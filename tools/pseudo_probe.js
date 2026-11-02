(function () {
  var hits = [];
  var ee = document.querySelectorAll('*');
  for (var i = 0; i < ee.length; i++) {
    var el = ee[i];
    var b = getComputedStyle(el, '::before');
    var a = getComputedStyle(el, '::after');
    var bs = String(b.content); var as = String(a.content);
    var interesting = function (cs, which) {
      var c = String(cs.content);
      if (c === 'none' || c === 'normal') return false;
      var pos = cs.position; var bg = cs.backgroundColor;
      if (/["']?[1-9]["']?$/.test(c) || /counter|attr/i.test(c) || /rgb\(2[0-4]\d, 1\d\d, [\d.]+\)/.test(bg)) {
        return true;
      }
      return false;
    };
    if (interesting(b, 'before') || interesting(a, 'after')) {
      hits.push({
        tag: el.tagName, cls: String(el.className || '').slice(0, 60), id: el.id,
        before: String(b.content).slice(0, 40), beforePos: b.position, beforeBg: b.backgroundColor.slice(0, 30),
        after: String(a.content).slice(0, 40), afterPos: a.position, afterBg: a.backgroundColor.slice(0, 30),
        attrs: Array.prototype.slice.call(el.attributes).map(function (x) { return x.name + '=' + String(x.value).slice(0, 30); }).slice(0, 8)
      });
      if (hits.length > 8) break;
    }
  }
  return JSON.stringify({ n: ee.length, hits: hits }, null, 1);
})()
