// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { describeElement, getAccessibleName, getRole, shortLabel } from '@/core/describe-element';
import { isSensitiveField } from '@/core/redact';

describe('describeElement', () => {
  it('collects role, name, test id and a unique selector', () => {
    document.body.innerHTML = `
      <form class="settings">
        <label for="name">Name</label><input id="name" />
        <div class="actions"><button type="submit" data-testid="settings-save" class="btn css-1x2y3z">Speichern</button></div>
        <div class="actions"><button type="button">Abbrechen</button></div>
      </form>`;
    const btn = document.querySelector('[data-testid]')!;
    const d = describeElement(btn);
    expect(d.tag).toBe('button');
    expect(d.role).toBe('button');
    expect(d.name).toBe('Speichern');
    expect(d.testId).toBe('data-testid=settings-save');
    expect(d.classes).toEqual(['btn']);
    expect(document.querySelectorAll(d.selector)).toHaveLength(1);
    expect(document.querySelector(d.selector)).toBe(btn);
  });

  it('uses labels for inputs and marks sensitive fields', () => {
    document.body.innerHTML = `<label for="n">Vorname</label><input id="n"><input type="password" name="pw">`;
    const input = document.getElementById('n')!;
    expect(getRole(input)).toBe('textbox');
    expect(getAccessibleName(input)).toBe('Vorname');
    expect(shortLabel(input)).toBe('textbox "Vorname"');
    expect(isSensitiveField(document.querySelector('[name=pw]')!)).toBe(true);
    expect(isSensitiveField(input)).toBe(false);
  });
});

describe('getContext', () => {
  it('uses the closest preceding heading and does not cross into other page regions', async () => {
    const { getContext } = await import('@/core/describe-element');
    document.body.innerHTML = `
      <nav aria-label="Sidebar"><ul><li><a href="/horizon"><span id="icon">*</span></a></li></ul></nav>
      <main>
        <h1>Branding</h1>
        <div><span id="upload">Drop an image</span></div>
        <h3>English</h3>
        <div>phrases</div>
      </main>`;
    expect(getContext(document.getElementById('upload')!)).toEqual(['section "Branding"']);
    expect(getContext(document.getElementById('icon')!)).toEqual(['link "*"', 'navigation "Sidebar"']);
  });

  it('anchors long selectors at a stable attribute', async () => {
    const { getCssSelector } = await import('@/core/describe-element');
    const deep = '<div><div>'.repeat(12) + '<a href="/settings/horizon"><div class="x"></div></a>' + '</div></div>'.repeat(12);
    document.body.innerHTML = deep + deep.replace('/settings/horizon', '/settings/other');
    const target = document.querySelector('a[href="/settings/horizon"] > div')!;
    const sel = getCssSelector(target);
    expect(document.querySelector(sel)).toBe(target);
    expect(sel.length).toBeLessThanOrEqual(120);
  });

  it('never builds selectors from utility classes', async () => {
    const { getCssSelector } = await import('@/core/describe-element');
    document.body.innerHTML = `
      <aside class="flex w-64 border-r">
        <button data-slot="popover-trigger" class="z-100 peer/menu-button flex w-full items-center gap-2">Workspace</button>
        <button data-slot="sidebar-item" class="flex">A</button>
        <button data-slot="sidebar-item" class="flex">B</button>
      </aside>
      <main><iframe name="App" class="h-full w-full border-0"></iframe><div class="settings-card p-4">x</div></main>`;
    expect(getCssSelector(document.querySelector('[data-slot=popover-trigger]')!)).toBe('button[data-slot="popover-trigger"]');
    expect(getCssSelector(document.querySelector('iframe')!)).toBe('iframe[name="App"]');
    expect(getCssSelector(document.querySelector('.settings-card')!)).toBe('.settings-card');
    const b = getCssSelector(document.querySelectorAll('[data-slot=sidebar-item]')[1]!);
    expect(document.querySelector(b)).toBe(document.querySelectorAll('[data-slot=sidebar-item]')[1]);
    expect(b).not.toMatch(/\.(flex|w-|z-|gap)/);
  });

  it('ignores generated ids and does not over-escape attribute values', async () => {
    const { getCssSelector, describeElement } = await import('@/core/describe-element');
    document.body.innerHTML = `
      <form><h3><button id="radix-_r_13_" data-slot="accordion-trigger">English</button></h3>
      <h3><button id="radix-_r_14_" data-slot="accordion-trigger">Deutsch</button></h3></form>
      <nav><a href="/platform-state">Platform State</a></nav>`;
    const btn = document.getElementById('radix-_r_13_')!;
    const sel = getCssSelector(btn);
    expect(sel).not.toContain('radix');
    expect(document.querySelector(sel)).toBe(btn);
    expect(describeElement(btn).id).toBeUndefined();
    expect(getCssSelector(document.querySelector('a')!)).toBe('a[href="/platform-state"]');
  });
});
