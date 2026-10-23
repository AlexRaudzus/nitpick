import type { Rect } from '../types';

const ACCENT = '#ff3b6b';
const CROP_PADDING = 48;

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
}

/** Wait until the browser has actually presented a frame without our UI. */
export const nextPaint = () =>
  new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r, 60))));

/**
 * Take a viewport screenshot with our own UI hidden, then produce
 *  - viewport: full screenshot with a numbered marker around `rect`
 *  - crop: close-up of `rect` with some surrounding context
 */
export async function captureScreenshots(
  captureViewport: () => Promise<string>,
  uiRoot: HTMLElement,
  rect: Rect | undefined,
  marker: number,
): Promise<{ viewport: string; crop?: string }> {
  // Hide our container inside the shadow root; styles on the host itself are overridden by
  // the `:host { all: initial !important }` reset.
  const previous = uiRoot.style.display;
  uiRoot.style.display = 'none';
  await nextPaint();
  let raw: string;
  try {
    raw = await captureViewport();
  } finally {
    uiRoot.style.display = previous;
  }

  const img = await loadImage(raw);
  // The screenshot is in device pixels; DOM rects are CSS pixels.
  const scale = img.naturalWidth / window.innerWidth;

  const full = document.createElement('canvas');
  full.width = img.naturalWidth;
  full.height = img.naturalHeight;
  const ctx = full.getContext('2d')!;
  ctx.drawImage(img, 0, 0);

  let crop: string | undefined;
  if (rect && rect.width > 0 && rect.height > 0) {
    const sx = Math.max(0, (rect.x - CROP_PADDING) * scale);
    const sy = Math.max(0, (rect.y - CROP_PADDING) * scale);
    const sw = Math.min(img.naturalWidth - sx, (rect.width + CROP_PADDING * 2) * scale);
    const sh = Math.min(img.naturalHeight - sy, (rect.height + CROP_PADDING * 2) * scale);
    if (sw > 0 && sh > 0) {
      const c = document.createElement('canvas');
      c.width = Math.round(sw);
      c.height = Math.round(sh);
      const cctx = c.getContext('2d')!;
      cctx.drawImage(img, sx, sy, sw, sh, 0, 0, sw, sh);
      drawOutline(cctx, (rect.x * scale) - sx, (rect.y * scale) - sy, rect.width * scale, rect.height * scale, scale);
      crop = c.toDataURL('image/png');
    }
    drawOutline(ctx, rect.x * scale, rect.y * scale, rect.width * scale, rect.height * scale, scale);
    drawBadge(ctx, rect.x * scale, rect.y * scale, marker, scale);
  }

  return { viewport: full.toDataURL('image/png'), crop };
}

function drawOutline(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, scale: number) {
  ctx.save();
  ctx.strokeStyle = ACCENT;
  ctx.lineWidth = 3 * scale;
  ctx.setLineDash([]);
  ctx.strokeRect(x, y, w, h);
  ctx.restore();
}

function drawBadge(ctx: CanvasRenderingContext2D, x: number, y: number, n: number, scale: number) {
  const r = 13 * scale;
  const cx = Math.max(r, x);
  const cy = Math.max(r, y);
  ctx.save();
  ctx.fillStyle = ACCENT;
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#fff';
  ctx.font = `bold ${14 * scale}px system-ui, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(String(n), cx, cy + scale);
  ctx.restore();
}
