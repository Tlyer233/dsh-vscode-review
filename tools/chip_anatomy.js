(function () {
  var out = { chips: [], lines: [], pinCandidates: [] };
  var chips = document.querySelectorAll('.chat-attached-context-attachment');
  for (var i = 0; i < chips.length; i++) {
    var el = chips[i];
    out.chips.push({
      aria: el.getAttribute('aria-label'),
      title: el.getAttribute('title'),
      role: el.getAttribute('role'),
      cls: String(el.className).slice(0, 80),
      attrs: Array.prototype.slice.call(el.attributes).map(function (a) { return a.name + '=' + String(a.value).slice(0, 60); }),
      text: (el.textContent || '').trim().slice(0, 60),
      outer: el.outerHTML.slice(0, 500)
    });
  }
  // any element carrying elementId-ish data
  var all = document.querySelectorAll('[data-element-id],[data-elementid],[data-comment-id],[data-browser-comment-id]');
  for (var j = 0; j < all.length && j < 8; j++) {
    out.pinCandidates.push({ tag: all[j].tagName, attrs: Array.prototype.slice.call(all[j].attributes).map(function (a) { return a.name + '=' + String(a.value).slice(0, 50); }).slice(0, 8), txt: (all[j].textContent || '').slice(0, 30) });
  }
  return JSON.stringify(out, null, 1);
})()
