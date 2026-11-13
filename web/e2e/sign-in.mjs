/**
 * Demo sign-in through the Kingdom screen, as a visitor does it: pick the character (on the first
 * screen or in «Все персонажи» with search) and confirm with «Войти в Королевство».
 * The entrance animation is skipped when it shows; callers wait for `.shell` themselves.
 */
export async function signIn(page, person) {
  await page.locator('.kl-card').first().waitFor();
  const card = page.locator('.kl-card', { hasText: person.name });
  if (await card.count()) await card.first().click();
  else {
    await page.getByRole('button', { name: /^Все персонажи/ }).click();
    await page.getByRole('searchbox').fill(person.name);
    await page.locator('.kl-all-list button', { hasText: person.name }).first().click();
  }
  await page.getByRole('button', { name: /^Войти в Королевство/ }).click();
  const skip = page.getByRole('button', { name: 'Пропустить' });
  await skip.click({ timeout: 1500 }).catch(() => undefined);
}
