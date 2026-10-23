import { browser, type Browser } from 'wxt/browser';
import { handle, type Request } from '@/extension/messages';
import { createSessionStore, type KVBackend } from '@/core/session-store';
import type { HostCommand } from '@/core/host';
import type { FeedbackSession } from '@/core/types';

// Service workers can be killed at any time, so all state lives in storage.local.
const kv: KVBackend = {
  get: (keys) => browser.storage.local.get(keys),
  set: (items) => browser.storage.local.set(items),
  remove: (keys) => browser.storage.local.remove(keys),
  keys: async () => Object.keys(await browser.storage.local.get(null)),
};
const store = createSessionStore(kv);

function dataUrl(mime: string, text: string): string {
  const bytes = new TextEncoder().encode(text);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return `data:${mime};base64,${btoa(bin)}`;
}

async function copyToClipboard(text: string): Promise<boolean> {
  try {
    if (!(await browser.offscreen.hasDocument())) {
      await browser.offscreen.createDocument({
        url: '/offscreen.html',
        reasons: ['CLIPBOARD'],
        justification: 'Copy the export path / markdown to the clipboard',
      });
    }
    return Boolean(await browser.runtime.sendMessage({ type: 'offscreen:copy', text }));
  } catch {
    return false;
  }
}

/** Absolute path of a finished download (Chrome only knows it once the file is written). */
async function downloadedPath(id: number): Promise<string | undefined> {
  for (let i = 0; i < 50; i++) {
    const [item] = await browser.downloads.search({ id });
    if (item?.state === 'complete' && item.filename) return item.filename;
    if (item?.state === 'interrupted') return undefined;
    await new Promise((r) => setTimeout(r, 100));
  }
  return undefined;
}

const pageOf = (tab?: Browser.tabs.Tab) => (tab?.url?.startsWith('http') ? { url: tab.url, title: tab.title } : undefined);

/**
 * Writes the export folder. Exporting a running session (shortcut) is a checkpoint: a fresh session
 * starts right away so feedback collection never stops.
 */
async function exportFolder(tab?: Browser.tabs.Tab) {
  const bundle = await store.bundle();
  if (!bundle.session.comments.length) throw new Error('Noch keine Kommentare');
  const folder = `agent-feedback/${bundle.folderName}`;
  const files: { name: string; url: string }[] = [
    { name: 'feedback.md', url: dataUrl('text/markdown', bundle.markdown) },
    { name: 'feedback.json', url: dataUrl('application/json', bundle.json) },
    ...bundle.assets.map((a) => ({ name: a.name, url: a.dataUrl })),
  ];
  const ids: number[] = [];
  for (const f of files) {
    ids.push(
      await browser.downloads.download({
        url: f.url,
        filename: `${folder}/${f.name}`,
        conflictAction: 'uniquify',
        saveAs: false,
      }),
    );
  }
  // Put the absolute folder path on the clipboard, ready to paste into the agent.
  const mdPath = ids[0] != null ? await downloadedPath(ids[0]) : undefined;
  const path = mdPath?.replace(/[\\/]feedback(?: \(\d+\))?\.md$/, '');
  const copied = path ? await copyToClipboard(path) : false;
  const restarted = bundle.session.active;
  if (restarted) {
    await store.discard();
    await store.start(pageOf(tab));
  }
  return { folder, path, files: files.length, copied, restarted };
}

async function onRequest(req: Request, sender: Browser.runtime.MessageSender): Promise<unknown> {
  switch (req.type) {
    case 'session:get':
      return store.load();
    case 'session:start': {
      // The page the session was started on already loaded, so record it as the first step.
      const tab = sender.tab ?? (await browser.tabs.query({ active: true, lastFocusedWindow: true }))[0];
      return store.start(pageOf(tab));
    }
    case 'session:stop':
      return store.stop();
    case 'session:resume':
      return store.resume();
    case 'session:discard':
      return store.discard();
    case 'session:hidden':
      return store.setHidden(req.hidden);
    case 'capture:viewport': {
      const windowId = sender.tab?.windowId;
      if (windowId == null) throw new Error('Kein Tab');
      return browser.tabs.captureVisibleTab(windowId, { format: 'png' });
    }
    case 'comment:add':
      return store.addComment(req.comment, req.screenshots);
    case 'comment:update':
      return store.updateComment(req.id, req.text);
    case 'comment:delete':
      return store.deleteComment(req.id);
    case 'timeline:add':
      return store.addTimeline(req.event);
    case 'log:add':
      return store.addLog(req.entry);
    case 'metadata:set':
      return store.setMetadata(req.origin, req.metadata);
    case 'export:folder':
      return exportFolder(sender.tab);
    case 'clipboard:copy':
      return copyToClipboard(req.text);
    case 'export:markdown':
      return (await store.bundle()).markdown;
  }
}

