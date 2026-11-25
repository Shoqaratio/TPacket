import { expect, type Page } from '@playwright/test';

export async function registerAndSignIn(page: Page, prefix: string): Promise<void> {
  const suffix = Math.random().toString(36).slice(2);
  const email = `${prefix}-${Date.now()}-${suffix}@example.com`;
  await page.goto('/');
  await page.getByRole('button', { name: 'Pas de compte ? Inscrivez-vous' }).click();
  await page.getByLabel('Nom affiché').fill(prefix);
  await page.getByLabel('Adresse e-mail').fill(email);
  await page.getByLabel('Mot de passe').fill('correct horse battery');
  await page.getByRole('button', { name: 'Valider' }).click();
  await expect(page.getByText(email)).toBeVisible();
}
