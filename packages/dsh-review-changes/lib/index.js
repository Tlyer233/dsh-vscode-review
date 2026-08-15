// dsh-review-changes host entry: review changes API
//
// Review Changes is WORKBENCH-level state:
//   workbench = the dsh Workspace directory the CURRENT session belongs to
//   session   = one conversation inside that workspace (may span days)
//   round     = one user message -> AI reply (AI may write/edit files)
//
// Every change is stored globally in ~/.dsh/review/changes and tagged with
// entry.workbenchId (the session header cwd) by the dsh-review plugin. The
// client tells this API which workspace the open session belongs to, so
// different workspaces in the same dsh web process get different lists.
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const { execFile, exec } = require('node:child_process')

const name = 'review-changes'
const inject = ['webServer']
const CODE_CLI = '/usr/local/bin/code'

function defaultStoreDir() {
  const home = process.env.DSH_HOME?.trim() || os.homedir()
  const base = process.env.DSH_HOME?.trim() ? home : path.join(home, '.dsh')
  return path.join(base, 'review', 'changes')
}

function canonicalPath(p) {
  try { return fs.realpathSync.native(String(p)) } catch { return path.resolve(String(p)) }
}

/**
 * The workbench the panel must show. The client passes the path of the
 * workspace the current session belongs to; fall back to process.cwd() for
 * old clients / sessions without a workspace record.
 */
function workbenchFromRequest(req) {
  let requested = ''
  try {
    const url = new URL(req.url, 'http://127.0.0.1')
    requested = url.searchParams.get('workbench') || ''
  } catch { /* noop */ }
  return canonicalPath(requested || process.cwd())
}

// ── Minimal diffHunks (LCS, same as inline-diff.js) ────────────────────────
const MAX_DP = 4000 * 4000
function splitLines(text) {
  const out = String(text).split(/\r?\n/)
  if (out.length > 0 && out[out.length - 1] === '') out.pop()
  return out
}
function computeLcs(a, b) {
  const n = a.length, m = b.length
  const dp = new Uint32Array((n + 1) * (m + 1))
  for (let i = 0; i < n; i++) {
    const row = (i + 1) * (m + 1), prev = i * (m + 1), ai = a[i]
    for (let j = 0; j < m; j++) {
      dp[row + j + 1] = ai === b[j] ? dp[prev + j] + 1 : Math.max(dp[prev + j + 1], dp[row + j])
    }
  }
  const out = []; let i = n, j = m
  while (i > 0 && j > 0) {
    if (a[i - 1] === b[j - 1]) { out.push([i - 1, j - 1]); i--; j-- }
    else if (dp[(i - 1) * (m + 1) + j] >= dp[i * (m + 1) + (j - 1)]) i--
    else j--
  }
  out.reverse(); return out
}
function diffHunks(beforeText, afterText) {
  if (beforeText == null) {
    const n = splitLines(afterText).length
    return n > 0 ? [{ beforeStart: -1, beforeCount: 0, afterStart: 0, afterCount: n }] : []
  }
  const a = splitLines(beforeText), b = splitLines(afterText)
  if (a.length * b.length > MAX_DP) return [{ beforeStart: 0, beforeCount: a.length, afterStart: 0, afterCount: b.length }]
  const lcs = computeLcs(a, b)
  const hunks = []; let i = 0, j = 0, hb = -1, ha = -1, hbn = 0, han = 0
  const flush = () => { if (hbn > 0 || han > 0) { hunks.push({ beforeStart: hb, beforeCount: hbn, afterStart: ha, afterCount: han }); hb = -1; ha = -1; hbn = 0; han = 0 } }
  for (const pair of lcs) {
    while (i < pair[0]) { if (hbn === 0 && han === 0) { hb = i; ha = j }; hbn++; i++ }
    while (j < pair[1]) { if (hbn === 0 && han === 0) { hb = i; ha = j }; han++; j++ }
    i++; j++; if (hbn > 0 || han > 0) flush()
  }
  while (i < a.length) { if (hbn === 0 && han === 0) { hb = i; ha = j }; hbn++; i++ }
  while (j < b.length) { if (hbn === 0 && han === 0) { hb = i; ha = j }; han++; j++ }
  flush(); return hunks
}
// ────────────────────────────────────────────────────────────────────────────

function sendJson(res, code, value) {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'access-control-allow-origin': '*' })
  res.end(JSON.stringify(value))
}

