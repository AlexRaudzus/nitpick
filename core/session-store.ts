import type { NewComment, Screenshots } from './host';
import { assetFileNames, exportFolderName, renderJson, renderMarkdown } from './render';
import type { FeedbackComment, FeedbackSession, LogEntry, TimelineEvent } from './types';

/** Minimal async key-value storage: chrome.storage.local in the extension, IndexedDB in the embed. */
export interface KVBackend {
  get(keys: string[]): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(keys: string[]): Promise<void>;
  keys(): Promise<string[]>;
}

export interface ExportBundle {
  session: FeedbackSession;
  /** e.g. `2026-10-23_14-02-11_localhost_3000` */
  folderName: string;
  markdown: string;
  json: string;
  /** Screenshots with their relative path as referenced in markdown/json. */
  assets: { name: string; dataUrl: string }[];
}

export const SESSION_KEY = 'session';
/** Preferences that outlive a session (e.g. headless mode). */
const PREFS_KEY = 'prefs';
type Prefs = { hidden?: boolean };
const ASSET_PREFIX = 'asset:';
const MAX_LOGS = 500;
const MAX_TIMELINE = 1000;

const uid = () => crypto.randomUUID().slice(0, 8);

/** Session state machine on top of a KV backend. All writes are serialized. */
export function createSessionStore(kv: KVBackend) {
  const listeners = new Set<(s: FeedbackSession | null) => void>();
  const emit = (s: FeedbackSession | null) => listeners.forEach((l) => l(s));

  let queue: Promise<unknown> = Promise.resolve();
  function serialized<T>(fn: () => Promise<T>): Promise<T> {
    const run = queue.then(fn, fn);
    queue = run.catch(() => undefined);
    return run;
  }

  async function load(): Promise<FeedbackSession | null> {
    const res = await kv.get([SESSION_KEY]);
    return (res[SESSION_KEY] as FeedbackSession | undefined) ?? null;
  }

  async function save(s: FeedbackSession | null) {
    if (s) await kv.set({ [SESSION_KEY]: s });
    else await kv.remove([SESSION_KEY]);
    emit(s);
  }

  function mutate(fn: (s: FeedbackSession) => void | false): Promise<FeedbackSession | null> {
    return serialized(async () => {
      const s = await load();
      if (!s) return null;
      // returning false means "nothing changed"
      if (fn(s) === false) return s;
      await save(s);
      return s;
    });
  }

  async function storeAsset(dataUrl: string | undefined): Promise<string | undefined> {
    if (!dataUrl) return undefined;
    const id = uid();
    await kv.set({ [ASSET_PREFIX + id]: dataUrl });
    return id;
  }

  async function clearAssets() {
    const keys = (await kv.keys()).filter((k) => k.startsWith(ASSET_PREFIX));
    if (keys.length) await kv.remove(keys);
  }

  return {
    load,

    subscribe(cb: (s: FeedbackSession | null) => void): () => void {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },

    /** Starts a new session unless one is active. `page` is recorded as the first step. */
    start(page?: { url: string; title?: string }, tabId?: number): Promise<FeedbackSession> {
      return serialized(async () => {
        const existing = await load();
        if (existing?.active) return existing;
        await clearAssets();
        const prefs = ((await kv.get([PREFS_KEY]))[PREFS_KEY] as Prefs | undefined) ?? {};
        const session: FeedbackSession = {
          id: uid(),
          startedAt: Date.now(),
          active: true,
          hidden: prefs.hidden || undefined,
          tabs: tabId != null ? [tabId] : undefined,
          comments: [],
          timeline: [],
          logs: [],
          metadata: {},
          userAgent: navigator.userAgent,
        };
        if (page) session.timeline.push({ type: 'navigate', at: Date.now(), url: page.url, title: page.title || undefined });
        await save(session);
        return session;
      });
    },

    stop: () =>
      mutate((s) => {
        s.active = false;
        s.endedAt = Date.now();
      }),

    resume: () =>
      mutate((s) => {
        s.active = true;
        s.endedAt = undefined;
      }),

    async addTab(tabId: number) {
      await mutate((s) => {
        if (!s.tabs || s.tabs.includes(tabId)) return false;
        s.tabs.push(tabId);
      });
    },

    /** Headless mode on/off; remembered for the next sessions. */
    async setHidden(hidden: boolean) {
      await kv.set({ [PREFS_KEY]: { hidden } satisfies Prefs });
      await mutate((s) => {
        s.hidden = hidden || undefined;
      });
    },

    discard: () =>
      serialized(async () => {
        await save(null);
        await clearAssets();
      }),

    async addComment(input: NewComment, screenshots: Screenshots): Promise<FeedbackComment> {
      const [viewport, crop] = await Promise.all([storeAsset(screenshots.viewport), storeAsset(screenshots.crop)]);
      let created: FeedbackComment | undefined;
      await mutate((s) => {
        const index = (s.comments.at(-1)?.index ?? 0) + 1;
        created = { ...input, id: uid(), index, timelineIndex: s.timeline.length - 1, screenshots: { viewport, crop } };
        s.comments.push(created);
        if (created.metadata && Object.keys(created.metadata).length) {
          s.metadata[new URL(created.url).origin] = created.metadata;
        }
        s.timeline.push({ type: 'comment', at: created.createdAt, url: created.url, commentId: created.id, commentIndex: index });
      });
      if (!created) throw new Error('Keine aktive Session');
      return created;
    },

    async updateComment(id: string, text: string) {
      await mutate((s) => {
        const c = s.comments.find((c) => c.id === id);
        if (!c) return false;
        c.text = text;
      });
    },

    deleteComment: (id: string) =>
      serialized(async () => {
        const s = await load();
        const c = s?.comments.find((c) => c.id === id);
        if (!s || !c) return;
        s.comments = s.comments.filter((x) => x.id !== id);
        s.timeline = s.timeline.filter((e) => !(e.type === 'comment' && e.commentId === id));
        await save(s);
        const keys = [c.screenshots.viewport, c.screenshots.crop].filter(Boolean).map((a) => ASSET_PREFIX + a);
        if (keys.length) await kv.remove(keys);
      }),

    async addTimeline(event: TimelineEvent) {
      await mutate((s) => {
        if (!s.active) return false;
        const last = s.timeline.at(-1);
        // Collapse repeated navigations (SPA routers often fire pushState + replaceState)
        if (event.type === 'navigate' && last?.type === 'navigate' && last.url === event.url) return false;
        // Collapse consecutive edits of the same field into the final value
        if (event.type === 'input' && last?.type === 'input' && last.target === event.target) {
          s.timeline[s.timeline.length - 1] = event;
          return;
        }
        s.timeline.push(event);
        if (s.timeline.length > MAX_TIMELINE) s.timeline.splice(0, s.timeline.length - MAX_TIMELINE);
      });
    },

    async addLog(entry: LogEntry) {
      await mutate((s) => {
        if (!s.active) return false;
        s.logs.push(entry);
        if (s.logs.length > MAX_LOGS) s.logs.splice(0, s.logs.length - MAX_LOGS);
      });
    },

    async setMetadata(origin: string, metadata: Record<string, unknown>) {
      await mutate((s) => {
        if (JSON.stringify(s.metadata[origin]) === JSON.stringify(metadata)) return false;
        s.metadata[origin] = metadata;
      });
    },

    /** Markdown, JSON and screenshots, ready to be written to disk or attached to a ticket. */
    async bundle(exportedAt = Date.now()): Promise<ExportBundle> {
      const session = await load();
      if (!session) throw new Error('Keine Session vorhanden');
      const names = assetFileNames(session);
      const stored = await kv.get([...names.keys()].map((id) => ASSET_PREFIX + id));
      const assets: ExportBundle['assets'] = [];
      for (const [id, name] of names) {
        const dataUrl = stored[ASSET_PREFIX + id];
        if (typeof dataUrl === 'string') assets.push({ name, dataUrl });
      }
      return {
        session,
        folderName: exportFolderName(session, exportedAt),
        markdown: renderMarkdown(session),
        json: renderJson(session),
        assets,
      };
    },
  };
}

export type SessionStore = ReturnType<typeof createSessionStore>;
