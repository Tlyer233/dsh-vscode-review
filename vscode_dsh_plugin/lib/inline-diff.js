'use strict'

/**
 * dsh-review-vscode — line diff for inline (Copilot-style) review UI.
 *
 * Pure logic: splits before/after texts into changed hunks so the extension
 * can decorate the changed lines and attach accept/reject buttons. No
 * dependencies. Uses the classic Myers shortest-edit-script algorithm:
 * O((N+M)·D) time (near-linear for small, local AI edits) instead of the
 * previous O(N·M) LCS DP.
 */

/**
 * Compute changed hunks between two texts.
 * @param beforeText string|null (null = whole file was created)
 * @param afterText string
 * @returns [{ beforeStart, beforeCount, afterStart, afterCount }]
 *          (beforeStart=-1/beforeCount=0 means whole-file create hunk)
 */
function diffHunks(beforeText, afterText) {
  if (beforeText === null || beforeText === undefined) {
    const n = countLines(afterText)
    return n > 0 ? [{ beforeStart: -1, beforeCount: 0, afterStart: 0, afterCount: n }] : []
  }
  const a = splitLines(beforeText)
  const b = splitLines(afterText)
  return myersHunks(a, b)
}

/** Split text into lines (no trailing empty entry). */
function splitLines(text) {
  const out = String(text).split(/\r?\n/)
  if (out.length > 0 && out[out.length - 1] === '') out.pop()
  return out
}

function countLines(text) {
  return splitLines(text).length
}

// ── Myers shortest edit script ──────────────────────────────────────────────

function myersHunks(a, b) {
  const n = a.length
  const m = b.length
  if (n === 0 && m === 0) return []
  if (n === 0) return [{ beforeStart: 0, beforeCount: 0, afterStart: 0, afterCount: m }]
  if (m === 0) return [{ beforeStart: 0, beforeCount: n, afterStart: 0, afterCount: 0 }]

  const max = n + m
  const offset = max + 1
  const size = 2 * max + 3
  const v = new Int32Array(size)
  const trace = []

  let d = 0
  for (; d <= max; d++) {
    trace.push(Int32Array.from(v))
    for (let k = -d; k <= d; k += 2) {
      let x
      if (k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1])) {
        x = v[offset + k + 1]
      } else {
        x = v[offset + k - 1] + 1
      }
      let y = x - k
      while (x < n && y < m && a[x] === b[y]) {
        x++
        y++
      }
      v[offset + k] = x
      if (x >= n && y >= m) {
        return opsToHunks(backtrack(trace, n, m, offset))
      }
    }
  }
  // Unreachable for sane inputs; safe fallback.
  return [{ beforeStart: 0, beforeCount: n, afterStart: 0, afterCount: m }]
}

/** Reconstruct the edit script: -1 = delete from before, 1 = insert after, 0 = equal. */
function backtrack(trace, n, m, offset) {
  const rev = []
  let x = n
  let y = m
  for (let d = trace.length - 1; d > 0; d--) {
    const V = trace[d]
    const k = x - y
    let prevK
    if (k === -d || (k !== d && V[offset + k - 1] < V[offset + k + 1])) {
      prevK = k + 1
    } else {
      prevK = k - 1
    }
    const prevX = V[offset + prevK]
    const prevY = prevX - prevK
    while (x > prevX && y > prevY) {
      rev.push(0) // equal line
      x--
      y--
    }
    if (x === prevX) {
      rev.push(1) // insert from b
      y--
    } else {
      rev.push(-1) // delete from a
      x--
    }
  }
  while (x > 0 && y > 0) {
    rev.push(0)
    x--
    y--
  }
  while (x > 0) {
    rev.push(-1)
    x--
  }
  while (y > 0) {
    rev.push(1)
    y--
  }
  return rev.reverse()
}

/** Collapse the edit script into changed line hunks. */
function opsToHunks(ops) {
  const hunks = []
  let i = 0 // before line cursor
  let j = 0 // after line cursor
  let p = 0
  while (p < ops.length) {
    if (ops[p] === 0) {
      let count = 0
      while (p < ops.length && ops[p] === 0) {
        count++
        p++
      }
      i += count
      j += count
      continue
    }
    const hunk = {
      beforeStart: i,
      beforeCount: 0,
      afterStart: j,
      afterCount: 0,
    }
    while (p < ops.length && ops[p] !== 0) {
      if (ops[p] === -1) {
        hunk.beforeCount++
        i++
      } else {
        hunk.afterCount++
        j++
      }
      p++
    }
    hunks.push(hunk)
  }
  return hunks
}

/** Whole-file helper: before/after line arrays for one hunk. */
function describeHunk(beforeText, afterText, h) {
  const bLines = beforeText === null ? [] : splitLines(beforeText)
  const aLines = splitLines(afterText)
  return {
    hunk: h,
    beforeLines: h.beforeStart < 0 ? [] : bLines.slice(h.beforeStart, h.beforeStart + h.beforeCount),
    afterLines: aLines.slice(h.afterStart, h.afterStart + h.afterCount),
  }
}

/** Join lines back, preserving the target text's trailing-newline shape. */
function joinPreservingEol(lines, eolSourceText) {
  const trailing = typeof eolSourceText === 'string' && eolSourceText.endsWith('\n')
  return lines.join('\n') + (trailing || lines.length === 0 ? '\n' : '')
}

/** Build a new after-text with one hunk returned to its before content (reject). */
function rejectHunk(beforeText, afterText, h) {
  const a = splitLines(afterText)
  const b = beforeText === null ? [] : splitLines(beforeText)
  if (h.beforeCount === 0) {
    a.splice(h.afterStart, h.afterCount)
  } else if (h.afterCount === 0) {
    a.splice(h.afterStart, 0, ...b.slice(h.beforeStart, h.beforeStart + h.beforeCount))
  } else {
    a.splice(h.afterStart, h.afterCount, ...b.slice(h.beforeStart, h.beforeStart + h.beforeCount))
  }
  return joinPreservingEol(a, afterText)
}

/** Build a new before-text with one hunk accepted (before absorbs the after block). */
function acceptHunk(beforeText, afterText, h) {
  const a = splitLines(afterText)
  const b = beforeText === null ? [] : splitLines(beforeText)
  if (h.afterCount === 0) {
    // Pure deletion: absorbing it means REMOVING those rows from the
    // baseline too, otherwise the hunk keeps reappearing in every diff.
    const bb = splitLines(beforeText || '')
    bb.splice(h.beforeStart < 0 ? 0 : h.beforeStart, h.beforeCount)
    return joinPreservingEol(bb, beforeText || '')
  }
  const block = a.slice(h.afterStart, h.afterStart + h.afterCount)
  if (beforeText === null) {
    return joinPreservingEol(block, afterText)
  }
  b.splice(h.beforeStart < 0 ? 0 : h.beforeStart, h.beforeCount, ...block)
  return joinPreservingEol(b, beforeText)
}

/** Lines removed by a hunk (for red deletion display); [] when none. */
function removedLinesForHunk(beforeText, h) {
  if (beforeText === null || h.beforeStart < 0 || h.beforeCount === 0) return []
  const b = splitLines(beforeText)
  return b.slice(h.beforeStart, h.beforeStart + h.beforeCount)
}

module.exports = { diffHunks, splitLines, countLines, describeHunk, rejectHunk, acceptHunk, removedLinesForHunk }
