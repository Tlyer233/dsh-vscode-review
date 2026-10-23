'use strict'

/**
 * Shared channel between the CDP module (renderer-side helpers) and the
 * element-context watcher (extension-side flow).
 *
 * dismissPrompt: clicks "Don't Save" on the VS Code modal that appears when
 * we close a dirty (untitled) element-context doc. Returns a result object.
 */
const handlers = { dismissPrompt: null, browserComment: null }

/**
 * 0.1.28: opening a file *from dsh* (clicking a file chip) makes VS Code
 * re-render its chat attachment, which re-opens the "Attached Element Context"
 * doc a moment later — the watcher then pushed a stray `element` chip back into
 * the dsh composer. dsh-browser arms this guard on every dsh-initiated open and
 * the watcher ignores element-doc events while it is live.
 */
let openGuardUntil = 0
function setOpenGuard(ms) {
  openGuardUntil = Date.now() + Math.max(0, Number(ms) || 0)
}
function openGuarded() {
  return Date.now() < openGuardUntil
}

function setDismissPrompt(fn) {
  handlers.dismissPrompt = typeof fn === 'function' ? fn : null
}

/**
 * 0.1.26: browser-comment.js (CDP, page side) produces comment payloads but has
 * no dsh plumbing; element-context-watcher.js owns that (sendRefsToDsh + the
 * element ref shape + focus handling). The watcher registers, the CDP module
 * calls — same one-way bridge pattern as dismissPrompt, no import cycle.
 * @param {(payload: object) => Promise<boolean>|void} fn
 */
function setBrowserCommentHandler(fn) {
  handlers.browserComment = typeof fn === 'function' ? fn : null
}

/** @param {object} payload @returns {Promise<{ok:boolean, why?:string}>} */
async function deliverBrowserComment(payload) {
  if (!handlers.browserComment) return { ok: false, why: 'no-handler (功能未挂载/开关关闭)' }
  try {
    const r = await handlers.browserComment(payload)
    return r === undefined ? { ok: true } : (r || { ok: false, why: 'null-result' })
  } catch (e) {
    return { ok: false, why: String((e && e.message) || e) }
  }
}

module.exports = { setDismissPrompt, dismissPrompt, setBrowserCommentHandler, deliverBrowserComment, setOpenGuard, openGuarded }

async function dismissPrompt() {
  if (!handlers.dismissPrompt) return { ok: false, why: 'no-handler' }
  try {
    return (await handlers.dismissPrompt()) || { ok: false, why: 'null-result' }
  } catch (e) {
    return { ok: false, why: String((e && e.message) || e) }
  }
}
