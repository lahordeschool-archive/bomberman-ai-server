import { type Browser, expect, type Page, test } from '@playwright/test';

const PASSWORD = 'a workflow password';

const WALKER = `function gameLoop(obs) {
  if (obs.tick === 0) console.log('walker ready');
  return ['MOVE UP', 'MOVE DOWN', 'MOVE LEFT', 'MOVE RIGHT'][Math.floor(Math.random() * 4)];
}
`;

let counter = 0;
function uniqueName(prefix: string): string {
  counter += 1;
  return `${prefix}_${Date.now().toString(36)}${counter}`;
}

async function register(page: Page, username = uniqueName('wf')): Promise<string> {
  await page.goto('/register');
  await page.getByLabel('Username').fill(username);
  await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(`Hi ${username}`);
  return username;
}

async function newUserPage(browser: Browser): Promise<{ page: Page; username: string }> {
  const context = await browser.newContext();
  const page = await context.newPage();
  return { page, username: await register(page) };
}

async function createBot(page: Page, name: string): Promise<string> {
  await page.goto('/');
  await page.getByLabel('New bot name').fill(name);
  await page.getByRole('button', { name: 'Create bot' }).click();
  await expect(page.getByRole('heading', { level: 1, name })).toBeVisible();
  return page.url().split('/bots/')[1]!;
}

async function setSource(page: Page, source: string): Promise<void> {
  await page.getByRole('textbox', { name: 'Bot source code' }).click();
  await page.keyboard.press('ControlOrMeta+A');
  await page.keyboard.press('Delete');
  await page.keyboard.insertText(source);
}

async function saveVersion(
  page: Page,
  name: string,
  options: { public?: boolean } = {},
): Promise<void> {
  await page.getByRole('button', { name: 'Save version' }).click();
  const dialog = page.getByRole('dialog', { name: 'Save a version' });
  await dialog.getByLabel('Version name').fill(name);
  if (options.public) await dialog.getByLabel(/Public source/).check();
  await dialog.getByRole('button', { name: 'Save version' }).click();
}

async function signOut(page: Page): Promise<void> {
  await page.goto('/account');
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page.getByRole('link', { name: 'Sign in' }).first()).toBeVisible();
}

test.describe('visitors', () => {
  test('browse the landing page, ladder, matches and missing pages', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));

    await page.goto('/');
    await expect(page.getByRole('heading', { level: 1 })).toContainText('Write the bot.');
    await expect(page.locator('.demo-arena canvas')).toBeVisible();
    await expect(page.locator('.scoreboard')).toContainText(/\d:\d\d/);

    await page.getByRole('link', { name: 'Leaderboard' }).first().click();
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Leaderboard');
    await expect(page.locator('.table, .empty-state')).toBeVisible();

    await page.getByRole('link', { name: 'Matches' }).first().click();
    await expect(page.getByRole('heading', { name: 'Live now' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Finished', exact: true })).toBeVisible();
    await expect(page.getByLabel('Only my bots')).toHaveCount(0);

    await page.goto('/this/does/not/exist');
    await expect(page.getByText('This tile is a wall')).toBeVisible();
    await page.goto('/u/nobody_by_that_name');
    await expect(page.getByText('This tile is a wall')).toBeVisible();
    await page.goto('/bots/00000000-0000-4000-8000-000000000000');
    await expect(page.getByText('This tile is a wall')).toBeVisible();
    await page.goto('/matches/00000000-0000-4000-8000-000000000000');
    await expect(page.getByRole('alert')).toContainText(/does not exist/);

    await page.goto('/account');
    await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();

    expect(errors).toEqual([]);
  });

  test('use the mobile menu', async ({ browser }) => {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const page = await context.newPage();
    await page.goto('/');
    await page.getByRole('button', { name: 'Open menu' }).click();
    await page.locator('#mobile-menu').getByRole('link', { name: 'Leaderboard' }).click();
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Leaderboard');
    await expect(page.locator('#mobile-menu')).toBeHidden();
    const overflow = await page.evaluate<number>(
      'document.documentElement.scrollWidth - document.documentElement.clientWidth',
    );
    expect(overflow).toBeLessThanOrEqual(0);
    await context.close();
  });
});

