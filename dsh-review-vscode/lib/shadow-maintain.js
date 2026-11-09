'use strict'

/**
 * Extension-side mirror of dsh-review/maintain.js triggers: check the
 * .last-maintain marker, then spawn the plugin host's maintain.js detached
 * (one implementation, two triggers — the script itself is environment-
 * guarded against re-entry via DSH_SHADOW_MAINTAIN).
 */

const fs = require('node:fs')
const path = require('node:path')
const { spawn } = require('node:child_process')
const { shadowRoot, dshHome } = require('./workbench.js')

const MAINTAIN_INTERVAL_MS = 7 * 24 * 3600 * 1000

function findMaintainScript() {
  // Single implementation lives in the dsh plugin package (ESM); the profile
  // install path is where `dsh plugin add` actually lands it (verified:
  // ~/.dsh/profiles/web/node_modules/dsh-review/maintain.js).
  const guesses = [
    path.join(dshHome(), 'profiles', 'web', 'node_modules', 'dsh-review', 'maintain.js'),
    path.join(__dirname, '..', '..', 'dsh-review', 'maintain.js'), // repo/dev layout
    path.join(__dirname, '..', 'dsh-review', 'maintain.js'),
  ]
  for (const g of guesses) {
    try { if (fs.statSync(g).isFile()) return g } catch { /* next */ }
  }
  return null
}

/**
 * Best-effort detached maintenance kick. Never throws, never blocks.
 */
function maybeStartMaintain() {
  if (process.env.DSH_SHADOW_MAINTAIN === '1') return
  try {
    const marker = path.join(shadowRoot(), '.last-maintain')
    try {
      if (Date.now() - fs.statSync(marker).mtimeMs < MAINTAIN_INTERVAL_MS) return
    } catch { /* missing marker → run */ }
    const script = findMaintainScript()
    if (!script) return
    try { fs.writeFileSync(marker, '', { flag: 'a' }) } catch { /* best effort */ }
    const child = spawn(process.execPath, [script], {
      detached: true,
      stdio: 'ignore',
      env: { ...process.env, DSH_SHADOW_MAINTAIN: '1' },
    })
    child.on('error', () => { /* never fatal */ })
    child.unref()
  } catch { /* best effort */ }
}

module.exports = { maybeStartMaintain }
