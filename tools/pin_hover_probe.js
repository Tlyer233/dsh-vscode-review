/* Prove per-pin rect materialization: hover each pin via CDP Input events,
 * then read the freshly-materialized highlight rect. */
const WebSocket = require('/Users/xi/.vscode/extensions/dsn.dsh-review-vscode-0.1.177/node_modules/ws');
const http = require('http');
const fs = require('fs');

(async () => {
  const targets = await new Promise((res) => http.get('http://127.0.0.1:9223/json', (r) => { let d = ''; r.on('data', c => d += c); r.on('end', () => res(JSON.parse(d))); }));
  const t = targets.find((x) => (x.url || '').indexOf('10.99.0.106:8005') !== -1);
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  const handlers = {};
  ws.on('message', (d) => { const m = JSON.parse(d.toString()); if (m.id && handlers[m.id]) { handlers[m.id](m); delete handlers[m.id]; } });
  let mid = 1;
  const send = (method, params) => new Promise((resolve) => { const myId = mid++; handlers[myId] = resolve; ws.send(JSON.stringify({ id: myId, method, params: params || {} })); });
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  await new Promise((r) => { ws.on('open', r); });
  await send('DOM.enable');
  await send('Runtime.enable');
  const ev = async (expr) => { const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true }); return r.result && r.result.result ? r.result.result.value : null; };

  const pinsJSON = await ev(`JSON.stringify(Array.prototype.map.call(document.createTreeWalker ? [] : [], x=>x))`); void pinsJSON;
  // pins are in a CLOSED shadow: get their positions via pierce, then hover with Input events
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
  console.log('PINS:', JSON.stringify(pins));

  for (let i = 0; i < pins.length; i++) {
    const p = pins[i];
    const hx = p.left + 9; const hy = p.top + 9; // pin bubble center-ish
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: hx, y: hy });
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: hx + 0.5, y: hy + 0.5 });
    await sleep(350);
    const rect = await ev(`(function(){
      // highlight-shape lives in the closed shadow too; read via pierce-free route:
      // the workbench injects a style/geometry mirror — fallback: re-pierce below by CDP
      return null; })()`); void rect;
    const d2 = await send('DOM.getDocument', { depth: -1, pierce: true });
    let shown = [];
    (function w2(n) {
      if (!n) return;
      const a = n.attributes || []; const at = {};
      for (let k = 0; k + 1 < a.length; k += 2) at[a[k]] = a[k + 1];
      if (/highlight-shape/.test(at.class || '') && !/display:\s*none/.test(at.style || '')) shown.push({ x: +at.x, y: +at.y, w: +at.width, h: +at.height });
      for (const c of (n.children || [])) w2(c);
      for (const s of (n.shadowRoots || [])) w2(s);
    })(d2.result.root);
    console.log('hover pin', i + 1, '(' + p.aria.slice(0, 34) + ') at', hx.toFixed(0) + ',' + hy.toFixed(0), '-> shown rects:', JSON.stringify(shown));
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 5, y: 500 }); // move away
    await sleep(120);
  }
  ws.close(); process.exit(0);
})().catch((e) => { console.log('ERR', e.message); process.exit(1); });
