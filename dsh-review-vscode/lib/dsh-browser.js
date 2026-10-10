'use strict'

/**
 * dsh sidebar: full-height iframe + message bridge + workbench scope.
 *
 * Reload is done by the extension host rewriting webview.html (Restart /
 * overlay 刷新). Never depends on webview JS being alive.
 * Overlay starts hidden so it cannot cover a working iframe.
 */

const vscode = require('vscode')
const fs = require('node:fs')
const path = require('node:path')
const { execFile } = require('node:child_process')

/**
 * Open a dsh-chat file reference in the editor (paired with plugin setting
 * openFilesInVscode). Two path sources, per the community interception table:
 * deliverables chips / inline mentions carry the FULL path in `title`
 * (absolute, opens directly); tool-row .fileLink buttons only carry their
 * display text, which dsh renders as a (possibly basename-truncated)
 * session-cwd-relative path with a `:line` or `:line-line` suffix — the log
 * proved labels like "index.js:363" reach us verbatim. Strip the line suffix
 * (we open the file only, no line jump, per user decision), resolve against
 * the session cwd then this window's workspace folders, and — the way the
 * community resolves ambiguous basenames against collected artifacts —
 * fall back to a workspace-wide basename search, preferring the candidate
 * whose path ends with the label (closest full-path match), then shortest.
 * @param {string} raw
 * @param {string} cwd
 */
async function openFileFromDsh(raw, cwd) {
  try {
    if (!raw) return
    let p = raw.trim()
    // "index.js:363" / "a/b.ts:12-20" → path + ignored line hint.
    const m = p.match(/^(.+?)[:#](\d+)(?:-\d+)?$/)
    if (m && m[1]) p = m[1]
    if (!path.isAbsolute(p)) {
      const roots = []
      if (cwd) roots.push(cwd)
      for (const f of vscode.workspace.workspaceFolders || []) roots.push(f.uri.fsPath)
      let hit = ''
      for (const r of roots) {
        try {
          const cand = path.resolve(r, p)
          if (fs.existsSync(cand)) { hit = cand; break }
        } catch (e) { /* next root */ }
      }
      if (!hit) {
        // dsh labels are basename-truncated (official decision note: the
        // matcher only resolves a basename when it is unique among the
        // turn's produced paths; ours is not). Search the workspace and
        // prefer the candidate whose path ends with the label.
        const base = path.basename(p)
        const want = p.split('/').join(path.sep)
        const found = await vscode.workspace.findFiles('**/' + base, '**/node_modules/**', 20)
        let best = null
        for (const uri of found) {
          const fp = uri.fsPath
          if (fp.endsWith(path.sep + want) && (!best || fp.length < best.length)) best = fp
        }
        if (!best) {
          for (const uri of found) {
            const fp = uri.fsPath
            if (!best || fp.length < best.length) best = fp
          }
        }
        hit = best || ''
      }
      if (!hit) { state.log('openFile missing: ' + raw); dshFileToast('dsh: 文件未找到 ' + raw); return }
      p = hit
    } else if (!fs.existsSync(p)) {
      // Absolute path from a chip/mention title that no longer
      // exists (deleted/moved file) — same user-visible outcome.
      state.log('openFile missing: ' + raw)
      dshFileToast('dsh: 文件未找到 ' + raw)
      return
    }
    const uri = vscode.Uri.file(p)
    let doc = null
    try {
      doc = await vscode.workspace.openTextDocument(uri)
    } catch (e) {
      // Images and other binaries reject openTextDocument
      // ("Binary contents are not supported" — hit on /tmp/*.png Read rows)
      // and there are file types with dedicated editors (pdf...).
      // Fall through to the generic opener so ANY openable file opens.
      doc = null
    }
    if (doc) {
      await vscode.window.showTextDocument(doc, { preview: false })
    } else {
      await vscode.commands.executeCommand('vscode.open', uri)
    }
    state.log('openFile ' + p)
  } catch (e) {
    state.log('openFile failed: ' + String((e && e.message) || e))
    dshFileToast('dsh: 打开失败 ' + raw)
  }
}

/**
 * Bottom-right notification that closes itself after ~1s (per user ask) —
 * showInformationMessage never auto-dismisses, so a 1s withProgress task is
 * the standard auto-close toast.
 * @param {string} title
 */
function dshFileToast(title) {
  try {
    void vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: title },
      () => new Promise((resolve) => setTimeout(resolve, 1000)),
    )
  } catch (e) { /* noop */ }
}

/** @type {{ dshView: any, dshVisible: boolean, lastScopeNoticeAt: number, lastScopeEmpty: boolean|null, log: (s: string) => void }} */
const state = {
  dshView: null,
  dshVisible: false,
  lastScopeNoticeAt: 0,
  lastScopeEmpty: null,
  log: (msg) => { /* set by activate */ void msg },
}

const CHROME_KEY = 'dshReview.iframeChrome'

/** @type {import('vscode').ExtensionContext | null} */
let extensionContext = null

/** @type {{ railSide: 'left' | 'right', railHidden: boolean, zoom: number }} */
let iframeChrome = { railSide: 'left', railHidden: false, zoom: 1 }

/**
 * @param {unknown} n
 * @returns {number}
 */
function clampZoom(n) {
  const x = Number(n)
  if (!Number.isFinite(x)) return 1
  return Math.min(2, Math.max(0.5, Math.round(x * 10) / 10))
}

/**
 * @param {unknown} raw
 * @returns {{ railSide: 'left' | 'right', railHidden: boolean, zoom: number }}
 */
