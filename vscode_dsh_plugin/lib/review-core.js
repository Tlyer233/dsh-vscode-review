'use strict'

/**
 * dsh-review-vscode — Copilot-style dual-model review core.
 *
 * Pure Node CJS; no `vscode` import. This module owns the two texts that
 * Copilot's chat editing keeps per file:
 *
 *   originalText  — the accepted baseline (pre-AI content, advanced as hunks
 *                   are accepted)
 *   modifiedText  — the working document (AI output + user edits)
 *
 * The visible review is always diff(originalText, modifiedText):
 *
 *   acceptHunk  -> apply the modified block INTO originalText
 *   rejectHunk  -> apply the original block BACK INTO modifiedText
 *   acceptAll   -> originalText := modifiedText
 *   rejectAll   -> modifiedText := originalText
 *
 * This is the same semantics as VS Code's ChatEditingTextModelChangeService
 * (keep/undo per hunk), reduced to line hunks for now. It replaces the
 * decisions.json content-matching path: after an action the diff is simply
 * recomputed, so accepted hunks disappear naturally and rejected hunks leave
 * the document in the accepted state.
 *
 * Persistence is the caller's responsibility (see review-session.js).
 */

const { diffHunks, acceptHunk, rejectHunk } = require('./inline-diff')

class ReviewCore {
  /**
   * @param {{id?: string, original?: string, modified?: string}} [opts]
   */
  constructor(opts = {}) {
    this.id = opts.id !== undefined && opts.id !== null ? String(opts.id) : null
    this.originalText = opts.original === undefined || opts.original === null ? '' : String(opts.original)
    this.modifiedText = opts.modified === undefined || opts.modified === null ? '' : String(opts.modified)
  }

  /** Current visible hunks: diff(original, modified). */
  hunks() {
    return diffHunks(this.originalText, this.modifiedText)
  }

  /** True when there is nothing left to review. */
  get done() {
    return this.hunks().length === 0
  }

  _hunk(index) {
    if (!Number.isInteger(index) || index < 0) return null
    const hunks = this.hunks()
    if (index >= hunks.length) return null
    return hunks[index]
  }

  /**
   * Accept one hunk: baseline absorbs the modified block.
   * Returns { hunk, remaining } or null for a stale/invalid index.
   */
  acceptHunk(index) {
    const h = this._hunk(index)
    if (!h) return null
    this.originalText = acceptHunk(this.originalText, this.modifiedText, h)
    return { hunk: h, remaining: this.hunks() }
  }

  /**
   * Reject one hunk: the document gets the original block back.
   * Returns { hunk, remaining } or null for a stale/invalid index.
   */
  rejectHunk(index) {
    const h = this._hunk(index)
    if (!h) return null
    this.modifiedText = rejectHunk(this.originalText, this.modifiedText, h)
    return { hunk: h, remaining: this.hunks() }
  }

  /** Keep the whole file: baseline becomes the modified document. */
  acceptAll() {
    this.originalText = this.modifiedText
    return this.hunks()
  }

  /** Undo the whole file: document returns to the baseline. */
  rejectAll() {
    this.modifiedText = this.originalText
    return this.hunks()
  }

  toJSON() {
    return { id: this.id, original: this.originalText, modified: this.modifiedText }
  }

  static fromJSON(value) {
    if (!value || typeof value !== 'object') return null
    return new ReviewCore({
      id: value.id,
      original: value.original,
      modified: value.modified,
    })
  }
}

module.exports = { ReviewCore } 
