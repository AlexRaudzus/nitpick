// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { describeElement, getAccessibleName, getRole, shortLabel } from '@/lib/describe-element';
import { isSensitiveField } from '@/lib/redact';

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
    const { getContext } = await import('@/lib/describe-element');
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
    const { getCssSelector } = await import('@/lib/describe-element');
    const deep = '<div><div>'.repeat(12) + '<a href="/settings/horizon"><div class="x"></div></a>' + '</div></div>'.repeat(12);
    document.body.innerHTML = deep + deep.replace('/settings/horizon', '/settings/other');
    const target = document.querySelector('a[href="/settings/horizon"] > div')!;
    const sel = getCssSelector(target);
    expect(document.querySelector(sel)).toBe(target);
    expect(sel.length).toBeLessThanOrEqual(120);
  });
});