function normalizeChrome(raw) {
  const src = raw && typeof raw === 'object' ? raw : {}
  return {
    railSide: src.railSide === 'right' ? 'right' : 'left',
    railHidden: !!src.railHidden,
    zoom: clampZoom(src.zoom),
  }
}

/**
 * @param {{ railSide: string, railHidden: boolean, zoom: number }} chrome
 * @returns {string}
 */
function chromeQuery(chrome) {
  const c = normalizeChrome(chrome)
  return '_dshRail=' + encodeURIComponent(c.railSide)
    + '&_dshHidden=' + (c.railHidden ? '1' : '0')
    + '&_dshZoom=' + encodeURIComponent(String(c.zoom))
}

/**
 * @param {unknown} raw
 */
function saveIframeChrome(raw) {
  iframeChrome = normalizeChrome(raw)
  if (extensionContext) {
    void extensionContext.globalState.update(CHROME_KEY, iframeChrome)
  }
}

function setLog(fn) {
  state.log = typeof fn === 'function' ? fn : () => { }
}

/** @type {null | ((filePath: string) => Promise<boolean>)} */
let reviewOpener = null

/**
 * Dock click: pending-sync starts/reveals the inline review (not a bare open).
 * @param {(filePath: string) => Promise<boolean>} fn
 */
function setReviewOpener(fn) {
  reviewOpener = typeof fn === 'function' ? fn : null
}

function cfg() {
  return vscode.workspace.getConfiguration('dshReview')
}

/** Sidebar frame origin override (the local authenticating proxy), when active. */
let frameBaseUrl = ''

/**
 * @param {string} url Local origin the sidebar iframe should load; '' restores the raw dsh URL.
 */
function setFrameBaseUrl(url) {
  frameBaseUrl = String(url || '')
}

function configuredWebUrl() {
  return frameBaseUrl || String(cfg().get('webUrl') || 'http://127.0.0.1:3080')
}

/**
 * @typedef {{ type: string, name: string, data: string, bytes: number }} ClipboardImagePayload
 */

/**
 * Parse `image/png <base64>` stdout from a clipboard helper.
 * @param {string} raw
 * @returns {ClipboardImagePayload | null}
 */
function parseClipboardImageStdout(raw) {
  const s = String(raw || '').trim()
  if (!s || s === 'NOIMAGE') return null
  const space = s.indexOf(' ')
  if (space < 0) return null
  let type = s.slice(0, space).toLowerCase()
  if (type === 'image/jpg') type = 'image/jpeg'
  if (type !== 'image/png' && type !== 'image/jpeg' && type !== 'image/webp' && type !== 'image/gif') return null
  const data = s.slice(space + 1).replace(/\s+/g, '')
  if (!data) return null
  const ext = type === 'image/jpeg' ? 'jpg' : type.slice('image/'.length)
  return { type, name: 'clipboard.' + ext, data, bytes: Math.floor(data.length * 0.75) }
}

/**
 * @param {string} cmd
 * @param {string[]} args
 * @param {{ encoding?: 'utf8' | 'buffer', input?: string }} [opts]
 * @returns {Promise<string | Buffer>}
 */
function execClipboardCmd(cmd, args, opts) {
  const encoding = opts && opts.encoding === 'buffer' ? 'buffer' : 'utf8'
  return new Promise((resolve) => {
    const child = execFile(cmd, args, {
      timeout: 2500,
      maxBuffer: 20 * 1024 * 1024,
      encoding: encoding === 'buffer' ? null : 'utf8',
      windowsHide: true,
    }, (err, stdout) => {
      if (err) {
        state.log('[paste] ' + cmd + ' failed: ' + String(err.message || err))
        resolve(encoding === 'buffer' ? Buffer.alloc(0) : '')
        return
      }
      resolve(stdout || (encoding === 'buffer' ? Buffer.alloc(0) : ''))
    })
    child.on('error', () => {
      resolve(encoding === 'buffer' ? Buffer.alloc(0) : '')
    })
    if (opts && opts.input && child.stdin) {
      try {
        child.stdin.end(opts.input)
      } catch {
        /* noop */
      }
    }
  })
}

/**
 * macOS: read PNG/JPEG/GIF (or convert NSImage) from the general pasteboard.
 * @returns {Promise<ClipboardImagePayload | null>}
 */
function readMacClipboardImage() {
  const script = [
    'ObjC.import("AppKit");',
    'function b64(data) {',
    '  if (!data) return "";',
    '  try { if (data.isNil && data.isNil()) return ""; } catch (e) {}',
    '  try { if (!(Number(data.length) > 0)) return ""; } catch (e) {}',
    '  var s = ObjC.unwrap(data.base64EncodedStringWithOptions(0));',
    '  return s || "";',
    '}',
    'var pb = $.NSPasteboard.generalPasteboard;',
    'var result = "NOIMAGE";',
    'var out = b64(pb.dataForType("public.png"));',
    'if (out) result = "image/png " + out;',
    'else {',
    '  out = b64(pb.dataForType("public.jpeg"));',
    '  if (out) result = "image/jpeg " + out;',
    '  else {',
    '    out = b64(pb.dataForType("public.gif")) || b64(pb.dataForType("com.compuserve.gif"));',
    '    if (out) result = "image/gif " + out;',
    '    else {',
    '      out = b64(pb.dataForType("public.webp")) || b64(pb.dataForType("org.webmproject.webp"));',
    '      if (out) result = "image/webp " + out;',
    '      else {',
    '        var img = $.NSImage.alloc.initWithPasteboard(pb);',
    '        if (img && !(img.isNil && img.isNil())) {',
    '          var tiff = img.TIFFRepresentation;',
    '          var rep = $.NSBitmapImageRep.imageRepWithData(tiff);',
    '          if (rep && !(rep.isNil && rep.isNil())) {',
    '            var png = rep.representationUsingTypeProperties($.NSBitmapImageFileTypePNG, $.NSDictionary.dictionary);',
    '            out = b64(png);',
    '            if (out) result = "image/png " + out;',
    '          }',
    '        }',
    '      }',
    '    }',
    '  }',
    '}',
    'result;',
  ].join('\n')
  return execClipboardCmd('osascript', ['-l', 'JavaScript'], { input: script }).then((stdout) => {
    return parseClipboardImageStdout(String(stdout || ''))
  })
}

