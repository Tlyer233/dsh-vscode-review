(function () {
  var out = { cls: [], geom: [] };
  var ee = document.querySelectorAll('*');
  for (var i = 0; i < ee.length; i++) {
    var el = ee[i];
    var cls = String(el.className && el.className.baseVal !== undefined ? el.className.baseVal : el.className || '');
    var id = el.id || '';
    if (/element|browser/i.test(cls + id) && /comment|pin|marker|badge|number/i.test(cls + id) && cls.length < 90) {
      out.cls.push({ tag: el.tagName, cls: cls.slice(0, 85), id: id.slice(0, 40), txt: (el.textContent || '').slice(0, 20) });
      if (out.cls.length > 10) break;
    }
  }
  for (var j = 0; j < ee.length; j++) {
    var el2 = ee[j];
    var cs = getComputedStyle(el2);
    if (cs.position !== 'fixed' && cs.position !== 'absolute') continue;
    var r = el2.getBoundingClientRect();
    if (r.width < 8 || r.width > 50 || r.height < 8 || r.height > 50) continue;
    var t = (el2.textContent || '').trim();
    var bc = cs.backgroundColor;
    if (t.length > 1 && t !== '') continue;
    if (/rgb\(2[01]\d, 1[01]\d|rgb\(2\d\d, 1[0-4]\d, 8\d/.test(bc) || t.length === 1) {
      out.geom.push({ tag: el2.tagName, cls: String(el2.className || '').slice(0, 70), txt: t, bg: bc, x: Math.round(r.left), y: Math.round(r.top), outer: el2.outerHTML.slice(0, 200) });
      if (out.geom.length > 8) break;
    }
  }
  return JSON.stringify(out, null, 1);
})()
