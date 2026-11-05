'use strict'

/**
 * Workbench-side observer for the Copilot chat input (Comment on Elements).
 *
 * Injected into the VS Code WORKBENCH DOM via CDP (the extension host cannot
 * reach the workbench DOM directly). It is EVENT-DRIVEN (MutationObserver,
 * no polling) and beacons the full chip+line state to the extension via
 * `console.log('__DSH_ANNO_WB__' + JSON)`, which the extension captures with
 * CDP Runtime.consoleAPICalled.
 *
 * Key facts (live-verified, see probe/v34):
 *  - The chat widget is EPHEMERAL: `.chat-attachments-container` only exists
 *    in the DOM while the chat panel is rendered. The observer must therefore
 *    watch the document for the container's appearance and re-attach.
 *  - Element chip: `.chat-attached-context-attachment.show-file-icons` with
 *    aria-label "Attached element, <name> (Delete)"; its ✕ is
 *    `a.monaco-button.codicon-close-compact` (aria "Remove from context").
 *    Clicking it fires the native `_onDidDelete` → `attachmentModel.delete`
 *    → the `@<name> <text>` line is removed → the page pin is removed/renumbered.
 *  - Suggested browser chip (NOT an annotation): aria-label starts
 *    "Suggested browser context" — excluded.
 *  - Comment text line: `.interactive-input-editor .view-line` with text
 *    `@<name> <text>`.
 *
 * The script is self-contained (no require/process/electron in the workbench
 * JS context) and idempotent (re-injection re-arms rather than duplicates).
 */

/**
 * @returns {string} The IIFE source to evaluate in the workbench page context.
 */
