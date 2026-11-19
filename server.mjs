import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('.', import.meta.url)).replace(/[\\/]+$/, '');
const host = '127.0.0.1';
const port = Number(process.env.PORT || 8173);
let sessionData = { tracks: [] };

const types = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.wav': 'audio/wav',
};

function sendJson(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
}

async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 256 * 1024 * 1024) throw new Error('Session data is too large');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

const server = createServer(async (req, res) => {
  try {
    const requestPath = decodeURIComponent(new URL(req.url, `http://${host}`).pathname);
    if (requestPath === '/api/session') {
      if (req.method === 'GET') {
        sendJson(res, 200, sessionData);
        return;
      }
      if (req.method === 'POST') {
        sessionData = await readJson(req);
        sendJson(res, 200, { ok: true });
        return;
      }
      sendJson(res, 405, { error: 'Method not allowed' });
      return;
    }
    const relativePath = requestPath === '/' ? '/index.html' : requestPath;
    const filePath = normalize(join(root, relativePath));
    if (!filePath.startsWith(root + sep) && filePath !== root) {
      res.writeHead(403);
      res.end('Forbidden');
      return;
    }

    const body = await readFile(filePath);
    res.writeHead(200, { 'Content-Type': types[extname(filePath).toLowerCase()] || 'application/octet-stream' });
    res.end(body);
  } catch (error) {
    const status = error.code === 'ENOENT' ? 404 : 500;
    res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(status === 404 ? 'Not found' : 'Server error');
  }
});

server.listen(port, host, () => {
  console.log(`Pitch Scope is running at http://${host}:${port}`);
});
