// Headless browser smoke test: builds nothing; expects `vite preview` (or dev) at URL.
// Usage: node scripts/smoke.mjs [url] [outDir]
import { chromium } from 'playwright-core';
import fs from 'node:fs';

const url = process.argv[2] ?? 'http://localhost:4173/';
const out = process.argv[3] ?? 'smoke-out';
fs.mkdirSync(out, { recursive: true });

const browser = await chromium.launch({
  channel: 'chrome',
  headless: true,
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = [];
page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') errors.push(`[${m.type()}] ${m.text()}`); });
page.on('pageerror', (e) => errors.push(`[pageerror] ${e.stack ?? e.message}`));

await page.goto(url, { waitUntil: 'networkidle' });
await page.waitForTimeout(1500);
await page.screenshot({ path: `${out}/01-welcome.png` });

// dismiss welcome card if present
await page.getByRole('button', { name: /let.s play/i }).click({ timeout: 3000 }).catch(() => errors.push('[smoke] no welcome button'));
await page.waitForTimeout(500);
await page.screenshot({ path: `${out}/02-idle.png` });

const phase = () => page.evaluate(() => window.__spinlab.engine.snapshot().phase);
async function waitPhase(p, timeout = 8000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    if ((await phase()) === p) return true;
    await page.waitForTimeout(50);
  }
  return false;
}

const report = {};
async function playBall(tag, opts = {}) {
  await page.evaluate((o) => { if (o.settings) window.__spinlab.applySettings(o.settings); if (o.control) window.__spinlab.setControl(o.control); }, opts);
  await page.evaluate(() => window.__spinlab.nextBall());
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${out}/${tag}-a-windup.png` });
  await waitPhase('incoming');
  await page.waitForTimeout(250);
  await page.screenshot({ path: `${out}/${tag}-b-incoming.png` });
  if (opts.settings?.controlMode === 'freeze') {
    report[`${tag}-frozen`] = await waitPhase('frozen');
    await page.screenshot({ path: `${out}/${tag}-c-frozen.png` });
    await page.keyboard.press('Space');
  }
  report[`${tag}-result`] = await waitPhase('result', 12000);
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${out}/${tag}-d-result.png` });
  report[`${tag}-outcome`] = await page.evaluate(() => window.__spinlab.getLastResult()?.outcome);
}

await playBall('custom', {});
await playBall('freeze', { settings: { controlMode: 'freeze' } });
await playBall('bot', { settings: { controlMode: 'realtime', opponentMode: 'bot', assist: 'full' } });
await playBall('botwind', { settings: { assist: 'wind' } });
await page.evaluate(() => window.__spinlab.applySettings({ camera: 'side' }));
await playBall('side', { settings: { assist: 'full' } });
await page.evaluate(() => window.__spinlab.applySettings({ camera: 'opponent' }));
await playBall('opp', {});
await page.evaluate(() => window.__spinlab.applySettings({ camera: 'player', autoPosition: false }));
await playBall('manual', { control: { x: 0, y: 0.9 } });

// keyboard / help
await page.keyboard.press('KeyH');
await page.waitForTimeout(300);
await page.screenshot({ path: `${out}/90-help.png` });
await page.keyboard.press('KeyH');

console.log(JSON.stringify({ report, errors }, null, 2));
await browser.close();
