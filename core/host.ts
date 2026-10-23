import type { ElementDescriptor, FeedbackComment, FeedbackSession, LogEntry, Rect, TimelineEvent } from './types';

export type NewComment = Omit<FeedbackComment, 'id' | 'index' | 'timelineIndex' | 'screenshots'>;
export type Screenshots = { viewport?: string; crop?: string };
export type ComponentInfo = { components?: string[]; sourceFile?: string; minified?: boolean };

/** What the page world reports: SPA navigations and console errors/warnings. */
export type PageEvent =
  | { type: 'navigate'; url: string }
  | { type: 'log'; level: 'error' | 'warn'; message: string; stack?: string };

export type HostCommand = 'pick' | 'export' | 'toggle-toolbar';

/** Button shown in the toolbar once the session is finished (export, hand over to ticket, …). */
export interface FinishAction {
  label: string;
  primary?: boolean;
  /**
   * Returns a message shown as toast. The first action is also bound to the export shortcut and may
   * then run while the session is still active.
   */
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
  /** Headless mode: hide the toolbar, work via shortcuts only. */
  setHidden(hidden: boolean): Promise<void>;

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
  /** External triggers, e.g. browser keyboard commands or the extension icon's context menu. */
  onCommand?(cb: (command: HostCommand) => void): () => void;
  /** Picking inside iframes (extension: also cross-origin). */
  frames?: FrameBridge;
}

/** Reported by pickers running inside iframes; rects are already translated to the top viewport. */
export type FrameEvent =
  | { type: 'held'; held: boolean }
  | { type: 'hover'; rect: Rect | null }
  | { type: 'picked'; element: ElementDescriptor; rect: Rect }
  | { type: 'shortcut'; code: string }
  | { type: 'escape' };

export interface FrameBridge {
  setPickerActive(active: boolean): void;
  onEvent(cb: (event: FrameEvent) => void): () => void;
}