function openInVSCode(filePath) {
  return new Promise((resolve) => {
    const resolved = path.resolve(filePath)
    // Open through the extension's URI handler: it forces a TEXT editor even
    // for files VS Code would normally open as an image/preview (e.g. .svg),
    // then attaches the pending inline review.
    const vscodeUri = 'vscode://dsn.dsh-review-vscode/review?file=' + encodeURIComponent(resolved)
    execFile(CODE_CLI, ['--open-url', vscodeUri], { timeout: 5000 }, (err1) => {
      if (!err1) return resolve({ ok: true, method: 'uri' })
      exec('open ' + JSON.stringify(vscodeUri), { timeout: 5000 }, (err2) => {
        if (!err2) return resolve({ ok: true, method: 'open-url' })
        resolve({ ok: false, error: (err1?.message || '') + ' / ' + (err2?.message || '') })
      })
    })
  })
}

/** Ask the VSCode extension to run one file-level verdict per listed file. */
function batchVerdictInVSCode(filePaths, action) {
  return new Promise((resolve) => {
    const files = filePaths.map((p) => path.resolve(p))
    const payload = Buffer.from(JSON.stringify({ files })).toString('base64url')
    const vscodeUri = 'vscode://dsn.dsh-review-vscode/review?action=' + action + '&batch=' + payload
    execFile(CODE_CLI, ['--open-url', vscodeUri], { timeout: 10000 }, (err1) => {
      if (!err1) return resolve({ ok: true, method: 'uri' })
      exec('open ' + JSON.stringify(vscodeUri), { timeout: 10000 }, (err2) => {
        if (!err2) return resolve({ ok: true, method: 'open-url' })
        resolve({ ok: false, error: (err1?.message || '') + ' / ' + (err2?.message || '') })
      })
    })
  })
}

function readJson(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')) } catch { return null }
}

/** VSCode ReviewCore persistence: `<id>.core` = { id, original, modified }. */
function readCore(storeDir, id) {
  const value = readJson(path.join(storeDir, String(id) + '.core'))
  if (!value || value.id !== String(id)) return null
  if (typeof value.original !== 'string') return null
  return value
}

/**
 * Pure computation: entries for the current workbench that still have
 * unreviewed hunks. Exported for tests.
 */
function computeReviewEntries(storeDir, workbench) {
  let names = []
  try { names = fs.readdirSync(storeDir).filter(n => n.endsWith('.json')) } catch {}

  // 1. Strict workbench isolation. Legacy entries without workbenchId are
  //    deliberately hidden everywhere (they predate workbench tagging).
  //    Keep ALL statuses here: the newest entry decides whether the file is
  //    pending. Never fall back to an older committed entry after the newest
  //    one was accepted/reverted — that is what made reviewed files reappear.
  const byFile = new Map()
  for (const n of names) {
    const e = readJson(path.join(storeDir, n))
    if (!e || !e.filePath) continue
    if (typeof e.workbenchId !== 'string' || !e.workbenchId) continue
    if (canonicalPath(e.workbenchId) !== canonicalPath(workbench)) continue
    const key = path.resolve(e.filePath)
    if (!byFile.has(key)) byFile.set(key, [])
    byFile.get(key).push(e)
  }

  const results = []
  for (const [filePath, entries] of byFile) {
    entries.sort((a, b) => String(b.at || '').localeCompare(String(a.at || '')))
    const newest = entries[0]

    // File-level gate, identical to VSCode findEntryForFile: only the
    // newest entry counts. Accepted/reverted newest entry -> file hidden.
    if (newest.status !== 'committed') continue

    // 2. Baseline = VSCode ReviewCore.original when this entry was reviewed
    //    with the new core; otherwise the newest committed entry's own .before
    //    (create -> empty baseline). This is what keeps the panel and the
    //    inline editor showing the same hunks.
    const core = readCore(storeDir, newest.id)
    let beforeText
    let coreUsed = false
    if (core) {
      beforeText = core.original
      coreUsed = true
    } else {
      const beforePath = path.join(storeDir, newest.id + '.before')
      if (fs.existsSync(beforePath)) {
        beforeText = fs.readFileSync(beforePath, 'utf8')
      } else if (newest.operation === 'create') {
        beforeText = ''
      } else {
        continue
      }
    }

    // 3. Current file from disk. Missing files are skipped until the
    //    extension supports inline review for deletions — never show a file
    //    that cannot actually be AC/RJ-ed.
    let currentText
    try { currentText = fs.readFileSync(filePath, 'utf8') } catch { continue }

    const totalHunks = diffHunks(beforeText, currentText)
    if (totalHunks.length === 0) continue

    // 4. Core baseline already absorbed accepted hunks, so every diff hunk
    //    is unreviewed. Legacy no-core entries use the old decisions fallback
    //    so pre-core review data stays hidden.
    let unreviewed = totalHunks
    if (!coreUsed) {
      const reviewed = new Set()
      const decs = readJson(path.join(storeDir, newest.id + '.decisions.json'))
      if (Array.isArray(decs)) {
        for (const d of decs) {
          if (typeof d?.text === 'string' && d.text) reviewed.add(d.text)
          if (typeof d?.bt === 'string' && d.bt) reviewed.add(d.bt)
        }
      }
      const docLines = splitLines(currentText)
      const blines = splitLines(beforeText)
      unreviewed = totalHunks.filter(h => {
        const afterBlock = h.afterCount > 0 ? docLines.slice(h.afterStart, h.afterStart + h.afterCount).join('\n') : ''
        const beforeBlock = h.beforeCount > 0 ? blines.slice(h.beforeStart, h.beforeStart + h.beforeCount).join('\n') : ''
        if (afterBlock && reviewed.has(afterBlock)) return false
        if (beforeBlock && reviewed.has(beforeBlock)) return false
        return true
      })
    }
    if (unreviewed.length === 0) continue

    let additions = 0, deletions = 0
    for (const h of unreviewed) {
      additions += h.afterCount
      deletions += h.beforeCount
    }

    results.push({
      id: newest.id,
      filePath: newest.filePath,
      operation: newest.operation || 'update',
      additions,
      deletions,
      totalHunks: totalHunks.length,
      unreviewedHunks: unreviewed.length,
      fileExists: true,
      at: newest.at || '',
      workbenchId: newest.workbenchId,
    })
  }

  results.sort((a, b) => String(b.at).localeCompare(String(a.at)))
  return results
}

