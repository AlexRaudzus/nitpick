import { domToPng } from 'modern-screenshot';

export type ScreenshotMode = 'auto' | 'tab' | 'dom';

/**
 * Screenshot source for the embed.
 *  - tab: `getDisplayMedia({ preferCurrentTab })` – pixel-exact, needs one permission prompt per page load
 *    (has to be requested from a click). The stream stays open for the whole session.
 *  - dom: re-renders the DOM into an image (modern-screenshot). No prompt, but cross-origin images,
 *    canvas/video content and some CSS may be missing.
 * `auto` asks for the tab once and falls back to dom if declined or unavailable.
 */
export function createScreenshotSource(mode: ScreenshotMode, isOwnUi: (node: Node) => boolean) {
  let stream: MediaStream | null = null;
  let video: HTMLVideoElement | null = null;

  const live = () => !!stream?.getVideoTracks().some((t) => t.readyState === 'live');

  async function grabFrame(): Promise<string> {
    const v = video!;
    // The frame currently in the video element can predate hiding the toolbar; wait for fresh ones.
    for (let i = 0; i < 2; i++) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 250); // static pages may not produce new frames
        v.requestVideoFrameCallback(() => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
    const canvas = document.createElement('canvas');
    canvas.width = v.videoWidth;
    canvas.height = v.videoHeight;
    canvas.getContext('2d')!.drawImage(v, 0, 0);
    return canvas.toDataURL('image/png');
  }

  function domCapture(): Promise<string> {
    return domToPng(document.documentElement, {
      width: window.innerWidth,
      height: window.innerHeight,
      scale: window.devicePixelRatio,
      backgroundColor: getComputedStyle(document.body).backgroundColor || '#fff',
      filter: (node) => !isOwnUi(node),
      timeout: 3000,
    });
  }

  return {
    get usesTab() {
      return live();
    },

    /** Ask for tab capture. Must be called while handling a user click. Returns whether it is active. */
    async requestTab(): Promise<boolean> {
      if (mode === 'dom' || live()) return live();
      if (!navigator.mediaDevices?.getDisplayMedia) return false;
      try {
        stream = await navigator.mediaDevices.getDisplayMedia({
          video: { displaySurface: 'browser', frameRate: 5 },
          audio: false,
          preferCurrentTab: true,
          selfBrowserSurface: 'include',
          surfaceSwitching: 'exclude',
        } as DisplayMediaStreamOptions);
        video = document.createElement('video');
        video.muted = true;
        video.playsInline = true;
        video.srcObject = stream;
        await video.play();
        return true;
      } catch {
        stream = null;
        return false;
      }
    },

    async capture(): Promise<string> {
      if (live() && video) return grabFrame();
      if (mode === 'tab') throw new Error('Tab-Freigabe nicht aktiv');
      return domCapture();
    },

    stop() {
      stream?.getTracks().forEach((t) => t.stop());
      stream = null;
      video = null;
    },
  };
}
