import { expect, test } from '@playwright/test';

const BOT_SOURCE = `function gameLoop(obs) {
  if (obs.tick === 0) {
    console.log('e2e bot online');
    fetch('http://localhost:8180/healthz').then((r) => r.json()).then(
      (body) => console.log('e2e fetch ok ' + JSON.stringify(body)),
      (error) => console.log('e2e fetch failed: ' + error.message),
    );
  }
  const moves = ['MOVE UP', 'MOVE DOWN', 'MOVE LEFT', 'MOVE RIGHT'];
  return moves[Math.floor(Math.random() * moves.length)];
}
`;

test('register, write a bot, test it, play ranked, watch the replay, and reach the leaderboard', async ({
  page,
}) => {
  const username = `e2e_${Date.now().toString(36)}`;
  const botName = 'E2E Walker';

  await page.goto('/register');
  await page.getByLabel('Username').fill(username);
  await page.getByLabel('Password').fill('an end to end password');
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(`Hi ${username}`);

  await page.getByLabel('New bot name').fill(botName);
  await page.getByRole('button', { name: 'Create bot' }).click();
  await expect(page.getByRole('heading', { level: 1, name: botName })).toBeVisible();

  const editor = page.getByRole('textbox', { name: /bot source/i });
  await editor.click();
  await page.keyboard.press('ControlOrMeta+A');
  await page.keyboard.press('Delete');
  await page.keyboard.insertText(BOT_SOURCE);

  await page.getByRole('button', { name: 'Run test' }).click();
  await expect(page.locator('.console-lines')).toContainText('e2e bot online');
  await expect(page.locator('.console-lines')).toContainText('e2e fetch ok');
  await page.getByRole('button', { name: 'Stop' }).click();

  await page.getByRole('button', { name: 'Save version' }).click();
  const saveDialog = page.getByRole('dialog', { name: 'Save a version' });
  await saveDialog.getByLabel('Version name').fill('First try');
  await saveDialog.getByRole('button', { name: 'Save version' }).click();
  await expect(page.getByText(/Saved “First try” as version 1/)).toBeVisible();

  await page.getByRole('tab', { name: 'Ranked' }).click();
  await page.getByRole('button', { name: 'Queue for ranked' }).click();
  await expect(page.getByRole('button', { name: 'Leave the queue' })).toBeVisible();

  await expect(async () => {
    await page.goto('/matches');
    await expect(page.locator('.match-row', { hasText: botName }).first()).toBeVisible({
      timeout: 1000,
    });
  }).toPass({ timeout: 45_000 });
  await page.locator('.match-row', { hasText: botName }).first().click();

  await expect(page.getByRole('heading', { level: 1 })).toContainText('Ranked match');
  await expect(page.getByText('Replay verified')).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('.table')).toContainText(botName);

  await page.getByRole('link', { name: 'Leaderboard' }).first().click();
  await expect(page.locator('.table')).toContainText(botName);
});
