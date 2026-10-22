import { createServer } from 'node:http'
import { readFile, realpath } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../../.perf/dist/', import.meta.url))
const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.ico': 'image/x-icon' }
export async function servePerf() {
  const base = await realpath(root)
  const server = createServer(async (req, res) => {
    try {
      if (req.headers.host !== '127.0.0.1:5191' || !['GET', 'HEAD'].includes(req.method)) { res.writeHead(403).end(); return }
      const pathname = decodeURIComponent(new URL(req.url, 'http://127.0.0.1:5191').pathname)
      const requested = path.resolve(base, '.' + (pathname === '/' ? '/index.html' : pathname))
      const file = await realpath(requested)
      if (!file.startsWith(base + path.sep)) { res.writeHead(403).end(); return }
      const bytes = await readFile(file)
      res.writeHead(200, { 'Content-Type': mime[path.extname(file)] ?? 'application/octet-stream', 'Cache-Control': 'no-store' })
      res.end(req.method === 'HEAD' ? undefined : bytes)
    } catch { res.writeHead(404).end('Không có file. Hãy chạy npm run perf:build.') }
  })
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(5191, '127.0.0.1', resolve) })
  return server
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await servePerf()
  console.log('Bộ đo: http://127.0.0.1:5191')
}
