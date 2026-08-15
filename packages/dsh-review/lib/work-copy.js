/**
 * Work-copy helpers: AI edits never touch the user's source file (OR).
 * Every tracked write/edit is redirected to a private copy under
 * <root>/work/<id>/<basename> — that copy is the "A" side of the review diff.
 */
import { join } from 'node:path'
import { mkdirSync, copyFileSync, writeFileSync, existsSync } from 'node:fs'

export function workRootOf(root) {
  return join(root, 'work')
}

export function workDirFor(root, id) {
  return join(workRootOf(root), String(id))
}

export function workPathFor(root, id, fileName) {
  return join(workDirFor(root, id), fileName)
}

export function ensureWorkDirs(root, id) {
  mkdirSync(workDirFor(root, id), { recursive: true })
}

/**
 * Stage the source file into a work copy (A side) for a new change.
 * Returns the work copy absolute path. For create operations (source
 * missing) writes an empty file so the tool call still resolves.
 */
export function stageWorkCopy(root, id, sourcePath, fileName, sourceExists) {
  ensureWorkDirs(root, id)
  const target = workPathFor(root, id, fileName)
  if (sourceExists) {
    copyFileSync(sourcePath, target)
  } else {
    writeFileSync(target, '', 'utf8')
  }
  return target
}
