/**
 * Shared storage roots for dsh-review (+ mirrored by dsh-review-vscode).
 *
 *   $DSH_HOME/review/shadow/repo.git           — one global shadow git (bare)
 *   $DSH_HOME/review/shadow/pending/<wbHash>.json — per-workbench pending list
 *
 * Ownership: edits from session.header.cwd go into that workbench's pending file.
 * filePath may lie outside that cwd.
 */
import { createHash } from 'node:crypto'
import { mkdirSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

export function dshHome() {
  const env = process.env.DSH_HOME && String(process.env.DSH_HOME).trim()
  return env || join(homedir(), '.dsh')
}

/** ~/.dsh/review/shadow */
export function shadowRoot() {
  return join(dshHome(), 'review', 'shadow')
}

/** ~/.dsh/review/shadow/repo.git — global bare repo */
export function globalGitDir() {
  return join(shadowRoot(), 'repo.git')
}

/** ~/.dsh/review/shadow/pending */
export function pendingDir() {
  return join(shadowRoot(), 'pending')
}

/**
 * Pending file for one dsh workbench (session cwd).
 * @param {string} workbench
 */
export function pendingFileFor(workbench) {
  return join(pendingDir(), workbenchRepoId(workbench) + '.json')
}

export function canonicalWorkbench(raw) {
  const p = resolve(String(raw || process.cwd()))
  try {
    return realpathSync.native(p)
  } catch {
    return p
  }
}

export function workbenchRepoId(workbench) {
  return createHash('sha1').update(canonicalWorkbench(workbench)).digest('hex').slice(0, 16)
}

export function ensureShadowRoot() {
  const root = shadowRoot()
  mkdirSync(root, { recursive: true })
  mkdirSync(pendingDir(), { recursive: true })
  return root
}