function apply(ctx) {
  const webServer = ctx.get('webServer')
  const storeDir = defaultStoreDir()

  // API: review changes — files that still have hunks needing AC/RJ.
  ctx.effect(() => webServer.register({
    kind: 'exact',
    path: '/api/review/changes',
    handler: async (req, res) => {
      if (req.method !== 'GET') { res.writeHead(405); res.end(); return }
      try {
        const workbench = workbenchFromRequest(req)
        sendJson(res, 200, { workbench, entries: computeReviewEntries(storeDir, workbench) })
      } catch (err) {
        sendJson(res, 500, { error: String(err?.message || err) })
      }
    },
  }), 'review-changes: API route')

  // API: open file in VS Code
  ctx.effect(() => webServer.register({
    kind: 'exact',
    path: '/api/review/open-file',
    handler: async (req, res) => {
      if (req.method !== 'POST') { res.writeHead(405); res.end(); return }
      try {
        let body = ''
        for await (const chunk of req) body += chunk
        const { filePath } = JSON.parse(body)
        if (!filePath || typeof filePath !== 'string') { sendJson(res, 400, { error: 'filePath required' }); return }
        const resolved = path.resolve(filePath)
        if (!fs.existsSync(resolved)) { sendJson(res, 404, { error: 'file not found' }); return }
        const result = await openInVSCode(resolved)
        sendJson(res, result.ok ? 200 : 500, result)
      } catch (err) {
        sendJson(res, 500, { error: String(err?.message || err) })
      }
    },
  }), 'review-changes: open-file route')

  // API: batch verdict for the files currently shown in the panel.
  ctx.effect(() => webServer.register({
    kind: 'exact',
    path: '/api/review/batch',
    handler: async (req, res) => {
      if (req.method !== 'POST') { res.writeHead(405); res.end(); return }
      try {
        let body = ''
        for await (const chunk of req) body += chunk
        const { action, filePaths } = JSON.parse(body)
        if (action !== 'acceptAll' && action !== 'rejectAll') { sendJson(res, 400, { error: 'action must be acceptAll|rejectAll' }); return }
        if (!Array.isArray(filePaths) || filePaths.length === 0) { sendJson(res, 400, { error: 'filePaths required' }); return }
        const result = await batchVerdictInVSCode(filePaths.filter((p) => typeof p === 'string'), action)
        sendJson(res, result.ok ? 200 : 500, result)
      } catch (err) {
        sendJson(res, 500, { error: String(err?.message || err) })
      }
    },
  }), 'review-changes: batch route')
}

module.exports = { name, inject, apply, computeReviewEntries }