/**
 * Windows: Clipboard.GetImage() as PNG base64.
 * @returns {Promise<ClipboardImagePayload | null>}
 */
function readWinClipboardImage() {
  const ps = [
    'Add-Type -AssemblyName System.Windows.Forms',
    'Add-Type -AssemblyName System.Drawing',
    'if (-not [Windows.Forms.Clipboard]::ContainsImage()) { Write-Output "NOIMAGE"; exit 0 }',
    '$img = [Windows.Forms.Clipboard]::GetImage()',
    'if ($null -eq $img) { Write-Output "NOIMAGE"; exit 0 }',
    '$ms = New-Object System.IO.MemoryStream',
    '$img.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)',
    'Write-Output ("image/png " + [Convert]::ToBase64String($ms.ToArray()))',
  ].join('; ')
  return execClipboardCmd('powershell.exe', ['-NoProfile', '-STA', '-NonInteractive', '-Command', ps]).then((stdout) => {
    return parseClipboardImageStdout(String(stdout || ''))
  })
}

/**
 * Linux: wl-paste / xclip PNG bytes.
 * @returns {Promise<ClipboardImagePayload | null>}
 */
function readLinuxClipboardImage() {
  return execClipboardCmd('wl-paste', ['--type', 'image/png', '--no-newline'], { encoding: 'buffer' }).then((buf) => {
    if (Buffer.isBuffer(buf) && buf.length > 8) {
      return {
        type: 'image/png',
        name: 'clipboard.png',
        data: buf.toString('base64'),
        bytes: buf.length,
      }
    }
    return execClipboardCmd('xclip', ['-selection', 'clipboard', '-t', 'image/png', '-o'], { encoding: 'buffer' }).then((buf2) => {
      if (Buffer.isBuffer(buf2) && buf2.length > 8) {
        return {
          type: 'image/png',
          name: 'clipboard.png',
          data: buf2.toString('base64'),
          bytes: buf2.length,
        }
      }
      return null
    })
  })
}

/**
 * Image bytes from the OS clipboard. vscode.env.clipboard cannot read images.
 * @returns {Promise<ClipboardImagePayload | null>}
 */
function readOsClipboardImage() {
  if (process.platform === 'darwin') return readMacClipboardImage()
  if (process.platform === 'win32') return readWinClipboardImage()
  return readLinuxClipboardImage()
}

/**
 * @param {string} url
 * @param {{ overlay?: 'hidden' | 'offline' | 'restarting', deferFrame?: boolean }} [opts]
 * @returns {string}
 */
