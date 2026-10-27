// End-to-end test of the in-app variant (no extension): runs a session once with tab capture
// (auto-accepted) and once with DOM-rendered screenshots. Usage: pnpm e2e:embed
import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { startEmbedDevServer } from './embed-dev.mjs';

const out = resolve('test-results/embed');
mkdirSync(out, { recursive: true });
const server = await startEmbedDevServer(5181);
const browser = await chromium.launch({
  channel: 'chromium',
  headless: !process.env.HEADED,
  args: ['--auto-accept-this-tab-capture'],
});

const fail = (msg) => {
  console.error(`✗ ${msg}`);
  process.exitCode = 1;
};
const count = (page, n) =>
  page.waitForFunction(
    (n) => document.querySelector('nitpick-ui')?.shadowRoot?.querySelector('.af-rec')?.textContent?.trim() === String(n),
    n,
  );

async function run(shots) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  page.on('pageerror', (err) => fail(`[${shots}] page error: ${err.message}`));
  await page.goto(`http://localhost:5181/settings?shots=${shots}`);
  await page.click('#af-record');
  const toolbar = page.locator('nitpick-ui .af-toolbar');
  await toolbar.waitFor({ timeout: 5000 });
  const tab = await page.evaluate(() => window.__recorder.usesTabCapture);
  if ((shots === 'auto') !== tab) fail(`[${shots}] tab capture active=${tab}`);

  await page.fill('#name', 'ACME GmbH');
  await page.fill('#pw', 'super-secret');
  await page.click('#broken');

  // Element comment via hold-to-comment
  await page.hover('[data-testid=settings-save]');
  await page.keyboard.down('Control');
  await page.keyboard.down('Alt');
  await page.locator('nitpick-ui .af-highlight').waitFor({ timeout: 2000 });
  await page.click('[data-testid=settings-save]', { modifiers: ['Control', 'Alt'] });
  await page.keyboard.up('Alt');
  await page.keyboard.up('Control');
  const composer = page.locator('nitpick-ui .af-composer textarea');
  await composer.fill('Label sollte "Speichern" heißen');
  await composer.press('Control+Enter');
  await count(page, 1);

  // Composer typing must not reach the page (isolated events) and clicks navigate normally again
  await page.click('text=Benutzer');
  await page.waitForURL('**/users');
  await page.waitForTimeout(300); // let the IndexedDB write of the navigation finish

  // Full reload: the session survives in IndexedDB and the toolbar comes back
  await page.reload();
  await toolbar.waitFor({ timeout: 5000 });
  await count(page, 1);

  await toolbar.getByRole('button', { name: 'Bereich' }).click();
  const card = await page.locator('.card').boundingBox();
  await page.mouse.move(card.x - 6, card.y - 6);
  await page.mouse.down();
  await page.mouse.move(card.x + card.width + 6, card.y + card.height + 6, { steps: 5 });
  await page.mouse.up();
  await composer.fill('Abstand zu groß');
  await composer.press('Control+Enter');
  await count(page, 2);

  await toolbar.getByRole('button', { name: 'Fertig' }).click();
  await toolbar.getByRole('button', { name: 'Übernehmen' }).click();
  await page.locator('#af-modal[open]').waitFor({ timeout: 5000 });
  await page.screenshot({ path: join(out, `${shots}-modal.png`) });
  if (await page.locator('nitpick-ui').count()) fail(`[${shots}] toolbar still mounted during hand-over`);

  const result = await page.evaluate(async () => {
    const r = window.__lastResult;
    const files = await Promise.all(
      r.files.map(async (f) => ({ name: f.name, type: f.type, b64: btoa(String.fromCharCode(...new Uint8Array(await f.arrayBuffer()))) })),
    );
    return { md: r.markdown, linked: r.renderMarkdown({ assetUrl: (p) => `https://cdn.example/${p}` }), files };
  });
  writeFileSync(join(out, `${shots}-feedback.md`), result.md);
  for (const f of result.files) writeFileSync(join(out, `${shots}-${f.name.replace('/', '-')}`), Buffer.from(f.b64, 'base64'));

  const checks = [
    ['component chain', '`SettingsPage › SettingsForm › SaveButton`'],
    ['test id', 'data-testid=settings-save'],
    ['meta tag metadata', 'version: 2.4.1'],
    ['option context', 'tenant: acme'],
    ['console error', 'Cannot read properties of undefined'],
    ['input recorded', 'input textbox "Firmenname" = "ACME GmbH"'],
    ['password masked', '= "••••"'],
    ['spa navigation', 'navigate /users'],
    ['region comment', 'Marked area (viewport)'],
  ];
  for (const [name, needle] of checks) if (!result.md.includes(needle)) fail(`[${shots}] ${name}: missing "${needle}"`);
  if (result.md.includes('super-secret')) fail(`[${shots}] password leaked`);
  if (/click (div|main|html|button "(Feedback aufnehmen|Fertig|Bereich)")/.test(result.md)) fail(`[${shots}] noise/own-UI click recorded`);
  if (!result.linked.includes('![close-up](https://cdn.example/screenshots/01-crop.png)')) fail(`[${shots}] image links not rendered`);
  const pngs = result.files.filter((f) => f.type === 'image/png');
  if (pngs.length !== 4) fail(`[${shots}] expected 4 screenshots, got ${pngs.length}`);

  // Cancel in the modal → toolbar returns; "Ticket erstellen" → session cleared
  await page.click('#af-cancel');
  await toolbar.getByRole('button', { name: 'Übernehmen' }).waitFor({ timeout: 5000 });
  await toolbar.getByRole('button', { name: 'Übernehmen' }).click();
  await page.click('#af-submit');
  await page.waitForTimeout(200);
  const pending = await page.evaluate(() => localStorage.getItem('nitpick:pending'));
  if (pending) fail(`[${shots}] session not cleared (${pending})`);
  await page.reload();
  await page.waitForTimeout(500);
  if (await page.locator('nitpick-ui').count()) fail(`[${shots}] toolbar restored after clear`);
  await page.close();
  console.log(`  [${shots}] ok – ${result.files.length} files`);
}

try {
  await run('auto');
  await run('dom');
  if (!process.exitCode) console.log('✓ embed e2e passed, artifacts in test-results/embed/');
} catch (err) {
  fail(err.stack ?? String(err));
} finally {
  await browser.close();
  await server.close();
}
