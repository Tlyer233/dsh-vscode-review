(function () {
  function walk(root, out, depth) {
    if (depth > 6 || out.length > 14) return;
    var els = root.querySelectorAll('*');
    for (var i = 0; i < els.length; i++) {
      var el = els[i];
      if (el.shadowRoot) {
        out.push({ shadow: true, tag: el.tagName, cls: String(el.className || '').slice(0, 50), kids: el.shadowRoot.querySelectorAll('*').length });
        walk(el.shadowRoot, out, depth + 1);
      }
      if (out.length > 14) return;
    }
    for (var q = 0; q < els.length; q++) {
      if (els[q].tagName === 'IFRAME') {
        try {
          var d = els[q].contentDocument;
          if (d) {
            var pins = [];
            var ee = d.querySelectorAll('*');
            for (var z = 0; z < ee.length; z++) {
              var t = (ee[z].textContent || '').trim();
              if (t.length === 1 && t >= '1' && t <= '9') {
                var r = ee[z].getBoundingClientRect();
                if (r.width > 4 && r.width < 40 && r.height > 4 && r.height < 40) pins.push(ee[z].outerHTML.slice(0, 220));
              }
              if (pins.length > 3) break;
            }
            out.push({ iframe: true, src: String(els[q].src).slice(0, 40), kids: ee.length, pins: pins });
            walk(d, out, depth + 1);
          }
        } catch (e) {
          out.push({ iframe: true, blocked: true, src: String(els[q].src).slice(0, 30) });
        }
      }
    }
  }
  var out = [];
  walk(document, out, 0);
  return JSON.stringify({
    frames: window.frames.length,
    found: out.slice(0, 15)
  });
})()