function dshWebviewHtml(url, opts) {
  const u = String(url || 'http://127.0.0.1:3080')
  const safe = u.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')
  const chrome = normalizeChrome((opts && opts.chrome) || iframeChrome)
  const src = safe + (u.indexOf('?') >= 0 ? '&' : '?') + '_dshVscode=' + Date.now() + '&' + chromeQuery(chrome)
  const overlayKind = opts && opts.overlay
  const deferFrame = overlayKind === 'offline' || overlayKind === 'restarting' || !!(opts && opts.deferFrame)
  const overlayClass = overlayKind === 'offline' || overlayKind === 'restarting' ? '' : ' hidden'
  const heading = overlayKind === 'restarting' ? '正在重启 dsh…' : 'dsh 未连接 / 已关闭'
  const blurb = overlayKind === 'restarting'
    ? '进程重启中，就绪后侧栏会自动加载。'
    : '侧栏未能加载页面。请确认本机 dsh 已启动，再点刷新（由扩展重载侧栏，不依赖快捷键）。'
  const frameSrc = deferFrame ? 'about:blank' : src
  return '' +
    '<!DOCTYPE html>' +
    '<html><head><meta charset="UTF-8">' +
    '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; frame-src ' + safe + ' about:blank; style-src \'unsafe-inline\'; script-src \'unsafe-inline\';">' +
    '<style>' +
    'html, body { width:100%; height:100%; margin:0; padding:0; overflow:hidden; background:var(--vscode-sideBar-background,#1e1e1e); color:var(--vscode-foreground,#ccc); font:13px/1.45 var(--vscode-font-family,system-ui,sans-serif); }' +
    'body { position:relative; display:flex; flex-direction:column; }' +
    'iframe { display:block; flex:1; width:100%; border:0; background:#111; }' +
    '#overlay { position:absolute; inset:0; z-index:2; display:flex; flex-direction:column; align-items:center; justify-content:center; gap:12px; padding:24px; box-sizing:border-box; text-align:center; background:var(--vscode-sideBar-background,#1e1e1e); }' +
    '#overlay.hidden { display:none; }' +
    '#overlay h1 { margin:0; font-size:15px; font-weight:600; }' +
    '#overlay p { margin:0; max-width:280px; opacity:0.85; }' +
    '#overlay .url { font-family:var(--vscode-editor-font-family,monospace); font-size:11px; opacity:0.65; word-break:break-all; }' +
    '#overlay a.btn { margin-top:4px; padding:8px 16px; font:inherit; text-decoration:none; color:var(--vscode-button-foreground,#fff); background:var(--vscode-button-background,#0e639c); border-radius:2px; }' +
    '#overlay a.btn:hover { background:var(--vscode-button-hoverBackground,#1177bb); }' +
    '</style></head>' +
    '<body>' +
    '<iframe id="dsh-frame" src="' + frameSrc + '" allow="clipboard-read; clipboard-write"></iframe>' +
    '<div id="overlay" class="' + overlayClass.trim() + '" role="status">' +
    '  <h1>' + heading + '</h1>' +
    '  <p>' + blurb + '</p>' +
    '  <p class="url">' + safe + '</p>' +
    '  <a class="btn" href="command:dshReview.reloadSidebar">刷新</a>' +
    '</div>' +
    '<script>' +
    '  var vscode = acquireVsCodeApi();' +
    '  var frame = document.getElementById("dsh-frame");' +
    '  var overlay = document.getElementById("overlay");' +
    '  var connected = false;' +
    '  var dshChrome = ' + JSON.stringify(chrome) + ';' +
    '  var watchdog = setTimeout(function () {' +
    '    if (!connected && overlay) overlay.classList.remove("hidden");' +
    '  }, 8000);' +
    '  function hideOverlay() {' +
    '    connected = true;' +
    '    if (watchdog) { clearTimeout(watchdog); watchdog = null; }' +
    '    if (overlay) overlay.classList.add("hidden");' +
    '  }' +
    '  function reloadFrame(force) {' +
    '    try {' +
    '      if (force && frame) {' +
    '        var srcNow = frame.src;' +
    '        frame.src = srcNow + (srcNow.indexOf("?") >= 0 ? "&" : "?") + "_dshReload=" + Date.now();' +
    '      } else if (frame && frame.contentWindow) {' +
    '        frame.contentWindow.location.reload();' +
    '      }' +
    '    } catch (e) {' +
    '      if (frame) frame.src = frame.src;' +
    '    }' +
    '  }' +
    '  document.addEventListener("keydown", function (event) {' +
    '    var mod = event.metaKey || event.ctrlKey;' +
    '    var key = String(event.key || "").toLowerCase();' +
    '    if (mod && event.shiftKey && !event.altKey && key === "p") {' +
    '      if (event.repeat) return;' +
    '      event.preventDefault();' +
    '      vscode.postMessage({ type: "dshShowCommands" });' +
    '      return;' +
    '    }' +
    '    if (mod && !event.altKey && key === "r") {' +
    '      event.preventDefault();' +
    '      vscode.postMessage({ type: "dshRefreshRequest" });' +
    '    }' +
    '  });' +
    '  document.addEventListener("wheel", function (event) {' +
    '    if (!(event.metaKey || event.ctrlKey) || event.altKey) return;' +
    '    event.preventDefault();' +
    '    var dir = event.deltaY > 0 ? -1 : 1;' +
    '    if (frame && frame.contentWindow) frame.contentWindow.postMessage({ type: "dshChromeZoomDelta", dir: dir }, "*");' +
    '  }, { capture: true, passive: false });' +
    '  var lastActiveAt = 0;' +
    '  function reportDshActive() {' +
    '    var now = Date.now();' +
    '    if (now - lastActiveAt < 3000) return;' +
    '    lastActiveAt = now;' +
    '    vscode.postMessage({ type: "dshViewActive" });' +
    '  }' +
    '  function pasteLog(line) {' +
    '    vscode.postMessage({ type: "dshPasteLog", line: String(line || "") });' +
    '  }' +
    '  function blobToB64(blob) {' +
    '    return new Promise(function (resolve, reject) {' +
    '      var r = new FileReader();' +
    '      r.onload = function () {' +
    '        var s = String(r.result || "");' +
    '        var i = s.indexOf(",");' +
    '        resolve(i >= 0 ? s.slice(i + 1) : s);' +
    '      };' +
    '      r.onerror = reject;' +
    '      r.readAsDataURL(blob);' +
    '    });' +
    '  }' +
    '  function canonicalImageType(type) {' +
    '    var t = String(type || "").toLowerCase();' +
    '    if (t === "image/jpg") return "image/jpeg";' +
    '    if (t === "image/png" || t === "image/jpeg" || t === "image/webp" || t === "image/gif") return t;' +
    '    return "";' +
    '  }' +
    '  function readParentClipboardImages() {' +
    '    if (!navigator.clipboard || typeof navigator.clipboard.read !== "function") {' +
    '      return Promise.resolve({ images: [], err: "no clipboard.read", typesDump: "" });' +
    '    }' +
    '    return navigator.clipboard.read().then(function (items) {' +
    '      var jobs = [];' +
    '      var typesDump = [];' +
    '      for (var i = 0; i < items.length; i++) {' +
    '        var types = items[i].types || [];' +
    '        typesDump.push(types.join("|"));' +
    '        for (var j = 0; j < types.length; j++) {' +
    '          var media = canonicalImageType(types[j]);' +
    '          if (!media) continue;' +
    '          (function (item, mime, kind) {' +
    '            jobs.push(item.getType(mime).then(function (blob) {' +
    '              return blobToB64(blob).then(function (data) {' +
    '                var ext = kind === "image/jpeg" ? "jpg" : kind.slice(6);' +
    '                return { type: kind, name: "clipboard." + ext, data: data, bytes: blob.size };' +
    '              });' +
    '            }));' +
    '          })(items[i], types[j], media);' +
    '          break;' +
    '        }' +
    '      }' +
    '      return Promise.all(jobs).then(function (images) {' +
    '        return { images: images, err: "", typesDump: typesDump.join(";") };' +
    '      });' +
    '    }).catch(function (err) {' +
    '      return { images: [], err: String(err && err.name || "") + " " + String(err && err.message || err), typesDump: "" };' +
    '    });' +
    '  }' +
    '  function forwardParentImages(hadText) {' +
    '    var settled = false;' +
    '    var timer = setTimeout(function () {' +
    '      if (settled) return;' +
    '      settled = true;' +
    '      pasteLog("parent clipboard.read timeout 400ms");' +
    '      if (frame && frame.contentWindow) frame.contentWindow.postMessage({ type: "dshPasteImages", images: [], hadText: !!hadText }, "*");' +
    '    }, 400);' +
    '    readParentClipboardImages().then(function (res) {' +
    '      if (settled) return;' +
    '      settled = true;' +
    '      clearTimeout(timer);' +
    '      pasteLog("parent clipboard.read images=" + res.images.length + " types=" + (res.typesDump || "") + (res.err ? " err=" + res.err : ""));' +
    '      if (frame && frame.contentWindow) frame.contentWindow.postMessage({ type: "dshPasteImages", images: res.images, hadText: !!hadText }, "*");' +
    '    });' +
    '  }' +
    '  document.addEventListener("paste", function (event) {' +
    '    var dump = [];' +
    '    try {' +
    '      var items = event.clipboardData && event.clipboardData.items;' +
    '      if (items) for (var i = 0; i < items.length; i++) dump.push(items[i].kind + ":" + items[i].type);' +
    '    } catch (e) {}' +
    '    pasteLog("parent document paste items=[" + dump.join(",") + "]");' +
    '  }, true);' +
    '  window.addEventListener("focus", reportDshActive);' +
    '  document.addEventListener("pointerdown", reportDshActive, true);' +
    '  document.addEventListener("keydown", reportDshActive, true);' +
    '  var lastDragLogAt = 0;' +
    '  var ghostTimer = 0;' +
    '  document.addEventListener("dragover", function (event) {' +
    '    var now = Date.now();' +
    '    if (now - lastDragLogAt > 1500) {' +
    '      lastDragLogAt = now;' +
    '      var ty = "";' +
    '      try { ty = Array.prototype.slice.call((event.dataTransfer || {}).types || []).join(","); } catch (e) {}' +
    '      vscode.postMessage({ type: "dshPasteLog", line: "[dbg] webview dragover shift=" + (event.shiftKey ? "y" : "n") + " dt=" + ty });' +
    '    }' +
    '    if (event.shiftKey && event.dataTransfer) event.preventDefault();' +
    '  }, true);' +
    '  document.addEventListener("drop", function (event) {' +
    '    if (!event.shiftKey || !event.dataTransfer) {' +
    '      vscode.postMessage({ type: "dshPasteLog", line: "[dbg] webview drop rejected shift=" + (event.shiftKey ? "y" : "n") });' +
    '      return;' +
    '    }' +
    '    event.preventDefault();' +
    '    var raws = [];' +
    '    try { raws.push(event.dataTransfer.getData("application/vnd.code.uri-list")); } catch (e) {}' +
    '    try { raws.push(event.dataTransfer.getData("text/uri-list")); } catch (e) {}' +
    '    vscode.postMessage({ type: "dshWebviewDrop", raws: raws });' +
    '  }, true);' +
    '  window.addEventListener("message", function (event) {' +
    '    var msg = event.data;' +
    '    if (!msg) return;' +
    '    if (msg.type === "dshDragOver") {' +
    '      try { frame.style.pointerEvents = "none"; } catch (e) {}' +
    '      if (ghostTimer) clearTimeout(ghostTimer);' +
    '      ghostTimer = setTimeout(function () { try { frame.style.pointerEvents = ""; } catch (e) {} }, 1500);' +
    '      return;' +
    '    }' +
    '    if (msg.type === "dshBridgeHello") {' +
    '      if (frame && frame.contentWindow) {' +
    '        frame.contentWindow.postMessage({ type: "dshChromeState", railSide: dshChrome.railSide, railHidden: !!dshChrome.railHidden, zoom: dshChrome.zoom }, "*");' +
    '        frame.contentWindow.postMessage({ type: "dshBridgeAck" }, "*");' +
    '      }' +
    '      vscode.postMessage({ type: "dshBridgeHello" });' +
    '      hideOverlay();' +
    '    } else if (msg.type === "dshHostStatus") {' +
    '      if (connected) return;' +
    '      if (!msg.up && overlay) overlay.classList.remove("hidden");' +
    '    } else if (msg.type === "dshPasteLog") {' +
    '      vscode.postMessage(msg);' +
    '    } else if (msg.type === "dshPasteImageRequest") {' +
    '      pasteLog("parent image request hadText=" + !!msg.hadText);' +
    '      forwardParentImages(!!msg.hadText);' +
    '    } else if (msg.type === "dshInsertText" || msg.type === "dshInsertRefs" || msg.type === "dshPasteText" || msg.type === "dshPasteImages" || msg.type === "dshSetScope" || msg.type === "dshPendingUpdated") {' +
    '      if (frame && frame.contentWindow) {' +
    '        frame.contentWindow.postMessage(msg, "*");' +
    '        if (msg.type === "dshInsertText" || msg.type === "dshInsertRefs") {' +
    '          try { frame.focus(); } catch (e) {}' +
    '        }' +
    '      }' +
    '    } else if (msg.type === "dshChromeState") {' +
    '      dshChrome = { railSide: msg.railSide === "right" ? "right" : "left", railHidden: !!msg.railHidden, zoom: Number(msg.zoom) || 1 };' +
    '      vscode.postMessage(msg);' +
    '    } else if (msg.type === "dshViewActive" || msg.type === "dshOpenExternal" || msg.type === "dshOpenFile" || msg.type === "dshPendingRequest" || msg.type === "dshReviewAll" || msg.type === "dshScopeViolation" || msg.type === "dshScopeMissing" || msg.type === "dshScopeEmpty" || msg.type === "dshWorkspaceCreated" || msg.type === "dshScopeDiag" || msg.type === "dshScopeRequest" || msg.type === "dshCopyText" || msg.type === "dshPasteRequest" || msg.type === "dshInsertResult" || msg.type === "dshShowCommands") {' +
    '      vscode.postMessage(msg);' +
    '    } else if (msg.type === "dshReload") {' +
    '      reloadFrame(!!msg.force);' +
    '    }' +
    '  });' +
    '</script>' +
    '</body>' +
    '</html>'
}

