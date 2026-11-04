import type { FeedbackSession } from './types';

/** A previous export, read back from disk: the session plus its screenshots by relative path. */
export interface ImportedExport {
  session: FeedbackSession;
  /** e.g. `screenshots/01-crop.png` → PNG data URL */
  assets: Record<string, string>;
}

async function readAsDataUrl(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return `data:${file.type || 'image/png'};base64,${btoa(bin)}`;
}

/** Path inside the picked folder: `nitpick/2026-…/screenshots/01-crop.png` → `screenshots/01-crop.png`. */
function relativeTo(file: File, root: string): string {
  const path = file.webkitRelativePath || file.name;
  return root && path.startsWith(root) ? path.slice(root.length) : path;
}

/**
 * Reads an export folder (as picked with `<input webkitdirectory>`). Picking a parent folder works
 * too as long as it holds exactly one export.
 */
export async function readExportFolder(files: File[]): Promise<ImportedExport> {
  const jsons = files.filter((f) => f.name === 'feedback.json');
  if (!jsons.length) throw new Error('Keine feedback.json im gewählten Ordner');
  if (jsons.length > 1) throw new Error('Mehrere Exporte im Ordner – bitte genau einen Export-Ordner wählen');
  const json = jsons[0]!;
  const root = (json.webkitRelativePath || json.name).slice(0, -'feedback.json'.length);

  let data: unknown;
  try {
    data = JSON.parse(await json.text());
  } catch {
    throw new Error('feedback.json ist kein gültiges JSON');
  }
  const session = parseSession(data);

  const wanted = new Set<string>();
  for (const c of session.comments) for (const p of Object.values(c.screenshots)) if (p) wanted.add(p);
  // Without folder paths (single files picked or dropped) the file name has to do.
  const byName = new Map([...wanted].map((p) => [p.split('/').pop()!, p]));
  const assets: Record<string, string> = {};
  for (const f of files) {
    const rel = f.webkitRelativePath ? relativeTo(f, root) : byName.get(f.name);
    if (rel && wanted.has(rel)) assets[rel] = await readAsDataUrl(f);
  }
  return { session, assets };
}

/** Checks the `nitpick/v1` shape just enough that the toolbar can work with it. */
export function parseSession(data: unknown): FeedbackSession {
  const d = data as Partial<FeedbackSession> & { format?: unknown };
  if (!d || typeof d !== 'object' || d.format !== 'nitpick/v1') {
    throw new Error('Kein Nitpick-Export (format nitpick/v1 erwartet)');
  }
  if (!Array.isArray(d.comments) || !Array.isArray(d.timeline) || typeof d.startedAt !== 'number') {
    throw new Error('feedback.json ist unvollständig');
  }
  const { format: _format, ...session } = d;
  return {
    ...session,
    comments: d.comments.map((c) => ({ ...c, screenshots: c.screenshots ?? {} })),
    logs: Array.isArray(d.logs) ? d.logs : [],
    metadata: d.metadata && typeof d.metadata === 'object' ? d.metadata : {},
  } as FeedbackSession;
}
