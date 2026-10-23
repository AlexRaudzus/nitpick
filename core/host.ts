import type { FeedbackComment, FeedbackSession, LogEntry, TimelineEvent } from './types';

export type NewComment = Omit<FeedbackComment, 'id' | 'index' | 'timelineIndex' | 'screenshots'>;
export type Screenshots = { viewport?: string; crop?: string };
export type ComponentInfo = { components?: string[]; sourceFile?: string; minified?: boolean };

/** What the page world reports: SPA navigations and console errors/warnings. */
export type PageEvent =
  | { type: 'navigate'; url: string }
  | { type: 'log'; level: 'error' | 'warn'; message: string; stack?: string };

/** Button shown in the toolbar once the session is finished (export, hand over to ticket, …). */
export interface FinishAction {
  label: string;
  primary?: boolean;
  /** Returns a message shown as toast. */
  run: () => Promise<string | void>;
}

/**
 * Everything the toolbar UI needs from its environment. The browser extension implements it via
 * messages to the service worker; the embed implements it in-page with IndexedDB.
 */
export interface FeedbackHost {
  // Session state
  load(): Promise<FeedbackSession | null>;
  /** Called with the new state whenever the session changes (also from other tabs where possible). */
  subscribe(cb: (session: FeedbackSession | null) => void): () => void;
  start(): Promise<void>;
  stop(): Promise<void>;
  resume(): Promise<void>;
  discard(): Promise<void>;

  addComment(comment: NewComment, screenshots: Screenshots): Promise<FeedbackComment>;
  updateComment(id: string, text: string): Promise<void>;
  deleteComment(id: string): Promise<void>;
  addTimeline(event: TimelineEvent): Promise<void>;
  addLog(entry: LogEntry): Promise<void>;
  setMetadata(origin: string, metadata: Record<string, unknown>): Promise<void>;

  // Page access
  /** PNG data URL of the visible viewport. The caller hides the toolbar UI beforehand. */
  captureViewport(): Promise<string>;
  /** Metadata the site provides (meta tags, window.__AGENT_FEEDBACK__, request-context event, …). */
  requestContext(): Promise<Record<string, unknown>>;
  probeComponents(el: Element): Promise<ComponentInfo>;
  onPageEvent(cb: (event: PageEvent) => void): () => void;

  // Shell specifics
  finishActions: FinishAction[];
  /** External trigger to pick a single element (keyboard command of the extension). */
  onPickCommand?(cb: () => void): () => void;
}