function scopePaths() {
  const folders = vscode.workspace.workspaceFolders || []
  const paths = []
  const rawPaths = []
  for (const folder of folders) {
    const raw = folder.uri.fsPath
    rawPaths.push(raw)
    try { paths.push(fs.realpathSync.native(raw)) } catch { paths.push(raw) }
  }
  return { paths, rawPaths }
}

/**
 * Throttled toast when this VS Code window has no workspace folder.
 * @param {string} [reason]
 */
function noticeScopeEmpty(reason) {
  const now = Date.now()
  if (now - (state.lastScopeNoticeAt || 0) < 2000) return
  state.lastScopeNoticeAt = now
  state.log('scope empty notice' + (reason ? ' (' + reason + ')' : ''))
  void vscode.window.showWarningMessage('当前窗口未打开工作区，无法进入 dsh 工作区')
}

function postScope(view) {
  if (!view) return
  const scope = scopePaths()
  const empty = scope.paths.length === 0 && scope.rawPaths.length === 0
  state.log(
    '[dsh-scope] postScope count=' + scope.paths.length
    + ' paths=' + JSON.stringify(scope.paths)
    + ' raw=' + JSON.stringify(scope.rawPaths),
  )
  void view.webview.postMessage({ type: 'dshSetScope', paths: scope.paths, rawPaths: scope.rawPaths })
  // Toast on transition into empty (closing last folder), not on every hello.
  if (empty && state.lastScopeEmpty === false) {
    noticeScopeEmpty('folders-cleared')
  }
  state.lastScopeEmpty = empty
}

