'use strict'

/**
 * Cross-process advisory lock (CommonJS mirror of dsh-review/lockfile.js).
 * Same protocol: O_EXCL + pid:mtime body, 50ms retries, stale takeover —
 * both processes MUST agree on it or the shadow store races again.
 */

const fs = require('node:fs')
const path = require('node:path')

const ZERO40 = '0'.repeat(40)

function acquireLock(file, opts) {
  const o = opts || {}
  const timeoutMs = o.timeoutMs != null ? o.timeoutMs : 3000
  const staleMs = o.staleMs != null ? o.staleMs : 5000
  const deadline = Date.now() + timeoutMs
  fs.mkdirSync(path.dirname(file), { recursive: true })
  for (;;) {
    let fd = -1
    try {
      fd = fs.openSync(file, 'wx')
      fs.writeSync(fd, String(process.pid) + ':' + String(Date.now()))
      fs.closeSync(fd)
      fd = -1
      return file
    } catch (e) {
      if (fd >= 0) { try { fs.closeSync(fd) } catch { /* noop */ } }
      if (!e || e.code !== 'EEXIST') throw e
      let takeover = false
      try {
        const buf = Buffer.alloc(64)
        const rfd = fs.openSync(file, 'r')
        let n = 0
        try { n = fs.readSync(rfd, buf, 0, 64, 0) } finally { try { fs.closeSync(rfd) } catch { /* noop */ } }
        const parts = buf.subarray(0, n).toString('utf8').split(':')
        const pid = Number(parts[0]) || -1
        const at = Number(parts[1]) || 0
        const old = Date.now() - at > staleMs || !pidAlive(pid)
        if (old && Date.now() > deadline + staleMs) takeover = true
        else if (old) { try { fs.unlinkSync(file) } catch { /* raced */ } }
      } catch {
        try {
          if (Date.now() - fs.statSync(file).mtimeMs > staleMs) {
            if (Date.now() > deadline + staleMs) takeover = true
            else fs.unlinkSync(file)
          }
        } catch { /* vanished between retries */ }
      }
      if (takeover) {
        try { fs.unlinkSync(file) } catch { /* raced */ }
        return file
      }
      if (Date.now() > deadline) throw new Error('lock timeout: ' + file)
      sleepSync(50)
    }
  }
}

function releaseLock(file) {
  if (!file) return
  try { fs.unlinkSync(file) } catch { /* noop */ }
}

function pidAlive(pid) {
  if (pid <= 0) return false
  try { process.kill(pid, 0); return true } catch (e) { return !!e && e.code === 'EPERM' }
}

function sleepSync(ms) {
  try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms) } catch { /* busy fallback */ }
}

/** update-ref old-value CAS argument; zero OID matches an unborn HEAD. */
function refOldValue(parentHash) {
  return parentHash && /^[0-9a-f]{40}$/.test(parentHash) ? parentHash : ZERO40
}

module.exports = { acquireLock, releaseLock, refOldValue }
