import { resolve } from 'node:path'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { commitFileSnapshot, ensureShadowRepo, relPath } from './shadow.js'
import { readPending, upsertPending } from './pending.js'
import { shadowRoot } from './workbench.js'
import { installJobsBridge } from './jobs.js'

export const name = 'dsh-review'
export const inject = []

/** Join key with the browser `settings.plugin.item` card. Do not import host packages — this plugin is loaded from a path outside dsh's node_modules. */
const REVIEW_NS = 'dsh-review'

/**
 * Minimal schemastery-shaped schema: callable resolver + toJSON for describe().
 * @param {unknown} value
 * @returns {{ enabled: boolean, fileSend: string, snippetSend: string, sidebarSide: string, jobsTerminal: boolean, scopeFilter: boolean, autoWorkspace: boolean, openFilesInVscode: boolean }}
 */
function reviewConfigSchema(value) {
  const v = value && typeof value === 'object' ? value : {}
  return {
    enabled: v.enabled !== false,
    fileSend: v.fileSend === 'prefixed' ? 'prefixed' : 'path',
    snippetSend: v.snippetSend === 'pointer' ? 'pointer' : 'fence',
    sidebarSide: v.sidebarSide === 'right' ? 'right' : 'left',
    // Off by default: background-job terminals stay out of VS Code until asked.
    jobsTerminal: v.jobsTerminal === true,
    // Both on by default: 0.1.43 row filter and 0.1.45 auto-register shipped
    // as the fixed behaviour; the 0.1.46 toggles only let users opt out.
    scopeFilter: v.scopeFilter !== false,
    autoWorkspace: v.autoWorkspace !== false,
    // On by default: in the VS Code workbench the built-in document preview
    // duplicates the editor the user is already looking at.
    openFilesInVscode: v.openFilesInVscode !== false,
  }
}
reviewConfigSchema.toJSON = function toJSON() {
  return {
    type: 'object',
    properties: {
      enabled: { type: 'boolean', default: true },
      fileSend: { type: 'string', default: 'path' },
      snippetSend: { type: 'string', default: 'fence' },
      sidebarSide: { type: 'string', default: 'left' },
      jobsTerminal: { type: 'boolean', default: false },
      scopeFilter: { type: 'boolean', default: true },
      autoWorkspace: { type: 'boolean', default: true },
      openFilesInVscode: { type: 'boolean', default: true },
    },
  }
}

/**
 * @param {object} ctx
 * @param {{ enabled?: boolean }} entry
 * @param {{ setSource: (fn: () => { enabled: boolean }) => void, onChange: () => void }} hooks
 * @description Same wiring as dsh-settings installSettingsSection, without importing it.
 */
function installReviewSettings(ctx, entry, hooks) {
  ctx.inject(['settings'], (sctx) => {
    if (!sctx.settings || typeof sctx.settings.register !== 'function') return
    const scope = sctx.settings.register(REVIEW_NS, reviewConfigSchema, { base: entry })
    hooks.setSource(() => scope.get())
    sctx.effect(() => () => {
      hooks.setSource(() => entry)
      hooks.onChange()
    })
    hooks.onChange()
    scope.watch(() => { hooks.onChange() })
  })
}

/** write/edit → shadow + pending; bash/run_code only for rm→delete. */
const TRACK = new Set(['edit', 'write'])
const SHELL_TOOLS = new Set(['bash', 'run_code', 'shell'])

/** filePath abs -> { beforeHash, chained, workbench, operation } */
const beforeByFile = new Map()

/** dsh session workbench = session.header.cwd (the Workspace the agent is in). */
function sessionWorkbench(exec) {
  const cwd = exec && exec.agent && exec.agent.session && exec.agent.session.header
    ? exec.agent.session.header.cwd
    : undefined
  return typeof cwd === 'string' && cwd ? cwd : process.cwd()
}

function toAbs(exec, filePath) {
  if (typeof filePath !== 'string' || !filePath) return null
  return resolve(sessionWorkbench(exec), filePath)
}

/**
 * Shell command strings to inspect for `rm` (never the whole run_code blob).
 * - bash/shell → arguments.command
 * - run_code → only `command: "..."` / `command: '...'` inside the code
 * @param {any} exec
 * @returns {string[]}
 */
