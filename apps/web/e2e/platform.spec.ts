import { expect, type Page, test } from '@playwright/test';
import { registerAndSignIn } from './auth';

test('academy navigation exposes dashboard, courses, exercises, activities and profile', async ({ page }) => {
  await registerAndSignIn(page, 'academy');
  const nav = page.getByRole('navigation', { name: 'Navigation pédagogique' });
  const masthead = page.getByRole('heading', { name: 'TPacket Academy' });
  await expect(nav.getByRole('button', { name: 'Tableau de bord' })).toHaveAttribute('aria-current', 'page');
  await nav.getByRole('button', { name: 'Mes cours' }).click();
  await expect(masthead).toBeVisible();
  await expect(page.locator('.nl-page-enter')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Fondamentaux des réseaux' })).toBeVisible();
  await nav.getByRole('button', { name: 'Mes exercices' }).click();
  await expect(masthead).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Premier LAN : connecter deux PC' })).toBeVisible();
  await nav.getByRole('button', { name: 'Mon profil' }).click();
  await expect(masthead).toBeVisible();
  await expect(page.getByText('Informations du compte')).toBeVisible();
  await nav.getByRole('button', { name: 'Mes activités' }).click();
  await expect(masthead).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Mes devoirs' })).toBeVisible();
});

test('starter exercise opens a prepared topology in the simulator', async ({ page }) => {
  await registerAndSignIn(page, 'starter');
  await page.getByRole('navigation', { name: 'Navigation pédagogique' }).getByRole('button', { name: 'Mes exercices' }).click();
  await page.getByRole('button', { name: 'S’entraîner' }).first().click();
  await expect(page.locator('.react-flow__node-device')).toHaveCount(3);
  await expect(page.getByText(/OBJECTIF/)).toBeVisible();
});

async function drop(page: Page, model: string, x: number, y: number) {
  const dt = await page.evaluateHandle((m) => {
    const d = new DataTransfer();
    d.setData('application/x-netlab-model', m);
    return d;
  }, model);
  await page.dispatchEvent('.react-flow__pane', 'drop', { dataTransfer: dt, clientX: x, clientY: y });
}

test('wireless laptop gets an address by DHCP from a server and browses its web page', async ({ page }) => {
  await registerAndSignIn(page, 'wifi');
  await page.getByRole('button', { name: 'Nouveau projet' }).click();
  await drop(page, '2960-24TT', 600, 160);
  await drop(page, 'Server', 420, 160);
  await drop(page, 'AccessPoint-PT', 760, 260);
  await drop(page, 'Laptop', 800, 400);
  const nodes = page.locator('.react-flow__node-device');
  await page.getByRole('button', { name: 'Automatique' }).click();
  await nodes.nth(1).click();
  await nodes.nth(0).click();
  await nodes.nth(2).click();
  await nodes.nth(0).click();
  await page.keyboard.press('Escape');
  // Server: static address + DHCP pool.
  await nodes.nth(1).click();
  await page.getByLabel('Adresse IPv4').first().fill('192.168.10.1');
  await page.getByRole('button', { name: 'Appliquer' }).first().click();
  await nodes.nth(1).dblclick();
  await page.getByRole('tab', { name: 'Services' }).click();
  const dhcp = page.locator('section').filter({ hasText: 'DHCP' }).first();
  await dhcp.getByLabel('Activé').check();
  await dhcp.getByLabel('Adresse de début').fill('192.168.10.100');
  await page.getByRole('button', { name: 'Enregistrer les services' }).click();
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Avance rapide (+30 s)' }).click();
  // Laptop: join the Wi-Fi (open SSID "Default") and use DHCP.
  await nodes.nth(3).click();
  await page.getByLabel('DHCP').first().check();
  await page.getByLabel('SSID (réseau Wi‑Fi)').first().fill('Default');
  await page.getByRole('button', { name: 'Demander une adresse (DHCP)' }).click();
  await expect(page.getByText('Adresse obtenue : 192.168.10.100')).toBeVisible();
  await expect(page.locator('.react-flow__edge-wifi')).toHaveCount(1);
  await nodes.nth(3).dblclick();
  await page.getByRole('tab', { name: 'Bureau' }).click();
  await page.getByRole('button', { name: 'Navigateur web' }).click();
  await page.getByLabel('URL').fill('http://192.168.10.1');
  await page.getByRole('button', { name: 'Aller' }).click();
  await expect(page.frameLocator('iframe[title="page"]').getByText('TPacket')).toBeVisible();
  await page.screenshot({ path: 'test-results/wireless.png' });
});

test('teacher creates a class and an assignment; the student joins, submits and gets a server-side grade', async ({ browser }) => {
  const api = 'http://localhost:8000/api';
  const reg = async (email: string, name: string) => {
    const ctx = await browser.newContext({ baseURL: 'http://localhost:5173', locale: 'fr-FR', viewport: { width: 1366, height: 768 } });
    const page = await ctx.newPage();
    await page.goto('/');
    await page.getByRole('button', { name: 'Pas de compte ? Inscrivez-vous' }).click();
    await page.getByLabel('Nom affiché').fill(name);
    await page.getByLabel('Adresse e-mail').fill(email);
    await page.getByLabel('Mot de passe').fill('correct horse battery');
    await page.getByRole('button', { name: 'Valider' }).click();
    await expect(page.getByText(email)).toBeVisible();
    return { ctx, page };
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
  const adminPage = await adminCtx.newPage();
  await adminPage.goto('/');
  await expect(adminPage.getByText('admin@example.com')).toBeVisible();
  const admin = { ctx: adminCtx, page: adminPage };
  const adminReq = admin.ctx.request;
  const csrf = async (c: typeof admin) => (await c.ctx.cookies()).find((x) => x.name === 'nl_csrf')!.value;
  await adminPage.getByRole('button', { name: 'Espace enseignant' }).click();
  const orgSelect = adminPage.getByRole('combobox', { name: 'Choisir un établissement' });
  const orgNameInput = adminPage.getByLabel('Nom de l’établissement');
  await expect.poll(async () => Boolean(await orgSelect.inputValue()) || (await orgNameInput.count()) === 1).toBe(true);
  if (await orgNameInput.count()) {
    await orgNameInput.fill('Lycée Test');
    await adminPage.getByRole('button', { name: 'Créer un établissement' }).click();
  }
  await expect(orgSelect).toHaveValue(/.+/);
  const orgId = await orgSelect.inputValue();
  expect(orgId).not.toBe('');
  await adminPage.getByPlaceholder('Nom de la classe (ex. SIO1 A)').fill('SIO2');
  await adminPage.getByRole('button', { name: 'Créer', exact: true }).click();
  await expect(adminPage.getByRole('button', { name: 'SIO2' })).toBeVisible();
  const inv = await (await adminReq.post(`${api}/orgs/${orgId}/invites`, { data: { role: 'teacher' }, headers: { 'x-csrf-token': await csrf(admin) } })).json();

  const teacher = await reg('prof@example.com', 'Mme Prof');
  await teacher.page.getByLabel('Code de classe / d’établissement').fill(inv.code);
  await teacher.page.getByRole('button', { name: 'Rejoindre' }).click();
  await expect(teacher.page.getByRole('button', { name: 'Espace enseignant' })).toBeVisible();
  // Exercise published through the API (the wizard itself is covered by the engine grading tests).
  const project = { format: 'netlab', schemaVersion: 1, name: 'LAN', devices: [{ id: 'd1', model: 'PC', name: 'PC0', x: 100, y: 100, powered: true, macBase: '000af3000001', modules: {}, host: { ipMode: 'static', ip: '', mask: '', gateway: '', dns: '', portUp: true } }], links: [], notes: [], zones: [], counters: { device: 1, link: 0, mac: 64, note: 0 } };
  const h = { 'x-csrf-token': await csrf(teacher) };
  const ex = await (await teacher.ctx.request.post(`${api}/orgs/${orgId}/exercises`, { data: { title: 'Adresser PC0' }, headers: h })).json();
  await teacher.ctx.request.post(`${api}/exercises/${ex.id}/versions`, { headers: h, data: { statement: 'Donnez à PC0 l’adresse 10.0.0.10/8.', initial_project: project, publish: true, rubric: { maxScore: 20, criteria: [{ id: 'ip', type: 'host_config', device: 'PC0', field: 'ip', expected: '10.0.0.10', points: 20 }] } } });

  const tp = teacher.page;
  await tp.getByRole('button', { name: 'Espace enseignant' }).click();
  await tp.getByPlaceholder('Nom de la classe (ex. SIO1 A)').fill('SIO1 A');
  await tp.getByRole('button', { name: 'Créer', exact: true }).click();
  await tp.getByRole('button', { name: 'SIO1 A' }).click();
  await tp.getByRole('button', { name: 'Générer un code d’inscription' }).click();
  const code = (await tp.locator('code').textContent())!.trim();
  await tp.locator('select').filter({ hasText: 'Exercice…' }).selectOption({ label: 'Adresser PC0 (v1)' });
  await tp.getByRole('button', { name: 'Attribuer' }).click();
  await expect(tp.getByRole('button', { name: 'Adresser PC0' })).toBeVisible();

  const student = await reg('eleve@example.com', 'Léa');
  const sp = student.page;
  await sp.getByLabel('Code de classe / d’établissement').fill(code);
  await sp.getByRole('button', { name: 'Rejoindre' }).click();
  const nav = sp.getByRole('navigation', { name: 'Navigation pédagogique' });
  await nav.getByRole('button', { name: 'Mes exercices' }).click();
  const exercise = sp.locator('article').filter({ has: sp.getByRole('heading', { name: 'Adresser PC0' }) });
  await expect(exercise).toBeVisible();
  await exercise.getByRole('button', { name: 'S’entraîner' }).click();
  await expect(sp.locator('.react-flow')).toBeVisible();
  await sp.getByRole('button', { name: 'Fichier' }).click();
  await sp.getByRole('menuitem', { name: 'Retour aux projets' }).click();
  await nav.getByRole('button', { name: 'Mes activités' }).click();
  await sp.getByRole('button', { name: 'Ouvrir' }).click();
  await expect(sp.getByRole('region', { name: 'Devoir' })).toContainText('Adresser PC0');
  await sp.locator('.react-flow__node-device').first().click();
  await sp.getByLabel('Adresse IPv4').first().fill('10.0.0.10');
  await sp.getByRole('button', { name: 'Appliquer' }).first().click();
  await sp.getByRole('button', { name: 'Vérifier' }).click();
  await expect(sp.getByText('✓ ip')).toBeVisible();
  await sp.keyboard.press('Escape');
  sp.once('dialog', (d) => void d.accept());
  await sp.getByRole('button', { name: 'Rendre' }).click();
  await expect(sp.getByText('Travail rendu (tentative 1).')).toBeVisible();

  await tp.getByRole('button', { name: 'Adresser PC0' }).click();
  await expect.poll(async () => { await tp.getByRole('button', { name: 'Actualiser' }).click(); return tp.locator('tbody tr').filter({ hasText: 'Léa' }).textContent(); }, { timeout: 20_000 }).toContain('20 / 20');
  await tp.screenshot({ path: 'test-results/teacher.png' });
});
