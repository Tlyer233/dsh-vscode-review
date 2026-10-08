import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { entryId } from './shadow.js'
import { ensureShadowRoot, pendingFileFor } from './workbench.js'

/**
 * Read pending list for one workbench.
 * @param {string} workbench session cwd
 * @returns {any[]}
 */
export function readPending(workbench) {
  ensureShadowRoot()
  if (!workbench) return []
  const pendingPath = pendingFileFor(workbench)
  if (!existsSync(pendingPath)) return []
  try {
    const raw = JSON.parse(readFileSync(pendingPath, 'utf8'))
    return Array.isArray(raw) ? raw : []
  } catch {
    return []
  }
}

/**
 * @param {string} workbench
 * @param {any[]} entries
 */
export function writePendingAtomic(workbench, entries) {
  ensureShadowRoot()
  if (!workbench) throw new Error('writePendingAtomic: workbench required')
  const pendingPath = pendingFileFor(workbench)
  mkdirSync(dirname(pendingPath), { recursive: true })
  const tmp = pendingPath + '.tmp'
  const body = JSON.stringify(entries, null, 2) + '\n'
  writeFileSync(tmp, body, 'utf8')
  renameSync(tmp, pendingPath)
}

/**
 * Upsert by absolute filePath into that session workbench's pending file.
 * `patch.workbench` MUST be the dsh session cwd that performed the edit.
 * `patch.operation` optional: 'create' | 'edit' | 'delete'
 */
export function upsertPending(patch, { clearRolling = false } = {}) {
  void clearRolling
  const filePath = String(patch.filePath)
  const workbench = String(patch.workbench || '')
  if (!workbench) {
    throw new Error('upsertPending: patch.workbench (session cwd) is required')
  }
  const list = readPending(workbench)
  const idx = list.findIndex((e) => e && e.filePath === filePath)
  const prev = idx >= 0 ? list[idx] : null
  const operation = patch.operation
    || (prev && prev.operation)
    || 'edit'
  const next = {
    id: (prev && prev.id) || entryId(filePath),
    filePath,
    workbench,
    operation,
    before: patch.before !== undefined ? patch.before : (prev && prev.before) || null,
    after: patch.after !== undefined ? patch.after : (prev && prev.after) || null,
    updatedAt: Date.now(),
  }
  if (idx >= 0) {
    // Idempotent: unchanged hashes must not rewrite the file. Browser pages
    // sharing the session re-fire tool events; a rewrite bumps updatedAt,
    // fires the VS Code watcher, and mount/clear storms make the dock flicker.
    if (prev.before === next.before && prev.after === next.after && prev.operation === next.operation) {
      return prev
    }
    list[idx] = next
  } else list.push(next)
  writePendingAtomic(workbench, list)
  return next
}

/**
 * @param {string} workbench
 * @param {string} filePath
 */
export function removePending(workbench, filePath) {
  if (!workbench) return
  const list = readPending(workbench).filter((e) => e && e.filePath !== filePath)
  writePendingAtomic(workbench, list)
}
