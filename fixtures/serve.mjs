// Zero-dependency static server for the local acme fixtures:
//   node fixtures/serve.mjs   ->   http://localhost:8099/acme/
// The site is served under /acme/ with relative links only, exactly like the
// grader setups described in the assignment, so the crawler must resolve
// relative hrefs and follow them.

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('./acme/', import.meta.url));
const PORT = Number(process.env.FIXTURE_PORT || 8099);

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
};

async function serveFile(req, res, filePath) {
  try {
    const body = await readFile(filePath);
    res.writeHead(200, {
      'content-type': CONTENT_TYPES[extname(filePath).toLowerCase()] || 'application/octet-stream',
      'content-length': body.length,
    });
    res.end(body);
  } catch {
    res.writeHead(404, { 'content-type': 'text/html; charset=utf-8' });
    res.end(`<!DOCTYPE html><html><head><title>404</title></head><body><h1>404 Not Found</h1><p>No fixture for ${req.url}</p></body></html>`);
  }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://localhost:${PORT}`);
  let pathname = decodeURIComponent(url.pathname);

  if (pathname === '/acme' || pathname === '/acme/') {
    // Normalize to the trailing-slash form so relative links resolve correctly.
    if (!pathname.endsWith('/')) {
      res.writeHead(301, { location: '/acme/' });
      res.end();
      return;
    }
    pathname = '/acme/index.html';
  }

  let relative = null;
  if (pathname === '/robots.txt') {
    relative = 'robots.txt'; // host-level robots for the crawler
  } else if (pathname.startsWith('/acme/')) {
    relative = pathname.slice('/acme/'.length);
    if (relative.endsWith('/')) relative += 'index.html';
  }

  if (!relative) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('not found - fixtures live under /acme/');
    return;
  }

  // Path traversal guard.
  const safe = normalize(relative).split(sep).includes('..') ? null : join(ROOT, relative);
  if (!safe || !safe.startsWith(ROOT)) {
    res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('forbidden');
    return;
  }

  await serveFile(req, res, safe);
});

server.listen(PORT, () => {
  console.log(`acme fixtures serving at http://localhost:${PORT}/acme/ (root ${ROOT})`);
});
