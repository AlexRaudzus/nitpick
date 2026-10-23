import { send } from '@/lib/messages';
import { interactiveAncestor, shortLabel } from '@/lib/describe-element';
import { isSensitiveField, redactText, truncate } from '@/lib/redact';
import type { TimelineEvent } from '@/lib/types';
import { onBridgeMessage, requestContext } from './bridge-client';

/**
 * Records the action timeline and console errors while a session is active.
 * `isOwnUi` filters out interactions with our toolbar.
 */
export function startRecorder(isActive: () => boolean, isOwnUi: (ev: Event) => boolean): () => void {
  const push = (event: TimelineEvent) => {
    if (isActive()) send({ type: 'timeline:add', event }).catch(() => undefined);
  };
  const onClick = (ev: MouseEvent) => {
    if (isOwnUi(ev)) return;
    const t = ev.composedPath()[0];
    if (!(t instanceof Element) || t === document.documentElement || t === document.body) return;
    const el = interactiveAncestor(t) ?? t;
    const label = shortLabel(el);
    // Clicks on anonymous containers (`div`, `span`) carry no information for the agent
    if (label === el.tagName.toLowerCase()) return;
    push({ type: 'click', at: Date.now(), url: location.href, target: label });
  };
  const onChange = (ev: Event) => {
    if (isOwnUi(ev)) return;
    const el = ev.target;
    if (!(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement)) return;
    if (el instanceof HTMLInputElement && ['checkbox', 'radio'].includes(el.type)) {
      push({ type: 'input', at: Date.now(), url: location.href, target: shortLabel(el), value: el.checked ? 'checked' : 'unchecked' });
      return;
    }
    const value = isSensitiveField(el) ? '••••' : truncate(redactText(el.value), 80);
    push({ type: 'input', at: Date.now(), url: location.href, target: shortLabel(el), value });
  };
  const onSubmit = (ev: SubmitEvent) => {
    if (isOwnUi(ev) || !(ev.target instanceof Element)) return;
    push({ type: 'submit', at: Date.now(), url: location.href, target: shortLabel(ev.target) });
  };

  document.addEventListener('click', onClick, true);
  document.addEventListener('change', onChange, true);
  document.addEventListener('submit', onSubmit, true);

  let lastUrl = '';
  const navigated = (url: string) => {
    if (url === lastUrl) return;
    lastUrl = url;
    push({ type: 'navigate', at: Date.now(), url, title: document.title || undefined });
    reportContext();
  };

  const reportContext = async () => {
    if (!isActive()) return;
    const metadata = await requestContext();
    if (Object.keys(metadata).length) send({ type: 'metadata:set', origin: location.origin, metadata }).catch(() => undefined);
  };

  const offBridge = onBridgeMessage((msg) => {
    if (msg.type === 'navigate') navigated(msg.url);
    if (msg.type === 'log' && isActive()) {
      send({
        type: 'log:add',
        entry: { at: Date.now(), url: location.href, level: msg.level, message: msg.message, stack: msg.stack },
      }).catch(() => undefined);
    }
  });

  navigated(location.href);

  return () => {
    document.removeEventListener('click', onClick, true);
    document.removeEventListener('change', onChange, true);
    document.removeEventListener('submit', onSubmit, true);
    offBridge();
  };
}
