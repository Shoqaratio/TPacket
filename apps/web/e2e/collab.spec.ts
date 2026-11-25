import { expect, type Page, test } from '@playwright/test';

async function drop(page: Page, model: string, x: number, y: number) {
  const dt = await page.evaluateHandle((m) => {
    const d = new DataTransfer();
    d.setData('application/x-netlab-model', m);
    return d;
  }, model);
  await page.dispatchEvent('.react-flow__pane', 'drop', { dataTransfer: dt, clientX: x, clientY: y });
}

test('two participants edit the same topology live; chat and history are shared', async ({ browser }) => {
  const api = 'http://localhost:8000/api';
  const user = async (email: string) => {
    const ctx = await browser.newContext({ baseURL: 'http://localhost:5173', locale: 'fr-FR', viewport: { width: 1366, height: 768 } });
    const page = await ctx.newPage();
    await page.goto('/');
    await page.getByRole('button', { name: 'Pas de compte ? Inscrivez-vous' }).click();
    await page.getByLabel('Nom affiché').fill(email.split('@')[0]!);
    await page.getByLabel('Adresse e-mail').fill(email);
    await page.getByLabel('Mot de passe').fill('correct horse battery');
    await page.getByRole('button', { name: 'Valider' }).click();
    await expect(page.getByText(email)).toBeVisible();
    const csrf = async () => (await ctx.cookies()).find((c) => c.name === 'nl_csrf')!.value;
    return { ctx, page, csrf };
  };
  const adminCtx = await browser.newContext({ baseURL: 'http://localhost:5173', locale: 'fr-FR', viewport: { width: 1366, height: 768 } });
  const registration = await adminCtx.request.post(`${api}/auth/register`, {
    data: { email: 'admin@example.com', password: 'correct horse battery', display_name: 'Admin' },
  });
  if (registration.status() === 409) {
    const login = await adminCtx.request.post(`${api}/auth/login`, { data: { email: 'admin@example.com', password: 'correct horse battery' } });
    expect(login.status()).toBe(200);
  } else {
    expect(registration.status()).toBe(201);
  }
  const page = await adminCtx.newPage();
  await page.goto('/');
  await expect(page.getByText('admin@example.com')).toBeVisible();
  const admin = { ctx: adminCtx, page, csrf: async () => (await adminCtx.cookies()).find((c) => c.name === 'nl_csrf')!.value };
  const org = await (await admin.ctx.request.post(`${api}/orgs`, { data: { name: 'Lycée Collab', slug: 'lycee-collab' }, headers: { 'x-csrf-token': await admin.csrf() } })).json();
  const code = async () => (await (await admin.ctx.request.post(`${api}/orgs/${org.id}/invites`, { data: { role: 'student' }, headers: { 'x-csrf-token': await admin.csrf() } })).json()).code as string;

  const a = await user('alice@example.com');
  const b = await user('bob@example.com');
  for (const u of [a, b]) {
    await u.page.getByLabel('Code de classe / d’établissement').fill(await code());
    await u.page.getByRole('button', { name: 'Rejoindre' }).click();
    await expect(u.page.getByText('Lycée Collab — student')).toBeVisible();
  }
  await a.page.getByRole('button', { name: 'Nouveau projet' }).click();
  await drop(a.page, 'PC', 400, 300);
  await expect(a.page.getByText('Synchronisé')).toBeVisible({ timeout: 15_000 });
  await a.page.getByRole('tab', { name: 'Collaboration' }).click();
  await a.page.getByRole('button', { name: 'Lien collaboration (écriture)' }).click();
  const link = await a.page.getByLabel('Lien').inputValue();
  await a.page.getByRole('button', { name: 'Démarrer la session' }).click();
  await expect(a.page.locator('.react-flow__node-device')).toHaveCount(1);

  await b.page.goto(link.replace(/^https?:\/\/[^/]+/, ''));
  await expect(b.page.locator('.react-flow__node-device')).toHaveCount(1, { timeout: 15_000 });

  await drop(a.page, '2960-24TT', 600, 300);
  await expect(b.page.locator('.react-flow__node-device')).toHaveCount(2);
  await drop(b.page, 'Server', 500, 450);
  await expect(a.page.locator('.react-flow__node-device')).toHaveCount(3);
  await expect(a.page.getByText('Server0')).toBeVisible();

  await b.page.getByRole('tab', { name: 'Collaboration' }).click();
  await b.page.getByLabel('Message').fill('Je câble le serveur');
  await b.page.getByRole('button', { name: 'Envoyer' }).click();
  await a.page.getByRole('tab', { name: 'Collaboration' }).click();
  await expect(a.page.getByText('Je câble le serveur')).toBeVisible();
  await expect(a.page.getByText(/addDevice/).first()).toBeVisible();
  await a.page.screenshot({ path: 'test-results/collab.png' });
});
