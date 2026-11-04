// End-to-end smoke test: loads the built extension into Chromium and runs a feedback session.
// Usage: pnpm build && pnpm e2e   (artifacts land in test-results/)
import { chromium } from 'playwright';
import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
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

  // Start a session like a click on the toolbar icon does
  const clickIcon = () =>
    sw.evaluate(async () => {
      const [tab] = await chrome.tabs.query({ url: 'http://localhost:5179/*' });
      await globalThis.__nitpick.onActionClicked(tab);
    });
  await clickIcon();

  const toolbar = page.locator('nitpick-ui .af-toolbar');
  await toolbar.waitFor({ timeout: 5000 }).catch(async (err) => {
    const hosts = await page.evaluate(() =>
      [...document.querySelectorAll('nitpick-ui')].map((h) => h.shadowRoot?.innerHTML.slice(0, 120) ?? 'no shadow'),
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
  await page.locator('nitpick-ui .af-highlight').waitFor({ timeout: 2000 });
  await page.click('[data-testid=settings-save]', { modifiers: ['Control', 'Alt'] });
  await page.keyboard.up('Alt');
  await page.keyboard.up('Control');
  const composer = page.locator('nitpick-ui .af-composer textarea');
  await composer.fill('Label sollte "Speichern" heißen statt "Submit"');
  await composer.press('Control+Enter');
  await page.locator('nitpick-ui .af-pin').first().waitFor({ timeout: 5000 });

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
    document.querySelector('nitpick-ui')?.shadowRoot?.querySelector('.af-rec')?.textContent?.includes('2'),
  );

  // 3) General note from the drawer that opens on hover
  await toolbar.getByRole('button', { name: 'Notiz' }).hover();
  const note = page.locator('nitpick-ui .af-drawer.af-open textarea');
  await note.waitFor({ timeout: 2000 });
  await page.waitForTimeout(300); // let the animation finish for the screenshot
  await page.screenshot({ path: join(out, 'drawer-note.png') });
  await note.fill('Seite lädt');
  // No save button: hovering over "Liste" switches the drawer and must not lose the text
  await toolbar.getByRole('button', { name: 'Liste' }).hover();
  await page.waitForFunction(() =>
    document.querySelector('nitpick-ui')?.shadowRoot?.querySelector('.af-rec')?.textContent?.includes('3'),
  );
  // Reopening shows the note; further edits update it in place (no second comment)
  await toolbar.getByRole('button', { name: 'Notiz' }).hover();
  await note.waitFor({ timeout: 2000 });
  if ((await note.inputValue()) !== 'Seite lädt') fail(`note not restored: "${await note.inputValue()}"`);
  await note.fill('Seite lädt insgesamt langsam');
  await page.waitForTimeout(900);
  // Leaving the toolbar closes the drawer, even though the note field had focus
  await page.mouse.move(100, 100);
  await page.locator('nitpick-ui .af-drawer.af-open').waitFor({ state: 'detached', timeout: 2000 });

  await page.screenshot({ path: join(out, 'page-with-pins.png') });
  // 3b) Element inside a cross-origin iframe, picked by holding Ctrl+Alt
  const frameBtn = page.frameLocator('iframe[name=Embedded]').locator('[data-slot=frame-action]');
  await frameBtn.click(); // normal click: recorded in the timeline, logs an error inside the frame
  await page.locator('h1').hover();
  await page.keyboard.down('Control');
  await page.keyboard.down('Alt');
  await frameBtn.hover({ modifiers: ['Control', 'Alt'] });
  await page.waitForTimeout(200);
  await frameBtn.click({ modifiers: ['Control', 'Alt'] });
  await page.keyboard.up('Alt');
  await page.keyboard.up('Control');
  await composer.fill('Button im iframe zu klein');
  await page.screenshot({ path: join(out, 'iframe-composer.png') });
  await composer.press('Control+Enter');
  await page.waitForFunction(() =>
    document.querySelector('nitpick-ui')?.shadowRoot?.querySelector('.af-rec')?.textContent?.includes('4'),
  );

  // 4) One-shot pick via "+ Kommentar" ends after one element
  await toolbar.getByRole('button', { name: '+ Kommentar' }).click();
  await page.click('h1');
  await composer.fill('Überschrift zu groß');
  await composer.press('Control+Enter');
  await page.waitForFunction(() =>
    document.querySelector('nitpick-ui')?.shadowRoot?.querySelector('.af-rec')?.textContent?.includes('5'),
  );
  await page.click('text=Einstellungen');
  await page.waitForURL('**/settings');

  await toolbar.getByRole('button', { name: 'Liste' }).hover();
  await page.locator('nitpick-ui .af-drawer.af-open .af-item').first().waitFor({ timeout: 2000 });
  await page.waitForTimeout(300);
  await page.screenshot({ path: join(out, 'drawer-list.png') });
  // Drag the toolbar out of the way (to the upper left); the position survives a reload
  const dockBox = async () => page.locator('nitpick-ui .af-toolbar').boundingBox();
  const before = await dockBox();
  const grip = await page.locator('nitpick-ui .af-grip').boundingBox();
  await page.mouse.move(grip.x + 4, grip.y + 8);
  await page.mouse.down();
  await page.mouse.move(grip.x - 500, grip.y - 500, { steps: 8 });
  await page.mouse.up();
  const after = await dockBox();
  if (!(after.x < before.x - 400 && after.y < before.y - 400)) fail(`toolbar not dragged: ${JSON.stringify({ before, after })}`);
  await toolbar.getByRole('button', { name: 'Liste' }).hover();
  await page.locator('nitpick-ui .af-drawer.af-open .af-item').first().waitFor({ timeout: 2000 });
  await page.waitForTimeout(300);
  await page.screenshot({ path: join(out, 'dragged.png') });
  await page.reload();
  await toolbar.waitFor({ timeout: 5000 });
  const reloaded = await dockBox();
  if (Math.abs(reloaded.y - after.y) > 2) fail(`toolbar position not restored: ${after.y} → ${reloaded.y}`);
  await page.locator('nitpick-ui .af-grip').dblclick();
  await page.mouse.move(10, 400);

  // Another tab that has nothing to do with the session must not end up in the timeline
  const other = await ctx.newPage();
  await other.goto('http://localhost:5179/other');
  await other.waitForTimeout(500);
  await other.fill('#name', 'OTHER-TAB');
  await other.click('#broken');
  await other.waitForTimeout(300);
  await other.close();
  await page.bringToFront();

  await toolbar.getByRole('button', { name: 'Fertig' }).click();
  await toolbar.getByRole('button', { name: 'Exportieren' }).waitFor();
  await page.screenshot({ path: join(out, 'stopped.png') });
  await toolbar.getByRole('button', { name: 'Weitere Export-Optionen' }).click();
  await page.locator('nitpick-ui .af-menu [role=menuitem]').filter({ hasText: 'Markdown kopieren' }).waitFor({ timeout: 2000 });
  await page.screenshot({ path: join(out, 'export-menu.png') });
  await page.keyboard.press('Escape');
  await page.locator('nitpick-ui .af-menu').waitFor({ state: 'detached', timeout: 2000 });
  // Discarding asks in place of the whole row; cancelling brings the actions back
  await toolbar.getByRole('button', { name: 'Verwerfen' }).click();
  await toolbar.getByText('Alle 5 Kommentare verwerfen?').waitFor({ timeout: 2000 });
  if (await toolbar.getByRole('button', { name: 'Fortsetzen' }).count()) fail('Fortsetzen visible while confirming discard');
  await page.screenshot({ path: join(out, 'discard-confirm.png') });
  await toolbar.getByRole('button', { name: 'Abbrechen' }).click();
  await toolbar.getByRole('button', { name: 'Exportieren' }).waitFor({ timeout: 2000 });

  // Checked before the export, which clears the session and with it the toolbar
  const ownUiOnTop = await page.evaluate(() => {
    const r = document.querySelector('nitpick-ui').shadowRoot.querySelector('.af-toolbar').getBoundingClientRect();
    return document.elementFromPoint(r.left + 10, r.top + 10)?.tagName.toLowerCase();
  });
  if (ownUiOnTop !== 'nitpick-ui') fail(`toolbar covered by ${ownUiOnTop}`);

  // Read results through an extension page
  const ext = await ctx.newPage();
  await ext.goto(`chrome-extension://${extId}/offscreen.html`);
  const result = await ext.evaluate(async () => {
    const md = await chrome.runtime.sendMessage({ type: 'export:markdown' });
    const all = await chrome.storage.local.get(null);
    const assets = Object.entries(all).filter(([k]) => k.startsWith('asset:'));
    // The export clears the session, so read storage first
    const exp = await chrome.runtime.sendMessage({ type: 'export:folder' });
    const after = await chrome.storage.local.get('session');
    return { md: md.data, exp, assets: Object.fromEntries(assets), session: all.session, cleared: !after.session };
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
    ['iframe element', 'in iframe: `iframe[name="Embedded"]` (http://127.0.0.1:5179/frame)'],
    ['iframe selector', 'selector: `button[data-slot="frame-action"]`'],
    ['iframe click in timeline', 'click button "Im Frame speichern" (in iframe)'],
    ['iframe console error', 'Frame failed to save'],
  ];
  for (const [name, needle] of checks) if (!md.includes(needle)) fail(`${name}: missing "${needle}"`);
  if (md.includes('super-secret')) fail('password leaked');
  if (md.includes('OTHER-TAB') || md.includes('/other')) fail('unrelated tab recorded');
  if (md.includes('now on 127.0.0.1')) fail('iframe event treated as origin change');
  if (/click (div|main|html)\b/.test(md)) fail('noise click recorded');
  if (!result.exp.ok) fail(`export failed: ${result.exp.error}`);
  else console.log(`  export path: ${result.exp.data.path} (copied: ${result.exp.data.copied})`);
  if (result.exp.ok && !result.exp.data.copied) fail('export path not copied to clipboard');
  if (result.exp.ok && !result.cleared) fail('session not cleared after export');
  if (Object.keys(result.assets).length !== 9) fail(`expected 9 screenshots, got ${Object.keys(result.assets).length}`);
  // Headless mode: icon starts a fresh session, Ctrl+Alt+H hides the toolbar, Ctrl+Alt+E exports and restarts
  const stored = () => sw.evaluate(async () => (await chrome.storage.local.get('session')).session);
  await sw.evaluate(() => chrome.storage.local.remove('session'));
  await page.waitForFunction(() => !document.querySelector('nitpick-ui')?.shadowRoot?.querySelector('.af-toolbar'));
  await clickIcon();
  await toolbar.waitFor({ timeout: 5000 });
  const badge = await sw.evaluate(() => chrome.action.getBadgeText({}));
  if (badge !== '0') fail(`badge "${badge}" instead of "0"`);
  await page.keyboard.down('Control');
  await page.keyboard.down('Alt');
  await page.locator('nitpick-ui .af-keys').waitFor({ timeout: 2000 });
  await page.screenshot({ path: join(out, 'shortcut-hint.png') });
  await page.keyboard.press('KeyH');
  await toolbar.waitFor({ state: 'detached', timeout: 2000 });
  await page.click('h1', { modifiers: ['Control', 'Alt'] });
  await page.keyboard.up('Alt');
  await page.keyboard.up('Control');
  await composer.fill('Headless-Kommentar');
  await composer.press('Control+Enter');
  const toast = page.locator('nitpick-ui .af-toast');
  await toast.filter({ hasText: 'Kommentar 1 gespeichert' }).waitFor({ timeout: 5000 });
  await page.screenshot({ path: join(out, 'headless.png') });
  // Ctrl+Alt+N opens the page note without a toolbar; typing goes straight into it
  await page.keyboard.down('Control');
  await page.keyboard.down('Alt');
  await page.keyboard.press('KeyN');
  await page.keyboard.up('Alt');
  await page.keyboard.up('Control');
  await note.waitFor({ timeout: 2000 });
  await page.keyboard.type('Headless-Notiz');
  await page.waitForTimeout(300);
  await page.screenshot({ path: join(out, 'headless-note.png') });
  await page.keyboard.press('Escape');
  await toast.filter({ hasText: 'Kommentar 2 gespeichert' }).waitFor({ timeout: 5000 });
  await page.keyboard.down('Control');
  await page.keyboard.down('Alt');
  await page.keyboard.press('KeyE');
  await page.keyboard.up('Alt');
  await page.keyboard.up('Control');
  await toast.filter({ hasText: 'neue Session läuft' }).waitFor({ timeout: 10000 });
  const fresh = await stored();
  if (!fresh?.active || fresh.comments.length || !fresh.hidden) fail(`no fresh hidden session after export: ${JSON.stringify(fresh)?.slice(0, 200)}`);
  // icon click on a running hidden session shows the toolbar again
  await clickIcon();
  await toolbar.waitFor({ timeout: 2000 });

  // Import: the first export, laid out on disk like the real export folder, replaces the current session
  const importDir = join(out, 'import', 'nitpick-export');
  mkdirSync(join(importDir, 'screenshots'), { recursive: true });
  const exported = {
    format: 'nitpick/v1',
    ...result.session,
    comments: result.session.comments.map((c) => {
      const screenshots = {};
      for (const [kind, id] of Object.entries(c.screenshots)) {
        const data = result.assets[`asset:${id}`];
        if (!data) continue;
        screenshots[kind] = `screenshots/${String(c.index).padStart(2, '0')}-${kind}.png`;
        writeFileSync(join(importDir, screenshots[kind]), Buffer.from(data.split(',')[1], 'base64'));
      }
      return { ...c, screenshots };
    }),
  };
  writeFileSync(join(importDir, 'feedback.json'), JSON.stringify(exported));
  await page.click('h1', { modifiers: ['Control', 'Alt'] });
  await composer.fill('Wird ersetzt');
  await composer.press('Control+Enter');
  await toolbar.getByRole('button', { name: 'Liste (1)' }).waitFor({ timeout: 5000 });
  await toolbar.getByRole('button', { name: 'Weitere Aktionen' }).click();
  const importItem = page.locator('nitpick-ui .af-menu').getByRole('menuitem', { name: 'Nitpick importieren…' });
  await importItem.waitFor({ timeout: 2000 });
  await page.keyboard.press('Escape');
  // Playwright can't hand a folder to this input (its setFiles stalls), so the files go in one by one
  const importInput = page.locator('nitpick-ui input[type=file]');
  await importInput.evaluate((i) => i.removeAttribute('webkitdirectory'));
  await importInput.evaluate((i) => (i.multiple = true));
  await importInput.setInputFiles([join(importDir, 'feedback.json'), ...readdirSync(join(importDir, 'screenshots')).map((f) => join(importDir, 'screenshots', f))]);
  await toolbar.getByText('Den Kommentar durch den Import ersetzen?').waitFor({ timeout: 2000 });
  await toolbar.getByRole('button', { name: 'Ersetzen' }).click();
  await toast.filter({ hasText: `${result.session.comments.length} Kommentare importiert` }).waitFor({ timeout: 5000 });
  await toolbar.getByRole('button', { name: 'Fortsetzen' }).waitFor({ timeout: 2000 });
  const imported = await stored();
  if (imported.active || imported.comments.length !== result.session.comments.length) fail(`import: unexpected session ${JSON.stringify(imported)?.slice(0, 200)}`);
  const importedShots = await sw.evaluate(async () => Object.keys(await chrome.storage.local.get(null)).filter((k) => k.startsWith('asset:')).length);
  if (importedShots !== Object.keys(result.assets).length) fail(`import: ${importedShots} screenshots instead of ${Object.keys(result.assets).length}`);
  await page.screenshot({ path: join(out, 'imported.png') });

  // Page parameters: a route mirrored into the query is suggested, and only applied once chosen
  const pins = page.locator('nitpick-ui .af-pin');
  const pinsHere = await pins.count();
  if (!pinsHere) fail('no markers for the imported comments on this page');
  await page.evaluate(() => history.pushState(null, '', '?_route=%2Fteams%2Fproblems'));
  const suggest = page.locator('nitpick-ui .af-suggest');
  await suggest.filter({ hasText: '_route' }).waitFor({ timeout: 2000 });
  if ((await pins.count()) !== pinsHere) fail('page params applied before the user chose them');
  await page.screenshot({ path: join(out, 'page-params-suggest.png') });
  await suggest.getByRole('button', { name: 'Trennen' }).click();
  await suggest.waitFor({ state: 'detached', timeout: 2000 });
  await pins.first().waitFor({ state: 'detached', timeout: 2000 });
  await page.evaluate(() => history.pushState(null, '', location.pathname));
  await pins.first().waitFor({ timeout: 2000 });
  // The "…" menu lets the user take it back
  await page.evaluate(() => history.pushState(null, '', '?_route=%2Fteams%2Fproblems'));
  await pins.first().waitFor({ state: 'detached', timeout: 2000 });
  await toolbar.getByRole('button', { name: 'Weitere Aktionen' }).click();
  await page.locator('nitpick-ui .af-menu').getByRole('menuitem', { name: 'Seiten unterscheiden nach…' }).click();
  const routeBox = page.locator('nitpick-ui .af-param').filter({ hasText: '_route' }).locator('input');
  if (!(await routeBox.isChecked())) fail('_route not checked in the page params drawer');
  await page.screenshot({ path: join(out, 'page-params-drawer.png') });
  await routeBox.uncheck();
  await pins.first().waitFor({ timeout: 2000 });
  if ((await pins.count()) !== pinsHere) fail(`expected ${pinsHere} markers after unchecking, got ${await pins.count()}`);
  if (await suggest.count()) fail('suggestion shown again after the user decided');

  // The page under each comment links there (full navigation; the session survives it)
  await page.mouse.move(10, 10);
  const pageLink = page.locator('nitpick-ui a.af-item-page[href*="/users"]').first();
  await pageLink.waitFor({ timeout: 2000 });
  await page.screenshot({ path: join(out, 'page-links.png') });
  await pageLink.click();
  await page.waitForURL(/\/users$/, { timeout: 5000 });
  await toolbar.getByRole('button', { name: 'Fortsetzen' }).waitFor({ timeout: 5000 });
  await page.locator('nitpick-ui .af-item-here .af-here').first().waitFor({ timeout: 2000 });
  // Hovering a marker previews its comment next to it
  await page.mouse.move(10, 10);
  const firstPin = page.locator('nitpick-ui .af-pin').first();
  await firstPin.hover();
  const preview = page.locator('nitpick-ui .af-preview');
  await preview.waitFor({ timeout: 2000 });
  const pinLabel = await firstPin.textContent();
  const listed = await page.locator('nitpick-ui .af-item').filter({ has: page.locator('.af-badge', { hasText: new RegExp(`^${pinLabel}$`) }) }).locator('.af-item-text').textContent();
  if (!(await preview.textContent()).includes(listed)) fail(`marker preview does not show comment ${pinLabel}`);
  await page.screenshot({ path: join(out, 'marker-preview.png') });
  await page.mouse.move(10, 10);
  await preview.waitFor({ state: 'detached', timeout: 2000 });

  if (!process.exitCode) console.log(`✓ e2e passed – ${result.exp.data.files} files exported, artifacts in test-results/`);
} catch (err) {
  fail(err.stack ?? String(err));
} finally {
  await ctx.close();
  server.close();
}
