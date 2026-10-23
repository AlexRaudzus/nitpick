/**
 * In-app variant of the feedback toolbar (no extension needed). Intended to be loaded lazily:
 *
 *   const { createFeedbackRecorder } = await import('agent-feedback/embed');
 *   const recorder = createFeedbackRecorder({ onComplete: (result) => openFeedbackModal(result) });
 *   await recorder.start(); // from a click handler ("Record")
 */
import { createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { FeedbackHost, PageEvent } from '../core/host';
import { collectContext, hookConsole, hookHistory, inspectComponents } from '../core/page';
import { renderMarkdown, type RenderOptions } from '../core/render';
import { createSessionStore, type ExportBundle } from '../core/session-store';
import type { FeedbackSession } from '../core/types';
import { App } from '../core/ui/App';
import css from '../core/ui/style.css?inline';
import { createIdbBackend } from './idb';
import { PENDING_FLAG } from './loader';
import { createScreenshotSource, type ScreenshotMode } from './screenshot';

export { hasPendingSession } from './loader';
export type { FeedbackSession, ExportBundle, RenderOptions };

export interface FeedbackResult extends ExportBundle {
  /** feedback.md, feedback.json and screenshots/NN-*.png as files (names = relative paths). */
  files: File[];
  /** Markdown with screenshots embedded as images, e.g. after uploading them to Linear. */
  renderMarkdown(opts: RenderOptions): string;
}

export interface RecorderOptions {
  /** Called when the user hands over the finished session. The toolbar is unmounted beforehand. */
  onComplete: (result: FeedbackResult) => void | Promise<void>;
  /** Extra app context per comment (user role, tenant, version, …); merged over meta tags etc. */
  context?: () => Record<string, unknown> | Promise<Record<string, unknown>>;
  /** Default `auto`: ask for tab capture on start, fall back to DOM rendering. */
  screenshots?: ScreenshotMode;
  /** Label of the hand-over button. */
  completeLabel?: string;
  /** IndexedDB database name. */
  dbName?: string;
}

const UI_TAG = 'agent-feedback-ui';
/** Same isolation as the extension: the page must not see typing/clicks inside our UI. */
const ISOLATED_EVENTS = ['keydown', 'keyup', 'keypress', 'pointerdown', 'mousedown', 'mouseup', 'focusin', 'focusout'];

function dataUrlToFile(dataUrl: string, name: string): File {
  const [head, b64] = dataUrl.split(',');
  const mime = /data:([^;]+)/.exec(head!)?.[1] ?? 'application/octet-stream';
  const bin = atob(b64!);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new File([bytes], name, { type: mime });
}

// Console/history hooks are global and installed once per page, no matter how many recorders exist.
const pageListeners = new Set<(e: PageEvent) => void>();
let hooked = false;
function hookPage() {
  if (hooked) return;
  hooked = true;
  const emit = (e: PageEvent) => pageListeners.forEach((l) => l(e));
  hookConsole(emit);
  hookHistory(emit);
}

export function createFeedbackRecorder(options: RecorderOptions) {
  const store = createSessionStore(createIdbBackend(options.dbName));
  let hostEl: HTMLElement | null = null;
  let root: Root | null = null;
  const isOwnUi = (node: Node) => !!hostEl && (node === hostEl || hostEl.contains(node));
  const shots = createScreenshotSource(options.screenshots ?? 'auto', isOwnUi);

  // Lets the host app check cheaply (without loading this bundle) whether to restore the toolbar after a reload.
  const syncFlag = (s: FeedbackSession | null) => {
    try {
      if (s) localStorage.setItem(PENDING_FLAG, s.active ? 'active' : 'stopped');
      else localStorage.removeItem(PENDING_FLAG);
    } catch {
      // storage blocked
    }
  };
  store.subscribe(syncFlag);

  // Other tabs of the app write to the same IndexedDB: tell them to reload the state.
  const channel = typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel('agent-feedback') : null;
  const remoteListeners = new Set<(s: FeedbackSession | null) => void>();
  store.subscribe(() => channel?.postMessage('changed'));
  if (channel) {
    channel.onmessage = async () => {
      const s = await store.load();
      remoteListeners.forEach((l) => l(s));
    };
  }

  const complete = async () => {
    const bundle = await store.bundle();
    const files = [
      new File([bundle.markdown], 'feedback.md', { type: 'text/markdown' }),
      new File([bundle.json], 'feedback.json', { type: 'application/json' }),
      ...bundle.assets.map((a) => dataUrlToFile(a.dataUrl, a.name)),
    ];
    unmount();
    shots.stop();
    await options.onComplete({ ...bundle, files, renderMarkdown: (opts) => renderMarkdown(bundle.session, opts) });
  };

  const api: FeedbackHost = {
    load: () => store.load(),
    subscribe(cb) {
      remoteListeners.add(cb);
      const off = store.subscribe(cb);
      return () => {
        off();
        remoteListeners.delete(cb);
      };
    },
    start: async () => void (await store.start({ url: location.href, title: document.title })),
    stop: async () => void (await store.stop()),
    resume: async () => void (await store.resume()),
    async discard() {
      await store.discard();
      shots.stop();
      unmount();
    },
    addComment: (c, s) => store.addComment(c, s),
    updateComment: (id, text) => store.updateComment(id, text),
    deleteComment: (id) => store.deleteComment(id),
    addTimeline: (e) => store.addTimeline(e),
    addLog: (e) => store.addLog(e),
    setMetadata: async (origin, md) => void (await store.setMetadata(origin, md)),

    captureViewport: () => shots.capture(),
    async requestContext() {
      const [page, app] = await Promise.all([
        collectContext(),
        Promise.resolve(options.context?.()).catch((err) => ({ _contextError: String(err) })),
      ]);
      return JSON.parse(JSON.stringify({ ...page, ...app }));
    },
    probeComponents: async (el) => inspectComponents(el),
    onPageEvent(cb) {
      pageListeners.add(cb);
      return () => pageListeners.delete(cb);
    },

    finishActions: [{ label: options.completeLabel ?? 'Übernehmen', primary: true, run: complete }],
  };

  function mount() {
    if (hostEl?.isConnected) return;
    hookPage();
    document.querySelectorAll(UI_TAG).forEach((el) => el.remove());
    hostEl = document.createElement(UI_TAG);
    // Equivalent of WXT's `:host { all: initial }`: page styles must not leak into the host element.
    hostEl.style.cssText = 'all: initial !important; position: fixed !important; z-index: 2147483647 !important;';
    const shadow = hostEl.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = css;
    const container = document.createElement('div');
    shadow.append(style, container);
    for (const type of ISOLATED_EVENTS) hostEl.addEventListener(type, (e) => e.stopPropagation());
    document.documentElement.append(hostEl);
    root = createRoot(container);
    root.render(createElement(App, { host: hostEl, api }));
  }

  function unmount() {
    root?.unmount();
    hostEl?.remove();
    root = null;
    hostEl = null;
  }

  return {
    /**
     * Starts a new session (or continues the active one) and shows the toolbar.
     * Call from a click handler so the tab-capture prompt is allowed.
     */
    async start() {
      await shots.requestTab();
      await store.start({ url: location.href, title: document.title });
      mount();
    },
    /** Shows the toolbar again for an existing session, e.g. after a reload or a cancelled hand-over. */
    async restore(): Promise<boolean> {
      const s = await store.load();
      syncFlag(s);
      if (!s) return false;
      mount();
      return true;
    },
    /** Deletes the session, e.g. after the ticket was created. */
    async clear() {
      await store.discard();
      shots.stop();
      unmount();
    },
    /** Current bundle without finishing the session. */
    bundle: () => store.bundle(),
    get usesTabCapture() {
      return shots.usesTab;
    },
    destroy() {
      unmount();
      shots.stop();
      channel?.close();
    },
  };
}

export type FeedbackRecorder = ReturnType<typeof createFeedbackRecorder>;