/**
 * Rewrite the whole sidebar document. This is the only reload path that
 * still works when webview JS is dead.
 * @param {boolean} [force]
 * @param {{ overlay?: 'hidden' | 'offline' | 'restarting', deferFrame?: boolean }} [opts]
 */
function reloadDshWebview(force, opts) {
  void force
  const view = state.dshView
  if (!view) return false
  const url = configuredWebUrl()
  view.webview.html = dshWebviewHtml(url, opts)
  state.log('reload sidebar html ' + url)
  return true
}

/** Show offline overlay after Stop (rewrites html; does not start dsh). */
function showDshOfflineOverlay() {
  return reloadDshWebview(true, { overlay: 'offline' })
}

/**
 * Park the iframe on about:blank so the old dsh page cannot retry/send
 * while the process is killed. Overlay matches the sidebar so it does not flash white.
 * @returns {boolean}
 */
function showDshRestartingOverlay() {
  return reloadDshWebview(true, { overlay: 'restarting' })
}

/**
 * @returns {Promise<void>}
 * @description Sidebar must own keyboard focus so the composer can take typing.
 */
async function focusDshSidebar() {
  try { await vscode.commands.executeCommand('dshReview.dshWebview.focus') } catch { /* noop */ }
}

async function sendTextToDsh(text) {
  const payload = String(text ?? '')
  if (payload === '') return false
  await focusDshSidebar()
  if (!state.dshView) {
    vscode.window.showWarningMessage('dsh: open the dsh sidebar first')
    return false
  }
  try {
    const ok = await state.dshView.webview.postMessage({ type: 'dshInsertText', text: payload })
    return ok
  } catch (e) {
    state.log('sendTextToDsh failed: ' + (e && e.message || e))
    return false
  }
}

/**
 * Drop payloads from the sidebar webview (VS Code explorer drag) into local
 * absolute paths. dataTransfer entries carry vscode-webview:// or file://
 * URIs per line; custom MIME (vnd.code.uri-list) carries the full list.
 * @param {unknown[]} raws
 * @returns {string[]}
 */
function webviewDropPaths(raws) {
  const out = []
  const seen = new Set()
  for (const raw of (Array.isArray(raws) ? raws : [])) {
    for (const line of String(raw || '').split(/\r?\n/)) {
      const u = String(line).trim()
      if (!u || u.startsWith('#')) continue
      let p = ''
      try {
        if (/^[a-zA-Z]:[\\/]/.test(u)) p = decodeURIComponent(u.replace(/\\/g, '/'))
        else if (u.startsWith('file://') || u.startsWith('vscode-webview://')) p = decodeURIComponent(new URL(u).pathname)
        else if (u.startsWith('/')) p = decodeURIComponent(u)
      } catch { p = '' }
      if (!p) continue
      if (process.platform === 'win32' && /^\/[a-zA-Z]:/.test(p)) p = p.slice(1)
      if (!fs.existsSync(p)) continue
      if (!seen.has(p)) { seen.add(p); out.push(p) }
    }
  }
  return out
}

