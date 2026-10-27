// Dev server for the in-app variant: the test page plus a "Feedback aufnehmen" button that loads
// embed/index.ts through Vite (HMR). Simulates an app's feedback modal on hand-over.
// Usage: pnpm dev:embed → http://localhost:5180/settings
import { createServer } from 'vite';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const port = Number(process.env.PORT ?? 5180);

const shell = `
<button id="af-record" style="position:fixed;left:16px;bottom:16px;z-index:10;padding:8px 14px">Feedback aufnehmen</button>
<dialog id="af-modal" style="width:min(720px,90vw)">
  <h2>Feedback-Modal (Demo)</h2>
  <div id="af-images" style="display:flex;gap:8px;flex-wrap:wrap"></div>
  <pre id="af-md" style="max-height:40vh;overflow:auto;white-space:pre-wrap;font-size:12px"></pre>
  <button id="af-cancel">Abbrechen</button>
  <button id="af-submit">Ticket erstellen</button>
</dialog>
<script type="module">
  import { hasPendingSession, loadRecorder } from '/embed/loader.ts';
  let recorder;
  const get = async () => {
    if (recorder) return recorder;
    const { createFeedbackRecorder } = await loadRecorder();
    recorder = createFeedbackRecorder({
      screenshots: new URLSearchParams(location.search).get('shots') ?? 'auto',
      context: () => ({ shell: 'embed-dev', tenant: 'acme' }),
      completeLabel: 'Übernehmen',
      onComplete(result) {
        window.__lastResult = result;
        const urls = Object.fromEntries(result.files.map((f) => [f.name, URL.createObjectURL(f)]));
        document.getElementById('af-md').textContent = result.renderMarkdown({ assetUrl: (p) => urls[p] && 'blob:' + p });
        document.getElementById('af-images').replaceChildren(
          ...result.files.filter((f) => f.type === 'image/png').map((f) => Object.assign(document.createElement('img'), { src: urls[f.name], title: f.name, style: 'height:90px;border:1px solid #ccc' })),
        );
        document.getElementById('af-modal').showModal();
      },
    });
    window.__recorder = recorder;
    return recorder;
  };
  document.getElementById('af-record').onclick = async () => (await get()).start();
  document.getElementById('af-cancel').onclick = async () => { document.getElementById('af-modal').close(); (await get()).restore(); };
  document.getElementById('af-submit').onclick = async () => { document.getElementById('af-modal').close(); (await get()).clear(); };
  if (hasPendingSession()) get().then((r) => r.restore());
</script>`;

export async function startEmbedDevServer(listenPort = port) {
  const server = await createServer({
    root,
    configFile: false,
    resolve: { alias: { '@': root } },
    server: { port: listenPort, strictPort: true },
    logLevel: 'warn',
    plugins: [
      {
        name: 'embed-test-page',
        configureServer(s) {
          s.middlewares.use(async (req, res, next) => {
            const path = (req.url ?? '/').split('?')[0];
            if (path.includes('.') || path.startsWith('/@') || path.startsWith('/node_modules')) return next();
            const page = readFileSync(new URL('./test-page.html', import.meta.url), 'utf8').replace('</body>', `${shell}</body>`);
            res.setHeader('content-type', 'text/html; charset=utf-8');
            res.end(await s.transformIndexHtml(req.url ?? '/', page));
          });
        },
      },
    ],
  });
  await server.listen();
  return server;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await startEmbedDevServer();
  console.log(`Embed test page on http://localhost:${port}/settings`);
}
