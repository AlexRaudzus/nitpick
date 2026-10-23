import { describe, expect, it } from 'vitest';
import { createSessionStore, type KVBackend } from '@/core/session-store';
import type { NewComment } from '@/core/host';

function memoryKV(): KVBackend & { data: Map<string, unknown> } {
  const data = new Map<string, unknown>();
  return {
    data,
    get: async (keys) => Object.fromEntries(keys.filter((k) => data.has(k)).map((k) => [k, structuredClone(data.get(k))])),
    set: async (items) => Object.entries(items).forEach(([k, v]) => data.set(k, structuredClone(v))),
    remove: async (keys) => keys.forEach((k) => data.delete(k)),
    keys: async () => [...data.keys()],
  };
}

const url = 'http://localhost:3000/settings';
const comment = (text: string): NewComment => ({
  kind: 'note',
  text,
  createdAt: Date.now(),
  url,
  pageTitle: 'Settings',
  metadata: { role: 'admin' },
  viewport: { width: 1280, height: 800, dpr: 1, scrollX: 0, scrollY: 0 },
});

describe('session store', () => {
  it('records the start page, numbers comments and links them into the timeline', async () => {
    const store = createSessionStore(memoryKV());
    await store.start({ url, title: 'Settings' });
    await store.addTimeline({ type: 'click', at: 1, url, target: 'button "Speichern"' });
    const c1 = await store.addComment(comment('eins'), { viewport: 'data:image/png;base64,AA==' });
    const c2 = await store.addComment(comment('zwei'), {});
    const s = (await store.load())!;
    expect([c1.index, c2.index]).toEqual([1, 2]);
    expect(c1.timelineIndex).toBe(1);
    expect(s.timeline.map((e) => e.type)).toEqual(['navigate', 'click', 'comment', 'comment']);
    expect(s.metadata['http://localhost:3000']).toEqual({ role: 'admin' });
  });

  it('collapses repeated navigations and consecutive input on the same field', async () => {
    const store = createSessionStore(memoryKV());
    await store.start({ url });
    await store.addTimeline({ type: 'navigate', at: 1, url });
    await store.addTimeline({ type: 'input', at: 2, url, target: 'textbox "Name"', value: 'A' });
    await store.addTimeline({ type: 'input', at: 3, url, target: 'textbox "Name"', value: 'AC' });
    const s = (await store.load())!;
    expect(s.timeline).toHaveLength(2);
    expect(s.timeline[1]).toMatchObject({ value: 'AC' });
  });

  it('ignores timeline and logs while stopped', async () => {
    const store = createSessionStore(memoryKV());
    await store.start();
    await store.stop();
    await store.addTimeline({ type: 'click', at: 1, url, target: 'x' });
    await store.addLog({ at: 1, url, level: 'error', message: 'boom' });
    const s = (await store.load())!;
    expect(s.timeline).toHaveLength(0);
    expect(s.logs).toHaveLength(0);
  });

  it('bundles screenshots under their export names and cleans up assets', async () => {
    const kv = memoryKV();
    const store = createSessionStore(kv);
    await store.start({ url });
    const c = await store.addComment(comment('eins'), { viewport: 'data:image/png;base64,AA==', crop: 'data:image/png;base64,AQ==' });
    const bundle = await store.bundle(new Date(2026, 9, 23, 14, 2, 11).getTime());
    expect(bundle.folderName).toBe('2026-10-23_14-02-11_localhost_3000');
    expect(bundle.assets.map((a) => a.name).sort()).toEqual(['screenshots/01-crop.png', 'screenshots/01-viewport.png']);
    expect(bundle.markdown).toContain('eins');

    await store.deleteComment(c.id);
    expect([...kv.data.keys()].filter((k) => k.startsWith('asset:'))).toHaveLength(0);
    await store.discard();
    expect(kv.data.size).toBe(0);
  });

  it('notifies subscribers on every change', async () => {
    const store = createSessionStore(memoryKV());
    const seen: (boolean | null)[] = [];
    store.subscribe((s) => seen.push(s ? s.active : null));
    await store.start();
    await store.stop();
    await store.discard();
    expect(seen).toEqual([true, false, null]);
  });

  it('serializes concurrent writes', async () => {
    const store = createSessionStore(memoryKV());
    await store.start();
    await Promise.all(Array.from({ length: 20 }, (_, i) => store.addTimeline({ type: 'click', at: i, url, target: `b${i}` })));
    expect((await store.load())!.timeline).toHaveLength(20);
  });

  it('remembers headless mode for the next session', async () => {
    const store = createSessionStore(memoryKV());
    await store.start();
    await store.setHidden(true);
    expect((await store.load())!.hidden).toBe(true);
    await store.discard();
    await store.start();
    expect((await store.load())!.hidden).toBe(true);
  });
});
