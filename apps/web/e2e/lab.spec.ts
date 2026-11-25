import { expect, type Page, test } from '@playwright/test';
import { registerAndSignIn } from './auth';

async function drop(page: Page, model: string, x: number, y: number) {
  const dt = await page.evaluateHandle((m) => {
    const d = new DataTransfer();
    d.setData('application/x-netlab-model', m);
    return d;
  }, model);
  await page.dispatchEvent('.react-flow__pane', 'drop', { dataTransfer: dt, clientX: x, clientY: y });
}

async function terminalText(page: Page) {
  return (await page.locator('[data-terminal] .xterm-rows').last().textContent()) ?? '';
}

async function typeInTerminal(page: Page, text: string) {
  await page.locator('[data-terminal]').last().click();
  await page.keyboard.type(text);
}

test('requires sign-in before the simulator or project data can be accessed', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Connexion requise' })).toBeVisible();
  await expect(page.getByRole('form', { name: 'Connexion' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Nouveau projet' })).toHaveCount(0);
  const projects = await page.request.get('http://localhost:8000/api/projects');
  expect(projects.status()).toBe(401);
});

test('signing out returns to the required sign-in screen', async ({ page }) => {
  await registerAndSignIn(page, 'logout');
  await page.getByRole('button', { name: 'Déconnexion' }).click();
  await expect(page.getByRole('heading', { name: 'Connexion requise' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Nouveau projet' })).toHaveCount(0);
});

test('build a LAN, configure it from the GUI and the CLI, and ping for real', async ({ page }) => {
  await registerAndSignIn(page, 'lab');
  await page.getByRole('button', { name: 'Nouveau projet' }).click();
  await expect(page.locator('.react-flow')).toBeVisible();

  await drop(page, '2960-24TT', 560, 200);
  await drop(page, 'PC', 420, 380);
  await drop(page, 'PC', 700, 380);
  await expect(page.locator('.react-flow__node-device')).toHaveCount(3);

  // Automatic cable: PC -> switch, twice.
  const nodes = page.locator('.react-flow__node-device');
  await page.getByRole('button', { name: 'Automatique' }).click();
  await nodes.nth(1).click();
  await nodes.nth(0).click();
  await nodes.nth(2).click();
  await nodes.nth(0).click();
  await expect(page.locator('.react-flow__edge')).toHaveCount(2);
  await page.keyboard.press('Escape');

  // IP configuration through the Properties panel.
  for (const [i, ip] of [[1, '192.168.1.10'], [2, '192.168.1.11']] as const) {
    await nodes.nth(i).click();
    await page.getByLabel('Adresse IPv4').first().fill(ip);
    await page.getByLabel('Masque de sous-réseau').first().fill('255.255.255.0');
    await page.getByRole('button', { name: 'Appliquer' }).first().click();
  }
  // Switch ports must finish STP listening/learning before forwarding.
  await page.getByRole('button', { name: 'Avance rapide (+30 s)' }).click();

  await nodes.nth(1).click();
  await page.getByRole('button', { name: 'CLI', exact: true }).first().click();
  await typeInTerminal(page, 'ping 192.168.1.11\n');
  await expect.poll(() => terminalText(page), { timeout: 15_000 }).toContain('Reply from 192.168.1.11');
  await expect.poll(() => terminalText(page)).toContain('Received = 4');
  await page.screenshot({ path: 'test-results/lan.png' });
});

test('IOS CLI: modes, abbreviations, contextual help and errors', async ({ page }) => {
  await registerAndSignIn(page, 'cli');
  await page.getByRole('button', { name: 'Nouveau projet' }).click();
  await drop(page, '1941', 600, 300);
  await page.locator('.react-flow__node-device').first().click();
  await page.getByRole('button', { name: 'CLI', exact: true }).first().click();
  await typeInTerminal(page, '\n');
  await typeInTerminal(page, 'en\nconf t\nhostname R1\n');
  await expect.poll(() => terminalText(page)).toContain('R1(config)#');
  await typeInTerminal(page, 'int g0/0\nip address 10.0.0.1 255.255.255.0\nno shut\nend\n');
  await typeInTerminal(page, 'show ip ?');
  await expect.poll(() => terminalText(page)).toContain('route');
  await page.keyboard.press('Backspace');
  await typeInTerminal(page, '\x03');
  await typeInTerminal(page, 'show ip int brief\n');
  await expect.poll(() => terminalText(page)).toMatch(/GigabitEthernet0\/0\s+10\.0\.0\.1/);
  await typeInTerminal(page, 'hostnme X\n');
  await expect.poll(() => terminalText(page)).toContain('% Unknown command');
  await page.screenshot({ path: 'test-results/cli.png' });
});

test('simulation mode: step a PDU, inspect it layer by layer', async ({ page }) => {
  await registerAndSignIn(page, 'simulation');
  await page.getByRole('button', { name: 'Nouveau projet' }).click();
  await drop(page, '2960-24TT', 560, 200);
  await drop(page, 'PC', 420, 380);
  await drop(page, 'PC', 700, 380);
  const nodes = page.locator('.react-flow__node-device');
  await page.getByRole('button', { name: 'Automatique' }).click();
  await nodes.nth(1).click();
  await nodes.nth(0).click();
  await nodes.nth(2).click();
  await nodes.nth(0).click();
  await page.keyboard.press('Escape');
  for (const [i, ip] of [[1, '10.0.0.1'], [2, '10.0.0.2']] as const) {
    await nodes.nth(i).click();
    await page.getByLabel('Adresse IPv4').first().fill(ip);
    await page.getByRole('button', { name: 'Appliquer' }).first().click();
  }
  await page.getByRole('button', { name: 'Avance rapide (+30 s)' }).click();
  await page.getByRole('radio', { name: 'Simulation' }).click();
  await page.getByRole('button', { name: 'Réinitialiser la simulation' }).click();
  await page.getByRole('button', { name: 'PDU complexe' }).click();
  await nodes.nth(1).click();
  await nodes.nth(2).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Envoyer' }).click();
  await page.getByRole('tab', { name: 'Événements' }).click();
  for (let i = 0; i < 12; i++) await page.getByRole('button', { name: 'Pas à pas' }).click();
  await expect(page.getByText('Réussi')).toBeVisible();
  await page.getByRole('row').filter({ hasText: 'ARP' }).first().click();
  await expect(page.getByText('Couche 2 — Liaison')).toBeVisible();
  await expect(page.getByText('Sender MAC / IP')).toBeVisible();
  await page.screenshot({ path: 'test-results/sim.png' });
});