test.describe('accounts', () => {
  test('validate, register, sign out, sign in, and change the password', async ({ page }) => {
    await page.goto('/register');
    await page.getByLabel('Username').fill('No Spaces!');
    await page.getByLabel('Password', { exact: true }).fill('short');
    await page.getByRole('button', { name: 'Create account' }).click();
    await expect(page.getByText('Use 3 to 24 lowercase letters')).toBeVisible();
    await expect(page.getByText('Use at least 8 characters.')).toBeVisible();

    const username = await register(page);
    await signOut(page);

    await page.goto('/register');
    await page.getByLabel('Username').fill(username);
    await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
    await page.getByRole('button', { name: 'Create account' }).click();
    await expect(page.getByRole('alert')).toHaveText('That username is not available.');

    await page.goto('/login');
    await page.getByLabel('Username').fill(username);
    await page.getByLabel('Password', { exact: true }).fill('not the password');
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page.getByRole('alert')).toHaveText('Incorrect username or password.');

    await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(`Hi ${username}`);

    await page.getByRole('link', { name: username }).click();
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Account');
    await page.getByLabel('Current password').fill('wrong current password');
    await page.getByLabel('New password').fill('a brand new password');
    await page.getByRole('button', { name: 'Update password' }).click();
    await expect(page.getByRole('alert')).toHaveText('Your current password is incorrect.');

    await page.getByLabel('Current password').fill(PASSWORD);
    await page.getByLabel('New password').fill('a brand new password');
    await page.getByRole('button', { name: 'Update password' }).click();
    await expect(page.getByRole('status')).toContainText('Password updated');

    await page.reload();
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Account');

    await signOut(page);
    await page.goto('/login');
    await page.getByLabel('Username').fill(username);
    await page.getByLabel('Password', { exact: true }).fill('a brand new password');
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(`Hi ${username}`);

    await page.goto('/account');
    await page.getByRole('link', { name: 'View your public profile' }).click();
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(username);
  });
});

