import { expect, test, type APIRequestContext } from '@playwright/test';
import { registerAndSignIn } from './auth';

async function change(request: APIRequestContext, path: string, data?: object) {
  const origin = 'http://localhost:5173';
  const auth = await request.get(`${origin}/api/auth/me`);
  expect(auth.ok()).toBe(true);
  // GET /auth/me confirms the session. The CSRF cookie is included with state-changing requests.
  const state = await request.storageState();
  const token = state.cookies.find(c => c.name === 'nl_csrf')!.value;
  const result = await request.post(`${origin}/api${path}`, { headers: { 'x-csrf-token': token }, data });
  expect(result.ok(), await result.text()).toBe(true);
  return result.json();
}

test('opens a campus mission in the simulator, submits it, and restores the project', async ({ page, playwright }, testInfo) => {
  const staff = await playwright.request.newContext({ baseURL: 'http://localhost:5173' });
  try {
    const password = 'correct horse battery';
    const identity = { email: 'admin@example.com', password };
    const registration = await staff.post('/api/auth/register', { data: { ...identity, display_name: 'Administrateur' } });
    if (!registration.ok()) expect((await staff.post('/api/auth/login', { data: identity })).ok()).toBe(true);
    const org = await change(staff, '/orgs', { name: 'Lycée Campus', slug: `campus-${Date.now()}` });
    const cls = await change(staff, `/orgs/${org.id}/classes`, { name: 'BTS SIO Campus', academic_year: '2026-2027' });
    await change(staff, `/campus/classes/${cls.id}/templates/ipv4-support`);
    const { code } = await change(staff, `/classes/${cls.id}/join-code`);
    await registerAndSignIn(page, 'etudiant-campus');
    await change(page.request, '/auth/invites/redeem', { code });
    await page.getByRole('link', { name: 'Campus' }).click();
    await expect(page).toHaveURL('/campus');
    await expect(page.locator('canvas')).toBeVisible();
    await expect(page.getByText('En ligne · 1 joueur')).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath('campus.png') });
    await page.getByLabel('Carte jouable du campus').focus();
    await page.keyboard.press('ArrowRight');
    const locationMarker = page.getByRole('button', { name: 'Ouvrir le plan' }).locator('circle');
    await expect(locationMarker).toHaveAttribute('cx', '28.5');

    const reachLab = async () => {
      await page.getByRole('button', { name: 'Carte', exact: true }).click();
      await page.getByRole('button', { name: 'Laboratoire réseau', exact: true }).click();
      await expect(async () => {
        await page.getByRole('button', { name: 'Interagir' }).click();
        const station = page.getByRole('dialog');
        if (!await station.getByRole('heading', { name: 'Atelier Mistral · Un poste isolé' }).isVisible() && await station.isVisible()) {
          await station.getByRole('button', { name: 'Fermer' }).click();
        }
        await expect(station.getByRole('heading', { name: 'Atelier Mistral · Un poste isolé' })).toBeVisible({ timeout: 200 });
      }).toPass({ timeout: 16000, intervals: [500, 750] });
      await page.getByRole('button', { name: 'Ouvrir dans le simulateur' }).click();
    };
    await reachLab();
    await page.locator('.react-flow__node-device').filter({ hasText: 'PC2' }).click();
    await page.getByLabel('Adresse IPv4').first().fill('192.168.10.43');
    await page.getByRole('button', { name: 'Appliquer' }).first().click();
    page.once('dialog', dialog => void dialog.accept());
    const submission = page.waitForResponse(response => response.url().endsWith('/submissions') && response.status() === 202);
    await page.getByRole('button', { name: 'Rendre', exact: true }).click();
    await submission;
    await page.getByRole('button', { name: 'Retour au campus' }).click();
    await expect(page.getByRole('button', { name: 'Niv. 1 · 100 XP' })).toBeVisible({ timeout: 15000 });
    await reachLab();
    await page.locator('.react-flow__node-device').filter({ hasText: 'PC2' }).click();
    await expect(page.getByLabel('Adresse IPv4').first()).toHaveValue('192.168.10.43');
  } finally {
    await staff.dispose();
  }
});
