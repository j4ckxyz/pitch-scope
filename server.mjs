import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('.', import.meta.url)).replace(/[\\/]+$/, '');
const host = '127.0.0.1';
const port = Number(process.env.PORT || 8173);

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

const server = createServer(async (req, res) => {
  try {
    const requestPath = decodeURIComponent(new URL(req.url, `http://${host}`).pathname);
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
