#!/usr/bin/env node
'use strict'
// Stand-in for the dsh server + dsh-review plugin routes (HOOK CONTRACT).
// Implements exactly the three contract routes with a fake ticking job.
// Usage: node mock_server.js --port=3988
const http = require('node:http')

const args = Object.fromEntries(
  process.argv.slice(2).map((s) => {
    const i = s.indexOf('=')
    return [s.slice(2, i), s.slice(i + 1)]
  }),
)
const PORT = Number(args.port) || 3988

const JOB = {
  id: 'bash-1',
  kind: 'bash',
  label: 'tick loop',
  status: 'running',
  ownerSession: 'sess-mock',
  cwd: '/mock/ws',
  startedAt: Date.now(),
}

let killed = false
const sseClients = new Set()

function sseSend(client, event, data) {
  client.write('event: ' + event + '\n')
  client.write('data: ' + JSON.stringify(data) + '\n\n')
}

let tick = 0
const timer = setInterval(() => {
  if (killed) return
  tick += 1
  for (const c of sseClients) {
    try { sseSend(c, 'output', { id: JOB.id, text: 'tick-' + tick + '\n' }) } catch { /* noop */ }
  }
}, 200)

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1')
  // GET /dsh-review/jobs
  if (req.method === 'GET' && url.pathname === '/dsh-review/jobs') {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify([{ ...JOB, status: killed ? 'killed' : 'running' }]))
    return
  }
  // GET /dsh-review/events (SSE)
  if (req.method === 'GET' && url.pathname === '/dsh-review/events') {
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    })
    res.write(': connected\n\n')
    sseSend(res, 'job', { ...JOB, status: killed ? 'killed' : 'running' })
    sseClients.add(res)
    req.on('close', () => sseClients.delete(res))
    return
  }
  // POST /dsh-review/jobs/:id/kill
  if (req.method === 'POST' && /\/dsh-review\/jobs\/[^/]+\/kill$/.test(url.pathname)) {
    const id = url.pathname.split('/')[3]
    if (id !== JOB.id) {
      res.writeHead(404, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: false, error: 'unknown job' }))
      return
    }
    killed = true
    for (const c of sseClients) {
      try { sseSend(c, 'job', { ...JOB, status: 'killed', finishedAt: Date.now() }) } catch { /* noop */ }
    }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: true, result: 'requested' }))
    return
  }
  res.writeHead(404, { 'content-type': 'text/plain' })
  res.end('not found')
})

server.listen(PORT, '127.0.0.1', () => {
  console.log('mock server listening on 127.0.0.1:' + PORT)
})
