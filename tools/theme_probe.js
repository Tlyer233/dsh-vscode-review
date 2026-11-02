const WebSocket = require('/Users/xi/.vscode/extensions/dsn.dsh-review-vscode-0.1.165/node_modules/ws');
const http = require('http');
(async () => {
  const targets = await new Promise((res) => http.get('http://127.0.0.1:9223/json', (r) => { let d = ''; r.on('data', c => d += c); r.on('end', () => res(JSON.parse(d))); }));
  const t = targets.find((x) => /127\.0\.0\.1:308\d/.test(x.url || ''));
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  let id = 1; const pending = {};
  ws.on('message', (d) => { const m = JSON.parse(d.toString()); if (m.id && pending[m.id]) { pending[m.id](m); delete pending[m.id]; } });
  await new Promise((r) => { ws.on('open', r); });
  const ev = (expression) => new Promise((resolve) => {
    const myId = id++;
    pending[myId] = (m) => {
      if (m.result && m.result.exceptionDetails) { const ed = m.result.exceptionDetails; resolve('EXC:' + ((ed.exception && (ed.exception.description || ed.exception.value)) || ed.text || '?').toString().slice(0, 200)); return; }
      resolve(m.result && m.result.result ? String(m.result.result.value) : 'noval');
    };
    ws.send(JSON.stringify({ id: myId, method: 'Runtime.evaluate', params: { expression, returnByValue: true } }));
  });
  const p1 = `(function () {
    var cs = getComputedStyle(document.documentElement);
    var out = [];
    for (var i = 0; i < cs.length; i++) { var p = cs[i]; if (p.slice(0,2) === '--') out.push(p + '=' + cs.getPropertyValue(p).trim().slice(0, 24)); }
    return JSON.stringify(out);
  })()`;
  console.log('VARS:', (await ev(p1)).slice(0, 1600));
  const p2 = `(function () {
    // what color does the app itself use for focus rings on the composer?
    var ed = document.querySelector('[data-composer-card] [contenteditable]');
    var card = document.querySelector('[data-composer-card]');
    var res = { focused: document.activeElement && document.activeElement.className ? String(document.activeElement.className).slice(0, 30) : null };
    if (card) { var s = getComputedStyle(card); res.cardOutline = s.outlineColor + ' / ' + s.outlineWidth; res.cardFocusShadowProbe = s.boxShadow.slice(0, 80); }
    if (ed) { var s2 = getComputedStyle(ed); res.editCaret = s2.caretColor; res.editColor = s2.color; }
    var btn = document.querySelector('[data-composer-card] button[class*="primary"]');
    if (btn) { var s3 = getComputedStyle(btn); res.btnAccentBg = s3.backgroundColor; res.btnImgFilter = (s3.filter || '').slice(0, 60); var img = btn.querySelector('svg, img'); if (img) { var s4 = getComputedStyle(img); res.iconColor = s4.color; } }
    return JSON.stringify(res);
  })()`;
  console.log('COLORS:', await ev(p2));
  ws.close(); process.exit(0);
})().catch((e) => { console.log('ERR', e.message); process.exit(1); });
