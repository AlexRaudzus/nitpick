/**
 * Runs in the page's own JS world (MAIN) at document_start. It can see what the isolated content script
 * cannot: console calls, history changes, framework internals on DOM nodes and page-provided metadata.
 * Everything is relayed to the content script via window.postMessage.
 */
import { BRIDGE_SOURCE, CONTENT_SOURCE, type BridgeToContent, type ContentToBridge } from '@/lib/messages';
import { redactText, truncate } from '@/lib/redact';

export default defineContentScript({
  matches: ['<all_urls>'],
  world: 'MAIN',
  runAt: 'document_start',
  allFrames: false,
  main() {
    // The extension re-injects itself into open tabs after an update; hook the page only once.
    const w = window as unknown as { __agentFeedbackBridge?: boolean };
    if (w.__agentFeedbackBridge) return;
    w.__agentFeedbackBridge = true;

    const post = (msg: BridgeToContent) => window.postMessage({ source: BRIDGE_SOURCE, ...msg }, '*');

    hookConsole(post);
    hookHistory(post);

    window.addEventListener('message', async (ev) => {
      if (ev.source !== window || ev.data?.source !== CONTENT_SOURCE) return;
      const msg = ev.data as ContentToBridge;
      if (msg.type === 'request-context') {
        post({ type: 'context', requestId: msg.requestId, metadata: await collectContext() });
      } else if (msg.type === 'probe') {
        const el = document.querySelector(`[data-agent-feedback-probe="${msg.requestId}"]`);
        post({ type: 'probe-result', requestId: msg.requestId, ...(el ? inspectComponents(el) : {}) });
      }
    });
  },
});

function stringifyArg(arg: unknown): string {
  if (arg instanceof Error) return `${arg.name}: ${arg.message}`;
  if (typeof arg === 'string') return arg;
  try {
    return JSON.stringify(arg) ?? String(arg);
  } catch {
    return String(arg);
  }
}

/** Apply printf-style %s/%o substitutions that React and others use in warnings. */
function formatArgs(args: unknown[]): string {
  if (typeof args[0] !== 'string' || !/%[sdioOcf]/.test(args[0])) return args.map(stringifyArg).join(' ');
  let i = 1;
  const head = args[0].replace(/%[sdioOcf]/g, (m) => (m === '%c' ? (i++, '') : i < args.length ? stringifyArg(args[i++]) : m));
  return [head, ...args.slice(i).map(stringifyArg)].join(' ');
}

function hookConsole(post: (msg: BridgeToContent) => void) {
  const emit = (level: 'error' | 'warn', message: string, stack?: string) =>
    post({
      type: 'log',
      level,
      message: truncate(redactText(message), 600),
      stack: stack ? truncate(redactText(stack), 1500) : undefined,
    });

  for (const level of ['error', 'warn'] as const) {
    const original = console[level];
    console[level] = function (...args: unknown[]) {
      try {
        const err = args.find((a): a is Error => a instanceof Error);
        emit(level, formatArgs(args), err?.stack);
      } catch {
        // never break the page's logging
      }
      return original.apply(this, args);
    };
  }
  window.addEventListener('error', (ev) => {
    const where = ev.filename ? ` (${ev.filename}:${ev.lineno}:${ev.colno})` : '';
    emit('error', `Uncaught ${ev.message}${where}`, (ev.error as Error | undefined)?.stack);
  });
  window.addEventListener('unhandledrejection', (ev) => {
    const reason = ev.reason as unknown;
    emit('error', `Unhandled rejection: ${stringifyArg(reason)}`, reason instanceof Error ? reason.stack : undefined);
  });
}

function hookHistory(post: (msg: BridgeToContent) => void) {
  const notify = () => post({ type: 'navigate', url: location.href });
  for (const method of ['pushState', 'replaceState'] as const) {
    const original = history[method];
    history[method] = function (...args: Parameters<History['pushState']>) {
      const result = original.apply(this, args);
      queueMicrotask(notify);
      return result;
    };
  }
  window.addEventListener('popstate', notify);
  window.addEventListener('hashchange', notify);
}

/**
 * Metadata a site can provide, in order of precedence (later wins):
 *  1. <meta name="agent-feedback:KEY" content="VALUE">
 *  2. window.__AGENT_FEEDBACK__ = {...} or () => {...} (may return a promise)
 *  3. a listener for the `agent-feedback:request-context` event that calls `event.detail.respond({...})`
 */
async function collectContext(): Promise<Record<string, unknown>> {
  const result: Record<string, unknown> = {};
  document.querySelectorAll<HTMLMetaElement>('meta[name^="agent-feedback:"]').forEach((m) => {
    result[m.name.slice('agent-feedback:'.length)] = m.content;
  });

  try {
    const global = (window as unknown as { __AGENT_FEEDBACK__?: unknown }).__AGENT_FEEDBACK__;
    const value = typeof global === 'function' ? await global() : global;
    if (value && typeof value === 'object') Object.assign(result, value);
  } catch (err) {
    result._contextError = String(err);
  }

  const responses: Record<string, unknown>[] = [];
  const respond = (data: unknown) => {
    if (data && typeof data === 'object') responses.push(data as Record<string, unknown>);
  };
  window.dispatchEvent(new CustomEvent('agent-feedback:request-context', { detail: { respond } }));
  await new Promise((r) => setTimeout(r, 50));
  for (const r of responses) Object.assign(result, r);

  // Make sure everything survives structured cloning.
  return JSON.parse(JSON.stringify(result, (_k, v) => (typeof v === 'function' ? undefined : v)));
}

