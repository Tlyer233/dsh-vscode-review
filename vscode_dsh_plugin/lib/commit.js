'use strict'

/**
 * dsh-review-vscode — commit operations (verify + revert).
 *
 * Pure logic; the filesystem is injected so plain-node tests can drive it:
 *   fsx = { readFile(p) -> Buffer|null, writeFile(p, buf) -> void,
 *          deleteFile(p) -> void, exists(p) -> boolean }
 */

/**
 * Verify an entry against the current on-disk file.
 * @returns 'match' | 'drifted' | 'missing' | 'unknown'
 */
async function verifyEntry({ fsx, entry, afterBytes }) {
  if (!entry) return 'unknown'
  if (entry.status === 'reverted') return 'reverted'
  if (!entry.afterAvailable || !afterBytes) return 'unknown'
  try {
    const current = await fsx.readFile(entry.filePath)
    if (current === null || current === undefined) return 'missing'
    return Buffer.compare(Buffer.from(current), Buffer.from(afterBytes)) === 0 ? 'match' : 'drifted'
  } catch {
    return 'missing'
  }
}

/**
 * Revert an entry: restore the before snapshot (update) or delete the file (create).
 * @returns {ok: true, action: 'update'|'create'|'deleted', message: string}
 *          or {ok: false, error: string}
 */
async function revertEntry({ fsx, entry, beforeBytes }) {
  if (!entry) return { ok: false, error: 'no change entry' }
  if (entry.status === 'reverted') return { ok: false, error: 'change ' + entry.id + ' is already reverted' }
  if (entry.operation === 'create') {
    // The AI created the file: revert = delete it.
    if (!await fsx.exists(entry.filePath)) {
      return { ok: false, error: 'file no longer exists: ' + entry.filePath }
    }
    try {
      await fsx.deleteFile(entry.filePath)
      return { ok: true, action: 'deleted', message: 'Deleted file ' + entry.filePath + ' (the AI created it).' }
    } catch (e) {
      return { ok: false, error: 'failed to delete: ' + (e && e.message || e) }
    }
  }
  if (!entry.beforeAvailable || beforeBytes === null || beforeBytes === undefined) {
    return { ok: false, error: 'this change has no usable before snapshot (beforeTruncated or missing); cannot auto-revert' }
  }
  try {
    await fsx.writeFile(entry.filePath, Buffer.from(beforeBytes))
    return { ok: true, action: 'update', message: 'Restored ' + entry.filePath + ' to its pre-change content.' }
  } catch (e) {
    return { ok: false, error: 'failed to write: ' + (e && e.message || e) }
  }
}

module.exports = { verifyEntry, revertEntry }

