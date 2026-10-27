/**
 * Runs in the page's own JS world (MAIN) at document_start. It can see what the isolated content script
 * cannot: console calls, history changes, framework internals on DOM nodes and page-provided metadata.
 * Everything is relayed to the content script via window.postMessage.
 */
import { BRIDGE_SOURCE, CONTENT_SOURCE, type BridgeToContent, type ContentToBridge } from '@/extension/messages';
import { collectContext, hookConsole, hookHistory, inspectComponents } from '@/core/page';

export default defineContentScript({
  matches: ['<all_urls>'],
  world: 'MAIN',
  runAt: 'document_start',
  allFrames: true,
  matchAboutBlank: true,
  main() {
    // The extension re-injects itself into open tabs after an update; hook the page only once.
    const w = window as unknown as { __nitpickBridge?: boolean };
    if (w.__nitpickBridge) return;
    w.__nitpickBridge = true;

    const post = (msg: BridgeToContent) => window.postMessage({ source: BRIDGE_SOURCE, ...msg }, '*');

    hookConsole(post);
    hookHistory(post);

    window.addEventListener('message', async (ev) => {
      if (ev.source !== window || ev.data?.source !== CONTENT_SOURCE) return;
      const msg = ev.data as ContentToBridge;
      if (msg.type === 'request-context') {
        post({ type: 'context', requestId: msg.requestId, metadata: await collectContext() });
      } else if (msg.type === 'probe') {
        const el = document.querySelector(`[data-nitpick-probe="${msg.requestId}"]`);
        post({ type: 'probe-result', requestId: msg.requestId, ...(el ? inspectComponents(el) : {}) });
      }
    });
  },
});
