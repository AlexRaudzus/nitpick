/**
 * Picking inside iframes, including cross-origin ones (the extension's content script runs in every frame).
 * The top frame owns the UI; each iframe runs a small agent that highlights/picks locally and reports up
 * via postMessage. Every level translates rects into its own viewport and records which <iframe> it came
 * through, so the top ends up with page coordinates plus the frame chain.
 */
import { describeElement, getCssSelector } from '@/core/describe-element';
import type { FrameBridge, FrameEvent } from '@/core/host';
import type { FrameInfo, Rect } from '@/core/types';
import { holdPressed, SHORTCUTS } from '@/core/ui/keys';
import { startRecorder } from '@/core/ui/recorder';
import { probeComponents } from './bridge-client';
import { createExtensionHost } from './host';

const SOURCE = 'agent-feedback-frames';

type Down = { source: typeof SOURCE; dir: 'down'; type: 'picker'; active: boolean };
type Up = { source: typeof SOURCE; dir: 'up'; event: FrameEvent; frames: FrameInfo[]; url: string };

const iframes = () => [...document.querySelectorAll('iframe, frame')] as HTMLIFrameElement[];
const iframeOf = (source: MessageEventSource | null) => iframes().find((f) => f.contentWindow === source);

function broadcastDown(active: boolean) {
  const msg: Down = { source: SOURCE, dir: 'down', type: 'picker', active };
  for (const f of iframes()) f.contentWindow?.postMessage(msg, '*');
}

function offset(rect: Rect, frame: HTMLIFrameElement): Rect {
  const r = frame.getBoundingClientRect();
  const style = getComputedStyle(frame);
  return {
    x: Math.round(rect.x + r.left + frame.clientLeft + parseFloat(style.paddingLeft)),
    y: Math.round(rect.y + r.top + frame.clientTop + parseFloat(style.paddingTop)),
    width: rect.width,
    height: rect.height,
  };
}

/** Re-express a message from a child frame in this document's coordinates. */
function lift(msg: Up, frame: HTMLIFrameElement): { event: FrameEvent; frames: FrameInfo[] } {
  const frames = [{ selector: getCssSelector(frame), url: msg.url }, ...msg.frames];
  const e = msg.event;
  if (e.type === 'hover' && e.rect) return { event: { type: 'hover', rect: offset(e.rect, frame) }, frames };
  if (e.type === 'picked') {
    const event: FrameEvent = {
      type: 'picked',
      rect: offset(e.rect, frame),
      element: { ...e.element, viewportRect: offset(e.element.viewportRect, frame) },
    };
    return { event, frames };
  }
  return { event: e, frames };
}

const isUp = (data: unknown): data is Up => (data as Up)?.source === SOURCE && (data as Up).dir === 'up';

/** Top-frame side, used by the toolbar. */
export function createFrameBridge(): FrameBridge {
  return {
    setPickerActive: broadcastDown,
    onEvent(cb) {
      const onMessage = (ev: MessageEvent) => {
        if (!isUp(ev.data)) return;
        const frame = iframeOf(ev.source);
        if (!frame) return;
        const { event, frames } = lift(ev.data, frame);
        if (event.type === 'picked') {
          const v = event.element.viewportRect;
          event.element = {
            ...event.element,
            frames,
            documentRect: { ...v, x: Math.round(v.x + scrollX), y: Math.round(v.y + scrollY) },
          };
        }
        cb(event);
      };
      window.addEventListener('message', onMessage);
      return () => window.removeEventListener('message', onMessage);
    },
  };
}

/** Runs in every iframe (no UI): local picker, key forwarding, relaying, timeline recording. */
export function startFrameAgent() {
  const post = (event: FrameEvent) => {
    const msg: Up = { source: SOURCE, dir: 'up', event, frames: [], url: location.href };
    window.parent.postMessage(msg, '*');
  };

  let active = false;
  let held = false;
  let hoverEl: Element | null = null;
  let raf = 0;
  const toRect = (el: Element): Rect => {
    const r = el.getBoundingClientRect();
    return { x: r.left, y: r.top, width: r.width, height: r.height };
  };
  const reportHover = () => {
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(() => post({ type: 'hover', rect: hoverEl ? toRect(hoverEl) : null }));
  };

  window.addEventListener('message', async (ev) => {
    const data = ev.data as Down | Up;
    if (data?.source !== SOURCE) return;
    if (data.dir === 'down' && ev.source === window.parent) {
      active = data.active;
      if (!active) hoverEl = null;
      broadcastDown(active);
    } else if (data.dir === 'up') {
      const frame = iframeOf(ev.source);
      if (!frame) return;
      const lifted = lift(data, frame);
      window.parent.postMessage({ ...data, ...lifted, url: location.href } satisfies Up, '*');
    }
  });

  // Hold keys and shortcuts typed while the focus is inside this frame
  const syncHeld = (e: KeyboardEvent | MouseEvent) => {
    const now = holdPressed(e);
    if (now !== held) post({ type: 'held', held: (held = now) });
  };
  window.addEventListener('keyup', syncHeld, true);
  window.addEventListener('blur', () => held && post({ type: 'held', held: (held = false) }));
  window.addEventListener(
    'keydown',
    (e) => {
      syncHeld(e);
      if (holdPressed(e) && SHORTCUTS[e.code]) {
        e.preventDefault();
        e.stopImmediatePropagation();
        if (!e.repeat) post({ type: 'shortcut', code: e.code });
      } else if (active && e.key === 'Escape') {
        post({ type: 'escape' });
      } else if (active && e.key === 'ArrowUp' && hoverEl?.parentElement && hoverEl.parentElement !== document.body) {
        e.preventDefault();
        hoverEl = hoverEl.parentElement;
        reportHover();
      }
    },
    true,
  );

  // Local picker
  window.addEventListener(
    'mousemove',
    (e) => {
      syncHeld(e);
      if (!active) return;
      const t = e.composedPath()[0];
      // Child iframes report their own hover
      hoverEl = t instanceof Element && !(t instanceof HTMLIFrameElement) ? t : null;
      if (hoverEl || !(t instanceof HTMLIFrameElement)) reportHover();
    },
    true,
  );
  window.addEventListener('scroll', () => active && hoverEl && reportHover(), true);
  const block = (e: Event) => {
    if (!active) return;
    e.preventDefault();
    e.stopImmediatePropagation();
  };
  for (const t of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'dblclick', 'contextmenu'] as const) {
    window.addEventListener(t, block, true);
  }
  window.addEventListener(
    'click',
    async (e) => {
      if (!active) return;
      block(e);
      const t = e.composedPath()[0];
      const el = hoverEl ?? (t instanceof Element ? t : null);
      if (!el) return;
      const element = { ...describeElement(el), ...(await probeComponents(el)) };
      post({ type: 'picked', element, rect: element.viewportRect });
    },
    true,
  );

  // Clicks and inputs inside the frame belong in the timeline too
  const host = createExtensionHost();
  let sessionActive = false;
  host.load().then((s) => (sessionActive = !!s?.active), () => undefined);
  host.subscribe((s) => (sessionActive = !!s?.active));
  startRecorder(host, () => sessionActive, () => active, { frame: true });
}