async function sendRefsToDsh(refs, fallbackText) {
  if (!Array.isArray(refs) || refs.length === 0) return sendTextToDsh(fallbackText)
  await focusDshSidebar()
  if (!state.dshView) {
    vscode.window.showWarningMessage('dsh: open the dsh sidebar first')
    return false
  }
  try {
    const ok = await state.dshView.webview.postMessage({
      type: 'dshInsertRefs',
      refs,
      fallbackText: String(fallbackText ?? ''),
    })
    return ok
  } catch (e) {
    state.log('sendRefsToDsh failed: ' + (e && e.message || e))
    return false
  }
}

function notifyPendingToDsh(entries) {
  if (!state.dshView) return false
  const list = Array.isArray(entries) ? entries : []
  void state.dshView.webview.postMessage({ type: 'dshPendingUpdated', entries: list })
  return true
}

/**
 * Dock row click: open file for create/edit; for delete, drop pending only.
 * @param {string} filePath absolute path from dock
 * @returns {Promise<boolean>}
 */
async function openPendingFileInEditor(filePath) {
  const abs = String(filePath || '') // normalize
  if (!abs) return false

  // Delete rows have no disk file — dismiss from pending instead of open.
  try {
    const { readOwnedPending, removeEntry } = require('./shadow-pending.js')
    const { entryOwnedByThisWindow } = require('./workbench-match.js')
    const entry = readOwnedPending().find((e) => e && e.filePath === abs)
    if (entry && entry.operation === 'delete') {
      removeEntry(abs, entry.workbench) // write that workbench's pending.json
      notifyPendingToDsh(readOwnedPending().filter(entryOwnedByThisWindow)) // refresh dock
      state.log('dismissed delete pending ' + abs)
      return true
    }
  } catch (e) {
    state.log('delete dismiss failed: ' + (e && e.message || e))
  }

  try {
    if (reviewOpener) {
      const ok = await reviewOpener(abs)
      if (ok) return true
    }
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(abs))
    await vscode.window.showTextDocument(doc, { preview: false })
    return true
  } catch (e) {
    state.log('openPendingFile failed: ' + (e && e.message || e))
    return false
  }
}

