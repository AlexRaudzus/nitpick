import { BRIDGE_SOURCE, CONTENT_SOURCE, type BridgeToContent, type ContentToBridge } from '@/extension/messages';

type Listener = (msg: BridgeToContent) => void;
const listeners = new Set<Listener>();

window.addEventListener('message', (ev) => {
  if (ev.source !== window || ev.data?.source !== BRIDGE_SOURCE) return;
  for (const l of listeners) l(ev.data as BridgeToContent);
});

export function onBridgeMessage(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function request<T extends BridgeToContent['type']>(
  msg: ContentToBridge,
  responseType: T,
  timeoutMs: number,
): Promise<Extract<BridgeToContent, { type: T }> | undefined> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      off();
      resolve(undefined);
    }, timeoutMs);
    const off = onBridgeMessage((res) => {
      if (res.type === responseType && 'requestId' in res && res.requestId === msg.requestId) {
        clearTimeout(timer);
        off();
        resolve(res as Extract<BridgeToContent, { type: T }>);
      }
    });
    window.postMessage({ source: CONTENT_SOURCE, ...msg }, '*');
  });
}

const rid = () => Math.random().toString(36).slice(2, 10);

export async function requestContext(): Promise<Record<string, unknown>> {
  const res = await request({ type: 'request-context', requestId: rid() }, 'context', 1500);
  return res?.metadata ?? {};
}

/** Ask the page-world bridge for framework component info of an element. */
export async function probeComponents(
  el: Element,
): Promise<{ components?: string[]; sourceFile?: string; minified?: boolean }> {
  const requestId = rid();
  el.setAttribute('data-nitpick-probe', requestId);
  try {
    const res = await request({ type: 'probe', requestId }, 'probe-result', 500);
    return { components: res?.components, sourceFile: res?.sourceFile, minified: res?.minified };
  } finally {
    el.removeAttribute('data-nitpick-probe');
  }
}
