(function () {
  var hits = [];
  var ee = document.querySelectorAll('*');
  for (var i = 0; i < ee.length; i++) {
    var el = ee[i];
    var cs = getComputedStyle(el);
    if (cs.position !== 'fixed' && cs.position !== 'absolute') continue;
    var r = el.getBoundingClientRect();
    if (r.width < 6 || r.width > 60 || r.height < 6 || r.height > 60) continue;
    var bg = cs.backgroundColor;
    var before = getComputedStyle(el, '::before').content;
    var after = getComputedStyle(el, '::after').content;
    var txt = (el.textContent || '').trim();
    if (txt === '' && (before === 'none' || before === 'normal') && (after === 'none' || after === 'normal')) continue;
    hits.push({
      tag: el.tagName, cls: String(el.className || '').slice(0, 70), id: el.id,
      txt: txt.slice(0, 12), before: String(before).slice(0, 30), after: String(after).slice(0, 30),
      x: Math.round(r.left), y: Math.round(r.top),
      attrs: Array.prototype.slice.call(el.attributes).map(function (a) { return a.name + '=' + String(a.value).slice(0, 40); }).slice(0, 10)
    });
    if (hits.length > 12) break;
  }
  return JSON.stringify(hits, null, 1);
})()
