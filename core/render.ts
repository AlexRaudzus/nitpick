import type { ElementDescriptor, FeedbackComment, FeedbackSession, LogEntry, TimelineEvent } from './types';

/** How long before a comment console entries are considered related to it. */
const RELATED_LOG_WINDOW_MS = 15_000;
const STEPS_BEFORE_COMMENT = 5;

const pad = (n: number, len = 2) => String(n).padStart(len, '0');

export function formatTime(ts: number): string {
  const d = new Date(ts);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

export function formatDateTime(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${formatTime(ts)}`;
}

/** Named after the export time (to the second), so repeated exports never overwrite each other. */
export function exportFolderName(session: FeedbackSession, exportedAt = Date.now()): string {
  const d = new Date(exportedAt);
  const host = hostOf(session.comments[0]?.url ?? session.timeline[0]?.url ?? '') || 'session';
  const date = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const time = `${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`;
  return `${date}_${time}_${host.replace(/[^\w.-]/g, '_')}`;
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return '';
  }
}

function originOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return '';
  }
}

function pathOf(url: string): string {
  try {
    const u = new URL(url);
    return `${u.pathname}${u.search}${u.hash}`;
  } catch {
    return url;
  }
}

/** Relative file names for every screenshot, keyed by asset id. */
export function assetFileNames(session: FeedbackSession): Map<string, string> {
  const names = new Map<string, string>();
  for (const c of session.comments) {
    const n = pad(c.index);
    if (c.screenshots.crop) names.set(c.screenshots.crop, `screenshots/${n}-crop.png`);
    if (c.screenshots.viewport) names.set(c.screenshots.viewport, `screenshots/${n}-viewport.png`);
  }
  return names;
}

export function describeTimelineEvent(e: TimelineEvent): string {
  switch (e.type) {
    case 'navigate':
      return `navigate ${pathOf(e.url)}${e.title ? ` ("${e.title}")` : ''}`;
    case 'click':
      return `click ${e.target}`;
    case 'input':
      return `input ${e.target} = "${e.value}"`;
    case 'submit':
      return `submit ${e.target}`;
    case 'comment':
      return `💬 feedback #${e.commentIndex}`;
  }
}

function firstLine(text: string): string {
  const line = text.trim().split('\n')[0] ?? '';
  return line.length > 80 ? `${line.slice(0, 80)}…` : line;
}

function code(v: string): string {
  return v.includes('`') ? `\`\` ${v} \`\`` : `\`${v}\``;
}

function renderElement(el: ElementDescriptor, label = 'Element'): string[] {
  const head = [code(el.tag), el.role && `role=${el.role}`, el.name && `name="${el.name}"`].filter(Boolean).join(' · ');
  const lines = [`**${label}:** ${head}`];
  if (el.testId) lines.push(`- test id: ${code(el.testId)}`);
  if (el.id) lines.push(`- id: ${code(el.id)}`);
  if (el.slot) lines.push(`- data-slot: ${code(el.slot)}`);
  if (el.frames?.length) {
    const chain = el.frames.map((f) => `${code(f.selector)} (${f.url})`).join(' › ');
    lines.push(`- in iframe: ${chain} — selector/inside below are relative to that frame's document`);
  }
  if (el.within?.length) lines.push(`- inside: ${[...el.within].reverse().join(' › ')}`);
  if (el.components?.length) lines.push(`- component: ${code(el.components.join(' › '))}`);
  else if (el.minified) lines.push('- component: _unknown (production build with minified names)_');
  if (el.sourceFile) lines.push(`- source: ${code(el.sourceFile)}`);
  lines.push(`- selector: ${code(el.selector)}`);
  if (el.text && el.text !== el.name) lines.push(`- text: "${el.text}"`);
  if (el.classes?.length) lines.push(`- classes: ${el.classes.map(code).join(' ')}`);
  const r = el.documentRect;
  lines.push(`- position (document): x=${r.x} y=${r.y} w=${r.width} h=${r.height}`);
  return lines;
}

function previousComment(session: FeedbackSession, c: FeedbackComment): FeedbackComment | undefined {
  const i = session.comments.indexOf(c);
  return i > 0 ? session.comments[i - 1] : undefined;
}

/** Errors shortly before this comment that were not already attached to the previous one. */
function relatedLogs(session: FeedbackSession, c: FeedbackComment): LogEntry[] {
  const since = Math.max(c.createdAt - RELATED_LOG_WINDOW_MS, previousComment(session, c)?.createdAt ?? 0);
  return session.logs.filter((l) => l.level === 'error' && l.at <= c.createdAt && l.at > since);
}

function dedupeLogs(logs: LogEntry[]): { entry: LogEntry; count: number }[] {
  const map = new Map<string, { entry: LogEntry; count: number }>();
  for (const l of logs) {
    const key = `${l.level}|${l.message}`;
    const existing = map.get(key);
    if (existing) existing.count++;
    else map.set(key, { entry: l, count: 1 });
  }
  return [...map.values()];
}

function renderMetadata(meta: Record<string, unknown>, indent = ''): string[] {
  return Object.entries(meta).map(([k, v]) => `${indent}- ${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`);
}

export interface RenderOptions {
  /**
   * Public URL for a screenshot path (e.g. after uploading it to a ticket). When given, screenshots are
   * embedded as images instead of being referenced as relative files.
   */
  assetUrl?: (path: string) => string | undefined;
}

function renderScreenshots(c: FeedbackComment, names: Map<string, string>, opts: RenderOptions): string[] {
  const shots = [
    c.screenshots.crop && { path: names.get(c.screenshots.crop)!, label: 'close-up' },
    c.screenshots.viewport && { path: names.get(c.screenshots.viewport)!, label: `viewport, marker ${c.index}` },
  ].filter((s) => !!s);
  if (!shots.length) return [];
  const urls = shots.map((s) => opts.assetUrl?.(s.path));
  if (urls.every(Boolean)) return [...shots.map((s, i) => `![${s.label}](${urls[i]})`), ''];
  return [`**Screenshots:** ${shots.map((s) => `${code(s.path)} (${s.label})`).join(', ')}`, ''];
}

function renderComment(session: FeedbackSession, c: FeedbackComment, names: Map<string, string>, opts: RenderOptions): string[] {
  const out: string[] = [];
  out.push(`### ${c.index}. ${firstLine(c.text) || '(no text)'}`, '');
  out.push(`**Page:** ${code(pathOf(c.url))}${c.pageTitle ? ` — ${c.pageTitle}` : ''}  `);
  out.push(`**Type:** ${c.kind === 'element' ? 'element comment' : c.kind === 'region' ? 'marked area' : 'general note'}`, '');
  out.push(...c.text.trim().split('\n').map((l) => `> ${l}`), '');

  if (c.region) {
    const r = c.region;
    out.push(
      `**Marked area (viewport):** x=${r.x} y=${r.y} w=${r.width} h=${r.height}, scroll=${c.viewport.scrollX},${c.viewport.scrollY}`,
      '',
    );
  }
  if (c.element) out.push(...renderElement(c.element, c.kind === 'region' ? 'Element at center of area' : 'Element'), '');

  out.push(...renderScreenshots(c, names, opts));

  const prev = previousComment(session, c);
  const steps = session.timeline
    .map((e, i) => ({ e, step: i + 1 }))
    .filter(({ e, step }) => step <= c.timelineIndex + 1 && e.type !== 'comment' && (!prev || e.at > prev.createdAt))
    .slice(-STEPS_BEFORE_COMMENT);
  if (steps.length) {
    out.push(`**Steps before this (see timeline):** ${steps.map((s) => `#${s.step}`).join(', ')}`, '');
  }

  const logs = dedupeLogs(relatedLogs(session, c));
  if (logs.length) {
    out.push('**Console errors shortly before:**');
    for (const { entry, count } of logs) out.push(`- ${code(entry.message)}${count > 1 ? ` (×${count})` : ''}`);
    out.push('');
  }

  const sessionMeta = session.metadata[originOf(c.url)];
  if (c.metadata && Object.keys(c.metadata).length && JSON.stringify(c.metadata) !== JSON.stringify(sessionMeta)) {
    out.push('<details><summary>App context at this moment</summary>', '', ...renderMetadata(c.metadata), '', '</details>', '');
  }
  return out;
}

export function renderMarkdown(session: FeedbackSession, opts: RenderOptions = {}): string {
  const names = assetFileNames(session);
  const pages = [...new Set(session.timeline.filter((e) => e.type === 'navigate').map((e) => e.url))];
  const end = session.endedAt ?? Date.now();
  const firstComment = session.comments[0];
  const out: string[] = [];

  out.push(`# UI feedback — ${hostOf(firstComment?.url ?? pages[0] ?? '') || 'session'}`, '');
  out.push(
    '> Collected with agent-feedback while clicking through the app. Each numbered item below is one piece of',
    '> feedback. Locate the UI in code via test id / component / selector, use the screenshots for visual context',
    '> (the viewport screenshot has a numbered marker), and check the timeline for how the state was reached.',
    '> Structured data for all items: `feedback.json`.',
    '',
  );

  out.push('## Context', '');
  out.push(`- Recorded: ${formatDateTime(session.startedAt)} – ${formatTime(end)}`);
  if (firstComment) {
    const v = firstComment.viewport;
    out.push(`- Viewport: ${v.width}×${v.height} @${Math.round(v.dpr * 100) / 100}x`);
  }
  out.push(`- Browser: ${session.userAgent}`);
  const mainHost = hostOf(firstComment?.url ?? pages[0] ?? '');
  if (pages.length) {
    out.push(`- Pages visited: ${pages.map((p) => code(hostOf(p) === mainHost ? pathOf(p) : p)).join(', ')}`);
  }
  for (const [origin, meta] of Object.entries(session.metadata)) {
    if (!Object.keys(meta).length) continue;
    out.push(`- App context (${origin}):`, ...renderMetadata(meta, '  '));
  }
  out.push('');

  out.push(`## Feedback (${session.comments.length} item${session.comments.length === 1 ? '' : 's'})`, '');
  if (!session.comments.length) out.push('_No comments recorded._', '');
  for (const c of session.comments) out.push(...renderComment(session, c, names, opts));

  if (session.timeline.length) {
    out.push('## Timeline', '');
    let lastOrigin = '';
    session.timeline.forEach((e, i) => {
      // Events inside iframes don't change the page the user is on
      const origin = 'frame' in e && e.frame ? lastOrigin : hostOf(e.url);
      const originNote = origin && origin !== lastOrigin && lastOrigin ? ` _(now on ${origin})_` : '';
      lastOrigin = origin || lastOrigin;
      out.push(`${i + 1}. ${formatTime(e.at)} ${describeTimelineEvent(e)}${originNote}`);
    });
    out.push('');
  }

  const logs = dedupeLogs(session.logs);
  if (logs.length) {
    out.push('## Console errors & warnings (deduplicated)', '');
    for (const { entry, count } of logs) {
      out.push(`- ${formatTime(entry.at)} **${entry.level}** ${code(entry.message)}${count > 1 ? ` (×${count})` : ''} on ${code(pathOf(entry.url))}`);
    }
    out.push('');
  }
  return out.join('\n');
}

/** JSON export: the session without image data, with screenshot ids replaced by file paths. */
export function renderJson(session: FeedbackSession): string {
  const names = assetFileNames(session);
  const comments = session.comments.map((c) => ({
    ...c,
    screenshots: {
      crop: c.screenshots.crop ? names.get(c.screenshots.crop) : undefined,
      viewport: c.screenshots.viewport ? names.get(c.screenshots.viewport) : undefined,
    },
  }));
  return JSON.stringify({ format: 'agent-feedback/v1', ...session, comments }, null, 2);
}
