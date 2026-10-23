export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Everything we know about a DOM element, collected so an agent can find it in code. */
export interface ElementDescriptor {
  tag: string;
  id?: string;
  testId?: string;
  /** shadcn/ui-style `data-slot` attribute. */
  slot?: string;
  role?: string;
  name?: string;
  text?: string;
  classes?: string[];
  selector: string;
  xpath: string;
  /** Position relative to the document (scroll-independent). */
  documentRect: Rect;
  /** Position relative to the viewport at capture time (matches the viewport screenshot). */
  viewportRect: Rect;
  /** Surrounding context, innermost first, e.g. ['button "Total Cards"', 'navigation "Sidebar"']. */
  within?: string[];
  /** Framework component chain, innermost last, e.g. ["SettingsPage", "SettingsForm", "Button"]. */
  components?: string[];
  /** Source file of the closest component, if the framework exposes it (Vue dev builds). */
  sourceFile?: string;
  /** Component names looked minified (production build), so `components` was omitted. */
  minified?: boolean;
}

export type CommentKind = 'element' | 'region' | 'note';

export interface FeedbackComment {
  id: string;
  index: number;
  kind: CommentKind;
  text: string;
  createdAt: number;
  url: string;
  pageTitle: string;
  element?: ElementDescriptor;
  /** Selected area in viewport coordinates (region comments). */
  region?: Rect;
  /** Asset ids, see FeedbackSession.assets. */
  screenshots: { viewport?: string; crop?: string };
  /** Timeline index of the last step before this comment. */
  timelineIndex: number;
  metadata?: Record<string, unknown>;
  viewport: { width: number; height: number; dpr: number; scrollX: number; scrollY: number };
}

export type TimelineEvent =
  | { type: 'navigate'; at: number; url: string; title?: string }
  | { type: 'click'; at: number; url: string; target: string }
  | { type: 'input'; at: number; url: string; target: string; value: string }
  | { type: 'submit'; at: number; url: string; target: string }
  | { type: 'comment'; at: number; url: string; commentId: string; commentIndex: number };

export interface LogEntry {
  at: number;
  url: string;
  level: 'error' | 'warn';
  message: string;
  stack?: string;
}

export interface FeedbackSession {
  id: string;
  startedAt: number;
  endedAt?: number;
  active: boolean;
  comments: FeedbackComment[];
  timeline: TimelineEvent[];
  logs: LogEntry[];
  /** Latest metadata reported by each origin. */
  metadata: Record<string, Record<string, unknown>>;
  userAgent: string;
}
