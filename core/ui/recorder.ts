import { interactiveAncestor, shortLabel } from '../describe-element';
import type { FeedbackHost } from '../host';
import { isSensitiveField, redactText, truncate } from '../redact';
import type { TimelineEvent } from '../types';

/**
 * Records the action timeline and console errors while a session is active.
 * `isOwnUi` filters out interactions with our toolbar.
 */
export function startRecorder(
  host: FeedbackHost,
  isActive: () => boolean,
  isOwnUi: (ev: Event) => boolean,
  /** Inside an iframe: no navigation/metadata of its own, targets are marked as in-frame. */
  opts: { frame?: boolean } = {},
): () => void {
  const label = (el: Element) => (opts.frame ? `${shortLabel(el)} (in iframe)` : shortLabel(el));
  const push = (event: TimelineEvent) => {
    if (opts.frame && event.type !== 'navigate' && event.type !== 'comment') event.frame = true;
    if (isActive()) host.addTimeline(event).catch(() => undefined);
  };
  const onClick = (ev: MouseEvent) => {
    if (isOwnUi(ev)) return;
    const t = ev.composedPath()[0];
    if (!(t instanceof Element) || t === document.documentElement || t === document.body) return;
    const el = interactiveAncestor(t) ?? t;
    // Clicks on anonymous containers (`div`, `span`) carry no information for the agent
    if (shortLabel(el) === el.tagName.toLowerCase()) return;
    push({ type: 'click', at: Date.now(), url: location.href, target: label(el) });
  };
  const onChange = (ev: Event) => {
    if (isOwnUi(ev)) return;
    const el = ev.target;
    if (!(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement)) return;
    if (el instanceof HTMLInputElement && ['checkbox', 'radio'].includes(el.type)) {
      push({ type: 'input', at: Date.now(), url: location.href, target: label(el), value: el.checked ? 'checked' : 'unchecked' });
      return;
    }
    const value = isSensitiveField(el) ? '••••' : truncate(redactText(el.value), 80);
    push({ type: 'input', at: Date.now(), url: location.href, target: label(el), value });
  };
  const onSubmit = (ev: SubmitEvent) => {
    if (isOwnUi(ev) || !(ev.target instanceof Element)) return;
    push({ type: 'submit', at: Date.now(), url: location.href, target: label(ev.target) });
  };

  document.addEventListener('click', onClick, true);
  document.addEventListener('change', onChange, true);
  document.addEventListener('submit', onSubmit, true);

  let lastUrl = '';
  const navigated = (url: string) => {
    if (opts.frame || url === lastUrl) return;
    lastUrl = url;
    push({ type: 'navigate', at: Date.now(), url, title: document.title || undefined });
    reportContext();
  };

  const reportContext = async () => {
    if (!isActive()) return;
    const metadata = await host.requestContext();
    if (Object.keys(metadata).length) host.setMetadata(location.origin, metadata).catch(() => undefined);
  };

  const offPage = host.onPageEvent((msg) => {
    if (msg.type === 'navigate') navigated(msg.url);
    if (msg.type === 'log' && isActive()) {
      host
        .addLog({ at: Date.now(), url: location.href, level: msg.level, message: msg.message, stack: msg.stack })
        .catch(() => undefined);
    }
  });

  navigated(location.href);

  return () => {
    document.removeEventListener('click', onClick, true);
    document.removeEventListener('change', onChange, true);
    document.removeEventListener('submit', onSubmit, true);
    offPage();
  };
}
