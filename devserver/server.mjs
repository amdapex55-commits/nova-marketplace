/* LOCAL DEVELOPMENT ONLY — never deployed.
 *
 * Serves exactly what Cloudflare will serve — ./public and nothing else — so a
 * path that works here cannot 404 in production, and a file that is private in
 * production cannot be reachable here.
 *
 *   node devserver/server.mjs   →   http://localhost:54330
 */
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';

const PORT = Number(process.env.PORT || 54330);
const ROOT = path.resolve(import.meta.dirname, '..', 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.webp': 'image/webp',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.ico': 'image/x-icon'
};

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  let file = path.join(ROOT, decodeURIComponent(url.pathname));

  // Nothing outside ./public, ever.
  if (!file.startsWith(ROOT)) { res.writeHead(403).end('forbidden'); return; }

  try {
    if ((await fs.stat(file)).isDirectory()) file = path.join(file, 'index.html');
  } catch {
    // Unknown path → index.html, matching Cloudflare's single-page-application
    // not_found_handling. Hash routes never reach the server, but a deep link
    // typed by hand should still load the app.
    file = path.join(ROOT, 'index.html');
  }

  try {
    const body = await fs.readFile(file);
    res.writeHead(200, {
      'content-type': MIME[path.extname(file)] || 'application/octet-stream',
      'cache-control': 'no-store'
    }).end(body);
  } catch {
    res.writeHead(404).end('not found');
  }
}).listen(PORT, () => console.log(`nova marketplace → http://localhost:${PORT}`));
