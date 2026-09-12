'use strict'

/**
 * Shared channel between the CDP module (renderer-side helpers) and the
 * element-context watcher (extension-side flow).
 *
 * dismissPrompt: clicks "Don't Save" on the VS Code modal that appears when
 * we close a dirty (untitled) element-context doc. Returns a result object.
 */
const handlers = { dismissPrompt: null }

function setDismissPrompt(fn) {
  handlers.dismissPrompt = typeof fn === 'function' ? fn : null
}

async function dismissPrompt() {
  if (!handlers.dismissPrompt) return { ok: false, why: 'no-handler' }
  try {
    return (await handlers.dismissPrompt()) || { ok: false, why: 'null-result' }
  } catch (e) {
    return { ok: false, why: String((e && e.message) || e) }
  }
}

module.exports = { setDismissPrompt, dismissPrompt }
