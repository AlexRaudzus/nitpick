// End-to-end smoke test: loads the built extension into Chromium and runs a feedback session.
// Usage: pnpm build && pnpm e2e   (artifacts land in test-results/)
import { chromium } from 'playwright';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { server } from './serve.mjs';

const extPath = resolve('.output/chrome-mv3');
const out = resolve('test-results');
mkdirSync(out, { recursive: true });
await new Promise((r) => server.listen(5179, r));

const ctx = await chromium.launchPersistentContext(mkdtempSync(join(tmpdir(), 'af-')), {
  channel: 'chromium',
  headless: process.env.HEADED ? false : true,
  viewport: { width: 1280, height: 800 },
  args: [`--disable-extensions-except=${extPath}`, `--load-extension=${extPath}`],
});

const fail = (msg) => {
  console.error(`✗ ${msg}`);
  process.exitCode = 1;
};

try {
  const sw = ctx.serviceWorkers()[0] ?? (await ctx.waitForEvent('serviceworker'));
  const extId = new URL(sw.url()).host;
  const page = await ctx.newPage();
  await page.goto('http://localhost:5179/settings');
  await page.waitForTimeout(500);

  // Start a session the way the popup does
  const popup = await ctx.newPage();
  await popup.goto(`chrome-extension://${extId}/popup.html`);
  await popup.getByRole('button', { name: 'Session starten' }).click();
  await popup.close().catch(() => undefined);
  await page.bringToFront();

  const toolbar = page.locator('agent-feedback-ui .af-toolbar');
  await toolbar.waitFor({ timeout: 5000 }).catch(async (err) => {
    const hosts = await page.evaluate(() =>
      [...document.querySelectorAll('agent-feedback-ui')].map((h) => h.shadowRoot?.innerHTML.slice(0, 120) ?? 'no shadow'),
    );
    const session = await sw.evaluate(async () => (await chrome.storage.local.get('session')).session?.active);
    throw new Error(`toolbar missing; session active=${session}; hosts=${JSON.stringify(hosts)}\n${err.message}`);
  });

  // Default: the app can be operated normally
  await page.fill('#name', 'ACME GmbH');
  await page.fill('#pw', 'super-secret');
  await page.click('#broken');
  await page.click('main', { position: { x: 600, y: 20 } }); // container click: must not show up in timeline

  // 1) Element comment by holding Ctrl+Alt
  await page.hover('[data-testid=settings-save]');
  await page.keyboard.down('Control');
  await page.keyboard.down('Alt');
  await page.locator('agent-feedback-ui .af-highlight').waitFor({ timeout: 2000 });
  await page.click('[data-testid=settings-save]', { modifiers: ['Control', 'Alt'] });
  await page.keyboard.up('Alt');
  await page.keyboard.up('Control');
  const composer = page.locator('agent-feedback-ui .af-composer textarea');
  await composer.fill('Label sollte "Speichern" heißen statt "Submit"');
  await composer.press('Control+Enter');
  await page.locator('agent-feedback-ui .af-pin').first().waitFor({ timeout: 5000 });

  // Releasing the keys returns to normal operation: this click must navigate
  await page.click('text=Benutzer');
  await page.waitForURL('**/users');

  // 2) Region comment
  await toolbar.getByRole('button', { name: 'Bereich' }).click();
  const card = await page.locator('.card').boundingBox();
  await page.mouse.move(card.x - 6, card.y - 6);
  await page.mouse.down();
  await page.mouse.move(card.x + card.width + 6, card.y + card.height + 6, { steps: 5 });
  await page.mouse.up();
  await composer.fill('Abstand zur Form ist zu groß');
  await composer.press('Control+Enter');
  // only the region pin belongs to /users; the element pin stays on /settings
  await page.waitForFunction(() =>
    document.querySelector('agent-feedback-ui')?.shadowRoot?.querySelector('.af-rec')?.textContent?.includes('2'),
  );

  // 3) General note from the drawer that opens on hover
  await toolbar.getByRole('button', { name: 'Notiz' }).hover();
  const note = page.locator('agent-feedback-ui .af-drawer.af-open textarea');
  await note.waitFor({ timeout: 2000 });
  await page.waitForTimeout(300); // let the animation finish for the screenshot
  await page.screenshot({ path: join(out, 'drawer-note.png') });
  await note.fill('Seite lädt insgesamt langsam');
  await note.press('Control+Enter');
  await page.waitForFunction(() =>
    document.querySelector('agent-feedback-ui')?.shadowRoot?.querySelector('.af-rec')?.textContent?.includes('3'),
  );

  await page.screenshot({ path: join(out, 'page-with-pins.png') });
  // 4) One-shot pick via "+ Kommentar" ends after one element
  await toolbar.getByRole('button', { name: '+ Kommentar' }).click();
  await page.click('h1');
  await composer.fill('Überschrift zu groß');
  await composer.press('Control+Enter');
  await page.waitForFunction(() =>
    document.querySelector('agent-feedback-ui')?.shadowRoot?.querySelector('.af-rec')?.textContent?.includes('4'),
  );
  await page.click('text=Einstellungen');
  await page.waitForURL('**/settings');

  await toolbar.getByRole('button', { name: 'Liste' }).hover();
  await page.locator('agent-feedback-ui .af-drawer.af-open .af-item').first().waitFor({ timeout: 2000 });
  await page.waitForTimeout(300);
  await page.screenshot({ path: join(out, 'drawer-list.png') });
  await toolbar.getByRole('button', { name: 'Fertig' }).click();
  await toolbar.getByRole('button', { name: 'Exportieren' }).waitFor();
  await page.screenshot({ path: join(out, 'stopped.png') });

  // Read results through an extension page
  const ext = await ctx.newPage();
  await ext.goto(`chrome-extension://${extId}/popup.html`);
  const result = await ext.evaluate(async () => {
    const md = await chrome.runtime.sendMessage({ type: 'export:markdown' });
    const exp = await chrome.runtime.sendMessage({ type: 'export:folder' });
    const all = await chrome.storage.local.get(null);
    const assets = Object.entries(all).filter(([k]) => k.startsWith('asset:'));
    return { md: md.data, exp, assets: Object.fromEntries(assets), session: all.session };
  });
  writeFileSync(join(out, 'feedback.md'), result.md);
  for (const c of result.session.comments) {
    for (const [kind, id] of Object.entries(c.screenshots)) {
      const data = result.assets[`asset:${id}`];
      if (data) writeFileSync(join(out, `${String(c.index).padStart(2, '0')}-${kind}.png`), Buffer.from(data.split(',')[1], 'base64'));
    }
  }

  const md = result.md;
  const checks = [
    ['component chain (internals filtered)', '`SettingsPage › SettingsForm › SaveButton`'],
    ['element context', 'inside: section "Einstellungen" › form'],
    ['test id', 'data-testid=settings-save'],
    ['page metadata (meta tag)', 'version: 2.4.1'],
    ['page metadata (global)', 'userRole: admin'],
    ['page metadata (event)', 'featureFlags: ["newSettings"]'],
    ['console error', 'Cannot read properties of undefined'],
    ['input recorded', 'input textbox "Firmenname" = "ACME GmbH"'],
    ['password masked', '= "••••"'],
    ['spa navigation', 'navigate /users'],
    ['region comment', 'Marked area (viewport)'],
    ['note', 'Seite lädt insgesamt langsam'],
    ['one-shot comment', 'Überschrift zu groß'],
  ];
  for (const [name, needle] of checks) if (!md.includes(needle)) fail(`${name}: missing "${needle}"`);
  if (md.includes('super-secret')) fail('password leaked');
  if (/click (div|main|html)\b/.test(md)) fail('noise click recorded');
  const ownUiOnTop = await page.evaluate(() => {
    const r = document.querySelector('agent-feedback-ui').shadowRoot.querySelector('.af-toolbar').getBoundingClientRect();
    return document.elementFromPoint(r.left + 10, r.top + 10)?.tagName.toLowerCase();
  });
  if (ownUiOnTop !== 'agent-feedback-ui') fail(`toolbar covered by ${ownUiOnTop}`);
  if (!result.exp.ok) fail(`export failed: ${result.exp.error}`);
  else console.log(`  export path: ${result.exp.data.path} (copied: ${result.exp.data.copied})`);
  if (result.exp.ok && !result.exp.data.copied) fail('export path not copied to clipboard');
  if (Object.keys(result.assets).length !== 7) fail(`expected 7 screenshots, got ${Object.keys(result.assets).length}`);
  if (!process.exitCode) console.log(`✓ e2e passed – ${result.exp.data.files} files exported, artifacts in test-results/`);
} catch (err) {
  fail(err.stack ?? String(err));
} finally {
  await ctx.close();
  server.close();
}
