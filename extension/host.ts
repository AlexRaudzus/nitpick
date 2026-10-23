import { browser } from 'wxt/browser';
import type { FeedbackHost } from '@/core/host';
import type { FeedbackSession } from '@/core/types';
import { SESSION_KEY } from '@/core/session-store';
import { send } from './messages';
import { onBridgeMessage, probeComponents, requestContext } from './bridge-client';

/** Content-script side of the extension: state lives in the service worker, page access via the MAIN-world bridge. */
export function createExtensionHost(): FeedbackHost {
  return {
    load: () => send({ type: 'session:get' }),
    subscribe(cb) {
      const onChange = (changes: Record<string, { newValue?: unknown }>, area: string) => {
        if (area === 'local' && SESSION_KEY in changes) cb((changes[SESSION_KEY].newValue as FeedbackSession) ?? null);
      };
      browser.storage.onChanged.addListener(onChange);
      return () => browser.storage.onChanged.removeListener(onChange);
    },
    start: async () => void (await send({ type: 'session:start' })),
    stop: async () => void (await send({ type: 'session:stop' })),
    resume: async () => void (await send({ type: 'session:resume' })),
    discard: async () => void (await send({ type: 'session:discard' })),
    addComment: (comment, screenshots) => send({ type: 'comment:add', comment, screenshots }),
    updateComment: async (id, text) => void (await send({ type: 'comment:update', id, text })),
    deleteComment: async (id) => void (await send({ type: 'comment:delete', id })),
    addTimeline: async (event) => void (await send({ type: 'timeline:add', event })),
    addLog: async (entry) => void (await send({ type: 'log:add', entry })),
    setMetadata: async (origin, metadata) => void (await send({ type: 'metadata:set', origin, metadata })),

    captureViewport: () => send({ type: 'capture:viewport' }),
    requestContext,
    probeComponents,
    onPageEvent: (cb) =>
      onBridgeMessage((msg) => {
        if (msg.type === 'navigate' || msg.type === 'log') cb(msg);
      }),

    finishActions: [
      {
        label: 'Exportieren',
        primary: true,
        async run() {
          const res = await send({ type: 'export:folder' });
          return res.copied ? `Exportiert · Pfad kopiert: ${res.path}` : `${res.files} Dateien in Downloads/${res.folder} gespeichert`;
        },
      },
      {
        label: 'Markdown kopieren',
        async run() {
          const md = await send({ type: 'export:markdown' });
          return (await send({ type: 'clipboard:copy', text: md })) ? 'Markdown kopiert (ohne Screenshots)' : 'Kopieren fehlgeschlagen';
        },
      },
    ],

    onPickCommand(cb) {
      const onMessage = (msg: unknown) => {
        if ((msg as { type?: string })?.type === 'command') cb();
      };
      browser.runtime.onMessage.addListener(onMessage);
      return () => browser.runtime.onMessage.removeListener(onMessage);
    },
  };
}
