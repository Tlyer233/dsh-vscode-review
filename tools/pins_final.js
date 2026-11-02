/* FINAL recipe, one continuous pass per pin:
 * hover pin (Input) -> read materialized rect (pierce) -> locate element by
 * rect -> hide comment host -> screenshot clip -> restore host -> move away. */
const WebSocket = require('/Users/xi/.vscode/extensions/dsn.dsh-review-vscode-0.1.177/node_modules/ws');
const http = require('http');
const fs = require('fs');
try { require('fs').mkdirSync(require('path').join(require('os').tmpdir(), 'dsh-probe'), { recursive: true }); } catch (e) { /* noop */ }
const OUT = require('path').join(require('os').tmpdir(), 'dsh-probe', 'probe_pins2');

(async () => {
  const targets = await new Promise((res) => http.get('http://127.0.0.1:9223/json', (r) => { let d = ''; r.on('data', c => d += c); r.on('end', () => res(JSON.parse(d))); }));
  const t = targets.find((x) => (x.url || '').indexOf('10.99.0.106:8005') !== -1);
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  const handlers = {};
  ws.on('message', (d) => { const m = JSON.parse(d.toString()); if (m.id && handlers[m.id]) { handlers[m.id](m); delete handlers[m.id]; } });
  let mid = 1;
  const send = (method, params) => new Promise((resolve) => { const myId = mid++; handlers[myId] = resolve; ws.send(JSON.stringify({ id: myId, method, params: params || {} })); });
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const ev = async (expr) => { const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true }); return r.result && r.result.result ? r.result.result.value : null; };
  await new Promise((r) => { ws.on('open', r); });
  await send('DOM.enable');

  const getPins = async () => {
    const doc = await send('DOM.getDocument', { depth: -1, pierce: true });
    const pins = [];
    (function walk(n) {
      if (!n) return;
      const a = n.attributes || []; const at = {};
      for (let i = 0; i + 1 < a.length; i += 2) at[a[i]] = a[i + 1];
      if (/comment-pin\b/.test(at.class || '') && /Element comment/.test(at['aria-label'] || '')) {
        const m = /left:\s*([\d.]+)px.*?top:\s*([\d.]+)px/.exec(at.style || '');
        pins.push({ aria: at['aria-label'], left: m ? +m[1] : 0, top: m ? +m[2] : 0 });
      }
      for (const c of (n.children || [])) walk(c);
      for (const s of (n.shadowRoots || [])) walk(s);
    })(doc.result.root);
    return { doc, pins };
  };
  const getShownRect = async (docPre) => {
    const d2 = docPre || await send('DOM.getDocument', { depth: -1, pierce: true });
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

  const EXPR_BODY = `(function(){
    var L=LOCJSON;
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

  const first = await getPins();
  console.log('PINS:', first.pins.length, JSON.stringify(first.pins.map((p) => p.aria)));
  for (let i = 0; i < first.pins.length; i++) {
    const p = first.pins[i];
    const hx = p.left + 9; const hy = p.top + 9;
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: hx, y: hy });
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: hx + 0.5, y: hy + 0.5 });
    await sleep(260);
    const rect = await getShownRect();
    if (!rect) { console.log(i + 1, 'NO RECT'); continue; }
    // hide injected layer, then capture + locate back-to-back
    await ev('var h=document.querySelector("[data-vscode-pick-host]"); if(h){h.setAttribute("data-dshr-bak",h.style.visibility||"");h.style.visibility="hidden";} "ok"');
    const r = await send('Runtime.evaluate', { expression: EXPR_BODY.replace('LOCJSON', JSON.stringify(rect)), returnByValue: true });
    const shot = await send('Page.captureScreenshot', { format: 'png', clip: { x: Math.max(0, rect.x - 8), y: Math.max(0, rect.y - 8), width: Math.max(1, rect.w + 16), height: Math.max(1, rect.h + 16), scale: 1 } });
    await ev('var h=document.querySelector("[data-vscode-pick-host]"); if(h){h.style.visibility=h.getAttribute("data-dshr-bak")||"";h.removeAttribute("data-dshr-bak");} "ok"');
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 5, y: 600 });
    let data = null; try { data = JSON.parse(String(r.result && r.result.result ? r.result.result.value : '')); } catch (e) { data = { err: 'parse' }; }
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const base = OUT + '-' + stamp + '-' + (i + 1);
    const comment = p.aria.replace(/^Element comment \d+: /, '');
    if (!data || data.err) { fs.writeFileSync(base + '.txt', '# ' + p.aria + '\nERROR: ' + (data && data.err) + ' rect=' + JSON.stringify(rect) + '\n'); console.log('ERR pin' + (i + 1), (data && data.err) || 'parse', JSON.stringify(rect)); continue; }
    const name = data.tag + (data.id ? '#' + data.id : (data.cls ? '.' + data.cls.trim().split(/\s+/).join('.') : ''));
    let txt = '# element: ' + name + '\n# comment: ' + comment + '\n# pin: ' + p.aria +
      '\n# time: ' + new Date().toString() + '\n# via: pin-layer probe (pierce+hover-rect; clean shot)\n\n' +
      '## SCREENSHOT\n文件: ' + base + '.png\n\n' +
      '## URL\n' + data.url + '\n\n## ELEMENT (Outer HTML)\n' + data.outer +
      '\n\n## ATTRIBUTES\n' + data.attrs.join('\n') +
      '\n\n## INNER TEXT\n' + data.inner +
      '\n\n## POSITION & SIZE\ntop: ' + data.rect.top + 'px | left: ' + data.rect.left + 'px | width: ' + data.rect.width + 'px | height: ' + data.rect.height + 'px\n\n' +
      '## MATCHED CSS RULES\n' + (data.rules || '(none)') + '\n\n## HTML PATH\n' + data.path + '\n';
    fs.writeFileSync(base + '.txt', txt);
    if (shot.result && shot.result.data) fs.writeFileSync(base + '.png', Buffer.from(shot.result.data, 'base64'));
    console.log('OK pin' + (i + 1), name, '->', base);
  }
  ws.close(); process.exit(0);
})().catch((e) => { console.log('ERR', e.message); process.exit(1); });
