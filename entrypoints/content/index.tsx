import ReactDOM from 'react-dom/client';
import './style.css';
import { browser } from 'wxt/browser';
import { App } from './App';

export default defineContentScript({
  matches: ['<all_urls>'],
  cssInjectionMode: 'ui',
  runAt: 'document_idle',
  async main(ctx) {
    // Exactly one live instance per tab: the manifest copy and a copy injected after install/update can meet.
    const w = window as unknown as { __agentFeedbackContent?: { alive: () => boolean } };
    if (w.__agentFeedbackContent?.alive()) return;
    w.__agentFeedbackContent = { alive: () => !ctx.isInvalid };
    // UI left behind by an orphaned copy from a previous extension version
    document.querySelectorAll('agent-feedback-ui').forEach((el) => el.remove());

    const ui = await createShadowRootUi(ctx, {
      name: 'agent-feedback-ui',
      position: 'overlay',
      zIndex: 2147483647,
      anchor: 'html',
      // Keep the page from reacting to typing/clicking inside our UI
      // (keyboard shortcuts, "click outside" handlers of modals and popovers).
      isolateEvents: ['keydown', 'keyup', 'keypress', 'pointerdown', 'mousedown', 'mouseup', 'focusin', 'focusout'],
      onMount(container, _shadow, host) {
        const root = ReactDOM.createRoot(container);
        root.render(<App host={host} />);
        return root;
      },
      onRemove(root) {
        root?.unmount();
      },
    });
    ui.mount();
    // Lets the background check whether a live copy already runs in this tab before injecting another.
    browser.runtime.onMessage.addListener((msg: { type?: string }, _sender, sendResponse) => {
      if (msg?.type !== 'ping') return;
      sendResponse('pong');
    });
    // After an extension update a fresh copy is injected; the old one must disappear.
    ctx.onInvalidated(() => ui.remove());
  },
});