test.describe('bots', () => {
  test('create, rename, edit, test, save versions, load, expand, and delete', async ({ page }) => {
    await register(page);

    await page.getByLabel('New bot name').fill('x');
    await page.getByRole('button', { name: 'Create bot' }).click();
    await expect(page.getByRole('alert')).toContainText('at least 2 characters');

    await createBot(page, 'Draft Bot');
    await expect(page.locator('.editor-header-meta')).toContainText('No version yet');

    await page.getByLabel('Load code').selectOption('hunter');
    await expect(page.getByRole('textbox', { name: 'Bot source code' })).toContainText(
      'Hunter: walks straight at the nearest player',
    );
    await expect(page.locator('.console-lines')).toContainText('Loaded the Hunter template');
    page.once('dialog', (dialog) => void dialog.accept());
    await page.getByLabel('Load code').selectOption('survivor');
    await expect(page.getByRole('textbox', { name: 'Bot source code' })).toContainText(
      'Survivor: plays for time',
    );

    await page.getByRole('button', { name: 'Rename bot' }).click();
    await page.getByLabel('Bot name').fill('Renamed Bot');
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Renamed Bot' })).toBeVisible();

    await setSource(page, 'function gameLoop(obs) { return ');
    await expect(page.getByText('Unsaved changes')).toBeVisible();
    await page.getByRole('button', { name: 'Run test' }).click();
    await expect(page.locator('.console-lines, [role="alert"]').first()).toContainText(
      /SyntaxError|Unexpected|failed/i,
    );
    await page.getByRole('button', { name: 'Save version' }).click();
    const saveDialog = page.getByRole('dialog', { name: 'Save a version' });
    await expect(saveDialog.getByRole('button', { name: 'Save version' })).toBeDisabled();
    await saveDialog.getByLabel('Version name').fill('Broken');
    await saveDialog.getByRole('button', { name: 'Save version' }).click();
    await expect(saveDialog.getByRole('alert')).toContainText('The sandbox rejected this version');
    await saveDialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(saveDialog).toBeHidden();

    await setSource(page, WALKER);
    await page.getByRole('button', { name: 'Run test' }).click();
    await expect(page.locator('.console-lines')).toContainText('walker ready');
    await expect(page.locator('.scoreboard')).toContainText('Renamed Bot');
    await page.getByRole('button', { name: 'Stop' }).click();

    await saveVersion(page, 'Wanderer');
    await expect(page.getByText(/Saved “Wanderer” as version 1/)).toBeVisible();
    await expect(page.getByText('Unsaved changes')).toHaveCount(0);

    await setSource(page, WALKER.replace('walker ready', 'walker v2 ready'));
    await saveVersion(page, 'Wanderer 2', { public: true });
    await expect(page.getByText(/Saved “Wanderer 2” as version 2/)).toBeVisible();
    const loadCode = page.getByLabel('Load code');
    await expect(loadCode.locator('option:checked')).toHaveText('v2 · Wanderer 2 (active)');

    await page.getByRole('tab', { name: 'Ranked' }).click();
    const versions = page.locator('.version-list li');
    await expect(versions).toHaveCount(2);
    await expect(versions.first()).toContainText('Active');
    await expect(versions.first()).toContainText('Public');
    await versions.nth(1).getByRole('button', { name: 'Load' }).click();
    await expect(page.locator('.console-lines')).toContainText('Loaded v1 · Wanderer');
    await expect(page.getByRole('textbox', { name: 'Bot source code' })).not.toContainText(
      'walker v2 ready',
    );
    await expect(page.getByText('Unsaved changes')).toBeVisible();
    await expect(loadCode.locator('option:checked')).toHaveText('v1 · Wanderer');

    await expect(
      loadCode.locator('optgroup[label="Saved versions of this bot"] option'),
    ).toHaveText(['v2 · Wanderer 2 (active)', 'v1 · Wanderer']);
    await loadCode.selectOption({ label: 'v2 · Wanderer 2 (active)' });
    await expect(page.getByRole('textbox', { name: 'Bot source code' })).toContainText(
      'walker v2 ready',
    );
    await expect(page.getByText('Unsaved changes')).toHaveCount(0);

    await page.getByRole('tab', { name: 'Local test' }).click();
    await page.getByLabel('Opponent 1').selectOption({ label: 'v1 · Wanderer' });
    await page.getByRole('button', { name: 'Run test' }).click();
    await expect(page.locator('.console-lines')).toContainText('walker ready');
    await expect(page.locator('.console-lines')).toContainText('walker v2 ready');
    await expect(page.locator('.scoreboard')).toContainText('v1 · Wanderer');
    await page.getByRole('button', { name: 'Stop' }).click();
    await page.getByRole('tab', { name: 'Ranked' }).click();

    await page.getByRole('button', { name: 'Queue for ranked' }).click();
    await expect(page.getByRole('button', { name: 'Leave the queue' })).toBeVisible();
    await page.getByRole('button', { name: 'Leave the queue' }).click();
    await expect(page.getByRole('button', { name: 'Queue for ranked' })).toBeVisible();

    await page.getByRole('button', { name: 'Expand the editor to full width' }).click();
    await expect(page.locator('.editor-page')).toHaveClass(/is-expanded/);
    await page.reload();
    await expect(page.getByRole('button', { name: 'Collapse the editor' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await page.getByRole('button', { name: 'Collapse the editor' }).click();
    await expect(page.locator('.editor-page')).not.toHaveClass(/is-expanded/);

    page.once('dialog', (dialog) => void dialog.accept());
    await page.getByRole('tab', { name: 'Ranked' }).click();
    await page.getByRole('button', { name: 'Delete bot' }).click();
    await expect(page.getByRole('heading', { name: 'Your bots' })).toBeVisible();
    await expect(page.locator('.bot-list')).toHaveCount(0);
  });

  test('share public source and copy another player’s bot', async ({ page, browser }) => {
    const author = await register(page);
    const botId = await createBot(page, 'Shared Bot');
    await setSource(page, WALKER.replace('walker ready', 'shared private'));
    await saveVersion(page, 'Secret');
    await expect(page.getByText(/as version 1/)).toBeVisible();
    await setSource(page, WALKER.replace('walker ready', 'shared public'));
    await saveVersion(page, 'Open book', { public: true });
    await expect(page.getByText(/as version 2/)).toBeVisible();

    const visitor = await browser.newPage();
    await visitor.goto(`/u/${author}`);
    await visitor.getByRole('link', { name: /Shared Bot/ }).click();
    await expect(visitor.getByRole('heading', { level: 1 })).toHaveText('Shared Bot');
    await expect(visitor.locator('.version-list li').nth(1)).toContainText('Private');
    await visitor.getByRole('button', { name: 'View source' }).click();
    await expect(visitor.getByRole('textbox', { name: /Source of Shared Bot v2/ })).toContainText(
      'shared public',
    );
    await expect(
      visitor.getByRole('link', { name: 'Sign up to start from this code' }),
    ).toBeVisible();
    await visitor.close();

    const other = await newUserPage(browser);
    await other.page.goto(`/bots/${botId}`);
    await expect(other.page.getByRole('heading', { level: 1 })).toHaveText('Shared Bot');
    await expect(other.page.getByRole('button', { name: 'Save version' })).toHaveCount(0);
    await other.page.getByRole('button', { name: 'View source' }).click();
    await other.page.getByRole('button', { name: 'Copy into a new bot' }).click();
    await expect(
      other.page.getByRole('heading', { level: 1, name: 'Shared Bot copy' }),
    ).toBeVisible();
    await expect(other.page.getByRole('textbox', { name: 'Bot source code' })).toContainText(
      'shared public',
    );
    await other.page.context().close();
  });
});

test.describe('casual rooms', () => {
  test('two players and a house bot play a room match and open its replay', async ({
    page,
    browser,
  }) => {
    await register(page);
    await createBot(page, 'Host Bot');
    await setSource(page, WALKER.replace('walker ready', 'host online'));
    await page.getByRole('tab', { name: 'Online casual' }).click();
    await page.getByRole('button', { name: 'Create a room' }).click();
    const code = (await page.locator('.panel strong.mono').textContent())!.trim();
    expect(code).toMatch(/^[A-Z0-9]{6}$/);

    const guest = await newUserPage(browser);
    await createBot(guest.page, 'Guest Bot');
    await setSource(guest.page, WALKER.replace('walker ready', 'guest online'));
    await guest.page.getByRole('tab', { name: 'Online casual' }).click();
    await guest.page.getByLabel('Room code').fill(code.toLowerCase());
    await guest.page.getByRole('button', { name: 'Join' }).click();
    await expect(guest.page.locator('.plain-list li')).toHaveCount(2);
    await expect(guest.page.getByRole('button', { name: 'Start match' })).toHaveCount(0);

    await expect(page.locator('.plain-list li')).toHaveCount(2);
    await page.getByRole('button', { name: 'Start match' }).click();

    for (const player of [page, guest.page]) {
      await expect(player.locator('.console-lines')).toContainText(/(host|guest) online/);
      await expect(player.locator('.scoreboard')).toContainText('Host Bot');
      await expect(player.locator('.scoreboard')).toContainText('Guest Bot');
    }
    await expect(page.getByText('(match in progress)')).toBeVisible();

    await page.getByRole('link', { name: 'Match over. Watch the replay' }).click({
      timeout: 45_000,
    });
    await expect(page.getByRole('heading', { level: 1 })).toContainText('Casual match');
    await expect(page.getByText('Replay verified')).toBeVisible({ timeout: 30_000 });
    await expect(page.locator('.table')).toContainText('Guest Bot');
    await guest.page.context().close();
  });
});

test.describe('ranked', () => {
  test('a queued bot plays, appears on its public page, profile, and the ladder', async ({
    page,
  }) => {
    const username = await register(page);
    const botId = await createBot(page, 'Ladder Bot');
    await setSource(page, WALKER);
    await saveVersion(page, 'Ladder v1');
    await expect(page.getByText(/as version 1/)).toBeVisible();
    await page.getByRole('tab', { name: 'Ranked' }).click();
    await page.getByRole('button', { name: 'Queue for ranked' }).click();

    await expect(async () => {
      await page.goto('/');
      await expect(page.locator('.match-list .match-row').first()).toBeVisible({ timeout: 1000 });
    }).toPass({ timeout: 45_000 });
    await expect(page.locator('.bot-row', { hasText: 'Ladder Bot' })).toContainText('games');

    await page.goto('/matches');
    await page.getByLabel('Only my bots').check();
    const finished = page.locator('.card', {
      has: page.getByRole('heading', { name: 'Finished' }),
    });
    await expect(finished.locator('.match-row').first()).toContainText('Ladder Bot');
    await finished.locator('.match-row').first().click();
    await expect(page.getByText('Replay verified')).toBeVisible({ timeout: 30_000 });
    await page.getByRole('button', { name: 'Pause' }).click();
    await page.getByLabel('Playback speed').selectOption('8');
    await page.getByLabel('Replay position').fill('0');
    await page.getByRole('button', { name: 'Play' }).click();
    await expect(page.getByRole('button', { name: 'Pause' })).toBeVisible();

    await page.locator('.table').getByRole('link', { name: 'Ladder Bot' }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Ladder Bot' })).toBeVisible();
    await expect(page.locator('.editor-page')).toBeVisible();

    await page.goto('/leaderboard');
    const row = page.locator('tr', { hasText: 'Ladder Bot' });
    await expect(row).toHaveClass(/is-mine/);
    await row.getByRole('link', { name: username }).click();
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(username);
    await expect(page.locator('.match-list .match-row').first()).toBeVisible();
    await page.goto('/leaderboard');
    await page.getByRole('link', { name: 'Cautious Bomber' }).first().click();
    await expect(page.getByText('House bot')).toBeVisible();
    expect(botId).toBeTruthy();
  });
});
