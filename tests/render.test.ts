import { describe, expect, it } from 'vitest';
import { renderJson, renderMarkdown, assetFileNames } from '@/core/render';
import type { FeedbackSession } from '@/core/types';

const t0 = new Date(2026, 9, 23, 14, 2, 0).getTime();

const session: FeedbackSession = {
  id: 's1',
  startedAt: t0,
  endedAt: t0 + 60_000,
  active: false,
  userAgent: 'TestBrowser/1.0',
  metadata: { 'http://localhost:3000': { role: 'admin', version: '2.4.1' } },
  timeline: [
    { type: 'navigate', at: t0, url: 'http://localhost:3000/settings', title: 'Settings' },
    { type: 'click', at: t0 + 1000, url: 'http://localhost:3000/settings', target: 'button "Speichern"' },
    { type: 'comment', at: t0 + 5000, url: 'http://localhost:3000/settings', commentId: 'c1', commentIndex: 1 },
    { type: 'navigate', at: t0 + 8000, url: 'https://login.example.com/authorize' },
  ],
  logs: [
    { at: t0 + 2000, url: 'http://localhost:3000/settings', level: 'error', message: 'TypeError: x is undefined' },
    { at: t0 + 2500, url: 'http://localhost:3000/settings', level: 'error', message: 'TypeError: x is undefined' },
  ],
  comments: [
    {
      id: 'c1',
      index: 1,
      kind: 'element',
      text: 'Label sollte "Sichern" heißen\nUnd größer sein',
      createdAt: t0 + 5000,
      url: 'http://localhost:3000/settings',
      pageTitle: 'Settings',
      timelineIndex: 1,
      screenshots: { viewport: 'a1', crop: 'a2' },
      viewport: { width: 1440, height: 900, dpr: 2, scrollX: 0, scrollY: 0 },
      element: {
        tag: 'button',
        role: 'button',
        name: 'Speichern',
        testId: 'data-testid=settings-save',
        selector: '[data-testid="settings-save"]',
        xpath: '/html/body/button[1]',
        components: ['SettingsPage', 'SettingsForm'],
        documentRect: { x: 10, y: 20, width: 100, height: 30 },
        viewportRect: { x: 10, y: 20, width: 100, height: 30 },
      },
    },
  ],
};

describe('renderMarkdown', () => {
  const md = renderMarkdown(session);

  it('contains the comment with element identifiers and screenshot paths', () => {
    expect(md).toContain('### 1. Label sollte "Sichern" heißen');
    expect(md).toContain('> Und größer sein');
    expect(md).toContain('`data-testid=settings-save`');
    expect(md).toContain('`SettingsPage › SettingsForm`');
    expect(md).toContain('`screenshots/01-crop.png`');
    expect(md).toContain('`screenshots/01-viewport.png` (viewport, marker 1)');
  });

  it('links preceding steps and related, deduplicated errors', () => {
    expect(md).toContain('**Steps before this (see timeline):** #1, #2');
    expect(md).toContain('- `TypeError: x is undefined` (×2)');
  });

  it('renders app context, timeline and origin changes', () => {
    expect(md).toContain('  - role: admin');
    expect(md).toContain('2. 14:02:01 click button "Speichern"');
    expect(md).toContain('_(now on login.example.com)_');
  });

  it('renders the snapshot', () => {
    expect(md).toMatchSnapshot();
  });
});

describe('renderJson', () => {
  it('replaces asset ids with file paths', () => {
    const json = JSON.parse(renderJson(session));
    expect(json.format).toBe('agent-feedback/v1');
    expect(json.comments[0].screenshots).toEqual({ crop: 'screenshots/01-crop.png', viewport: 'screenshots/01-viewport.png' });
    expect(assetFileNames(session).size).toBe(2);
  });
});

describe('exportFolderName', () => {
  it('uses the export time including seconds', async () => {
    const { exportFolderName } = await import('@/core/render');
    const at = new Date(2026, 9, 23, 15, 7, 9).getTime();
    expect(exportFolderName(session, at)).toBe('2026-10-23_15-07-09_localhost_3000');
  });
});
