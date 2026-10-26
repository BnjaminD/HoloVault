// Creates (or promotes) an administrator. Usage: npm run create-admin -- email@domaine.fr
// The password is typed interactively so it never ends up in the shell history.
import { createInterface } from 'node:readline';
import { loadConfig } from '../src/config.js';
import { openDb } from '../src/db/index.js';
import { hashSecret, setScryptCost } from '../src/lib/security.js';
import { emailField } from '../src/lib/validation.js';

function askHidden(question) {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    rl._writeToOutput = (s) => rl.output.write(s.startsWith(question) ? s : '');
    rl.question(question, (answer) => {
      rl.output.write('\n');
      rl.close();
      resolve(answer);
    });
  });
}

const email = emailField.safeParse(process.argv[2] ?? '');
if (!email.success) {
  console.error('Usage : npm run create-admin -- email@domaine.fr');
  process.exit(1);
}

const config = loadConfig();
setScryptCost(config.scryptCost);
const db = openDb(config.databasePath);
const password = process.env.ADMIN_PASSWORD || (await askHidden('Mot de passe admin (14 caractères min.) : '));
if (password.length < 14) {
  console.error('Mot de passe trop court (14 caractères minimum pour un administrateur).');
  process.exit(1);
}
const hash = await hashSecret(password);
const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(email.data);
if (existing) {
  db.prepare("UPDATE users SET role = 'admin', password_hash = ? WHERE id = ?").run(hash, existing.id);
  console.info(`Compte ${email.data} promu administrateur.`);
} else {
  db.prepare("INSERT INTO users (email, password_hash, first_name, last_name, role, created_at) VALUES (?, ?, 'Admin', 'Boutique', 'admin', ?)").run(
    email.data, hash, Date.now(),
  );
  console.info(`Administrateur ${email.data} créé.`);
}
db.close();
