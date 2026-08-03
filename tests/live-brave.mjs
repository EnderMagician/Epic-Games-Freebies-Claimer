import { createRequire } from 'node:module';
import { mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline/promises';

const require = createRequire(import.meta.url);
const playwrightRoot = process.env.CODEX_NODE_MODULES || 'C:\\Users\\ASUS\\.cache\\codex-runtimes\\codex-primary-runtime\\dependencies\\node\\node_modules';
const { chromium } = require(join(playwrightRoot, 'playwright'));
const extensionDir = process.cwd();
const bravePath = process.env.BRAVE_PATH || 'C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe';
const profileDir = join(tmpdir(), `epic-freebies-brave-e2e-${Date.now()}`);

await mkdir(profileDir, { recursive: true });
const context = await chromium.launchPersistentContext(profileDir, {
  executablePath: bravePath,
  headless: false,
  args: [`--disable-extensions-except=${extensionDir}`, `--load-extension=${extensionDir}`, '--no-first-run', '--no-default-browser-check']
});

context.on('page', (page) => {
  page.on('console', (message) => console.log(`[page console:${message.type()}] ${message.text()}`));
  page.on('pageerror', (error) => console.log(`[page error] ${error.message}`));
  page.on('requestfailed', (request) => console.log(`[request failed] ${request.url()} :: ${request.failure()?.errorText || 'unknown'}`));
});

try {
  const store = context.pages()[0] || await context.newPage();
  await store.goto('https://store.epicgames.com/en-US/free-games', { waitUntil: 'domcontentloaded' });
  console.log('Isolated Brave is open at Epic Games Store. Sign in there if needed, then return here.');
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  await rl.question('Press Enter after the Epic session is ready: ');
  rl.close();

  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker', { timeout: 10000 });
  const extensionId = new URL(worker.url()).hostname;
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extensionId}/popup/popup.html`);
  await popup.waitForTimeout(1500);
  console.log('Initial popup state:', (await popup.locator('body').innerText()).slice(0, 1000));

  await popup.locator('#refresh').click();
  await popup.waitForTimeout(3000);
  const games = await popup.locator('#epic-list .m3-game-card').count();
  console.log(`Current Epic promotion cards: ${games}`);
  if (games < 1) throw new Error('No current Epic promotion cards were rendered.');

  for (let index = 0; index < Math.min(games, 2); index += 1) {
    const card = popup.locator('#epic-list .m3-game-card').nth(index);
    const title = await card.locator('.title').innerText();
    const button = card.locator('.claim-btn');
    if (await button.isDisabled()) {
      console.log(`Skipping already-completed game: ${title}`);
      continue;
    }
    console.log(`Claiming staged game ${index + 1}: ${title}`);
    await button.click();
    await waitForSettlement(popup, title, 45000);
    console.log((await popup.locator('body').innerText()).slice(0, 1000));
  }

  console.log('Open pages after claims:', context.pages().map((page) => page.url()));

  await popup.reload({ waitUntil: 'domcontentloaded' });
  await popup.waitForTimeout(1500);
  console.log('Post-claim persisted state:', (await popup.locator('body').innerText()).slice(0, 1400));
} finally {
  await context.close();
  await rm(profileDir, { recursive: true, force: true });
}

async function waitForSettlement(popup, title, timeoutMs) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const text = await popup.locator('body').innerText();
    const claimedTitles = await popup.locator('#claimed-list .claimed-title').allTextContents();
    if (claimedTitles.some((value) => value.trim() === title)) return;
    if (text.includes('Needs attention') || text.includes('Cần xử lý') || text.includes('needs_attention')) {
      throw new Error(`Epic requires manual attention while claiming ${title}.`);
    }
    const pending = await popup.locator('.claim-btn').evaluateAll((buttons) => buttons.some((button) => button.textContent?.includes('Claiming')));
    if (!pending) return;
    await popup.waitForTimeout(1500);
  }
  throw new Error(`Claim did not settle within ${timeoutMs}ms: ${title}`);
}
