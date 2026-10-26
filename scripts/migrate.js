// Applies pending schema migrations. Usage: npm run migrate (also done automatically at startup).
import { loadConfig } from '../src/config.js';
import { openDb } from '../src/db/index.js';

const config = loadConfig();
const db = openDb(config.databasePath);
console.info(`Schéma à jour (version ${db.pragma('user_version', { simple: true })}) : ${config.databasePath}`);
db.close();
