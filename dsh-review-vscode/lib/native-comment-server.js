'use strict'

/**
 * 0.1.34: receives element comments from VS Code's OWN browser comment UI.
 *
 * The native comment box lives in a renderer CDP cannot see (measured: no target and
 * no DOM anywhere holds the text), so a tiny patch inside VS Code's bundle files
 * (tools/patch_comment_hook.py) POSTs each comment to this fixed-port listener. The
 * payload is then handed to the same pipeline our own annotation box uses: markdown
 * file + one file chip in the dsh composer.
 *
 * The port is a constant because the workbench patch is static text: it cannot read
 * our settings.
 */
const http = require('node:http')
const bridge = require('./element-bridge')

const PORT = 43167
const TAG = '[native-comment]'
const MAX_BODY = 64 * 1024

module.exports = function startNativeCommentServer (deps) {
  const log = deps && deps.log ? deps.log : { appendLine: () => {} }
  let server = null
  const seen = new Map() // dedupe: fetch + Image() both fire, and VS Code may double-insert

  function dedupeKey (q) {
    return String(q.elementId || '') + '|' + String(q.name || '') + '|' + String(q.comment || '')
  }

  async function handle (req, res) {
    const url = new URL(req.url, 'http://127.0.0.1')
    if (url.pathname !== '/dsh-comment') {
      res.writeHead(404)
      res.end('nope')
      return
    }
    const q = url.searchParams.get('d') || '{}'
    let data
    try { data = JSON.parse(q) } catch (e) { data = null }
    res.writeHead(204, { 'access-control-allow-origin': '*' })
    res.end()
    if (!data || !data.comment) {
      log.appendLine(TAG + ' ping/no-comment ignored: ' + q.slice(0, 120))
      return
    }
    const key = dedupeKey(data)
    const now = Date.now()
    const last = seen.get(key)
    if (last && now - last < 4000) {
      log.appendLine(TAG + ' duplicate ignored (within 4s): ' + String(data.comment).slice(0, 60))
      return
    }
    seen.set(key, now)
    while (seen.size > 60) seen.delete(seen.keys().next().value)

    // Feed the existing comment pipeline; the native UI already drew its own pin, so
    // our page script must not add a second one (it only pins its own submits anyway).
    const payload = {
      ev: 'comment',
      native: true,
      text: String(data.comment || ''),
      label: String(data.name || 'element') + (data.elementId ? ' #' + String(data.elementId) : ''),
      url: String(data.url || ''),
      title: '',
      size: '',
      locate: 'native',
      tag: 'element',
      id: String(data.elementId || ''),
      classes: [],
      attributes: {},
      ancestors: [],
      selector: '',
      innerText: '',
      outerHTML: '',
      bounds: { x: 0, y: 0, width: 0, height: 0 },
    }
    const r = await bridge.deliverBrowserComment(payload)
    const ok = r === true || !!(r && r.ok)
    log.appendLine(TAG + ' native comment -> dsh ok=' + ok + (r && r.why ? ' why=' + r.why : '') +
      ' label=' + payload.label + ' chars=' + payload.text.length)
  }

  function start () {
    try {
      server = http.createServer((req, res) => {
        // Content is in the query string, but drain any body so keep-alive is happy.
        req.resume()
        void handle(req, res)
      })
      server.on('error', (e) => {
        log.appendLine(TAG + ' listen failed on ' + PORT + ': ' + String((e && e.message) || e) +
          ' — 端口被占，改 tools/patch_comment_hook.py 的 PORT 后重打补丁')
        server = null
      })
      server.listen(PORT, '127.0.0.1', () => {
        log.appendLine(TAG + ' listening on http://127.0.0.1:' + PORT + '/dsh-comment')
      })
    } catch (e) {
      log.appendLine(TAG + ' start failed: ' + String((e && e.message) || e))
    }
  }

  start()
  return {
    port: PORT,
    dispose () { if (server) { server.close(); server = null } },
  }
}
