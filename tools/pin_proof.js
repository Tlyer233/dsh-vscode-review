/* Proof: read the vscode-comment closed-shadow layer via CDP pierce, locate the
 * pinned element by its exact rect, dump FULL context + screenshot. No chips,
 * no hover, no Copilot panel. */
const WebSocket = require('/Users/xi/.vscode/extensions/dsn.dsh-review-vscode-0.1.177/node_modules/ws');
const http = require('http');
const fs = require('fs');
try { require('fs').mkdirSync(require('path').join(require('os').tmpdir(), 'dsh-probe'), { recursive: true }); } catch (e) { /* noop */ }

const OUT = require('path').join(require('os').tmpdir(), 'dsh-probe', 'probe_pin_proof');

(async () => {
  const targets = await new Promise((res) => http.get('http://127.0.0.1:9223/json', (r) => { let d = ''; r.on('data', c => d += c); r.on('end', () => res(JSON.parse(d))); }));
  const t = targets.find((x) => (x.url || '').indexOf('10.99.0.106:8005') !== -1);
  if (!t) throw new Error('NInfer target not found');
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  const handlers = {};
  ws.on('message', (d) => { const m = JSON.parse(d.toString()); if (m.id && handlers[m.id]) { handlers[m.id](m); delete handlers[m.id]; } });
  let mid = 1;
  const send = (method, params) => new Promise((resolve) => { const myId = mid++; handlers[myId] = resolve; ws.send(JSON.stringify({ id: myId, method, params: params || {} })); });
  await new Promise((r) => { ws.on('open', r); });
  await send('DOM.enable');

  // 1) pierce the closed shadow: collect pins + their highlight rects
  const doc = await send('DOM.getDocument', { depth: -1, pierce: true });
  const pins = [];
  let cutout = null;
  (function walk(n, inLayer) {
    if (!n) return;
    const a = n.attributes || [];
    const cls = (a[a.indexOf('class') + 1]) || '';
    const aria = (a[a.indexOf('aria-label') + 1]) || '';
    const title = (a[a.indexOf('title') + 1]) || '';
    if (/comment-pin\b/.test(cls) && /Element comment/.test(aria)) pins.push({ aria, title, cls });
    if (/highlight-shape/.test(cls)) {
      const at = {}; for (let i = 0; i < a.length; i += 2) at[a[i]] = a[i + 1];
      cutout = { x: +at.x, y: +at.y, w: +at.width, h: +at.height };
    }
    if (/comment-layer/.test(cls)) inLayer = true;
    for (const c of (n.children || [])) walk(c, inLayer);
    for (const s of (n.shadowRoots || [])) walk(s, inLayer);
  })(doc.result.root, false);
  console.log('PINS:', JSON.stringify(pins));
  console.log('CUTOUT RECT:', JSON.stringify(cutout));
  if (!pins.length || !cutout) throw new Error('no pins/rect found — is a comment still attached?');

  // 2) locate the element by exact rect + collect FULL context (page side)
  const loc = { x: cutout.x, y: cutout.y, w: cutout.w, h: cutout.h };
  const EXPR = `(function(){
    var L=${JSON.stringify(loc)};
    var els=document.querySelectorAll('*'); var hit=null;
    for (var i=0;i<els.length;i++){ var r=els[i].getBoundingClientRect();
      if (Math.abs(r.left-L.x)<1.5 && Math.abs(r.top-L.y)<1.5 && Math.abs(r.width-L.w)<1.5 && Math.abs(r.height-L.h)<1.5){ hit=els[i]; break; } }
    if (!hit) return JSON.stringify({err:'no-element-at-rect'});
    var out={ tag:hit.tagName.toLowerCase(), id:hit.id, cls:String(hit.className||''),
      outer: hit.outerHTML.slice(0,4000),
      attrs: Array.prototype.slice.call(hit.attributes).map(function(x){return x.name+'='+x.value}),
      inner: (hit.innerText||'').trim().slice(0,2000),
      rect: (function(){var r=hit.getBoundingClientRect();return {top:Math.round(r.top),left:Math.round(r.left),width:Math.round(r.width),height:Math.round(r.height)}})(),
      url: location.href,
      path: (function(){var p=[];var n2=hit;while(n2&&n2.tagName&&p.length<30){var nm=n2.tagName.toLowerCase();if(n2.id)nm+='#'+n2.id;else if(n2.className&&typeof n2.className==='string'&&n2.className.trim())nm+='.'+n2.className.trim().split(/\\s+/).join('.');p.unshift(nm);n2=n2.parentElement;}return p.join(' > ')})(),
      rules: (function(){var rs=[];var sheets=document.styleSheets;for(var s=0;s<sheets.length&&rs.length<60;s++){var rr;try{rr=sheets[s].cssRules}catch(e){continue}if(!rr)continue;for(var c=0;c<rr.length;c++){var ru=rr[c];if(ru.selectorText){try{if(hit.matches(ru.selectorText))rs.push(ru.selectorText+' { '+ru.style.cssText+' }')}catch(e){}}}}return rs.join('\\n')})()
    };
    return JSON.stringify(out);
  })()`;
  const r = await send('Runtime.evaluate', { expression: EXPR, returnByValue: true });
  const data = JSON.parse(String(r.result.result.value));
  if (data.err) throw new Error(data.err);
  console.log('ELEMENT:', data.tag + '#' + data.id, data.rect);

  // 3) screenshot clipped to the element
  const shot = await send('Page.captureScreenshot', { format: 'png', clip: { x: Math.max(0, loc.x - 8), y: Math.max(0, loc.y - 8), width: Math.max(1, loc.w + 16), height: Math.max(1, loc.h + 16), scale: 1 } });

  // 4) write proof files
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const base = OUT + '-' + stamp;
  const comment = pins.map((p) => p.aria.replace(/^Element comment \d+: /, '')).join(' | ');
  let txt = '# element: ' + data.tag + (data.id ? '#' + data.id : (data.cls ? '.' + data.cls.trim().split(/\s+/).join('.') : '')) + '\n' +
    '# comment(s from pins): ' + comment + '\n' +
    '# pin layer: ' + pins.map((p) => p.aria).join(' ;; ') + '\n' +
    '# cutout rect (pierce from CLOSED shadow): ' + JSON.stringify(cutout) + '\n' +
    '# time: ' + new Date().toString() + '\n' +
    '# via: probe (CDP pierce, no chip, no hover, no panel)\n\n' +
    '## SCREENSHOT\n文件: ' + base + '.png\n\n' +
    '## URL\n' + data.url + '\n\n## ELEMENT (Outer HTML)\n' + data.outer +
    '\n\n## ATTRIBUTES\n' + data.attrs.join('\n') +
    '\n\n## INNER TEXT\n' + data.inner +
    '\n\n## POSITION & SIZE\ntop: ' + data.rect.top + 'px | left: ' + data.rect.left + 'px | width: ' + data.rect.width + 'px | height: ' + data.rect.height + 'px\n\n' +
    '## MATCHED CSS RULES\n' + (data.rules || '(none)') + '\n\n## HTML PATH\n' + data.path + '\n';
  fs.writeFileSync(base + '.txt', txt);
  if (shot.result && shot.result.data) fs.writeFileSync(base + '.png', Buffer.from(shot.result.data, 'base64'));
  console.log('WROTE:', base + '.txt', '+', base + '.png');
  ws.close(); process.exit(0);
})().catch((e) => { console.log('ERR', e.message); process.exit(1); });