function setupDshBrowser(context) {
  extensionContext = context
  iframeChrome = normalizeChrome(context.globalState.get(CHROME_KEY))
  context.subscriptions.push(vscode.commands.registerCommand('dshReview.reloadSidebar', () => {
    state.log('reloadSidebar command')
    reloadDshWebview(true)
  }))

  context.subscriptions.push(vscode.window.registerWebviewViewProvider('dshReview.dshWebview', {
    resolveWebviewView(view) {
      const url = configuredWebUrl()
      view.webview.options = {
        enableScripts: true,
        enableCommandUris: ['dshReview.reloadSidebar'],
      }
      view.title = 'dsh'
      view.description = ''

      view.webview.onDidReceiveMessage((msg) => {
        if (!msg) return
        if (msg.type === 'dshChromeState') {
          saveIframeChrome(msg)
          return
        }
        if (msg.type === 'dshRefreshRequest') {
          state.log('refresh request')
          reloadDshWebview(true)
          return
        }
        if (msg.type === 'dshShowCommands') {
          void vscode.commands.executeCommand('workbench.action.showCommands')
          return
        }
        if (msg.type === 'dshPasteLog') {
          state.log('[paste] ' + String(msg.line || ''))
          return
        }
        if (msg.type === 'dshOpenFile') {
          void openFileFromDsh(String(msg.path || ''), String(msg.cwd || ''))
          return
        }
        if (msg.type === 'dshBridgeHello') {
          state.log('dsh bridge hello')
          postScope(view)
          try {
            const { readOwnedPending } = require('./shadow-pending.js')
            const { entryOwnedByThisWindow } = require('./workbench-match.js')
            notifyPendingToDsh(readOwnedPending().filter(entryOwnedByThisWindow))
          } catch (e) {
            state.log('pending push on hello failed: ' + (e && e.message || e))
          }
          return
        }
        // Client (re)asked for whitelist — answer even if Dock was not mounted earlier.
        if (msg.type === 'dshScopeRequest') {
          state.log('[dsh-scope] scope request from client')
          postScope(view)
          return
        }
        if (msg.type === 'dshViewActive') return
        if (msg.type === 'dshPendingRequest') {
          try {
            const { readOwnedPending } = require('./shadow-pending.js')
            const { entryOwnedByThisWindow } = require('./workbench-match.js')
            notifyPendingToDsh(readOwnedPending().filter(entryOwnedByThisWindow))
          } catch (e) {
            state.log('dshPendingRequest failed: ' + (e && e.message || e))
          }
          return
        }
        if (msg.type === 'dshWebviewDrop') {
          const rawLens = (Array.isArray(msg.raws) ? msg.raws : []).map((r) => String(r).length).join(',')
          state.log('[dbg] host drop rawLens=' + rawLens)
          const paths = webviewDropPaths(msg.raws)
          state.log('[dbg] host drop paths=' + paths.length + (paths.length ? ' first=' + paths[0] : ''))
          if (paths.length > 0) {
            const refs = paths.map((p) => ({
              kind: fs.existsSync(p) && fs.statSync(p).isDirectory() ? 'folder' : 'file',
              path: p,
            }))
            void sendRefsToDsh(refs, paths.join('\n'))
          }
          return
        }
        if (msg.type === 'dshReviewAll') {
          const cmd = msg.action === 'reject' ? 'dshReview.rejectAllPending' : 'dshReview.acceptAllPending'
          vscode.commands
            .executeCommand(cmd)
            .catch((e) => state.log('dshReviewAll failed: ' + (e && e.message || e)))
          return
        }
        if (msg.type === 'dshScopeDiag') {
          state.log(
            '[dsh-scope] ' + String(msg.action || '?')
            + ' build=' + String(msg.build || '?')
            + ' current=' + String(msg.current || '')
            + (msg.bound ? ' bound=' + String(msg.bound) : '')
            + ' scopeCount=' + String(msg.scopeCount ?? '')
            + ' rawCount=' + String(msg.rawCount ?? '')
            + ' scopePaths=' + JSON.stringify(msg.scopePaths || [])
            + ' rawPaths=' + JSON.stringify(msg.rawPaths || [])
            + (Array.isArray(msg.dshItems) ? ' dshItems=' + JSON.stringify(msg.dshItems) : ''),
          )
          return
        }
        if (msg.type === 'dshOpenFile') {
          void openPendingFileInEditor(msg.filePath)
          return
        }
        if (msg.type === 'dshOpenExternal') {
          try {
            const parsed = vscode.Uri.parse(String(msg.url || ''))
            if (parsed.scheme === 'http' || parsed.scheme === 'https') {
              void vscode.env.openExternal(parsed)
            }
          } catch (e) {
            state.log('dshOpenExternal failed: ' + (e && e.message || e))
          }
          return
        }
        if (msg.type === 'dshScopeViolation') {
          const now = Date.now()
          if (now - (state.lastScopeNoticeAt || 0) > 2500) {
            state.lastScopeNoticeAt = now
            void vscode.window.showInformationMessage('只能查看当前工作区')
          }
          return
        }
        // VS Code window has no workspace folder — client forced dsh home.
        if (msg.type === 'dshScopeEmpty') {
          noticeScopeEmpty('client')
          return
        }
        if (msg.type === 'dshScopeMissing') {
          const now = Date.now()
          if (now - (state.lastScopeNoticeAt || 0) > 4000) {
            state.lastScopeNoticeAt = now
            void vscode.window.showWarningMessage('该窗口绑定的工作区尚未在 dsh 中创建，已返回 dsh 首页')
          }
          return
        }
        // Client auto-registered this window's folder as a dsh workspace
        // (0.1.45 plan B: subfolder windows get their own empty workspace).
        if (msg.type === 'dshWorkspaceCreated') {
          state.log('[dsh-scope] auto workspace created path=' + String(msg.path || ''))
          const now = Date.now()
          if (now - (state.lastWsCreateNoticeAt || 0) > 4000) {
            state.lastWsCreateNoticeAt = now
            void vscode.window.showInformationMessage('已在 dsh 中为当前窗口文件夹创建工作区' + (msg.path ? ': ' + msg.path : ''))
          }
          return
        }
        if (msg.type === 'dshCopyText' && typeof msg.text === 'string') {
          void vscode.env.clipboard.writeText(msg.text)
        } else if (msg.type === 'dshPasteRequest') {
          vscode.env.clipboard.readText().then((text) => {
            void view.webview.postMessage({ type: 'dshPasteText', text: String(text ?? '') })
          }, () => { /* noop */ })
          // vscode.env.clipboard is text-only; images come from the OS pasteboard.
          void readOsClipboardImage().then((image) => {
            if (!image) {
              state.log('[paste] os clipboard image none')
              return
            }
            state.log('[paste] os clipboard image type=' + image.type + ' bytes=' + image.bytes)
            void view.webview.postMessage({ type: 'dshPasteImages', images: [image] })
          })
        } else if (msg.type === 'dshInsertResult') {
          const line = 'insert mode=' + (msg.mode || '?')
            + ' count=' + (msg.count || 0)
            + (msg.reason ? ' reason=' + msg.reason : '')
            + (msg.source ? ' source=' + msg.source : '')
          state.log(line)
          if (msg.mode && msg.mode !== 'chip') {
            void vscode.window.showWarningMessage('dsh chip 未生效: ' + line)
          }
          // Pull VS Code focus back to the sidebar after every chip insert
          // (selection AND drag-drop flows), then ping the iframe so the DOM
          // focus lands on the composer (the Lexical caret needs it).
          void focusDshSidebar().then(() => {
            void view.webview.postMessage({ type: 'dshFocusComposer' })
          })
        }
      })

      state.dshView = view
      state.dshVisible = !!view.visible
      state.log('sidebar html ' + url)
      view.webview.html = dshWebviewHtml(url)
      postScope(view)
      view.onDidChangeVisibility(() => {
        state.dshVisible = !!view.visible
      })
      view.onDidDispose(() => {
        if (state.dshView === view) {
          state.dshView = null
          state.dshVisible = false
        }
      })
    },
  }, { webviewOptions: { retainContextWhenHidden: true } }))

  context.subscriptions.push(vscode.workspace.onDidChangeWorkspaceFolders(() => {
    if (state.dshView) postScope(state.dshView)
  }))
}

module.exports = {
  state,
  setLog,
  setFrameBaseUrl,
  setupDshBrowser,
  sendRefsToDsh,
  reloadDshWebview,
  showDshOfflineOverlay,
  showDshRestartingOverlay,
  notifyPendingToDsh,
  openPendingFileInEditor,
  setReviewOpener,
  scopePaths,
}
