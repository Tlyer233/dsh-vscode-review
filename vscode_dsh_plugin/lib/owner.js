'use strict'

/**
 * dsh-review-vscode — activity-aware dsh-host ownership gate.
 *
 * Two VS Code instances both watch the same review store. When dsh writes a
 * new change manifest, both instances see it and both try to auto-open the
 * file. This module makes auto-open deterministic AND follows the window the
 * user is actually using:
 *
 *   candidate = this window has a dsh sidebar WebviewView that is currently
 *               visible (or was visible / said dshBridgeHello very recently)
 *   owner     = candidate that currently holds `dsh-owner.lock` in the store
 *
 * The webview reports real user activity (pointer/keyboard/focus) through
 * `markDshActive`. If a different window holds the lease but has been idle,
 * the freshly-active window takes the lease over, so a dsh edit auto-opens
 * in the window where the user is actually talking to dsh — not the other
 * instance.
 *
 * Lease fields: { id, pid, at, lastActivity }. `at` is refreshed by the
 * holder heartbeat; `lastActivity` is the holder's last REAL dsh activity and
 * only changes when the user interacts with the dsh UI.
 */

const fs = require('node:fs')
const path = require('node:path')
const { state, log } = require('./runtime.js')

const LEASE_NAME = 'dsh-owner.lock'
const HEARTBEAT_MS = 5000
const EXPIRE_MS = 15000
const HIDDEN_GRACE_MS = 30000
const ACTIVITY_FRESH_MS = 6000
const TAKEOVER_LEAD_MS = 3000

let leaseTimer = null

function leasePath(storeDir) {
  return path.join(storeDir, LEASE_NAME)
}

function readLeaseRaw(storeDir) {
  try {
    return JSON.parse(fs.readFileSync(leasePath(storeDir), 'utf8'))
  } catch { return null }
}

function readValidLease(storeDir) {
  const l = readLeaseRaw(storeDir)
  if (!l || typeof l.id !== 'string' || typeof l.at !== 'number') return null
  if (Date.now() - l.at > EXPIRE_MS) return null
  return l
}

function leasePayload(id, lastActivity) {
  const at = Date.now()
  return {
    id,
    pid: process.pid,
    at,
    lastActivity: Number.isFinite(lastActivity) && lastActivity > 0 ? lastActivity : at,
  }
}

function writeLease(storeDir, id, lastActivity) {
  const p = leasePath(storeDir)
  const tmp = p + '.' + process.pid + '.tmp'
  try {
    fs.writeFileSync(tmp, JSON.stringify(leasePayload(id, lastActivity)))
    fs.renameSync(tmp, p)
  } catch (e) {
    try { fs.unlinkSync(tmp) } catch { /* noop */ }
    throw e
  }
}

function tryCreateLease(storeDir, id) {
  try {
    fs.writeFileSync(leasePath(storeDir), JSON.stringify(leasePayload(id, Date.now())), { flag: 'wx' })
    return true
  } catch (e) {
    if (!e || e.code !== 'EEXIST') log('dsh owner lease create failed:', e && e.message || e)
    return false
  }
}

function isCandidate() {
  if (!state.dshView) return false
  if (state.dshVisible) return true
  // The sidebar may be temporarily hidden (e.g. user switched to another
  // view in the same container). Keep this window a candidate for a short
  // grace period after the last activity so dsh writes still auto-open here.
  return Date.now() - state.dshOwnerAt < HIDDEN_GRACE_MS
}

function claimLease(storeDir) {
  if (!isCandidate()) return false
  const id = state.instanceId
  const myAt = state.dshOwnerAt || 0
  const cur = readValidLease(storeDir)
  if (cur) {
    if (cur.id === id) {
      try { writeLease(storeDir, id, myAt) } catch (e) { log('dsh owner lease refresh failed:', e && e.message || e) }
      return true
    }
    // Activity-based takeover: we were just touched by the user and the
    // current holder has been idle for a meaningful while. This is what
    // makes ownership follow the window the user is actually using.
    const theirAt = Number.isFinite(cur.lastActivity) ? cur.lastActivity : (Number(cur.at) || 0)
    const now = Date.now()
    if (myAt > 0 && now - myAt < ACTIVITY_FRESH_MS && myAt - theirAt >= TAKEOVER_LEAD_MS) {
      try {
        writeLease(storeDir, id, myAt)
        log('dsh owner takeover [' + id + '] from [' + cur.id + '] myAt=' + myAt + ' theirAt=' + theirAt)
        return true
      } catch (e) {
        log('dsh owner takeover failed:', e && e.message || e)
        return false
      }
    }
    return false
  }

  // No live owner. Claim atomically with `wx`; if the file already exists but
  // is expired/corrupt, clear it and try once more. Never delete a VALID
  // lease owned by another window.
  if (tryCreateLease(storeDir, id)) return true
  const existing = readLeaseRaw(storeDir)
  if (existing && !readValidLease(storeDir)) {
    try { fs.unlinkSync(leasePath(storeDir)) } catch { /* noop */ }
    return tryCreateLease(storeDir, id)
  }
  return readValidLease(storeDir)?.id === id
}

/** Record real dsh UI activity in THIS window and try to own the lease. */
function markDshActive(storeDir) {
  state.dshOwnerAt = Date.now()
  if (!isCandidate()) return false
  try { return claimLease(storeDir) } catch (e) { log('dsh mark active failed:', e && e.message || e); return false }
}

/** True when this window should auto-open a file for a new dsh change. */
function isDshOwnerWindow(storeDir) {
  return claimLease(storeDir)
}

function startOwnerHeartbeat(storeDir) {
  if (leaseTimer) return
  leaseTimer = setInterval(() => {
    try { claimLease(storeDir) } catch (e) { log('dsh owner heartbeat failed:', e && e.message || e) }
  }, HEARTBEAT_MS)
}

function stopOwnerHeartbeat() {
  if (leaseTimer) { clearInterval(leaseTimer); leaseTimer = null }
}

module.exports = { isDshOwnerWindow, markDshActive, startOwnerHeartbeat, stopOwnerHeartbeat, LEASE_NAME }
