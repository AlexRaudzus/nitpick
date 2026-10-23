import { finder } from '@medv/finder';
import type { ElementDescriptor, Rect } from './types';
import { truncate } from './redact';

const TEST_ID_ATTRS = ['data-testid', 'data-test-id', 'data-test', 'data-cy', 'data-qa'];
/** Attributes that are usually written by hand in source code and therefore stable + greppable. */
const STABLE_ATTRS = [...TEST_ID_ATTRS, 'data-slot', 'name', 'aria-label', 'href', 'title', 'placeholder', 'alt', 'role', 'type', 'for'];

/** Classes that look generated (CSS modules, styled-components, emotion) are useless for agents. */
const GENERATED_CLASS = /^(css|sc|jsx|emotion)-|__(?=[\w-]*\d)[\w-]{5,}$/;

const IMPLICIT_ROLES: Record<string, string | ((el: Element) => string | undefined)> = {
  a: (el) => (el.hasAttribute('href') ? 'link' : undefined),
  button: 'button',
  select: 'combobox',
  textarea: 'textbox',
  nav: 'navigation',
  main: 'main',
  header: 'banner',
  footer: 'contentinfo',
  form: 'form',
  dialog: 'dialog',
  img: 'img',
  ul: 'list',
  ol: 'list',
  li: 'listitem',
  table: 'table',
  h1: 'heading',
  h2: 'heading',
  h3: 'heading',
  h4: 'heading',
  h5: 'heading',
  h6: 'heading',
  input: (el) => {
    const type = (el as HTMLInputElement).type;
    if (type === 'checkbox') return 'checkbox';
    if (type === 'radio') return 'radio';
    if (type === 'button' || type === 'submit' || type === 'reset') return 'button';
    if (type === 'range') return 'slider';
    return 'textbox';
  },
};

export function getRole(el: Element): string | undefined {
  const explicit = el.getAttribute('role');
  if (explicit) return explicit.split(' ')[0];
  const implicit = IMPLICIT_ROLES[el.tagName.toLowerCase()];
  return typeof implicit === 'function' ? implicit(el) : implicit;
}

function cleanText(text: string | null | undefined): string | undefined {
  const t = text?.replace(/\s+/g, ' ').trim();
  return t ? t : undefined;
}

/** Simplified accessible name computation — good enough to identify an element in code. */
export function getAccessibleName(el: Element): string | undefined {
  const doc = el.ownerDocument;
  const labelledBy = el.getAttribute('aria-labelledby');
  if (labelledBy) {
    const text = labelledBy
      .split(/\s+/)
      .map((id) => doc.getElementById(id)?.textContent)
      .join(' ');
    if (cleanText(text)) return truncate(cleanText(text)!, 80);
  }
  const direct = el.getAttribute('aria-label') ?? el.getAttribute('alt') ?? el.getAttribute('title');
  if (cleanText(direct)) return truncate(cleanText(direct)!, 80);

  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) {
    const label = el.labels?.[0]?.textContent ?? el.getAttribute('placeholder');
    if (cleanText(label)) return truncate(cleanText(label)!, 80);
    if (el instanceof HTMLInputElement && ['button', 'submit', 'reset'].includes(el.type)) {
      return cleanText(el.value);
    }
    return undefined;
  }
  const role = getRole(el);
  if (role && ['button', 'link', 'heading', 'tab', 'menuitem', 'option', 'checkbox', 'radio'].includes(role)) {
    const text = cleanText((el as HTMLElement).innerText ?? el.textContent);
    if (text) return truncate(text, 80);
  }
  return undefined;
}

function getTestId(el: Element): string | undefined {
  for (const attr of TEST_ID_ATTRS) {
    const v = el.getAttribute(attr);
    if (v) return `${attr}=${v}`;
  }
  return undefined;
}

export function getXPath(el: Element): string {
  const parts: string[] = [];
  let node: Element | null = el;
  while (node && node.nodeType === Node.ELEMENT_NODE) {
    if (node.id && node.ownerDocument.querySelectorAll(`#${CSS.escape(node.id)}`).length === 1) {
      parts.unshift(`//*[@id="${node.id}"]`);
      return parts.join('/');
    }
    const tag = node.tagName.toLowerCase();
    let index = 1;
    let sibling = node.previousElementSibling;
    while (sibling) {
      if (sibling.tagName === node.tagName) index++;
      sibling = sibling.previousElementSibling;
    }
    parts.unshift(`${tag}[${index}]`);
    node = node.parentElement;
  }
  return `/${parts.join('/')}`;
}

export function getCssSelector(el: Element): string {
  for (const attr of TEST_ID_ATTRS) {
    const v = el.getAttribute(attr);
    if (!v) continue;
    const sel = `[${attr}="${CSS.escape(v)}"]`;
    if (el.ownerDocument.querySelectorAll(sel).length === 1) return sel;
  }
  try {
    const selector = finder(el, {
      className: (name) => !GENERATED_CLASS.test(name),
      attr: (name, value) => STABLE_ATTRS.includes(name) && value.length <= 80,
      timeoutMs: 500,
    });
    return selector.length > 120 ? (anchoredSelector(el) ?? selector) : selector;
  } catch {
    return getXPath(el);
  }
}

