// dsh-review-changes client entry: collapsible file changes panel above input box 
window.__ModuleLoader__.load({
  id: "review-changes", 
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" }); 
    const React = require("react");
    const { createElement: h, useState, useEffect, useCallback, useRef } = React;

    const POLL_MS = 500;
    const REF_SOURCE = "vscode-ref";
    const CLIENT_BUILD = "2026-08-16T22-00";

    // Native dsh occurrence-chip pipeline (semi-public service faces):
    //   ctx.conversation.input.shell(sessionId) -> SessionInputShell
    //   ctx.inputTriggers.registerSource(...)   -> codec used at send time.
    let inputHub = null;
    let refSourceRegistered = false;
    let bridgeActive = false;
    const refRegistry = new Map();
    let refSeq = 0;

    // VSCode workbench scope (reverse watchdog, NOT a UI filter).
    // The extension sends the realpath + raw fsPath of every folder opened in
    // THIS VS Code window. dsh's settings/search/picker/plugin UI stays fully
    // interactive; only the CURRENT SESSION's workbench is watched. When the
    // session drifts into a workbench outside this whitelist, we immediately
    // pull it back to the bound workbench's latest session (or its blank
    // session placeholder) and ask VS Code to show "只能查看当前工作区".
    let vscodeScopePaths = [];
    let vscodeScopeRawPaths = [];
    let vscodeScopePullingAt = 0;

    function normalizeScopePath(p) {
      return String(p || "").replace(/\/+$/, "");
    }

    function scopePathAllowed(path) {
      const want = normalizeScopePath(path);
      for (const p of vscodeScopePaths) if (normalizeScopePath(p) === want) return true;
      for (const p of vscodeScopeRawPaths) if (normalizeScopePath(p) === want) return true;
      return false;
    }

    function scopeIsActive() {
      return vscodeScopePaths.length > 0 || vscodeScopeRawPaths.length > 0;
    }

    function setVscodeScope(paths, rawPaths) {
      vscodeScopePaths = Array.isArray(paths) ? paths.filter((p) => typeof p === "string" && p) : [];
      vscodeScopeRawPaths = Array.isArray(rawPaths) ? rawPaths.filter((p) => typeof p === "string" && p) : [];
      vscodeScopePullingAt = 0;
    }

    function postScopeMessage(type, extra) {
      try {
        const msg = Object.assign({ type: type }, extra || {});
        window.parent.postMessage(msg, "*");
      } catch (err) { /* noop */ }
    }

    // Fast hover bubble for truncated paths. Native title tooltips are too
    // slow in the VS Code webview; this one appears on mouseenter and is
    // fixed-positioned so scroll containers never clip it.
    function HoverTip(props) {
      const [tip, setTip] = useState(null);
      const text = String(props.text || "");
      return h("span", {
        onMouseEnter: function (event) {
          if (text === "") return;
          const r = event.currentTarget.getBoundingClientRect();
          setTip({ x: r.left, y: r.bottom + 4 });
        },
        onMouseLeave: function () { setTip(null); },
        style: { display: "block", width: "100%", minWidth: 0, maxWidth: "100%", overflow: "hidden" },
      },
        props.children,
        tip ? h("div", {
          style: {
            position: "fixed",
            left: Math.min(tip.x, Math.max(8, (typeof window !== "undefined" ? window.innerWidth : 1200) - 350)),
            top: Math.min(tip.y, Math.max(8, (typeof window !== "undefined" ? window.innerHeight : 900) - 80)),
            zIndex: 99999,
            maxWidth: "340px",
            padding: "6px 8px",
            background: "var(--dsh-color-surface-elevated, #1f1f1f)",
            color: "var(--dsh-color-text, #fff)",
            border: "1px solid var(--dsh-color-border, #80808059)",
            borderRadius: "8px",
            fontSize: "12px",
            lineHeight: "1.5",
            wordBreak: "break-all",
            boxShadow: "0 4px 12px #0000004d",
            pointerEvents: "none",
          },
        }, text) : null
      );
    }

    function mintRefs(refs) {
      return refs.map(function (r) {
        refSeq += 1;
        const id = "vs" + refSeq;
        const modelText = typeof r.modelText === "string" ? r.modelText
          : (typeof r.path === "string" ? "文件: " + r.path : String(r.label || ""));
        const clipboardText = typeof r.clipboardText === "string" ? r.clipboardText : modelText;
        refRegistry.set(id, { modelText, label: String(r.label || clipboardText) });
        return {
          source: REF_SOURCE,
          ref: id,
          label: String(r.label || clipboardText),
          clipboardText: clipboardText,
        };
      });
    }

    function serializeRef(ref, signal) {
      const item = refRegistry.get(String(ref));
      if (!item) return Promise.reject(new Error("vscode-ref: unknown ref " + String(ref)));
      return Promise.resolve(item.modelText);
    }

    function postPipelineProbe() {
      try {
        window.parent.postMessage({
          type: "dshPipelineProbe",
          inputHub: !!inputHub,
          refSource: refSourceRegistered,
        }, "*");
      } catch (err) { /* noop */ }
    }

    // Native chips share one dsh CSS class; color them per kind by minting a
    // rule keyed on the occurrenceId that dsh assigns after pasteBegin.
    const CHIP_COLORS = {
      file: "rgba(74,158,255,0.26)",      // blue
      folder: "rgba(240,161,50,0.26)",    // amber
      selection: "rgba(167,139,250,0.34)", // violet
    };
    let chipStyleTag = null;

    function injectChipStyles(entries) {
      if (!Array.isArray(entries) || entries.length === 0) return;
      try {
        if (!chipStyleTag || !document.head.contains(chipStyleTag)) {
          chipStyleTag = document.createElement("style");
          chipStyleTag.id = "dsh-review-chip-styles";
          chipStyleTag.dataset.plugin = "review-changes";
          document.head.appendChild(chipStyleTag);
        }
        // Native layout ONLY: never resize the placeholder shell. Changing its
        // width breaks dsh's mirror/backdrop alignment and makes the caret
        // jump. Colors still ride the chip element.
        const css = entries
          .filter(function (e) { return e && Number.isFinite(e.id); })
          .map(function (e) {
            const color = CHIP_COLORS[e.kind] || CHIP_COLORS.file;
            return '[data-decoration="chip"][data-occurrence="' + e.id + '"]{background:' + color + ' !important;}';
          })
          .join("\n");
        if (css) chipStyleTag.textContent += "\n" + css;
      } catch (err) { /* styling is cosmetic */ }
    }

    function showFloatingToast(text, isError) {
      try {
        var t = document.createElement("div");
        t.textContent = text;
        t.style.cssText = "position:fixed;top:20px;right:20px;background:var(--dsh-color-surface-elevated,#1f1f1f);color:var(--dsh-color-text,#fff);padding:8px 16px;border-radius:8px;font-size:13px;z-index:9999;border:1px solid " + (isError ? "var(--dsh-color-danger,#e5534b)" : "var(--dsh-color-border,#80808059)") + ";box-shadow:0 4px 12px #0000004d;transition:opacity 0.3s;opacity:1;";
        document.body.appendChild(t);
        setTimeout(function () { t.style.opacity = "0"; setTimeout(function () { if (document.body.contains(t)) document.body.removeChild(t); }, 300); }, 2500);
      } catch (err) { /* noop */ }
    }

    async function fetchChanges(workbench) {
      try {
        const query = workbench ? "?workbench=" + encodeURIComponent(workbench) : "";
        const res = await fetch("/api/review/changes" + query);
        if (!res.ok) return [];
        const data = await res.json();
        return data.entries || [];
      } catch { return []; }
    } 

    function ReviewChangesDock(props) { 
      const [entries, setEntries] = useState([]);
      const [collapsed, setCollapsed] = useState(true);
      const timerRef = useRef(null);

      // The dock slot is session-scoped and receives the framework standard
      // kit. Resolve the CURRENT workspace path: prefer the workspace that
      // accounts this session, then fall back to the session summary cwd.
      const sessionId = props && props.sessionId;
      const sessionCwd = props && props.useSessions
        ? props.useSessions(function (s) { return s.byId && s.byId[sessionId] ? s.byId[sessionId].cwd : undefined; })
        : undefined;
      const workspacePath = props && props.useWorkspaces
        ? props.useWorkspaces(function (s) {
            var items = s && s.items ? s.items : [];
            for (var i = 0; i < items.length; i++) {
              var ids = items[i].sessionIds || [];
              if (ids.indexOf(sessionId) >= 0) return items[i].path;
            }
            return undefined;
          })
        : undefined;
      const workbench = workspacePath || sessionCwd || "";

      // Bridge from the VS Code sidebar webview: insert text at the current
      // cursor of the dsh composer. Cross-origin, so the parent webview posts
      // a message and this listener (inside the dsh page) applies it.
      const inputActions = props && props.inputActions;
      const draft = props && props.useInput
        ? props.useInput(function (s) { return s.draft; })
        : "";
      const draftRef = useRef(draft);
      draftRef.current = draft;
      const inputSnapshot = props && props.useInput
        ? props.useInput(function (s) { return s; })
        : null;
      const inputStateRef = useRef(inputSnapshot);
      inputStateRef.current = inputSnapshot;

      // Option B tag display: short pill label in the input, FULL path in the
      // native title attribute (hover). React keeps title=label in its props;
      // a one-time DOM write survives re-renders because that prop never
      // changes.
      function syncChipTitles() {
        try {
          const snap = inputStateRef.current || {};
          const occurrences = Array.isArray(snap.occurrences) ? snap.occurrences : [];
          const titleByOccurrence = {};
          for (let i = 0; i < occurrences.length; i++) {
            const o = occurrences[i];
            if (o.source === REF_SOURCE) titleByOccurrence[o.occurrenceId] = o.clipboardText || o.label || "";
          }
          const chips = document.querySelectorAll('[data-decoration="chip"]');
          for (let i = 0; i < chips.length; i++) {
            const id = Number(chips[i].getAttribute("data-occurrence"));
            if (Number.isFinite(id) && titleByOccurrence[id]) chips[i].title = titleByOccurrence[id];
          }
        } catch (err) { /* cosmetic */ }
      }

      useEffect(() => {
        const timer = setTimeout(syncChipTitles, 50);
        return () => clearTimeout(timer);
      }, [inputSnapshot]);

      useEffect(() => {
        let zoom = 1;
        let pendingPasteTarget = null;
        let lastComposer = null;
        let bridgeTimer = null;
        let bridgeAttempts = 0;

        function postToParent(msg) {
          try { window.parent.postMessage(msg, "*"); } catch (err) { /* noop */ }
        }

        // Only enable shortcut/drop interception after the VS Code parent
        // answers the handshake. In a plain browser tab (parent === window)
        // there is no ack sender, so every native browser shortcut stays
        // untouched and the retry loop stops by itself.
        function announceBridge() {
          if (bridgeActive || bridgeTimer === null) return;
          bridgeAttempts += 1;
          if (bridgeAttempts > 12) {
            clearInterval(bridgeTimer);
            bridgeTimer = null;
            return;
          }
          postToParent({ type: "dshBridgeHello" });
        }

        // Real dsh UI activity -> tell the VSCode extension which window the
        // user is actually using, so the auto-open lease can follow it.
        let lastActivityAt = 0;
        function reportActivity() {
          if (!bridgeActive) return;
          const now = Date.now();
          if (now - lastActivityAt < 3000) return;
          lastActivityAt = now;
          postToParent({ type: "dshViewActive" });
        }

        function activeEditable() {
          const el = document.activeElement;
          return isEditable(el) ? el : null;
        }

        // Copying a selection that contains native chips must expand each
        // placeholder to its clipboardText (same discipline as dsh's own
        // copy handler) so Cmd+C never leaks U+FFFC into the system clipboard.
        function occurrenceExpandedSelection(el) {
          if (!el || el.tagName !== "TEXTAREA" || typeof el.value !== "string") return null;
          const start = el.selectionStart;
          const end = el.selectionEnd;
          if (!Number.isFinite(start) || !Number.isFinite(end) || start >= end) return null;
          const snap = inputStateRef.current || {};
          const draftText = typeof snap.draft === "string" ? snap.draft : el.value;
          const occurrences = Array.isArray(snap.occurrences) ? snap.occurrences : [];
          let out = "";
          let cursor = start;
          for (let i = 0; i < occurrences.length; i++) {
            const o = occurrences[i];
            if (o.offset < start) continue;
            if (o.offset >= end) break;
            out += draftText.slice(cursor, o.offset) + String(o.clipboardText || "");
            cursor = o.offset + 1;
          }
          out += draftText.slice(cursor, end);
          return out;
        }

        function getSelectionText() {
          const el = document.activeElement;
          const expanded = occurrenceExpandedSelection(el);
          if (expanded !== null) return expanded;
          if (el && el.tagName === "INPUT" && typeof el.value === "string") {
            const start = el.selectionStart;
            const end = el.selectionEnd;
            if (Number.isFinite(start) && Number.isFinite(end) && start < end) return el.value.slice(start, end);
          }
          const sel = window.getSelection();
          return sel ? sel.toString() : "";
        }

        function isEditable(el) {
          return !!el && (el.tagName === "TEXTAREA" || el.tagName === "INPUT" || el.isContentEditable);
        }

        function onFocusIn(event) {
          const el = event.target;
          if (isEditable(el) && el.tagName === "TEXTAREA") lastComposer = el;
        }

        function replaceTextareaSelection(el, text) {
          const start = Number.isFinite(el.selectionStart) ? el.selectionStart : 0;
          const end = Number.isFinite(el.selectionEnd) ? el.selectionEnd : start;
          try {
            el.setRangeText(text, start, end, "end");
          } catch (err) {
            el.value = el.value.slice(0, start) + text + el.value.slice(end);
          }
          try {
            el.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: text }));
          } catch (err) {
            try { el.dispatchEvent(new Event("input", { bubbles: true })); } catch (err2) { /* noop */ }
          }
        }

        // Insert at the element's CURRENT caret/selection. A blurred textarea
        // keeps its selectionStart/selectionEnd, so this still hits the right
        // spot when the message arrives while VS Code has focus.
        function insertAtCaret(el, text) {
          if (!isEditable(el)) return false;
          if (el.tagName === "TEXTAREA" || el.tagName === "INPUT") {
            replaceTextareaSelection(el, text);
            return true;
          }
          try {
            el.focus();
            return document.execCommand("insertText", false, text);
          } catch (err) {
            return false;
          }
        }

        // Paste into the FOCUSED editable only — precisely the control that
        // was focused when Cmd/Ctrl+V was pressed (pendingPasteTarget). No
        // target -> drop the text; it must never land in the composer or any
        // other editable via a stale fallback.
        function insertIncomingText(text, preferred) {
          if (!isEditable(preferred)) return false;
          return insertAtCaret(preferred, text);
        }

        // Explicit VSCode actions (send selection / drop refs) always target
        // the COMPOSER textarea, never a settings input.
        function preferredComposer(preferred) {
          if (preferred && preferred.tagName === "TEXTAREA") return preferred;
          if (lastComposer && document.body.contains(lastComposer)) return lastComposer;
          return null;
        }

        function insertComposerText(text) {
          const target = preferredComposer(null);
          if (target && insertAtCaret(target, text)) return true;
          if (inputActions) inputActions.setDraft(draftRef.current + text);
          return false;
        }

        // ---- Native chip insertion (spike) --------------------------------
        function currentSelection(preferred) {
          const el = preferredComposer(preferred);
          const len = draftRef.current.length;
          if (el && el.tagName === "TEXTAREA") {
            const start = Number.isFinite(el.selectionStart) ? el.selectionStart : len;
            const end = Number.isFinite(el.selectionEnd) ? el.selectionEnd : start;
            return {
              start: Math.max(0, Math.min(start, len)),
              end: Math.max(0, Math.min(end, len)),
            };
          }
          return { start: len, end: len };
        }

        // Try the dsh native occurrence chip path; fall back to plain text.
        function insertRefsAtCaret(refs, fallbackText, preferred) {
          const list = Array.isArray(refs) ? refs : [];
          if (!sessionId || !inputHub || !refSourceRegistered || list.length === 0) {
            if (fallbackText) insertComposerText(fallbackText);
            return { mode: "text", count: list.length, reason: "no native pipeline" };
          }
          try {
            const shell = inputHub.shell(sessionId);
            if (!shell || typeof shell.pasteBegin !== "function") {
              throw new Error("conversation.input.shell().pasteBegin unavailable");
            }
            const sel = currentSelection(preferred);
            const references = mintRefs(list);
            let raw = "";
            const components = [];
            for (let i = 0; i < references.length; i++) {
              const start = raw.length;
              raw += "x";
              const end = raw.length;
              components.push({ start: start, end: end, reference: references[i] });
              raw += " ";
            }
            const beforeRev = shell.snapshot.draftRev;
            shell.pasteBegin(raw, { start: sel.start, end: sel.end }, components);
            if (shell.snapshot.draftRev === beforeRev) throw new Error("pasteBegin rejected span");
            const byRef = {};
            const occurrences = shell.snapshot.occurrences || [];
            for (let i = 0; i < occurrences.length; i++) {
              if (occurrences[i].source === REF_SOURCE) byRef[occurrences[i].ref] = occurrences[i].occurrenceId;
            }
            injectChipStyles(references.map(function (r, i) {
              return { id: byRef[r.ref], kind: list[i] && list[i].kind };
            }));
            const caret = sel.start + references.length * 2;
            const target = preferredComposer(preferred);
            if (target) {
              setTimeout(function () {
                if (!document.body.contains(target)) return;
                try {
                  if (target.tagName === "TEXTAREA") target.setSelectionRange(caret, caret);
                } catch (err) { /* noop */ }
              }, 0);
            }
            return { mode: "chip", count: references.length, reason: "" };
          } catch (err) {
            console.warn("[dsh-review] native chip insert failed, fallback to text:", err && err.message || err);
            if (fallbackText) insertComposerText(fallbackText);
            return { mode: "text", count: list.length, reason: err && err.message || String(err) };
          }
        }

        function applyZoom() {
          const value = zoom === 1 ? "" : String(zoom);
          try { document.documentElement.style.zoom = value; } catch (err) { /* noop */ }
          try { document.body.style.zoom = ""; } catch (err) { /* noop */ }
        }

        function onBridgeMessage(event) {
          const msg = event.data;
          if (!msg) return;
          if (msg.type === "dshBridgeAck") {
            bridgeActive = true;
            if (bridgeTimer !== null) { clearInterval(bridgeTimer); bridgeTimer = null; }
            console.log("[dsh-review] VSCode bridge handshake ok");
            reportActivity();
            return;
          }
          if (msg.type === "dshSetScope") {
            setVscodeScope(msg.paths, msg.rawPaths);
            console.log("[dsh-review] VSCode workbench scope:", (msg.paths || []).length, "path(s)");
            return;
          }
          if (msg.type === "dshInsertText" && typeof msg.text === "string") {
            // Explicit VSCode action: always the composer, never a settings
            // input; append to draft only when no composer has been focused.
            insertComposerText(msg.text);
          } else if (msg.type === "dshInsertRefs" && Array.isArray(msg.refs)) {
            const fallback = typeof msg.fallbackText === "string" ? msg.fallbackText : "";
            const result = insertRefsAtCaret(msg.refs, fallback, document.activeElement);
            postToParent({
              type: "dshInsertResult",
              source: "selection",
              mode: result.mode,
              count: result.count,
              reason: result.reason || "",
            });
          } else if (msg.type === "dshPasteText" && typeof msg.text === "string") {
            const target = pendingPasteTarget && document.body.contains(pendingPasteTarget)
              ? pendingPasteTarget
              : null;
            pendingPasteTarget = null;
            // Target-aware: pastes back into exactly the focused field; no
            // draft fallback if that field disappeared.
            insertIncomingText(msg.text, target);
          }
        }

        // The iframe cannot reliably reach the system clipboard, so copy/cut
        // go through the extension. Paste is read by the extension and comes
        // back as dshPasteText. ALL of this only exists after the VSCode
        // handshake; a plain browser tab keeps native behavior.
        function onKeydown(event) {
          if (!bridgeActive) return;
          const mod = event.metaKey || event.ctrlKey;
          if (!mod) return;
          const key = String(event.key || "").toLowerCase();
          const editable = activeEditable();
          const composer = editable && editable.tagName === "TEXTAREA";

          if (key === "a") {
            if (!editable) return;
            event.preventDefault();
            editable.focus();
            if (editable.tagName === "TEXTAREA" || editable.tagName === "INPUT") {
              editable.setSelectionRange(0, editable.value.length);
            } else {
              try { document.execCommand("selectAll", false, null); } catch (err) { /* noop */ }
            }
          } else if (key === "c") {
            const text = getSelectionText();
            if (!text) return;
            event.preventDefault();
            postToParent({ type: "dshCopyText", text: text });
          } else if (key === "x") {
            const text = getSelectionText();
            if (!text) return;
            event.preventDefault();
            postToParent({ type: "dshCopyText", text: text });
            if (editable) {
              if (editable.tagName === "TEXTAREA" || editable.tagName === "INPUT") {
                replaceTextareaSelection(editable, "");
              } else {
                editable.focus();
                try { document.execCommand("delete", false, null); } catch (err) { /* noop */ }
              }
            }
          } else if (key === "v") {
            // Only paste into a focused editable. No focus -> do not touch
            // the event, and never route it into the composer draft.
            if (!editable) return;
            event.preventDefault();
            pendingPasteTarget = editable;
            postToParent({ type: "dshPasteRequest" });
          } else if (key === "r") {
            // In the VS Code sidebar the iframe cannot reload itself reliably,
            // so Ctrl/Cmd+R anywhere in dsh reloads the frame; Shift forces a
            // cache-busting reload. Plain browser tabs keep native behavior
            // because bridgeActive is only true after the VSCode handshake.
            if (event.repeat) return;
            event.preventDefault();
            postToParent({ type: "dshReload", force: !!event.shiftKey });
          } else if (key === "+" || key === "=" || key === "-" || key === "_" || key === "0") {
            // Zoom works anywhere inside the VSCode dsh iframe, not just in
            // the composer textarea. Plain browser tabs keep native zoom
            // because bridgeActive is false there.
            event.preventDefault();
            if (key === "0") zoom = 1;
            else if (key === "-" || key === "_") zoom = Math.max(0.5, Math.round((zoom - 0.1) * 10) / 10);
            else zoom = Math.min(2, Math.round((zoom + 0.1) * 10) / 10);
            applyZoom();
          }
        }

        // dsh -> VSCode copy fallback: also catches context-menu copy.
        function onCopy(event) {
          if (!bridgeActive) return;
          let text = "";
          try {
            if (event && event.clipboardData) text = event.clipboardData.getData("text/plain") || "";
          } catch (err) { /* noop */ }
          if (!text) text = getSelectionText();
          if (text) postToParent({ type: "dshCopyText", text: text });
        }

        // DROP: VS Code 1.133 passes Explorer file drags into the webview
        // while Shift is held. application/vnd.code.uri-list carries the FULL
        // resource list (text/uri-list only carries the first file), so read
        // that first and insert every absolute path at the composer caret.
        function parseUriListString(raw) {
          const s = String(raw || "").trim();
          if (!s) return [];
          if (s.charAt(0) === "[" || s.charAt(0) === "{") {
            try {
              const parsed = JSON.parse(s);
              if (Array.isArray(parsed)) return parsed.map(String);
              if (typeof parsed === "string") return [parsed];
            } catch (err) { /* fall through to line format */ }
          }
          return s.split(/\r?\n/).map(function (t) { return t.trim(); })
            .filter(function (t) { return t && t.charAt(0) !== "#"; });
        }

        function uriToPath(uri) {
          const u = String(uri || "").trim();
          if (!u) return null;
          try {
            if (/^file:/i.test(u)) {
              const parsed = new URL(u);
              let p = decodeURIComponent(parsed.pathname);
              if (parsed.hostname && parsed.hostname !== "localhost") {
                p = "//" + parsed.hostname + p; // UNC path
              } else if (/^\/[A-Za-z]:[\\/]/.test(p)) {
                p = p.slice(1); // windows drive path
              }
              return p;
            }
            if (/^\//.test(u) || /^[A-Za-z]:[\\/]/.test(u)) return decodeURIComponent(u);
          } catch (err) { /* not a URI; return the raw string below */ }
          return u;
        }

        function pathsFromDrop(dt) {
          const raws = [];
          try { raws.push(dt.getData("application/vnd.code.uri-list")); } catch (err) { /* noop */ }
          try { raws.push(dt.getData("text/uri-list")); } catch (err) { /* noop */ }
          const seen = {};
          const out = [];
          for (let i = 0; i < raws.length; i++) {
            const uris = parseUriListString(raws[i]);
            for (let j = 0; j < uris.length; j++) {
              const p = uriToPath(uris[j]);
              if (p && !seen[p]) { seen[p] = true; out.push(p); }
            }
          }
          return out;
        }

        // VS Code puts non-directory resources in the ResourceURLs JSON list,
        // while application/vnd.code.uri-list carries EVERYTHING. Paths that
        // appear only in the full list are folders.
        function filePathSetFromDrop(dt) {
          try {
            const raw = dt.getData("resourceurls") || dt.getData("ResourceURLs");
            if (!raw) return null;
            const arr = JSON.parse(raw);
            if (!Array.isArray(arr)) return null;
            const set = {};
            for (let i = 0; i < arr.length; i++) {
              const p = uriToPath(arr[i]);
              if (p) set[p] = true;
            }
            return set;
          } catch (err) { return null; }
        }

        function refsForDropPaths(paths, dt) {
          const fileSet = filePathSetFromDrop(dt);
          return paths.map(function (p) {
            const base = p.split("/").pop() || p;
            const isFile = fileSet ? fileSet[p] === true : true;
            return {
              kind: isFile ? "file" : "folder",
              path: p,
              label: (isFile ? "📄 " : "📁 ") + base,
              clipboardText: p,
              modelText: (isFile ? "文件: " : "目录: ") + p,
            };
          });
        }

        function dragPayload(event, phase) {
          const dt = event.dataTransfer;
          const types = dt && dt.types ? Array.prototype.slice.call(dt.types) : [];
          let uriList = "";
          let internalList = "";
          let plain = "";
          try { if (dt) uriList = dt.getData("text/uri-list") || ""; } catch (err) { /* noop */ }
          try { if (dt) internalList = dt.getData("application/vnd.code.uri-list") || ""; } catch (err) { /* noop */ }
          try { if (dt) plain = dt.getData("text/plain") || ""; } catch (err) { /* noop */ }
          const files = dt && dt.files ? Array.prototype.slice.call(dt.files).map(function (f) { return f.name; }) : [];
          const items = dt && dt.items ? Array.prototype.slice.call(dt.items).map(function (it) { return it.kind + ":" + it.type; }) : [];
          return {
            phase: phase,
            types: types,
            uriList: String(uriList || "").slice(0, 800),
            internalList: String(internalList || "").slice(0, 2000),
            plain: String(plain || "").slice(0, 800),
            files: files.slice(0, 20),
            items: items.slice(0, 20),
          };
        }

        function onDragOver(event) {
          if (!bridgeActive) return;
          if (!event.shiftKey || !event.dataTransfer) return;
          event.preventDefault();
        }

        function onDrop(event) {
          if (!bridgeActive) return;
          if (!event.shiftKey || !event.dataTransfer) return;
          event.preventDefault();
          const paths = pathsFromDrop(event.dataTransfer);
          if (paths.length > 0) {
            const refs = refsForDropPaths(paths, event.dataTransfer);
            const result = insertRefsAtCaret(refs, paths.join("\n"), document.activeElement);
            postToParent({
              type: "dshInsertResult",
              source: "drop",
              mode: result.mode,
              count: result.count,
              reason: result.reason || "",
              first: paths[0],
            });
          } else {
            // No recognizable path: keep the diagnostic path alive.
            postToParent({ type: "dshDropProbe", payload: dragPayload(event, "drop") });
          }
        }

        // External links: inside the VS Code iframe they cannot navigate, so
        // send http/https links to the extension, which opens them in the
        // default browser. Plain browser tabs keep native link behavior.
        function onExternalClick(event) {
          if (bridgeActive === false) return;
          const anchor = event.target && event.target.closest ? event.target.closest("a[href]") : null;
          if (anchor === null) return;
          const href = String(anchor.href || anchor.getAttribute("href") || "");
          if (href.indexOf("http://") !== 0 && href.indexOf("https://") !== 0) return;
          event.preventDefault();
          event.stopPropagation();
          postToParent({ type: "dshOpenExternal", url: href });
        }
        bridgeActive = false;
        bridgeTimer = window.setInterval(announceBridge, 500);
        announceBridge();

        window.addEventListener("message", onBridgeMessage);
        document.addEventListener("click", onExternalClick, true);
        document.addEventListener("keydown", onKeydown, true);
        document.addEventListener("copy", onCopy);
        document.addEventListener("focusin", onFocusIn, true);
        document.addEventListener("dragover", onDragOver, true);
        document.addEventListener("drop", onDrop, true);
        document.addEventListener("pointerdown", reportActivity, true);
        document.addEventListener("keydown", reportActivity, true);
        window.addEventListener("focus", reportActivity, true);
        return () => {
          if (bridgeTimer !== null) { clearInterval(bridgeTimer); bridgeTimer = null; }
          bridgeActive = false;
          window.removeEventListener("message", onBridgeMessage);
          document.removeEventListener("click", onExternalClick, true);
          document.removeEventListener("keydown", onKeydown, true);
          document.removeEventListener("copy", onCopy);
          document.removeEventListener("focusin", onFocusIn, true);
          document.removeEventListener("dragover", onDragOver, true);
          document.removeEventListener("drop", onDrop, true);
          document.removeEventListener("pointerdown", reportActivity, true);
          document.removeEventListener("keydown", reportActivity, true);
          window.removeEventListener("focus", reportActivity, true);
        };
      }, [inputActions]);

      const poll = useCallback(async () => {
        const data = await fetchChanges(workbench);
        setEntries(data); 
      }, [workbench]);

      useEffect(() => {
        setEntries([]);
        poll();
        timerRef.current = window.setInterval(poll, POLL_MS); 
        return () => { if (timerRef.current) clearInterval(timerRef.current); };
      }, [poll]); 

      // Batch verdict for exactly the files CURRENTLY shown in the panel.
      const runBatch = (action) => {
        const files = entries
          .filter(function (e) { return e.fileExists && e.unreviewedHunks > 0; })
          .map(function (e) { return e.filePath; });
        if (files.length === 0) return;
        fetch("/api/review/batch", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: action, filePaths: files }),
        }).then(function (r) { return r.json(); }).then(function (d) {
          if (d && d.ok) {
            showFloatingToast((action === "acceptAll" ? "\u2705 已发送 " : "\u274C 已发送 ") + files.length + " \u4E2A\u6587\u4EF6\u5230 VS Code \u6279\u91CF\u5904\u7406");
            setTimeout(function () { poll(); }, 250);
          } else {
            showFloatingToast("\u274C \u6279\u91CF\u64CD\u4F5C\u5931\u8D25: " + ((d && d.error) || "unknown"), true);
          }
        }).catch(function (e) { showFloatingToast("\u274C \u8BF7\u6C42\u5931\u8D25: " + e.message, true); });
      };

      if (entries.length === 0) return null;

      const totalAdded = entries.reduce((s, e) => s + (e.additions || 0), 0);
      const totalRemoved = entries.reduce((s, e) => s + (e.deletions || 0), 0);

      return h("div", {
        style: {
          margin: "0 auto 4px",
          boxSizing: "border-box",
          flex: "none",
          overflow: "hidden",
          width: "calc(100% - var(--dsh-composer-side-clearance, 0px) * 2 - var(--dsh-composer-dock-inset, 0px) * 4)",
          maxWidth: "calc(var(--dsh-composer-card-max-width, 800px) - var(--dsh-composer-dock-inset, 0px) * 4)", 
          borderRadius: "12px",
          border: "1px solid var(--dsw-alias-border-l1, #80808059)",
          background: "var(--dsw-specific-tip, var(--dsh-color-surface, transparent))",
          fontSize: "13px",
          fontFamily: "var(--vscode-font-family, inherit)",
          lineHeight: "20px", 
        }
      },
        // Header 
        h("div", {
          onClick: () => setCollapsed(!collapsed),
          style: {
            display: "flex", alignItems: "center", gap: "8px",
            padding: "6px 10px", cursor: "pointer", userSelect: "none",
            color: "var(--dsh-color-text, inherit)",
            borderBottom: collapsed ? "none" : "1px solid var(--dsh-color-border, #80808030)", 
          }
        },
          h("span", { style: { fontSize: "11px", opacity: 0.6 } }, collapsed ? "\u25B6" : "\u25BC"),
          h("span", { style: { fontWeight: 600 } }, "\u{1F4C1} Review Changes"),
          h("span", { title: "dsh-review-changes client build", style: { opacity: 0.45, fontSize: "10px", fontFamily: "monospace" } }, CLIENT_BUILD),
          h("span", { style: { opacity: 0.7, marginLeft: "4px" } },
            entries.reduce(function(s,e){return s+e.unreviewedHunks},0) + " hunk" + (entries.reduce(function(s,e){return s+e.unreviewedHunks},0) > 1 ? "s" : "") + " in " + entries.length + " file" + (entries.length > 1 ? "s" : "") 
          ),
          h("span", { style: { marginLeft: "auto", fontFamily: "monospace", fontSize: "11px", color: "var(--dsh-color-success, #2da44e)" } }, "+" + totalAdded),
          h("span", { style: { fontFamily: "monospace", fontSize: "11px", color: "var(--dsh-color-danger, #e5534b)", marginLeft: "4px" } }, "-" + totalRemoved),
          h("button", {
            type: "button",
            title: "\u63A5\u53D7\u5F53\u524D\u5217\u8868\u7684\u6240\u6709\u6587\u4EF6",
            onClick: function (e) { e.stopPropagation(); runBatch("acceptAll"); },
            style: { marginLeft: "8px", padding: "1px 6px", fontSize: "11px", lineHeight: "16px", borderRadius: "8px", border: "1px solid #2da44e66", background: "#2da44e22", color: "var(--dsh-color-success,#2da44e)", cursor: "pointer" },
          }, "\u2713 \u5168\u90E8\u63A5\u53D7"),
          h("button", {
            type: "button",
            title: "\u64A4\u56DE\u5F53\u524D\u5217\u8868\u7684\u6240\u6709\u6587\u4EF6",
            onClick: function (e) { e.stopPropagation(); runBatch("rejectAll"); },
            style: { marginLeft: "4px", padding: "1px 6px", fontSize: "11px", lineHeight: "16px", borderRadius: "8px", border: "1px solid #e5534b66", background: "#e5534b22", color: "var(--dsh-color-danger,#e5534b)", cursor: "pointer" },
          }, "\u2717 \u5168\u90E8\u64A4\u56DE"),
        ),
        // File list
        !collapsed && h("div", { style: { display: "flex", flexDirection: "column", gap: "4px", margin: 0, padding: "6px 12px", listStyle: "none", maxHeight: "180px", overflowY: "auto" } },
          entries.map(function(entry) { 
            const basename = entry.filePath.split("/").pop() || entry.filePath;
            const dir = entry.filePath.replace(/\/[^\/]+$/, "");
            return h("div", {
              key: entry.id,
              // Grid row: the path cell is bounded so a long file path never
              // squeezes the +/-/hunk columns.
              style: { display: "grid", gridTemplateColumns: "16px minmax(0, 1fr) 40px 88px 40px", gap: "8px", alignItems: "center", width: "100%", minWidth: 0, fontSize: "13px", lineHeight: "20px", color: "var(--dsw-alias-label-secondary, var(--dsh-color-text, inherit))" } 
            },
              h("span", { style: { fontFamily: "monospace", fontSize: "11px", minWidth: "16px", textAlign: "right", color: !entry.fileExists ? "var(--dsh-color-danger, #e5534b)" : entry.operation === "create" ? "var(--dsh-color-success, #2da44e)" : "var(--dsh-color-accent, #50a0ff)" } }, !entry.fileExists ? "\u{1F5D1}" : entry.operation === "create" ? "\u2795" : "\u270F\uFE0F"),
              h(HoverTip, { text: entry.filePath },
                h("span", {
                onClick: function(e) {
                  e.preventDefault();
                  e.stopPropagation();
                  var filePath = entry.filePath;
                  // 尝试多种 VS Code URI scheme
                  if(!entry.fileExists){alert("\u{1F5D1} 文件已被删除: "+filePath.split("/").pop());return;} fetch("/api/review/open-file", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ filePath: filePath })
                  }).then(function(r){return r.json()}).then(function(d){
                    if(d.ok){
                      var t=document.createElement("div");
                      t.textContent="\u2705 VS Code 已打开: "+filePath.split("/").pop();
                      t.style.cssText="position:fixed;top:20px;right:20px;background:var(--dsh-color-surface-elevated,#1f1f1f);color:var(--dsh-color-text,#fff);padding:8px 16px;border-radius:8px;font-size:13px;z-index:9999;border:1px solid var(--dsh-color-border,#80808059);box-shadow:0 4px 12px #0000004d;transition:opacity 0.3s;opacity:1;";
                      document.body.appendChild(t);
                      setTimeout(function(){t.style.opacity="0";setTimeout(function(){document.body.removeChild(t)},300)},2000);
                    } else {
                      var msg=d.error||""; alert(msg.includes("not found") ? "\u{1F4C1} 文件不存在: "+filePath.split("/").pop() : "\u274C 打开失败: "+msg);
                    }
                  }).catch(function(e){alert("\u274C 请求失败: "+e.message)}) 
                },
                onMouseEnter: function(e) { e.target.style.textDecoration = "underline" },
                onMouseLeave: function(e) { e.target.style.textDecoration = "none" },
                style: { display: "flex", alignItems: "center", gap: "6px", minWidth: 0, overflow: "hidden", cursor: "pointer" },
              },
                h("span", { style: { fontWeight: 500, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", flex: "0 0 45%", width: "45%", maxWidth: "45%", color: !entry.fileExists ? "var(--dsh-color-danger, #e5534b)" : "var(--dsh-color-accent, #50a0ff)", textDecoration: !entry.fileExists ? "line-through" : "none" } }, basename),
                h("span", { style: { opacity: 0.4, fontSize: "11px", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", minWidth: 0, flex: "1 1 55%" } }, dir)
              ),
              ),
              h("span", { style: { fontFamily: "monospace", fontSize: "11px", color: "var(--dsh-color-success, #2da44e)", whiteSpace: "nowrap", textAlign: "right" } }, "+" + entry.additions),
              h("span", { style: { opacity: 0.4, fontSize: "11px", whiteSpace: "nowrap", textAlign: "right" } }, entry.unreviewedHunks + " unreviewed"),
              h("span", { style: { fontFamily: "monospace", fontSize: "11px", color: "var(--dsh-color-danger, #e5534b)", whiteSpace: "nowrap", textAlign: "right" } }, "-" + entry.deletions), 
            );
          })
        )
      );
    }

    // Settings-page panel: ALL historical unresolved files grouped by
    // workbench, with per-file AC/RJ and global AC All / RJ All. RJ always
    // asks for confirmation first because it rewrites the file back to the
    // review before-snapshot.
    function HistoryReviewSettingsSection() {
      const [groups, setGroups] = useState([]);
      const [totals, setTotals] = useState({ totalFiles: 0, totalHunks: 0, totalAdditions: 0, totalDeletions: 0 });
      const [loading, setLoading] = useState(true);
      const [note, setNote] = useState("");
      const [busy, setBusy] = useState("");
      const [confirmReq, setConfirmReq] = useState(null);

      const load = useCallback(function () {
        fetch("/api/review/all", { headers: { "Accept": "application/json" } })
          .then(function (r) { return r.json() })
          .then(function (d) {
            // Always show the COMPLETE history across all workbenches, in both
            // browser and VSCode mode (per user decision: settings history is
            // global; only the input dock stays scoped to the current session).
            const visible = Array.isArray(d.groups) ? d.groups : [];
            setGroups(visible);
            setTotals({
              totalFiles: d.totalFiles || 0,
              totalHunks: d.totalUnreviewedHunks || 0,
              totalAdditions: d.totalAdditions || 0,
              totalDeletions: d.totalDeletions || 0,
            });
            setLoading(false);
          })
          .catch(function (e) {
            setNote("加载失败: " + (e && e.message || e));
            setLoading(false);
          });
      }, []);

      useEffect(function () {
        // This settings section is mounted only while the "历史待裁决" page
        // is the active settings view, so a 500ms poll costs nothing outside
        // this page and makes AC/RJ feedback feel immediate.
        if (busy) return;
        load();
        const timer = setInterval(load, 500);
        return function () { clearInterval(timer); };
      }, [load, busy]);

      function executeVerdict(list, action, target) {
        setBusy(target);
        setNote("");
        fetch("/api/review/batch", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: action, filePaths: list }),
        })
          .then(function (r) { return r.json() })
          .then(function (d) {
            setBusy("");
            if (!d || !d.ok) { setNote("VS Code 执行失败: " + ((d && d.error) || "unknown")); return; }
            setNote("已提交 " + action + "（" + target + "）给 VS Code，正在处理...");
          })
          .catch(function (e) {
            setBusy("");
            setNote("请求失败: " + (e && e.message || e));
          });
      }

      function runVerdict(filePaths, action, what) {
        const isRj = action === "rejectAll";
        let list = filePaths;
        if (list === null || list === undefined) {
          list = [];
          for (const g of groups) {
            for (const entry of g.entries) {
              if (entry && entry.filePath) list.push(entry.filePath);
            }
          }
        } else if (!Array.isArray(list)) {
          list = [list];
        }
        if (list.length === 0) { setNote("没有可执行的文件"); return; }
        const target = what || (filePaths === null || filePaths === undefined ? "ALL（所有工作区）" : "该文件");
        const isBatchAc = !isRj && (filePaths === null || filePaths === undefined || Array.isArray(filePaths));
        if (isRj || isBatchAc) {
          // In-panel confirmation instead of window.confirm: window.confirm is
          // unreliable inside the VS Code webview iframe and could silently
          // swallow clicks, which is exactly the "cannot click" symptom.
          setConfirmReq({ list, action, target });
          return;
        }
        executeVerdict(list, action, target);
      }

      if (loading) {
        return h("div", { style: { padding: "10px", fontSize: "13px", opacity: 0.7 } }, "正在加载历史待裁决...");
      }

      return h("div", { style: { display: "flex", flexDirection: "column", gap: "10px", fontSize: "13px" } },
        h("div", { style: { display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" } },
          h("span", { style: { fontWeight: 600 } }, "\u{1F4C2} 历史待裁决"),
          h("span", { title: "dsh-review-changes client build", style: { opacity: 0.45, fontSize: "10px", fontFamily: "monospace" } }, CLIENT_BUILD),
          h("span", { style: { opacity: 0.7, fontSize: "12px" } },
            totals.totalFiles + " 文件 / " + totals.totalHunks + " hunk  / +" + totals.totalAdditions + " -" + totals.totalDeletions),
          h("button", {
            type: "button",
            onClick: function () { runVerdict(null, "acceptAll", "ALL（所有工作区）"); },
            disabled: !!busy || totals.totalFiles === 0,
            style: { marginLeft: "auto", padding: "2px 10px", fontSize: "12px", lineHeight: "20px", borderRadius: "8px", border: "1px solid #2da44e66", background: "#2da44e22", color: "var(--dsh-color-success,#2da44e)", cursor: "pointer" },
          }, "\u2713 AC All"),
          h("button", {
            type: "button",
            onClick: function () { runVerdict(null, "rejectAll", "ALL（所有工作区）"); },
            disabled: !!busy || totals.totalFiles === 0,
            style: { padding: "2px 10px", fontSize: "12px", lineHeight: "20px", borderRadius: "8px", border: "1px solid #e5534b66", background: "#e5534b22", color: "var(--dsh-color-danger,#e5534b)", cursor: "pointer" },
          }, "\u2717 RJ All"),
        ),
        confirmReq ? h("div", { style: { display: "flex", alignItems: "center", gap: "8px", padding: "8px 10px", borderRadius: "8px", border: confirmReq.action === "rejectAll" ? "1px solid var(--dsh-color-danger, #e5534b66)" : "1px solid var(--dsh-color-accent, #50a0ff66)", background: "var(--dsh-color-surface-elevated, #1f1f1f55)", fontSize: "12px" } },
          h("span", { style: { flex: "1 1 auto", minWidth: 0 } }, "确认 " + (confirmReq.action === "rejectAll" ? "RJ" : "AC") + " " + confirmReq.target + "？共 " + confirmReq.list.length + " 个文件"),
          h("button", {
            type: "button",
            onClick: function () { const r = confirmReq; setConfirmReq(null); executeVerdict(r.list, r.action, r.target); },
            style: { padding: "2px 10px", fontSize: "12px", lineHeight: "20px", borderRadius: "8px", border: "1px solid #2da44e66", background: "#2da44e22", color: "var(--dsh-color-success,#2da44e)", cursor: "pointer" },
          }, "确认"),
          h("button", {
            type: "button",
            onClick: function () { setConfirmReq(null); },
            style: { padding: "2px 10px", fontSize: "12px", lineHeight: "20px", borderRadius: "8px", border: "1px solid var(--dsh-color-border, #80808040)", background: "transparent", color: "var(--dsh-color-text, inherit)", cursor: "pointer" },
          }, "取消"),
        ) : null,
        note ? h("div", { style: { padding: "6px 10px", borderRadius: "8px", background: "var(--dsh-color-surface-elevated, #1f1f1f66)", fontSize: "12px" } }, note) : null,
        groups.length === 0 ? h("div", { style: { padding: "8px 10px", borderRadius: "8px", border: "1px dashed var(--dsh-color-border, #80808040)", fontSize: "12px", opacity: 0.75 } }, "没有历史待裁决文件。") : null,
        groups.map(function (group) {
          const label = String(group.workbenchId || "(未归属工作区)");
          return h("div", {
            key: group.key || label,
            style: { border: "1px solid var(--dsh-color-border, #80808030)", borderRadius: "10px", padding: "8px 10px", display: "flex", flexDirection: "column", gap: "6px" },
          },
            h("div", { style: { display: "grid", gridTemplateColumns: "minmax(0, 1fr) max-content max-content max-content", gap: "8px", alignItems: "center", width: "100%", minWidth: 0 } },
              h(HoverTip, { text: label },
                h("span", { style: { display: "block", fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0 } }, "\u{1F4C1} " + label)
              ),
              h("span", { style: { opacity: 0.6, fontSize: "11px", whiteSpace: "nowrap", flexShrink: 0 } }, group.entries.length + " 文件"),
              h("button", {
                type: "button",
                title: "AC \u8BE5\u5DE5\u4F5C\u533A\u5168\u90E8\u6587\u4EF6",
                disabled: !!busy,
                onClick: function () { runVerdict(group.entries.map(function (entry) { return entry.filePath; }), "acceptAll", "工作区 " + label); },
                style: { padding: "1px 8px", fontSize: "11px", lineHeight: "18px", borderRadius: "8px", border: "1px solid #2da44e66", background: "#2da44e22", color: "var(--dsh-color-success,#2da44e)", cursor: "pointer", whiteSpace: "nowrap", flexShrink: 0 },
              }, "AC\u7EC4"),
              h("button", {
                type: "button",
                title: "RJ \u8BE5\u5DE5\u4F5C\u533A\u5168\u90E8\u6587\u4EF6",
                disabled: !!busy,
                onClick: function () { runVerdict(group.entries.map(function (entry) { return entry.filePath; }), "rejectAll", "工作区 " + label); },
                style: { padding: "1px 8px", fontSize: "11px", lineHeight: "18px", borderRadius: "8px", border: "1px solid #e5534b66", background: "#e5534b22", color: "var(--dsh-color-danger,#e5534b)", cursor: "pointer", whiteSpace: "nowrap", flexShrink: 0 },
              }, "RJ\u7EC4"),
            ),
            group.entries.map(function (entry) {
              const basename = entry.filePath.split("/").pop() || entry.filePath;
              const dir = entry.filePath.replace(/\/[^\/]+$/, "");
              return h("div", {
                key: entry.id + ":" + entry.filePath,
                // Grid keeps the path column bounded so long paths can never
                // squeeze the +/-/hunk/AC/RJ columns (pattern from the
                // awesome-dsh-plugin community UIs: fixed minmax columns).
                style: { display: "grid", gridTemplateColumns: "16px minmax(0, 1fr) 40px 40px 44px max-content max-content", gap: "8px", alignItems: "center", width: "100%", minWidth: 0 },
              },
                h("span", { style: { fontFamily: "monospace", fontSize: "11px", textAlign: "right", color: entry.operation === "create" ? "var(--dsh-color-success, #2da44e)" : "var(--dsh-color-accent, #50a0ff)" } }, entry.operation === "create" ? "\u2795" : "\u270F\uFE0F"),
                h(HoverTip, { text: entry.filePath },
                  h("span", {
                  style: { display: "flex", alignItems: "center", gap: "6px", minWidth: 0, overflow: "hidden", cursor: "default" },
                },
                  h("span", { style: { fontWeight: 500, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", flex: "0 0 45%", width: "45%", maxWidth: "45%", color: "var(--dsh-color-accent, #50a0ff)" } }, basename),
                  h("span", { style: { opacity: 0.4, fontSize: "11px", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", minWidth: 0, flex: "1 1 55%" } }, dir)
                ),
                ),
                h("span", { style: { fontFamily: "monospace", fontSize: "11px", color: "var(--dsh-color-success, #2da44e)", whiteSpace: "nowrap", textAlign: "right" } }, "+" + entry.additions),
                h("span", { style: { fontFamily: "monospace", fontSize: "11px", color: "var(--dsh-color-danger, #e5534b)", whiteSpace: "nowrap", textAlign: "right" } }, "-" + entry.deletions),
                h("span", { style: { opacity: 0.5, fontSize: "11px", whiteSpace: "nowrap", textAlign: "right" } }, entry.unreviewedHunks + " h"),
                h("button", {
                  type: "button",
                  disabled: !!busy,
                  onClick: function () { runVerdict(entry.filePath, "acceptAll"); },
                  style: { padding: "1px 8px", fontSize: "11px", lineHeight: "18px", borderRadius: "8px", border: "1px solid #2da44e66", background: "#2da44e22", color: "var(--dsh-color-success,#2da44e)", cursor: "pointer" },
                }, "AC"),
                h("button", {
                  type: "button",
                  disabled: !!busy,
                  onClick: function () { runVerdict(entry.filePath, "rejectAll"); },
                  style: { padding: "1px 8px", fontSize: "11px", lineHeight: "18px", borderRadius: "8px", border: "1px solid #e5534b66", background: "#e5534b22", color: "var(--dsh-color-danger,#e5534b)", cursor: "pointer" },
                }, "RJ"),
              );
            })
          );
        })
      );
    }

    function apply(ctx) { 
      // Replace the settings nav gear for OUR section with a whale glyph.
      // dsh hardcodes nav icons by section id (unknown ids get a gear), so we
      // patch the rendered nav button by matching its visible label. The
      // observer covers settings panels opened later in the same page.
      function patchSettingsNavIcon() {
        try {
          const buttons = document.querySelectorAll("button");
          for (const button of buttons) {
            if (button.getAttribute("data-dsh-whale") === "1") continue;
            let matched = false;
            for (const span of button.querySelectorAll("span")) {
              if (String(span.textContent || "").indexOf("历史待裁决") >= 0) { matched = true; break; }
            }
            if (matched === false) continue;
            const first = button.firstElementChild;
            if (first && first.tagName && first.tagName.toLowerCase() === "svg") {
              const holder = document.createElement("span");
              holder.innerHTML = '<svg viewBox="0 0 1024 1024" width="16" height="16" aria-hidden="true" xmlns="http://www.w3.org/2000/svg"><path fill="currentColor" d="M987.008 238.208c-10.24-5.056-14.72 4.48-20.736 9.408-2.048 1.6-3.84 3.648-5.504 5.504-15.04 16.128-32.64 26.624-55.488 25.408-33.6-1.92-62.208 8.64-87.488 34.368-5.376-31.68-23.296-50.56-50.432-62.72-14.272-6.336-28.672-12.608-38.592-26.368-6.976-9.728-8.832-20.544-12.352-31.232-2.24-6.464-4.48-13.12-11.84-14.208-8.064-1.28-11.2 5.504-14.4 11.136-12.672 23.168-17.536 48.64-17.088 74.56 1.088 58.112 25.6 104.32 74.304 137.344 5.568 3.712 7.04 7.552 5.248 13.056-3.328 11.328-7.296 22.4-10.752 33.664-2.24 7.296-5.568 8.896-13.248 5.696a222.592 222.592 0 0 1-70.272-47.744c-34.56-33.472-65.92-70.528-104.96-99.52a450.688 450.688 0 0 0-27.84-19.072c-39.872-38.784 5.184-70.592 15.616-74.368 10.944-3.84 3.84-17.472-31.488-17.28-35.2 0.128-67.52 11.968-108.608 27.648a113.664 113.664 0 0 1-18.816 5.504 390.4 390.4 0 0 0-116.544-4.032c-76.224 8.512-137.088 44.608-181.888 106.24C30.08 405.12 17.472 489.216 32.896 576.96c16.32 92.416 63.424 169.024 135.872 228.864 75.136 62.08 161.6 92.416 260.288 86.592 59.968-3.392 126.72-11.52 201.984-75.2 18.944 9.408 38.848 13.12 71.936 16 25.472 2.432 49.92-1.28 68.992-5.12 29.696-6.4 27.648-33.92 16.896-39.04-87.168-40.576-68.032-24.064-85.44-37.376 44.288-52.48 111.04-107.008 137.152-283.52 2.048-14.08 0.256-22.848 0-34.24-0.128-6.912 1.408-9.6 9.28-10.432 21.824-2.432 43.008-8.448 62.528-19.2 56.448-30.912 79.168-81.536 84.544-142.4 0.832-9.216-0.128-18.88-9.92-23.744z m-491.968 547.2c-84.48-66.496-125.44-88.32-142.336-87.36-15.808 0.832-12.992 18.944-9.536 30.784 3.648 11.648 8.384 19.712 15.104 29.952 4.544 6.784 7.68 16.896-4.608 24.384-27.2 16.896-74.496-5.632-76.736-6.784-55.04-32.384-101.056-75.264-133.504-133.824a409.6 409.6 0 0 1-52.48-181.504c-0.768-15.616 3.84-21.12 19.328-23.936 20.352-3.712 41.472-4.48 61.824-1.6 86.208 12.608 159.552 51.264 221.056 112.32 35.136 34.88 61.696 76.48 89.088 117.12 29.056 43.136 60.416 84.224 100.224 117.888 14.08 11.84 25.344 20.864 36.032 27.52-32.384 3.52-86.464 4.352-123.52-24.96z m40.448-260.736a12.416 12.416 0 1 1 24.832 0 12.416 12.416 0 0 1-12.48 12.48 12.288 12.288 0 0 1-12.352-12.48z m125.696 64.64a73.984 73.984 0 0 1-23.808 6.464 50.88 50.88 0 0 1-32.32-10.24c-11.008-9.28-18.944-14.464-22.272-30.72a71.616 71.616 0 0 1 0.64-23.808c2.88-13.248-0.32-21.76-9.6-29.44-7.68-6.336-17.28-8-27.904-8a22.528 22.528 0 0 1-10.24-3.2c-4.48-2.24-8.064-7.68-4.608-14.528a47.488 47.488 0 0 1 7.744-8.448c14.4-8.192 30.976-5.504 46.336 0.64 14.272 5.824 24.96 16.512 40.448 31.616 15.872 18.24 18.688 23.36 27.712 36.992 7.104 10.816 13.632 21.76 18.048 34.432 2.688 7.808-0.832 14.272-10.176 18.24z"/></svg>';
              first.parentNode.replaceChild(holder.firstChild, first);
            }
            button.setAttribute("data-dsh-whale", "1");
          }
        } catch (err) { /* noop */ }
      }
      patchSettingsNavIcon();
      const settingsNavObserver = new MutationObserver(patchSettingsNavIcon);
      if (document.body) settingsNavObserver.observe(document.body, { childList: true, subtree: true });
      ctx.effect(function () {
        return function () { settingsNavObserver.disconnect(); };
      }, "review-changes: settings nav whale icon");

      // Reverse workbench watchdog. It never filters dsh UI; it only reacts
      // when the CURRENT session lands in a workbench outside the whitelist
      // this VS Code window declared, then pulls it back immediately.
      function findBoundWorkspace(items) {
        for (const want of vscodeScopePaths.concat(vscodeScopeRawPaths)) {
          const hit = items.find((w) => w && normalizeScopePath(w.path) === normalizeScopePath(want));
          if (hit) return hit;
        }
        return null;
      }

      function latestBoundSession(workspace, byId) {
        let best = null;
        let bestAt = -Infinity;
        for (const id of Array.isArray(workspace.sessionIds) ? workspace.sessionIds : []) {
          const summary = byId[id];
          if (!summary || summary.blank) continue;
          if (summary.origin === "subagent" || summary.parentId) continue;
          const at = typeof summary.updatedAt === "number" ? summary.updatedAt : 0;
          if (best === null || at > bestAt) { best = id; bestAt = at; }
        }
        return best;
      }

      function checkWorkbenchScope() {
        if (!scopeIsActive()) return;
        const workspaces = ctx.workspaces;
        const sessions = ctx.sessions;
        if (!workspaces || !sessions) { console.warn("[dsh-review] scope watchdog: workspaces/sessions unavailable"); return; }
        let wsnap, ssnap;
        try { wsnap = workspaces.list.getSnapshot(); } catch (e) { return; }
        try { ssnap = sessions.list.getSnapshot(); } catch (e) { return; }
        const current = ssnap && ssnap.current;
        if (!current) return;
        const items = Array.isArray(wsnap.items) ? wsnap.items : [];
        const byId = (ssnap && ssnap.byId) || {};
        const currentWs = items.find((w) => Array.isArray(w.sessionIds) && w.sessionIds.indexOf(current) >= 0);
        if (!currentWs) return;
        if (scopePathAllowed(currentWs.path)) return;

        // Drift detected: immediate pullback, throttled only against loops.
        const now = Date.now();
        if (vscodeScopePullingAt && now - vscodeScopePullingAt < 1500) return;
        vscodeScopePullingAt = now;
        postScopeMessage("dshScopeViolation", { from: currentWs.path, to: vscodeScopePaths[0] || vscodeScopeRawPaths[0] || "" });

        function goHome() {
          try {
            if (sessions && typeof sessions.clear === "function") sessions.clear();
          } catch (e) { console.warn("[dsh-review] scope home clear failed:", e && e.message || e); }
        }

        const bound = findBoundWorkspace(items);
        if (!bound) {
          // The bound workbench does not exist in dsh at all. There is
          // nowhere to pull back to, so return to dsh's home / workspace
          // selection view instead of repeatedly nagging VSCode.
          postScopeMessage("dshScopeMissing", { path: vscodeScopePaths[0] || vscodeScopeRawPaths[0] || "" });
          goHome();
          return;
        }
        const target = latestBoundSession(bound, byId);
        if (target) {
          try {
            sessions.open(target);
          } catch (e) {
            console.warn("[dsh-review] scope pullback open failed:", e && e.message || e);
            postScopeMessage("dshScopeMissing", { path: bound.path, error: e && e.message || String(e) });
            goHome();
          }
          return;
        }
        // No real session yet: navigate to the workbench's blank-session
        // placeholder (no message is sent, so no real session is created).
        try {
          workspaces.connectWorkspace(bound.workspaceId).then(
            function (sessionId) {
              try { sessions.open(sessionId); } catch (e) {
                console.warn("[dsh-review] scope blank session open failed:", e && e.message || e);
                postScopeMessage("dshScopeMissing", { path: bound.path, error: e && e.message || String(e) });
                goHome();
              }
            },
            function (e) {
              postScopeMessage("dshScopeMissing", { path: bound.path, error: e && e.message || String(e) });
              goHome();
            }
          );
        } catch (e) {
          postScopeMessage("dshScopeMissing", { path: bound.path, error: e && e.message || String(e) });
          goHome();
        }
      }

      ctx.effect(function () {
        const timer = setInterval(checkWorkbenchScope, 350);
        return function () { clearInterval(timer); };
      }, "review-changes: workbench scope watchdog");

      ctx.inject(["slots", "conversation", "inputTriggers"], function(scope) {
        try {
          const conversation = scope.conversation;
          if (conversation && conversation.input && typeof conversation.input.shell === "function") {
            inputHub = conversation.input;
            console.log("[dsh-review] native chip pipeline: conversation.input.shell available");
          } else {
            console.warn("[dsh-review] native chip pipeline unavailable (no conversation.input.shell); refs will fall back to text");
          }
        } catch (err) {
          console.warn("[dsh-review] native chip pipeline probe failed:", err && err.message || err);
        }
        postPipelineProbe();
        scope.effect(function() {
          let unregisterRefSource = function () {};
          try {
            if (scope.inputTriggers && typeof scope.inputTriggers.registerSource === "function") {
              unregisterRefSource = scope.inputTriggers.registerSource({
                trigger: "@",
                name: REF_SOURCE,
                order: 1000,
                candidates: async function () { return []; },
                codec: { serialize: serializeRef },
              });
              refSourceRegistered = true;
              console.log("[dsh-review] vscode-ref trigger source registered");
            } else {
              console.warn("[dsh-review] inputTriggers unavailable; chip send-serialization will not work");
            }
          } catch (err) {
            console.warn("[dsh-review] vscode-ref source registration failed:", err && err.message || err);
          }
          postPipelineProbe();
          // Settings-page section. Register it robustly: use slots.inject when
          // the declaration is late (normal path), and also poll for the
          // declared slot so a timing/cache quirk can never silently drop the
          // nav entry.
          let unregisterSettingsSection = function () {};
          let settingsRegistered = false;
          function settingsSectionInstalled() {
            try {
              if (!scope.slots || typeof scope.slots.entries !== "function") return false;
              const list = scope.slots.entries("settings.section") || [];
              return list.some((e) => e && e.options && e.options.id === "review-changes");
            } catch (err) { return false; }
          }
          function registerSettingsSection() {
            if (settingsRegistered || settingsSectionInstalled()) { settingsRegistered = true; return; }
            try {
              const declared = scope.slots && typeof scope.slots.spec === "function" && !!scope.slots.spec("settings.section");
              if (!declared) return;
              const dispose = scope.slots.register({
                name: "settings.section",
                id: "review-changes",
                order: 40,
                label: function () { return "历史待裁决"; },
              }, HistoryReviewSettingsSection);
              settingsRegistered = true;
              unregisterSettingsSection = function () { try { dispose(); } catch (err) { /* noop */ } };
              console.log("[dsh-review] settings.section registered (ensure path):", CLIENT_BUILD);
            } catch (err) {
              console.warn("[dsh-review] settings.section direct registration failed:", err && err.message || err);
            }
          }
          try {
            if (scope.slots && typeof scope.slots.inject === "function") {
              const injectDispose = scope.slots.inject("settings.section", function () {
                try {
                  if (settingsSectionInstalled()) { settingsRegistered = true; return function () {}; }
                  const dispose = scope.slots.register({
                    name: "settings.section",
                    id: "review-changes",
                    order: 40,
                    label: function () { return "历史待裁决"; },
                  }, HistoryReviewSettingsSection);
                  settingsRegistered = true;
                  unregisterSettingsSection = function () { try { dispose(); } catch (err) { /* noop */ } };
                  console.log("[dsh-review] settings.section registered (inject path):", CLIENT_BUILD);
                  return dispose;
                } catch (err) {
                  console.warn("[dsh-review] settings.section inject registration failed:", err && err.message || err);
                }
              });
              if (injectDispose) {
                const oldDispose = unregisterSettingsSection;
                unregisterSettingsSection = function () {
                  try { injectDispose(); } catch (err) { /* noop */ }
                  oldDispose();
                };
              }
            } else {
              console.warn("[dsh-review] slots.inject unavailable; will retry direct registration");
            }
          } catch (err) {
            console.warn("[dsh-review] settings.section slots.inject failed:", err && err.message || err);
          }
          // Belt-and-suspenders retry: once the declaration exists, register
          // directly if the inject path never fired.
          registerSettingsSection();
          let settingsRetryTimer = null;
          if (!settingsRegistered) {
            settingsRetryTimer = setInterval(function () {
              if (settingsRegistered) { clearInterval(settingsRetryTimer); settingsRetryTimer = null; return; }
              registerSettingsSection();
            }, 1000);
          }
          const unregisterDock = scope.slots.register({ 
            name: "conversation.input.dock",
            id: "review-changes",
            order: 5,
          }, ReviewChangesDock);
          return function () {
            if (settingsRetryTimer !== null) { clearInterval(settingsRetryTimer); settingsRetryTimer = null; }
            unregisterSettingsSection();
            unregisterDock();
            unregisterRefSource();
            refSourceRegistered = false;
          };
        }, "review-changes: dock + vscode-ref source");
      }); 
    }

    exports.apply = apply;
    // Declare the services so ctx.slots / ctx.workspaces / ctx.sessions are
    // bound when apply() runs: settings registration needs slots, and the
    // reverse workbench watchdog needs the workspace/session service faces.
    exports.inject = ["slots", "workspaces", "sessions"];
    return module.exports; 
  }
}); 
