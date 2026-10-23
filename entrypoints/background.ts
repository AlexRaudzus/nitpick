import { browser, type Browser } from 'wxt/browser';
import { handle, type Request } from '@/lib/messages';
import { exportFolderName, renderJson, renderMarkdown, assetFileNames } from '@/lib/render';
import type { FeedbackComment, FeedbackSession } from '@/lib/types';

const SESSION_KEY = 'session';
const ASSET_PREFIX = 'asset:';
const MAX_LOGS = 500;
const MAX_TIMELINE = 1000;

// Service workers can be killed at any time, so all state lives in storage.local.
// Writes are serialized because messages from several tabs can arrive concurrently.
let queue: Promise<unknown> = Promise.resolve();
function serialized<T>(fn: () => Promise<T>): Promise<T> {
  const run = queue.then(fn, fn);
  queue = run.catch(() => undefined);
  return run;
}

async function load(): Promise<FeedbackSession | null> {
  const res = await browser.storage.local.get(SESSION_KEY);
  return (res[SESSION_KEY] as FeedbackSession | undefined) ?? null;
}

async function save(session: FeedbackSession) {
  await browser.storage.local.set({ [SESSION_KEY]: session });
}

function mutate(fn: (s: FeedbackSession) => void): Promise<FeedbackSession | null> {
  return serialized(async () => {
    const s = await load();
    if (!s) return null;
    fn(s);
    await save(s);
    return s;
  });
}

const uid = () => crypto.randomUUID().slice(0, 8);

async function storeAsset(dataUrl: string | undefined): Promise<string | undefined> {
  if (!dataUrl) return undefined;
  const id = uid();
  await browser.storage.local.set({ [ASSET_PREFIX + id]: dataUrl });
  return id;
}

async function clearAssets() {
  const all = await browser.storage.local.get(null);
  const keys = Object.keys(all).filter((k) => k.startsWith(ASSET_PREFIX));
  if (keys.length) await browser.storage.local.remove(keys);
}

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
  const session = await load();
  if (!session) throw new Error('Keine Session vorhanden');
  const folder = `agent-feedback/${exportFolderName(session)}`;
  const files: { name: string; url: string }[] = [
    { name: 'feedback.md', url: dataUrl('text/markdown', renderMarkdown(session)) },
    { name: 'feedback.json', url: dataUrl('application/json', renderJson(session)) },
  ];
  const names = assetFileNames(session);
  const assets = await browser.storage.local.get([...names.keys()].map((id) => ASSET_PREFIX + id));
  for (const [id, name] of names) {
    const url = assets[ASSET_PREFIX + id] as string | undefined;
    if (url) files.push({ name, url });
  }
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
      return load();

    case 'session:start':
      return serialized(async () => {
        const existing = await load();
        if (existing?.active) return existing;
        await clearAssets();
        const session: FeedbackSession = {
          id: uid(),
          startedAt: Date.now(),
          active: true,
          comments: [],
          timeline: [],
          logs: [],
          metadata: {},
          userAgent: navigator.userAgent,
        };
        // The page the session was started on already loaded, so record it as the first step.
        const tab = sender.tab?.url?.startsWith('http')
          ? sender.tab
          : (await browser.tabs.query({ active: true, lastFocusedWindow: true }))[0];
        if (tab?.url?.startsWith('http')) {
          session.timeline.push({ type: 'navigate', at: Date.now(), url: tab.url, title: tab.title || undefined });
        }
        await save(session);
        return session;
      });

    case 'session:stop':
      return mutate((s) => {
        s.active = false;
        s.endedAt = Date.now();
      });

    case 'session:resume':
      return mutate((s) => {
        s.active = true;
        s.endedAt = undefined;
      });

    case 'session:discard':
      return serialized(async () => {
        await browser.storage.local.remove(SESSION_KEY);
        await clearAssets();
        return null;
      });

    case 'capture:viewport': {
      const windowId = sender.tab?.windowId;
      if (windowId == null) throw new Error('Kein Tab');
      return browser.tabs.captureVisibleTab(windowId, { format: 'png' });
    }

    case 'comment:add': {
      const [viewport, crop] = await Promise.all([
        storeAsset(req.screenshots.viewport),
        storeAsset(req.screenshots.crop),
      ]);
      let created: FeedbackComment | undefined;
      await mutate((s) => {
        const index = (s.comments.at(-1)?.index ?? 0) + 1;
        created = {
          ...req.comment,
          id: uid(),
          index,
          timelineIndex: s.timeline.length - 1,
          screenshots: { viewport, crop },
        };
        s.comments.push(created);
        if (created.metadata && Object.keys(created.metadata).length) {
          s.metadata[new URL(created.url).origin] = created.metadata;
        }
        s.timeline.push({ type: 'comment', at: created.createdAt, url: created.url, commentId: created.id, commentIndex: index });
      });
      if (!created) throw new Error('Keine aktive Session');
      return created;
    }

    case 'comment:update':
      await mutate((s) => {
        const c = s.comments.find((c) => c.id === req.id);
        if (c) c.text = req.text;
      });
      return null;

    case 'comment:delete':
      return serialized(async () => {
        const s = await load();
        const c = s?.comments.find((c) => c.id === req.id);
        if (!s || !c) return null;
        s.comments = s.comments.filter((x) => x.id !== req.id);
        s.timeline = s.timeline.filter((e) => !(e.type === 'comment' && e.commentId === req.id));
        await save(s);
        const keys = [c.screenshots.viewport, c.screenshots.crop].filter(Boolean).map((id) => ASSET_PREFIX + id);
        if (keys.length) await browser.storage.local.remove(keys);
        return null;
      });

    case 'timeline:add':
      await mutate((s) => {
        if (!s.active) return;
        const last = s.timeline.at(-1);
        // Collapse repeated navigations (SPA routers often fire pushState + replaceState)
        if (req.event.type === 'navigate' && last?.type === 'navigate' && last.url === req.event.url) return;
        // Collapse consecutive edits of the same field into the final value
        if (req.event.type === 'input' && last?.type === 'input' && last.target === req.event.target) {
          s.timeline[s.timeline.length - 1] = req.event;
          return;
        }
        s.timeline.push(req.event);
        if (s.timeline.length > MAX_TIMELINE) s.timeline.splice(0, s.timeline.length - MAX_TIMELINE);
      });
      return null;

    case 'log:add':
      await mutate((s) => {
        if (!s.active) return;
        s.logs.push(req.entry);
        if (s.logs.length > MAX_LOGS) s.logs.splice(0, s.logs.length - MAX_LOGS);
      });
      return null;

    case 'metadata:set':
      await mutate((s) => {
        s.metadata[req.origin] = req.metadata;
      });
      return null;

    case 'export:folder':
      return exportFolder();

    case 'clipboard:copy':
      return copyToClipboard(req.text);

    case 'export:markdown': {
      const s = await load();
      if (!s) throw new Error('Keine Session vorhanden');
      return renderMarkdown(s);
    }
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