/** `a[href="/settings/horizon"] > div` instead of a 15-level nth-of-type chain. */
function anchoredSelector(el: Element): string | undefined {
  const parts: string[] = [];
  for (let node: Element | null = el; node && node !== el.ownerDocument.body; node = node.parentElement) {
    for (const attr of STABLE_ATTRS) {
      const v = node.getAttribute(attr);
      if (!v || v.length > 80) continue;
      const anchor = `${node.tagName.toLowerCase()}[${attr}="${CSS.escape(v)}"]`;
      const candidate = [anchor, ...parts].join(' > ');
      if (el.ownerDocument.querySelectorAll(candidate).length === 1) return candidate;
    }
    if (node.id) {
      const candidate = [`#${CSS.escape(node.id)}`, ...parts].join(' > ');
      if (el.ownerDocument.querySelectorAll(candidate).length === 1) return candidate;
    }
    const parent: Element | null = node.parentElement;
    const tag = node.tagName.toLowerCase();
    const same = parent ? [...parent.children].filter((c) => c.tagName === node!.tagName) : [];
    parts.unshift(same.length > 1 ? `${tag}:nth-of-type(${same.indexOf(node) + 1})` : tag);
    if (parts.length > 6) return undefined;
  }
  return undefined;
}

function toRect(r: DOMRect, offsetX = 0, offsetY = 0): Rect {
  return {
    x: Math.round(r.left + offsetX),
    y: Math.round(r.top + offsetY),
    width: Math.round(r.width),
    height: Math.round(r.height),
  };
}

const LANDMARK =
  'nav, aside, main, header, footer, dialog, form, section[aria-label], section[aria-labelledby], [role=dialog], [role=alertdialog], [role=region], [role=navigation], [role=tabpanel], [role=menu], [role=listbox], [role=tablist], table';

/** Page regions that are separate from the main content; headings outside don't describe what's inside. */
const BOUNDARY =
  'nav, aside, header, footer, dialog, [role=dialog], [role=alertdialog], [role=navigation], [role=menu], [role=listbox], [role=tooltip]';

/** Closest interactive ancestor, closest landmark and the heading of the surrounding block. */
export function getContext(el: Element): string[] | undefined {
  const items: { node: Element; label: string }[] = [];
  const interactive = el.parentElement?.closest(INTERACTIVE);
  if (interactive && interactive !== el.ownerDocument.body) items.push({ node: interactive, label: shortLabel(interactive) });

  // Nearest heading *before* the element within its block; never cross a landmark boundary
  // (a sidebar icon must not be attributed to a heading in the main content).
  for (let node = el.parentElement; node && node !== el.ownerDocument.body; node = node.parentElement) {
    const heading = [...node.querySelectorAll('h1, h2, h3, h4, h5, h6, [role=heading]')]
      .filter((h) => h !== el && !h.contains(el) && !el.contains(h))
      .filter((h) => h.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING)
      .at(-1);
    const text = cleanText(heading?.textContent);
    if (text) {
      items.push({ node, label: `section "${truncate(text, 50)}"` });
      break;
    }
    if (node.matches(BOUNDARY)) break;
  }

  const landmark = el.parentElement?.closest(LANDMARK);
  if (landmark && !items.some((i) => i.node === landmark)) {
    items.push({ node: landmark, label: shortLabel(landmark, false) });
  }
  // innermost first
  items.sort((a, b) => (a.node.contains(b.node) ? 1 : b.node.contains(a.node) ? -1 : 0));
  return items.length ? items.map((i) => i.label) : undefined;
}

export function describeElement(el: Element): ElementDescriptor {
  const rect = el.getBoundingClientRect();
  const win = el.ownerDocument.defaultView ?? window;
  const classes = [...el.classList].filter((c) => !GENERATED_CLASS.test(c)).slice(0, 6);
  const text = cleanText((el as HTMLElement).innerText ?? el.textContent);
  return {
    tag: el.tagName.toLowerCase(),
    id: el.id || undefined,
    testId: getTestId(el),
    slot: el.getAttribute('data-slot') ?? undefined,
    role: getRole(el),
    name: getAccessibleName(el),
    text: text ? truncate(text, 120) : undefined,
    classes: classes.length ? classes : undefined,
    within: getContext(el),
    selector: getCssSelector(el),
    xpath: getXPath(el),
    documentRect: toRect(rect, win.scrollX, win.scrollY),
    viewportRect: toRect(rect),
  };
}

/** Short human/agent-readable label used in the timeline, e.g. `button "Speichern"`. */
export function shortLabel(el: Element, textFallback = true): string {
  const role = getRole(el) ?? el.tagName.toLowerCase();
  const name = getAccessibleName(el);
  const testId = getTestId(el);
  // Fall back to short visible text so `div "Total Cards"` beats a bare `div`
  const text = name ?? (textFallback ? shortText(el) : undefined);
  let label = text ? `${role} "${truncate(text, 50)}"` : role;
  if (testId) label += ` [${testId}]`;
  else if (!name && el.id) label += `#${el.id}`;
  return label;
}

function shortText(el: Element): string | undefined {
  const text = cleanText((el as HTMLElement).innerText ?? el.textContent);
  return text && text.length <= 60 ? text : undefined;
}

const INTERACTIVE = 'button, a[href], input, select, textarea, label, summary, [role], [data-testid], [onclick], [tabindex]';

/** Walk up from a click target to the element the user most likely meant (button, link, input...). */
export function interactiveAncestor(el: Element): Element | null {
  return el.closest(INTERACTIVE);
}
