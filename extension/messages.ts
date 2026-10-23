import { browser, type Browser } from 'wxt/browser';
import type { FeedbackComment, FeedbackSession, LogEntry, TimelineEvent } from '@/core/types';
import type { ComponentInfo, NewComment, PageEvent, Screenshots } from '@/core/host';

/** Messages from content script / popup to the background service worker. */
export type Request =
  | { type: 'session:get' }
  | { type: 'session:start' }
  | { type: 'session:stop' }
  | { type: 'session:resume' }
  | { type: 'session:discard' }
  | { type: 'session:hidden'; hidden: boolean }
  | { type: 'capture:viewport' }
  | {
      type: 'comment:add';
      comment: NewComment;
      screenshots: Screenshots;
    }
  | { type: 'comment:update'; id: string; text: string }
  | { type: 'comment:delete'; id: string }
  | { type: 'timeline:add'; event: TimelineEvent }
  | { type: 'log:add'; entry: LogEntry }
  | { type: 'metadata:set'; origin: string; metadata: Record<string, unknown> }
  | { type: 'export:folder' }
  | { type: 'export:markdown' }
  | { type: 'clipboard:copy'; text: string };

export interface ResponseMap {
  'session:get': FeedbackSession | null;
  'session:start': FeedbackSession;
  'session:stop': FeedbackSession | null;
  'session:resume': FeedbackSession | null;
  'session:discard': null;
  'session:hidden': null;
  'capture:viewport': string;
  'comment:add': FeedbackComment;
  'comment:update': null;
  'comment:delete': null;
  'timeline:add': null;
  'log:add': null;
  'metadata:set': null;
  'export:folder': { folder: string; path?: string; files: number; copied: boolean; restarted: boolean };
  'clipboard:copy': boolean;
  'export:markdown': string;
}

type Reply<T> = { ok: true; data: T } | { ok: false; error: string };

export async function send<R extends Request>(req: R): Promise<ResponseMap[R['type']]> {
  const res = (await browser.runtime.sendMessage(req)) as Reply<ResponseMap[R['type']]> | undefined;
  if (!res) throw new Error(`No response for ${req.type}`);
  if (!res.ok) throw new Error(res.error);
  return res.data;
}

/** Background side: register a handler; uses sendResponse so it works on every Chrome version. */
export function handle(
  handler: (req: Request, sender: Browser.runtime.MessageSender) => Promise<unknown>,
) {
  browser.runtime.onMessage.addListener((req, sender, sendResponse) => {
    handler(req as Request, sender).then(
      (data) => sendResponse({ ok: true, data: data ?? null }),
      (err: unknown) => sendResponse({ ok: false, error: err instanceof Error ? err.message : String(err) }),
    );
    return true;
  });
}

/** Messages between the page-world bridge and the isolated content script (window.postMessage). */
export const BRIDGE_SOURCE = 'agent-feedback-bridge';
export const CONTENT_SOURCE = 'agent-feedback-content';

export type BridgeToContent =
  | PageEvent
  | { type: 'context'; requestId: string; metadata: Record<string, unknown> }
  | ({ type: 'probe-result'; requestId: string } & ComponentInfo);

export type ContentToBridge =
  | { type: 'request-context'; requestId: string }
  | { type: 'probe'; requestId: string };
