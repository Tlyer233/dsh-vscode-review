/**
 * @dsn/dsh-review — dsh review plugin.
 *
 * What it does (host plane, zero runtime deps on @deepseek-ai/*):
 *  1. On every model write/edit (tools/result), journals the change into a
 *     change-manifest store ($DSH_HOME/review/changes/<id>.{json,before,after})
 *     — the same store the future Trae/VS Code extension will read.
 *  2. Opens the Trae two-file diff view for each change (autoOpenDiff),
 *     left = before snapshot, right = the current file.
 *  3. Exposes review_status / review_revert / review_open tools:
 *       review_status  — list & verify AI file changes (dsh-side validation)
 *       review_revert  — restore the pre-change content from the snapshot
 *                        (no git; guarded by the post-write fs version)
 *       review_open    — re-open the Trae diff for a recorded change
 *
 * Events used (stable public dsh vocabulary):
 *   tools/pre-execute  waterfall — captures a bounded before-preview fallback
 *   fs/observed        emit     — remembers the post-write fs version
 *   tools/result       emit     — commits the journal entry and opens Trae
 */
import { existsSync, unlinkSync, copyFileSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs'
import { join, basename as pathBasename } from 'node:path'
import {
  resolveRoot, ensureDirs, newChangeId, buildEntry, saveEntry, updateEntry,
  listEntries, findActionableEntry, readSnapshot, snapshotPath, writeSnapshot,
  DEFAULT_MAX_SNAPSHOT_BYTES,
} from './review-journal.js'
import { workRootOf, workPathFor, ensureWorkDirs, stageWorkCopy } from './work-copy.js'
import { resolveTraeCommand, openDiff, openFile } from './trae.js' 

export const name = 'review' 

const DEFAULT_CONFIG = {
  enabled: true,
  autoOpenDiff: true,
  openOnRevert: true,
  traeCommand: '',                 // '' = auto-detect trae CLI
  reuseWindow: true,
  trackTools: ['write', 'edit'],
  maxSnapshotBytes: DEFAULT_MAX_SNAPSHOT_BYTES,
} 

/** Plain config normalization (no schemastery import). */
export function normalizeConfig(raw = {}) {
  const cfg = { ...DEFAULT_CONFIG, ...(raw || {}) }
  if (!Array.isArray(cfg.trackTools)) cfg.trackTools = [...DEFAULT_CONFIG.trackTools]
  cfg.trackTools = cfg.trackTools.filter((t) => typeof t === 'string')
  cfg.enabled = cfg.enabled !== false
  cfg.autoOpenDiff = cfg.autoOpenDiff !== false
  cfg.openOnRevert = cfg.openOnRevert !== false
  cfg.reuseWindow = cfg.reuseWindow !== false
  cfg.maxSnapshotBytes = Number.isFinite(cfg.maxSnapshotBytes) && cfg.maxSnapshotBytes > 0
    ? Math.floor(cfg.maxSnapshotBytes)
    : DEFAULT_MAX_SNAPSHOT_BYTES
  return cfg 
}

/**
 * Canonical workbench directory for one tool execution. The authoritative
 * source is the session header cwd (the workspace the session was created
 * in), not process.cwd(): one dsh web process can host many workspaces.
 */
function workbenchIdOf(exec) {
  const cwd = exec && exec.agent && exec.agent.session && exec.agent.session.header
    ? exec.agent.session.header.cwd
    : undefined
  const raw = typeof cwd === 'string' && cwd !== '' ? cwd : process.cwd()
  try {
    return realpathSync.native(raw)
  } catch {
    return raw
  }
}

const decoder = new TextDecoder('utf-8')

export function apply(ctx, rawConfig) {
  const config = normalizeConfig(rawConfig)
  if (!config.enabled) return 

  const root = ensureDirs(resolveRoot(config))
  const track = new Set(config.trackTools) 

  /** Bounded before-preview fallback, keyed by targetKey (never revert-safe). */
  const pending = new Map()
  /** Post-write fs versions from fs/observed, keyed by targetKey. */
  const versionCache = new Map() 

  const fsx = () => ctx.get('fs')
  const logger = {
    warn: (...a) => { if (ctx.logger && ctx.logger.warn) ctx.logger.warn(...a); else console.warn('[dsh-review]', ...a) },
    info: (...a) => { if (ctx.logger && ctx.logger.info) ctx.logger.info(...a) },
  } 

  // ── pre-execute: redirect write/edit onto a private work copy (A side) ────
  // The user's source file (OR) is NEVER modified by the AI tool here; the
  // tool runs against <root>/work/<id>/<basename> instead. The review UI
  // diff-renders OR vs the work copy, and accepting a hunk applies it to OR.
  ctx.on('tools/pre-execute', async (exec, next) => {
    try {
      if (track.has(exec.name)) {
        const fs = fsx()
        const filePath = exec.arguments && exec.arguments.file_path
        if (fs && typeof filePath === 'string') { 
          try {
            const target = await fs.resolve(filePath, { signal: exec.signal })
            const info = await fs.stat(target, exec.signal)
            const sourceExists = !!(info && info.type === 'file')
            const id = newChangeId()
            let workPath = null
            if (target) {
              // Resolve the real absolute path: prefer displayPath for copies.
              const abs = target.displayPath || filePath
              const fileName = pathBasename(abs)
              workPath = stageWorkCopy(root, id, abs, fileName, sourceExists)
              // exec.arguments is frozen in dsh-tools — the call cannot be
              // redirected. The tool runs on the real file; finalize() then
              // restores the OR from the captured before-text below.
            }
            if (workPath) {
              let bytes = null
              try {
                bytes = await fs.readBytes(target, exec.signal, config.maxSnapshotBytes)
              } catch { /* too large / binary → no preview */ }
              // Keyed by the OR target key (the tool writes the real file).
              pending.set(String(target.targetKey), {
                before: bytes && bytes.byteLength > 0 ? decoder.decode(bytes) : null,
                tool: exec.name,
                filePath: target.displayPath,
                workPath,
                operationPreview: sourceExists ? 'update' : 'create',
                at: new Date().toISOString(),
              })
            }
          } catch (e) {
            try {
              const { appendFileSync } = await import('node:fs')
              appendFileSync('/Users/xi/.dsh/review/pre-execute-error.log',
                new Date().toISOString() + ' ' + (e && e.stack || e) + '\n')
            } catch { /* ignore */ }
          }
        }
      }
    } catch (e) {
      try {
        const { appendFileSync } = await import('node:fs')
        appendFileSync('/Users/xi/.dsh/review/pre-execute-error.log',
          new Date().toISOString() + ' OUTER ' + (e && e.stack || e) + '\n')
      } catch { /* ignore */ }
    }
    return next()
  })

  // ── fs/observed: remember post-write versions for revert guards ───────────
  ctx.on('fs/observed', (target, observation) => {
    if (observation && observation.kind === 'present') {
      versionCache.set(String(target.targetKey), String(observation.version))
    }
  })

  // ── tools/result: journal committed changes and open Trae ─────────────────
  ctx.on('tools/result', (exec, result) => {
    if (!track.has(exec.name)) return
    void finalizeChange(exec, result).catch((error) => {
      logger.warn('finalize failed:', error && error.message || error)
    })
  })

  async function resolveTarget(filePath, signal) {
    try {
      const fs = fsx()
      if (!fs || typeof filePath !== 'string') return undefined
      return await fs.resolve(filePath, { signal })
    } catch {
      return undefined
    }
  }

  async function vfsWrite(filePath, text, signal) {
    const fs = fsx()
    const target = await fs.resolve(filePath, { signal })
    if (target) {
      await fs.writeText(target, String(text), undefined, signal)
    }
  }

  function dropPendingFor(filePath) {
    if (typeof filePath !== 'string') return
    void resolveTarget(filePath).then((target) => {
      if (target) pending.delete(String(target.targetKey))
    }).catch(() => { })
  }

  async function finalizeChange(exec, result) {
    if (result.isError) {
      dropPendingFor(exec.arguments && exec.arguments.file_path)
      return
    }
    const fs = fsx()
    if (!fs) return
    const value = result.value
    if (!value || typeof value.path !== 'string' || value.path === '') return

    const tool = exec.name
    const operation = value.operation === 'create' ? 'create' : 'update'

    // Full before/after come from the backend value (diff basis). before ===
    // null means create, or a file too large/binary for the backend to return.
    const before = value.before !== undefined && value.before !== null ? String(value.before) : null
    const after = value.after !== undefined && value.after !== null ? String(value.after) : null

    const rawPath = value.path
    const target = await resolveTarget(rawPath, exec.signal)
    const targetKey = target ? String(target.targetKey) : rawPath

    // NEW MODEL: the AI tool keeps the real file as its output (no OR
    // restore) - the AI must see its own writes for context on later
    // calls. The before snapshot is the review left side; the live file
    // is the right side. The VS Code extension owns the diff/undo.
    const pendingEntry = pending.get(targetKey) || pending.get(rawPath)
    pending.delete(targetKey)
    pending.delete(rawPath)
    const filePath = pendingEntry && pendingEntry.filePath ? pendingEntry.filePath : rawPath
    const workPath = pendingEntry && pendingEntry.workPath ? pendingEntry.workPath : null
    let version = versionCache.get(targetKey)
    versionCache.delete(targetKey)
    if (version === undefined && target) {
      try {
        const info = await fs.stat(target, exec.signal)
        if (info) version = String(info.version)
      } catch { /* version may stay unknown; revert then reverts unconditionally */ }
    }

    // Preview fallback when the backend could not return a full before.
    let beforeText = before
    if (beforeText === null && pendingEntry && pendingEntry.before !== undefined) {
      beforeText = pendingEntry.before
    }
    const previewOnly = beforeText !== null && before === null

    const id = newChangeId()
    const at = new Date().toISOString()
    const entry = buildEntry({
      id, at, tool,
      filePath,
      targetKey,
      operation,
      version,
      before: previewOnly ? null : beforeText,   // preview is never revert-safe
      after,
      workPath,
      maxSnapshotBytes: config.maxSnapshotBytes,
    })
    if (previewOnly) {
      // Store the truncated preview as the diff left side anyway.
      writeSnapshot(root, id, 'before', beforeText, config.maxSnapshotBytes)
    }
    // Tag this change with the session's workspace directory (session header
    // cwd, canonicalized). One dsh process can serve many workspaces, so
    // process.cwd() would mix them together.
    entry.workbenchId = workbenchIdOf(exec)

    const saved = saveEntry(root, entry, {
      before: previewOnly ? undefined : beforeText,
      after,
      maxSnapshotBytes: config.maxSnapshotBytes,
    })

    if (config.autoOpenDiff && (beforeText !== null || operation === 'create')) {
      if (operation === 'create' && beforeText === null) {
        writeSnapshot(root, id, 'before', '', config.maxSnapshotBytes)
      }
      const beforePath = snapshotPath(root, id, 'before')
      const res = await openDiff({
        traeCommand: config.traeCommand,
        beforePath,
        realPath: filePath,
        reuseWindow: config.reuseWindow,
      })
      if (res.ok) {
        updateEntry(root, id, { openedInTrae: true, traeResult: 'ok' })
      } else {
        updateEntry(root, id, { traeResult: { error: res.error } })
        logger.warn('trae diff open failed:', res.error)
      }
    }
    return saved
  }

  // The loader initializes entries in parallel, so the systemPrompt / tools
  // services may not be provided yet when apply() runs — register through
  // ctx.inject (same pattern as the built-in dsh plugins).
  ctx.inject(['systemPrompt', 'tools'], (scope) => {

    // ── tool: review_status ─────────────────────────────────────────────────
    scope.systemPrompt.section({
      name: 'tool:review',
      order: 121,
      text: 'A review layer journals every write/edit: use review_status to list and verify the AI changes (it re-reads each file and reports match/drifted/missing), review_revert to restore the pre-change snapshot content of one file (no git), and review_open to reopen its Trae diff.',
    })

    scope.tools.register({
      name: 'review_status',
      description: 'List AI file changes recorded by the review layer and verify they still match what was written (re-reads files; reports match/drifted/missing).',
      parameters: {
        file_path: { type: 'string', description: 'Limit to this file (absolute path or basename).' },
        limit: { type: 'number', description: 'Max entries, newest first (default 20, max 200).' },
        include_reverted: { type: 'boolean', description: 'Also list already-reverted changes (default false).' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            total: { type: 'number', required: true },
            entries: {
              type: 'array',
              required: true,
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  id: { type: 'string', required: true },
                  at: { type: 'string', required: true },
                  tool: { type: 'string', required: true },
                  file_path: { type: 'string', required: true },
                  operation: { type: 'string', required: true },
                  status: { type: 'string', required: true },
                  verified: { type: 'string', required: true },
                  additions: { type: 'number', required: true },
                  deletions: { type: 'number', required: true },
                  opened_in_trae: { type: 'boolean', required: true },
                },
              },
            },
          },
        },
        render: (_args, value) => [{ type: 'text', text: renderStatusText(value) }],
      },
      isConcurrencySafe: () => true,
      async execute(args) {
        const limit = Math.min(Math.max(Number.parseInt(args.limit, 10) || 20, 1), 200)
        const includeReverted = args.include_reverted === true
        const filePath = typeof args.file_path === 'string' && args.file_path !== '' ? args.file_path : undefined
        const entries = listEntries(root, { limit: 200, filePath })
          .filter((e) => includeReverted || e.status === 'committed')
          .slice(0, limit)
        const fs = fsx()
        const rows = []
        for (const e of entries) {
          rows.push({
            id: e.id,
            at: e.at,
            tool: e.tool,
            file_path: e.filePath,
            operation: e.operation,
            status: e.status,
            verified: fs ? await verifyEntry(fs, e) : 'unknown',
            additions: (e.stats && e.stats.additions) || 0,
            deletions: (e.stats && e.stats.deletions) || 0,
            opened_in_trae: e.openedInTrae === true,
          })
        }
        return { total: rows.length, entries: rows }
      },
    })

    async function verifyEntry(fs, entry) {
      if (entry.status === 'reverted') return 'reverted'
      if (!entry.afterAvailable) return 'unknown'
      const afterText = readSnapshot(root, entry.id, 'after')
      if (afterText === null) return 'unknown'
      let target
      try {
        target = await fs.resolve(entry.filePath)
      } catch {
        return 'missing'
      }
      let current = null
      try {
        const bytes = await fs.readBytes(target, undefined, Math.max(config.maxSnapshotBytes, Buffer.byteLength(afterText, 'utf8') + 1))
        current = decoder.decode(bytes)
      } catch {
        return 'missing'
      }
      return current === afterText ? 'match' : 'drifted'
    }

    // ── tool: review_revert ───────────────────────────────────────────────────
    scope.tools.register({
      name: 'review_revert',
      description: 'Restore the pre-change content of one file from its reviewed snapshot (no git). The revert is guarded by the fs version captured right after the AI write: if the file changed since, it refuses. For a file the AI created, it deletes that file.',
      parameters: {
        file_path: { type: 'string', required: true, description: 'The changed file to revert (absolute path or basename).' },
        change_id: { type: 'string', description: 'Pin the exact change id (from review_status); default is the newest committed change for the file.' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            id: { type: 'string', required: true },
            file_path: { type: 'string', required: true },
            operation: { type: 'string', required: true },
            status: { type: 'string', required: true },
            restored: { type: 'boolean', required: true },
            deleted: { type: 'boolean', required: false },
          },
        },
        render: (_args, value) => [{
          type: 'text',
          text: value.deleted
            ? `Reverted change ${value.id}: deleted the file the AI created (${value.file_path}).`
            : `Reverted change ${value.id}: restored ${value.file_path} to its pre-change content.`,
        }],
      },
      isConcurrencySafe: () => false,
      async execute(args, exec) {
        if (typeof args.file_path !== 'string' || args.file_path === '') {
          throw new Error('file_path is required')
        }
        const entry = findActionableEntry(root, {
          changeId: typeof args.change_id === 'string' && args.change_id ? args.change_id : undefined,
          filePath: args.file_path,
        })
        if (!entry) {
          throw new Error('no reviewed change found for ' + args.file_path + ' (run review_status first)')
        }
        if (entry.status === 'reverted') {
          throw new Error('change ' + entry.id + ' is already reverted')
        }
        const fs = fsx()
        if (!fs) throw new Error('fs service unavailable')

        if (entry.operation === 'create') {
          // Created by the AI → delete the file (fs has no delete primitive).
          const target = await fs.resolve(entry.filePath)
          const procPath = fs.processPath ? fs.processPath(target) : entry.filePath
          if (existsSync(procPath)) {
            try {
              unlinkSync(procPath)
            } catch (error) {
              throw new Error('failed to delete created file: ' + (error && error.message || error))
            }
          }
          updateEntry(root, entry.id, { status: 'reverted', revertedAt: new Date().toISOString() })
          if (config.openOnRevert) {
            void openFile({
              traeCommand: config.traeCommand,
              realPath: entry.filePath,
              reuseWindow: config.reuseWindow,
            }).catch(() => { })
          }
          return { id: entry.id, file_path: entry.filePath, operation: 'create', status: 'reverted', restored: true, deleted: true }
        }

        if (!entry.beforeAvailable) {
          throw new Error('before snapshot unavailable for change ' + entry.id +
            ' (file too large or non-text) — cannot auto-revert')
        }
        const beforeText = readSnapshot(root, entry.id, 'before')
        if (beforeText === null) {
          throw new Error('before snapshot file missing for change ' + entry.id)
        }
        const target = await fs.resolve(entry.filePath)
        const intent = entry.version
          ? { kind: 'replaceIfVersion', version: entry.version }
          : undefined
        let outcome
        try {
          outcome = await fs.writeText(target, beforeText, intent, exec.signal)
        } catch (error) {
          if (error && error.code === 'FS_STALE_VERSION') {
            throw new Error('the file changed after the AI write (fs version mismatch) — refrained from overwriting; review manually')
          }
          throw error
        }
        updateEntry(root, entry.id, { status: 'reverted', revertedAt: new Date().toISOString() })
        if (config.openOnRevert) {
          const afterPath = snapshotPath(root, entry.id, 'after')
          void (existsSync(afterPath)
            ? openDiff({
              traeCommand: config.traeCommand,
              beforePath: afterPath,
              realPath: entry.filePath,
              reuseWindow: config.reuseWindow,
            })
            : openFile({
              traeCommand: config.traeCommand,
              realPath: entry.filePath,
              reuseWindow: config.reuseWindow,
            })
          ).catch(() => { })
        }
        return { id: entry.id, file_path: entry.filePath, operation: entry.operation, status: 'reverted', restored: true }
      },
    })

    // ── tool: review_open ─────────────────────────────────────────────────────
    scope.tools.register({
      name: 'review_open',
      description: 'Reopen the Trae diff view for a recorded change (left = before snapshot, right = current file).',
      parameters: {
        file_path: { type: 'string', description: 'The changed file to open (absolute path or basename).' },
        change_id: { type: 'string', description: 'Pin the exact change id (from review_status); default is the newest change for the file.' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            id: { type: 'string', required: true },
            file_path: { type: 'string', required: true },
            opened: { type: 'boolean', required: true },
          },
        },
        render: (_args, value) => [{ type: 'text', text: value.opened ? 'Opened diff for ' + value.id : 'Failed to open diff for ' + value.id }],
      },
      isConcurrencySafe: () => true,
      async execute(args) {
        const filePath = typeof args.file_path === 'string' && args.file_path !== '' ? args.file_path : undefined
        const changeId = typeof args.change_id === 'string' && args.change_id !== '' ? args.change_id : undefined
        const entry = findActionableEntry(root, { changeId, filePath })
        if (!entry) throw new Error('no reviewed change found (run review_status first)')
        let beforePath = snapshotPath(root, entry.id, 'before')
        if (!existsSync(beforePath)) {
          if (entry.operation === 'create') {
            writeSnapshot(root, entry.id, 'before', '', config.maxSnapshotBytes)
            beforePath = snapshotPath(root, entry.id, 'before')
          } else {
            beforePath = undefined
          }
        }
        let res
        if (beforePath) {
          res = await openDiff({
            traeCommand: config.traeCommand,
            beforePath,
            realPath: entry.filePath,
            reuseWindow: config.reuseWindow,
          })
        } else {
          res = await openFile({
            traeCommand: config.traeCommand,
            realPath: entry.filePath,
            reuseWindow: config.reuseWindow,
          })
        }
        if (res.ok) updateEntry(root, entry.id, { openedInTrae: true, traeResult: 'ok' })
        else updateEntry(root, entry.id, { traeResult: { error: res.error } })
        return { id: entry.id, file_path: entry.filePath, opened: res.ok }
      },
    })
  })

  // Avoid an unused-import surprise: resolveTraeCommand is also used for the
  // preflight check below (kept cheap — no process spawn).
  resolveTraeCommand(config.traeCommand)

  ctx.effect(() => () => {
    pending.clear()
    versionCache.clear()
  })
}

function renderStatusText(value) {
  const lines = []
  lines.push('dsh review — ' + value.total + ' change(s)')
  if (value.total === 0) lines.push('(no reviewed changes)')
  for (const e of value.entries) {
    const mark = e.verified === 'match' ? '✓' : e.status === 'reverted' ? '↩' : e.verified === 'drifted' ? '⚠' : e.verified === 'missing' ? '✗' : '?'
    const sign = '+' + e.additions + ' -' + e.deletions
    lines.push(mark + ' ' + e.at + ' [' + e.tool + (e.operation === 'create' ? '/create' : '') + '] ' + sign + ' ' + e.file_path + ' — ' + e.status + (e.verified && e.verified !== 'unknown' ? '/' + e.verified : ''))
  }
  return lines.join('\n')
}

export default { name, apply }
