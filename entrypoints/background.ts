import { browser, type Browser } from 'wxt/browser';
import { handle, type Request } from '@/extension/messages';
import { createSessionStore, type KVBackend } from '@/core/session-store';

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

async function exportFolder(): Promise<{ folder: string; path?: string; files: number; copied: boolean }> {
  const bundle = await store.bundle();
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
  return { folder, path, files: files.length, copied };
}

async function onRequest(req: Request, sender: Browser.runtime.MessageSender): Promise<unknown> {
  switch (req.type) {
    case 'session:get':
      return store.load();
    case 'session:start': {
      // The page the session was started on already loaded, so record it as the first step.
      const tab = sender.tab?.url?.startsWith('http')
        ? sender.tab
        : (await browser.tabs.query({ active: true, lastFocusedWindow: true }))[0];
      return store.start(tab?.url?.startsWith('http') ? { url: tab.url, title: tab.title } : undefined);
    }
    case 'session:stop':
      return store.stop();
    case 'session:resume':
      return store.resume();
    case 'session:discard':
      return store.discard();
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
      return exportFolder();
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
      const alive = await browser.tabs.sendMessage(tab.id, { type: 'ping' }).catch(() => undefined);
      if (alive === 'pong') return;
      try {
        await browser.scripting.executeScript({ target, files: ['/content-scripts/page-bridge.js'], world: 'MAIN' });
        await browser.scripting.executeScript({ target, files: ['/content-scripts/content.js'] });
      } catch {
        // restricted pages (chrome web store, PDFs, …)
      }
    }),
  );
}

export default defineBackground(() => {
  handle(onRequest);
  browser.runtime.onInstalled.addListener(() => {
    injectIntoOpenTabs();
  });

  browser.commands.onCommand.addListener(async (command, tab) => {
    const tabId = tab?.id ?? (await browser.tabs.query({ active: true, currentWindow: true }))[0]?.id;
    if (tabId == null) return;
    // If the tab has no live content script yet (opened before install), inject and retry once.
    const sendCommand = () => browser.tabs.sendMessage(tabId, { type: 'command', command });
    await sendCommand().catch(async () => {
      await browser.scripting.executeScript({ target: { tabId }, files: ['/content-scripts/content.js'] }).catch(() => undefined);
      await new Promise((r) => setTimeout(r, 300));
      await sendCommand().catch(() => undefined);
    });
  });
});
