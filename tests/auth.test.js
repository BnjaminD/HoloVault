import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { addUser, checkout, addProduct, csrf, login, request, setup, PASSWORD } from './helpers.js';

const sid = (res) => res.headers['set-cookie']?.find((c) => c.startsWith('hv.sid='))?.split(';')[0];

describe('comptes clients', () => {
  it('inscription puis accès au compte', async () => {
    const { app } = setup();
    const agent = request.agent(app);
    const token = await csrf(agent, '/inscription');
    const res = await agent.post('/inscription').type('form').send({
      _csrf: token, email: 'Nouveau@Example.com', password: PASSWORD, passwordConfirm: PASSWORD,
      firstName: 'Ondine', lastName: 'Azuria', phone: '+33 (0)6 12.34.56.78', addressLine1: '3 quai',
      postalCode: '69002', city: 'Lyon', country: 'FR', acceptTerms: 'on',
    });
    assert.equal(res.status, 302);
    assert.equal(res.headers.location, '/compte');
    assert.match((await agent.get('/compte')).text, /Bonjour Ondine/);
  });

  it('refuse une inscription en double sans révéler que le compte existe', async () => {
    const { app, db } = setup();
    await addUser(db, { email: 'pris@example.com' });
    const agent = request.agent(app);
    const token = await csrf(agent, '/inscription');
    const res = await agent.post('/inscription').type('form').send({
      _csrf: token, email: 'pris@example.com', password: PASSWORD, passwordConfirm: PASSWORD,
      firstName: 'A', lastName: 'B', phone: '0600000000', addressLine1: '1 rue', postalCode: '75001', city: 'Paris', country: 'FR', acceptTerms: 'on',
    });
    assert.equal(res.status, 400);
    assert.doesNotMatch(res.text, /existe déjà|already/i);
  });

  it('même message d’erreur pour un e-mail inconnu et un mauvais mot de passe', async () => {
    const { app, db } = setup();
    await addUser(db);
    const unknown = await login(request.agent(app), { email: 'inconnu@example.com', password: 'x' });
    const wrong = await login(request.agent(app), { email: 'client@example.com', password: 'mauvais' });
    assert.equal(unknown.status, 401);
    assert.equal(wrong.status, 401);
    const msg = (r) => r.text.match(/<div class="alert[^>]*>([\s\S]*?)<\/div>/)?.[1].trim();
    assert.equal(msg(unknown), msg(wrong));
  });

  it('verrouille le compte après 5 échecs, même avec le bon mot de passe ensuite', async () => {
    const { app, db } = setup();
    const user = await addUser(db);
    for (let i = 0; i < 5; i++) await login(request.agent(app), { email: user.email, password: 'mauvais' });
    const res = await login(request.agent(app), user);
    assert.equal(res.status, 401);
  });

  it('change l’identifiant de session à la connexion (anti-fixation)', async () => {
    const { app, db } = setup();
    const user = await addUser(db);
    const agent = request.agent(app);
    const first = await agent.get('/connexion');
    const before = sid(first);
    assert.ok(before);
    const res = await login(agent, user);
    assert.equal(res.status, 302);
    assert.notEqual(sid(res), before);
  });

  it('cookie de session HttpOnly + SameSite', async () => {
    const { app } = setup();
    const res = await request(app).get('/connexion');
    const cookie = res.headers['set-cookie'].find((c) => c.startsWith('hv.sid='));
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /SameSite=Lax/);
  });

  for (const next of ['//evil.com', '/\\evil.com', 'https://evil.com', '/%0d%0aSet-Cookie:x', 'javascript:alert(1)']) {
    it(`pas de redirection ouverte via next=${next}`, async () => {
      const { app, db } = setup();
      const user = await addUser(db);
      const agent = request.agent(app);
      const token = await csrf(agent);
      const res = await agent.post('/connexion').type('form').send({ _csrf: token, ...user, next });
      assert.equal(res.status, 302);
      assert.equal(res.headers.location, '/compte');
    });
  }

  it('déconnexion uniquement en POST avec jeton CSRF', async () => {
    const { app, db } = setup();
    const user = await addUser(db);
    const agent = request.agent(app);
    await login(agent, user);
    assert.equal((await agent.get('/deconnexion')).status, 404);
    assert.equal((await agent.post('/deconnexion')).status, 403);
    assert.equal((await agent.get('/compte')).status, 200);
  });

  it('le changement de mot de passe déconnecte les autres sessions', async () => {
    const { app, db } = setup();
    const user = await addUser(db);
    const laptop = request.agent(app);
    const phone = request.agent(app);
    await login(laptop, user);
    await login(phone, user);
    const token = await csrf(laptop, '/compte');
    const res = await laptop.post('/compte/mot-de-passe').type('form').send({
      _csrf: token, currentPassword: PASSWORD, newPassword: 'Nouveau-Mot-De-Passe-42', newPasswordConfirm: 'Nouveau-Mot-De-Passe-42',
    });
    assert.equal(res.status, 302);
    assert.equal((await laptop.get('/compte')).status, 200);
    assert.equal((await phone.get('/compte')).status, 302);
  });
});

describe('connexion invité (référence + numéro de commande)', () => {
  async function guestOrder() {
    const ctx = setup();
    const product = addProduct(ctx.db);
    const buyer = request.agent(ctx.app);
    await checkout(buyer, product);
    const page = await buyer.get('/commande/confirmation');
    const reference = page.text.match(/HV-[A-Z0-9]{8}/)[0];
    const code = page.text.match(/[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}/)[0];
    return { ...ctx, reference, code };
  }

  const guestLogin = async (agent, reference, code) => {
    const token = await csrf(agent, '/connexion?mode=commande');
    return agent.post('/connexion/commande').type('form').send({ _csrf: token, reference, code });
  };

  it('accepte la saisie en minuscules et sans tirets', async () => {
    const { app, reference, code } = await guestOrder();
    const agent = request.agent(app);
    const res = await guestLogin(agent, reference.toLowerCase().replace('-', ''), code.toLowerCase().replace(/-/g, ''));
    assert.equal(res.headers.location, '/suivi');
    assert.match((await agent.get('/suivi')).text, new RegExp(reference));
  });

  it('le numéro de commande n’est stocké que haché', async () => {
    const { db, reference, code } = await guestOrder();
    const row = db.prepare('SELECT access_code_hash FROM orders WHERE reference = ?').get(reference);
    assert.match(row.access_code_hash, /^scrypt\$/);
    assert.ok(!row.access_code_hash.includes(code.replace(/-/g, '')));
  });

  it('verrouille la commande après 5 mauvais numéros', async () => {
    const { app, reference, code } = await guestOrder();
    for (let i = 0; i < 5; i++) await guestLogin(request.agent(app), reference, 'AAAA-BBBB-CCCC');
    const res = await guestLogin(request.agent(app), reference, code);
    assert.equal(res.status, 401);
  });

  it('/suivi sans session invité renvoie vers la connexion', async () => {
    const { app } = setup();
    const res = await request(app).get('/suivi');
    assert.equal(res.status, 302);
    assert.match(res.headers.location, /mode=commande/);
  });
});
