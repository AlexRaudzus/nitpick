// Serves dev/test-page.html for every path (SPA-style) — used for manual and e2e testing.
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';

const port = Number(process.env.PORT ?? 5179);
const html = () => readFileSync(new URL('./test-page.html', import.meta.url));
export const server = createServer((_req, res) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(html());
});
if (import.meta.url === `file://${process.argv[1]}`) {
  server.listen(port, () => console.log(`Test page on http://localhost:${port}/settings`));
}
