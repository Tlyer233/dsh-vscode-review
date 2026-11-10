// dsh-review client (bridge + chips; dock UI kept for chip pipeline parity)

window.__ModuleLoader__.load({
  id: "dsh-review",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
    const React = require("react");
    const { createElement: h, useState, useEffect, useCallback, useRef, useSyncExternalStore } = React;

    const REF_SOURCE = "vscode-ref";

    // Dock op icons (from icon.md) — fill via currentColor so row tint applies.
    const OP_ICON_EDIT = "M684.202667 117.248c15.893333-15.872 42.154667-15.36 58.922666 1.408l90.517334 90.517333c16.661333 16.661333 17.344 42.986667 1.429333 58.922667l-445.653333 445.653333c-7.936 7.914667-23.104 16.746667-34.218667 19.776l-143.701333 39.253334c-21.909333 5.994667-35.114667-7.104-29.568-28.949334l37.248-146.773333c2.773333-10.944 11.562667-26.346667 19.392-34.176l445.653333-445.653333zM268.736 593.066667c-2.901333 2.901333-8.106667 12.074667-9.130667 16.021333l-29.12 114.773333 111.957334-30.570666c4.437333-1.216 13.632-6.549333 16.810666-9.728l445.653334-445.653334-90.517334-90.496-445.653333 445.653334zM682.794667 178.986667l90.517333 90.517333-30.186667 30.186667-90.496-90.517334 30.165334-30.165333z m-362.026667 362.048l90.496 90.517333-30.165333 30.165333-90.517334-90.496 30.165334-30.186666zM170.666667 874.666667c0-11.776 9.429333-21.333333 21.461333-21.333334h661.077333a21.333333 21.333333 0 1 1 0 42.666667H192.128A21.333333 21.333333 0 0 1 170.666667 874.666667z";
    const OP_ICON_CREATE = "M465.454545 465.454545V139.636364a46.545455 46.545455 0 0 1 93.09091 0v325.818181h325.818181a46.545455 46.545455 0 0 1 0 93.09091H558.545455v325.818181a46.545455 46.545455 0 0 1-93.09091 0V558.545455H139.636364a46.545455 46.545455 0 0 1 0-93.09091z";
    const OP_ICON_DELETE_A = "M832 1024H192V288h64v672h512V288h64v736zM128 160h768v64H128z";
    const OP_ICON_DELETE_B = "M672 224H352V0h320z m-256-64h192V64h-192zM384 384h64v448h-64zM576 384h64v448h-64z";

    /**
     * Small SVG glyph for dock row operation.
     * @param {string} op create|edit|delete
     * @param {string} color css color
     */
    function OpIcon(op, color) {
      const kids = op === "delete"
        ? [
          h("path", { key: "a", d: OP_ICON_DELETE_A, fill: "currentColor" }),
          h("path", { key: "b", d: OP_ICON_DELETE_B, fill: "currentColor" }),
        ]
        : [
          h("path", {
            key: "p",
            d: op === "create" ? OP_ICON_CREATE : OP_ICON_EDIT,
            fill: "currentColor",
          }),
        ];
      return h("span", {
        title: op,
        style: {
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          width: "14px",
          height: "14px",
          color: color,
          flex: "none",
        },
      },
        h("svg", {
          viewBox: "0 0 1024 1024",
          width: "14",
          height: "14",
          "aria-hidden": "true",
          style: { display: "block" },
        }, kids)
      );
    }
    let inputHub = null;
    let conversationApi = null;
    let refSourceRegistered = false;
    let bridgeActive = false;
    let clipboardBridged = false;
    const refRegistry = new Map();
    let refSeq = 0;

    // Annotation dock (0.2.3): chip row ABOVE the composer input, mirroring the
    // Copilot attachment strip (dsh-annotate mechanism: native slot
    // conversation.input.dock). The extension is the single source of truth
    // (Copilot observer beacon -> dshAnnoDock full state); the dock is a pure
    // mirror. Deletion is delegated back (dshAnnoDelete) so the extension can
    // perform the REAL CDP click on the Copilot chip — only that removes the
    // native pin. Send/manual-clear of the draft = consume all (dshAnnoConsumed).
    let annoDockChips = [];
    const annoDockSubscribers = new Set();
    function setAnnoDockChips(list) {
      const next = Array.isArray(list) ? list.filter(Boolean).map(function (c) {
        return { name: String(c.name || ""), text: String(c.text || ""), key: String(c.key || ""), kind: String(c.kind || "element"), file: c.file ? String(c.file) : "" };
      }) : [];
      const same = next.length === annoDockChips.length && next.every(function (c, i) {
        return c.key === annoDockChips[i].key && c.text === annoDockChips[i].text && c.file === annoDockChips[i].file;
      });
      if (same) return;
      annoDockChips = next;
      annoDockSubscribers.forEach(function (fn) { try { fn(); } catch (err) { /* noop */ } });
    }
    function subscribeAnnoDock(fn) {
      annoDockSubscribers.add(fn);
      return function () { annoDockSubscribers.delete(fn); };
    }

    // Send detection (0.2.4): fire dshAnnoConsumed ONLY on a REAL send —
    // Enter (non-Shift, non-composing) inside the composer, or the composer's
    // primary (send) button click. A manual clear (Cmd+A + delete) presses
    // neither, so it no longer triggers the Copilot flash. This replaces the
    // old ambiguous "draft non-empty -> empty" heuristic that fired on BOTH
    // send and manual clear. Selectors mirror dsh-annotate's proven
    // composerPrimary()/onComposerEnter() exactly.
    let lastAnnoSendMark = 0;
    // (0.2.15) ③ SYNCHRONOUS intercept-and-append — dsh-annotate@0.1.0 shape
    // copied exactly: the MATERIAL (element/comment/file) was delivered at
    // ANNOTATION time via dshAnnoDock (annoDockChips = their pending Map),
    // so at Enter time everything is local & SYNC: compose (L775-780),
    // only THEN preventDefault (L781-782), submit via the session face
    // prompt(parts,'queue') (L851) which works idle AND generating; the
    // setDraft+button path (L181-189) is the documented fallback.
    let annoForwarding = false;
    let annoPrepSeq = 0;
    const annoPrepPending = new Map();
    // (2.1.1) SEND-POINT GATE (user: "能不绑定enter吗? 直接卡dsh的发送"): the
    // upstream composer has exactly ONE submit funnel — sink -> conversation
    // .sendSession(session, text, attachmentIds, mode, signal) (verified in
    // dsh-client-ui-conversation/lib/client.js 4685+15884). We wrap it on the
    // instance we already hold. Enter, the Send button, and the accelerated
    // chord ALL arrive here, with the GUI-already-resolved mode ('queue'|
    // 'steer') as a parameter — no busyEnter guessing needed on this path.
    // Other inputs' Enter (e.g. the AskUserQuestion custom-answer field) never
    // touches sendSession, so it stops being intercepted at all. The old Enter
    // interception stays ONLY as fallback for builds without sendSession.
    const annoGatePending = new Map();
    var annoIframeBootAt = Date.now();
    function annoSendGate(orig, session, text, attachmentIds, mode, signal) {
      try {
        if (!vscodeIframeHint() || !getReviewSettings().annotationToDsh) return orig(session, text, attachmentIds, mode, signal);
        if (annoForwarding) return orig(session, text, attachmentIds, mode, signal);
        const t = String(text == null ? "" : text);
        if (t.trim() !== "" && t.trimStart().charAt(0) === "/") {
          try { window.parent.postMessage({ type: "dshPasteLog", line: "[send] gate: slash command pass-through" }, "*"); } catch (err) { /* noop */ }
          return orig(session, text, attachmentIds, mode, signal);
        }
        let para = null;
        try { if (window.__dshaPeek) para = window.__dshaPeek(); } catch (err) { /* noop */ }
        if (para === null && annoDockChips.length === 0) return orig(session, text, attachmentIds, mode, signal);
        const req = ++annoPrepSeq;
        const base = para ? (t === "" ? para.text : t + "\n\n" + para.text) : t;
        try { window.parent.postMessage({ type: "dshPasteLog", line: "[send] gate: block request req=" + req + " mode=" + String(mode) }, "*"); } catch (err) { /* noop */ }
        return new Promise(function (resolve) {
          let done = false;
          const settle = function (block) {
            if (done) return;
            done = true;
            annoGatePending.delete(req);
            const b = String(block || "");
            const finalText = b === "" ? base : (base === "" ? b : base + "\n\n" + b);
            try { if (para && para.sid !== null && para.sid !== undefined && window.__dshaClear) window.__dshaClear(para.sid); } catch (err) { /* noop */ }
            const go = function () { resolve(orig(session, finalText, attachmentIds, mode, signal)); };
            try { annoProgFinish(go); } catch (err) { go(); }
          };
          annoGatePending.set(req, settle);
          try { annoProgStart(req); } catch (err) { /* noop */ }
          try { window.parent.postMessage({ type: "dshAnnoPrepareReq", req: req }, "*"); } catch (err) { settle(annoComposeBatch()); }
          setTimeout(function () {
            if (!annoGatePending.has(req)) return;
            try { window.parent.postMessage({ type: "dshPasteLog", line: "[send] gate: prepared timeout 75s -> self-composed" }, "*"); } catch (err) { /* noop */ }
            settle(annoComposeBatch());
          }, 75000);
        });
      } catch (err) {
        try { window.parent.postMessage({ type: "dshPasteLog", line: "[send] gate error -> native passthrough: " + String(err).slice(0, 90) }, "*"); } catch (e2) { /* noop */ }
        return orig(session, text, attachmentIds, mode, signal);
      }
    }
    // (0.2.22) SEND PROGRESS UI: while a send is held for the Copilot read,
    // LOCK the composer (disabled input) and ring it with a progress bar;
    // bar full (dshAnnoPrepared) = the message goes out. Stages from the
    // extension: 1 hover starting, 2 captures done, 3 fills done, prepared=100.
    let annoProgReq = null;
    let annoProgEls = null;
    let annoAnimT = null;
    // (0.2.30) defined at load so the vendored dsha capture-phase handlers can
    // consult it on the VERY FIRST Enter (hoisting-safe: any TDZ miss = false).
    window.__dshrWillTakeEnter = function () {
      try {
        if (!vscodeIframeHint()) return false;
        if (!getReviewSettings().annotationToDsh) return false;
        if (annoForwarding) return false;
        if (annoProgReq !== null) return false;
        return true;
      } catch (err) { return false }
    };
    // (0.2.39) quadratic, FAST-then-SLOW (user: "刚开始快, 后面慢, 你反了"):
    // p(t) = ceil * (1 - (1 - t/T)^2) — quick launch, even decelerating creep
    // toward the cap; prepared answer jumps to 100.
    function annoAnimTo(target, ratePerSec) {
      void target; void ratePerSec;
      const els = annoProgEls;
      if (!els) return;
      if (annoAnimT) { clearInterval(annoAnimT); annoAnimT = null; }
      const t0 = Date.now();
      // (0.2.45) user ruling: roar to 66% fast, then a long slow crawl.
      // phase1 (0-6s):  66*(1-(1-t/6)^2)          — steep launch, soft landing at 66
      // phase2 (6-60s): 66+30*(1-(1-(t-6)/54)^2)  — slow creep toward 96
      // prepared tops to 100. Continuous, monotonic, no abrupt jump.
      const P1 = 6000, C1 = 66, P2 = 54000, C2 = 96;
      try { window.parent.postMessage({ type: "dshPasteLog", line: "[paste] prog animator start (client 0.2.45, 66-then-crawl)" }, "*"); } catch (err) { /* noop */ }
      annoAnimT = setInterval(function () {
        try {
          const cur = parseFloat(els.bar.style.width) || 0;
          const el2 = Date.now() - t0;
          let p;
          if (el2 <= P1) { const g1 = 1 - el2 / P1; p = C1 * (1 - g1 * g1); }
          else { const f2 = Math.min(1, (el2 - P1) / P2); const g2 = 1 - f2; p = C1 + (C2 - C1) * (1 - g2 * g2); }
          p = Math.max(cur, p); // monotonic
          els.bar.style.width = p + "%";
        } catch (err) { if (annoAnimT) { clearInterval(annoAnimT); annoAnimT = null; } }
      }, 100);
    }
    function annoProgStyle() {
      if (document.getElementById("dshr-anno-prog-css")) return;
      const st = document.createElement("style");
      st.id = "dshr-anno-prog-css";
      st.textContent = ".dshr-anno-lock{position:relative;} .dshr-anno-ring{position:absolute;inset:calc(0px - var(--dsw-focus-ring-width, 2px));border-radius:var(--dsw-radius-md, 12px);border:var(--dsw-focus-ring-width, 2px) solid currentColor;pointer-events:none;z-index:40;} .dshr-anno-bar{position:absolute;left:0;top:0;bottom:0;width:0%;border-radius:var(--dsw-radius-md, 12px);background:currentColor;opacity:.16;transition:width var(--ds-transition-duration, .2s) var(--ds-ease-in-out, ease);pointer-events:none;z-index:39;}";
      (document.head || document.documentElement).appendChild(st);
    }
    function annoProgStart(req) {
      const card = document.querySelector("[data-composer-card]");
      if (!card) return;
      annoProgStyle();
      annoProgReq = req;
      card.classList.add("dshr-anno-lock");
      const ring = document.createElement("div"); ring.className = "dshr-anno-ring";
      const bar = document.createElement("div"); bar.className = "dshr-anno-bar";
      card.appendChild(ring); card.appendChild(bar);
      const ed = card.querySelector('[contenteditable="true"]');
      let edRestore = null;
      if (ed) { edRestore = { el: ed }; ed.setAttribute("contenteditable", "false"); ed.style.opacity = "0.55"; ed.style.pointerEvents = "none"; }
      const ta = card.querySelector("textarea");
      if (ta && !ed) { edRestore = { el: ta, was: ta.disabled }; ta.disabled = true; }
      const btn = card.querySelector('button[class*="primary"]');
      let btnRestore = null;
      if (btn && !btn.disabled) { btnRestore = { el: btn }; btn.disabled = true; }
      annoProgEls = { card: card, ring: ring, bar: bar, ed: edRestore, btn: btnRestore };
      bar.style.transition = "none";
      bar.style.width = "0%";
      annoAnimTo(38, 22); // (0.2.28) 0 -> 38% in ~1.7s: the "we got it" fast segment
    }
    function annoProgStage(stage) {
      if (!annoProgEls) return;
      // (0.2.28) even creep per phase: snapshot+scan is the long haul (15-40s),
      // crawl 38 -> 88 at ~1.5%/s instead of sitting at 40 then sprinting.
      // (0.2.38) stages no longer retarget — the quadratic runs the whole way
    }
    function annoProgFinish(then) {
      const els = annoProgEls;
      annoProgEls = null; annoProgReq = null;
      if (annoAnimT) { clearInterval(annoAnimT); annoAnimT = null; }
      if (!els) { if (then) then(); return; }
      try { els.bar.style.transition = "width .15s ease"; els.bar.style.width = "100%"; } catch (err) { /* noop */ }
      setTimeout(function () {
        try {
          if (els.ed) { els.ed.el.setAttribute("contenteditable", "true"); els.ed.el.style.opacity = ""; els.ed.el.style.pointerEvents = ""; }
          if (els.btn) els.btn.el.disabled = false;
          els.card.classList.remove("dshr-anno-lock");
          if (els.ring.parentNode) els.ring.parentNode.removeChild(els.ring);
          if (els.bar.parentNode) els.bar.parentNode.removeChild(els.bar);
        } catch (err) { /* noop */ }
        if (then) then();
      }, 180);
    }
    function annoComposeBatch() {
      // (0.2.37) ELEMENT chips only — attachments (file/snippet/terminal/
      // screenshot) are NOT annotations; they never ride the self-composed
      // (busy-flush / timeout) block.
      const els = annoDockChips.filter(function (c) { return !c.kind || c.kind === "element"; });
      if (els.length === 0) return "";
      const lines = ["以下是我对浏览器元素的标注(全文见各文件):", ""];
      els.forEach(function (c, i) {
        lines.push((i + 1) + ". @" + c.name + "  注释: " + (c.text || "(无)"));
        lines.push("   全文文件: " + (c.file || "(待补)"));
      });
      return lines.join("\n");
    }
    function annoReadDraft(event) {
      let raw = "";
      try { if (window.__dshrAnnoGetDraft) raw = String(window.__dshrAnnoGetDraft() || ""); } catch (err) { /* noop */ }
      if (!raw && event && event.target) {
        try { raw = String(event.target.value || event.target.innerText || event.target.textContent || ""); } catch (err) { /* noop */ }
      }
      return raw.replace(/\u200b/g, "");
    }
    function markAnnoSend(event) {
      // true = intercepted (message already submitted synchronously; caller suppresses native)
      try {
        window.parent.postMessage({ type: "dshPasteLog", line: "anno mark: hint=" + (vscodeIframeHint() ? 1 : 0) + " toggle=" + (getReviewSettings().annotationToDsh ? 1 : 0) + " chips=" + annoDockChips.length + " fwd=" + (annoForwarding ? 1 : 0) }, "*");
      } catch (err) { /* noop */ }
      if (!vscodeIframeHint()) return false;
      if (!getReviewSettings().annotationToDsh) return false;
      if (annoForwarding) return false;
      // (2.1.1) sendSession gate active -> native submit; the gate does the work.
      if (window.__dshrSendWrapped === true) return false;
      const now = Date.now();
      if (now - lastAnnoSendMark < 200) return false;  // debounce: one gesture, one send
      lastAnnoSendMark = now;
      // (0.2.27) DOCK IS NOT GROUND TRUTH: the extension re-checks its own
      // beacon state (annoCurrentChips) and answers '' instantly when Copilot
      // is truly empty (no flash, ~100ms round trip). Killing this early
      // return fixes the stale-dock class: annotations created while the
      // toggle was OFF never reached our dock, sends then bypassed capture
      // entirely ("我标注了, copilot有, 但没带上").
      const draft = annoReadDraft(event).trim();
      // (2.0.49) SLASH COMMANDS PASS UNTOUCHED: /plan, /mode … must arrive at
      // dsh exactly as typed or they stop being commands (user: "我/plan无法被
      // dsh识别为mode"). No interception, no append — pending pills stay on the
      // pill shelf and ride the next plain send.
      if (draft !== "" && /^\//.test(draft)) {
        try { window.parent.postMessage({ type: "dshPasteLog", line: "[paste] slash command send -> native pass-through (no anno touch)" }, "*"); } catch (err) { /* noop */ }
        return false;
      }
      // (0.2.29 note) Do NOT gate on "@name in draft": annotations ride
      // AUTOMATICALLY on any send — the user's prose never mentions them.
      // (0.2.30) UNIFIED ENTER ORCHESTRATOR (dsh-annotate internalized): the
      // paragraph batch, when one waits, is merged into the draft this send
      // carries; the vendored handlers step aside via __dshrWillTakeEnter.
      // (0.2.19) USER-FINAL ORDER — ALWAYS read Copilot FIRST, send after.
      // No fast path on stale lists: the extension does the authoritative read
      // (page rebuild + hover + file writes) and answers dshAnnoPrepared the
      // moment the read completes; submission happens at THAT instant.
      // (No dshAnnoConsumed post: it would double-trigger the same read.)
      // Ask the extension; it flashes, hovers, fills the reserved files, then
      // answers with the finished block — we submit at that moment. 8s
      // timeout submits anyway (with whatever rows we have).
      // (0.2.29) A capture is already in flight for an earlier send. Holding
      // THIS Enter too (old behavior) queued it and the queue merge shipped it
      // inside the earlier prompt — the user saw "发不出去". Submit instantly
      // via the normal queue path instead; it needs no attachment block.
      if (annoProgReq !== null) {
        // (0.2.30) ...but paragraph annotations must STILL go out on this Enter:
        try { if (window.__dshaFlushNow && window.__dshaFlushNow(draft)) { try { event.preventDefault(); event.stopPropagation(); } catch (err) { /* noop */ } return true; } } catch (err) { /* noop */ }
        return false;
      }
      const req = ++annoPrepSeq;
      let para = null;
      try { if (window.__dshaPeek) para = window.__dshaPeek(); } catch (err) { /* noop */ }
      const draftFull = para ? (draft === "" ? para.text : draft + "\n\n" + para.text) : draft;
      annoPrepPending.set(req, { draft: draftFull, sid: para ? String(para.sid) : null, at: Date.now() });
      annoProgStart(req);
      try { window.parent.postMessage({ type: "dshAnnoPrepareReq", req: req }, "*"); } catch (err) { /* noop */ }
      try { if (event && event.preventDefault) event.preventDefault(); if (event && event.stopPropagation) event.stopPropagation(); } catch (err) { /* noop */ }
      setTimeout(function () {
        if (!annoPrepPending.has(req)) return;
        const pt = annoPrepPending.get(req);
        annoPrepPending.delete(req);
        annoProgFinish(function () { annoSubmitNow(null, annoFinishText(draft, null), draft); });
        try { if (pt && pt.sid !== null && window.__dshaClear) window.__dshaClear(pt.sid); } catch (err) { /* noop */ }
      }, 75000); // (0.2.26) heap-bridge main path costs ~15-40s (snapshot+parse); hover fallback stays quick. 15s was tuned for hover-only.
      return true;
    }
    function annoFinishText(draft, block) {
      const batch = block || annoComposeBatch();
      return batch ? (draft === "" ? batch : draft + "\n\n" + batch) : draft;
    }
    function annoSubmitNow(event, text, draft) {
      try { if (event && event.preventDefault) event.preventDefault(); if (event && event.stopPropagation) event.stopPropagation(); } catch (err) { /* noop */ }
      annoForwarding = true;
      try {
        let sent = false;
        try { sent = !!(window.__dshrAnnoPrompt && window.__dshrAnnoPrompt(text)); } catch (err) { /* noop */ }
        if (sent) { try { if (window.__dshrAnnoSetDraftFull) window.__dshrAnnoSetDraftFull(""); } catch (err) { /* noop */ } }
        else {
          try { if (window.__dshrAnnoSetDraftFull) window.__dshrAnnoSetDraftFull(text); } catch (err) { /* noop */ }
          const b = document.querySelector('[data-composer-card] button[class*="primary"]');
          if (b && !b.disabled) { try { b.click(); } catch (err) { /* noop */ } }
        }
        annoDockChips = [];
        annoDockSubscribers.forEach(function (fn) { try { fn(); } catch (err) { /* noop */ } });
        try { window.parent.postMessage({ type: "dshPasteLog", line: "anno send: prompt=" + sent + " len=" + text.length }, "*"); } catch (err) { /* noop */ }
      } finally {
        setTimeout(function () { annoForwarding = false; }, 1000);
      }
      void draft;
    }
    try {
      window.__dshrAnnoPrepared = function (req, block) {
        const g = annoGatePending.get(req);
        if (g) { annoGatePending.delete(req); g(String(block || "")); return; }
        const p = annoPrepPending.get(req);
        if (!p) return;
        annoPrepPending.delete(req);
        annoProgFinish(function () { annoSubmitNow(null, annoFinishText(p.draft, String(block || "")), p.draft); });
        try { if (p.sid !== null && window.__dshaClear) window.__dshaClear(p.sid); } catch (err) { /* noop */ }
      };
    } catch (err) { /* noop */ }
    function __unused_markAnnoSend_tail() {
      annoForwarding = true;
      try {
        let sent = false;
        try { sent = !!(window.__dshrAnnoPrompt && window.__dshrAnnoPrompt(text)); } catch (err) { /* noop */ }
        if (sent) {
          try { if (window.__dshrAnnoSetDraftFull) window.__dshrAnnoSetDraftFull(""); } catch (err) { /* noop */ }
        } else {
          try { if (window.__dshrAnnoSetDraftFull) window.__dshrAnnoSetDraftFull(text); } catch (err) { /* noop */ }
          const b = document.querySelector('[data-composer-card] button[class*="primary"]');
          if (b && !b.disabled) { try { b.click(); } catch (err) { /* noop */ } }
        }
        try { window.parent.postMessage({ type: "dshPasteLog", line: "anno send sync: prompt=" + sent + " len=" + text.length }, "*"); } catch (err) { /* noop */ }
      } finally {
        setTimeout(function () { annoForwarding = false; }, 1000);
      }
      return true;
    }
    (function installAnnoSendDetection() {
      if (typeof document === "undefined" || typeof document.addEventListener !== "function") return;
      function composerPrimaryButton() {
        return document.querySelector('[data-composer-card] button[class*="primary"]');
      }
      // Enter in the composer (not Shift+Enter newline, not IME composing) = send.
      document.addEventListener("keydown", function (event) {
        if (event.key !== "Enter" || event.shiftKey === true || event.isComposing === true) return;
        const target = event.target;
        if (!target || typeof target.closest !== "function") return;
        if (target.closest("[data-dsh-annotate]")) return;
        const textarea = target.tagName === "TEXTAREA";
        const inEditor = target.isContentEditable === true || target.closest('[contenteditable="true"]') != null;
        if (!textarea && !inEditor) return;
        if (markAnnoSend(event)) { event.preventDefault(); event.stopPropagation(); }
      }, true);
      // The send button means the same thing as Enter.
      // (0.2.7) While the agent is GENERATING the same primary button morphs
      // into stop/pause — clicking it is not a send. Guard on the label.
      document.addEventListener("click", function (event) {
        const button = composerPrimaryButton();
        if (!button) return;
        const pressed = event.target && event.target.closest ? event.target.closest("button") : event.target;
        if (pressed !== button) return;
        const lbl = String(button.getAttribute("aria-label") || button.title || button.textContent || "").toLowerCase();
        if (/stop|pause|cancel|停止|暂停|取消/.test(lbl)) return;
        if (markAnnoSend(event)) { event.preventDefault(); event.stopPropagation(); }
      }, true);
    })();

    // VSCode workbench scope (reverse watchdog + dock gate + session-list filter).
    // Extension sends realpath + raw fsPath of every folder in THIS window.
    // Match = equal or UNDER a folder (0.1.44; ancestor workspaces excluded:
    // 子窗口不显示父工作区).
    // Empty list (VS Code opened no folder) = forced no-workbench: clear
    // any current session and keep clearing if the user tries to open one.
    let vscodeScopePaths = [];
    let vscodeScopeRawPaths = [];

    let vscodeScopePullingAt = 0;
    /** First `dshSetScope` from the extension has arrived (empty list is valid). */
    let vscodeScopeReceived = false;
    /** True while a `connectWorkspace` call is in flight (process-wide, not per-path). */
    let connectInFlight = false;
    /** Immediate tick hook set by apply(); null until plugin mounts. */
    let scopeWatchdogTick = null;
    /** Throttle key for noisy diag actions (no-currentWs). */
    let scopeDiagSpamAt = 0;
    /** Dock / UI hooks notified when whitelist changes (module-level setScope). */
    const scopeChangeListeners = [];

    function normalizeScopePath(p) {
      return String(p || "").replace(/\/+$/, "");
    }

    /**
     * Workbench membership. 0.1.44 rule (user: "父可以显示子; 子不能显示父"):
     * a session workspace belongs to this window only when it EQUALS one of
     * the window folders or sits UNDER one (descendant). Ancestor workspaces
     * do NOT count — a VS Code window opened on a subfolder must not show
     * the parent dsh workspace's sessions/dock (watchdog then forces the
     * empty home screen). Boundary-aware: "/repo2" is NOT under "/repo".
     * Affects dock gate + scope watchdog + session-list filter.
     */
    function scopePathAllowed(path) {
      const want = normalizeScopePath(path);
      if (!want) return false;
      const hit = function (p) {
        const s = normalizeScopePath(p);
        if (!s) return false;
        return s === want || want.startsWith(s + "/");
      };
      for (const p of vscodeScopePaths) if (hit(p)) return true;
      for (const p of vscodeScopeRawPaths) if (hit(p)) return true;
      return false;
    }

    function scopeIsActive() {
      return vscodeScopePaths.length > 0 || vscodeScopeRawPaths.length > 0;
    }

    /**
     * Dock / session gate (STRICT):
     *   current dsh session workbench ∈ VS Code window folders
     * Empty session cwd → no match (do not show dock).
     */
    function workbenchMatches(sessionWorkbench) {
      if (!scopeIsActive()) return false;
      const wb = normalizeScopePath(sessionWorkbench || "");
      if (!wb) return false;
      return scopePathAllowed(wb);
    }

    function setVscodeScope(paths, rawPaths) {
      const nextPaths = Array.isArray(paths) ? paths.filter((p) => typeof p === "string" && p) : [];
      const nextRaw = Array.isArray(rawPaths) ? rawPaths.filter((p) => typeof p === "string" && p) : [];
      const first = !vscodeScopeReceived;
      const same = nextPaths.length === vscodeScopePaths.length
        && nextRaw.length === vscodeScopeRawPaths.length
        && nextPaths.every(function (p, i) { return p === vscodeScopePaths[i]; })
        && nextRaw.every(function (p, i) { return p === vscodeScopeRawPaths[i]; });
      vscodeScopeReceived = true;
      if (!first && same) return;
      vscodeScopePaths = nextPaths;
      vscodeScopeRawPaths = nextRaw;
      // Allow an immediate pullback on the next tick (do not wait out old throttle).
      vscodeScopePullingAt = 0;
      if (typeof scopeWatchdogTick === "function") {
        try { scopeWatchdogTick(); } catch (err) { /* noop */ }
      }
      for (let i = 0; i < scopeChangeListeners.length; i++) {
        try { scopeChangeListeners[i](); } catch (err) { /* noop */ }
      }
    }

    function postScopeMessage(type, extra) {
      try {
        const msg = Object.assign({ type: type }, extra || {});
        window.parent.postMessage(msg, "*");
      } catch (err) { /* noop */ }
    }

    /**
     * Scope diagnosis → VS Code Output + console.
     * @param {{ action: string, current?: string, bound?: string, dshItems?: string[] }} info
     */
    function postScopeDiag(info) {
      const payload = Object.assign({
        scopeCount: vscodeScopePaths.length,
        rawCount: vscodeScopeRawPaths.length,
        scopePaths: vscodeScopePaths.slice(),
        rawPaths: vscodeScopeRawPaths.slice(),
      }, info || {});
      postScopeMessage("dshScopeDiag", payload);
    }

    // VS Code iframe chrome:
    // 1) conversation header is always shown (no toggle button).
    // 2) dock the rail left or right (the one remaining button).
    // 3) rail auto-hide on edge hover drives dsh-rail-hidden (kept as-is).
    const IFRAME_SIDEBAR_STYLE_ID = "dsh-review-iframe-sidebar";
    const IFRAME_RAIL_SIDE_BTN_ID = "dsh-review-rail-side";
    const IFRAME_RAIL_EXPAND_BTN_ID = "dsh-review-rail-expand";
    const IFRAME_RAIL_SIDE_KEY = "dsh-review-rail-side";
    const IFRAME_RAIL_HIDDEN_KEY = "dsh-review-rail-hidden";
    const IFRAME_ZOOM_KEY = "dsh-review-zoom";
    let iframeChromeLive = null;

    /**
     * @description Clamp iframe zoom to 0.5–2.0 in 0.1 steps.
     * @param {unknown} n
     * @returns {number}
     */
    function clampIframeZoom(n) {
      const x = Number(n);
      if (!Number.isFinite(x)) return 1;
      return Math.min(2, Math.max(0.5, Math.round(x * 10) / 10));
    }

    /**
     * @description Read last chrome from URL (stamped by the extension) then localStorage.
     * @returns {{ railSide: "left" | "right", railHidden: boolean, zoom: number }}
     */
    function readIframeChrome() {
      // Seed the rail dock side from plugin settings (设置 → 代码审查 → 侧栏位置).
      let railSide = getReviewSettings().sidebarSide;
      let railHidden = false;
      let zoom = 1;
      let sideFromUrl = false;
      let hiddenFromUrl = false;
      let zoomFromUrl = false;
      try {
        const q = new URLSearchParams(String(location.search || ""));
        const qSide = q.get("_dshRail");
        const qHidden = q.get("_dshHidden");
        const qZoom = q.get("_dshZoom");
        if (qSide === "right" || qSide === "left") { railSide = qSide; sideFromUrl = true; }
        if (qHidden === "1" || qHidden === "0") { railHidden = qHidden === "1"; hiddenFromUrl = true; }
        if (qZoom !== null && qZoom !== "") { zoom = clampIframeZoom(qZoom); zoomFromUrl = true; }
      } catch (err) { /* noop */ }
      if (!sideFromUrl) {
        try {
          if (localStorage.getItem(IFRAME_RAIL_SIDE_KEY) === "right") railSide = "right";
        } catch (err) { /* noop */ }
      }
      if (!hiddenFromUrl) {
        try { railHidden = localStorage.getItem(IFRAME_RAIL_HIDDEN_KEY) === "1"; } catch (err) { /* noop */ }
      }
      if (!zoomFromUrl) {
        try {
          const storedZoom = localStorage.getItem(IFRAME_ZOOM_KEY);
          if (storedZoom !== null && storedZoom !== "") zoom = clampIframeZoom(storedZoom);
        } catch (err) { /* noop */ }
      }
      return { railSide: railSide, railHidden: railHidden, zoom: zoom };
    }

    function hostScalesFrame() {
      try { return new URLSearchParams(String(location.search || "")).get("_dshFrameZoom") === "1"; } catch (err) { return false; }
    }

    /**
     * @returns {{ railSide: "left" | "right", railHidden: boolean, zoom: number }}
     */
    function currentIframeChrome() {
      if (iframeChromeLive) return iframeChromeLive;
      iframeChromeLive = readIframeChrome();
      return iframeChromeLive;
    }

    /**
     * @description Remember rail/zoom in iframe localStorage and VS Code globalState.
     * @param {{ railSide?: "left" | "right", railHidden?: boolean, zoom?: number }} patch
     */
    function persistIframeChrome(patch) {
      if (!inVscodeIframe() && !vscodeIframeHint()) return;
      const next = Object.assign({}, currentIframeChrome(), patch || {});
      next.railSide = next.railSide === "right" ? "right" : "left";
      next.railHidden = !!next.railHidden;
      next.zoom = clampIframeZoom(next.zoom);
      iframeChromeLive = next;
      try { localStorage.setItem(IFRAME_RAIL_SIDE_KEY, next.railSide); } catch (err) { /* noop */ }
      try { localStorage.setItem(IFRAME_RAIL_HIDDEN_KEY, next.railHidden ? "1" : "0"); } catch (err) { /* noop */ }
      try { localStorage.setItem(IFRAME_ZOOM_KEY, String(next.zoom)); } catch (err) { /* noop */ }
      try {
        window.parent.postMessage({
          type: "dshChromeState",
          railSide: next.railSide,
          railHidden: next.railHidden,
          zoom: next.zoom,
        }, "*");
      } catch (err) { /* noop */ }
    }

    /**
     * True when this page is the VS Code webview iframe (URL stamped by dsh-browser).
     * @returns {boolean}
     */
    function vscodeIframeHint() {
      try {
        if (window.parent === window) return false;
      } catch (err) {
        return true;
      }
      try {
        if (sessionStorage.getItem("dsh-review-vscode-iframe") === "1") return true;
        if (/(?:\?|&)_dshVscode=/.test(String(location.search || ""))) {
          sessionStorage.setItem("dsh-review-vscode-iframe", "1");
          return true;
        }
      } catch (err) {
        return false;
      }
      return false;
    }

    /**
     * VS Code sidebar iframe only. Standalone browser tabs stay false so
     * watchdog / chrome / StatsLine hide never touch them.
     * @returns {boolean}
     */
    function inVscodeIframe() {
      if (bridgeActive) return true;
      if (vscodeIframeHint()) return true;
      try {
        return typeof document !== "undefined" && document.documentElement.classList.contains("dsh-vscode-iframe");
      } catch (err) {
        return false;
      }
    }

    /**
     * Dock the collapsed dsh rail on the left or right edge.
     * @param {"left" | "right"} side
     */
    function setIframeRailSide(side) {
      const right = side === "right";
      try { document.documentElement.classList.toggle("dsh-rail-right", right); } catch (err) { /* noop */ }
      persistIframeChrome({ railSide: right ? "right" : "left" });
      const btn = document.getElementById(IFRAME_RAIL_SIDE_BTN_ID);
      if (!btn) return;
      const label = right ? "侧栏改贴左侧" : "侧栏改贴右侧";
      btn.setAttribute("aria-label", label);
      btn.title = label;
      btn.classList.toggle("is-right", right);
    }

    /**
     * @description Apply the settings sidebar position immediately. Our save
     * channel is the plugin's own HTTP route (the rc.2 settings plane has no
     * provider, so no settings/document-updated event fires); the settings
     * card calls this right after a successful save, and the settings-card
     * effect calls it after every scope reload. First iframe load seeds it
     * via readIframeChrome.
     */
    function applyRailSideFromSettings() {
      try {
        if (!(bridgeActive || vscodeIframeHint())) return;
        const side = getReviewSettings().sidebarSide;
        if (iframeChromeLive && iframeChromeLive.railSide !== side) setIframeRailSide(side);
        applySidebarMode();
      } catch (err) { /* noop */ }
    }

    /**
     * Hide or show the native 56px icon rail. Uses our CSS, not dsh attributes
     * (React immediately restores data-sidebar-collapsed).
     * @param {boolean} hidden
     */
    // 0.2.0: zero ONLY the first grid track (sidebar) when hiding, preserving
    // the third track (rightbar/workspace panel). We watch the frame's inline
    // style and rewrite only track 1, surviving dsh React re-renders.
    //
    // Race-condition safe: we only WRITE when hidden (zero track 1). When
    // visible, we never restore from a saved value — dsh owns the cols. This
    // avoids stale restores that blank the sidebar when the workspace panel
    // opens and dsh re-renders with new cols.
    let railColsObserver = null;
    let railOriginalCols = null;
    function applyRailHiddenCols() {
      try {
        const hidden = document.documentElement.classList.contains("dsh-rail-hidden");
        const frame = document.querySelector('[data-slot="root"] > *');
        if (!frame) return;
        const cols = frame.style.gridTemplateColumns;
        if (!cols) return;
        const parts = cols.split(/\s+/);
        if (parts.length < 3) return;
        if (hidden) {
          if (parts[0] !== "0px") {
            railOriginalCols = cols;
            parts[0] = "0px";
            frame.style.gridTemplateColumns = parts.join(" ");
          }
        } else if (railOriginalCols && cols !== railOriginalCols) {
          // Restore once when un-hiding, then clear so dsh owns cols again.
          frame.style.gridTemplateColumns = railOriginalCols;
          railOriginalCols = null;
        }
      } catch (err) { /* noop */ }
    }
    function installRailColsObserver() {
      if (railColsObserver) return;
      const frame = document.querySelector('[data-slot="root"] > *');
      if (!frame) return;
      railColsObserver = new MutationObserver(applyRailHiddenCols);
      railColsObserver.observe(frame, { attributes: true, attributeFilter: ["style"] });
      applyRailHiddenCols();
    }

    function setIframeRailHidden(hidden) {
      try { document.documentElement.classList.toggle("dsh-rail-hidden", !!hidden); } catch (err) { /* noop */ }
      installRailColsObserver();
      applyRailHiddenCols();
      persistIframeChrome({ railHidden: !!hidden });
      const btn = document.getElementById(IFRAME_RAIL_EXPAND_BTN_ID);
      if (!btn) return;
      const label = hidden ? "显示侧栏" : "隐藏侧栏";
      btn.setAttribute("aria-expanded", hidden ? "false" : "true");
      btn.setAttribute("aria-label", label);
      btn.title = label;
      btn.classList.toggle("is-open", !hidden);
    }

    // Floating session panel (设置 → 代码审查 → 悬浮会话按钮). On: the rail
    // track stays zeroed and dsh's own expanded sidebar is re-positioned as a
    // fixed card next to an always-visible corner button (works on every
    // page, so Plugins / settings always have a way back). Off: the rail is
    // always shown.
    const FLOAT_TOGGLE_ID = "dsh-review-float-toggle";
    const FLOAT_OPEN_KEY = "dsh-review-float-open";
    const FLOAT_TOGGLE_SVG = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" aria-hidden="true">'
      + '<rect x="2" y="2.5" width="12" height="11" rx="2"/><path d="M5 6h6M5 8.5h6M5 11h3.5"/></svg>';

    // Set by the scope watchdog (it owns the workspace/session lists).
    let jumpToLatestSession = null;

    function sidebarFloatMode() {
      return getReviewSettings().sidebarFloat;
    }

    function floatPanelStoredOpen() {
      try { return localStorage.getItem(FLOAT_OPEN_KEY) === "1"; } catch (err) { return false; }
    }

    function setFloatPanelOpen(open) {
      try { localStorage.setItem(FLOAT_OPEN_KEY, open ? "1" : "0"); } catch (err) { /* noop */ }
      try { document.documentElement.classList.toggle("dsh-float-open", !!open); } catch (err) { /* noop */ }
      const btn = document.getElementById(FLOAT_TOGGLE_ID);
      if (btn) {
        const label = open ? "收起会话列表" : "展开会话列表";
        btn.classList.toggle("is-open", !!open);
        btn.setAttribute("aria-expanded", open ? "true" : "false");
        btn.setAttribute("aria-label", label);
        btn.title = label;
      }
      // A collapsed (icon-rail) sidebar would float as a 56px strip.
      if (open) expandCollapsedSidebar();
    }

    function expandCollapsedSidebar() {
      const root = document.querySelector('[data-slot="root"]');
      if (!root) return;
      const host = root.querySelector(':scope > * > :first-child [data-slot="sidebar"] > :first-child');
      const t = root.querySelector('[aria-keyshortcuts="Alt+Meta+B"]');
      if (!t) return;
      const collapsed = (host && /_collapsed\b/.test(String(host.className || ""))) ||
        /expand|open/i.test(String(t.getAttribute("aria-label") || ""));
      if (collapsed) {
        try { t.click(); } catch (err) { /* noop */ }
      }
    }

    function applySidebarMode() {
      if (typeof document === "undefined") return;
      if (!bridgeActive && !vscodeIframeHint()) return;
      const float = sidebarFloatMode();
      const html = document.documentElement;
      html.classList.toggle("dsh-rail-float", float);
      setIframeRailHidden(float);
      let btn = document.getElementById(FLOAT_TOGGLE_ID);
      if (!float) {
        if (btn && btn.parentNode) btn.parentNode.removeChild(btn);
        html.classList.remove("dsh-float-open");
        return;
      }
      if (!btn) {
        btn = document.createElement("button");
        btn.id = FLOAT_TOGGLE_ID;
        btn.type = "button";
        btn.innerHTML = FLOAT_TOGGLE_SVG;
        btn.addEventListener("click", function (event) {
          event.preventDefault();
          event.stopPropagation();
          setFloatPanelOpen(!html.classList.contains("dsh-float-open"));
          // Second click of a double-click: the toggle above undid the first
          // click's toggle, so the panel keeps its state; then jump.
          if (event.detail === 2 && typeof jumpToLatestSession === "function") jumpToLatestSession();
        });
        try { document.body.appendChild(btn); } catch (err) { /* noop */ }
      }
      installFloatOutsideClose();
      expandCollapsedSidebar();
      setFloatPanelOpen(floatPanelStoredOpen());
    }

    let floatOutsideCloseInstalled = false;
    // Menus / dialogs opened from the panel are portaled outside
    // [data-slot="root"]; only presses inside root but outside the panel close.
    function installFloatOutsideClose() {
      if (floatOutsideCloseInstalled) return;
      floatOutsideCloseInstalled = true;
      document.addEventListener("pointerdown", function (event) {
        const html = document.documentElement;
        if (!html.classList.contains("dsh-rail-float") || !html.classList.contains("dsh-float-open")) return;
        const target = event.target;
        if (!target || typeof target.closest !== "function") return;
        if (target.closest("#" + FLOAT_TOGGLE_ID)) return;
        const root = target.closest('[data-slot="root"]');
        if (!root) return;
        const panel = root.querySelector(':scope > * > :first-child [data-slot="sidebar"] > :first-child');
        if (panel && panel.contains(target)) return;
        setFloatPanelOpen(false);
      }, true);
    }

    /**
     * Inject header/side/expand toggles. No-op outside the iframe.
     */
    function installIframeSidebarPeek() {
      if (typeof document === "undefined") return;
      if (!bridgeActive && !vscodeIframeHint()) return;
      try { document.documentElement.classList.add("dsh-vscode-iframe"); } catch (err) { /* noop */ }
      const css = [
        // Make chat content nearly fill the VS Code sidebar — keep a small
        // breathing margin (8px) instead of the default 16px+8px+max-width.
        "html.dsh-vscode-iframe .wSkVaW_body, html.dsh-vscode-iframe .wSkVaW_embeddedBody {",
        "  --dsh-chat-content-width: 100%;",
        "  --dsh-composer-card-max-width: 100%;",
        "  --dsh-composer-side-clearance: 8px;",
        "  --dsh-composer-dock-inset: 0px;",
        "}",
        // Hero (empty state) root has padding: 0 24px — reduce to 8px.
        "html.dsh-vscode-iframe .pXSMma_root {",
        "  padding: 0 8px !important;",
        "}",
        // Composer dock root padding uses side-clearance var (now 8px).
        "html.dsh-vscode-iframe .uV2eYG_root {",
        "  padding: 0 8px 4px !important;",
        "}",
        // The host's own header stays untouched: title row plus the view tabs on
        // their own row. Both one-line attempts (a hover overlay over the title
        // row, then an in-flow third grid track) cost more than the height they
        // saved — the overlay ate clicks on the header actions, and a narrow
        // third track made the host fold the tabs into its overflow menu.
        // 0.2.0: sidebar track zeroing is done in JS (applyRailHiddenCols)
        // to preserve the rightbar/workspace track. No CSS grid override here.
        // Right dock: RTL flips the first (sidebar) track to the right edge.
        // dsh drops data-sidebar-collapsed once the sidebar expands, so the
        // frame is also hooked through its stable root slot — otherwise the
        // expanded panel snaps back to the left.
        "html.dsh-vscode-iframe.dsh-rail-right [data-sidebar-collapsed], html.dsh-vscode-iframe.dsh-rail-right [data-details-collapsed], html.dsh-vscode-iframe.dsh-rail-right [data-slot=\"root\"] > * {",
        "  direction: rtl;",
        "}",
        "html.dsh-vscode-iframe.dsh-rail-right [data-sidebar-collapsed] > *, html.dsh-vscode-iframe.dsh-rail-right [data-details-collapsed] > *, html.dsh-vscode-iframe.dsh-rail-right [data-slot=\"root\"] > * > * {",
        "  direction: ltr;",
        "}",
      ].concat(floatPanelCss()).join("\n");
      let tag = document.getElementById(IFRAME_SIDEBAR_STYLE_ID);
      if (!tag) {
        tag = document.createElement("style");
        tag.id = IFRAME_SIDEBAR_STYLE_ID;
        try { document.head.appendChild(tag); } catch (err) { /* noop */ }
      }
      tag.textContent = css;
      ["dsh-my-plugin-rail-hit", "dsh-review-header-toggle", "dsh-review-rail-expand", IFRAME_RAIL_SIDE_BTN_ID].forEach(function (oldId) {
        const oldEl = document.getElementById(oldId);
        if (oldEl && oldEl.parentNode) oldEl.parentNode.removeChild(oldEl);
      });
      const chrome = currentIframeChrome();
      setIframeRailSide(chrome.railSide);
      applySidebarMode();
      compactNativeStatsLine();
    }

    // z-index 90/95: above conversation layers (≤70), below every dsh menu,
    // popover and toast (100+) so menus opened from the panel stay on top.
    function floatPanelCss() {
      const sr = 'html.dsh-rail-float.dsh-float-open [data-slot="root"] > * > :first-child [data-slot="sidebar"] > :first-child';
      return [
        sr + " {",
        "  position: fixed !important; top: 42px !important; right: 38px !important; left: auto !important; bottom: auto !important;",
        "  width: 280px !important; height: auto !important; max-height: min(78vh, calc(100vh - 54px)) !important;",
        "  z-index: 90 !important; direction: ltr !important; overflow: hidden !important; border-radius: 12px !important;",
        "  background: var(--dsh-color-surface-elevated, var(--dsh-color-surface, #1f1f1e)) !important;",
        "  border: 1px solid var(--dsh-color-border, rgba(255,255,255,0.10)) !important;",
        "  box-shadow: 0 16px 40px rgba(0,0,0,0.45), 0 2px 8px rgba(0,0,0,0.30) !important;",
        "  transform-origin: top right; animation: dshr-float-in 0.14s cubic-bezier(0.2, 0.8, 0.2, 1);",
        "}",
        // Fit-content height: every flex level down to the list may shrink,
        // so the footer sits right under the list and only the list scrolls.
        sr + ' [class*="_regionArea"] { display: flex !important; flex-direction: column !important; }',
        sr + ' [class*="_regionArea"], ' + sr + ' [class*="_regionArea"] > * > *, ' + sr + ' [class*="_listArea"] { flex: 0 1 auto !important; min-height: 0 !important; }',
        sr + ' [class*="_listArea"] > * { flex: 0 1 auto !important; min-height: 0 !important; display: flex !important; flex-direction: column !important; }',
        sr + ' [data-dsh-claude-part="list"], ' + sr + ' [class*="_listArea"] > * > [class*="_list"] { flex: 0 1 auto !important; min-height: 0 !important; overflow-y: auto !important; overscroll-behavior: contain; }',
        sr + ' [aria-keyshortcuts="Alt+Meta+B"] { display: none !important; }',
        "@keyframes dshr-float-in { from { opacity: 0; transform: translateY(-4px) scale(0.98); } to { opacity: 1; transform: none; } }",
        "#" + FLOAT_TOGGLE_ID + " {",
        "  position: fixed; top: 42px; right: 6px; z-index: 95; width: 26px; height: 26px; padding: 0; margin: 0;",
        "  display: grid; place-items: center; border-radius: 8px; cursor: pointer;",
        "  border: 1px solid var(--dsh-color-border, rgba(255,255,255,0.12));",
        "  color: var(--dsh-color-text-secondary, rgba(255,255,255,0.72));",
        "  background: var(--dsh-color-surface-elevated, rgba(40,40,38,0.92));",
        "  box-shadow: 0 4px 12px rgba(0,0,0,0.35);",
        "  transition: background 0.12s ease, color 0.12s ease, border-color 0.12s ease;",
        "}",
        "#" + FLOAT_TOGGLE_ID + ":hover { color: var(--dsh-color-text, #fff); background: var(--dsh-color-surface-hover, rgba(60,60,58,0.95)); }",
        "#" + FLOAT_TOGGLE_ID + ".is-open { color: var(--dsh-color-accent, #d97757); border-color: color-mix(in srgb, var(--dsh-color-accent, #d97757) 45%, transparent); }",
        "#" + FLOAT_TOGGLE_ID + " svg { width: 15px; height: 15px; display: block; }",
      ];
    }

    const STATS_COMPACT_STYLE_ID = "dsh-review-compact-statsline";

    /**
     * Resolve native StatsLine hashed class names from its injected stylesheet.
     * @returns {{ root: string, sep: string }}
     */
    function statsLineSelectors() {
      let root = ".FJxK0a_root";
      let sep = ".FJxK0a_sep";
      try {
        const tag = document.querySelector('style[data-plugin-css="@deepseek-ai/dsh-client-ui-conversation/StatsLine.module.css"]');
        const css = (tag && tag.textContent) || "";
        const mRoot = css.match(/\.([A-Za-z0-9_-]+_root)\{/);
        const mSep = css.match(/\.([A-Za-z0-9_-]+_sep)\{/);
        if (mRoot) root = "." + mRoot[1];
        if (mSep) sep = "." + mSep[1];
      } catch (err) { /* fallback hash */ }
      return { root: root, sep: sep };
    }

    /**
     * Keep native StatsLine visible in the VS Code iframe, with tighter height
     * and margins. Standalone browser tabs are not styled.
     */
    function compactNativeStatsLine() {
      if (typeof document === "undefined") return;
      if (!inVscodeIframe()) return;
      try { document.documentElement.classList.remove("dsh-hide-native-stats"); } catch (err) { /* noop */ }
      const sel = statsLineSelectors();
      let style = document.getElementById(STATS_COMPACT_STYLE_ID);
      if (!style) {
        style = document.createElement("style");
        style.id = STATS_COMPACT_STYLE_ID;
        try { document.head.appendChild(style); } catch (err) { /* noop */ }
      }
      style.textContent = [
        "html.dsh-vscode-iframe " + sel.root + "{",
        "  padding:0 calc(var(--dsh-composer-side-clearance, 0px) + 8px) !important;",
        "  margin:0 auto !important;",
        "  font-size:11px !important;",
        "  line-height:14px !important;",
        "}",
        "html.dsh-vscode-iframe " + sel.sep + "{",
        "  margin:0 4px !important;",
        "}",
      ].join("");
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

    /**
     * @returns {boolean} true once the live 设置 snapshot has landed.
     * @description dsh settings-scope lifecycle is 'loading' → 'ready'/'unavailable'
     * (value stays undefined until the first accepted read; dsh-web-ui gates the
     * same way). Watchdog ticks fire BEFORE the settings fetch settles, so
     * anything acting on user opt-outs must gate on this, never on defaults.
     */
    function reviewSettingsReady() {
      if (!reviewSettingsScope || typeof reviewSettingsScope.getSnapshot !== "function") return false;
      try {
        const s = reviewSettingsScope.getSnapshot();
        return !!(s && s.status === "ready");
      } catch (e) { return false; }
    }

    /**
     * @returns {{ enabled: boolean, fileSend: string, snippetSend: string, sidebarSide: string, sidebarFloat: boolean, jobsTerminal: boolean, scopeFilter: boolean, autoWorkspace: boolean, openFilesInVscode: boolean, claudeAdapt: boolean, annotationToDsh: boolean }}
     * @description Live 设置 → 代码审查 values; defaults if the scope is not ready.
     */
    function getReviewSettings() {
      // Default to pointer: matches the user's persisted yaml choice; fence
      // is only used when the live scope explicitly says fence.
      const d = { enabled: true, fileSend: "path", snippetSend: "pointer", sidebarSide: "left", sidebarFloat: true, jobsTerminal: false, scopeFilter: true, autoWorkspace: true, openFilesInVscode: true, claudeAdapt: true, annotationToDsh: true, annoHeapBridge: true };
      if (!reviewSettingsScope || typeof reviewSettingsScope.getSnapshot !== "function") return d;
      const snap = reviewSettingsScope.getSnapshot();
      const val = snap && snap.value;
      // Namespace absent from the client describe mirror (late host
      // registration): fall back to the defaults above instead of coercing
      // an undefined section into fence.
      if (!val || typeof val !== "object") return d;
      const v = val;
      return {
        enabled: v.enabled !== false,
        fileSend: v.fileSend === "prefixed" ? "prefixed" : "path",
        snippetSend: v.snippetSend === "pointer" ? "pointer" : "fence",
        sidebarSide: v.sidebarSide === "right" ? "right" : "left",
        sidebarFloat: v.sidebarFloat !== false,
        jobsTerminal: v.jobsTerminal === true,
        scopeFilter: v.scopeFilter !== false,
        autoWorkspace: v.autoWorkspace !== false,
        openFilesInVscode: v.openFilesInVscode !== false,
        claudeAdapt: v.claudeAdapt !== false,
        annotationToDsh: v.annotationToDsh !== false,
        annoHeapBridge: v.annoHeapBridge !== false,
      };
    }

    /**
     * @param {object} r
     * @returns {string}
     */
    function snippetRangeLabel(r) {
      const a = Number(r && r.startLine);
      const b = Number(r && r.endLine);
      if (!Number.isFinite(a) || a < 1) return "";
      if (!Number.isFinite(b) || b <= a) return "L" + a;
      return "L" + a + "~L" + b;
    }

    /**
     * @param {object} r
     * @returns {string}
     * @description Cell span for notebook selections: "C3" or "C2~C4" (1-based cell index).
     */
    function notebookCellRange(r) {
      if (!r || !r.notebook) return "";
      const a = Number(r.cellStart);
      const b = Number(r.cellEnd);
      if (!Number.isFinite(a) || a < 1) return "";
      if (!Number.isFinite(b) || b <= a) return "C" + a;
      return "C" + a + "~C" + b;
    }

    /**
     * @param {string} content
     * @returns {string}
     * @description Fence with no language tag; body is the insert-time snapshot.
     */
    function fenceSnippet(content) {
      const body = String(content || "").replace(/\n$/, "");
      return "\n```\n" + body + "\n```";
    }

    /**
     * @param {string} p
     * @returns {string}
     * @description Wrap file_path in backticks so dsh does not parse `/` as a skill.
     */
    function quoteFilePath(p) {
      const s = String(p || "");
      if (!s) return s;
      return "`" + s.replace(/`/g, "") + "`";
    }

    /**
     * @param {object} r
     * @returns {object}
     * @description Chip label stays short; modelText is what the model receives.
     */
    function formatRefForSend(r) {
      const src = r && typeof r === "object" ? r : {};
      const s = getReviewSettings();
      const filePath = String(src.path || "");
      const quoted = quoteFilePath(filePath);
      const kind = src.kind;
      if (kind === "terminal") {
        const content = typeof src.content === "string" ? src.content : "";
        const fenced = fenceSnippet(content);
        const label = src.label || "Terminal";
        return Object.assign({}, src, {
          label: label,
          clipboardText: fenced,
          modelText: fenced,
        });
      }
      if (kind === "selection") {
        // Notebook selections prepend the cell span: "C3 L1~L5" / "C2~C4".
        const range = (function () {
          const cellPart = notebookCellRange(src);
          const linePart = snippetRangeLabel(src);
          return cellPart ? (linePart ? cellPart + " " + linePart : cellPart) : linePart;
        })();
        const plainPointer = filePath + (range ? " " + range : "");
        // User-confirmed format: the WHOLE pointer backticked as one unit.
        const allQuoted = "`" + filePath.replace(/`/g, "") + (range ? " " + range : "") + "`";
        const label = plainPointer;
        const content = typeof src.content === "string" ? src.content : "";
        // Explicit mode from the VS Code extension wins; plugin settings
        // decide only for flows without one (drag-drop).
        const mode = src.sendMode === "fence" || src.sendMode === "pointer"
          ? src.sendMode
          : s.snippetSend;
        if (mode === "fence" && content) {
          return Object.assign({}, src, {
            label: label,
            clipboardText: allQuoted,
            modelText: fenceSnippet(content),
          });
        }
        return Object.assign({}, src, {
          label: label,
          clipboardText: allQuoted,
          modelText: allQuoted,
          textFallback: allQuoted,
        });
      }
      if (kind === "element") {
        // Browser element annotation (Comment on Elements → dsh): chip = the
        // element (label, e.g. "div#count"), text = the comment (modelText /
        // clipboardText set by the extension as "@<name> <text>"). Preserve them
        // verbatim — there is NO file path, so the file/folder branch would
        // clobber modelText to an empty string and the chip would vanish on send.
        const label = String(src.label || "element");
        const modelText = typeof src.modelText === "string" ? src.modelText : label;
        const clipboardText = typeof src.clipboardText === "string" ? src.clipboardText : modelText;
        return Object.assign({}, src, {
          label: label,
          clipboardText: clipboardText,
          modelText: modelText,
          textFallback: modelText,
        });
      }
      const prefix = kind === "folder" ? "目录: " : "文件: ";
      const modelText = s.fileSend === "prefixed" ? prefix + quoted : quoted;
      return Object.assign({}, src, {
        clipboardText: quoted,
        modelText: modelText,
      });
    }

    /**
     * @param {string} path
     * @returns {string}
     * @description dsh 0.1.6 native file mention: @/path, quoted when it has spaces.
     */
    function fileMention(path) {
      const p = String(path || "");
      return p.indexOf(" ") >= 0 ? '@"' + p + '"' : "@" + p;
    }

    function mintRefs(refs) {
      return refs.map(function (r) {
        // File/folder chips ride dsh's native "reference" source: native icon,
        // openable in the right sidebar, native serialize/persistence.
        if (r.kind === "file" || r.kind === "folder") {
          const mention = fileMention(r.path);
          const label = String(r.label || String(r.path || "").split("/").pop() || r.path);
          return {
            source: "reference",
            ref: mention,
            label: r.kind === "folder" && !/\/$/.test(label) ? label + "/" : label,
            appearance: r.kind === "folder" ? "folder" : "file",
            clipboardText: mention,
          };
        }
        refSeq += 1;
        const id = "vs" + refSeq;
        const modelText = typeof r.modelText === "string" ? r.modelText
          : (typeof r.path === "string" ? quoteFilePath(r.path) : String(r.label || ""));
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

    // Native chips share one dsh CSS class; color them per kind by minting a
    // rule keyed on the occurrenceId that dsh assigns after pasteBegin.
    const CHIP_COLORS = {
      file: "rgba(74,158,255,0.26)",      // blue
      folder: "rgba(240,161,50,0.26)",    // amber
      selection: "rgba(167,139,250,0.34)", // violet
      terminal: "rgba(20,184,166,0.36)",  // teal — not file/folder/snippet
      element: "rgba(236,72,153,0.30)",   // pink — browser element annotation
    };
    let chipStyleTag = null;

    function injectChipStyles(entries) {
      if (!Array.isArray(entries) || entries.length === 0) return;
      try {
        if (!chipStyleTag || !document.head.contains(chipStyleTag)) {
          chipStyleTag = document.createElement("style");
          chipStyleTag.id = "dsh-review-chip-styles";
          chipStyleTag.dataset.plugin = "dsh-review";
          document.head.appendChild(chipStyleTag);
        }
        // Native layout ONLY: never resize the placeholder shell. Changing its
        // width breaks dsh's mirror/backdrop alignment and makes the caret
        // jump. Colors still ride the chip element.
        const css = entries
          .filter(function (e) { return e && Number.isFinite(e.id); })
          .map(function (e) {
            const color = CHIP_COLORS[e.kind] || CHIP_COLORS.file;
            // Legacy scan-derived chips carry the occurrence id in the DOM; the
            // current composer renders real chip nodes, tagged by tagChipKinds.
            return '[data-decoration="chip"][data-occurrence="' + e.id + '"]{background:' + color + ' !important;}'
              + '\n[data-composer-chip="' + REF_SOURCE + '"][data-dsh-review-kind="' + (e.kind || "file") + '"] > span{background:' + color + ' !important;}'
              + '\n[data-composer-chip="reference"][data-dsh-review-kind="' + (e.kind || "file") + '"] > span{background:' + color + ' !important;}';
          })
          .join("\n");
        if (css) chipStyleTag.textContent += "\n" + css;
      } catch (err) { /* styling is cosmetic */ }
    }

    /**
     * Tag this plugin's composer chips with their kind. The current composer DOM
     * exposes no occurrence id, but occurrence order and chip host order are both
     * editor order, so the two lists line up.
     * @param {object} shell
     * @param {object[]} references minted refs, in insertion order
     * @param {object[]} list formatted refs carrying `kind`
     */
    function tagChipKinds(shell, references, list) {
      try {
        const kindByRef = {};
        for (let i = 0; i < references.length; i++) {
          kindByRef[references[i].ref] = (list[i] && list[i].kind) || "file";
        }
        const occurrences = (shell && shell.snapshot && shell.snapshot.occurrences) || [];
        const ours = occurrences.filter(function (o) { return o.source === REF_SOURCE || o.source === "reference"; });
        const chips = document.querySelectorAll('[data-composer-chip="' + REF_SOURCE + '"],[data-composer-chip="reference"]');
        for (let i = 0; i < ours.length && i < chips.length; i++) {
          const kind = kindByRef[ours[i].ref];
          if (kind) chips[i].setAttribute("data-dsh-review-kind", kind);
        }
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

    function ReviewChangesDock(props) {
      const [entries, setEntries] = useState([]);
      const [collapsed, setCollapsed] = useState(true);
      const [inVSCodeIframe, setInVSCodeIframe] = useState(false);
      const [scopeVersion, setScopeVersion] = useState(0);
      const [allBusy, setAllBusy] = useState(false);
      // Reset the all-accept/reject busy latch whenever pending changes.
      useEffect(() => { setAllBusy(false); }, [entries]);

      // The dock slot is session-scoped and receives the framework standard
      // kit. Resolve the CURRENT workspace path: prefer the workspace that
      // accounts this session, then fall back to the session summary cwd.
      const sessionId = props && props.sessionId;
      const sessionIdRef = useRef(sessionId);
      sessionIdRef.current = sessionId;
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
      const inputActionsRef = useRef(inputActions);
      inputActionsRef.current = inputActions;
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
        let zoom = clampIframeZoom(currentIframeChrome().zoom);
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
            const oEnd = o.offset + (Number.isFinite(o.length) ? o.length : 1);
            if (oEnd <= start) continue;
            if (o.offset >= end) break;
            out += draftText.slice(cursor, o.offset) + String(o.clipboardText || "");
            cursor = oEnd;
          }
          out += draftText.slice(cursor, end);
          return out;
        }

        function getSelectionText() {
          const el = document.activeElement;
          const expanded = occurrenceExpandedSelection(el);
          if (expanded !== null) return expanded;
          // window.getSelection() does not see a selection inside a form field.
          if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA") && typeof el.value === "string") {
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
          if (isEditable(el)) lastComposer = el;
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

        // Synthetic paste events are dispatched by insertIncomingText; the
        // onPaste bridge listener must not re-route them (paste loop).
        let syntheticPasteDepth = 0;

        /**
         * @param {HTMLElement} el
         * @param {string} text
         * @returns {boolean}
         * @description Replay text through dsh's native PASTE pipeline
         *              (DataTransfer text/plain), which splits lines into
         *              proper line nodes — same as a standalone-browser paste.
         */
        function dispatchSyntheticPaste(el, text) {
          try {
            const dt = new DataTransfer();
            dt.setData("text/plain", String(text === null || text === undefined ? "" : text));
            const evt = new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true });
            syntheticPasteDepth += 1;
            try { el.dispatchEvent(evt); } finally { syntheticPasteDepth -= 1; }
            return true;
          } catch (err) {
            return false;
          }
        }

        function insertIncomingText(text, preferred) {
          if (!isEditable(preferred)) return false;
          if (preferred.tagName !== "TEXTAREA" && preferred.tagName !== "INPUT") {
            // dsh 0.1.6+ Lexical composer: execCommand insertText is ignored
            // and selection.insertText drops newlines (facebook/lexical#5592).
            // Replay a synthetic paste so the native PASTE pipeline handles it.
            const focusTarget = (activeEditable() && document.body.contains(activeEditable())) ? activeEditable() : preferred;
            if (dispatchSyntheticPaste(focusTarget, text)) {
              setTimeout(function () { focusComposer(); }, 0);
              return true;
            }
            if (sessionId && inputHub) {
              try {
                const shell = inputHub.shell(sessionId);
                if (shell && typeof shell.paste === "function") {
                  shell.paste(String(text === null || text === undefined ? "" : text));
                  setTimeout(function () { focusComposer(); }, 0);
                  return true;
                }
              } catch (err) { /* fall through to the DOM path */ }
            }
          }
          return insertAtCaret(preferred, text);
        }

        /**
         * @returns {HTMLTextAreaElement | null}
         * @description Last focused composer, else the largest visible textarea.
         */
        /**
         * @returns {HTMLElement | null}
         * @description Largest visible contenteditable (dsh 0.1.6+ Lexical
         *              composer); same area heuristic as the textarea scan.
         */
        function findComposerEditable() {
          const nodes = document.querySelectorAll('[contenteditable="true"]');
          let best = null;
          let bestArea = 0;
          for (let i = 0; i < nodes.length; i++) {
            const el = nodes[i];
            if (!el) continue;
            const r = el.getBoundingClientRect();
            if (r.width < 40 || r.height < 16) continue;
            const area = r.width * r.height;
            if (area > bestArea) {
              bestArea = area;
              best = el;
            }
          }
          return best;
        }

        function findComposerTextarea() {
          if (lastComposer && document.body.contains(lastComposer)) return lastComposer;
          const nodes = document.querySelectorAll("textarea");
          let best = null;
          let bestArea = 0;
          for (let i = 0; i < nodes.length; i++) {
            const el = nodes[i];
            if (!el || el.disabled || el.readOnly) continue;
            const r = el.getBoundingClientRect();
            if (r.width < 40 || r.height < 16) continue;
            const area = r.width * r.height;
            if (area > bestArea) {
              bestArea = area;
              best = el;
            }
          }
          return best || findComposerEditable();
        }

        function preferredComposer(preferred) {
          if (preferred && preferred.tagName === "TEXTAREA" && document.body.contains(preferred)) return preferred;
          return findComposerTextarea();
        }

        /**
         * @param {number} [caret]
         * @returns {boolean}
         * @description Keyboard must land in the dsh composer after a chip insert.
         */
        /**
         * dsh 0.2 rc: after a chip insert the wanted caret (just past the
         * chip) is remembered for a moment; shell.focus() may answer it with
         * a start-of-draft caret (observed), so force it back by inserting an
         * empty string at the wanted span (the editor lands its caret there).
         */
        let caretWanted = null;
        let caretWantedAt = 0;
        function caretNow(shell) {
          const p = (shell && shell.projection) || {};
          return Number.isFinite(p.caret) ? p.caret : null;
        }
        function ensureCaretAfterChip() {
          if (!(sessionId && inputHub) || !Number.isFinite(caretWanted)) return;
          if (Date.now() - caretWantedAt > 3000) return;
          try {
            const shell = inputHub.shell(sessionId);
            if (!shell) return;
            const now = caretNow(shell);
            if (now === null || Math.abs(now - caretWanted) <= 1) return;
            if (typeof shell.insertText === "function") {
              shell.insertText("", { start: caretWanted, end: caretWanted, draftRev: liveRev(shell) });
            }
          } catch (err) { /* caret fix is best-effort */ }
        }

        function focusComposer(caret) {
          // dsh 0.2 rc: the composer is Lexical. A bare DOM focus on the
          // contenteditable lands the caret at the START (official facade
          // note); shell.focus() restores the settled caret — right after a
          // freshly inserted chip. DOM path remains for textarea composers.
          if (sessionId && inputHub) {
            try {
              const shell = inputHub.shell(sessionId);
              if (shell && typeof shell.focus === "function") {
                shell.focus();
                ensureCaretAfterChip();
                return true;
              }
            } catch (err) { /* fall through to the DOM path */ }
          }
          const el = findComposerTextarea();
          if (!el) return false;
          lastComposer = el;
          try { el.focus(); } catch (err) { /* noop */ }
          if (el.tagName === "TEXTAREA" && Number.isFinite(caret) && caret >= 0) {
            try { el.setSelectionRange(caret, caret); } catch (err) { /* noop */ }
          }
          return true;
        }

        // 0.1.67: the click-interception patch lives in another closure; expose
        // the composer refocus so the insert-guard branch can hand focus back.
        try { window.__dshrFocusComposer = focusComposer; } catch (err) { /* noop */ }
        // (0.2.8) ③ draft bridge for the anno prepare/append protocol.
        try {
          window.__dshrAnnoGetDraft = function () { return String(draftRef.current == null ? "" : draftRef.current); };
          window.__dshrAnnoSetDraftFull = function (text) {
            const a = inputActionsRef.current;
            if (a && typeof a.setDraft === "function") { a.setDraft(String(text == null ? "" : text)); return true; }
            return false;
          };
        } catch (err) { /* noop */ }

        function insertComposerText(text) {
          const value = String(text === null || text === undefined ? "" : text);
          if (!value) return false;
          // Current dsh: splice at the live caret through the input shell. The
          // composer is a contenteditable editor now, so the DOM fallbacks below
          // can only append.
          if (sessionId && inputHub) {
            try {
              const shell = inputHub.shell(sessionId);
              if (shell && typeof shell.insertText === "function" && shell.insertText(value, referenceSpan(shell))) {
                setTimeout(function () { focusComposer(); }, 0);
                return true;
              }
            } catch (err) { /* fall through to the DOM paths */ }
          }
          const target = preferredComposer(null);
          if (target && insertAtCaret(target, value)) {
            focusComposer();
            return true;
          }
          const actions = inputActionsRef.current;
          if (actions) actions.setDraft(draftRef.current + value);
          setTimeout(function () { focusComposer(); }, 0);
          return false;
        }

        // Native chip insertion ---------------------------------------------
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

        /**
         * Live insertion span for the current dsh composer: detect-coordinate
         * caret/selection plus the revision the insertion CASes against.
         * @param {object} shell conversation.input.shell(sessionId)
         * @returns {{ start: number, end: number, draftRev: number }}
         */
        function referenceSpan(shell) {
          const proj = (shell && shell.projection) || {};
          const snap = (shell && shell.snapshot) || {};
          const text = typeof proj.detectText === "string" ? proj.detectText
            : (typeof snap.draft === "string" ? snap.draft : "");
          const sel = proj.selection;
          const fallback = Number.isFinite(proj.caret) ? proj.caret : text.length;
          const start = sel && Number.isFinite(sel.start) ? sel.start : fallback;
          const end = sel && Number.isFinite(sel.end) ? sel.end : fallback;
          return { start: start, end: end, draftRev: liveRev(shell) };
        }

        /**
         * Newest draft revision. The shell increments it inside the editor commit,
         * while the published snapshot may still carry the previous one.
         * @param {object} shell
         * @returns {number}
         */
        function liveRev(shell) {
          if (shell && Number.isFinite(shell.rev)) return shell.rev;
          return (shell && shell.snapshot && shell.snapshot.draftRev) || 0;
        }

        /**
         * Detect-coordinate insertion point for the chip after the one just added:
         * the live caret when the editor advanced it, else the end of the draft.
         * @param {object} shell
         * @param {number} previous start offset of the insertion just applied
         * @returns {{ start: number, end: number, draftRev: number }}
         */
        function spanAfterInsert(shell, previous) {
          const proj = (shell && shell.projection) || {};
          const detect = typeof proj.detectText === "string" ? proj.detectText : "";
          const caret = Number.isFinite(proj.caret) ? proj.caret : detect.length;
          const at = caret > previous ? caret : detect.length;
          return { start: at, end: at, draftRev: liveRev(shell) };
        }

        /**
         * Occurrence of one of our refs in the live composer projection.
         * @param {object} shell
         * @param {string} ref
         * @returns {object|null}
         */
        function findRefOccurrence(shell, ref) {
          const occurrences = (shell && shell.snapshot && shell.snapshot.occurrences) || [];
          for (let i = 0; i < occurrences.length; i++) {
            if ((occurrences[i].source === REF_SOURCE || occurrences[i].source === "reference") && occurrences[i].ref === ref) return occurrences[i];
          }
          return null;
        }

        // 0.1.68 diagnostic: dsh 0.2.1 added a plain-text reference entity
        // transform (TextRefNode, "editing continues inside"), which makes our
        // detect-space caret arithmetic suspect. One log line per insert records
        // which coordinate space the live caret actually reports.
        function caretDiag(tag, shell) {
          try {
            const p = (shell && shell.projection) || {};
            const sn = (shell && shell.snapshot) || {};
            const occ = (sn.occurrences || []).map(function (o) {
              return o.offset + "+" + o.length + ":" + o.source;
            }).join(",");
            postScopeMessage("dshPasteLog", {
              line: "[caret] " + tag + " caret=" + p.caret + " detectLen=" + String(p.detectText || "").length +
                " draftLen=" + String(sn.draft || "").length + " rev=" + liveRev(shell) +
                " caretWanted=" + caretWanted + " occ=[" + occ + "]",
            });
          } catch (err) { /* diagnostics only */ }
        }

        // Try the dsh native occurrence chip path; fall back to plain text.
        // 0.1.57: two-way binding with VS Code's native element comments. We cannot hook
        // dsh's own chip-removal handler, so we remember which chips we inserted (by their
        // unique file name) and watch the composer: when a name stops being rendered while
        // the composer still holds text, the user deleted that chip -> tell the extension,
        // which deletes the matching "@<element> <text>" line in the Copilot composer, and
        // VS Code drops the page pin on its own (verified by the user's test).
        const trackedRefs = new Map(); // file name -> { path }
        let refSweepAt = 0;
        let lastDiagAt = 0;
        let sweepReported = false;
        let announceSent = false;
        // A chip matches when its text carries either the file-name tail or the annotation
        // label we gave it (dsh truncates long labels in the middle, both survive).
        function textHas(el, info) {
          const txt = String((el && el.textContent) || '');
          const t = info && info.tail, a2 = info && info.alt;
          if (t && txt.indexOf(t) !== -1) return true;
          if (a2 && txt.indexOf(a2) !== -1) return true;
          return false;
        }
        function composerScope() {
          // The composer markup is dsh's own and is not guaranteed to be contenteditable,
          // and returning null here used to switch the whole binding off silently. The md
          // file names we track are unique (timestamp + random), so falling back to the
          // document body is safe and keeps the binding alive whatever the markup is.
          const editor = document.querySelector('[contenteditable="true"], textarea');
          if (editor) {
            let node = editor;
            for (let i = 0; i < 3 && node.parentElement; i++) node = node.parentElement;
            return node
          }
          return document.body || document.documentElement;
        }
        function postState(extra) {
          // 0.1.82: only the scope-request message has ever reached the extension, so all
          // client-side events (tracked / dropped / request-received / removed) ride on it.
          const msg = { type: "dshScopeRequest", build: "0.2.0", watching: Array.from(trackedRefs.keys()).slice(0, 3) };
          try { Object.assign(msg, extra || {}); } catch (err) { /* noop */ }
          try { window.parent.postMessage(msg, "*"); } catch (err) { /* noop */ }
        }
        function announceTracking() {
          // 0.1.80: report right after inserting chips, over the scope-request channel —
          // the only client -> extension message proven to arrive. (dshRefsTracked never
          // showed up in the log, and a scope request fired at page load reports 0 anyway.)
          if (!trackedRefs.size) return;
          postState({ report: "已盯上方块" });
        }
        function trackInsertedRefs(refs, list) {
          const all = []
            .concat(Array.isArray(refs) ? refs : [])
            .concat(Array.isArray(list) ? list : []);
          all.forEach(function (r) {
            const path = String((r && (r.path || r.ref || r.label)) || '');
            const name = path.split('/').pop();
            if (name && /\.md$/.test(name)) {
              // dsh renders the chip label with a middle ellipsis ("comment-20261023-13…-xd4m.md"),
              // so neither exact equality nor a full-name contains-match finds it. The tail
              // ("span-xd4m.md") survives truncation and is unique enough to identify a chip.
              const tail = name.replace(/^comment-\d{8}-\d{6}-/, '') || name;
              // 0.1.89: the chip's visible text is the annotation itself now (ext 0.1.74), so
              // matching by file name alone stopped finding chips. Keep both needles.
              const alt = String((r && r.label) || '').replace(/\s+/g, ' ').trim().slice(0, 40);
              trackedRefs.set(name, { path: path, el: null, since: Date.now(), tail: tail, alt: alt });
              announceSent = false;
            }
          });
          // 0.1.81: remember the chip's own node. Text scanning the body was useless — the
          // file name also appears elsewhere in the page, so a deleted chip still looked
          // present. Node identity (isConnected) is exact.
          setTimeout(function () {
            const scope = composerScope();
            if (!scope) return;
            const nodes = scope.querySelectorAll('span,div,a,button');
            trackedRefs.forEach(function (info, nm) {
              if (info.el && info.el.isConnected) return;
              for (let i = 0; i < nodes.length; i++) {
                const el = nodes[i];
                if (!textHas(el, info)) continue;
                const parent = el.parentElement;
                if (parent && parent !== scope && String(parent.textContent || '').indexOf(nm) !== -1 && String(parent.textContent || '').length > String(el.textContent || '').length + 4) continue;
                info.el = el;
                break;
              }
            });
          }, 400);
          announceTracking();
        }
        // 0.1.92: dsh's chips are button[data-ref-chip="file"] whose title is "@<absolute path>"
        // (measured from the live page). Registering by that structure covers chips inserted in
        // earlier sessions too — previously only chips we inserted ourselves were tracked, so
        // deleting an older chip produced no reaction at all.
        // 0.1.94: the user removes a reference by backspacing it out of the composer, so the
        // composer's own text is the authority for "is this reference still there" (measured:
        // it renders as text inside div.*_input, e.g. "呃2😓1 312312").
        function composerRoot() {
          var r = null;
          try { r = document.querySelector('[contenteditable="true"]') } catch (err) { r = null }
          if (r) return r;
          try { r = document.querySelector('[class*="_input"]') } catch (err) { r = null }
          if (r) return r;
          // 0.1.96: do NOT fall back to document.body — sent messages carry the same chip
          // markup, which made every "is it still there" answer yes forever (measured: the
          // client reported 连着 for 3 chips while the composer held 0 references).
          return null;
        }
        function chipNodes() {
          var list = [];
          const root = composerRoot();
          if (!root) return list;
          try { list = Array.prototype.slice.call(root.querySelectorAll('button[data-ref-chip="file"]')); } catch (err) { list = []; }
          if (!list.length) {
            try { list = Array.prototype.slice.call(root.querySelectorAll('[data-ref-chip]')).filter(function (n) { return /\.md(\b|$)/.test(String(n.getAttribute && n.getAttribute('title') || '')) }); } catch (err) { list = []; }
          }
          return list;
        }
        // 0.1.95: the composer's references are span.<hash>_reference elements (measured from a
        // click the user made: svg < span.q44v1G_reference:"321321"). That class is the exact
        // handle for "does this reference still exist in the composer" — no text guessing.
        function refNodes() {
          var list = [];
          const root = composerRoot();
          if (!root) return list;
          try { list = Array.prototype.slice.call(root.querySelectorAll('[class*="_reference"], [data-ref-chip], [class*="_refChip"]')) } catch (err) { list = []; }
          return list;
        }
        function refTexts() {
          const set = {};
          const nodes = refNodes();
          for (let i = 0; i < nodes.length; i++) {
            const t = String(nodes[i].textContent || '').replace(/\s+/g, ' ').trim();
            if (t) set[t] = true;
            const ti = String((nodes[i].getAttribute && nodes[i].getAttribute('title')) || '');
            if (ti) set[ti] = true;
          }
          return set;
        }
        function pathOfChip(el) {
          const t = String((el && el.getAttribute && el.getAttribute('title')) || '');
          const p2 = t.charAt(0) === '@' ? t.slice(1) : t;
          return p2.indexOf('/') === 0 ? p2 : '';
        }
        function censusChips() {
          const nodes = chipNodes();
          const seenPaths = {};
          for (let i = 0; i < nodes.length; i++) {
            const p2 = pathOfChip(nodes[i]);
            if (!p2) continue;
            const name = p2.split('/').pop();
            if (!/\.md$/.test(name)) continue;
            seenPaths[name] = true;
            let info = trackedRefs.get(name);
            if (!info) {
              const tail = name.replace(/^comment-\d{8}-\d{6}-/, '') || name;
              info = { path: p2, el: nodes[i], since: Date.now(), tail: tail, alt: String(nodes[i].textContent || '').replace(/\s+/g, ' ').trim().slice(0, 40), seen: true };
              trackedRefs.set(name, info);
            } else if (!info.el || !info.el.isConnected) {
              info.el = nodes[i];
              info.seen = true;
            }
          }
          return seenPaths;
        }

        function sweepDroppedRefs() {
          const now = Date.now();
          // 0.1.98: the throttle was pure latency (a chip can only vanish on a mutation, which is
          // what calls us) — only guard against re-entrancy and the empty case.
          if (now - refSweepAt < 80 || trackedRefs.size === 0) return;
          refSweepAt = now;
          const scope = composerScope();
          if (!scope) return;
          const text = String(scope.textContent || '');
          // (the cleared-composer case is handled below, against the composer element itself)
          const croot = composerRoot();
          if (!croot) {
            const n2 = Date.now();
            if (n2 - lastDiagAt > 4000) { lastDiagAt = n2; postState({ report: "找不到 dsh 输入框元素（[class*=_input]）" }); }
            return;
          }
          const composerText = String(croot.textContent || '');
          // 0.1.97: an empty composer used to be treated as "the message was sent, nothing was
          // deleted" — but backspacing the last reference also empties it, so the deletion was
          // ignored forever (measured: composer text was "" while the client still reported
          // 连着 for a tracked chip). Empty now means every remaining reference is gone.
          if (!composerText.trim()) {
            // 0.1.99: an empty composer is ambiguous — the user may have sent the message (the
            // references move into the sent bubble) instead of deleting them. Sending must not
            // remove the page pins, so check the conversation for the annotation text first.
            const conversation = (function () {
              let t = '';
              try {
                const nodes = document.querySelectorAll('[data-slot="conversation.user.text.node"], [data-ref-chip], [class*="_refChip"]')
                for (let z = 0; z < nodes.length; z++) t += ' \u241f' + String(nodes[z].textContent || '') + ' ' + String(nodes[z].getAttribute && nodes[z].getAttribute('title') || '')
              } catch (err) { t = '' }
              return t
            })();
            const gone = [];
            trackedRefs.forEach(function (info, name) {
              const alt = String((info && info.alt) || '').replace(/\s+/g, ' ').trim();
              if (alt && conversation.indexOf(alt) !== -1) {
                postState({ report: "输入框清空但是已发送（保留图钉）: " + name });
                return;
              }
              gone.push({ name: name, path: info.path });
            });
            trackedRefs.clear();
            for (let g = 0; g < gone.length; g++) {
              postState({ report: "输入框清空 -> 方块全部移除: " + gone[g].name, drop: gone[g].name, dropPath: gone[g].path })
            }
            if (gone.length) return;
          }
          // 0.1.90: say out loud why a tracked chip was or was not treated as deleted — the
          // 撤图钉 path produced no log at all, so the broken link had to be made visible.
          const diag = [];
          const seenPaths = censusChips();
          const inRefs = refTexts();
          const refsText = Object.keys(inRefs).join("\u241f");
          for (const nm in inRefs) {
            if (Object.prototype.hasOwnProperty.call(trackedRefs, nm)) inRefs[nm] = true
          }
          void refsText;
          const short = function (nm) { return String(nm).replace(/^comment-\d{8}-/, '').slice(0, 14) };
          trackedRefs.forEach(function (info, name) {
            // 0.1.86: we track the chip before dsh renders it (the log order proved it:
            // 已盯上方块 -> postScope -> insert mode=chip). Without a grace period the very
            // first sweep ran in that gap, saw the name missing, declared a deletion and ate
            // the user's pin seconds after it appeared. Require: a grace period, and that we
            // actually saw the node once, before ever reporting a drop.
            if (info.el && info.el.isConnected) { diag.push(short(name) + " 连着"); return; }
            if (Date.now() - (info.since || 0) < 1500) { diag.push(short(name) + " 宽限中"); return; }
            // 0.1.84: dsh re-renders the chip and replaces its DOM node, so a disconnected
            // node alone is not a deletion. Re-resolve by name and rebind; only when the name
            // is gone from the page as well is it a real deletion.
            if (info.el && text.indexOf(name) !== -1) {
              diag.push(short(name) + " 被替换后重绑");
              const nodes = composerScope().querySelectorAll('span,div,a,button');
              for (let i = 0; i < nodes.length; i++) {
                if (!textHas(nodes[i], info)) continue;
                if (!info.el || String(nodes[i].textContent || '').length < String(info.el.textContent || '').length) info.el = nodes[i];
                info.seen = true;
              }
              return;
            }
            const ct = composerText;
            const altKey = info.alt ? String(info.alt).replace(/\s+/g, ' ').trim() : '';
            const still = seenPaths[name] || (altKey && inRefs[altKey]) || (info.tail && refsText.indexOf(info.tail) !== -1) || ct.indexOf(name) !== -1 || (altKey && ct.indexOf(altKey) !== -1);
            if (still) { diag.push(short(name) + " 还在输入框"); return; }
            if (!info.seen) { diag.push(short(name) + " 从没见过节点"); return; }
            diag.push(short(name) + " 判为已删");
            trackedRefs.delete(name);
            postState({ report: "方块被删: " + name, drop: name, dropPath: info.path });
          });
          if (diag.length && now - lastDiagAt > 2000) {
            lastDiagAt = now;
            postState({ report: "方块状态: " + diag.join(" | ").slice(0, 220) });
          }
          if (trackedRefs.size && !sweepReported) {
            sweepReported = true;
            try { window.parent.postMessage({ type: "dshRefsTracked", names: Array.from(trackedRefs.keys()).slice(0, 4) }, "*"); } catch (err) { /* noop */ }
          }
        }
        // 0.1.91: the DOM-disappearance check is unreliable — dsh rebuilds chip nodes with React,
        // so a tracked node can stay isConnected (measured: 方块状态 … 连着 forever) and the drop
        // was never reported. Watch the click itself: pressing the chip's 删除 reports the drop
        // immediately, event driven, no grace period, no polling.
        let chipClickHooked = false;
        function hookChipClicks() {
          if (chipClickHooked) return;
          chipClickHooked = true;
          document.addEventListener('click', function (ev) {
            if (trackedRefs.size === 0) return;
            const src = ev && ev.target;
            if (!src || !src.closest) return;
            const btn = src.closest('button,[role="button"],svg,[aria-label],[title]');
            if (!btn) return;
            const labelOf = (n) => String((n.getAttribute && (n.getAttribute('aria-label') || n.getAttribute('title'))) || '') + ' ' + String(n.textContent || '');
            const txt = labelOf(btn);
            const isChipBtn = !!(btn.closest && btn.closest('button[data-ref-chip="file"]'));
            if (!/删|remove|delete|close|移除|×|✕/i.test(txt) && !isChipBtn) return;
            const own = btn.closest('button[data-ref-chip="file"]');
            if (own) {
              const op = pathOfChip(own);
              const onm = op ? op.split('/').pop() : '';
              if (onm && trackedRefs.has(onm)) {
                const oi = trackedRefs.get(onm);
                trackedRefs.delete(onm);
                postState({ report: "方块被点删: " + onm, drop: onm, dropPath: oi.path });
                return;
              }
            }
            let el = btn;
            for (let up = 0; el && up < 10; up++) {
              const own = String(el.textContent || '');
              let hit = null;
              trackedRefs.forEach(function (info, name) {
                if ((info.tail && own.indexOf(info.tail) !== -1) || (info.alt && own.indexOf(info.alt) !== -1) || own.indexOf(name) !== -1) hit = name;
              });
              if (hit) {
                const info = trackedRefs.get(hit);
                const dp = info && info.path;
                trackedRefs.delete(hit);
                postState({ report: "方块被点删: " + hit, drop: hit, dropPath: dp });
                return;
              }
              el = el.parentElement;
            }
          }, true);
        }
        hookChipClicks();

        // 0.1.93: diagnostic of last resort — report the first click that happens anywhere a
        // file chip is nearby, with the control's tag/text/ancestor chain, so the delete
        // control's real shape becomes visible in the extension log instead of guessed.
        let clickDiagAt = 0;
        document.addEventListener('click', function (ev) {
          const now = Date.now();
          if (now - clickDiagAt < 800) return;
          const src = ev && ev.target;
          if (!src || !src.tagName) return;
          let near = null;
          let n = src;
          for (let up = 0; n && up < 12; up++) { if (/comment-\d{8}-|\.md/.test(String(n.textContent || ''))) { near = n; break } n = n.parentElement }
          if (!near) {
            const chips = chipNodes();
            if (!chips.length) return;
            near = chips[0];
          }
          clickDiagAt = now;
          const chain = [];
          let c = src;
          for (let d = 0; c && d < 6; d++) {
            const cls = typeof c.className === 'string' ? c.className.trim().split(/\s+/)[0] : '';
            chain.push(c.tagName.toLowerCase() + (c.id ? '#' + c.id : '') + (cls ? '.' + cls : '') + (c.getAttribute && c.getAttribute('data-ref-chip') ? '[chip]' : '') + (String(c.textContent || '').trim() ? ':' + JSON.stringify(String(c.textContent || '').trim().slice(0, 14)) : ''));
            c = c.parentElement;
          }
          postState({ report: "方块附近点击: " + chain.join(" < ").slice(0, 230) });
        }, true);

        function removeTrackedChipByName(name) {
          // 0.1.58: reverse half of the binding — the user deleted the pin/reference in
          // Copilot, so drop the chip we inserted. Chips are dsh's own React nodes, so the
          // only safe way is to click the control inside the chip that matches the name.
          const scope = composerScope();
          if (!scope || !name) return false;
          const tr = trackedRefs.get(name);
          const needle = (tr && tr.tail) || name;
          const needle2 = (tr && tr.alt) || '';
          // 0.1.94: a composer reference is text, so the way the user deletes it is selecting
          // that text and deleting it — do the same, then fall back to clicking a control.
          try {
            const root = composerRoot();
            const alt1 = needle2 || needle || name;
            var needleText = alt1;
            // prefer the exact reference element: click its remove affordance if it has one
            const refs = refNodes();
            for (let q = 0; q < refs.length; q++) {
              const own = String(refs[q].textContent || '').replace(/\s+/g, ' ').trim();
              if (!alt1 || (own.indexOf(alt1) === -1 && String(refs[q].getAttribute('title') || '').indexOf(alt1) === -1)) continue;
              const ctl = refs[q].querySelector('svg,button,[role="button"],[class*="remove"],[class*="close"],[class*="delete"]') || refs[q];
              try { ctl.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true, view: window })); return true; } catch (err) { /* keep trying */ }
            }
            if (root && needleText) {
              const walker = document.createTreeWalker(root, window.NodeFilter.SHOW_TEXT, null);
              let tn = null;
              while ((tn = walker.nextNode())) {
                if (String(tn.nodeValue || '').indexOf(needleText) === -1) continue;
                const range = document.createRange();
                range.selectNodeContents(tn);
                const sel = window.getSelection();
                sel.removeAllRanges();
                sel.addRange(range);
                let ok2 = false;
                try { ok2 = document.execCommand('delete'); } catch (err) { ok2 = false; }
                try { sel.removeAllRanges(); } catch (err) { /* noop */ }
                if (ok2) return true;
                break;
              }
            }
          } catch (err) { /* fall through to clicking */ }
          const nodes = scope.querySelectorAll('span,div,a,button');
          for (let i = 0; i < nodes.length; i++) {
            const el = nodes[i];
            if (String(el.textContent || '').indexOf(needle) === -1 && (!needle2 || String(el.textContent || '').indexOf(needle2) === -1)) continue;
            const parent = el.parentElement;
            if (parent && parent !== scope && String(parent.textContent || '').indexOf(needle) !== -1 && String(parent.textContent || '').length > String(el.textContent || '').length + 4) continue;
            let target = null;
            try { target = el.querySelector('button,[role="button"],svg,[class*="remove"],[class*="close"]'); } catch (err) { target = null; }
            if (!target && el.matches && el.matches('button,[role="button"]')) target = el;
            if (!target) target = el;
            try {
              target.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
              return true;
            } catch (err) { return false; }
          }
          return false;
        }
        try { window.parent.postMessage({ type: "dshClientBuild", version: "0.2.3" }, "*"); } catch (err) { /* noop */ }
        window.__dshrTracked = function () { return Array.from(trackedRefs.keys()); };
        window.__dshrRemoveChip = function (nm) {
          const name = String(nm || '');
          const ok = removeTrackedChipByName(name);
          if (ok) trackedRefs.delete(name);
          return ok;
        };
        if (!window.__dshrRefWatch) {
          window.__dshrRefWatch = true;
          // 0.1.85: event driven only (the user asked for no polling) — a chip can only
          // disappear as a result of a DOM mutation, so the observer is sufficient.
          try { new MutationObserver(sweepDroppedRefs).observe(document.documentElement, { childList: true, subtree: true, characterData: true }); } catch (err) { /* noop */ }
        }

        function insertRefsAtCaret(refs, fallbackText, preferred) {
          const list = (Array.isArray(refs) ? refs : []).map(formatRefForSend);
          const formattedFallback = list.map(function (r) { return r.textFallback || r.modelText; }).filter(Boolean).join("\n") || fallbackText;
          // The custom source is only needed for non-file refs (selection/terminal);
          // file/folder chips use dsh's native "reference" source.
          const needsCustom = list.some(function (r) { return r.kind !== "file" && r.kind !== "folder"; });
          if (!sessionId || !inputHub || (needsCustom && !refSourceRegistered) || list.length === 0) {
            if (formattedFallback) insertComposerText(formattedFallback);
            return {
              mode: "text",
              count: list.length,
              reason: !sessionId ? "no sessionId" : (!inputHub ? "no inputHub" : ((needsCustom && !refSourceRegistered) ? "no refSource" : "empty")),
            };
          }
          // 0.1.69: the plan-export path needs a session id for file naming, and
          // props.sessionId is the authoritative value in this component (dsh
          // stopped publishing sessions.list `.current` in 0.1.6).
          try { window.__dshrSessionId = String(sessionId); } catch (err) { /* noop */ }
          try {
            const shell = inputHub.shell(sessionId);
            if (!shell) throw new Error("conversation.input.shell unavailable");
            const references = mintRefs(list);

            // Current dsh: one reference chip per call. The insertion replaces the
            // span at the live caret and appends a separating space; every later
            // chip is chained right after the previous one so the block stays in
            // order even when the caret cannot be re-read.
            if (typeof shell.insertReference === "function") {
              const byRef = {};
              let span = referenceSpan(shell);
              for (let i = 0; i < references.length; i++) {
                const at = span.start;
                if (!shell.insertReference(references[i], span)) {
                  const p = shell.projection || {};
                  throw new Error("insertReference rejected ref " + references[i].ref
                    + " span=" + JSON.stringify(span)
                    + " detect=" + JSON.stringify(String(p.detectText || "").slice(0, 60)));
                }
                const occ = findRefOccurrence(shell, references[i].ref);
                if (!occ) throw new Error("insertReference left no occurrence for " + references[i].ref);
                byRef[references[i].ref] = occ.occurrenceId;
                span = spanAfterInsert(shell, at);
              }
              tagChipKinds(shell, references, list);
              injectChipStyles(references.map(function (r, i) {
                return { id: byRef[r.ref], kind: list[i] && list[i].kind, ref: r.ref };
              }));
              const caretAt = caretAfterRefs(shell, references);
              // rc.2 caret coordinates are DETECT-space (each mention counts
              // as one char): the chaining span after the last insert IS the
              // caret-after-chip. draft-space caretAt (caretAfterRefs) is
              // ~100 chars off on long mentions, which is why the earlier
              // caretFix kept missing.
              if (span && Number.isFinite(span.start)) {
                caretWanted = span.start;
                caretWantedAt = Date.now();
              }
              setTimeout(function () { focusComposer(caretAt); }, 0);
              setTimeout(function () { focusComposer(caretAt); }, 50);
              setTimeout(function () { ensureCaretAfterChip(); }, 300);
              // 0.1.67 insert-guard: the click that follows a fresh chip is the
              // user placing the caret, not a request to open the file.
              try { window.__dshrRefGuardUntil = Date.now() + 800; } catch (err) { /* noop */ }
              setTimeout(function () { try { caretDiag("insertReference", inputHub.shell(sessionId)); } catch (err) { /* noop */ } }, 320);
              trackInsertedRefs(refs, list);
              return { mode: "chip", count: references.length, reason: "" };
            }

            if (typeof shell.pasteBegin !== "function") {
              throw new Error("conversation.input.shell() has no chip insertion API");
            }
            const sel = currentSelection(preferred);
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
            // pasteBegin expands each "x" into `@${label}`; never use refs*2 —
            // that lands the caret inside the chip and subsequent typing
            // corrupts the occurrence (e.g. digits mixed into L30~L38).
            const draftNow = typeof shell.snapshot.draft === "string" ? shell.snapshot.draft : "";
            let caret = sel.start;
            for (let i = 0; i < references.length; i++) {
              const o = occurrences.find(function (x) { return x.ref === references[i].ref; });
              if (!o) continue;
              let end = o.offset + o.length;
              if (end < draftNow.length && draftNow.charAt(end) === " ") end += 1;
              caret = end;
            }
            const caretAt = caret;
            caretWanted = caretAt;
            caretWantedAt = Date.now();
            setTimeout(function () { focusComposer(caretAt); }, 0);
            setTimeout(function () { focusComposer(caretAt); }, 50);
            try { window.__dshrRefGuardUntil = Date.now() + 800; } catch (err) { /* noop */ }
            setTimeout(function () { try { caretDiag("pasteBegin", inputHub.shell(sessionId)); } catch (err) { /* noop */ } }, 320);
            trackInsertedRefs(list);
            return { mode: "chip", count: references.length, reason: "" };
          } catch (err) {
            console.warn("[dsh-review] native chip insert failed, fallback to text:", err && err.message || err);
            if (formattedFallback) insertComposerText(formattedFallback);
            return { mode: "text", count: list.length, reason: err && err.message || String(err) };
          }
        }

        /**
         * Caret offset just past the last inserted chip (and its separating space).
         * @param {object} shell
         * @param {object[]} references
         * @returns {number}
         */
        function caretAfterRefs(shell, references) {
          const snap = (shell && shell.snapshot) || {};
          const text = typeof snap.draft === "string" ? snap.draft : "";
          let caret = 0;
          for (let i = 0; i < references.length; i++) {
            const o = findRefOccurrence(shell, references[i].ref);
            if (!o) continue;
            let end = o.offset + o.length;
            if (end < text.length && text.charAt(end) === " ") end += 1;
            caret = end;
          }
          return caret;
        }

        function applyZoom() {
          if (!inVscodeIframe() && !vscodeIframeHint()) return;
          // A host that scales the iframe element itself (ext ≥ 2.1.19) owns the
          // zoom; CSS zoom here would double it and desync popover positioning.
          const value = zoom === 1 || hostScalesFrame() ? "" : String(zoom);
          try { document.documentElement.style.zoom = value; } catch (err) { /* noop */ }
          try { document.body.style.zoom = ""; } catch (err) { /* noop */ }
          persistIframeChrome({ zoom: zoom });
        }

        applyZoom();

        /**
         * @description Cmd/Ctrl + wheel zooms the VS Code iframe only.
         * @param {WheelEvent} event
         */
        function onWheelZoom(event) {
          if (!bridgeActive && !vscodeIframeHint()) return;
          if (!(event.metaKey || event.ctrlKey) || event.altKey) return;
          event.preventDefault();
          event.stopPropagation();
          const dir = event.deltaY > 0 ? -1 : 1;
          zoom = clampIframeZoom(zoom + dir * 0.1);
          applyZoom();
        }

        function onBridgeMessage(event) {
          const msg = event.data;
          if (!msg) return;
          if (msg.type === "dshAnnoProg") {
            try { if (msg.req === annoProgReq) annoProgStage(Number(msg.stage) || 0); } catch (err) { /* noop */ }
            return;
          }
          if (msg.type === "dshAnnoPrepared") {
            try { if (window.__dshrAnnoPrepared) window.__dshrAnnoPrepared(msg.req, String(msg.block || "")); } catch (err) { /* noop */ }
            return;
          }
          if (msg.type === "dshAnnoFocus") {
            // (0.2.7) ext returned the view to dsh after an annotation flash:
            // put the caret back in the composer (chat.open had stolen focus).
            try { if (window.__dshrFocusComposer) window.__dshrFocusComposer(); } catch (err) { /* noop */ }
            return;
          }
          if (msg.type === "dshBridgeAck") {
            bridgeActive = true;
            setInVSCodeIframe(true);
            if (bridgeTimer !== null) { clearInterval(bridgeTimer); bridgeTimer = null; }
            console.log("[dsh-review] VSCode bridge handshake ok");
            reportActivity();
            installClipboardBridge();
            installIframeSidebarPeek();
            compactNativeStatsLine();
            setTimeout(compactNativeStatsLine, 800);
            applyZoom();
            // Scope is owned by apply()-level listener; ask again in case early posts were dropped.
            try { window.parent.postMessage({ type: "dshScopeRequest", build: "0.2.0", watching: Array.from(trackedRefs.keys()).slice(0, 3) }, "*"); } catch (err) { /* noop */ }
            return;
          }
          if (msg.type === "dshChromeState") {
            if (msg.railSide === "left" || msg.railSide === "right") setIframeRailSide(msg.railSide);
            if (msg.zoom !== undefined && msg.zoom !== null) {
              zoom = clampIframeZoom(msg.zoom);
              applyZoom();
            }
            return;
          }
          if (msg.type === "dshChromeZoomDelta") {
            const dir = Number(msg.dir) < 0 ? -1 : 1;
            zoom = clampIframeZoom(zoom + dir * 0.1);
            applyZoom();
            return;
          }
          // dshSetScope is handled in apply() (always-on); do not require Dock mount.
          if (msg.type === "dshPendingUpdated") {
            setEntries(Array.isArray(msg.entries) ? msg.entries.filter(Boolean) : []);
            return;
          }
          if (msg.type === "dshInsertText" && typeof msg.text === "string") {
            // Explicit VSCode action: always the composer, never a settings
            // input; append to draft only when no composer has been focused.
            insertComposerText(msg.text);
          } else if (msg.type === "dshRemoveReference" && msg.name) {
            const nm = String(msg.name);
            postState({ report: "收到删方块请求: " + nm });
            let ok = false;
            // Element annotation chip (0.2.3): precise removal via the input
            // state's occurrence — find the source=vscode-ref occurrence whose
            // label is this element name, click the chip's own delete control
            // (dsh's native state update, no React fight), then drop the
            // comment text line that follows the chip.
            if (msg.element) {
              const snap = inputStateRef.current || {};
              const occs = Array.isArray(snap.occurrences) ? snap.occurrences : [];
              const match = occs.find(function (o) {
                if (o.source !== REF_SOURCE) return false;
                if (o.label === nm) return true;
                if (String(o.clipboardText || "").indexOf(nm) === 0) return true;
                if (String(o.label || "").indexOf(nm) === 0) return true;
                return false;
              });
              if (match) {
                const el = document.querySelector('[data-decoration="chip"][data-occurrence="' + String(match.occurrenceId) + '"]');
                if (el) {
                  const ctl = el.querySelector('button,[role="button"],[class*="remove"],[class*="close"],[class*="delete"],svg');
                  if (ctl) {
                    try { ctl.dispatchEvent(new window.MouseEvent("click", { bubbles: true, cancelable: true, view: window })); ok = true; } catch (err) { ok = false; }
                  }
                  if (!ok) { try { el.remove(); ok = true; } catch (err) { ok = false; } }
                }
              }
              if (ok && msg.text) {
                // Comment line ("text" appended after the chip) is plain draft
                // text: select the text node carrying it and delete, same
                // technique as removeTrackedChipByName's fallback.
                try {
                  const root = composerRoot();
                  const needle = String(msg.text);
                  const walker = document.createTreeWalker(root, window.NodeFilter.SHOW_TEXT, null);
                  let tn = null;
                  while ((tn = walker.nextNode())) {
                    if (String(tn.nodeValue || "").indexOf(needle) === -1) continue;
                    const range = document.createRange();
                    range.selectNodeContents(tn);
                    const sel = window.getSelection();
                    sel.removeAllRanges();
                    sel.addRange(range);
                    try { document.execCommand("delete"); } catch (err) { /* noop */ }
                    try { sel.removeAllRanges(); } catch (err) { /* noop */ }
                    break;
                  }
                } catch (err) { /* chip is gone; orphan text is cosmetic */ }
              }
            }
            if (!ok) ok = removeTrackedChipByName(nm);
            if (ok) trackedRefs.delete(nm);
            postState({ report: "删方块结果: " + nm + " -> " + (ok ? "已删" : "页面上没找到") });
          } else if (msg.type === "dshInsertRefs" && Array.isArray(msg.refs)) {
            const fallback = typeof msg.fallbackText === "string" ? msg.fallbackText : "";
            const result = insertRefsAtCaret(msg.refs, fallback, null);
            // 0.1.70 (browser element comments): the comment text must sit NEXT
            // TO the element chip, not inside it. Wait out the chip's caret
            // placement (the 300ms caret force) so the text splices right after
            // the chip. mode==="text" needs nothing here — fallbackText already
            // carries comment + element context.
            const append = typeof msg.appendText === "string" ? msg.appendText : "";
            if (append && result.mode === "chip") {
              setTimeout(function () { insertComposerText(append + "\n"); }, 330);
            }
            postToParent({
              type: "dshInsertResult",
              source: "selection",
              mode: result.mode,
              count: result.count,
              reason: result.reason || "",
            });
          } else if (msg.type === "dshAnnoDock") {
            // Full-state mirror of the Copilot attachment strip (event-driven:
            // the extension posts this on every observer beacon, never polls).
            try { window.parent.postMessage({ type: "dshPasteLog", line: "annoDock recv " + ((msg.chips || []).length) + " row(s)" }, "*"); } catch (err) { /* noop */ }
            setAnnoDockChips(msg.chips);
          } else if (msg.type === "dshFocusComposer") {
            // Extension pulled VS Code focus back to the sidebar; now the
            // view document is active, so the DOM focus lands on the composer.
            focusComposer();
          } else if (msg.type === "dshPasteImages") {
            const payloads = Array.isArray(msg.images) ? msg.images : [];
            pasteLog("iframe got extension images=" + payloads.length);
            const files = filesFromImagePayloads(payloads);
            attachDraftImages(files);
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

        // dsh UI copy buttons use navigator.clipboard.writeText, which fails
        // inside the VS Code webview iframe. Bridge that to the extension.
        function installClipboardBridge() {
          if (clipboardBridged) return;
          clipboardBridged = true;
          function sendCopy(text) {
            const s = String(text ?? "");
            if (!s) return;
            postToParent({ type: "dshCopyText", text: s });
          }
          function forwardPlainText(items) {
            try {
              const list = items || [];
              for (let i = 0; i < list.length; i++) {
                const item = list[i];
                if (!item || typeof item.getType !== "function") continue;
                const types = item.types || [];
                if (Array.prototype.indexOf.call(types, "text/plain") < 0) continue;
                item.getType("text/plain").then(function (blob) {
                  return blob && typeof blob.text === "function" ? blob.text() : "";
                }).then(function (t) { sendCopy(t); }).catch(function () { /* noop */ });
                break;
              }
            } catch (err) { /* noop */ }
          }
          // A plain-http host (the ssh sidebar's http://<ip>:3082) is not a
          // secure context, so navigator.clipboard does not exist and dsh's copy
          // buttons fall back to execCommand("copy") on a hidden textarea.
          // Writes go through the extension either way; reads stay absent.
          try {
            const origExec = document.execCommand;
            document.execCommand = function (command) {
              const c = String(command || "").toLowerCase();
              if (c === "copy" || c === "cut") sendCopy(getSelectionText());
              return origExec.apply(document, arguments);
            };
          } catch (err) { /* noop */ }
          if (!navigator.clipboard) {
            try {
              Object.defineProperty(navigator, "clipboard", {
                configurable: true,
                value: {
                  writeText: function (text) { sendCopy(text); return Promise.resolve(); },
                  write: function (items) { forwardPlainText(items); return Promise.resolve(); },
                },
              });
            } catch (err) { /* noop */ }
            return;
          }
          try {
            if (typeof navigator.clipboard.writeText === "function") {
              const origWriteText = navigator.clipboard.writeText.bind(navigator.clipboard);
              navigator.clipboard.writeText = function (text) {
                sendCopy(text);
                return origWriteText(text).catch(function () { return undefined; });
              };
            }
          } catch (err) { /* noop */ }
          try {
            if (typeof navigator.clipboard.write === "function") {
              const origWrite = navigator.clipboard.write.bind(navigator.clipboard);
              navigator.clipboard.write = function (items) {
                forwardPlainText(items);
                return origWrite(items).catch(function () { return undefined; });
              };
            }
          } catch (err) { /* noop */ }
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
                // Lexical composer (dsh 0.1.6+): execCommand("delete") is a
                // no-op; remove the selection through the input shell.
                let cut = false;
                if (sessionId && inputHub) {
                  try {
                    const shell = inputHub.shell(sessionId);
                    if (shell && typeof shell.insertText === "function") {
                      const span = referenceSpan(shell);
                      cut = span.start !== span.end && shell.insertText("", span);
                    }
                  } catch (err) { /* fall through to the DOM path */ }
                }
                if (!cut) {
                  editable.focus();
                  try { document.execCommand("delete", false, null); } catch (err) { /* noop */ }
                }
              }
            }
          } else if (key === "v") {
            if (!editable) return;
            // Same as text: VS Code never fires a DOM paste in this iframe.
            // Extension reads clipboard (text + image) and posts back.
            event.preventDefault();
            requestTextPaste(editable);
          } else if (key === "p" && event.shiftKey && !event.altKey) {
            // VS Code workbench chords do not reach the iframe; only this one
            // is forwarded. Cmd+P is left alone.
            if (event.repeat) return;
            event.preventDefault();
            event.stopPropagation();
            postToParent({ type: "dshShowCommands" });
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
            else if (key === "-" || key === "_") zoom = clampIframeZoom(zoom - 0.1);
            else zoom = clampIframeZoom(zoom + 0.1);
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

        /**
         * Paste diagnostics → iframe console + VS Code Output.
         * @param {string} line
         */
        function pasteLog(line) {
          const s = String(line || "");
          try { console.warn("[dsh-review][paste]", s); } catch (err) { /* noop */ }
          try { postToParent({ type: "dshPasteLog", line: s }); } catch (err) { /* noop */ }
        }

        let lastTextPasteAt = 0;

        /**
         * Ask the extension to read the OS clipboard (text + image).
         * iframe clipboard APIs are denied; DOM paste never fires.
         * @param {HTMLElement} editable
         */
        function requestTextPaste(editable) {
          pendingPasteTarget = editable;
          const now = Date.now();
          if (now - lastTextPasteAt < 200) {
            pasteLog("skip duplicate paste request");
            return;
          }
          lastTextPasteAt = now;
          pasteLog("request paste via extension bridge");
          postToParent({ type: "dshPasteRequest" });
        }

        /**
         * Map a clipboard MIME to dsh's accepted image types.
         * @param {string} type
         * @returns {string}
         */
        function canonicalImageType(type) {
          const t = String(type || "").toLowerCase();
          if (t === "image/jpg") return "image/jpeg";
          if (t === "image/png" || t === "image/jpeg" || t === "image/webp" || t === "image/gif") return t;
          return "";
        }

        /**
         * Files from a paste event — same source as dsh InputBar.onPaste.
         * @param {DataTransfer | null | undefined} dt
         * @returns {File[]}
         */
        function filesFromClipboardData(dt) {
          const out = [];
          if (!dt || !dt.items) return out;
          for (let i = 0; i < dt.items.length; i++) {
            const item = dt.items[i];
            if (!item || item.kind !== "file") continue;
            if (!canonicalImageType(item.type)) continue;
            const file = item.getAsFile();
            if (file) out.push(file);
          }
          return out;
        }

        /**
         * Rebuild File objects from parent-webview base64 payloads.
         * @param {any[]} list
         * @returns {File[]}
         */
        function filesFromImagePayloads(list) {
          const out = [];
          if (!Array.isArray(list)) return out;
          for (let i = 0; i < list.length; i++) {
            const p = list[i];
            if (!p || typeof p.data !== "string" || !p.data) continue;
            const media = canonicalImageType(p.type);
            if (!media) continue;
            try {
              const bin = atob(p.data);
              const bytes = new Uint8Array(bin.length);
              for (let j = 0; j < bin.length; j++) bytes[j] = bin.charCodeAt(j);
              const ext = media === "image/jpeg" ? "jpg" : media.slice("image/".length);
              out.push(new File([bytes], String(p.name || ("clipboard." + ext)), { type: media }));
            } catch (err) {
              pasteLog("decode payload failed: " + (err && err.message || err));
            }
          }
          return out;
        }

        /**
         * Same path as conversation InputBar addImages: createDraftImages + shell.addImages.
         * @param {File[]} files
         * @returns {boolean}
         */
        function attachDraftImages(files) {
          if (!files || !files.length) return false;
          const sid = sessionIdRef.current;
          if (!sid) { pasteLog("attach fail: no sessionId"); return false; }
          if (!conversationApi || !inputHub) { pasteLog("attach fail: no conversation/inputHub"); return false; }
          const shell = inputHub.shell(sid);
          if (!shell) { pasteLog("attach fail: no input shell"); return false; }
          try {
            // Current dsh: runtime draft attachments + shell.addAttachments.
            if (typeof conversationApi.createDrafts === "function" && typeof shell.addAttachments === "function") {
              const drafts = conversationApi.createDrafts(sid, files);
              if (!shell.addAttachments(drafts.map(function (draft) { return draft.id; }))) {
                if (typeof conversationApi.releaseDraftAttachments === "function") conversationApi.releaseDraftAttachments(drafts);
                pasteLog("attach fail: addAttachments rejected n=" + drafts.length);
                return false;
              }
              pasteLog("attach ok n=" + drafts.length + " session=" + String(sid));
              return true;
            }
            // Older dsh: createDraftImages + shell.addImages.
            if (typeof conversationApi.createDraftImages !== "function") {
              pasteLog("attach fail: no createDrafts/createDraftImages");
              return false;
            }
            const images = conversationApi.createDraftImages(files);
            if (typeof shell.addImages !== "function") {
              if (typeof conversationApi.releaseDraftImages === "function") conversationApi.releaseDraftImages(images);
              pasteLog("attach fail: no shell.addImages");
              return false;
            }
            if (!shell.addImages(images.map(function (img) { return img.id; }))) {
              if (typeof conversationApi.releaseDraftImages === "function") conversationApi.releaseDraftImages(images);
              pasteLog("attach fail: addImages rejected n=" + images.length);
              return false;
            }
            pasteLog("attach ok n=" + images.length + " session=" + String(sid));
            return true;
          } catch (err) {
            pasteLog("attach throw: " + (err && err.message || err));
            return false;
          }
        }

        // Context-menu paste may still deliver clipboardData; Cmd+V does not.
        function onPaste(event) {
          if (!bridgeActive) return;
          if (syntheticPasteDepth > 0) {
            // Our own synthetic paste is on its way to the native PASTE
            // pipeline; do not re-route it through the extension bridge.
            try { event.preventDefault(); } catch (err) { /* noop */ }
            return;
          }
          const dt = event.clipboardData;
          const itemDump = [];
          try {
            if (dt && dt.items) {
              for (let i = 0; i < dt.items.length; i++) {
                itemDump.push(dt.items[i].kind + ":" + dt.items[i].type);
              }
            }
          } catch (err) {
            pasteLog("clipboardData.items throw: " + (err && err.message || err));
          }
          const files = filesFromClipboardData(dt);
          let textLen = 0;
          try { textLen = dt ? String(dt.getData("text/plain") || "").length : 0; } catch (err) { /* noop */ }
          pasteLog("iframe paste items=[" + itemDump.join(",") + "] files=" + files.length + " textLen=" + textLen + " editable=" + !!activeEditable());
          if (files.length > 0) {
            const ok = attachDraftImages(files);
            pasteLog("paste image → createDraftImages/addImages ok=" + ok);
            if (ok) {
              event.preventDefault();
              event.stopPropagation();
            }
            return;
          }
          const editable = activeEditable();
          if (!editable) {
            pasteLog("skip: no editable target");
            return;
          }
          event.preventDefault();
          requestTextPaste(editable);
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
              label: base,
              clipboardText: p,
              modelText: (isFile ? "文件: " : "目录: ") + p,
            };
          });
        }

        let lastDragOverPostAt = 0;

        function onDragOver(event) {
          const now = Date.now();
          // VS Code explorer drags only carry dataTransfer data inside the
          // webview HOST document; this iframe sees hover but no payload.
          // Tell the host, which turns this iframe pointer-transparent so the
          // real dragover/drop land on the host and reach the extension.
          if (event.dataTransfer && now - lastDragOverPostAt > 400) {
            lastDragOverPostAt = now;
            try { postToParent({ type: "dshDragOver" }); } catch (err) { /* noop */ }
          }
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
            const result = insertRefsAtCaret(refs, paths.join("\n"), null);
            postToParent({
              type: "dshInsertResult",
              source: "drop",
              mode: result.mode,
              count: result.count,
              reason: result.reason || "",
              first: paths[0],
            });
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

        // Treat each occurrence as one atomic capsule: caret cannot sit
        // inside, ArrowLeft/Right jump the whole range, click snaps to the
        // nearest boundary. dsh keeps `@label` as real textarea characters
        // (backdrop is paint-only); without this, clicks land mid-chip.
        let snappingCaret = false;
        function listedOccurrences() {
          const snap = inputStateRef.current || {};
          return Array.isArray(snap.occurrences) ? snap.occurrences : [];
        }
        function occurrenceContaining(pos, occs) {
          for (let i = 0; i < occs.length; i++) {
            const o = occs[i];
            const end = o.offset + o.length;
            if (pos > o.offset && pos < end) return o;
          }
          return null;
        }
        function snapComposerCaret(el) {
          if (!el || el.tagName !== "TEXTAREA") return;
          const occs = listedOccurrences();
          if (occs.length === 0) return;
          const start = el.selectionStart;
          const end = el.selectionEnd;
          if (!Number.isFinite(start) || !Number.isFinite(end)) return;
          if (start === end) {
            const o = occurrenceContaining(start, occs);
            if (!o) return;
            const left = o.offset;
            const right = o.offset + o.length;
            const next = (start - left <= right - start) ? left : right;
            if (next === start) return;
            snappingCaret = true;
            try { el.setSelectionRange(next, next); } catch (err) { /* noop */ }
            snappingCaret = false;
            return;
          }
          let a = start;
          let b = end;
          for (let i = 0; i < occs.length; i++) {
            const o = occs[i];
            const oEnd = o.offset + o.length;
            if (o.offset >= b || oEnd <= a) continue;
            if (a > o.offset && a < oEnd) a = o.offset;
            if (b > o.offset && b < oEnd) b = oEnd;
          }
          if (a === start && b === end) return;
          snappingCaret = true;
          try { el.setSelectionRange(a, b); } catch (err) { /* noop */ }
          snappingCaret = false;
        }
        function onAtomicCaretKeydown(event) {
          if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
          if (event.altKey || event.metaKey || event.ctrlKey) return;
          const el = event.target;
          if (!el || el.tagName !== "TEXTAREA") return;
          const occs = listedOccurrences();
          if (occs.length === 0) return;
          const start = el.selectionStart;
          const end = el.selectionEnd;
          if (start !== end) return;
          if (event.key === "ArrowLeft") {
            const inside = occurrenceContaining(start, occs);
            if (inside) {
              event.preventDefault();
              event.stopPropagation();
              el.setSelectionRange(inside.offset, inside.offset);
              return;
            }
            for (let i = 0; i < occs.length; i++) {
              if (occs[i].offset + occs[i].length === start) {
                event.preventDefault();
                event.stopPropagation();
                el.setSelectionRange(occs[i].offset, occs[i].offset);
                return;
              }
            }
          } else {
            const inside = occurrenceContaining(start, occs);
            if (inside) {
              event.preventDefault();
              event.stopPropagation();
              const right = inside.offset + inside.length;
              el.setSelectionRange(right, right);
              return;
            }
            for (let i = 0; i < occs.length; i++) {
              if (occs[i].offset === start) {
                event.preventDefault();
                event.stopPropagation();
                const right = occs[i].offset + occs[i].length;
                el.setSelectionRange(right, right);
                return;
              }
            }
          }
        }
        function onAtomicCaretSettle() {
          if (snappingCaret) return;
          snapComposerCaret(document.activeElement);
        }

        // Keep a prior handshake across React remounts (inputActions identity
        // used to tear down the effect and wipe bridgeActive, so ack never stuck).
        if (bridgeActive) {
          setInVSCodeIframe(true);
          installClipboardBridge();
        } else {
          bridgeTimer = window.setInterval(announceBridge, 500);
          announceBridge();
        }

        // Re-render dock gate when apply()-level setScope updates the whitelist.
        function onScopeChanged() {
          setScopeVersion(function (n) { return n + 1; });
        }
        scopeChangeListeners.push(onScopeChanged);

        window.addEventListener("message", onBridgeMessage);
        document.addEventListener("click", onExternalClick, true);
        document.addEventListener("keydown", onKeydown, true);
        document.addEventListener("wheel", onWheelZoom, { capture: true, passive: false });
        document.addEventListener("keydown", onAtomicCaretKeydown, true);
        document.addEventListener("mouseup", onAtomicCaretSettle, true);
        document.addEventListener("keyup", onAtomicCaretSettle, true);
        document.addEventListener("selectionchange", onAtomicCaretSettle);
        document.addEventListener("copy", onCopy);
        document.addEventListener("paste", onPaste, true);
        document.addEventListener("focusin", onFocusIn, true);
        document.addEventListener("dragover", onDragOver, true);
        document.addEventListener("drop", onDrop, true);
        document.addEventListener("pointerdown", reportActivity, true);
        document.addEventListener("keydown", reportActivity, true);
        window.addEventListener("focus", reportActivity, true);
        return () => {
          if (bridgeTimer !== null) { clearInterval(bridgeTimer); bridgeTimer = null; }
          // Do NOT clear bridgeActive — remount must not drop the handshake.
          const idx = scopeChangeListeners.indexOf(onScopeChanged);
          if (idx >= 0) scopeChangeListeners.splice(idx, 1);
          window.removeEventListener("message", onBridgeMessage);
          document.removeEventListener("click", onExternalClick, true);
          document.removeEventListener("keydown", onKeydown, true);
          document.removeEventListener("wheel", onWheelZoom, true);
          document.removeEventListener("keydown", onAtomicCaretKeydown, true);
          document.removeEventListener("mouseup", onAtomicCaretSettle, true);
          document.removeEventListener("keyup", onAtomicCaretSettle, true);
          document.removeEventListener("selectionchange", onAtomicCaretSettle);
          document.removeEventListener("copy", onCopy);
          document.removeEventListener("paste", onPaste, true);
          document.removeEventListener("focusin", onFocusIn, true);
          document.removeEventListener("dragover", onDragOver, true);
          document.removeEventListener("drop", onDrop, true);
          document.removeEventListener("pointerdown", reportActivity, true);
          document.removeEventListener("keydown", reportActivity, true);
          window.removeEventListener("focus", reportActivity, true);
        };
      }, []);

      const match = workbenchMatches(workbench);
      const showDock = inVSCodeIframe && match;

      // Mount / become eligible: ask VS Code for pending once (covers reopen).
      useEffect(() => {
        if (!showDock) return;
        try { window.parent.postMessage({ type: "dshPendingRequest" }, "*"); } catch (err) { /* noop */ }
      }, [showDock, scopeVersion]);

      if (!showDock) return null;

      // Rows already filtered by VS Code to this window's workbenches; further
      // restrict to the CURRENT session workbench (exact path).
      const live = entries.filter(function (e) {
        if (!e || !e.filePath) return false;
        if (!e.workbench) return false;
        return normalizeScopePath(e.workbench) === normalizeScopePath(workbench);
      });

      // Claude-adapt palette: warm-black surface, terracotta accent, ivory text.
      const claude = getReviewSettings().claudeAdapt;
      const dockBg = claude ? "var(--dsw-alias-bg-layer-2, rgba(20,20,19,0.85))" : "var(--dsw-specific-tip, var(--dsh-color-surface, transparent))";
      const dockBorder = claude ? "1px solid rgba(217,119,87,0.25)" : "1px solid var(--dsw-alias-border-l1, #80808059)";
      const dockTextColor = claude ? "var(--dsw-alias-label-primary, #faf9f5)" : "var(--dsh-color-text, inherit)";
      const acceptBg = claude ? "#d97757" : "var(--dsh-color-success, #3fb950)";
      const rejectBg = claude ? "#b53333" : "var(--dsh-color-danger, #f85149)";
      const fileLinkColor = claude ? "#d97757" : "var(--dsh-color-accent, #50a0ff)";
      const createColor = claude ? "#55805e" : "var(--dsh-color-success, #3fb950)";
      const deleteColor = claude ? "#cf5b5b" : "var(--dsh-color-danger, #f85149)";

      return h("div", {
        style: {
          margin: "0 auto 4px",
          boxSizing: "border-box",
          flex: "none",
          overflow: "hidden",
          width: "calc(100% - var(--dsh-composer-side-clearance, 0px) * 2 - var(--dsh-composer-dock-inset, 0px) * 4)",
          maxWidth: "calc(var(--dsh-composer-card-max-width, 800px) - var(--dsh-composer-dock-inset, 0px) * 4)",
          borderRadius: "12px",
          border: dockBorder,
          background: dockBg,
          fontSize: "13px",
          fontFamily: "var(--vscode-font-family, inherit)",
          lineHeight: "20px",
        }
      },
        h("div", {
          onClick: function () { setCollapsed(!collapsed); },
          style: {
            display: "flex", alignItems: "center", gap: "8px",
            padding: "6px 10px", cursor: "pointer", userSelect: "none",
            color: dockTextColor,
            borderBottom: collapsed || live.length === 0 ? "none" : "1px solid " + (claude ? "rgba(217,119,87,0.2)" : "var(--dsh-color-border, #80808030)"),
          }
        },
          h("span", { style: { fontSize: "11px", opacity: 0.6 } }, collapsed ? "\u25B6" : "\u25BC"),
          h("span", { style: { fontWeight: 600 } }, "Review Changes"),
          h("span", { style: { opacity: 0.7, marginLeft: "4px" } },
            live.length === 0 ? "无待审" : (live.length + " file" + (live.length > 1 ? "s" : ""))
          ),
          ["accept", "reject"].map(function (action) {
            const disabled = allBusy || live.length === 0;
            return h("span", {
              key: action,
              onClick: function (e) {
                e.preventDefault();
                e.stopPropagation();
                if (disabled) return;
                setAllBusy(true);
                try {
                  window.parent.postMessage({ type: "dshReviewAll", action: action }, "*");
                } catch (err) { setAllBusy(false); }
              },
              style: {
                marginLeft: action === "accept" ? "auto" : "0",
                padding: "1px 10px",
                borderRadius: "6px",
                fontSize: "12px",
                lineHeight: "18px",
                cursor: disabled ? "default" : "pointer",
                userSelect: "none",
                color: "#ffffff",
                background: action === "accept" ? acceptBg : rejectBg,
                opacity: disabled ? 0.35 : 1,
                pointerEvents: disabled ? "none" : "auto",
              }
            }, action === "accept" ? "\u2713 全部接受" : "\u2715 全部撤回");
          }),
        ),
        !collapsed && live.length > 0 && h("div", {
          style: {
            display: "flex", flexDirection: "column", gap: "4px",
            margin: 0, padding: "6px 12px", maxHeight: "180px", overflowY: "auto",
          }
        },
          live.map(function (entry) {
            const filePath = String(entry.filePath || "");
            const basename = filePath.split("/").pop() || filePath;
            const dir = filePath.replace(/\/[^\/]+$/, "");
            const op = String(entry.operation || "edit");
            const isDelete = op === "delete";
            const isCreate = op === "create";
            const iconColor = isDelete
              ? deleteColor
              : (isCreate
                ? createColor
                : fileLinkColor);
            const nameDecor = isDelete ? "line-through" : "none";
            const nameColor = isDelete ? deleteColor : fileLinkColor;
            return h("div", {
              key: entry.id || filePath,
              style: {
                display: "grid",
                gridTemplateColumns: "14px minmax(0, 1fr)",
                gap: "8px",
                alignItems: "center",
                width: "100%",
                minWidth: 0,
                fontSize: "13px",
                lineHeight: "20px",
                color: "var(--dsw-alias-label-secondary, var(--dsh-color-text, inherit))",
                opacity: isDelete ? 0.85 : 1,
              }
            },
              OpIcon(isDelete ? "delete" : (isCreate ? "create" : "edit"), iconColor),
              h(HoverTip, { text: filePath },
                h("span", {
                  onClick: function (e) {
                    e.preventDefault();
                    e.stopPropagation();
                    try {
                      window.parent.postMessage({ type: "dshOpenFile", filePath: filePath }, "*");
                    } catch (err) { /* noop */ }
                  },
                  onMouseEnter: function (e) {
                    e.currentTarget.style.textDecoration = isDelete ? "line-through underline" : "underline";
                  },
                  onMouseLeave: function (e) {
                    e.currentTarget.style.textDecoration = nameDecor;
                  },
                  style: {
                    display: "flex", alignItems: "center", gap: "6px",
                    minWidth: 0, overflow: "hidden", cursor: "pointer",
                    textDecoration: nameDecor,
                  },
                },
                  h("span", {
                    style: {
                      fontWeight: 500, whiteSpace: "nowrap", overflow: "hidden",
                      textOverflow: "ellipsis", flex: "0 0 45%", maxWidth: "45%",
                      color: nameColor,
                      textDecoration: nameDecor,
                    }
                  }, basename),
                  h("span", {
                    style: {
                      opacity: 0.4, fontSize: "11px", whiteSpace: "nowrap",
                      overflow: "hidden", textOverflow: "ellipsis", minWidth: 0, flex: "1 1 55%",
                      textDecoration: nameDecor,
                    }
                  }, dir)
                )
              )
            );
          })
        )
      );
    }

    const REVIEW_SETTINGS_NS = "dsh-review";
    /** Bound in installReviewSettingsCard; insert path reads it at mint time. */
    let reviewSettingsScope = null;
    const REVIEW_CARD_CSS_ID = "dsh-review/plugin-card.css";
    const REVIEW_CARD_CSS = "" +
      ".dshr-page{list-style:none;margin:0;padding:0}" +
      ".dshr-card{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);border-radius:12px;list-style:none;transition:border-color .16s,background .16s}" +
      ".dshr-card:hover{border-color:var(--dsw-alias-label-dimmed)}" +
      ".dshr-cardOpen{background:var(--dsw-alias-bg-layer-2);border-color:var(--dsw-alias-label-dimmed)}" +
      ".dshr-header{appearance:none;width:100%;font:inherit;color:inherit;text-align:left;cursor:pointer;background:0 0;border:0;border-radius:12px;align-items:center;gap:12px;padding:14px 16px;display:flex}" +
      ".dshr-headText{flex-direction:column;flex:1;gap:4px;min-width:0;display:flex}" +
      ".dshr-name{color:var(--dsw-alias-label-primary);font-size:15px;font-weight:600;line-height:1.4}" +
      ".dshr-description{color:var(--dsw-alias-label-tertiary);font-size:13px;line-height:1.5}" +
      ".dshr-chevron{color:var(--dsw-alias-label-tertiary);flex:none;transition:transform .16s}" +
      ".dshr-chevronOpen{transform:rotate(180deg)}" +
      ".dshr-body{border-top:1px solid var(--dsw-alias-border-l2);margin:0 16px;padding:12px 0 8px}" +
      ".dshr-field{display:flex;align-items:flex-start;gap:10px;padding:4px 0}" +
      ".dshr-stack{flex-direction:column;gap:12px;padding:4px 0;display:flex}" +
      ".dshr-stack .dshr-field{flex-direction:column;align-items:stretch;gap:6px}" +
      ".dshr-select{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);height:34px;font:inherit;color:var(--dsw-alias-label-primary);border-radius:8px;padding:0 12px;font-size:13px;width:100%}" +
      ".dshr-field label{color:var(--dsw-alias-label-primary);font-size:13px;font-weight:500;line-height:1.5}" +
      ".dshr-hint{color:var(--dsw-alias-label-tertiary);margin:4px 0 0;font-size:12px;line-height:1.5}" +
      ".dshr-footer{border-top:1px solid var(--dsw-alias-border-l2);justify-content:flex-end;align-items:center;gap:8px;padding:12px 0 4px;display:flex}" +
      ".dshr-failed{min-width:0;color:var(--dsw-alias-label-error);flex:1;margin:0;font-size:12px;line-height:1.5}" +
      ".dshr-discard,.dshr-save{appearance:none;font:inherit;cursor:pointer;border:1px solid transparent;border-radius:8px;padding:5px 14px;font-size:13px;line-height:1.5}" +
      ".dshr-discard{border-color:var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary);background:transparent}" +
      ".dshr-save{background:var(--dsw-alias-label-primary);color:var(--dsw-alias-bg-layer-3)}" +
      ".dshr-discard:disabled,.dshr-save:disabled{opacity:.4;cursor:default}";

    /**
     * @description Inject card CSS once (same pattern as official PluginCard).
     */
    function ensureReviewCardCss() {
      if (typeof document === "undefined") return;
      if (document.querySelector("style[data-plugin-css=" + JSON.stringify(REVIEW_CARD_CSS_ID) + "]")) return;
      const tag = document.createElement("style");
      tag.dataset.plugin = "dsh-review";
      tag.dataset.pluginCss = REVIEW_CARD_CSS_ID;
      tag.textContent = REVIEW_CARD_CSS;
      document.head.appendChild(tag);
    }

    /**
     * @param {object} ctx client context
     * @description Register 设置 → 插件配置 card keyed by Host namespace `dsh-review`.
     */
    /**
     * @param {object} remote client `remote` service (has settings face + $on)
     * @returns {object|null} settingsScope-shaped snapshot store, or null
     * @description dsh 0.2.0-rc.2 replacement for settingsScope.bind: derive
     * this namespace's view from the one `remote.settings.describe()` mirror,
     * refresh on `settings/document-updated`, write via
     * `remote.settings.mutate(ns, [{op:"set",path,value}], revision)`.
     */
    function makeRemoteSettingsScope(remote) {
      const settings = remote && remote.settings;
      if (!settings || typeof settings.describe !== "function" || typeof settings.mutate !== "function") return null;
      let snapshot = { status: "loading", writable: false, value: void 0, revision: 0 };
      const listeners = new Set();
      let inFlight = null;
      function notify() { for (const l of listeners) l(); }
      function load() {
        if (inFlight) return inFlight;
        // rc.2 web profiles mount the settings service but no persistence
        // provider, so remote.settings.describe() throws and the official
        // settings plane is read-only. dsh-web plugins (tts: /dsh-tts-api;
        // voice-input: ctx.remote.speech.configure) all persist through their
        // OWN host channel; we do the same via /dsh-review/settings.
        const run = Promise.resolve().then(function () {
          return fetch("/dsh-review/settings", { credentials: "same-origin", cache: "no-store" });
        })
          .then(function (res) {
            if (!res.ok) throw new Error("settings GET " + res.status);
            return res.json();
          })
          .then(function (value) {
            snapshot = { status: "ready", writable: true, value: value, revision: snapshot.revision + 1 };
          }, function () {
            snapshot = { status: "error", writable: false, value: void 0, revision: snapshot.revision };
          })
          .then(function () { inFlight = null; notify(); });
        inFlight = run;
        return run;
      }
      return {
        subscribe: function (listener) {
          listeners.add(listener);
          return function () { listeners.delete(listener); };
        },
        getSnapshot: function () { return snapshot; },
        set: function (key, value) {
          const patch = {};
          patch[key] = value;
          return fetch("/dsh-review/settings", {
            method: "POST",
            credentials: "same-origin",
            cache: "no-store",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(patch),
          }).then(function (res) {
            if (!res.ok) throw new Error("settings POST " + res.status);
            return res.json();
          }).then(function (value) {
            snapshot = { status: "ready", writable: true, value: value, revision: snapshot.revision + 1 };
            notify();
            return value;
          });
        },
        reload: load,
      };
    }

    function installReviewSettingsCard(ctx) {
      if (!ctx || typeof ctx.inject !== "function") return;
      ctx.inject(["remote.settings"], function (sctx) {
        const reviewScope = makeRemoteSettingsScope(sctx.remote);
        if (!reviewScope) {
          console.warn("[dsh-review] remote.settings missing; plugin card skipped");
          return;
        }
        reviewSettingsScope = reviewScope;
        sctx.effect(function () {
          const remote = sctx.remote;
          const off = remote && typeof remote.$on === "function"
            ? remote.$on("settings/document-updated", function () { reviewScope.reload().then(applyRailSideFromSettings); })
            : null;
          reviewScope.reload().then(applyRailSideFromSettings);
          return function () { if (typeof off === "function") off(); };
        });
        ensureReviewCardCss();
        function ReviewSettingsCard(props) {
          const snap = useSyncExternalStore(
            function (onStore) { return reviewScope.subscribe(onStore); },
            function () { return reviewScope.getSnapshot(); },
          );
          const [open, setOpen] = useState(!!(props && props.page));
          const [draftEnabled, setDraftEnabled] = useState(null);
          const [draftFileSend, setDraftFileSend] = useState(null);
          const [draftSnippetSend, setDraftSnippetSend] = useState(null);
          const [draftSidebarSide, setDraftSidebarSide] = useState(null);
          const [draftSidebarFloat, setDraftSidebarFloat] = useState(null);
          const [draftJobsTerminal, setDraftJobsTerminal] = useState(null);
          const [draftScopeFilter, setDraftScopeFilter] = useState(null);
          const [draftAutoWorkspace, setDraftAutoWorkspace] = useState(null);
          const [draftOpenFilesVs, setDraftOpenFilesVs] = useState(null);
          const [draftClaudeAdapt, setDraftClaudeAdapt] = useState(null);
          const [draftAnnotationToDsh, setDraftAnnotationToDsh] = useState(null);
          const [draftAnnoHeapBridge, setDraftAnnoHeapBridge] = useState(null);
          const [saving, setSaving] = useState(false);
          const [failed, setFailed] = useState(false);
          const live = getReviewSettings();
          const liveEnabled = live.enabled;
          const liveFileSend = live.fileSend;
          const liveSnippetSend = live.snippetSend;
          const liveSidebarSide = live.sidebarSide;
          const liveSidebarFloat = live.sidebarFloat;
          const liveJobsTerminal = live.jobsTerminal;
          const liveScopeFilter = live.scopeFilter;
          const liveAutoWorkspace = live.autoWorkspace;
          const liveOpenFilesVs = live.openFilesInVscode;
          const liveClaudeAdapt = live.claudeAdapt;
          const liveAnnotationToDsh = live.annotationToDsh;
          const liveAnnoHeapBridge = live.annoHeapBridge;
          const shownEnabled = draftEnabled == null ? liveEnabled : draftEnabled;
          const shownFileSend = draftFileSend == null ? liveFileSend : draftFileSend;
          const shownSnippetSend = draftSnippetSend == null ? liveSnippetSend : draftSnippetSend;
          const shownSidebarSide = draftSidebarSide == null ? liveSidebarSide : draftSidebarSide;
          const shownSidebarFloat = draftSidebarFloat == null ? liveSidebarFloat : draftSidebarFloat;
          const shownJobsTerminal = draftJobsTerminal == null ? liveJobsTerminal : draftJobsTerminal;
          const shownScopeFilter = draftScopeFilter == null ? liveScopeFilter : draftScopeFilter;
          const shownAutoWorkspace = draftAutoWorkspace == null ? liveAutoWorkspace : draftAutoWorkspace;
          const shownOpenFilesVs = draftOpenFilesVs == null ? liveOpenFilesVs : draftOpenFilesVs;
          const shownClaudeAdapt = draftClaudeAdapt == null ? liveClaudeAdapt : draftClaudeAdapt;
          const shownAnnotationToDsh = draftAnnotationToDsh == null ? liveAnnotationToDsh : draftAnnotationToDsh;
          const shownAnnoHeapBridge = draftAnnoHeapBridge == null ? liveAnnoHeapBridge : draftAnnoHeapBridge;
          const dirty = shownEnabled !== liveEnabled
            || shownFileSend !== liveFileSend
            || shownSnippetSend !== liveSnippetSend
            || shownSidebarSide !== liveSidebarSide
            || shownSidebarFloat !== liveSidebarFloat
            || shownJobsTerminal !== liveJobsTerminal
            || shownScopeFilter !== liveScopeFilter
            || shownAutoWorkspace !== liveAutoWorkspace
            || shownOpenFilesVs !== liveOpenFilesVs
            || shownClaudeAdapt !== liveClaudeAdapt
            || shownAnnotationToDsh !== liveAnnotationToDsh
            || shownAnnoHeapBridge !== liveAnnoHeapBridge;
          const available = snap && snap.status === "ready";
          const writable = !!(snap && snap.writable);

          useEffect(function () {
            setDraftEnabled(null);
            setDraftFileSend(null);
            setDraftSnippetSend(null);
            setDraftSidebarSide(null);
            setDraftSidebarFloat(null);
            setDraftJobsTerminal(null);
            setDraftScopeFilter(null);
            setDraftAutoWorkspace(null);
            setDraftOpenFilesVs(null);
            setDraftClaudeAdapt(null);
            setDraftAnnotationToDsh(null);
            setDraftAnnoHeapBridge(null);
            setFailed(false);
          }, [liveEnabled, liveFileSend, liveSnippetSend, liveSidebarSide, liveSidebarFloat, liveJobsTerminal, liveScopeFilter, liveAutoWorkspace, liveOpenFilesVs, liveClaudeAdapt, liveAnnotationToDsh, liveAnnoHeapBridge]);

          if (!available) return null;

          function discardDraft() {
            setDraftEnabled(null);
            setDraftFileSend(null);
            setDraftSnippetSend(null);
            setDraftSidebarSide(null);
            setDraftSidebarFloat(null);
            setDraftJobsTerminal(null);
            setDraftScopeFilter(null);
            setDraftAutoWorkspace(null);
            setDraftOpenFilesVs(null);
            setDraftClaudeAdapt(null);
            setDraftAnnotationToDsh(null);
            setDraftAnnoHeapBridge(null);
            setFailed(false);
          }

          /**
           * @description Sequential set() so revision fencing does not collide.
           */
          function saveDraft() {
            setSaving(true);
            setFailed(false);
            let chain = Promise.resolve();
            if (shownEnabled !== liveEnabled) {
              chain = chain.then(function () { return reviewScope.set("enabled", shownEnabled); });
            }
            if (shownFileSend !== liveFileSend) {
              chain = chain.then(function () { return reviewScope.set("fileSend", shownFileSend); });
            }
            if (shownSnippetSend !== liveSnippetSend) {
              chain = chain.then(function () { return reviewScope.set("snippetSend", shownSnippetSend); });
            }
            if (shownSidebarSide !== liveSidebarSide) {
              chain = chain.then(function () { return reviewScope.set("sidebarSide", shownSidebarSide); });
            }
            if (shownSidebarFloat !== liveSidebarFloat) {
              chain = chain.then(function () { return reviewScope.set("sidebarFloat", shownSidebarFloat); });
            }
            if (shownJobsTerminal !== liveJobsTerminal) {
              chain = chain.then(function () { return reviewScope.set("jobsTerminal", shownJobsTerminal); });
            }
            if (shownScopeFilter !== liveScopeFilter) {
              chain = chain.then(function () { return reviewScope.set("scopeFilter", shownScopeFilter); });
            }
            if (shownAutoWorkspace !== liveAutoWorkspace) {
              chain = chain.then(function () { return reviewScope.set("autoWorkspace", shownAutoWorkspace); });
            }
            if (shownOpenFilesVs !== liveOpenFilesVs) {
              chain = chain.then(function () { return reviewScope.set("openFilesInVscode", shownOpenFilesVs); });
            }
            if (shownClaudeAdapt !== liveClaudeAdapt) {
              chain = chain.then(function () { return reviewScope.set("claudeAdapt", shownClaudeAdapt); });
            }
            if (shownAnnotationToDsh !== liveAnnotationToDsh) {
              chain = chain.then(function () { return reviewScope.set("annotationToDsh", shownAnnotationToDsh); });
            }
            if (shownAnnoHeapBridge !== liveAnnoHeapBridge) {
              chain = chain.then(function () { return reviewScope.set("annoHeapBridge", shownAnnoHeapBridge); });
            }
            chain.then(
              function () { setSaving(false); discardDraft(); applyRailSideFromSettings(); },
              function () { setSaving(false); setFailed(true); },
            );
          }

          return h("li", { className: "dshr-card" + (open ? " dshr-cardOpen" : "") },
            h("button", {
              type: "button",
              className: "dshr-header",
              "aria-expanded": open,
              onClick: function () { setOpen(!open); },
            },
              h("span", { className: "dshr-headText" },
                h("span", { className: "dshr-name" }, "代码审查"),
                h("span", { className: "dshr-description" }, "待审、侧栏贴边位置、任务终端、工作区会话显示，以及拖入文件 / 代码段时发给模型的格式。"),
              ),
              h("span", {
                className: "dshr-chevron" + (open ? " dshr-chevronOpen" : ""),
                "aria-hidden": true,
              }, "▾"),
            ),
            open ? h("div", { className: "dshr-body" },
              h("div", { className: "dshr-field" },
                h("input", {
                  id: "dshr-enabled",
                  type: "checkbox",
                  checked: shownEnabled,
                  disabled: !writable || saving,
                  onChange: function (e) {
                    setDraftEnabled(!!e.target.checked);
                    setFailed(false);
                  },
                }),
                h("div", null,
                  h("label", { htmlFor: "dshr-enabled" }, "启用代码审查"),
                  h("p", { className: "dshr-hint" }, "关闭后新的工具写入不再进入待审。已打开的审查不受影响。"),
                ),
              ),
              h("div", { className: "dshr-stack" },
                h("div", { className: "dshr-field" },
                  h("label", { htmlFor: "dshr-file-send" }, "拖入文件时发给模型"),
                  h("select", {
                    id: "dshr-file-send",
                    className: "dshr-select",
                    value: shownFileSend,
                    disabled: !writable || saving,
                    onChange: function (e) {
                      setDraftFileSend(e.target.value);
                      setFailed(false);
                    },
                  },
                    h("option", { value: "path" }, "`file_path`（反引号包路径）"),
                    h("option", { value: "prefixed" }, "文件: `file_path`"),
                  ),
                  h("p", { className: "dshr-hint" }, "路径带反引号，避免 / 被当成 skill。输入框仍是文件名 chip。"),
                ),
                h("div", { className: "dshr-field" },
                  h("label", { htmlFor: "dshr-snippet-send" }, "拖入代码段时发给模型"),
                  h("select", {
                    id: "dshr-snippet-send",
                    className: "dshr-select",
                    value: shownSnippetSend,
                    disabled: !writable || saving,
                    onChange: function (e) {
                      setDraftSnippetSend(e.target.value);
                      setFailed(false);
                    },
                  },
                    h("option", { value: "fence" }, "整段正文（围栏，无语言）"),
                    h("option", { value: "pointer" }, "`file_path` L1~L2"),
                  ),
                  h("p", { className: "dshr-hint" }, "整段：插入时快照正文；chip 仍显示「文件名 L1~L2」。指针模式路径同样带反引号。"),
                ),
                h("div", { className: "dshr-field" },
                  h("label", { htmlFor: "dshr-rail-side" }, "侧栏位置"),
                  h("select", {
                    id: "dshr-rail-side",
                    className: "dshr-select",
                    value: shownSidebarSide,
                    disabled: !writable || saving,
                    onChange: function (e) {
                      setDraftSidebarSide(e.target.value);
                      setFailed(false);
                    },
                  },
                    h("option", { value: "left" }, "左侧"),
                    h("option", { value: "right" }, "右侧"),
                  ),
                  h("p", { className: "dshr-hint" }, "常驻侧栏贴窗口左/右边缘（VS Code 侧栏内生效，保存后立即换边；悬浮模式下不显示侧栏）。"),
                ),
              ),
              h("div", { className: "dshr-field" },
                h("input", {
                  id: "dshr-sidebar-float",
                  type: "checkbox",
                  checked: shownSidebarFloat,
                  disabled: !writable || saving,
                  onChange: function (e) {
                    setDraftSidebarFloat(!!e.target.checked);
                    setFailed(false);
                  },
                }),
                h("div", null,
                  h("label", { htmlFor: "dshr-sidebar-float" }, "会话列表改为悬浮按钮"),
                  h("p", { className: "dshr-hint" }, "开启：不显示侧栏，右上角常驻一个按钮：单击展开/收起悬浮会话列表（含底部设置，开关状态会记住），双击跳回本工作区最近活跃的会话。关闭：侧栏常驻显示。仅 VS Code 侧栏内生效。"),
                ),
              ),
              h("div", { className: "dshr-field" },
                h("input", {
                  id: "dshr-jobs-terminal",
                  type: "checkbox",
                  checked: shownJobsTerminal,
                  disabled: !writable || saving,
                  onChange: function (e) {
                    setDraftJobsTerminal(!!e.target.checked);
                    setFailed(false);
                  },
                }),
                h("div", null,
                  h("label", { htmlFor: "dshr-jobs-terminal" }, "在 VS Code 显示任务终端"),
                  h("p", { className: "dshr-hint" }, "开启后 agent 的后台 bash 任务才会在 VS Code 弹出只读终端标签；关闭只影响之后的新任务，已打开的终端不受影响。默认关。"),
                ),
              ),
              h("div", { className: "dshr-field" },
                h("input", {
                  id: "dshr-scope-filter",
                  type: "checkbox",
                  checked: shownScopeFilter,
                  disabled: !writable || saving,
                  onChange: function (e) {
                    setDraftScopeFilter(!!e.target.checked);
                    setFailed(false);
                  },
                }),
                h("div", null,
                  h("label", { htmlFor: "dshr-scope-filter" }, "侧栏只显示当前工作区的对话"),
                  h("p", { className: "dshr-hint" }, "VS Code 侧栏会话列表隐藏其他工作区的分组与会话（分组 / 排序 / 归档筛选照常可用）。关闭后 VS Code 侧栏显示全部对话。浏览器打开不受影响。默认开。"),
                ),
              ),
              h("div", { className: "dshr-field" },
                h("input", {
                  id: "dshr-auto-workspace",
                  type: "checkbox",
                  checked: shownAutoWorkspace,
                  disabled: !writable || saving,
                  onChange: function (e) {
                    setDraftAutoWorkspace(!!e.target.checked);
                    setFailed(false);
                  },
                }),
                h("div", null,
                  h("label", { htmlFor: "dshr-auto-workspace" }, "自动为新文件夹创建工作区"),
                  h("p", { className: "dshr-hint" }, "VS Code 打开的文件夹若从未在 dsh 注册（如单独打开子文件夹），自动为它创建 dsh 工作区并在那里开新会话。关闭后这类窗口返回 dsh 首页并提示。默认开。"),
                ),
              ),
              h("div", { className: "dshr-field" },
                h("input", {
                  id: "dshr-open-files-vs",
                  type: "checkbox",
                  checked: shownOpenFilesVs,
                  disabled: !writable || saving,
                  onChange: function (e) {
                    setDraftOpenFilesVs(!!e.target.checked);
                    setFailed(false);
                  },
                }),
                h("div", null,
                  h("label", { htmlFor: "dshr-open-files-vs" }, "点击文件用 VS Code 编辑器打开"),
                  h("p", { className: "dshr-hint" }, "点击对话里的文件链接 / 产物卡片 / 行内文件提及时,在 VS Code 编辑器打开该文件,而不是 dsh 内置预览(仅 VS Code 侧栏内生效;关闭后恢复 dsh 原生预览)。默认开。"),
                ),
              ),
              h("div", { className: "dshr-field" },
                h("input", {
                  id: "dshr-claude-adapt",
                  type: "checkbox",
                  checked: shownClaudeAdapt,
                  disabled: !writable || saving,
                  onChange: function (e) {
                    setDraftClaudeAdapt(!!e.target.checked);
                    setFailed(false);
                  },
                }),
                h("div", null,
                  h("label", { htmlFor: "dshr-claude-adapt" }, "适配 Claude 界面"),
                  h("p", { className: "dshr-hint" }, "开启后 Review Changes 待审栏使用 Claude 主题配色（暖黑底、陶橙点缀），与 dsh-claude-style / dsh-anthropic-fonts 协调。关闭恢复默认配色。默认开。"),
                ),
              ),
              h("div", { className: "dshr-field" },
                h("input", {
                  id: "dshr-annotation-to-dsh",
                  type: "checkbox",
                  checked: shownAnnotationToDsh,
                  disabled: !writable || saving,
                  onChange: function (e) {
                    setDraftAnnotationToDsh(!!e.target.checked);
                    setFailed(false);
                  },
                }),
                h("div", null,
                  h("label", { htmlFor: "dshr-annotation-to-dsh" }, "浏览器元素批注发给 dsh"),
                  h("p", { className: "dshr-hint" }, "开启后：在 Copilot（Comment on Elements）里标注元素；在 dsh 发送消息时自动抓取全部标注内容并入消息发给 agent，随后清空 Copilot（chip + 输入行）并立即闪回 dsh；打开 Copilot 面板也会立刻送回 dsh；VS Code 重载时同样清一次。关闭后：此功能如同不存在——不抓取、不清理、不闪回、不清输入行，批注完全走 Copilot 原生流程。仅 VS Code 侧栏生效，浏览器打开的 dsh 不受影响。默认开。"),
                ),
              ),
              h("div", { className: "dshr-field" },
                h("input", {
                  id: "dshr-anno-heap",
                  type: "checkbox",
                  checked: shownAnnoHeapBridge,
                  disabled: !writable || saving,
                  onChange: function (e) {
                    setDraftAnnoHeapBridge(!!e.target.checked);
                    setFailed(false);
                  },
                }),
                h("div", null,
                  h("label", { htmlFor: "dshr-anno-heap" }, "发送时堆直读标注（免 hover）"),
                  h("p", { className: "dshr-hint" }, "开启（默认）：发送带标注时对工作台内存做堆快照，直读 Copilot 附件母本（官方全文含完整 CSS + pick 时截图，顺带收取整页/区域截图附件），不合成 hover；快照+解析约 15-40 秒，进度环显示。关闭或堆路失败：本次发送不带标注全文（无回退——hover 老路已退役），附件照常清空。"),
                ),
              ),
              h("div", { className: "dshr-footer" },
                failed ? h("p", { className: "dshr-failed", role: "status" }, "保存失败") : null,
                h("button", {
                  type: "button",
                  className: "dshr-discard",
                  disabled: !dirty || saving,
                  onClick: discardDraft,
                }, "放弃"),
                h("button", {
                  type: "button",
                  className: "dshr-save",
                  disabled: !dirty || saving || !writable,
                  onClick: saveDraft,
                }, saving ? "保存中" : "保存"),
              ),
            ) : null,
          );
        }
        function ReviewSettingsPage() {
          return h("ul", { className: "dshr-page" }, h(ReviewSettingsCard, { page: true }));
        }
        sctx.effect(function () {
          const registered = [];
          // Own page in the Settings dialog nav (below the built-in sections,
          // which use order -10..20). The settings shell declares the slot
          // after we load, so register from slots.inject's callback - a bare
          // register races the owner and throws "slot is not declared".
          const seats = [
            { name: "settings.section", id: "dsh-review", order: 200, label: function () { return "代码审查"; }, component: ReviewSettingsPage },
          ];
          seats.forEach(function (seat) {
            const off = sctx.slots.inject(seat.name, function () {
              try {
                const opts = Object.assign({}, seat);
                delete opts.component;
                sctx.slots.register(opts, seat.component);
              } catch (err) {
                console.log("[dsh-review] seat skip", seat.name, (err && err.message || "").slice(0, 80));
              }
            });
            if (typeof off === "function") registered.push(off);
          });
          return function () {
            registered.forEach(function (off) { off(); });
          };
        }, "dsh-review: plugin settings card");
      });
    }

    // (2.1.2) "of context used" popover: 576,167,879 tok -> 576.2M tok + one
    // TOTAL (in+out) row. EVENT-driven: fires on the trigger click; a scoped
    // MutationObserver watches ONLY the open popover (React live-updates would
    // clobber a one-shot rewrite) and is DISCONNECTED when the popover leaves
    // the DOM — zero timers, zero global polling (user rule: 别轮询).
    function annoFmtTok(n) {
      n = Number(n) || 0;
      if (n >= 1e6) return (n / 1e6).toFixed(1) + "M";
      if (n >= 1e3) return (n / 1e3).toFixed(1) + "K";
      return String(n);
    }
    function annoRestatize(pop) {
      try {
        if (!pop || !pop.isConnected) return;
        if (pop.__dshrStatBusy) return;
        pop.__dshrStatBusy = true;
        try {
          // (2.1.4) React may split the value into SEPARATE text nodes
          // ("23,724" + " tok"), which killed the single-text-node match. Match
          // on LEAF elements instead: no child elements, whole text matches
          // "N,NNN tok". The scoped observer re-applies after every React
          // commit, so replacing textContent wholesale is safe.
          var re = /^([\d,]+)\s*tok$/;
          var hits = [], total = 0;
          var all = pop.querySelectorAll("span,div,b,strong");
          for (var q = 0; q < all.length; q++) {
            var el = all[q];
            if (el.getAttribute("data-dshr-tok-total") !== null) continue;
            if (el.children.length > 0) continue;
            var t = String(el.textContent || "").trim();
            if (t.indexOf("tok") === -1) continue;
            var mm = re.exec(t);
            if (!mm) continue;
            var v = parseInt(mm[1].replace(/,/g, ""), 10) || 0;
            hits.push([el, t, v]);
            total += v;
          }
          for (var i = 0; i < hits.length; i++) {
            if (hits[i][2] >= 1000) hits[i][0].textContent = annoFmtTok(hits[i][2]) + " tok";
          }
          if (hits.length && !pop.querySelector("[data-dshr-tok-total]")) {
            // (2.1.5) CLONE the native Output metric cell and rewrite its two
            // leaf texts: position, color, size then inherit 100% (hand-rolled
            // row sat flush-right and bold — user: "往左一点, 颜色和上面一样").
            var item = hits[hits.length - 1][0].parentElement;
            var grid = item.parentElement;
            if (grid) {
              var clone = item.cloneNode(true);
              clone.setAttribute("data-dshr-tok-total", "1");
              var ce = clone.querySelectorAll("span,div,b,strong");
              var valEl = null, labEl = null;
              for (var c = 0; c < ce.length; c++) {
                var cel = ce[c];
                if (cel.children.length > 0) continue;
                var tct = String(cel.textContent || "").trim();
                if (!tct) continue;
                if (/^[\d.,]+\s*[KMGT]?\s*tok$/i.test(tct)) { valEl = cel; }
                else if (tct.indexOf("tok") === -1 && !labEl) { labEl = cel; }
              }
              if (labEl && valEl) {
                labEl.textContent = /[用会]/.test(String(pop.textContent || "")) ? "合计" : "Total";
                valEl.textContent = annoFmtTok(total) + " tok";
                grid.appendChild(clone);
              }
            }
          }
        } finally { pop.__dshrStatBusy = false; }
      } catch (err) { /* cosmetic only */ }
    }
    function annoFindTokGrid() {
      try {
        var w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
        var n, pop = null;
        while ((n = w.nextNode())) {
          var t = String(n.nodeValue).trim();
          if (/token\s*(usage|用量)|session\s*statistics|会话统计/i.test(t)) { pop = n.parentElement; break; }
        }
        // (2.1.7) React's DOM order for the two section headings is NOT
        // stable — climb to the subtree that actually holds "<number> tok".
        while (pop && pop !== document.body && !/[\d,]{3,}\s*tok/.test(pop.textContent || "")) pop = pop.parentElement;
        return (pop && pop !== document.body) ? pop : null;
      } catch (err) { return null }
    }
    function annoWatchContextPopover(e) {
      try {
        var trg = e && e.target && e.target.closest ? e.target.closest('[aria-label*="of context used"], [aria-label*="上下文已用"]') : null;
        if (!trg) return;
        setTimeout(function () {
          try {
            // the popover renders near the trigger; locate it via the unique literals
            var pop = annoFindTokGrid();
            if (!pop) return;
            annoRestatize(pop);
            // (2.1.9) THE LIVE-SESSION KILLER: while the agent runs, session
            // stats refresh continuously and React REMOUNTS the popover's
            // inner nodes; an observer parked on the grid died with the
            // detached copy, leaving raw numbers and no Total (user's mac
            // page, caught red-handed by CDP: one Total written, then gone).
            // Park the observer on the [role=dialog] wrapper (survives inner
            // remounts) and RE-LOCATE the grid on every mutation.
            var dlg = pop.closest ? pop.closest('[role="dialog"]') : null;
            if (!dlg) dlg = pop;
            if (dlg.__dshrStatObs) return;
            var obs = new MutationObserver(function () {
              if (!dlg.isConnected) { try { obs.disconnect(); } catch (err) { /* gone */ } return; }
              var g2 = annoFindTokGrid();
              if (g2) annoRestatize(g2);
            });
            obs.observe(dlg, { childList: true, subtree: true, characterData: true });
            dlg.__dshrStatObs = obs;
          } catch (err) { /* cosmetic only */ }
        }, 150);
      } catch (err) { /* cosmetic only */ }
    }
    function apply(ctx) {
      installIframeSidebarPeek();
      installReviewSettingsCard(ctx);
      // 0.2.0: narrow-sidebar hint for the RIGHT sidebar (workspace files).
      // dsh's computeColumns returns rightbar=0 when available width < 300px,
      // so the expand button silently does nothing in a narrow VS Code iframe.
      // Capture-phase listener so it fires even if dsh stops propagation.
      let rightbarToastCooldown = false;
      document.addEventListener("click", function (event) {
        try {
          const target = event.target;
          if (!target || !target.closest) return;
          const btn = target.closest('[data-sidebar-right-expand]');
          if (!btn) return;
          // 0.2.0: let dsh handle the sidebar collapse naturally when the
          // rightbar opens. Auto-hide will hide the rail after mouse leaves.
          // Only re-apply hidden if it was already hidden (dsh may expand it).
          const wasHidden = document.documentElement.classList.contains("dsh-rail-hidden");
          if (wasHidden) {
            setTimeout(function () { setIframeRailHidden(true); }, 50);
            setTimeout(function () { setIframeRailHidden(true); }, 300);
          }
          setTimeout(function () {
            const rightbarCol = document.querySelector('[data-rightbar-col]');
            const w = rightbarCol ? rightbarCol.getBoundingClientRect().width : 0;
            if (w < 50 && !rightbarToastCooldown) {
              rightbarToastCooldown = true;
              showFloatingToast("侧栏太窄，无法打开工作区面板，请拉宽 VS Code 侧栏", false);
              setTimeout(function () { rightbarToastCooldown = false; }, 3000);
            }
          }, 250);
        } catch (err) { /* noop */ }
      }, true);
      // Reverse workbench watchdog:
      // 1) VS Code has no folder open → force dsh home (no session) forever.
      // 2) Matching whitelist workspace → open the latest real session once
      //    (any whitelist workbench). Later user-opened chats are left alone.
      // 3) No matching workspace → new blank session (when a dsh row exists).
      // 4) Current session workbench ∉ whitelist → pull back to latest / new.
      const uiWorkspace = (typeof ctx.uiWorkspace === "object" && ctx.uiWorkspace) || null;

      /**
       * @param {object} ssnap sessions.list.getSnapshot()
       * @returns {string|undefined}
       * @description Current session: .current pre-0.1.6; mainView retention from 0.1.6 on.
       */
      function currentSessionOf(ssnap) {
        if (ssnap && typeof ssnap.current === "string" && ssnap.current) return ssnap.current;
        const byId = (ssnap && ssnap.byId) || {};
        for (const id of Object.keys(byId)) {
          const s = byId[id];
          if (s && s.retainedBy && (s.retainedBy.mainView ?? 0) > 0) return id;
        }
        return undefined;
      }

      /**
       * @param {string} sessionId
       * @returns {boolean}
       * @description Open a session: uiWorkspace (0.1.6+) or sessions.open (older).
       */
      function openSessionCompat(sessionId) {
        if (uiWorkspace && typeof uiWorkspace.openSession === "function") {
          uiWorkspace.openSession(sessionId);
          return true;
        }
        if (typeof sessions.open === "function") {
          sessions.open(sessionId);
          return true;
        }
        return false;
      }

      /**
       * @param {string} workspaceId
       * @returns {Promise<string>|null}
       * @description Connect a workspace: uiWorkspace (0.1.6+) or workspaces (older).
       */
      function connectWorkspaceCompat(workspaceId) {
        if (uiWorkspace && typeof uiWorkspace.connectWorkspace === "function") {
          return uiWorkspace.connectWorkspace(workspaceId);
        }
        if (typeof workspaces.connectWorkspace === "function") {
          return workspaces.connectWorkspace(workspaceId);
        }
        return null;
      }

      function findBoundWorkspace(items) {
        for (const want of vscodeScopePaths.concat(vscodeScopeRawPaths)) {
          const hit = items.find((w) => w && normalizeScopePath(w.path) === normalizeScopePath(want));
          if (hit) return hit;
        }
        return null;
      }

      /**
       * @description dsh workspaces whose path is in the VS Code folder whitelist.
       * @param {object[]} items
       * @returns {object[]}
       */
      function matchingWorkspaces(items) {
        const out = [];
        for (let i = 0; i < items.length; i++) {
          const w = items[i];
          if (w && scopePathAllowed(w.path)) out.push(w);
        }
        return out;
      }

      /**
       * @param {object} summary
       * @returns {boolean}
       * @description Non-blank, non-subagent chat we should land on.
       */
      function isRealSession(summary) {
        if (!summary || summary.blank) return false;
        return !isSubagentSession(summary);
      }

      // Forks also carry parentId, so parentId alone must not exclude them.
      function isSubagentSession(summary) {
        if (summary.origin === "subagent") return true;
        const pv = summary.projectionValues;
        if (pv && pv.subagent) return true;
        const id = String(summary.id || summary.sessionId || "");
        return !!(summary.parentId || summary.parentSessionId) && id.indexOf("session-") !== 0;
      }

      function latestBoundSession(workspace, byId) {
        let best = null;
        let bestAt = -Infinity;
        for (const id of Array.isArray(workspace.sessionIds) ? workspace.sessionIds : []) {
          const summary = byId[id];
          if (!isRealSession(summary)) continue;
          const at = typeof summary.updatedAt === "number" ? summary.updatedAt : 0;
          if (best === null || at > bestAt) { best = id; bestAt = at; }
        }
        return best;
      }

      /**
       * @description Newest real chat among every whitelist workspace.
       * @param {object[]} items
       * @param {object} byId
       * @returns {string | null}
       */
      function latestWhitelistedSession(items, byId) {
        let best = null;
        let bestAt = -Infinity;
        const matches = matchingWorkspaces(items);
        for (let i = 0; i < matches.length; i++) {
          const id = latestBoundSession(matches[i], byId);
          if (!id) continue;
          const summary = byId[id];
          const at = summary && typeof summary.updatedAt === "number" ? summary.updatedAt : 0;
          if (best === null || at > bestAt) { best = id; bestAt = at; }
        }
        return best;
      }

      /**
       * @param {object[]} items
       * @returns {string[]}
       * @description Session ids listed on whitelist workspace rows (may lack byId yet).
       */
      function whitelistSessionIds(items) {
        const out = [];
        const matches = matchingWorkspaces(items);
        for (let i = 0; i < matches.length; i++) {
          const ids = Array.isArray(matches[i].sessionIds) ? matches[i].sessionIds : [];
          for (let j = 0; j < ids.length; j++) {
            if (ids[j]) out.push(ids[j]);
          }
        }
        return out;
      }

      /**
       * @param {object[]} items
       * @param {object} byId
       * @returns {boolean}
       * @description True when a listed id has not hydrated into sessions.list yet.
       */
      function whitelistHasUnresolvedIds(items, byId) {
        const ids = whitelistSessionIds(items);
        for (let i = 0; i < ids.length; i++) {
          if (!byId[ids[i]]) return true;
        }
        return false;
      }

      /**
       * @param {object[]} items
       * @param {object} byId
       * @returns {string | null}
       * @description Newest listed id even if blank — never create a second empty chat.
       */
      function latestAnyWhitelistedSession(items, byId) {
        let best = null;
        let bestAt = -Infinity;
        const ids = whitelistSessionIds(items);
        for (let i = 0; i < ids.length; i++) {
          const id = ids[i];
          const summary = byId[id];
          const at = summary && typeof summary.updatedAt === "number" ? summary.updatedAt : 0;
          if (best === null || at >= bestAt) { best = id; bestAt = at; }
        }
        return best;
      }

      // wbPath → session id we already default-opened (or a real chat the user is in).
      const preferredLatestOpened = Object.create(null);
      let landDone = false;
      // 0.1.49 one-shot re-land: dsh can drop the blank session it restored
      // between restore and mount (first-open logs: current=session-97aaa110
      // → welcome screen). landDone then latched and the window never landed
      // again until a manual reload. Retry exactly once, and only while this
      // window's own workspaces hold no real (non-blank) chat — so "user
      // closed their session → stay home" still holds in normal windows.
      let landRetryUsed = false;
      /** Bumped when we open an existing chat so an in-flight connectWorkspace is ignored. */
      let connectGeneration = 0;
      /** First time we started waiting for session list hydrate on this iframe. */
      let hydrateWaitSince = 0;
      const HYDRATE_WAIT_MS = 8000;
      let waitHydrateLogged = false;

      /**
       * @param {object} sessions
       * @param {string} sessionId
       * @param {string} matchPath
       * @returns {boolean}
       * @description Open an existing id and cancel any in-flight blank connect.
       */
      function openKnownSession(sessions, sessionId, matchPath) {
        landDone = true;
        connectGeneration += 1;
        hydrateWaitSince = 0;
        try {
          if (!openSessionCompat(sessionId)) throw new Error("no session open API (uiWorkspace.openSession / sessions.open)");
          preferredLatestOpened[normalizeScopePath(matchPath || "")] = sessionId;
          return true;
        } catch (e) {
          landDone = false;
          console.warn("[dsh-review] open latest session failed:", e && e.message || e);
          return false;
        }
      }

      // Same "most recently active" rule as the refresh landing: newest user
      // message in this window's workspaces; all workspaces when no folder is
      // open (a session outside the scope would just be pulled back).
      jumpToLatestSession = function () {
        try {
          const wsnap = ctx.workspaces.list.getSnapshot();
          const ssnap = ctx.sessions.list.getSnapshot();
          const items = Array.isArray(wsnap && wsnap.items) ? wsnap.items : [];
          const byId = (ssnap && ssnap.byId) || {};
          let best = null;
          if (scopeIsActive()) {
            best = latestWhitelistedSession(items, byId);
          } else {
            let bestAt = -Infinity;
            for (const id of Object.keys(byId)) {
              const sum = byId[id];
              if (!isRealSession(sum) || sum.archived) continue;
              const at = typeof sum.updatedAt === "number" ? sum.updatedAt : 0;
              if (at > bestAt) { best = id; bestAt = at; }
            }
          }
          if (!best) return false;
          // Plugins / Automation pages keep the last session retained by the
          // main view, so "current" alone doesn't mean the chat is on screen.
          const chatShown = !!document.querySelector('[contenteditable="true"], textarea');
          if (chatShown && currentSessionOf(ssnap) === best) return false;
          return openKnownSession(ctx.sessions, best, "");
        } catch (e) {
          console.warn("[dsh-review] jump to latest session failed:", e && e.message || e);
          return false;
        }
      };

      /**
       * @description Open latest whitelist chat, or a blank session if none exist.
       * @returns {boolean} true if we started a switch
       */
      function openLatestOrNew(items, byId, workspaces, sessions, current) {
        const matches = matchingWorkspaces(items);
        const latest = latestWhitelistedSession(items, byId);
        if (latest) {
          if (current === latest) {
            landDone = true;
            connectGeneration += 1;
            hydrateWaitSince = 0;
            return false;
          }
          return openKnownSession(sessions, latest, matches[0] && matches[0].path);
        }

        const ids = whitelistSessionIds(items);
        const unresolved = whitelistHasUnresolvedIds(items, byId);
        const emptyList = ids.length === 0;
        if (unresolved || (matches.length > 0 && emptyList)) {
          // 0.1.50 speed: dsh list stores carry a monotone baseline phase
          // ('pending' → 'ready'; official contract: empty-with-ready
          // means truly no sessions, and dsh gates its own restoreSelection on
          // both lists being ready). Once the sessions store is ready with no
          // unresolved ids, stop waiting — the fixed 8s sleep only covered a
          // half-hydrated store and added ~4s to first-open landing.
          let phaseReady = false;
          try {
            phaseReady = (sessions.list.getSnapshot() || {}).phase === "ready";
          } catch (e) { /* phase unknown → keep waiting */ }
          if (!(phaseReady && !unresolved)) {
            if (!hydrateWaitSince) hydrateWaitSince = Date.now();
            if (Date.now() - hydrateWaitSince < HYDRATE_WAIT_MS) {
              if (!waitHydrateLogged) {
                waitHydrateLogged = true;
                postScopeDiag({
                  action: "wait-hydrate",
                  current: String(current || ""),
                  dshItems: items.map(function (w) { return w && w.path ? String(w.path) : "(no-path)"; }).slice(0, 30),
                });
              }
              return false;
            }
          }
          const fallback = latestAnyWhitelistedSession(items, byId);
          if (fallback) {
            if (current === fallback) {
              landDone = true;
              connectGeneration += 1;
              hydrateWaitSince = 0;
              return false;
            }
            return openKnownSession(sessions, fallback, matches[0] && matches[0].path);
          }
        }

        hydrateWaitSince = 0;
        const anyId = latestAnyWhitelistedSession(items, byId);
        if (anyId) {
          if (current === anyId) {
            landDone = true;
            connectGeneration += 1;
            return false;
          }
          return openKnownSession(sessions, anyId, matches[0] && matches[0].path);
        }
        if (matches.length === 0) {
          // (2.1.10, user spec 2026-11-02) blank-land across ALL workspaces:
          // the window has folders but NO dsh workspace matches the whitelist
          // (matches empty) and native restore landed on NOTHING (current
          // undefined → hero). The old code returned false and left the hero
          // forever ("刷新后不默认打开最近对话"). Open the most recently
          // UPDATED real session globally — only once the lists are truly
          // ready, so a half-hydrated store never wins the race. When a real
          // session IS currently open (current defined), we do NOT touch it.
          // (2.1.11) the ssh window often has NO folder open (scopePaths
          // empty, "attached-to-host" windows) — Policy-1 pins it home, but
          // the USER spec is "after a refresh, blank → jump to most recently
          // active". Confine to the first 10s of this iframe's life so a
          // later manual "home" click is never hijacked.
          if (current === undefined && Date.now() - annoIframeBootAt < 10000) {
            let wsReady = false, ssReady = false;
            try { wsReady = (workspaces.list.getSnapshot() || {}).phase === "ready"; } catch (e) { /* keep false */ }
            try { ssReady = (sessions.list.getSnapshot() || {}).phase === "ready"; } catch (e) { /* keep false */ }
            if (wsReady && ssReady) {
              let best = null, bestAt = -Infinity;
              for (let wi = 0; wi < items.length; wi++) {
                const w = items[wi];
                const ids = Array.isArray(w && w.sessionIds) ? w.sessionIds : [];
                for (let si = 0; si < ids.length; si++) {
                  const sum = byId[ids[si]];
                  if (!isRealSession(sum) || sum.archived) continue;
                  const at = typeof sum.updatedAt === "number" ? sum.updatedAt : 0;
                  if (at > bestAt) { best = ids[si]; bestAt = at; }
                }
              }
              if (best) return openKnownSession(sessions, best, "");
              landDone = true; // lists ready, genuinely no sessions → hero is correct
            }
          }
          return false;
        }
        return connectNewSession(matches[0], workspaces, sessions);
      }

      /**
       * @description Create a blank session in `workspace` and select it.
       * @param {object} workspace dsh workspace row
       * @param {object} workspaces dsh workspaces api
       * @param {object} sessions dsh sessions api
       * @returns {boolean} true if connectWorkspace was started
       */
      function connectNewSession(workspace, workspaces, sessions) {
        const key = normalizeScopePath(workspace.path);
        if (connectInFlight) return false; // one Host mount at a time
        if (landDone) return false;
        const now = Date.now();
        if (vscodeScopePullingAt && now - vscodeScopePullingAt < 5000) return false; // 5s cooldown
        vscodeScopePullingAt = now;
        const connect = connectWorkspaceCompat(workspace.workspaceId);
        if (!connect) return false;
        const gen = ++connectGeneration;
        connectInFlight = true;
        connect.then(
          function (sessionId) {
            connectInFlight = false;
            if (gen !== connectGeneration) return;
            if (landDone) return;
            // 0.1.48: sessions.open() no longer exists on dsh 0.1.6+ (the
            // ClientSessions facade only offers retain/search/scope/…). It
            // threw, the throw was swallowed, landDone was set anyway — the
            // fresh blank session existed host-side but the main view never
            // mounted it: welcome screen stuck (the 10-minute incident).
            // Use the shared compat shim (uiWorkspace.openSession first),
            // and keep landDone false on failure so the next tick retries.
            try {
              if (!openSessionCompat(sessionId)) throw new Error("no session open API (uiWorkspace.openSession / sessions.open)");
            } catch (e) {
              console.warn("[dsh-review] fresh session open failed:", e && e.message || e);
              return;
            }
            preferredLatestOpened[key] = sessionId;
            landDone = true;
          },
          function (e) {
            connectInFlight = false;
            if (gen !== connectGeneration) return;
            landDone = false;
            console.warn("[dsh-review] connectWorkspace failed:", e && e.message || e);
          }
        );
        return true;
      }

      // ---- 0.1.45 plan B: auto-register window folders as dsh workspaces ----
      // A VS Code window opened on a folder dsh has never seen (e.g. a
      // subfolder of another workspace) has no session group of its own,
      // and dsh ≥0.1.7-rc.1 (commit b9b14dc05e, persisted
      // "dsh.sessions.current") restores the PARENT's last session there.
      // Fix at the root: ctx.workspaces.create({path}) (official, idempotent
      // — same call dsh-workspace-jump uses) registers THIS folder; the
      // normal landing flow then opens a blank session in it. Create failure
      // falls back to goHome() (clearMain welcome) + dshScopeMissing toast.
      const wsAutoCreate = new Map(); // folder → { inflight, attemptedAt, warned }
      const WS_AUTOCREATE_RETRY_MS = 60000;
      function autoCreateWorkspaces() {
        // 0.1.47 race fix: on webview boot the settings snapshot is 'loading'
        // for a second while the watchdog already ticks — reading the default
        // (on) then creates workspaces the user turned ② off (the
        // sub-sub-workspace 20:51:43 incident). Not ready → nudge a reload,
        // skip; the 1.5s tick retries until the real value lands.
        if (!reviewSettingsReady()) {
          try { if (reviewSettingsScope && reviewSettingsScope.reload) reviewSettingsScope.reload(); } catch (e) { /* noop */ }
          return;
        }
        // 0.1.46 setting ②「自动为新文件夹创建工作区」off → never register.
        if (!getReviewSettings().autoWorkspace) return;
        const ws = ctx.workspaces;
        if (!ws || typeof ws.create !== "function") return;
        for (const folder of vscodeScopePaths) {
          const f = normalizeScopePath(folder);
          if (!f) continue;
          let st = wsAutoCreate.get(f);
          if (!st) { st = { inflight: false, attemptedAt: 0, warned: false }; wsAutoCreate.set(f, st); }
          if (st.inflight) continue;
          if (st.attemptedAt && Date.now() - st.attemptedAt < WS_AUTOCREATE_RETRY_MS) continue;
          st.inflight = true;
          st.attemptedAt = Date.now();
          Promise.resolve(ws.create({ path: f })).then(
            function (result) {
              st.inflight = false;
              if (!result || result.ok) {
                // One-shot notice through the extension (throttled there).
                postScopeMessage("dshWorkspaceCreated", { path: f });
                return;
              }
              if (!st.warned) {
                st.warned = true;
                console.warn("[dsh-review] auto workspace create failed:", f, (result && result.error && (result.error.message || result.error)) || result);
              }
            },
            function (e) {
              st.inflight = false;
              if (!st.warned) {
                st.warned = true;
                console.warn("[dsh-review] auto workspace create threw:", f, e && e.message || e);
              }
            },
          );
        }
      }
      /** True while an auto-create is pending/fresh → suppress dshScopeMissing toast. */
      function autoCreateBusy() {
        // Settings not landed → creation may still fire: keep the
        // "workspace missing" toast suppressed (0.1.47 race fix).
        if (!reviewSettingsReady()) return true;
        // Setting ② off → no auto-create is ever pending: let dshScopeMissing
        // toast again ("returned to dsh home" is then the truthful message).
        if (!getReviewSettings().autoWorkspace) return false;
        const ws = ctx.workspaces;
        if (!ws || typeof ws.create !== "function") return false;
        if (wsAutoCreate.size === 0) return true; // create exists; first tick not run yet
        for (const st of wsAutoCreate.values()) {
          if (Date.now() - st.attemptedAt < WS_AUTOCREATE_RETRY_MS) return true;
        }
        return false;
      }

      /** True when any workspace matching THIS window holds a non-blank chat. */
      function hasRealSession(items, byId) {
        const matches = matchingWorkspaces(items);
        for (const w of matches) {
          const ids = Array.isArray(w.sessionIds) ? w.sessionIds : [];
          for (const id of ids) {
            const s = byId[id];
            if (s && !s.blank) return true;
          }
        }
        return false;
      }

      function checkWorkbenchScope() {
        // Standalone browser: do not pin/clear workspaces. VS Code iframe only.
        if (!inVscodeIframe()) return;
        // 0.1.46 setting ①「侧栏只显示当前工作区的对话」: the 1.5s tick also
        // syncs the row filter — off → teardown (un-hides every row), on →
        // install (wsFilterInstall re-checks its own iframe/scope gates).
        try {
          if (getReviewSettings().scopeFilter) wsFilterInstall();
          else if (wsFilterInstalled) wsFilterTeardown();
        } catch (e) { /* noop */ }
        const workspaces = ctx.workspaces;
        const sessions = ctx.sessions;
        if (!workspaces || !sessions) { console.warn("[dsh-review] scope watchdog: workspaces/sessions unavailable"); return; }
        let wsnap, ssnap;
        try { wsnap = workspaces.list.getSnapshot(); } catch (e) { return; }
        try { ssnap = sessions.list.getSnapshot(); } catch (e) { return; }
        const current = currentSessionOf(ssnap);
        const items = Array.isArray(wsnap.items) ? wsnap.items : [];
        const byId = (ssnap && ssnap.byId) || {};

        function goHome() {
          // dsh 0.2.0 home API: uiWorkspace.clearMain() releases the
          // mainView retain AND empties the persisted "dsh.sessions.current"
          // (selection store) so the next reload stops restoring the last
          // session. (dsh 0.1.6 removed sessions.clear — the old no-op path.)
          try {
            if (uiWorkspace && typeof uiWorkspace.clearMain === "function") { uiWorkspace.clearMain(); return; }
          } catch (e) { console.warn("[dsh-review] scope home clearMain failed:", e && e.message || e); return; }
          try {
            if (sessions && typeof sessions.clear === "function") { sessions.clear(); return; }
          } catch (e) { console.warn("[dsh-review] scope home clear failed:", e && e.message || e); return; }
          console.warn("[dsh-review] scope home: no clear API (uiWorkspace.clearMain / sessions.clear unavailable)");
        }

        // Handshake has not arrived yet: do not treat empty paths as "no folder".
        if (!vscodeScopeReceived) return;

        // No VS Code workspace folder: stay on dsh home; re-clear if user opens any.
        // (2.1.12 exception, user spec) the ssh "attached to host, no folder"
        // window must still land on the most recently active session after a
        // refresh — blank + inside the first 10s falls through to the normal
        // landing flow below; blank AFTER 10s keeps Policy-1 (a deliberate
        // "home" click is respected).
        if (!scopeIsActive()) {
          if (!current) {
            if (Date.now() - annoIframeBootAt > 10000) return;
          } else {
          if (connectInFlight) return;
          const nowEmpty = Date.now();
          // Short throttle — keep pullback snappy when user re-opens a workspace.
          if (vscodeScopePullingAt && nowEmpty - vscodeScopePullingAt < 2000) return;
          vscodeScopePullingAt = nowEmpty;
          postScopeMessage("dshScopeEmpty", {});
          goHome();
          return;
          }
        }

        // 0.1.45 plan B: no dsh workspace matches this window's folders
        // (subfolder window, fresh machine…) → register them now (throttled);
        // the next tick's normal landing flow opens a blank session in it.
        if (matchingWorkspaces(items).length === 0) autoCreateWorkspaces();

        // Home / unknown current: whitelist match → latest chat; else new session.
        if (!current) {
          if (landDone && !landRetryUsed && !hasRealSession(items, byId)) {
            // 0.1.49: dsh dropped the restored blank session — unlock
            // the landing latch ONCE so the first open converges
            // without needing a manual webview reload.
            landRetryUsed = true;
            landDone = false;
            hydrateWaitSince = 0;
            postScopeDiag({ action: "land-retry", current: "", dshItems: [] });
          }
          if (landDone) return;
          openLatestOrNew(items, byId, workspaces, sessions, current);
          return;
        }

        const currentWs = items.find((w) => Array.isArray(w.sessionIds) && w.sessionIds.indexOf(current) >= 0);
        if (!currentWs) {
          if (!landDone) openLatestOrNew(items, byId, workspaces, sessions, current);
          return;
        }
        if (scopePathAllowed(currentWs.path)) {
          if (!landDone) {
            openLatestOrNew(items, byId, workspaces, sessions, current);
            return;
          }
          preferredLatestOpened[normalizeScopePath(currentWs.path)] = current;
          return;
        }

        postScopeMessage("dshScopeViolation", { from: currentWs.path, to: vscodeScopePaths[0] || vscodeScopeRawPaths[0] || "" });

        const matches = matchingWorkspaces(items);
        const dshItems = items.map(function (w) { return w && w.path ? String(w.path) : "(no-path)"; }).slice(0, 30);
        if (matches.length === 0) {
          postScopeDiag({
            action: "missing-home",
            current: String(currentWs.path || ""),
            dshItems: dshItems,
          });
          // While auto-create is pending/fresh the toast would be a lie
          // ("not created yet") — the workspace is being made right now.
          if (!autoCreateBusy()) {
            postScopeMessage("dshScopeMissing", { path: vscodeScopePaths[0] || vscodeScopeRawPaths[0] || "" });
          }
          goHome();
          return;
        }
        postScopeDiag({
          action: "pullback",
          current: String(currentWs.path || ""),
          bound: String(matches[0].path || ""),
          dshItems: dshItems,
        });
        landDone = false;
        if (openLatestOrNew(items, byId, workspaces, sessions, current)) return;
        if (connectInFlight) return;
        goHome();
        return;
      }

      // ---- Session-list workspace filter (VS Code iframe only) ----------
      // The sidebar keeps its native powers: 分组(按工作区/工作区树/单列表),
      // 排序(手动/最近更新), 归档筛选. This filter only display:none-hides
      // rows that do not belong to THIS window's folders (containment, see
      // scopePathAllowed): session rows via workspaceId→path from the store,
      // group headers / overflow rows follow their group; the Ungrouped group
      // is hidden. 归档筛选 composes with it (intersection, per user: a).
      // Browser tabs never install this ⇒ fully native list, zero intervention.
      let wsFilterInstalled = false;
      let wsFilterObserver = null;
      let wsFilterTimer = null;
      let wsFilterUnsubs = [];
      function wsFilterApply() {
        let items = [];
        try {
          const ws = ctx.workspaces;
          items = (ws && ws.list.getSnapshot().items) || [];
        } catch (err) { return; } // store not ready: leave rows as they are
        const groupAllowed = new Map();
        const idToPath = new Map();
        for (const w of items) {
          const gid = w && w.workspaceId != null ? String(w.workspaceId) : "";
          if (gid) groupAllowed.set(gid, !!(w && w.path) && scopePathAllowed(String(w.path)));
          if (Array.isArray(w && w.sessionIds)) {
            for (const sid of w.sessionIds) {
              if (typeof sid === "string" && !idToPath.has(sid)) idToPath.set(sid, String((w && w.path) || ""));
            }
          }
        }
        const mark = function (row, hide) {
          if (row.classList.contains("dshr-rowHidden") === hide) return; // idempotent, no loop
          if (hide) row.classList.add("dshr-rowHidden");
          else row.classList.remove("dshr-rowHidden");
        };
        for (const row of document.querySelectorAll("[data-row-key]")) {
          const key = row.getAttribute("data-row-key") || "";
          if (key.startsWith("session:")) {
            const path = idToPath.get(key.slice(8));
            // Unmapped = Ungrouped (or brand-new row mid-store-update); hide.
            mark(row, path === undefined ? true : !scopePathAllowed(path));
          } else if (key.startsWith("workspace:")) {
            const gid = key.slice(10);
            mark(row, gid === "" || groupAllowed.get(gid) !== true);
          } else if (key.startsWith("overflow:")) {
            const gid = key.slice(9);
            mark(row, gid === "" || groupAllowed.get(gid) !== true);
          }
          // "empty" placeholder: native list-empty state; leave as-is.
        }
      }
      function wsFilterSchedule() {
        if (wsFilterTimer !== null) return;
        wsFilterTimer = setTimeout(function () {
          wsFilterTimer = null;
          try { wsFilterApply(); } catch (err) { console.warn("[dsh-review] session filter pass failed:", err && err.message || err); }
        }, 120);
      }
      function wsFilterInstall() {
        if (wsFilterInstalled) return;
        // VS Code sidebar only, and only after the scope whitelist arrived
        // (a browser tab never receives dshSetScope → never installs).
        if (!(inVscodeIframe() || bridgeActive || vscodeIframeHint())) return;
        if (!vscodeScopeReceived) return;
        // 0.1.46 setting ① off → stay uninstalled (also covers the
        // scopeChangeListeners path, which fires without the tick). 0.1.47:
        // ALSO wait for the live 设置 snapshot — acting on the default while
        // 'loading' would hide rows for users who opted ① off. The 1.5s tick
        // re-calls this until settings land.
        try { if (!reviewSettingsReady() || !getReviewSettings().scopeFilter) return; } catch (e) { /* keep default-on */ }
        wsFilterInstalled = true;
        try {
          const style = document.createElement("style");
          style.id = "dshr-ws-filter";
          style.textContent = ".dshr-rowHidden{display:none !important}";
          document.head.appendChild(style);
        } catch (err) { /* noop */ }
        try {
          wsFilterObserver = new MutationObserver(wsFilterSchedule);
          // Small-scoped root (body of the sidebar frame), attributes
          // filtered to the keys React rewrites on select/drag; our own class
          // writes are idempotent so the observer self-terminates.
          wsFilterObserver.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["data-row-key", "class"] });
        } catch (err) { /* noop */ }
        try {
          const un1 = ctx.workspaces.list.subscribe(wsFilterSchedule);
          const un2 = ctx.sessions.list.subscribe(wsFilterSchedule);
          if (typeof un1 === "function") wsFilterUnsubs.push(un1);
          if (typeof un2 === "function") wsFilterUnsubs.push(un2);
        } catch (err) { /* noop */ }
        wsFilterSchedule();
      }
      function wsFilterTeardown() {
        if (wsFilterObserver) { try { wsFilterObserver.disconnect(); } catch (err) { /* noop */ } wsFilterObserver = null; }
        if (wsFilterTimer !== null) { clearTimeout(wsFilterTimer); wsFilterTimer = null; }
        for (const un of wsFilterUnsubs) { try { un(); } catch (err) { /* noop */ } }
        wsFilterUnsubs = [];
        try { const st = document.getElementById("dshr-ws-filter"); if (st) st.remove(); } catch (err) { /* noop */ }
        for (const row of document.querySelectorAll(".dshr-rowHidden")) row.classList.remove("dshr-rowHidden");
        wsFilterInstalled = false;
      }

      // ---- Sidebar menu hover-grace patch (0.1.55) ---------------------------
      // dsh sidebar row menus (ui-primitives Menu, portal:true +
      // closeOnPointerLeave:true) close on a 200ms usePointerGrace timer armed
      // by a REACT pointerleave on the trigger span; the cancel on entering
      // the portaled list does not happen in the VS Code webview, so the menu
      // dies ~200ms after the pointer leaves the button. Patch: native
      // pointerenter/pointermove listeners on each portaled menu dispatch a
      // synthetic pointerover at the trigger anchor (inside the root
      // container, with relatedTarget set — React's enter/leave polyfill
      // ignores over events without one, facebook/react#12978) so React
      // observes a span-enter and cancels the close; when the pointer really
      // leaves the menu, ordinary events re-arm the grace and it closes
      // natively. (ego-browser CDP mouse events distort relatedTarget — this
      // patch verified in the real VS Code webview, not in ego.)
      // Second fix: in a narrow sidebar the fixed-positioned portal
      // menu can hang past the webview viewport and get clipped (labels cut
      // off); after open (fixedPos lands a couple of frames later — a
      // late pass at 250ms is the effective one) clamp its left/top inside
      // the viewport. React keeps fixedPos stable while open, so the inline
      // correction is not clobbered.
      let menuPatchObserver = null;
      function dshrMenuFit(menuEl) {
        const fix = function () {
          try {
            if (!menuEl.isConnected) return;
            const r = menuEl.getBoundingClientRect();
            if (r.width === 0 || r.height === 0) return;
            const vw = window.innerWidth, vh = window.innerHeight;
            const left = parseFloat(menuEl.style.left);
            const top = parseFloat(menuEl.style.top);
            let nl = left, nt = top;
            if (r.right > vw - 4) nl = Math.max(8, vw - r.width - 8);
            if (r.bottom > vh - 4) nt = Math.max(8, vh - r.height - 8);
            if (nl !== left && nl > 0) menuEl.style.left = nl + "px";
            if (nt !== top && nt > 0) menuEl.style.top = nt + "px";
          } catch (err) { /* noop */ }
        };
        try {
          requestAnimationFrame(function () { requestAnimationFrame(fix); });
          setTimeout(fix, 250);
        } catch (err) { /* noop */ }
      }
      function menuPatchArm(menuEl) {
        if (menuEl.__dshrMenuPatched) return;
        menuEl.__dshrMenuPatched = true;
        dshrMenuFit(menuEl);
        let lastSent = 0;
        function send(e) {
          const now = Date.now();
          if (now - lastSent < 150) return;
          lastSent = now;
          let anchor = null;
          try {
            // The portal's nearest ancestor DOM node in the REACT tree is the
            // Menu root <span> that wraps the anchor button (the portal is a
            // React child of that span); the fiber walk finds it even
            // though the DOM parent is body.
            const fk = Object.keys(menuEl).find(function (k) { return k.indexOf("__reactFiber$") === 0; });
            let fiber = fk ? menuEl[fk] : null;
            let hops = 0;
            while (fiber && hops < 24) {
              const node = fiber.stateNode;
              if (node && node.nodeType === 1 && node !== menuEl) {
                const b = node.querySelector ? node.querySelector("button") : null;
                anchor = b || node;
                break;
              }
              fiber = fiber.return;
              hops++;
            }
          } catch (err) { anchor = null; }
          if (!anchor || !anchor.isConnected) return;
          try {
            anchor.dispatchEvent(new PointerEvent("pointerover", {
              bubbles: true, cancelable: true, composed: true,
              clientX: e.clientX, clientY: e.clientY,
              pointerId: e.pointerId || 1, pointerType: e.pointerType || "mouse",
            }));
          } catch (err) { /* noop */ }
        }
        menuEl.addEventListener("pointerenter", send, true);
        menuEl.addEventListener("pointermove", send, true);
      }
      function menuPatchInstall() {
        if (menuPatchObserver) return;
        try {
          menuPatchObserver = new MutationObserver(function (muts) {
            for (const m of muts) {
              const nodes = m.addedNodes;
              for (let i = 0; i < nodes.length; i++) {
                const n = nodes[i];
                if (n.nodeType !== 1) continue;
                const cands = [];
                if (n.matches && n.matches('[role="menu"]')) cands.push(n);
                if (n.querySelectorAll) {
                  const inner = n.querySelectorAll('[role="menu"]');
                  for (let j = 0; j < inner.length; j++) cands.push(inner[j]);
                }
                for (const c of cands) {
                  // Only the portaled popovers need it (their DOM
                  // parent is body ⇒ invisible to React's listeners).
                  // CSS-module tokens look like "_portal_<hash>" — match the
                  // LEADING name; the hash suffix varies per dsh build.
                  let portal = false;
                  for (let j = 0; j < c.classList.length; j++) {
                    if (c.classList[j].indexOf("_portal_") === 0 || c.classList[j] === "_portal") { portal = true; break; }
                  }
                  if (portal) menuPatchArm(c);
                }
              }
            }
          });
          menuPatchObserver.observe(document.body, { childList: true });
        } catch (err) { menuPatchObserver = null; }
      }

      // ---- Open clicked files in the VS Code editor (0.1.58) -----------------
      // dsh routes every clickable file reference — turnTail produced-file
      // chips, inline-code file mentions, and tool-row .fileLink buttons —
      // through the owner openFile, which on the web client opens a
      // document-preview tab in the right sidebar (dsh-resource://file →
      // ui-sidebar-documentpreview). In the VS Code workbench that preview
      // duplicates the editor the user is already looking at, so with the
      // openFilesInVscode setting on (default) we capture those clicks and
      // post the path to the extension (dshOpenFile → openTextDocument).
      // Path source per the official ui-deliverables README: chips and
      // mentions carry the FULL path in title; .fileLink buttons only show
      // session-cwd-relative text, so relative paths are resolved host-side
      // against the session cwd + window workspace folders.
      let fileOpenListener = null;
      function currentSessionCwd() {
        try {
          const ssnap = ctx.sessions.list.getSnapshot();
          const id = ssnap && ssnap.current;
          const rec = id && ssnap.byId ? ssnap.byId[id] : null;
          return rec && rec.cwd ? String(rec.cwd) : "";
        } catch (err) { return ""; }
      }
      // (0.2.13) dsh-annotate@0.1.0 VERBATIM: the public session face is the
      // send — sessions.sessionOf(scope).prompt(parts, "queue") works while
      // IDLE and while GENERATING, no button, no Enter simulation, no draft
      // timing games. Exposed globally for the anno prepare protocol (the
      // markAnnoSend closure sits at module scope, outside apply(ctx)).
      // (2.0.49) Send mode follows the USER's own setting, mirroring the GUI's
      // resolveSubmitMode: idle -> queue (== direct send); busy -> the stored
      // ui-conversation.busyEnter preference ("queue" | "steer"). Settings read
      // best-effort via ctx.remote.settings.describe; unreadable => queue
      // (today's behavior, never a regression). Mode is logged for proof.
      function annoPromptMode() {
        try {
          let pref = "queue";
          // (2.0.51) TRUTH SOURCE #0 = the live composer send-button label,
          // which ui-conversation renders from the policy's in-memory store
          // (dict keys verified in upstream lib/client.js: "input.send.steer"
          // = 插话发送/Steer message, "input.send.queue" = 排队发送/Queue message
          // — only rendered while running with a plain draft). The web profile
          // has no settings persistence provider, so durable reads (configForms
          // / remote.settings.describe) only ever see defaults — that is why a
          // page visibly set to Steer read as queue (user screenshots 21:16 +
          // 21:51). Precedence: live DOM > configForms > describe > queue.
          try {
            const card0 = document.querySelector("[data-composer-card]");
            if (card0) {
              const bs = card0.querySelectorAll("button");
              for (let bi = 0; bi < bs.length; bi++) {
                const a = String(bs[bi].getAttribute("aria-label") || "");
                if (/插话发送|Steer message/i.test(a)) { pref = "steer"; break; }
                if (/排队发送|Queue message/i.test(a)) { pref = "queue"; break; }
              }
            }
          } catch (err) { /* label not in a policy state */ }
          if (pref === "queue") {
          // (2.0.50) PRIMARY SOURCE = ctx.configForms, the exact host the GUI's
          // own ComposerSubmissionPolicy adopts (ui-conversation client.js
          // ~19539: new ComposerSubmissionPolicy(ctx.configForms.get(
          // "ui-conversation"))). The web profile has NO server-side settings
          // persistence provider — remote.settings.describe() only ever sees
          // defaults, which is why a live "Steer" read as queue.
          try {
            const form = ctx.configForms && typeof ctx.configForms.get === "function" ? ctx.configForms.get("ui-conversation") : null;
            const sec = form && typeof form.getSnapshot === "function" ? form.getSnapshot() : null;
            const v = sec && sec.value ? sec.value.busyEnter : null;
            if (v === "steer" || v === "queue") pref = v;
          } catch (err) { /* configForms missing on old builds */ }
          if (pref === "queue") {
            try {
              const st = ctx.remote && ctx.remote.settings && typeof ctx.remote.settings.describe === "function"
                ? ctx.remote.settings.describe("ui-conversation") : null;
              const v2 = st && st.value ? (typeof st.value.get === "function" ? st.value.get("busyEnter") : st.value.busyEnter) : null;
              if (v2 === "steer" || v2 === "queue") pref = v2;
            } catch (err) { /* settings plane unavailable */ }
          }
          }
          let running = false;
          try {
            const sid = currentSessionId();
            const sc = sid && ctx.sessions.scope(sid);
            const se = sc && ctx.sessions.sessionOf(sc);
            running = !!(se && (se.status === "running" || se.running === true || se.isRunning === true));
          } catch (err) { /* unknown => treat idle */ }
          const mode = running && pref === "steer" ? "steer" : "queue";
          try { window.parent.postMessage({ type: "dshPasteLog", line: "[paste] prompt mode=" + mode + " (busyEnter=" + pref + " running=" + running + " client 2.0.51)" }, "*"); } catch (err2) { /* noop */ }
          return mode;
        } catch (err) { return "queue" }
      }
      try {
        window.__dshrAnnoPrompt = function (text) {
          try {
            const sid = currentSessionId();
            if (!sid) return false;
            const scope = ctx.sessions.scope(sid);
            if (scope === undefined) return false;
            const session = ctx.sessions.sessionOf(scope);
            if (session === undefined) return false;
            Promise.resolve(session.prompt([{ type: "text", text: String(text) }], annoPromptMode())).catch(function () { /* core surfaces errors */ });
            return true;
          } catch (err) { return false; }
        };
      } catch (err) { /* noop */ }

      function currentSessionId() {
        // 0.1.69: dsh ≥0.1.6 stopped publishing `.current` (the session is the
        // one retained by mainView), so the old one-liner returned "" and plan
        // files were named plan-session-<timestamp>. Three tiers, and the tier
        // is reported in the log (`sid_src=`) so a bad name is self-explaining.
        try {
          const id = currentSessionOf(ctx.sessions.list.getSnapshot());
          if (id) { window.__dshrSidSrc = "store"; return String(id); }
        } catch (err) { /* next tier */ }
        try {
          if (window.__dshrSessionId) { window.__dshrSidSrc = "insert"; return String(window.__dshrSessionId); }
        } catch (err) { /* next tier */ }
        try {
          const m = /\/(session|s)\/([A-Za-z0-9_-]{6,})/.exec(String(location.pathname || ""));
          if (m && m[2]) { window.__dshrSidSrc = "route"; return m[2]; }
        } catch (err) { /* next tier */ }
        try { window.__dshrSidSrc = "none"; } catch (err) { /* noop */ }
        return "";
      }

      // Plan cards (0.2.1): submitted / pending plans are `dsh-resource://`
      // virtual documents opened in the RIGHT sidebar, which in a narrow VS
      // Code aux bar is barely readable. 0.1.67 intercepts the click and hands
      // the same markdown to VS Code as a real file (extension writes
      // ~/.dsh/review/plans/… and opens it focused).
      // Text sources, in order: the React payload dsh builds in submittedPlan
      // ({callId, markdown, title}), the client resource store, the open
      // preview DOM. If all three miss, the click is left to dsh untouched.
      function planSurface(el) {
        try {
          if (!el || !el.closest) return null;
          const card = el.closest("[data-plan-card]");
          if (card) return { kind: "card", node: card, callId: String(card.getAttribute("data-plan-card") || "") };
          let node = el;
          for (let i = 0; i < 6 && node && node !== document.body; i++) {
            if (node.nodeType === 1 && node.classList) {
              for (let j = 0; j < node.classList.length; j++) {
                const t = node.classList[j];
                // CSS-module tokens come in both namings: "_reviewLink_<hash>"
                // and "<hash>_reviewLink" (dsh-client-ui-plan PlanPreview).
                if (t.indexOf("_reviewLink_") === 0 || (t.length > 11 && t.endsWith("_reviewLink"))) {
                  return { kind: "review", node: node, callId: "" };
                }
              }
            }
            node = node.parentElement;
          }
        } catch (err) { /* not a plan surface */ }
        return null;
      }

      function planFromContainer(v) {
        // The two shapes dsh uses for plan text, normalized to one record:
        // {callId, markdown, title} (submittedPlan) and {plan: "<markdown>"}
        // (pending review — ui-plan passes params.planReview.markdown =
        // review.plan, dsh-client-ui-plan/lib/client.js:683-686).
        if (!v || typeof v !== "object") return null;
        if (typeof v.markdown === "string" && v.markdown.length > 40) return v;
        if (typeof v.plan === "string" && v.plan.length > 40) {
          const m = /^#\s+(\S[^\r\n]*)/.exec(v.plan.trim());
          return {
            markdown: v.plan,
            callId: typeof v.callId === "string" ? v.callId : "",
            requestKey: typeof v.requestKey === "string" ? v.requestKey : "",
            title: m ? m[1] : "",
          };
        }
        return null;
      }

      function planRecordOf(value, depth) {
        // Shallow + sampled so a click never walks the whole React tree.
        // Missing the string shape is exactly what made 0.1.68 fall through to
        // the rendered innerText of a pending plan (mangled tables).
        if (!value || typeof value !== "object" || depth > 3) return null;
        const direct = planFromContainer(value);
        if (direct) return direct;
        // One level into the wrappers dsh actually passes: props.review (the
        // pending card) and the chat view-node payload fields (submitted card).
        const wrappers = [value.review, value.state, value.data];
        for (let i = 0; i < wrappers.length; i++) {
          const hit = planFromContainer(wrappers[i]);
          if (hit) return hit;
        }
        if (Array.isArray(value)) {
          for (let i = 0; i < value.length && i < 12; i++) {
            const hit = planRecordOf(value[i], depth + 1);
            if (hit) return hit;
          }
          return null;
        }
        if (value.props && typeof value.props === "object") {
          const hit = planRecordOf(value.props, depth + 1);
          if (hit) return hit;
        }
        return null;
      }

      function planRecordFromFiber(node) {
        try {
          const keys = node && Object.keys(node) ? Object.keys(node) : [];
          let fk = null;
          for (let i = 0; i < keys.length; i++) {
            if (keys[i].indexOf("__reactFiber$") === 0) { fk = keys[i]; break; }
          }
          let fiber = fk ? node[fk] : null;
          // A pending review has no callId — dsh identifies it by requestKey
          // (`review:<requestKey>`, PlanReviewOpen:108), so collect it while
          // walking; the resource fallback needs it to build the address.
          let requestKey = "";
          for (let hops = 0; fiber && hops < 40; hops++) {
            const props = fiber.memoizedProps;
            if (!requestKey && props && typeof props.requestKey === "string") requestKey = props.requestKey;
            const hitProps = planRecordOf(props, 0);
            if (hitProps) {
              if (requestKey && !hitProps.requestKey) { try { hitProps.requestKey = requestKey; } catch (err) { /* frozen */ } }
              return hitProps;
            }
            let state = fiber.memoizedState;
            for (let h = 0; state && h < 30; h++) {
              const sv = state.memoizedState !== undefined ? state.memoizedState : state;
              if (!requestKey && sv && typeof sv === "object" && typeof sv.requestKey === "string") requestKey = sv.requestKey;
              const hit = planRecordOf(sv, 0);
              if (hit) {
                if (requestKey && !hit.requestKey) { try { hit.requestKey = requestKey; } catch (err) { /* frozen */ } }
                return hit;
              }
              state = state.next;
            }
            fiber = fiber.return;
          }
        } catch (err) { /* fiber shape changed */ }
        return null;
      }

      function planTextFromSource(address) {
        // `ctx.resources.source(addr)` returns a snapshot-store SOURCE, not the
        // content (dsh-client-resources/lib/client.js:66-100); the snapshot is
        // {status:"loading"|"none"|"live"|"failed", value} (same file, consume
        // at 145-154) and only `live` carries the plan. Subscribing would pin
        // the record and turn the click async, which the fiber tier makes
        // unnecessary — read the snapshot if something already loaded it.
        try {
          const res = ctx && ctx.resources;
          if (!res || typeof res.source !== "function") return "";
          const src = res.source(address);
          if (!src) return "";
          if (typeof src.getSnapshot !== "function") {
            if (typeof src === "string") return src;
            if (typeof src.markdown === "string") return src.markdown;
            return typeof src.text === "string" ? src.text : "";
          }
          const snap = src.getSnapshot();
          if (!snap || snap.status !== "live") return "";
          const v = snap.value;
          if (!v) return "";
          if (typeof v === "string") return v;
          if (typeof v.markdown === "string") return v.markdown;
          if (typeof v.plan === "string") return v.plan;
          return "";
        } catch (err) { return ""; }
      }

      function planTextFromPreviewDom() {
        try {
          const nodes = document.querySelectorAll("[class]");
          for (let i = 0; i < nodes.length; i++) {
            const cls = String(nodes[i].className || "");
            const isDoc = cls.indexOf("_document_") >= 0 || /(^|\s)_document\b/.test(cls) || cls.split(/\s+/).some((t) => t.endsWith("_document"));
            if (!isDoc) continue;
            const txt = String(nodes[i].innerText || "").trim();
            if (txt.length > 40) return txt;
          }
        } catch (err) { /* noop */ }
        return "";
      }

      let chipProbeLogged = false
      function chipAbsPath(btn, want) {
        // 0.1.70: user-message attachment chips label with the BASENAME only;
        // the absolute path survives in the chip's React props (or an <img>
        // src for image previews). Without this, the extension receives a bare
        // name and its workspace-scoped findFiles misses files outside the
        // workspace (e.g. /tmp/RustDesk-1000/cliprdr-server/*.png screenshots).
        try {
          const img = btn.querySelector && btn.querySelector("img[src]")
          if (img) {
            let s = String(img.getAttribute("src") || "").split("#")[0].split("?")[0]
            if (s.indexOf("file://") === 0) s = s.slice(7)
            try { s = decodeURIComponent(s) } catch (err) { /* keep raw */ }
            if (s.charAt(0) === "/" && s.slice(s.lastIndexOf("/") + 1) === want) return s
          }
          const keys = Object.keys(btn)
          let fk = null
          for (let i = 0; i < keys.length; i++) {
            if (keys[i].indexOf("__reactFiber$") === 0) { fk = keys[i]; break }
          }
          let fiber = fk ? btn[fk] : null
          for (let hops = 0; fiber && hops < 24; hops++) {
            const props = fiber.memoizedProps
            if (props && typeof props === "object") {
              const names = Object.keys(props)
              if (!chipProbeLogged) {
                chipProbeLogged = true
                try {
                  const dbg = names.filter(function (n) { return typeof props[n] === "string" })
                    .slice(0, 8).map(function (n) { return n + "=" + String(props[n]).slice(0, 90) }).join(" ")
                  postScopeMessage("dshPasteLog", { line: "[chip] props " + (dbg || "(no string props)") })
                } catch (err) { /* noop */ }
              }
              for (let i = 0; i < names.length; i++) {
                const v = props[names[i]]
                if (typeof v === "string" && v.charAt(0) === "/" &&
                  v.slice(v.lastIndexOf("/") + 1) === want) return v
              }
            }
            fiber = fiber.return
          }
        } catch (err) { /* fiber shape changed */ }
        return null
      }
      function fileOpenTargetPath(btn) {
        const title = btn.getAttribute && btn.getAttribute("title");
        if (typeof title === "string" && title.charAt(0) === "/") return title;
        if (btn.classList) {
          for (let j = 0; j < btn.classList.length; j++) {
            // CSS-module token for the tool-row link appears in BOTH naming
            // schemes across dsh packages ("_fileLink_<hash>" leading-name,
            // and "<hash>_fileLink" leading-hash) — match either.
            const t = btn.classList[j];
            if (t.indexOf("_fileLink_") === 0 || (t.length > 9 && t.endsWith("_fileLink"))) {
              const txt = (btn.textContent || "").trim();
              if (txt) return txt;
            }
          }
        }
        // "Edited N files" summary-card rows (0.1.64): the label is a bare
        // basename with an extension — no title, no fileLink class. Accept a
        // single-line full-text basename match only, so prose buttons
        // ("全部接受", "Skip", "Next") never fire. Row text may carry the
        // "+7 −0" diff stats inside the same button — strip a trailing stat
        // group before testing.
        const full = (btn.textContent || "").trim();
        if (full.length > 1 && full.length <= 120 && full.indexOf("\n") < 0) {
          const cand = full.replace(/[+−+-]\d+\s*[−+-]\s*\d+\s*$/, "").trim();
          // 0.1.66: card rows may label files with a WORKSPACE-RELATIVE path
          // ("dsh-review/client.js"), not just a bare basename — the extension
          // resolves relative paths against the session cwd /
          // workspace roots. So only reject backslashes and glob junk.
          if (cand.length > 1 && cand.indexOf("\\") < 0 && cand.indexOf("*") < 0 &&
            cand.indexOf("?") < 0 && cand.indexOf("<") < 0 && cand.indexOf(">") < 0 &&
            cand.indexOf("|") < 0 && cand.charAt(0) !== "/" &&
            /\.[A-Za-z][A-Za-z0-9]{0,7}$/.test(cand)) {
            // 0.1.70: bare-basename labels (user-message chips) lost their
            // directory — recover the absolute path from the chip's own data.
            if (cand.indexOf("/") < 0) {
              const abs = chipAbsPath(btn, cand)
              if (abs) return abs
            }
            return cand;
          }
        }
        // Collapsed single-file card (0.1.65): title "Edited CHANGELOG.md" plus
        // a "Preview in sidebar" subtitle; spans concatenate inside textContent
        // ("Edited CHANGELOG.mdPreview in sidebar"). Take the basename out of
        // the "Edited <name.ext>" prefix.
        if (full.length > 1 && full.length <= 160 && full.indexOf("\n") < 0) {
          const m = full.match(/^Edited\s+([^/\\\n]+?\.[A-Za-z][A-Za-z0-9]{0,7})/);
          if (m && m[1]) {
            const name = m[1].trim();
            if (name.indexOf("*") < 0 && name.indexOf("?") < 0 && name.indexOf("<") < 0 &&
              name.indexOf(">") < 0 && name.indexOf("|") < 0) {
              if (name.indexOf("/") < 0) {
                const abs = chipAbsPath(btn, name)
                if (abs) return abs
              }
              return name;
            }
          }
        }
        return null;
      }
      function fileOpenInstall() {
        if (fileOpenListener) return;
        fileOpenListener = function (e) {
          try {
            if (!(inVscodeIframe() || bridgeActive || vscodeIframeHint())) return;
            if (!reviewSettingsReady() || !getReviewSettings().openFilesInVscode) return;
            // 0.1.67: plan cards → write the plan markdown to a real file and
            // open it in the VS Code editor (dsh's own right-sidebar preview is
            // unreadable in a narrow aux bar).
            const planHit = planSurface(e.target);
            if (planHit) {
              const rec = planRecordFromFiber(planHit.node);
              const sid = currentSessionId();
              const callId = (rec && rec.callId) || planHit.callId || "";
              const rk = (rec && rec.requestKey) || "";
              let text = rec && typeof rec.markdown === "string" ? rec.markdown : "";
              let tier = text ? "fiber" : "";
              if (!text && sid) {
                if (rk) {
                  text = planTextFromSource("dsh-resource://plan-review/" + encodeURIComponent(sid) + "/" + encodeURIComponent(rk));
                  if (text) tier = "resource";
                }
                if (!text && callId) {
                  text = planTextFromSource("dsh-resource://plan/" + encodeURIComponent(sid) + "/" + encodeURIComponent(callId));
                  if (text) tier = "resource";
                }
              }
              if (!text) { text = planTextFromPreviewDom(); if (text) tier = "dom"; }
              // The rendered-text tier loses markdown syntax; say so in the file
              // instead of quietly passing mangled prose off as the plan.
              if (tier === "dom") text = "> ⚠ 正文取自渲染文本，未能读取原始 markdown，排版可能与源文有出入。\n\n" + text;
              if (!text) {
                // Nothing readable yet: leave the click to dsh so its own
                // preview still opens instead of the click doing nothing.
                postScopeMessage("dshPasteLog", { line: "[plan] tier=none kind=" + planHit.kind + " -> native preview" });
                return;
              }
              e.preventDefault();
              try { e.stopImmediatePropagation(); } catch (err) { e.stopPropagation(); }
              postScopeMessage("dshPasteLog", { line: "[plan] kind=" + planHit.kind + " tier=" + tier + " chars=" + text.length + " callId=" + callId + " rk=" + rk + " sid=" + sid + " sid_src=" + String(window.__dshrSidSrc || "?") });
              postScopeMessage("dshOpenPlan", {
                markdown: text,
                title: (rec && rec.title) || "",
                callId: callId,
                requestKey: rk,
                sessionId: sid,
                cwd: currentSessionCwd(),
              });
              return;
            }
            const btn = e.target && e.target.closest ? e.target.closest('button, a, [role="button"]') : null;
            let raw = btn ? fileOpenTargetPath(btn) : null;
            // Cards/rows are not always real buttons (the collapsed "Edited X"
            // card is a plain div) — walk up to 6 ancestors and test each
            // (0.1.65). The text-based matchers stay strict, so only
            // file-card surfaces hit.
            if (!raw) {
              let node = e.target;
              for (let i = 0; i < 6 && node && node !== document.body; i++) {
                if (node.nodeType === 1) {
                  raw = fileOpenTargetPath(node);
                  if (raw) break;
                }
                node = node.parentElement;
              }
            }
            if (!raw) return;
            const inInsertGuard = Date.now() < (window.__dshrRefGuardUntil || 0);
            e.preventDefault();
            // dsh's own click handlers sit on document too (capture, registered
            // after ours). stopPropagation does NOT stop same-node listeners —
            // the native preview still opened and hid itself via the width
            // check. stopImmediatePropagation kills them: this click is
            // ours now.
            try { e.stopImmediatePropagation(); } catch (err) { e.stopPropagation(); }
            if (inInsertGuard) {
              // 0.1.67: right after we insert refs ourselves, the click that
              // places the caret lands on the fresh chip. Opening the file moved
              // VS Code focus into the editor, so every following keystroke
              // typed into the FILE instead of the composer. Swallow the click
              // (no VS Code open, no dsh preview) and hand focus back.
              postScopeMessage("dshPasteLog", { line: "[openfile] suppressed (insert-guard) raw=" + raw });
              try { if (window.__dshrFocusComposer) window.__dshrFocusComposer(); } catch (err) { /* noop */ }
              return;
            }
            postScopeMessage("dshPasteLog", { line: "fileOpen raw=" + raw + (e.altKey ? " (focusEditor)" : "") });
            // Alt/Option-click = pre-0.1.24 behaviour (open AND focus the file).
            // A plain click keeps focus in the composer so typing continues in
            // the draft; the file opens in the background.
            postScopeMessage("dshOpenFile", { path: raw, cwd: currentSessionCwd(), keepFocus: !e.altKey });
          } catch (err) { /* noop */ }
        };
        try { document.addEventListener("click", fileOpenListener, true); } catch (err) { fileOpenListener = null; }
      }
      function fileOpenTeardown() {
        if (fileOpenListener) {
          try { document.removeEventListener("click", fileOpenListener, true); } catch (err) { /* noop */ }
          fileOpenListener = null;
        }
      }

      // ---- Finder file-paste into the VS Code webview (0.1.63) --------
      // Finder Cmd+C on a file puts only a FILE PROMISE on the clipboard
      // (no pixels — that is why the pasted chip is empty). Browsers
      // materialize the promise into a real File; the VS Code webview clipboard
      // bridge hands us a size-0 placeholder, so dsh's native rail gets no
      // bytes. When a Files paste carries no bytes at all, swallow it and ask
      // the extension host, which reads the real paths out of the macOS
      // clipboard (NSFilenamesPboardType) and inserts them through the normal
      // "send to dsh" native reference channel (dshInsertRefs). Screenshots
      // and "copy image" carry real bytes (size > 0) and stay untouched.
      let pasteGuardListener = null;
      function pasteGuardInstall() {
        if (pasteGuardListener) return;
        pasteGuardListener = function (e) {
          try {
            if (!(inVscodeIframe() || bridgeActive || vscodeIframeHint())) return;
            const dt = e.clipboardData;
            if (!dt) return;
            const files = dt.files ? Array.prototype.slice.call(dt.files) : [];
            if (!files.length) return;
            const parts = [];
            let allEmpty = true;
            for (let i = 0; i < files.length; i++) {
              const f = files[i];
              const size = (f && f.size) || 0;
              if (size > 0) allEmpty = false;
              parts.push(((f && f.name) || "?") + ":" + size);
            }
            postScopeMessage("dshPasteLog", { line: "files[" + parts.join(", ") + "]" + (allEmpty ? " placeholder" : "") });
            if (!allEmpty) return;
            e.preventDefault();
            e.stopPropagation();
            postScopeMessage("dshPasteFileRef", {
              names: files.map(function (f) { return (f && f.name) || ""; }),
            });
          } catch (err) { /* noop */ }
        };
        try { document.addEventListener("paste", pasteGuardListener, true); } catch (err) { pasteGuardListener = null; }
      }
      function pasteGuardTeardown() {
        if (pasteGuardListener) {
          try { document.removeEventListener("paste", pasteGuardListener, true); } catch (err) { /* noop */ }
          pasteGuardListener = null;
        }
      }

      scopeWatchdogTick = checkWorkbenchScope;
      const wsFilterScopeHook = function () { try { wsFilterInstall(); } catch (err) { /* noop */ } };
      scopeChangeListeners.push(wsFilterScopeHook);
      ctx.effect(function () {
        // Always-on whitelist listener (must not depend on Dock mount).
        try { menuPatchInstall(); } catch (err) { /* noop */ }
        try { fileOpenInstall(); } catch (err) { /* noop */ }
        try { pasteGuardInstall(); } catch (err) { /* noop */ }
        function onScopeFromHost(event) {
          const msg = event.data;
          if (!msg || msg.type !== "dshSetScope") return;
          // 0.1.83: the removal instruction rides on the scope answer — the one
          // extension -> client message that demonstrably arrives (the sidebar workspace
          // list is fed by it), whereas dshRemoveReference never reached this page.
          if (Array.isArray(msg.removeChips) && msg.removeChips.length) {
            msg.removeChips.forEach(function (nm) {
              let ok = false;
              try { ok = !!(window.__dshrRemoveChip && window.__dshrRemoveChip(nm)); } catch (err) { ok = false; }
              let watch = [];
              try { watch = (window.__dshrTracked && window.__dshrTracked()) || []; } catch (err) { watch = []; }
              try { window.parent.postMessage({ type: "dshScopeRequest", build: "0.2.0", watching: watch.slice(0, 3), report: "捎带删方块: " + nm + " -> " + (ok ? "已删" : "没找到方块节点") }, "*"); } catch (err) { /* noop */ }
            });
          }
          if (msg.focusComposer) {
            try { if (window.__dshrFocusComposer) window.__dshrFocusComposer(); } catch (err) { /* noop */ }
          }
          setVscodeScope(msg.paths, msg.rawPaths);
        }
        window.addEventListener("message", onScopeFromHost);
        try { window.parent.postMessage({ type: "dshScopeRequest", build: "0.2.0", watching: Array.from(trackedRefs.keys()).slice(0, 3) }, "*"); } catch (err) { /* noop */ }
        // 0.1.98: no scope polling — the extension pushes dshSetScope on every workspace change,
        // and the initial dshScopeRequest above covers startup hydration.
        const timer = null;
        return function () {
          try { if (timer) clearInterval(timer); } catch (err) { /* noop */ }
          window.removeEventListener("message", onScopeFromHost);
          if (scopeWatchdogTick === checkWorkbenchScope) scopeWatchdogTick = null;
          const hookAt = scopeChangeListeners.indexOf(wsFilterScopeHook);
          if (hookAt >= 0) scopeChangeListeners.splice(hookAt, 1);
          try { if (menuPatchObserver) { menuPatchObserver.disconnect(); menuPatchObserver = null; } } catch (err) { /* noop */ }
          fileOpenTeardown();
          pasteGuardTeardown();
          wsFilterTeardown();
        };
      }, "dsh-review: workbench scope watchdog");

    // Annotation dock chips (0.2.3): the row ABOVE the composer input — the
    // dsh side of "Copilot has two: a chip above the input and an @ref line
    // inside it". Native slot conversation.input.dock, same mechanism as
    // dsh-annotate. Pure mirror of the Copilot attachment strip: state arrives
    // via dshAnnoDock (extension, from the Copilot observer beacon); ✕ posts
    // dshAnnoDelete and the extension performs the REAL CDP click on the
    // Copilot chip (only that removes the native pin + renumbers).
    // Also the consume detector: our vscode-ref chips leave the input (send or
    // manual clear) and the draft is empty -> dshAnnoConsumed -> the extension
    // real-clicks every remaining Copilot chip away.
    function AnnoDockChips(props) {
      const [, force] = useState(0);
      useEffect(function () {
        return subscribeAnnoDock(function () { force(function (n) { return n + 1; }); });
      }, []);
      const inputSnapshot = props && props.useInput ? props.useInput(function (s) { return s; }) : null;
      // (0.2.4) The old "draft non-empty -> empty" consume trigger is removed:
      // it also fired on a manual clear (Cmd+A + delete), which flashed Copilot
      // by mistake. Consume now fires ONLY on a real send — see the global
      // markAnnoSend() send-detection above (Enter in composer / send button).
      const chips = annoDockChips;
      // (0.2.5) Toggle off = feature does not exist: no dock chips either.
      if (!getReviewSettings().annotationToDsh) return null;
      if (chips.length === 0) return null;
      // (0.2.9) USER RULING: no chip strip above the dsh composer. The dock
      // data (annoDockChips) stays — it is the ③ interception gate — but the
      // UI is not rendered: dsh send -> Copilot capture -> appended paths ->
      // agent, invisibly.
      return null;
      // eslint-disable-next-line no-unreachable
      return h("div", {
        style: {
          display: "flex", alignItems: "center", gap: "6px", flexWrap: "wrap",
          width: "100%", boxSizing: "border-box",
          maxWidth: "calc(var(--dsh-composer-card-max-width, 800px) - var(--dsh-composer-dock-inset, 0px) * 4)",
          margin: "0 auto 4px", padding: "0 2px",
        }
      }, chips.map(function (c) {
        return h("span", {
          key: c.key || (c.name + "|" + c.text),
          title: c.text ? c.name + " — " + c.text : c.name,
          style: {
            display: "inline-flex", alignItems: "center", gap: "6px",
            maxWidth: "340px", height: "26px", padding: "0 8px",
            borderRadius: "999px",
            border: "1px solid color-mix(in srgb, CanvasText 20%, transparent)",
            background: "color-mix(in srgb, CanvasText 8%, Canvas)",
            color: "CanvasText", fontSize: "12px", lineHeight: "1",
          }
        },
          h("span", { style: { opacity: 0.6, fontSize: "13px" } }, "\u{1F4F7}"),
          h("span", { style: { fontWeight: 500, whiteSpace: "nowrap" } }, c.name),
          c.text ? h("span", { style: { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", opacity: 0.75 } }, c.text) : null,
          h("button", {
            type: "button",
            "aria-label": "Delete annotation " + c.name,
            onClick: function (e) {
              e.preventDefault();
              e.stopPropagation();
              try { window.parent.postMessage({ type: "dshAnnoDelete", name: c.name, key: c.key }, "*"); } catch (err) { /* noop */ }
            },
            style: { border: "0", background: "transparent", color: "inherit", opacity: 0.55, cursor: "pointer", fontSize: "11px", padding: "0", lineHeight: "1" }
          }, "\u2715")
        );
      }));
    }

      ctx.inject(["slots", "conversation", "inputTriggers"], function (scope) {
        try {
          const conversation = scope.conversation;
          if (conversation && conversation.input && typeof conversation.input.shell === "function") {
            inputHub = conversation.input;
            conversationApi = conversation;
            // (2.1.1) wrap the single composer submit funnel (see annoSendGate).
            try {
              if (conversationApi && typeof conversationApi.sendSession === "function" && !conversationApi.__dshrSendWrapped) {
                const origSendSession = conversationApi.sendSession.bind(conversationApi);
                conversationApi.sendSession = function (session, text, attachmentIds, mode, signal) {
                  return annoSendGate(origSendSession, session, text, attachmentIds, mode, signal);
                };
                conversationApi.__dshrSendWrapped = true;
                try { window.__dshrSendWrapped = true; } catch (err) { /* noop */ }
                try { window.parent.postMessage({ type: "dshPasteLog", line: "[send] sendSession gate installed (client 2.1.1)" }, "*"); } catch (err) { /* noop */ }
              if (!window.__dshrStatClick) {
                window.__dshrStatClick = true;
                document.addEventListener("click", annoWatchContextPopover, true);
              }
              }
            } catch (err) {
              try { window.parent.postMessage({ type: "dshPasteLog", line: "[send] gate install failed: " + String(err).slice(0, 90) }, "*"); } catch (e2) { /* noop */ }
            }
          } else {
            console.warn("[dsh-review] native chip pipeline unavailable (no conversation.input.shell); refs will fall back to text");
          }
        } catch (err) {
          console.warn("[dsh-review] native chip pipeline failed:", err && err.message || err);
        }
        scope.effect(function () {
          let unregisterRefSource = function () { };
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
            } else {
              console.warn("[dsh-review] inputTriggers unavailable; chip send-serialization will not work");
            }
          } catch (err) {
            console.warn("[dsh-review] vscode-ref source registration failed:", err && err.message || err);
          }
          // Dock slot is always registered (bridge/chips need a mount). The
          // panel itself renders only when inVSCodeIframe && workbenchMatch.
          const unregisterDock = scope.slots.register({
            name: "conversation.input.dock",
            id: "dsh-review",
            order: 5,
          }, ReviewChangesDock);
          // Annotation chip row: its own seat in the same dock slot (order 4 =
          // above the Review Changes panel, matching Copilot's strip position).
          // Always mounted (returns null when empty) so the consume detector
          // stays live even with no annotations waiting.
          const unregisterAnnoDock = scope.slots.register({
            name: "conversation.input.dock",
            id: "dsh-review-anno",
            order: 4,
          }, AnnoDockChips);
          return function () {
            unregisterAnnoDock();
            unregisterDock();
            unregisterRefSource();
            refSourceRegistered = false;
          };
        }, "dsh-review: dock + vscode-ref source");
      });
    }


    exports.apply = apply;
    exports.inject = ["slots", "workspaces", "sessions", "uiWorkspace", "remote", "locale", "uiConversation"];
    return module.exports;
  }
});