/**
 * Content scripts declared in the manifest only run on pages loaded after install/update. Inject them
 * into already open tabs so the toolbar and shortcut work without reloading every tab.
 * An outdated copy still running in a tab is invalidated by WXT and removes its own UI.
 */
async function injectIntoOpenTabs() {
  const tabs = await browser.tabs.query({ url: ['http://*/*', 'https://*/*'] });
  await Promise.all(
    tabs.map(async (tab) => {
      // Tabs still loading get the manifest content scripts anyway
      if (tab.id == null || tab.discarded || tab.status !== 'complete') return;
      const target = { tabId: tab.id };
      // Skip tabs where a live (non-orphaned) copy already answers
      const alive = await browser.tabs.sendMessage(tab.id, { type: 'ping' }, { frameId: 0 }).catch(() => undefined);
      if (alive === 'pong') return;
      try {
        const all = { ...target, allFrames: true };
        await browser.scripting.executeScript({ target: all, files: ['/content-scripts/page-bridge.js'], world: 'MAIN' });
        await browser.scripting.executeScript({ target: all, files: ['/content-scripts/content.js'] });
      } catch {
        // restricted pages (chrome web store, PDFs, …)
      }
    }),
  );
}

/** Send a command to the tab's toolbar; inject the content script first if the tab predates the install. */
async function commandTab(tabId: number, command: HostCommand): Promise<boolean> {
  const sendCommand = () => browser.tabs.sendMessage(tabId, { type: 'command', command }, { frameId: 0 }).then(() => true);
  return sendCommand().catch(async () => {
    await browser.scripting.executeScript({ target: { tabId }, files: ['/content-scripts/content.js'] }).catch(() => undefined);
    await new Promise((r) => setTimeout(r, 300));
    return sendCommand().catch(() => false);
  });
}

/** Icon click: start a session, resume a finished one, or show/hide the toolbar of the running one. */
async function onActionClicked(tab?: Browser.tabs.Tab) {
  const s = await store.load();
  if (!s) await store.start(pageOf(tab));
  else if (!s.active) await store.resume();
  else await store.setHidden(!s.hidden);
}

async function exportFromMenu(tab?: Browser.tabs.Tab) {
  // Prefer the toolbar so the result shows up as a toast; restricted pages have none.
  if (tab?.id != null && (await commandTab(tab.id, 'export'))) return;
  await exportFolder(tab).catch(() => undefined);
}

async function updateBadge(s: FeedbackSession | null) {
  const text = !s ? '' : s.active ? String(s.comments.length) : '✓';
  await browser.action.setBadgeText({ text });
  await browser.action.setBadgeBackgroundColor({ color: s?.active ? '#ff3b6b' : '#71717a' });
  await browser.action.setTitle({
    title: !s
      ? 'Agent Feedback – Klick startet eine Session'
      : s.active
        ? `Agent Feedback – ${s.comments.length} Kommentare · Klick: Toolbar ${s.hidden ? 'zeigen' : 'ausblenden'}`
        : 'Agent Feedback – Session beendet · Klick: fortsetzen',
  });
}

const MENU = { export: 'af-export', toolbar: 'af-toolbar', shortcuts: 'af-shortcuts' } as const;

export default defineBackground(() => {
  handle(onRequest);
  store.subscribe((s) => void updateBadge(s));
  store.load().then(updateBadge);

  browser.runtime.onInstalled.addListener(() => {
    injectIntoOpenTabs();
    browser.contextMenus.removeAll().then(() => {
      browser.contextMenus.create({ id: MENU.export, title: 'Exportieren', contexts: ['action'] });
      browser.contextMenus.create({ id: MENU.toolbar, title: 'Toolbar ein-/ausblenden', contexts: ['action'] });
      browser.contextMenus.create({ id: MENU.shortcuts, title: 'Tastenkürzel anpassen…', contexts: ['action'] });
    });
  });

  browser.action.onClicked.addListener((tab) => void onActionClicked(tab));

  browser.contextMenus.onClicked.addListener(async (info, tab) => {
    if (info.menuItemId === MENU.export) await exportFromMenu(tab);
    if (info.menuItemId === MENU.toolbar) await onActionClicked(tab);
    if (info.menuItemId === MENU.shortcuts) await browser.tabs.create({ url: 'chrome://extensions/shortcuts' });
  });

  browser.commands.onCommand.addListener(async (command, tab) => {
    tab ??= (await browser.tabs.query({ active: true, currentWindow: true }))[0];
    if (command === 'export') return exportFromMenu(tab);
    if (command === 'toggle-picker' && tab?.id != null) await commandTab(tab.id, 'pick');
  });

  // Test hook for the e2e script (the toolbar icon cannot be clicked from Playwright)
  (globalThis as unknown as { __agentFeedback: unknown }).__agentFeedback = { onActionClicked };
});
