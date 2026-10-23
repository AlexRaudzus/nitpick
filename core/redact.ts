const SENSITIVE_FIELD = /pass|pwd|secret|token|otp|pin|cvc|cvv|card|iban|ssn|api[-_]?key/i;

/** True for form fields whose value must never be recorded. */
export function isSensitiveField(el: Element): boolean {
  if (el instanceof HTMLInputElement && (el.type === 'password' || el.type === 'hidden')) return true;
  const hints = [
    el.getAttribute('name'),
    el.getAttribute('id'),
    el.getAttribute('autocomplete'),
    el.getAttribute('aria-label'),
  ];
  return hints.some((h) => h != null && SENSITIVE_FIELD.test(h));
}

/** Mask tokens that commonly leak through logs (JWTs, bearer tokens, long hex/base64 secrets). */
export function redactText(text: string): string {
  return text
    .replace(/eyJ[\w-]{8,}\.[\w-]{8,}\.[\w-]{8,}/g, (m) => `${m.slice(0, 8)}…[redacted]`)
    .replace(/(bearer\s+)[\w.~+/=-]{12,}/gi, '$1[redacted]')
    .replace(/((?:token|secret|password|api[-_]?key)["']?\s*[:=]\s*["']?)[^\s"'&,}]{4,}/gi, '$1[redacted]');
}

export function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}
