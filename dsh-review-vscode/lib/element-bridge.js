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

/**
 * 0.1.36: one place to turn whatever the VS Code bundle hook reports (HTTP beacon or
 * a CDP read of globalThis.__dshNativeComments — the workbench CSP blocks fetch/img,
 * measured: no request ever landed) into the comment shape our md pipeline expects.
 * The nid is a hash of url+name+elementId+text so a duplicate arrival (both channels,
 * or fetch+Image double fire) updates the same file instead of adding another chip.
 */
function nativeCommentPayload(q) {
  q = q || {}
  const url = String(q.url || '')
  const name = String(q.name || 'element')
  const text = String(q.comment || '')
  const elementId = String(q.elementId || '')
  const key = url + '|' + name + '|' + elementId + '|' + text
  let h = 0
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) | 0
  return {
    ev: 'comment', native: true, nid: 'n' + (h >>> 0).toString(36),
    text: text, label: name + (elementId ? ' #' + elementId : ''), url: url,
    title: '', size: '', locate: 'native', tag: 'element', id: elementId,
    classes: [], attributes: {}, ancestors: [], selector: '', innerText: '', outerHTML: '',
    bounds: { x: 0, y: 0, width: 0, height: 0 },
  }
}

/**
 * 0.1.48: the browser-comment module knows which http(s) pages it has CDP attached to;
 * the watcher needs a page URL for native comments (it no longer opens the element doc,
 * which used to be the only source). One provider, no import cycle.
 */
let pageUrlProvider = null
function setPageUrlProvider(fn) {
  pageUrlProvider = typeof fn === 'function' ? fn : null
}
function browserPageUrl() {
  try { return pageUrlProvider ? String(pageUrlProvider() || '') : '' } catch { return '' }
}

/**
 * 0.1.49: the watcher needs the element behind a native "@span#x" reference, and only
 * browser-comment.js holds CDP connections to the page. One provider, same one-way bridge
 * pattern (no import cycle): the module registers probeElement(url, query), the watcher
 * calls it and merges the answer into the markdown.
 */
let elementProbe = null
function setElementProbe(fn) {
  elementProbe = typeof fn === 'function' ? fn : null
}
async function probeElement(url, query) {
  if (!elementProbe) return null
  try { return await elementProbe(url, query) } catch { return null }
}

/**
 * 0.1.57: the dsh client tells us when the user deletes one of the chips we inserted
 * (it watches its own composer). We reply by removing the matching line from the Copilot
 * composer, which makes VS Code drop the page pin. The handler lives in the watcher, which
 * owns that document; here we only route.
 */
let referenceDroppedHandler = null
function setReferenceDroppedHandler(fn) {
  referenceDroppedHandler = typeof fn === 'function' ? fn : null
}
function referenceDropped(payload) {
  if (!referenceDroppedHandler) return false
  try { return !!referenceDroppedHandler(payload) } catch { return false }
}

/* 0.1.75: the page pin survey. browser-comment owns the CDP connections; the watcher asks
 * for "what does the page actually contain right now" after each annotation so the log shows
 * whether VS Code's pin lives in this page or in the unreachable agent host. */
let pageStateProbe = null
function setPageStateProbe(fn) {
  pageStateProbe = typeof fn === 'function' ? fn : null
}
async function pageState(url) {
  if (!pageStateProbe) return null
  try { return await pageStateProbe(url) } catch { return null }
}

/* 0.1.84: pin census taken through the CDP DOM agent (it pierces the closed shadow root that
 * holds VS Code's element-comment pins). */
let pinsProbe = null
function setPagePinsProbe(fn) {
  pinsProbe = typeof fn === 'function' ? fn : null
}
async function pagePins(url) {
  if (!pinsProbe) return null
  try { return await pinsProbe(url) } catch { return null }
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
    if (r === undefined) return { ok: true }
    if (r === false) return { ok: false, why: 'handler refused（见 [element-context] 日志）' }
    return r || { ok: false, why: 'null-result' }
  } catch (e) {
    return { ok: false, why: String((e && e.message) || e) }
  }
}

module.exports = { nativeCommentPayload, setPageStateProbe, pageState, setPagePinsProbe, pagePins, setReferenceDroppedHandler, referenceDropped, setElementProbe, probeElement, setPageUrlProvider, browserPageUrl, setDismissPrompt, dismissPrompt, setBrowserCommentHandler, deliverBrowserComment, setOpenGuard, openGuarded }

async function dismissPrompt() {
  if (!handlers.dismissPrompt) return { ok: false, why: 'no-handler' }
  try {
    return (await handlers.dismissPrompt()) || { ok: false, why: 'null-result' }
  } catch (e) {
    return { ok: false, why: String((e && e.message) || e) }
  }
}
