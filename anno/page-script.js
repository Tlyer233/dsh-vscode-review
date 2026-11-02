/* dsh annotation intercept (in-page, DEFAULT world, injected via CDP).
 * The native comment box lives in the ISOLATED world (worldId 999, "Electron
 * Isolated Context"), inside the pick host's CLOSED shadow root. Its keydown
 * events do NOT reach the default world's document, but they DO reach the pick
 * host (the shadow host) at the CAPTURE level — confirmed: a pick-host CAPTURE
 * keydown listener with stopImmediatePropagation blocks the native commit.
 *
 * This script:
 *  - Waits for the pick host (appears after ⌥⌘C) and installs a CAPTURE keydown
 *    listener on it: Enter (no Shift) = native commit → we block it and beacon.
 *  - Installs a CAPTURE click listener on it: the + send button = native commit
 *    → we block it and beacon.
 *  - Captures the element click coordinates (pointerup on the pick host, NOT on
 *    the comment box / shadow host content) so the extension can resolve the
 *    element via elementFromPoint.
 *  - Provides its OWN numbered pins (open shadow overlay) with hover preview +
 *    delete + renumber, driven by the extension via addPin/removePin/clearPins.
 * Zero Copilot by construction: the native _submitComment() is never reached.
 */
(function () {
  'use strict';
  var PREFIX = '__DSH_ANNO__';
  function beacon(o) { try { console.log(PREFIX + JSON.stringify(o)) } catch (e) {} }
  if (window.__dshAnno) { window.__dshAnno.reinstall(); return; }

  var pins = [];
  var seq = 0;
  var lastPointerUp = null;
  var pickHost = null;
  var overlayHost = null;
  var installed = false;

  function ensureOverlay() {
    if (overlayHost && overlayHost.isConnected) return overlayHost.shadowRoot;
    var host = document.createElement('div');
    host.setAttribute('data-dsh-anno-overlay', '');
    host.style.cssText = 'position:fixed;top:0;left:0;width:0;height:0;z-index:2147483646;pointer-events:none;';
    var root = host.attachShadow({ mode: 'open' });
    var style = document.createElement('style');
    style.textContent = [
      '.comment-pin{position:absolute;transform:translate(-50%,-100%);pointer-events:auto;}',
      '.comment-pin-bubble{display:inline-flex;align-items:center;justify-content:center;min-width:20px;height:20px;padding:0 5px;border-radius:11px;background:#0b83ff;color:#fff;font:600 12px/20px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;box-shadow:0 1px 3px rgba(0,0,0,.35);cursor:pointer;user-select:none;}',
      '.comment-pin-number{line-height:1;}',
      '.comment-pin-x{margin-left:3px;font-size:12px;line-height:1;cursor:pointer;opacity:.85;}',
      '.comment-pin-x:hover{opacity:1;}',
      '.comment-pin-preview{position:absolute;top:24px;left:50%;transform:translateX(-50%);background:rgba(20,20,20,.96);color:#e8e8e8;padding:6px 10px;border-radius:6px;font:12px/16px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;white-space:pre-wrap;max-width:280px;pointer-events:none;}',
      ''
    ].join('\n');
    root.appendChild(style);
    document.documentElement.appendChild(host);
    overlayHost = host;
    return root;
  }

  function renumber() {
    pins.forEach(function (p, i) { p.ordinal = i + 1; if (p.numberEl) p.numberEl.textContent = String(i + 1) })
  }

  function selectorOf(el) {
    try {
      if (!el || el.nodeType !== 1) return '';
      var s = el.tagName.toLowerCase();
      if (el.id) return s + '#' + el.id;
      var cls = el.className;
      if (cls && typeof cls === 'string') {
        var c = cls.trim().split(/\s+/).slice(0, 2);
        if (c.length) s += '.' + c.join('.');
      }
      return s;
    } catch (e) { return '' }
  }

  function addPin(x, y, comment) {
    var el = null;
    try { el = (x != null && y != null) ? document.elementFromPoint(x, y) : null } catch (e) {}
    var rect = el ? el.getBoundingClientRect() : { left: 12, top: 12, width: 120, height: 28 };
    var id = 'anno-' + (++seq);
    var root = ensureOverlay();
    var pin = document.createElement('div');
    pin.className = 'comment-pin';
    pin.style.left = (rect.left + Math.min(24, rect.width / 2)) + 'px';
    pin.style.top = rect.top + 'px';
    var bubble = document.createElement('span');
    bubble.className = 'comment-pin-bubble';
    var num = document.createElement('span');
    num.className = 'comment-pin-number';
    num.textContent = '1';
    var xbtn = document.createElement('span');
    xbtn.className = 'comment-pin-x';
    xbtn.textContent = '×';
    xbtn.title = '删除批注';
    bubble.appendChild(num);
    bubble.appendChild(xbtn);
    pin.appendChild(bubble);
    var preview = document.createElement('div');
    preview.className = 'comment-pin-preview';
    preview.textContent = comment || '(空批注)';
    preview.style.display = 'none';
    pin.appendChild(preview);

    pin.addEventListener('pointerenter', function () { preview.style.display = 'block' });
    pin.addEventListener('pointerleave', function () { preview.style.display = 'none' });
    xbtn.addEventListener('click', function (e) { e.stopPropagation(); removePin(id) });
    root.appendChild(pin);
    var p = { id: id, ordinal: 1, x: x, y: y, el: el, pin: pin, numberEl: num, comment: comment };
    pins.push(p);
    renumber();
    beacon({ ev: 'pinAdded', id: id, ordinal: p.ordinal, selector: selectorOf(el), label: selectorOf(el), comment: comment, pins: pins.length });
    return { id: id, ordinal: p.ordinal, selector: selectorOf(el), comment: comment };
  }

  function removePin(id) {
    var idx = -1;
    for (var i = 0; i < pins.length; i++) { if (pins[i].id === id) { idx = i; break } }
    if (idx < 0) return;
    var p = pins.splice(idx, 1)[0];
    try { p.pin.remove() } catch (e) {}
    renumber();
    beacon({ ev: 'pinRemoved', id: id, pins: pins.length });
  }

  function clearPins() {
    var n = pins.length;
    pins = [];
    try { if (overlayHost && overlayHost.shadowRoot) overlayHost.shadowRoot.querySelectorAll('.comment-pin').forEach(function (el) { el.remove() }) } catch (e) {}
    if (n) beacon({ ev: 'pinsCleared', pins: 0 });
  }

  function doCommit() {
    var x = lastPointerUp ? lastPointerUp.x : null;
    var y = lastPointerUp ? lastPointerUp.y : null;
    beacon({ ev: 'commit', x: x, y: y });
    lastPointerUp = null;
  }

  function onPickHost() {
    if (!pickHost) return false;
    pickHost.addEventListener('keydown', function (e) {
      try {
        if (e.key !== 'Enter' || e.shiftKey) return;
        e.stopImmediatePropagation();
        e.stopPropagation();
        e.preventDefault();
        beacon({ ev: 'interceptEnter' });
        doCommit();
      } catch (err) { beacon({ ev: 'err', msg: String((err && err.message) || err) }) }
    }, true);
    pickHost.addEventListener('click', function (e) {
      try {
        var isSend = false;
        var t = e.target;
        if (t && (t.className || '').indexOf('comment-send') !== -1) isSend = true;
        if (!isSend) {
          var path = (e.composedPath) ? e.composedPath() : [];
          for (var i = 0; i < path.length; i++) {
            var n = path[i];
            if (n && (n.className || '').indexOf('comment-send') !== -1) { isSend = true; break }
          }
        }
        if (isSend) {
          e.stopImmediatePropagation();
          e.stopPropagation();
          e.preventDefault();
          beacon({ ev: 'interceptSend' });
          doCommit();
        }
      } catch (err) { beacon({ ev: 'err', msg: String((err && err.message) || err) }) }
    }, true);
    pickHost.addEventListener('pointerup', function (e) {
      try {
        // Only capture page clicks (not the comment box / send button).
        var isShadowContent = false;
        var path = (e.composedPath) ? e.composedPath() : [];
        for (var i = 0; i < path.length; i++) {
          var n = path[i];
          if (n && ((n.className || '').indexOf('comment-composer') !== -1 || (n.className || '').indexOf('comment-send') !== -1)) { isShadowContent = true; break }
        }
        if (isShadowContent) return;
        lastPointerUp = { x: e.clientX, y: e.clientY };
      } catch (err) {}
    }, true);
    return true;
  }

  function findPickHost() {
    var h = document.querySelector('[data-vscode-pick-host]');
    if (h) { pickHost = h; return true }
    return false;
  }

  function reinstall() {
    installed = false;
    pickHost = null;
    if (findPickHost() && onPickHost()) {
      beacon({ ev: 'installed', pins: pins.length });
    } else {
      var tries = 0;
      var iv = setInterval(function () {
        tries++;
        if (findPickHost() && onPickHost()) {
          clearInterval(iv);
          beacon({ ev: 'installed', pins: pins.length });
        }
        // indefinite: the pick host appears whenever the user presses ⌥⌘C
      }, 100);
    }
  }

  window.__dshAnno = {
    start: reinstall,
    addPin: addPin,
    removePin: removePin,
    clearPins: clearPins,
    renumber: renumber,
    get pins() { return pins.map(function (p) { return { id: p.id, ordinal: p.ordinal, selector: selectorOf(p.el), comment: p.comment } }) },
    reinstall: reinstall,
  };
  window.__dshAnno.start();
  return 'installed';
})()
