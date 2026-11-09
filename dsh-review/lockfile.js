/**
 * Cross-process advisory lock (O_EXCL + stale takeover).
 * The shadow store is written by TWO processes (dsh plugin host + VS Code
 * extension host); each side's in-process promise queue cannot see the other,
 * so HEAD chains and pending JSON need a shared lock.
 *
 * Protocol: create `<name>` with O_EXCL, body = pid + acquire ms. Contended →
 * 50ms retries up to `timeoutMs`. Holder older than `staleMs` (or dead pid) →
 * steal. Timeout → throw so callers log instead of corrupting silently.
 */
import { existsSync, mkdirSync, openSync, readSync, closeSync, unlinkSync, writeSync, statSync } from 'node:fs'
import { dirname } from 'node:path'

const ZERO40 = '0'.repeat(40)

export function acquireLock(path, { timeoutMs = 3000, staleMs = 5000 } = {}) {
  const deadline = Date.now() + timeoutMs
  mkdirSync(dirname(path), { recursive: true })
  for (;;) {
    let fd = -1
    try {
      fd = openSync(path, 'wx')
      writeSync(fd, Buffer.from(process.pid + ':' + Date.now()))
      closeSync(fd)
      fd = -1
      return path
    } catch (e) {
      if (fd >= 0) { try { closeSync(fd) } catch { /* noop */ } }
      if (!e || e.code !== 'EEXIST') throw e
      let takeover = false
      try {
        const buf = Buffer.alloc(64)
        const rfd = openSync(path, 'r')
        let n = 0
        try { n = readSync(rfd, buf, 0, 64, 0) } finally { try { closeSync(rfd) } catch { /* noop */ } }
        const parts = buf.subarray(0, n).toString('utf8').split(':')
        const pid = Number(parts[0]) || -1
        const at = Number(parts[1]) || 0
        const old = Date.now() - at > staleMs || !pidAlive(pid)
        if (old && Date.now() > deadline + staleMs) takeover = true
        else if (old) { try { unlinkSync(path) } catch { /* raced */ } }
      } catch {
        try {
          if (Date.now() - statSync(path).mtimeMs > staleMs) {
            if (Date.now() > deadline + staleMs) takeover = true
            else unlinkSync(path)
          }
        } catch { /* vanished between retries */ }
      }
      if (takeover) {
        try { unlinkSync(path) } catch { /* raced */ }
        return path
      }
      if (Date.now() > deadline) throw new Error('lock timeout: ' + path)
      sleepSync(50)
    }
  }
}

export function releaseLock(path) {
  if (!path) return
  try { unlinkSync(path) } catch { /* noop */ }
}

function pidAlive(pid) {
  if (pid <= 0) return false
  try { process.kill(pid, 0); return true } catch (e) { return !!e && e.code === 'EPERM' }
}

function sleepSync(ms) {
  try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms) } catch { /* busy fallback */ }
}

/** update-ref with old-value CAS; the zero OID compares against an unborn HEAD. */
export function refOldValue(parentHash) {
  return parentHash && /^[0-9a-f]{40}$/.test(parentHash) ? parentHash : ZERO40
}
