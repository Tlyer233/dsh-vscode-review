/**
 * Global shadow git: bare repo at ~/.dsh/review/shadow/repo.git.
 * Each snapshot only writes the touched file blob (no full-tree add -A).
 * Tree path = files/<sha1(absPath)> so any absolute path works.
 */
import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, unlinkSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { promisify } from 'node:util'
import { createHash, randomBytes } from 'node:crypto'
import {
  canonicalWorkbench,
  ensureShadowRoot,
  globalGitDir,
  shadowRoot,
} from './workbench.js'

const execFileAsync = promisify(execFile)

/** Serialize all snapshots: parallel write/edit share one git index/HEAD. */
let snapshotTail = Promise.resolve()

/**
 * Run `fn` after prior snapshots finish (does not skip the next on failure).
 * @param {() => Promise<any>} fn
 */
function enqueueSnapshot(fn) {
  const run = snapshotTail.then(fn, fn)
  snapshotTail = run.then(() => undefined, () => undefined)
  return run
}

function cleanEnv() {
  const env = { ...process.env }
  for (const k of [
    'GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY',
    'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_CEILING_DIRECTORIES', 'GIT_TEMPLATE_DIR',
  ]) delete env[k]
  return env
}

/** Stable tree path for an absolute file (independent of workbench). */
export function blobKey(absFile) {
  const abs = resolve(String(absFile || ''))
  const id = createHash('sha1').update(abs).digest('hex')
  return 'files/' + id
}

/**
 * Human label for logs: relative to workbench when possible, else abs.
 * @param {string} workbench
 * @param {string} absFile
 */
export function displayPath(workbench, absFile) {
  const root = canonicalWorkbench(workbench)
  const abs = resolve(String(absFile || ''))
  let rel = relative(root, abs)
  if (!rel || rel.startsWith('..')) return abs
  return rel.split('\\').join('/')
}

/** @deprecated use displayPath — kept name for call sites that meant "label" */
export function relPath(workbench, absFile) {
  return displayPath(workbench, absFile)
}

async function git(args, extraEnv = {}) {
  const gitDir = globalGitDir()
  const { stdout, stderr } = await execFileAsync('git', [
    '--git-dir', gitDir,
    ...args,
  ], {
    env: { ...cleanEnv(), ...extraEnv },
    maxBuffer: 32 * 1024 * 1024,
    encoding: 'utf8',
  })
  if (stderr && /fatal:/i.test(stderr)) throw new Error(stderr.trim())
  return String(stdout || '').trim()
}

export async function ensureShadowRepo() {
  ensureShadowRoot()
  const gitDir = globalGitDir()
  if (!existsSync(join(gitDir, 'HEAD'))) {
    mkdirSync(gitDir, { recursive: true })
    await execFileAsync('git', ['init', '--bare', '--template=', gitDir], {
      env: cleanEnv(),
      encoding: 'utf8',
    })
    await git(['config', 'commit.gpgSign', 'false'])
    await git(['config', 'user.name', 'dsh-shadow'])
    await git(['config', 'user.email', 'shadow@localhost'])
  }
  return { gitDir }
}

/**
 * One-file snapshot. Queued so parallel tool writes cannot share `.index.lock`.
 * Missing file → drop that blob key (create-before / delete-after).
 * @param {string} absFile
 * @param {string} message
 * @returns {Promise<string>} commit hash
 */
export async function commitFileSnapshot(absFile, message) {
  return enqueueSnapshot(() => commitFileSnapshotNow(absFile, message))
}

/**
 * Isolated git index per call; must run under enqueueSnapshot.
 * @param {string} absFile
 * @param {string} message
 * @returns {Promise<string>}
 */
async function commitFileSnapshotNow(absFile, message) {
  await ensureShadowRepo()
  const abs = resolve(String(absFile || ''))
  const key = blobKey(abs)
  const indexFile = join(shadowRoot(), '.index-' + randomBytes(8).toString('hex'))
  const env = { GIT_INDEX_FILE: indexFile }

  try {
    let parent = ''
    try {
      parent = await git(['rev-parse', 'HEAD'])
    } catch { /* empty repo */ }

    if (parent) {
      await git(['read-tree', parent], env)
    }

    if (existsSync(abs)) {
      const blob = await git(['hash-object', '-w', '--', abs])
      await git(['update-index', '--add', '--cacheinfo', '100644', blob, key], env)
    } else {
      try {
        await git(['update-index', '--force-remove', '--', key], env)
      } catch { /* not in tree */ }
    }

    const tree = await git(['write-tree'], env)
    const commitArgs = parent
      ? ['commit-tree', tree, '-p', parent, '-m', String(message || 'snapshot')]
      : ['commit-tree', tree, '-m', String(message || 'snapshot')]
    const commit = await git(commitArgs)
    await git(['update-ref', 'HEAD', commit])
    return commit
  } finally {
    try { unlinkSync(indexFile) } catch { /* noop */ }
    try { unlinkSync(indexFile + '.lock') } catch { /* noop */ }
  }
}

/**
 * Read file content at a shadow commit.
 * @param {string} commit
 * @param {string} absFile
 * @returns {Promise<string|null>}
 */
export async function showAt(commit, absFile) {
  if (!commit || !absFile) return null
  const key = blobKey(absFile)
  try {
    await ensureShadowRepo()
    return await git(['show', `${commit}:${key}`])
  } catch {
    return null
  }
}

export function entryId(filePath) {
  return createHash('sha1').update(String(filePath)).digest('hex').slice(0, 12)
}

/** @deprecated no-op alias — global repo has no per-wb dir */
export function shadowPaths() {
  return { gitDir: globalGitDir(), root: shadowRoot() }
}
