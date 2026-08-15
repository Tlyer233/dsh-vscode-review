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

    // Native dsh occurrence-chip pipeline (semi-public service faces):
    //   ctx.conversation.input.shell(sessionId) -> SessionInputShell
    //   ctx.inputTriggers.registerSource(...)   -> codec used at send time.
    let inputHub = null;
    let refSourceRegistered = false;
    const refRegistry = new Map();
    let refSeq = 0;

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
        let lastEditable = null;

        function postToParent(msg) {
          try { window.parent.postMessage(msg, "*"); } catch (err) { /* noop */ }
        }

        function activeEditable() {
          const el = document.activeElement;
          if (!el) return null;
          if (el.tagName === "TEXTAREA" || el.isContentEditable) return el;
          return null;
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
          const expanded = occurrenceExpandedSelection(document.activeElement);
          if (expanded !== null) return expanded;
          const sel = window.getSelection();
          return sel ? sel.toString() : "";
        }

        function isEditable(el) {
          return !!el && (el.tagName === "TEXTAREA" || el.isContentEditable);
        }

        function onFocusIn(event) {
          const el = event.target;
          if (isEditable(el)) lastEditable = el;
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
          if (el.tagName === "TEXTAREA") {
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

        // Preferred target -> last focused editable -> draft append fallback.
        function insertIncomingText(text, preferred) {
          const target = isEditable(preferred) ? preferred
            : (lastEditable && document.body.contains(lastEditable) ? lastEditable : null);
          if (target && insertAtCaret(target, text)) return;
          if (inputActions) inputActions.setDraft(draftRef.current + text);
        }

        // ---- Native chip insertion (spike) --------------------------------
        function preferredEditable(preferred) {
          if (isEditable(preferred)) return preferred;
          if (lastEditable && document.body.contains(lastEditable)) return lastEditable;
          return null;
        }

        function currentSelection(preferred) {
          const el = preferredEditable(preferred);
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
            if (fallbackText) insertIncomingText(fallbackText, preferred);
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
            const target = preferredEditable(preferred);
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
            if (fallbackText) insertIncomingText(fallbackText, preferred);
            return { mode: "text", count: list.length, reason: err && err.message || String(err) };
          }
        }

        function applyZoom() {
          try { document.documentElement.style.zoom = zoom === 1 ? "" : String(zoom); } catch (err) { /* noop */ }
        }

        function onBridgeMessage(event) {
          const msg = event.data;
          if (!msg) return;
          if (msg.type === "dshInsertText" && typeof msg.text === "string") {
            // Insert at the composer caret (last focused editable if the
            // message arrives while VS Code has focus); append to draft only
            // when no editable has ever been focused.
            insertIncomingText(msg.text, document.activeElement);
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
              : document.activeElement;
            pendingPasteTarget = null;
            insertIncomingText(msg.text, target);
          }
        }

        // The iframe cannot reliably reach the system clipboard, so copy/cut
        // go through the extension. Paste is read by the extension and comes
        // back as dshPasteText.
        function onKeydown(event) {
          const mod = event.metaKey || event.ctrlKey;
          if (!mod) return;
          const key = String(event.key || "").toLowerCase();
          const editable = activeEditable();

          if (key === "a") {
            if (!editable) return;
            event.preventDefault();
            if (editable.tagName === "TEXTAREA") {
              editable.focus();
              editable.setSelectionRange(0, editable.value.length);
            } else {
              editable.focus();
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
              if (editable.tagName === "TEXTAREA") {
                replaceTextareaSelection(editable, "");
              } else {
                editable.focus();
                try { document.execCommand("delete", false, null); } catch (err) { /* noop */ }
              }
            }
          } else if (key === "v") {
            event.preventDefault();
            pendingPasteTarget = document.activeElement;
            postToParent({ type: "dshPasteRequest" });
          } else if (key === "r") {
            if (event.repeat) return;
            event.preventDefault();
            postToParent({ type: "dshReload", force: !!event.shiftKey });
          } else if (key === "+" || key === "=") {
            event.preventDefault();
            zoom = Math.min(2, Math.round((zoom + 0.1) * 10) / 10);
            applyZoom();
          } else if (key === "-" || key === "_") {
            event.preventDefault();
            zoom = Math.max(0.5, Math.round((zoom - 0.1) * 10) / 10);
            applyZoom();
          } else if (key === "0") {
            event.preventDefault();
            zoom = 1;
            applyZoom();
          }
        }

        // dsh -> VSCode copy fallback: also catches context-menu copy.
        function onCopy(event) {
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
          if (!event.shiftKey || !event.dataTransfer) return;
          event.preventDefault();
        }

        function onDrop(event) {
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

        window.addEventListener("message", onBridgeMessage);
        document.addEventListener("keydown", onKeydown, true);
        document.addEventListener("copy", onCopy);
        document.addEventListener("focusin", onFocusIn, true);
        document.addEventListener("dragover", onDragOver, true);
        document.addEventListener("drop", onDrop, true);
        return () => {
          window.removeEventListener("message", onBridgeMessage);
          document.removeEventListener("keydown", onKeydown, true);
          document.removeEventListener("copy", onCopy);
          document.removeEventListener("focusin", onFocusIn, true);
          document.removeEventListener("dragover", onDragOver, true);
          document.removeEventListener("drop", onDrop, true);
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
              style: { display: "flex", alignItems: "center", gap: "10px", minWidth: 0, fontSize: "13px", lineHeight: "20px", color: "var(--dsw-alias-label-secondary, var(--dsh-color-text, inherit))" } 
            },
              h("span", { style: { fontFamily: "monospace", fontSize: "11px", minWidth: "16px", textAlign: "right", color: !entry.fileExists ? "var(--dsh-color-danger, #e5534b)" : entry.operation === "create" ? "var(--dsh-color-success, #2da44e)" : "var(--dsh-color-accent, #50a0ff)" } }, !entry.fileExists ? "\u{1F5D1}" : entry.operation === "create" ? "\u2795" : "\u270F\uFE0F"),
              h("span", {
                style: { fontWeight: 500, whiteSpace: "nowrap", color: !entry.fileExists ? "var(--dsh-color-danger, #e5534b)" : "var(--dsh-color-accent, #50a0ff)", textDecoration: !entry.fileExists ? "line-through" : "none", cursor: "pointer" },
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
                onMouseLeave: function(e) { e.target.style.textDecoration = "none" }
              }, basename),
              h("span", { style: { opacity: 0.4, fontSize: "11px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1 } }, dir),
              h("span", { style: { fontFamily: "monospace", fontSize: "11px", color: "var(--dsh-color-success, #2da44e)", whiteSpace: "nowrap" } }, "+" + entry.additions),  h("span", { style: { opacity: 0.4, fontSize: "11px", marginLeft: "4px" } }, entry.unreviewedHunks + " unreviewed"), 
              h("span", { style: { fontFamily: "monospace", fontSize: "11px", color: "var(--dsh-color-danger, #e5534b)", whiteSpace: "nowrap" } }, "-" + entry.deletions), 
            );
          })
        )
      );
    }

    function apply(ctx) { 
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
          const unregisterDock = scope.slots.register({ 
            name: "conversation.input.dock",
            id: "review-changes",
            order: 5,
          }, ReviewChangesDock);
          return function () {
            unregisterDock();
            unregisterRefSource();
            refSourceRegistered = false;
          };
        }, "review-changes: dock + vscode-ref source");
      }); 
    }

    exports.apply = apply;
    return module.exports; 
  }
}); 
