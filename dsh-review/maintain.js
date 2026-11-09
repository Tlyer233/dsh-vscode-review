#!/usr/bin/env node
/**
 * Shadow-store maintenance (spawned detached by the dsh plugin host AND the
 * VS Code extension; DSH_SHADOW_MAINTAIN=1 is set on the child so this file's
 * ensureShadowRoot call does not re-trigger itself).
 *
 * Best-practice chain (hermes-agent checkpoint maintenance, opencode #36093
 * "pin live hashes with refs so gc can preserve them", DeepSeek-TUI #1126
 * "reclaim needs severed chains + reflog expire, HEAD rewind alone does
 * nothing"):
 *   1. PIN live state — every before/after hash still named by ANY pending
 *      file gets refs/dsh-review/pin/<hash>, so the history cut and gc below
 *      can never strand an in-flight review (in any window / any project).
 *   2. TRUNCATE history — HEAD becomes an ORPHAN copy of a recent tree.
 *      Commit ids of retained commits are never rewritten (pending files
 *      point at them); the abandoned ancestor chain is what gets collected.
 *   3. DROP dead pins — path pins + hash pins whose object is no longer
 *      named by pending (finished/cleared reviews → their blobs become
 *      collectable; THIS is how 11 GiB of old review data gets reclaimed).
 *   4. RECLAIM — reflog expire --all (the reflog pins objects too) + gc
 *      --prune=now.
 *   5. MARK — bump <shadowRoot>/.last-maintain so triggers fire rarely.
 */
import { execFile, execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, utimesSync } from 'node:fs'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { ensureShadowRoot, globalGitDir, pendingDir, shadowRoot } from './workbench.js'
import { acquireLock, releaseLock } from './lockfile.js'

const execFileAsync = promisify(execFile)

const HISTORY_KEEP = 500 // commits kept reachable from HEAD after the cut

function cleanEnv() {
  const env = { ...process.env }
  for (const k of [
    'GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY',
    'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_CEILING_DIRECTORIES', 'GIT_TEMPLATE_DIR',
  ]) delete env[k]
  env.GIT_CONFIG_GLOBAL = '/dev/null'
  env.GIT_CONFIG_SYSTEM = '/dev/null'
  return env
}

async function git(args) {
  const { stdout, stderr } = await execFileAsync('git', ['--git-dir', globalGitDir(), ...args], {
    env: cleanEnv(),
    maxBuffer: 32 * 1024 * 1024,
    encoding: 'utf8',
  })
  if (stderr && /fatal:/i.test(stderr)) throw new Error(stderr.trim())
  return String(stdout || '').trim()
}

function log(...a) {
  console.log('[dsh-shadow-maintain]', ...a)
}

/** Every 40-hex hash named by any pending file's before/after. */
function liveHashes() {
  const hashes = new Set()
  let files = []
  try { files = readdirSync(pendingDir()) } catch { return hashes }
  for (const f of files) {
    if (!f.endsWith('.json')) continue
    try {
      const list = JSON.parse(readFileSync(join(pendingDir(), f), 'utf8'))
      if (!Array.isArray(list)) continue
      for (const e of list) {
        if (!e) continue
        for (const h of [e.before, e.after]) {
          if (typeof h === 'string' && /^[0-9a-f]{40}$/.test(h)) hashes.add(h)
        }
      }
    } catch { /* corrupt pending file: treat as empty */ }
  }
  return hashes
}

async function listRefs(prefix) {
  let out = ''
  try { out = await git(['for-each-ref', '--format=%(objectname) %(refname)', prefix]) } catch { /* none */ }
  return String(out || '').split('\n').filter(Boolean).map((line) => {
    const [oid, ref] = line.split(' ')
    return { oid, ref }
  }).filter((r) => r.oid && r.ref)
}