function shellCommandStrings(exec) {
  const name = String((exec && exec.name) || '')
  const args = (exec && exec.arguments) || {}
  if (name === 'bash' || name === 'shell') {
    const c = args.command || args.cmd
    return typeof c === 'string' && c.trim() ? [c] : []
  }
  if (name === 'run_code') {
    const code = String(args.code || '')
    const out = []
    const re = /\bcommand\s*:\s*("((?:\\.|[^"\\])*)"|'((?:\\.|[^'\\])*)')/g
    let m
    while ((m = re.exec(code))) {
      const raw = m[2] != null ? m[2] : m[3]
      if (raw == null || raw === '') continue
      out.push(raw.replace(/\\"/g, '"').replace(/\\'/g, "'"))
    }
    return out
  }
  return []
}

/**
 * True if abs looks like a real filesystem path (filters JS crumbs).
 * @param {string} abs
 */
function looksLikeFilePath(abs) {
  if (!abs || abs.length < 3) return false
  if (/[{}\n\r]|,\s/.test(abs)) return false
  if (!abs.includes('/')) return false
  const base = abs.split('/').pop() || ''
  if (!base || /["'`]/.test(base)) return false
  if (/^(delete|description|rm|command)$/i.test(base)) return false
  return true
}

/**
 * Pull paths out of a single shell command like: rm -rf '/a/b' ./c
 * @param {string} cmd
 * @param {string} workbench
 * @returns {string[]}
 */
function extractRmPathsFromCommand(cmd, workbench) {
  const src = String(cmd || '')
  if (!src || !/\brm\b/.test(src)) return []
  const blocks = src.match(/\brm\b(?:\s+-[a-zA-Z0-9]+)*\s+[^;&\n|]+/g) || []
  const out = []
  const seen = new Set()
  for (const block of blocks) {
    const quoted = [...block.matchAll(/'([^']+)'|"([^"]+)"/g)]
    for (const m of quoted) {
      const p = m[1] || m[2]
      if (!p || p.startsWith('-')) continue
      const abs = resolve(workbench, p)
      if (!looksLikeFilePath(abs)) continue
      if (!seen.has(abs)) { seen.add(abs); out.push(abs) }
    }
    const bare = block.replace(/'[^']*'|"[^"]*"/g, ' ')
    const tokens = bare.trim().split(/\s+/).slice(1)
    for (const t of tokens) {
      if (!t || t.startsWith('-')) continue
      if (!t.includes('/') && !/\.\w{1,16}$/.test(t)) continue
      const abs = resolve(workbench, t)
      if (!looksLikeFilePath(abs)) continue
      if (!seen.has(abs)) { seen.add(abs); out.push(abs) }
    }
  }
  return out
}

/**
 * All rm target paths for this tool execution.
 * @param {any} exec
 * @param {string} workbench
 * @returns {string[]}
 */
function extractRmPaths(exec, workbench) {
  const seen = new Set()
  const out = []
  for (const cmd of shellCommandStrings(exec)) {
    for (const abs of extractRmPathsFromCommand(cmd, workbench)) {
      if (!seen.has(abs)) { seen.add(abs); out.push(abs) }
    }
  }
  return out
}

/**
 * @param {string} abs
 * @param {string} workbench
 */
function pendingEntry(abs, workbench) {
  return readPending(workbench).find((e) => e && e.filePath === abs) || null
}

/**
 * If this file is still awaiting review (has a before), keep that baseline
 * across further AI edits so pending shows the cumulative diff — not only
 * the last micro-edit.
 * @param {string} abs
 * @param {string} workbench
 */
function baselineToKeep(abs, workbench) {
  const hit = pendingEntry(abs, workbench)
  if (hit && hit.before) return hit.before
  return null
}

/**
 * Snapshot files about to be rm'd (pre-execute), so delete pending has a before.
 * @param {any} exec
 */
async function prepareDeletesFromShell(exec) {
  const wb = sessionWorkbench(exec)
  const paths = extractRmPaths(exec, wb)
  for (const abs of paths) {
    if (!existsSync(abs)) continue
    await ensureShadowRepo()
    const kept = baselineToKeep(abs, wb)
    const prevOp = (pendingEntry(abs, wb) && pendingEntry(abs, wb).operation) || 'edit'
    if (kept) {
      beforeByFile.set(abs, { beforeHash: kept, chained: true, workbench: wb, operation: 'delete', prevOp })
      await commitFileSnapshot(abs, 'before(delete-chain) ' + relPath(wb, abs))
      console.info('[dsh-review] delete-before(keep)', relPath(wb, abs), kept.slice(0, 8), 'wb=' + wb)
    } else {
      const hash = await commitFileSnapshot(abs, 'before(delete) ' + relPath(wb, abs))
      beforeByFile.set(abs, { beforeHash: hash, chained: false, workbench: wb, operation: 'delete', prevOp })
      console.info('[dsh-review] delete-before', relPath(wb, abs), hash.slice(0, 8), 'wb=' + wb)
    }
  }
}

/**
 * After shell succeeds: paths that rm targeted and are gone → pending delete.
 * Only paths parsed from the command (no full pending scan).
 * @param {any} exec
 */
async function finalizeDeletesFromShell(exec) {
  const wb = sessionWorkbench(exec)
  const paths = extractRmPaths(exec, wb)
  for (const abs of paths) {
    if (!looksLikeFilePath(abs)) continue
    if (existsSync(abs)) {
      beforeByFile.delete(abs)
      console.info('[dsh-review] delete-skip still-exists', relPath(wb, abs))
      continue
    }
    const prev = beforeByFile.get(abs)
    beforeByFile.delete(abs)
    const hit = pendingEntry(abs, wb)
    const beforeHash = (prev && prev.beforeHash) || (hit && hit.before) || null
    upsertPending({
      filePath: abs,
      workbench: wb,
      before: beforeHash,
      after: null,
      operation: 'delete',
    }, { clearRolling: true })
    console.info(
      '[dsh-review] delete', relPath(wb, abs),
      'wb=' + wb,
      'before=' + (beforeHash ? beforeHash.slice(0, 8) : '(none)'),
    )
  }
}

export function apply(ctx, config) {
  const entry = config && typeof config === 'object' ? config : { enabled: true }
  let source = () => entry
  // Card-saved settings live in <shadowRoot>/settings.json (this plugin's
  // own persistence; the rc.2 web profile has no settings provider). They
  // layer on top of the cordis row so both sources are honored at boot.
  let override = {}
  try {
    const storedPath = resolve(shadowRoot(), 'settings.json')
    if (existsSync(storedPath)) override = reviewConfigSchema(JSON.parse(readFileSync(storedPath, 'utf8')))
  } catch { /* keep row config only */ }
  if (Object.keys(override).length) Object.assign(entry, override)
  installReviewSettings(ctx, entry, {
    setSource: (current) => { source = current },
    onChange: () => {
      try { console.info('[dsh-review] settings', source()) } catch { /* noop */ }
    },
  })
  if (source().enabled === false) return

  console.info('[dsh-review] shadow root =', shadowRoot())
  console.info('[dsh-review] layout = global repo.git + pending/<wbHash>.json')
  console.info('[dsh-review] pending owner = session.header.cwd; filePath may be outside that cwd')
  console.info('[dsh-review] TRACK tools =', [...TRACK].join(','), '+ shell rm→delete')

  // Expose background jobs to the VSCode extension (SSE + kill by id).
  // `jobs`/`webServer` are cordis services: only reachable inside an injected
  // sub-context (bare ctx.jobs throws "cannot get property ... without inject").
  // installJobsBridge is idempotent (symbol flags), so the inject callback
  // re-running on service changes is safe. A failure here must not break the
  // review tool hooks below.
  try {
    ctx.inject(['jobs', 'webServer'], (sctx) => {
      installJobsBridge(sctx, {
        get: () => reviewConfigSchema({ ...source(), ...override }),
        set: (patch) => {
          const merged = reviewConfigSchema({ ...source(), ...override, ...(patch || {}) })
          override = merged
          Object.assign(entry, merged)
          const dir = shadowRoot()
          mkdirSync(dir, { recursive: true })
          const target = resolve(dir, 'settings.json')
          writeFileSync(target + '.tmp', JSON.stringify(merged, null, 2))
          renameSync(target + '.tmp', target)
          return merged
        },
      })
    })
  } catch (e) {
    console.warn('[dsh-review] jobs bridge failed:', e && e.message || e)
  }

  ctx.on('tools/pre-execute', async (exec, next) => {
    try {
      if (SHELL_TOOLS.has(exec.name)) {
        await prepareDeletesFromShell(exec)
      }
      if (TRACK.has(exec.name)) {
        const wb = sessionWorkbench(exec)
        const filePath = exec.arguments && exec.arguments.file_path
        const abs = toAbs(exec, filePath)
        if (abs) {
          await ensureShadowRepo()
          const existed = existsSync(abs)
          const operation = exec.name === 'write' && !existed ? 'create' : 'edit'
          const kept = baselineToKeep(abs, wb)
          if (kept) {
            // Keep create if this file was originally a create still pending.
            const prevOp = (pendingEntry(abs, wb) && pendingEntry(abs, wb).operation) || operation
            const op = prevOp === 'create' ? 'create' : operation
            beforeByFile.set(abs, { beforeHash: kept, chained: true, workbench: wb, operation: op })
            await commitFileSnapshot(abs, 'before(chain) ' + relPath(wb, abs))
            console.info('[dsh-review] before(keep)', relPath(wb, abs), kept.slice(0, 8), 'op=' + op, 'wb=' + wb)
          } else {
            const hash = await commitFileSnapshot(abs, 'before ' + relPath(wb, abs))
            beforeByFile.set(abs, { beforeHash: hash, chained: false, workbench: wb, operation })
            upsertPending({
              filePath: abs,
              before: hash,
              after: null,
              workbench: wb,
              operation,
            }, { clearRolling: true })
            console.info('[dsh-review] before', relPath(wb, abs), hash.slice(0, 8), 'op=' + operation, 'wb=' + wb)
          }
        }
      }
    } catch (e) {
      console.warn('[dsh-review] pre-execute shadow failed:', e && e.message || e)
    }
    return next()
  })

  ctx.on('tools/result', (exec, result) => {
    if (SHELL_TOOLS.has(exec.name)) {
      if (result && result.isError) {
        // Drop staged delete befores for this command's targets.
        const wb = sessionWorkbench(exec)
        for (const abs of extractRmPaths(exec, wb)) {
          beforeByFile.delete(abs)
        }
        return
      }
      void finalizeDeletesFromShell(exec).catch((e) => {
        console.warn('[dsh-review] delete finalize failed:', e && e.message || e)
      })
      return
    }
    if (!TRACK.has(exec.name)) return
    if (result && result.isError) {
      const abs = toAbs(exec, exec.arguments && exec.arguments.file_path)
      if (abs) beforeByFile.delete(abs)
      return
    }
    void (async () => {
      try {
        const wb = sessionWorkbench(exec)
        const raw = (result && result.value && result.value.path)
          || (exec.arguments && exec.arguments.file_path)
        const abs = toAbs(exec, raw)
        if (!abs) return
        await ensureShadowRepo()
        const afterHash = await commitFileSnapshot(abs, 'after ' + relPath(wb, abs))
        const prev = beforeByFile.get(abs)
        beforeByFile.delete(abs)
        const beforeHash = (prev && prev.beforeHash)
          || baselineToKeep(abs, wb)
          || afterHash
        const operation = (prev && prev.operation)
          || (pendingEntry(abs, wb) && pendingEntry(abs, wb).operation)
          || 'edit'
        upsertPending({
          filePath: abs,
          before: beforeHash,
          after: afterHash,
          workbench: wb,
          operation,
        }, { clearRolling: true })
        console.info(
          '[dsh-review] after', relPath(wb, abs),
          'op=' + operation,
          'wb=' + wb,
          'before=' + beforeHash.slice(0, 8),
          'after=' + afterHash.slice(0, 8),
          prev && prev.chained ? '(chained)' : '',
          beforeHash === afterHash ? '(WARN same hash)' : '',
        )
      } catch (e) {
        console.warn('[dsh-review] result shadow failed:', e && e.message || e)
      }
    })()
  })
}