/** Framework / headless-UI internals that tell an agent nothing about where the UI lives in code. */
const FRAMEWORK_COMPONENT =
  /^(Anonymous|Fragment|Suspense|StrictMode|Profiler|Provider|Consumer|Context|Slot|SlotClone|Slottable|Primitive|Presence|Portal|DismissableLayer|DismissableLayerBranch|FocusScope|FocusGuards|Popper|PopperAnchor|PopperContent|PopperArrow|VisuallyHidden|RemoveScroll|RemoveScrollBar|Collection.*|RovingFocus.*|Menu(Anchor|Portal|Content(Impl)?|RootContent.*)|ErrorBoundary|.*Boundary|.*Router|Router|AppRouter|ServerRoot|HotReload|ReactDevOverlay|RenderFromTemplateContext|ScrollAndFocusHandler|InnerScrollAndFocusHandler|Head|Root|AppContainer|PathnameContextProviderAdapter|SegmentViewNode|SegmentStateProvider|SegmentViewStateNode|ClientPageRoot|ClientSegmentRoot|LinkComponent)$/;

/** Minifiers produce names like `E`, `l_`, `tN`, `og`. */
const looksMinified = (name: string) => name.length <= 3 && !/^[A-Z][a-z]{2}$/.test(name);

function isUsefulComponent(name: string): boolean {
  if (looksMinified(name)) return false;
  // `Primitive.div`, `Primitive.button.Slot` (Radix), `FooProvider`, `withRouter(...)` style wrappers
  if (name.includes('.') || name.includes('(')) return false;
  if (name.endsWith('Provider')) return false;
  return !FRAMEWORK_COMPONENT.test(name);
}

type Fiber = { type: unknown; return: Fiber | null; elementType?: unknown };

function componentName(type: unknown): string | undefined {
  if (!type || typeof type === 'string') return undefined;
  const t = type as { displayName?: string; name?: string; render?: unknown; type?: unknown };
  if (typeof type === 'function') return t.displayName || t.name || undefined;
  if (t.displayName) return t.displayName;
  if (t.render) return componentName(t.render); // forwardRef
  if (t.type) return componentName(t.type); // memo
  return undefined;
}

function inspectComponents(el: Element): { components?: string[]; sourceFile?: string; minified?: boolean } {
  // Svelte (dev): exact source location on the element
  const svelteMeta = (el as unknown as { __svelte_meta?: { loc?: { file: string; line: number } } }).__svelte_meta;

  // React: walk up the fiber tree
  for (let node: Element | null = el; node; node = node.parentElement) {
    const key = Object.keys(node).find((k) => k.startsWith('__reactFiber$'));
    if (!key) continue;
    const names: string[] = [];
    let depth = 0;
    let sawMinified = false;
    for (let f: Fiber | null | undefined = (node as unknown as Record<string, Fiber>)[key]; f && names.length < 5 && depth < 300; f = f.return, depth++) {
      const name = componentName(f.type);
      if (name && looksMinified(name)) sawMinified = true;
      if (name && isUsefulComponent(name) && names[0] !== name) names.unshift(name);
    }
    return {
      components: names.length ? names : undefined,
      minified: !names.length && sawMinified ? true : undefined,
      sourceFile: svelteMeta?.loc ? `${svelteMeta.loc.file}:${svelteMeta.loc.line}` : undefined,
    };
  }

  // Vue 3 / Vue 2 (dev builds expose __file)
  for (let node: Element | null = el; node; node = node.parentElement) {
    const vue3 = (node as unknown as { __vueParentComponent?: VueInstance }).__vueParentComponent;
    if (vue3) {
      const names: string[] = [];
      let file: string | undefined;
      for (let c: VueInstance | null | undefined = vue3; c && names.length < 6; c = c.parent) {
        const name = c.type?.__name || c.type?.name;
        file ??= c.type?.__file;
        if (name) names.unshift(name);
      }
      return { components: names.length ? names : undefined, sourceFile: file };
    }
    const vue2 = (node as unknown as { __vue__?: { $options?: { name?: string; __file?: string } } }).__vue__;
    if (vue2?.$options) {
      return {
        components: vue2.$options.name ? [vue2.$options.name] : undefined,
        sourceFile: vue2.$options.__file,
      };
    }
  }

  if (svelteMeta?.loc) return { sourceFile: `${svelteMeta.loc.file}:${svelteMeta.loc.line}` };
  return {};
}

type VueInstance = { type?: { __name?: string; name?: string; __file?: string }; parent?: VueInstance | null };