async function main() {
  ensureShadowRoot()
  let head = ''
  try { head = await git(['rev-parse', 'HEAD']) } catch { log('empty repo, nothing to do'); return }

  const hashes = liveHashes()

  // 1. pin live pending hashes
  let pinned = 0
  for (const h of hashes) {
    try {
      await git(['cat-file', '-e', h])
    } catch {
      continue // object already collected; nothing to pin
    }
    try {
      await git(['update-ref', 'refs/dsh-review/pin/' + h, h])
      pinned++
    } catch (e) {
      log('pin failed', h.slice(0, 8), String((e && e.message) || e))
    }
  }

  // 2. truncate history: orphan tip at the retained boundary (ids preserved)
  let truncated = false
  try {
    const count = Number(await git(['rev-list', '--count', 'HEAD'])) || 0
    if (count > HISTORY_KEEP) {
      // Orphan-tip at HEAD's OWN tree: the cumulative tree is the live set
      // (every key currently on disk); the ancestors only add superseded
      // blobs, which is exactly what we want collected. Pending-pinned
      // hashes survive via refs/pin (step 1), so no review baseline is lost.
      const tree = await git(['rev-parse', 'HEAD^{tree}'])
      const fresh = await git(['commit-tree', tree, '-m', 'shadow: history truncated (kept last ' + HISTORY_KEEP + ')'])
      await git(['update-ref', 'HEAD', fresh, head])
      truncated = true
    }
  } catch (e) {
    log('truncate skipped:', String((e && e.message) || e))
  }

  // 3. drop dead pins: path pins (before/after) and hash pins no pending
  //    file names any more. Objects they alone kept die in step 4.
  let dropped = 0
  const refs = [...await listRefs('refs/dsh-review/before'), ...await listRefs('refs/dsh-review/after'), ...await listRefs('refs/dsh-review/pin')]
  for (const { oid, ref } of refs) {
    if (hashes.has(oid)) continue
    try {
      await git(['update-ref', '-d', ref])
      dropped++
    } catch (e) {
      log('unpin failed', ref, String((e && e.message) || e))
    }
  }

  // 4. reclaim — the HEAD reflog alone keeps the abandoned chain alive, so
  //    expire + delete it before gc. Ref work happens under .snapshot.lock
  //    (same lock the writers use), and gc runs with a ONE-DAY cutoff in a
  //    detached child: --prune=now would race fresh not-yet-pinned blobs from
  //    a concurrent writer (git-gc NOTES + opencode keep a grace window).
  const snapLock = acquireLock(join(shadowRoot(), '.snapshot.lock'), { timeoutMs: 10000 })
  try {
    try { await git(['reflog', 'expire', '--expire=never', '--all']) } catch { /* none */ }
    try { await git(['reflog', 'delete', 'HEAD']) } catch { /* none */ }
  } finally {
    releaseLock(snapLock)
  }
  try {
    const { spawn } = await import('node:child_process')
    const child = spawn('git', ['--git-dir', globalGitDir(), 'gc', '--prune=1.day.ago', '--quiet'], {
      env: cleanEnv(),
      detached: true,
      stdio: 'ignore',
    })
    child.on('error', (e) => log('gc spawn failed:', String((e && e.message) || e)))
    child.unref()
  } catch (e) {
    log('gc failed:', String((e && e.message) || e))
  }

  // 5. mark
  try {
    const m = join(shadowRoot(), '.last-maintain')
    mkdirSync(shadowRoot(), { recursive: true })
    if (!existsSync(m)) {
      const { writeFileSync } = await import('node:fs')
      writeFileSync(m, '')
    }
    utimesSync(m, new Date(), new Date())
  } catch { /* best effort */ }

  let size = '?'
  try { size = execFileSync('du', ['-sh', shadowRoot()], { encoding: 'utf8' }).split('\t')[0].trim() } catch { /* win */ }
  log('done pinned=' + pinned, 'droppedPins=' + dropped, 'truncated=' + truncated, 'store=' + size)
}

main().catch((e) => {
  console.error('[dsh-shadow-maintain] failed:', String((e && e.message) || e))
  process.exitCode = 1
})
