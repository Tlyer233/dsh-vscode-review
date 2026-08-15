/**
 * @dsn/dsh-review - Trae (VS Code family) CLI opener.
 *
 * Zero external deps. Resolves the trae executable and spawns
 *
 *   trae --diff <before-snapshot> <real-file> [--reuse-window]
 *
 * detached + fire-and-forget, so dsh never blocks on the editor. The same
 * module serves VS Code later by pointing traeCommand at the VS Code CLI
 * (code --diff has the same interface).
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'

/** Candidate commands, probed in order (no shell resolution). */
const CANDIDATES = [
  '/Applications/Trae.app/Contents/Resources/app/bin/trae',
  '/usr/local/bin/trae',
  '/opt/homebrew/bin/trae',
  '/Applications/Trae CN.app/Contents/Resources/app/bin/trae-cn',
  '/usr/local/bin/trae-cn',
]

/**
 * Resolve the trae CLI command.
 * @param explicit - config.traeCommand ('' = auto-detect)
 * @returns command string, or null when nothing usable is found
 */
export function resolveTraeCommand(explicit = '') {
  if (explicit && explicit.trim() !== '') return explicit.trim()
  if (process.env.DSH_REVIEW_TRAE_BIN && process.env.DSH_REVIEW_TRAE_BIN.trim() !== '') {
    return process.env.DSH_REVIEW_TRAE_BIN.trim()
  }
  for (const c of CANDIDATES) {
    if (c.includes('/') ? existsSync(c) : true) return c
  }
  return null
}

/**
 * Open a two-file diff in Trae.
 * @param opts.traeCommand - resolved CLI command
 * @param opts.beforePath - left side (old content snapshot); must exist
 * @param opts.realPath - right side (current file); must exist
 * @param opts.reuseWindow - pass --reuse-window
 * @returns Promise<{ ok: true } | { ok: false, error: string }>
 */
export function openDiff({ traeCommand, beforePath, realPath, reuseWindow = true }) {
  return new Promise((resolve) => {
    const cmd = resolveTraeCommand(traeCommand)
    if (!cmd) {
      resolve({ ok: false, error: 'no trae CLI found (set config.traeCommand)' })
      return
    }
    if (!existsSync(String(realPath))) {
      resolve({ ok: false, error: 'real file missing: ' + realPath })
      return
    }
    if (!existsSync(String(beforePath))) {
      resolve({ ok: false, error: 'before snapshot missing: ' + beforePath })
      return
    }
    const args = ['--diff', String(beforePath), String(realPath)]
    if (reuseWindow) args.push('--reuse-window')
    let child
    try {
      child = spawn(cmd, args, { detached: true, stdio: 'ignore' })
    } catch (error) {
      resolve({ ok: false, error: String(error && error.message || error) })
      return
    }
    child.on('error', (error) => {
      resolve({ ok: false, error: String(error.message || error) })
    })
    child.on('spawn', () => {
      child.unref()
      resolve({ ok: true })
    })
  })
}

/**
 * Open a file in Trae (used after revert to show the restored file).
 */
export function openFile({ traeCommand, realPath, reuseWindow = true }) {
  return new Promise((resolve) => {
    const cmd = resolveTraeCommand(traeCommand)
    if (!cmd) {
      resolve({ ok: false, error: 'no trae CLI found (set config.traeCommand)' })
      return
    }
    if (!existsSync(String(realPath))) {
      resolve({ ok: false, error: 'file missing: ' + realPath })
      return
    }
    const args = [String(realPath)]
    if (reuseWindow) args.push('--reuse-window')
    let child
    try {
      child = spawn(cmd, args, { detached: true, stdio: 'ignore' })
    } catch (error) {
      resolve({ ok: false, error: String(error && error.message || error) })
      return
    }
    child.on('error', (error) => {
      resolve({ ok: false, error: String(error.message || error) })
    })
    child.on('spawn', () => {
      child.unref()
      resolve({ ok: true })
    })
  })
}
