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

    // VSCode workbench scope (reverse watchdog + dock gate).
    // Extension sends realpath + raw fsPath of every folder in THIS window.
    // Match is STRICT equality only (no parent/child widening).
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

    function scopePathAllowed(path) {
      const want = normalizeScopePath(path);
      if (!want) return false;
      for (const p of vscodeScopePaths) if (normalizeScopePath(p) === want) return true;
      for (const p of vscodeScopeRawPaths) if (normalizeScopePath(p) === want) return true;
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
      try { console.log("[dsh-scope]", payload.action, payload); } catch (err) { /* noop */ }
      postScopeMessage("dshScopeDiag", payload);
    }

    // VS Code iframe chrome:
    // 1) keep the native 56px rail (no edge-hide); a tab expands/collapses it.
    // 2) hide conversation header; a top-right tab toggles it back.
    // 3) dock the rail left or right.
    const IFRAME_SIDEBAR_STYLE_ID = "dsh-review-iframe-sidebar";
    const IFRAME_HEADER_BTN_ID = "dsh-review-header-toggle";
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
      let railSide = "left";
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
     * Expand or collapse the conversation header (iframe only).
     * @param {boolean} on
     */
    function setIframeHeaderOpen(on) {
      try { document.documentElement.classList.toggle("dsh-header-open", !!on); } catch (err) { /* noop */ }
      const btn = document.getElementById(IFRAME_HEADER_BTN_ID);
      if (!btn) return;
      const label = on ? "收起顶栏" : "展开顶栏";
      btn.setAttribute("aria-expanded", on ? "true" : "false");
      btn.setAttribute("aria-label", label);
      btn.title = label;
      btn.classList.toggle("is-open", !!on);
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
     * Hide or show the native 56px icon rail. Uses our CSS, not dsh attributes
     * (React immediately restores data-sidebar-collapsed).
     * @param {boolean} hidden
     */
    function setIframeRailHidden(hidden) {
      try { document.documentElement.classList.toggle("dsh-rail-hidden", !!hidden); } catch (err) { /* noop */ }
      persistIframeChrome({ railHidden: !!hidden });
      const btn = document.getElementById(IFRAME_RAIL_EXPAND_BTN_ID);
      if (!btn) return;
      const label = hidden ? "显示侧栏" : "隐藏侧栏";
      btn.setAttribute("aria-expanded", hidden ? "false" : "true");
      btn.setAttribute("aria-label", label);
      btn.title = label;
      btn.classList.toggle("is-open", !hidden);
    }

    /**
     * Inject header/side/expand toggles. No-op outside the iframe.
     */
    function installIframeSidebarPeek() {
      if (typeof document === "undefined") return;
      if (!bridgeActive && !vscodeIframeHint()) return;
      try { document.documentElement.classList.add("dsh-vscode-iframe"); } catch (err) { /* noop */ }
      const css = [
        // Hide the 56px rail without fighting dsh React state.
        // Newer dsh marks the frame grid data-sidebar-collapsed; older builds
        // used data-details-collapsed, so match either.
        "html.dsh-vscode-iframe.dsh-rail-hidden [data-sidebar-collapsed], html.dsh-vscode-iframe.dsh-rail-hidden [data-details-collapsed] {",
        "  grid-template-columns: 0px minmax(0, 1fr) 0px !important;",
        "}",
        // Right dock: RTL flips the first (sidebar) track to the right edge.
        "html.dsh-vscode-iframe.dsh-rail-right [data-sidebar-collapsed], html.dsh-vscode-iframe.dsh-rail-right [data-details-collapsed] {",
        "  direction: rtl;",
        "}",
        "html.dsh-vscode-iframe.dsh-rail-right [data-sidebar-collapsed] > *, html.dsh-vscode-iframe.dsh-rail-right [data-details-collapsed] > * {",
        "  direction: ltr;",
        "}",
        "html.dsh-vscode-iframe:not(.dsh-header-open) [data-slot=\"conversation.session.header\"],",
        "html.dsh-vscode-iframe:not(.dsh-header-open) [data-slot=\"conversation.session.header\"] header {",
        "  display: none !important;",
        "}",
        "html.dsh-vscode-iframe.dsh-header-open [data-slot=\"conversation.session.header\"] {",
        "  display: contents !important;",
        "}",
        "#dsh-review-header-toggle, #dsh-review-rail-side, #dsh-review-rail-expand { display: none; }",
        "html.dsh-vscode-iframe #dsh-review-header-toggle,",
        "html.dsh-vscode-iframe #dsh-review-rail-side,",
        "html.dsh-vscode-iframe #dsh-review-rail-expand {",
        "  display: flex; align-items: center; justify-content: center;",
        "  position: fixed; top: 0; z-index: 80;",
        "  width: 28px; height: 14px; padding: 0; margin: 0;",
        "  border: 0; border-radius: 0 0 8px 8px;",
        "  background: color-mix(in srgb, var(--dsw-alias-bg-base, #1e1e1e) 88%, #000);",
        "  color: var(--dsw-alias-label-tertiary, #9a9a9a);",
        "  box-shadow: 0 1px 4px rgba(0,0,0,0.35);",
        "  cursor: pointer; opacity: 0.72;",
        "}",
        "html.dsh-vscode-iframe #dsh-review-header-toggle { right: 10px; }",
        "html.dsh-vscode-iframe #dsh-review-rail-side { right: 42px; }",
        "html.dsh-vscode-iframe #dsh-review-rail-expand { right: 74px; }",
        "html.dsh-vscode-iframe #dsh-review-header-toggle:hover,",
        "html.dsh-vscode-iframe #dsh-review-rail-side:hover,",
        "html.dsh-vscode-iframe #dsh-review-rail-expand:hover { opacity: 1; }",
        "html.dsh-vscode-iframe #dsh-review-header-toggle svg,",
        "html.dsh-vscode-iframe #dsh-review-rail-side svg,",
        "html.dsh-vscode-iframe #dsh-review-rail-expand svg {",
        "  width: 12px; height: 12px; display: block;",
        "  transition: transform 0.15s ease;",
        "}",
        "html.dsh-vscode-iframe #dsh-review-header-toggle.is-open svg { transform: rotate(180deg); }",
        "html.dsh-vscode-iframe #dsh-review-rail-side.is-right svg { transform: scaleX(-1); }",
        "html.dsh-vscode-iframe #dsh-review-rail-expand.is-open svg { transform: rotate(180deg); }",
      ].join("\n");
      let tag = document.getElementById(IFRAME_SIDEBAR_STYLE_ID);
      if (!tag) {
        tag = document.createElement("style");
        tag.id = IFRAME_SIDEBAR_STYLE_ID;
        try { document.head.appendChild(tag); } catch (err) { /* noop */ }
      }
      tag.textContent = css;
      const oldHit = document.getElementById("dsh-my-plugin-rail-hit");
      if (oldHit && oldHit.parentNode) oldHit.parentNode.removeChild(oldHit);
      if (!document.getElementById(IFRAME_HEADER_BTN_ID)) {
        const btn = document.createElement("button");
        btn.id = IFRAME_HEADER_BTN_ID;
        btn.type = "button";
        btn.innerHTML = '<svg viewBox="0 0 12 12" aria-hidden="true"><path d="M2.5 4.2L6 7.8 9.5 4.2" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>';
        btn.addEventListener("click", function (event) {
          event.preventDefault();
          event.stopPropagation();
          const open = !document.documentElement.classList.contains("dsh-header-open");
          setIframeHeaderOpen(open);
        });
        try { document.body.appendChild(btn); } catch (err) { /* noop */ }
        setIframeHeaderOpen(false);
      }
      if (!document.getElementById(IFRAME_RAIL_SIDE_BTN_ID)) {
        const sideBtn = document.createElement("button");
        sideBtn.id = IFRAME_RAIL_SIDE_BTN_ID;
        sideBtn.type = "button";
        sideBtn.innerHTML = '<svg viewBox="0 0 12 12" aria-hidden="true"><path d="M4.2 2.5L7.8 6 4.2 9.5" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>';
        sideBtn.addEventListener("click", function (event) {
          event.preventDefault();
          event.stopPropagation();
          const next = document.documentElement.classList.contains("dsh-rail-right") ? "left" : "right";
          setIframeRailSide(next);
        });
        try { document.body.appendChild(sideBtn); } catch (err) { /* noop */ }
      }
      if (!document.getElementById(IFRAME_RAIL_EXPAND_BTN_ID)) {
        const expandBtn = document.createElement("button");
        expandBtn.id = IFRAME_RAIL_EXPAND_BTN_ID;
        expandBtn.type = "button";
        expandBtn.innerHTML = '<svg viewBox="0 0 12 12" aria-hidden="true"><rect x="1.5" y="2" width="9" height="8" rx="1" fill="none" stroke="currentColor" stroke-width="1.3"/><path d="M4.5 2v8" fill="none" stroke="currentColor" stroke-width="1.3"/></svg>';
        expandBtn.addEventListener("click", function (event) {
          event.preventDefault();
          event.stopPropagation();
          const hidden = !document.documentElement.classList.contains("dsh-rail-hidden");
          setIframeRailHidden(hidden);
        });
        try { document.body.appendChild(expandBtn); } catch (err) { /* noop */ }
      }
      const chrome = currentIframeChrome();
      setIframeRailSide(chrome.railSide);
      setIframeRailHidden(chrome.railHidden);
      compactNativeStatsLine();
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
     * @returns {{ enabled: boolean, fileSend: string, snippetSend: string }}
     * @description Live 设置 → 代码审查 values; defaults if the scope is not ready.
     */
    function getReviewSettings() {
      const d = { enabled: true, fileSend: "path", snippetSend: "fence" };
      if (!reviewSettingsScope || typeof reviewSettingsScope.getSnapshot !== "function") return d;
      const snap = reviewSettingsScope.getSnapshot();
      const v = snap && snap.value && typeof snap.value === "object" ? snap.value : {};
      return {
        enabled: v.enabled !== false,
        fileSend: v.fileSend === "prefixed" ? "prefixed" : "path",
        snippetSend: v.snippetSend === "pointer" ? "pointer" : "fence",
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
        const range = snippetRangeLabel(src);
        const pointer = quoted + (range ? " " + range : "");
        const base = filePath.split("/").pop() || filePath;
        const label = src.label || (base + (range ? " " + range : ""));
        const content = typeof src.content === "string" ? src.content : "";
        if (s.snippetSend === "fence" && content) {
          return Object.assign({}, src, {
            label: label,
            clipboardText: pointer,
            modelText: fenceSnippet(content),
          });
        }
        return Object.assign({}, src, {
          label: label,
          clipboardText: pointer,
          modelText: pointer,
        });
      }
      const prefix = kind === "folder" ? "目录: " : "文件: ";
      const modelText = s.fileSend === "prefixed" ? prefix + quoted : quoted;
      return Object.assign({}, src, {
        clipboardText: quoted,
        modelText: modelText,
      });
    }

    function mintRefs(refs) {
      return refs.map(function (r) {
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
              + '\n[data-composer-chip="' + REF_SOURCE + '"][data-dsh-review-kind="' + (e.kind || "file") + '"] > span{background:' + color + ' !important;}';
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
        const ours = occurrences.filter(function (o) { return o.source === REF_SOURCE; });
        const chips = document.querySelectorAll('[data-composer-chip="' + REF_SOURCE + '"]');
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

        function insertIncomingText(text, preferred) {
          if (!isEditable(preferred)) return false;
          return insertAtCaret(preferred, text);
        }

        /**
         * @returns {HTMLTextAreaElement | null}
         * @description Last focused composer, else the largest visible textarea.
         */
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
          return best;
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
        function focusComposer(caret) {
          const el = findComposerTextarea();
          if (!el) return false;
          lastComposer = el;
          try { el.focus(); } catch (err) { /* noop */ }
          if (el.tagName === "TEXTAREA" && Number.isFinite(caret) && caret >= 0) {
            try { el.setSelectionRange(caret, caret); } catch (err) { /* noop */ }
          }
          return true;
        }

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
            if (occurrences[i].source === REF_SOURCE && occurrences[i].ref === ref) return occurrences[i];
          }
          return null;
        }

        // Try the dsh native occurrence chip path; fall back to plain text.
        function insertRefsAtCaret(refs, fallbackText, preferred) {
          const list = (Array.isArray(refs) ? refs : []).map(formatRefForSend);
          const formattedFallback = list.map(function (r) { return r.modelText; }).filter(Boolean).join("\n") || fallbackText;
          if (!sessionId || !inputHub || !refSourceRegistered || list.length === 0) {
            if (formattedFallback) insertComposerText(formattedFallback);
            return {
              mode: "text",
              count: list.length,
              reason: !sessionId ? "no sessionId" : (!inputHub ? "no inputHub" : (!refSourceRegistered ? "no refSource" : "empty")),
            };
          }
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
              setTimeout(function () { focusComposer(caretAt); }, 0);
              setTimeout(function () { focusComposer(caretAt); }, 50);
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
            setTimeout(function () { focusComposer(caretAt); }, 0);
            setTimeout(function () { focusComposer(caretAt); }, 50);
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
          const value = zoom === 1 ? "" : String(zoom);
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
            try { window.parent.postMessage({ type: "dshScopeRequest" }, "*"); } catch (err) { /* noop */ }
            return;
          }
          if (msg.type === "dshChromeState") {
            if (msg.railSide === "left" || msg.railSide === "right") setIframeRailSide(msg.railSide);
            if (typeof msg.railHidden === "boolean") setIframeRailHidden(msg.railHidden);
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
          } else if (msg.type === "dshInsertRefs" && Array.isArray(msg.refs)) {
            const fallback = typeof msg.fallbackText === "string" ? msg.fallbackText : "";
            const result = insertRefsAtCaret(msg.refs, fallback, null);
            postToParent({
              type: "dshInsertResult",
              source: "selection",
              mode: result.mode,
              count: result.count,
              reason: result.reason || "",
            });
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
          if (!navigator.clipboard) return;
          clipboardBridged = true;
          function sendCopy(text) {
            const s = String(text ?? "");
            if (!s) return;
            postToParent({ type: "dshCopyText", text: s });
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
                editable.focus();
                try { document.execCommand("delete", false, null); } catch (err) { /* noop */ }
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
        h("div", {
          onClick: function () { setCollapsed(!collapsed); },
          style: {
            display: "flex", alignItems: "center", gap: "8px",
            padding: "6px 10px", cursor: "pointer", userSelect: "none",
            color: "var(--dsh-color-text, inherit)",
            borderBottom: collapsed || live.length === 0 ? "none" : "1px solid var(--dsh-color-border, #80808030)",
          }
        },
          h("span", { style: { fontSize: "11px", opacity: 0.6 } }, collapsed ? "\u25B6" : "\u25BC"),
          h("span", { style: { fontWeight: 600 } }, "Review Changes"),
          h("span", { style: { opacity: 0.7, marginLeft: "4px" } },
            live.length === 0 ? "无待审" : (live.length + " file" + (live.length > 1 ? "s" : ""))
          ),
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
              ? "var(--dsh-color-danger, #f85149)"
              : (isCreate
                ? "var(--dsh-color-success, #3fb950)"
                : "var(--dsh-color-accent, #50a0ff)");
            const nameDecor = isDelete ? "line-through" : "none";
            const nameColor = isDelete
              ? "var(--dsh-color-danger, #f85149)"
              : "var(--dsh-color-accent, #50a0ff)";
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
    function installReviewSettingsCard(ctx) {
      if (!ctx || typeof ctx.inject !== "function") return;
      ctx.inject(["settingsScope"], function (sctx) {
        if (!sctx.settingsScope || typeof sctx.settingsScope.bind !== "function") {
          console.warn("[dsh-review] settingsScope.bind missing; plugin card skipped");
          return;
        }
        const reviewScope = sctx.settingsScope.bind({ namespace: REVIEW_SETTINGS_NS });
        reviewSettingsScope = reviewScope;
        ensureReviewCardCss();
        sctx.effect(function () {
          return sctx.slots.register({
            name: "settings.plugin.item",
            key: REVIEW_SETTINGS_NS,
          }, function ReviewSettingsCard() {
            const snap = useSyncExternalStore(
              function (onStore) { return reviewScope.subscribe(onStore); },
              function () { return reviewScope.getSnapshot(); },
            );
            const [open, setOpen] = useState(false);
            const [draftEnabled, setDraftEnabled] = useState(null);
            const [draftFileSend, setDraftFileSend] = useState(null);
            const [draftSnippetSend, setDraftSnippetSend] = useState(null);
            const [saving, setSaving] = useState(false);
            const [failed, setFailed] = useState(false);
            const live = getReviewSettings();
            const liveEnabled = live.enabled;
            const liveFileSend = live.fileSend;
            const liveSnippetSend = live.snippetSend;
            const shownEnabled = draftEnabled == null ? liveEnabled : draftEnabled;
            const shownFileSend = draftFileSend == null ? liveFileSend : draftFileSend;
            const shownSnippetSend = draftSnippetSend == null ? liveSnippetSend : draftSnippetSend;
            const dirty = shownEnabled !== liveEnabled
              || shownFileSend !== liveFileSend
              || shownSnippetSend !== liveSnippetSend;
            const available = snap && snap.status === "ready";
            const writable = !!(snap && snap.writable);

            useEffect(function () {
              setDraftEnabled(null);
              setDraftFileSend(null);
              setDraftSnippetSend(null);
              setFailed(false);
            }, [liveEnabled, liveFileSend, liveSnippetSend]);

            if (!available) return null;

            function discardDraft() {
              setDraftEnabled(null);
              setDraftFileSend(null);
              setDraftSnippetSend(null);
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
              chain.then(
                function () { setSaving(false); discardDraft(); },
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
                  h("span", { className: "dshr-description" }, "待审、以及拖入文件 / 代码段时发给模型的格式。"),
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
          });
        }, "dsh-review: plugin settings card");
      });
    }

    function apply(ctx) {
      installIframeSidebarPeek();
      installReviewSettingsCard(ctx);
      // Reverse workbench watchdog:
      // 1) VS Code has no folder open → force dsh home (no session) forever.
      // 2) Matching whitelist workspace → open the latest real session once
      //    (any whitelist workbench). Later user-opened chats are left alone.
      // 3) No matching workspace → new blank session (when a dsh row exists).
      // 4) Current session workbench ∉ whitelist → pull back to latest / new.
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
        if (summary.origin === "subagent" || summary.parentId) return false;
        return true;
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
          sessions.open(sessionId);
          preferredLatestOpened[normalizeScopePath(matchPath || "")] = sessionId;
          return true;
        } catch (e) {
          landDone = false;
          console.warn("[dsh-review] open latest session failed:", e && e.message || e);
          return false;
        }
      }

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
        if (matches.length === 0) return false;
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
        if (!workspace.workspaceId || typeof workspaces.connectWorkspace !== "function") return false;
        const gen = ++connectGeneration;
        connectInFlight = true;
        workspaces.connectWorkspace(workspace.workspaceId).then(
          function (sessionId) {
            connectInFlight = false;
            if (gen !== connectGeneration) return;
            if (landDone) return;
            try { sessions.open(sessionId); } catch (e) {
              console.warn("[dsh-review] fresh session open failed:", e && e.message || e);
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

      function checkWorkbenchScope() {
        // Standalone browser: do not pin/clear workspaces. VS Code iframe only.
        if (!inVscodeIframe()) return;
        const workspaces = ctx.workspaces;
        const sessions = ctx.sessions;
        if (!workspaces || !sessions) { console.warn("[dsh-review] scope watchdog: workspaces/sessions unavailable"); return; }
        let wsnap, ssnap;
        try { wsnap = workspaces.list.getSnapshot(); } catch (e) { return; }
        try { ssnap = sessions.list.getSnapshot(); } catch (e) { return; }
        const current = ssnap && ssnap.current;
        const items = Array.isArray(wsnap.items) ? wsnap.items : [];
        const byId = (ssnap && ssnap.byId) || {};

        function goHome() {
          try {
            if (sessions && typeof sessions.clear === "function") sessions.clear();
          } catch (e) { console.warn("[dsh-review] scope home clear failed:", e && e.message || e); }
        }

        // Handshake has not arrived yet: do not treat empty paths as "no folder".
        if (!vscodeScopeReceived) return;

        // No VS Code workspace folder: stay on dsh home; re-clear if user opens any.
        if (!scopeIsActive()) {
          if (!current) return;
          if (connectInFlight) return;
          const nowEmpty = Date.now();
          // Short throttle — keep pullback snappy when user re-opens a workspace.
          if (vscodeScopePullingAt && nowEmpty - vscodeScopePullingAt < 2000) return;
          vscodeScopePullingAt = nowEmpty;
          postScopeMessage("dshScopeEmpty", {});
          goHome();
          return;
        }

        // Home / unknown current: whitelist match → latest chat; else new session.
        if (!current) {
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
          postScopeMessage("dshScopeMissing", { path: vscodeScopePaths[0] || vscodeScopeRawPaths[0] || "" });
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

      scopeWatchdogTick = checkWorkbenchScope;
      ctx.effect(function () {
        // Always-on whitelist listener (must not depend on Dock mount).
        function onScopeFromHost(event) {
          const msg = event.data;
          if (!msg || msg.type !== "dshSetScope") return;
          setVscodeScope(msg.paths, msg.rawPaths);
        }
        window.addEventListener("message", onScopeFromHost);
        try { window.parent.postMessage({ type: "dshScopeRequest" }, "*"); } catch (err) { /* noop */ }
        const timer = setInterval(checkWorkbenchScope, 1500);
        return function () {
          clearInterval(timer);
          window.removeEventListener("message", onScopeFromHost);
          if (scopeWatchdogTick === checkWorkbenchScope) scopeWatchdogTick = null;
        };
      }, "dsh-review: workbench scope watchdog");

      ctx.inject(["slots", "conversation", "inputTriggers"], function (scope) {
        try {
          const conversation = scope.conversation;
          if (conversation && conversation.input && typeof conversation.input.shell === "function") {
            inputHub = conversation.input;
            conversationApi = conversation;
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
          return function () {
            unregisterDock();
            unregisterRefSource();
            refSourceRegistered = false;
          };
        }, "dsh-review: dock + vscode-ref source");
      });
    }

    exports.apply = apply;
    exports.inject = ["slots", "workspaces", "sessions"];
    return module.exports;
  }
});