function observerSource() {
  return `
(function () {
  'use strict';
  var PREFIX = '__DSH_ANNO_WB__';
  var DEBOUNCE_MS = 120;

  // (2.1.13) WINDOW IDENTITY IN EVERY LINE. Multi-window attribution was
  // guesswork: the log says which exthost wrote a line, but NOT which workbench
  // page the observer actually lives in (2.1.3 matches windows by host:port, and
  // two SSH windows behind one forwarded port collide). document.title carries
  // the folder plus the [SSH: host] suffix -> stamp it into every beacon and into
  // getState(); the extension side echoes it into beacon / dock / send lines.
  var WIN = '?';
  try { WIN = String(document.title || '?').replace(/\s+/g, ' ').slice(0, 90); } catch (e) {}

  function beacon(o) { try { console.log(PREFIX + JSON.stringify(o)); } catch (e) {} }

  // ---- idempotency: re-arm on re-injection, never duplicate observers ----
  if (window.__dshAnnoWb && typeof window.__dshAnnoWb.reinstall === 'function') {
    if (window.__dshAnnoWb._version === 3) {
      window.__dshAnnoWb.reinstall();
      return 'reinstalled';
    }
    // (0.1.115) version upgrade: detach the old widget observers, then fall
    // through and build the v2 closure fresh (the old docObserver may still
    // fire duplicate beacons until the window reloads — harmless).
    try { window.__dshAnnoWb.reinstall(); } catch (e) {}
    try { window.__dshAnnoWb = undefined; } catch (e) {}
  }

  var chipObserver = null;   // MutationObserver on .chat-attachments-container
  var lineObserver = null;   // MutationObserver on .interactive-input-editor
  var docObserver = null;    // MutationObserver on document (container appear/disappear)
  var attachedCont = null;   // (0.1.115) the container node chipObserver is bound to
  var debounceTimer = null;
  var armed = false;
  var lastChipCount = -1;    // previous beacon's chip count (for immediate-beacon on add)
  var lastBeaconKey = '';    // (0.1.116) last beaconed state key (dedupe identical beacons)

  function chipContainer() { return document.querySelector('.chat-attachments-container'); }
  function inputEditor() { return document.querySelector('.interactive-input-editor'); }

  // ---- state extraction ----
  function readChips() {
    var cont = chipContainer();
    if (!cont) return [];
    var out = [];
    var chips = cont.querySelectorAll('.chat-attached-context-attachment');
    for (var i = 0; i < chips.length; i++) {
      var c = chips[i];
      var aria = c.getAttribute('aria-label') || '';
      // (0.1.184) CLEAR-EVERYTHING rule: ALL real attachments are tracked now —
      // element / file (incl. code-snippet ranges) / image / context (terminal
      // selection). 'Suggested ...' hints stay excluded. kind rides along.
      var PREFIX = [['Attached element,', 'element'], ['Attached file,', 'file'], ['Attached image,', 'image'], ['Attached context,', 'generic']];
      var kind = null, rest = '';
      for (var q = 0; q < PREFIX.length; q++) {
        if (aria.indexOf(PREFIX[q][0]) === 0) { kind = PREFIX[q][1]; rest = aria.slice(PREFIX[q][0].length); break; }
      }
      if (!kind) {
        if (aria.indexOf('Suggested') === 0) continue;
        if (aria.indexOf('(Delete)') === -1) continue;
        kind = 'other'; rest = aria;
      }
      var name = rest.replace(/ \\(Delete\\)$/, '').trim();
      var x = c.querySelector('a.monaco-button.codicon-close-compact, a.codicon-close-compact');
      out.push({ name: name, aria: aria, kind: kind, hasX: !!x });
    }
    return out;
  }

  function readLines() {
    var ed = inputEditor();
    if (!ed) return [];
    var out = [];
    var lines = ed.querySelectorAll('.view-line');
    for (var i = 0; i < lines.length; i++) {
      var t = (lines[i].textContent || '').replace(/\\u00a0/g, ' ');
      var m = /^@(\\S+)\\s*(.*)$/.exec(t);
      if (!m) continue; // only annotation reference lines (@name text)
      out.push({ ref: m[1], text: (m[2] || '').trim() });
    }
    return out;
  }

  function snapshot() { return { chips: readChips(), lines: readLines() }; }

  function doBeacon() {
    var s = snapshot();
    lastChipCount = s.chips.length;
    // (0.1.116) Dedupe: Monaco repaints / container re-arms fire scheduleBeacon
    // over and over with IDENTICAL state (the 23:39 log showed 18x the same
    // chips=[] lines=[...]). Identical beacons are noise AND, worse, each one
    // reset the extension's 2.5s flash-back debounce, so the view NEVER
    // returned to dsh ("打开copilot不闪回"). Only beacon on real change.
    var key = '';
    for (var ci = 0; ci < s.chips.length; ci++) key += s.chips[ci].name + ',';
    key += '|';
    for (var li = 0; li < s.lines.length; li++) key += s.lines[li].ref + '=' + s.lines[li].text + ',';
    if (key === lastBeaconKey) return;
    lastBeaconKey = key;
    // Diagnostic: timestamp + chip names so the extension log shows the exact
    // beacon sequence (which beacons have chips, which don't, and the timing).
    beacon({ ev: 'state', win: WIN, chips: s.chips, lines: s.lines, t: Date.now() });
  }

  function scheduleBeacon() {
    // TIMING FIX: when a chip is ADDED (count goes up), beacon immediately —
    // the Copilot chat widget is ephemeral (panel switch destroys it), so waiting
    // for the 120ms debounce risks the beacon firing AFTER the widget is gone
    // (beaconing "no chips"). Adds are the critical event; deletes/line-changes
    // can wait for the debounce.
    var nowCount = (chipContainer() ? chipContainer().querySelectorAll('.chat-attached-context-attachment').length : 0);
    if (lastChipCount >= 0 && nowCount > lastChipCount) {
      if (debounceTimer) { clearTimeout(debounceTimer); debounceTimer = null; }
      doBeacon();
      return;
    }
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(function () {
      debounceTimer = null;
      doBeacon();
    }, DEBOUNCE_MS);
  }

  // ---- per-widget observers (re-attached when the widget re-renders) ----
  function attachWidgetObservers() {
    detachWidgetObservers();
    var cont = chipContainer();
    var ed = inputEditor();
    attachedCont = cont;
    if (cont) {
      chipObserver = new MutationObserver(scheduleBeacon);
      chipObserver.observe(cont, { childList: true, subtree: true, attributes: true, attributeFilter: ['aria-label', 'class'] });
    }
    if (ed) {
      lineObserver = new MutationObserver(scheduleBeacon);
      lineObserver.observe(ed, { childList: true, subtree: true, characterData: true });
    }
    armed = true;
    // Emit the initial state so the extension has a baseline.
    scheduleBeacon();
  }

  function detachWidgetObservers() {
    if (chipObserver) { chipObserver.disconnect(); chipObserver = null; }
    if (lineObserver) { lineObserver.disconnect(); lineObserver = null; }
    attachedCont = null; // (0.1.117) so the next appearance counts as "opened"
    armed = false;
  }

  // ---- document-level observer: the chat widget is ephemeral ----
  function onDocMutations(muts) {
    // (0.1.115) doc-level safety net: VS Code re-renders the chat subtree when
    // the view reopens — the container instance we attached to is gone, chips
    // are restored into a NEW container asynchronously (the model restore lags
    // the container creation). The old logic only armed on "container first
    // appeared", so the later chip insertions were never observed (user
    // annotated 3, beacons showed 0 — the "read hits the dsh window" bug).
    // On ANY doc mutation: re-attach when the live container differs from the
    // attached one, and beacon immediately when the live chip count rises
    // above the last beaconed count. Event-driven, no polling.
    var live = chipContainer();
    if (live && live !== attachedCont) {
      var wasNull = !attachedCont; // (0.1.117) none → some transition = panel opened
      attachWidgetObservers(); // re-arms + scheduleBeacon (immediate on count add)
      if (wasNull) beacon({ ev: 'widget-opened', win: WIN, t: Date.now() });
      return;
    }
    var liveCount = live ? live.querySelectorAll('.chat-attached-context-attachment').length : 0;
    if (liveCount > 0 && liveCount > lastChipCount) {
      if (debounceTimer) { clearTimeout(debounceTimer); debounceTimer = null; }
      doBeacon();
      return;
    }
    for (var i = 0; i < muts.length; i++) {
      var m = muts[i];
      // Container appeared (added nodes include it) → arm widget observers.
      if (m.type === 'childList') {
        var added = m.addedNodes || [];
        for (var j = 0; j < added.length; j++) {
          var n = added[j];
          if (n.nodeType === 1 && (n.classList && (n.classList.contains('chat-attachments-container') || n.classList.contains('interactive-input-part')))) {
            attachWidgetObservers();
            return;
          }
          if (n.nodeType === 1 && n.querySelector && n.querySelector('.chat-attachments-container')) {
            attachWidgetObservers();
            return;
          }
        }
        // Container removed → disarm (widget destroyed).
        if (!chipContainer() && !inputEditor()) {
          detachWidgetObservers();
          lastBeaconKey = ''; // (0.1.116) next render must beacon even if state looks identical
          beacon({ ev: 'widget-gone' });
        }
      }
    }
  }

  function startDocObserver() {
    if (docObserver) docObserver.disconnect();
    docObserver = new MutationObserver(onDocMutations);
    docObserver.observe(document.documentElement, { childList: true, subtree: true });
    // If the widget is already present, arm immediately.
    if (chipContainer() || inputEditor()) attachWidgetObservers();
  }

  // ---- API exposed to the extension (called via CDP Runtime.evaluate) ----
  function getState() {
    var s = snapshot();
    return JSON.stringify({ ev: 'state', win: WIN, chips: s.chips, lines: s.lines });
  }

  /**
   * Click the ✕ of the element chip whose name matches, truly triggering the
   * native deletion (attachmentModel.delete → @ref line removed → pin removed).
   * @param {string} name e.g. "div#count"
   * @returns {string} 'clicked:<name>' | 'not-found:<name>'
   */
  function deleteChip(name) {
    var cont = chipContainer();
    if (!cont) return 'no-container';
    var chips = cont.querySelectorAll('.chat-attached-context-attachment');
    for (var i = 0; i < chips.length; i++) {
      var c = chips[i];
      var aria = c.getAttribute('aria-label') || '';
      var m = /^Attached element, (.+) \\(Delete\\)$/.exec(aria);
      var cname = m ? m[1] : aria;
      if (cname === name) {
        var x = c.querySelector('a.monaco-button.codicon-close-compact, a.codicon-close-compact');
        if (x) { x.click(); return 'clicked:' + name; }
        return 'no-x:' + name;
      }
    }
    return 'not-found:' + name;
  }

  function reinstall() {
    detachWidgetObservers();
    if (debounceTimer) { clearTimeout(debounceTimer); debounceTimer = null; }
    startDocObserver();
    beacon({ ev: 'installed', win: WIN });
  }

  window.__dshAnnoWb = {
    getState: getState,
    deleteChip: deleteChip,
    reinstall: reinstall,
    _version: 3
  };

  startDocObserver();
  beacon({ ev: 'installed', win: WIN });
  return 'installed';
})()
`;
}

module.exports = { observerSource };
