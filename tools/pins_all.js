/* Enumerate ALL pins in the vscode-comment closed-shadow layer, pair each with
 * its highlight rect by proximity, locate each element by rect, dump one file
 * (+png) per pin. */
const WebSocket = require('/Users/xi/.vscode/extensions/dsn.dsh-review-vscode-0.1.177/node_modules/ws');
const http = require('http');
const fs = require('fs');
try { require('fs').mkdirSync(require('path').join(require('os').tmpdir(), 'dsh-probe'), { recursive: true }); } catch (e) { /* noop */ }
const OUT = require('path').join(require('os').tmpdir(), 'dsh-probe', 'probe_pins');

(async () => {
  const targets = await new Promise((res) => http.get('http://127.0.0.1:9223/json', (r) => { let d = ''; r.on('data', c => d += c); r.on('end', () => res(JSON.parse(d))); }));
  const t = targets.find((x) => (x.url || '').indexOf('10.99.0.106:8005') !== -1);
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  const handlers = {};
  ws.on('message', (d) => { const m = JSON.parse(d.toString()); if (m.id && handlers[m.id]) { handlers[m.id](m); delete handlers[m.id]; } });
  let mid = 1;
  const send = (method, params) => new Promise((resolve) => { const myId = mid++; handlers[myId] = resolve; ws.send(JSON.stringify({ id: myId, method, params: params || {} })); });
  await new Promise((r) => { ws.on('open', r); });
  await send('DOM.enable');
  const doc = await send('DOM.getDocument', { depth: -1, pierce: true });

  const pins = []; const rects = [];
  (function walk(n) {
    if (!n) return;
    const a = n.attributes || [];
    const at = {}; for (let i = 0; i + 1 < a.length; i += 2) at[a[i]] = a[i + 1];
    const cls = at.class || '';
    if (/comment-pin\b/.test(cls) && /Element comment/.test(at['aria-label'] || '')) {
      const m = /left:\s*([\d.]+)px.*?top:\s*([\d.]+)px/.exec(at.style || '');
      pins.push({ aria: at['aria-label'], left: m ? +m[1] : NaN, top: m ? +m[2] : NaN });
    }
    if (/highlight-shape/.test(cls)) {
      rects.push({ x: +at.x, y: +at.y, w: +at.width, h: +at.height, shown: !/display:\s*none/.test(at.style || '') });
    }
    for (const c of (n.children || [])) walk(c);
    for (const s of (n.shadowRoots || [])) walk(s);
  })(doc.result.root);
  console.log('PIN COUNT:', pins.length, JSON.stringify(pins));
  console.log('RECTS:', rects.length, JSON.stringify(rects));

  // pair pin -> nearest visible rect (pin bubble sits at the element's edge)
  // recipe proven by pin_hover_probe: hover each pin (CDP Input), its rect
  // materializes right then; read it, then move away.
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const getShownRect = async () => {
    const d2 = await send('DOM.getDocument', { depth: -1, pierce: true });
    let shown = null;
    (function w2(n) {
      if (!n || shown) return;
      const a = n.attributes || []; const at = {};
      for (let k = 0; k + 1 < a.length; k += 2) at[a[k]] = a[k + 1];
      if (/highlight-shape/.test(at.class || '') && !/display:\s*none/.test(at.style || '')) shown = { x: +at.x, y: +at.y, w: +at.width, h: +at.height };
      for (const c of (n.children || [])) w2(c);
      for (const s of (n.shadowRoots || [])) w2(s);
    })(d2.result.root);
    return shown;
  };
  const pairs = [];
  for (const p of pins) {
    const hx = p.left + 9; const hy = p.top + 9;
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: hx, y: hy });
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: hx + 0.5, y: hy + 0.5 });
    await sleep(300);
    const rect = await getShownRect();
    pairs.push({ pin: p, rect: rect, dist: 0, by: 'hover' });
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 5, y: 500 });
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 4, y: 502 });
    await sleep(250);
  }
  console.log('PAIRS:', JSON.stringify(pairs.map((x) => ({ n: x.pin.aria.slice(0, 30), dist: Math.round(x.dist) }))));

  for (let i = 0; i < pairs.length; i++) {
    const pair = pairs[i];
    if (!pair.rect) { console.log(i + 1, 'NO RECT for', pair.pin.aria); continue; }
    const loc = { x: pair.rect.x, y: pair.rect.y, w: pair.rect.w, h: pair.rect.h };
    const EXPR = `(function(){
      var L=${JSON.stringify(loc)};
      var els=document.querySelectorAll('*'); var hit=null;
      for (var i=0;i<els.length;i++){ var r=els[i].getBoundingClientRect();
        if (Math.abs(r.left-L.x)<1.5 && Math.abs(r.top-L.y)<1.5 && Math.abs(r.width-L.w)<1.5 && Math.abs(r.height-L.h)<1.5){ hit=els[i]; break; } }
      if (!hit) return JSON.stringify({err:'no-element-at-rect'});
      return JSON.stringify({ tag: hit.tagName.toLowerCase(), id: hit.id, cls: String(hit.className||''),
        outer: hit.outerHTML.slice(0,4000),
        attrs: Array.prototype.slice.call(hit.attributes).map(function(x){return x.name+'='+x.value}),
        inner: (hit.innerText||'').trim().slice(0,2000),
        rect: (function(){var r=hit.getBoundingClientRect();return {top:Math.round(r.top),left:Math.round(r.left),width:Math.round(r.width),height:Math.round(r.height)}})(),
        url: location.href,
        path: (function(){var p=[];var n2=hit;while(n2&&n2.tagName&&p.length<30){var nm=n2.tagName.toLowerCase();if(n2.id)nm+='#'+n2.id;else if(n2.className&&typeof n2.className==='string'&&n2.className.trim())nm+='.'+n2.className.trim().split(/\\s+/).join('.');p.unshift(nm);n2=n2.parentElement;}return p.join(' > ')})(),
        rules: (function(){var rs=[];var sheets=document.styleSheets;for(var s=0;s<sheets.length&&rs.length<60;s++){var rr;try{rr=sheets[s].cssRules}catch(e){continue}if(!rr)continue;for(var c=0;c<rr.length;c++){var ru=rr[c];if(ru.selectorText){try{if(hit.matches(ru.selectorText))rs.push(ru.selectorText+' { '+ru.style.cssText+' }')}catch(e){}}}}return rs.join(String.fromCharCode(10))})()
      });
    })()`;
    const r = await send('Runtime.evaluate', { expression: EXPR, returnByValue: true });
    let data = null; try { data = JSON.parse(String(r.result.result.value)); } catch (e) { data = { err: 'parse' }; }
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const base = OUT + '-' + stamp + '-' + (i + 1);
    if (!data || data.err) { fs.writeFileSync(base + '.txt', '# ' + pair.pin.aria + '\nERROR: ' + (data && data.err) + ' rect=' + JSON.stringify(loc) + '\n'); console.log('WROTE(err):', base); continue; }
    const shot = await send('Page.captureScreenshot', { format: 'png', clip: { x: Math.max(0, loc.x - 8), y: Math.max(0, loc.y - 8), width: Math.max(1, loc.w + 16), height: Math.max(1, loc.h + 16), scale: 1 } });
    const name = data.tag + (data.id ? '#' + data.id : (data.cls ? '.' + data.cls.trim().split(/\s+/).join('.') : ''));
    const comment = pair.pin.aria.replace(/^Element comment \d+: /, '');
    let txt = '# element: ' + name + '\n# comment: ' + comment + '\n# pin: ' + pair.pin.aria +
      '\n# pin-layer rect: ' + JSON.stringify(loc) + '\n# time: ' + new Date().toString() +
      '\n# via: probe (closed-shadow pierce; no chip/hover/panel)\n\n' +
      '## SCREENSHOT\n文件: ' + base + '.png\n\n' +
      '## URL\n' + data.url + '\n\n## ELEMENT (Outer HTML)\n' + data.outer +
      '\n\n## ATTRIBUTES\n' + data.attrs.join('\n') +
      '\n\n## INNER TEXT\n' + data.inner +
      '\n\n## POSITION & SIZE\ntop: ' + data.rect.top + 'px | left: ' + data.rect.left + 'px | width: ' + data.rect.width + 'px | height: ' + data.rect.height + 'px\n\n' +
      '## MATCHED CSS RULES\n' + (data.rules || '(none)') + '\n\n## HTML PATH\n' + data.path + '\n';
    fs.writeFileSync(base + '.txt', txt);
    if (shot.result && shot.result.data) fs.writeFileSync(base + '.png', Buffer.from(shot.result.data, 'base64'));
    console.log('WROTE:', base, name, JSON.stringify(loc));
  }
  ws.close(); process.exit(0);
})().catch((e) => { console.log('ERR', e.message); process.exit(1); });
