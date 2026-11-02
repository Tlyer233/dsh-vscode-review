/* Closure-pierce proof: chip DOM element -> its click listener -> closure ->
 * widget instance -> attachment entry (the <chip, content> map) WITHOUT any
 * hover. Read-only. */
const WebSocket = require('/Users/xi/.vscode/extensions/dsn.dsh-review-vscode-0.1.177/node_modules/ws');
const http = require('http');
(async () => {
  const targets = await new Promise((res) => http.get('http://127.0.0.1:9223/json', (r) => { let d = ''; r.on('data', c => d += c); r.on('end', () => res(JSON.parse(d))); }));
  const wb = targets.find((x) => x.type === 'page' && (x.url || '').indexOf('vscode-file') === 0);
  const ws = new WebSocket(wb.webSocketDebuggerUrl);
  const handlers = {};
  ws.on('message', (d) => { const m = JSON.parse(d.toString()); if (m.id && handlers[m.id]) { handlers[m.id](m); delete handlers[m.id]; } });
  let mid = 1;
  const send = (method, params) => new Promise((resolve) => { const myId = mid++; handlers[myId] = resolve; ws.send(JSON.stringify({ id: myId, method, params: params || {} })); });
  await new Promise((r) => { ws.on('open', r); });

  // 1) chip element objectId
  const chip = await send('Runtime.evaluate', { expression: `(function(){var as=document.querySelectorAll('.chat-attached-context-attachment');for(var i=0;i<as.length;i++){var a=as[i].getAttribute('aria-label')||'';if(a.indexOf('Attached element,')===0)return as[i];}return null;})()`, returnByValue: false });
  const chipId = chip.result && chip.result.result ? chip.result.result.objectId : null;
  if (!chipId) { console.log('no chip element'); process.exit(0); }
  console.log('chip objectId ok');

  // 2) its event listeners (click/mouseup) -> listener function objectIds
  const ls = await send('DOMDebugger.getEventListeners', { objectId: chipId, depth: -1 });
  const listeners = (ls.result && ls.result.listeners) || [];
  console.log('LISTENER TYPES:', listeners.map((l) => l.type + (l.useCapture ? '(cap)' : '')).join(','));
  console.log('RAW LISTENER[0]:', JSON.stringify(listeners[0]).slice(0, 300));
  for (const cand of listeners) {
    const fnId = cand.objectId;
    if (cand.type !== 'click' && cand.type !== 'mouseup') continue;
    if (!fnId) continue;
    let desc = '';
    try {
      const ts = await send('Runtime.callFunctionOn', { objectId: fnId, functionDeclaration: 'function(){ return this.toString(); }', returnByValue: true });
      desc = String(ts.result && ts.result.result ? ts.result.result.value : '').slice(0, 120);
    } catch (e) { desc = 'ERR ' + String(e).slice(0, 60); }
    const p1 = await send('Runtime.getProperties', { objectId: fnId });
    const own = (p1.result || []).filter((x) => x.name !== 'length' && x.name !== 'name' && x.name !== 'prototype').map((x) => x.name);
    const intr = (p1.internalProperties || []).map((x) => x.name);
    console.log('== L', cand.type, cand.useCapture ? '(cap)' : '', '| own:', own.join(',') || '-', '| internal:', intr.join(',') || '-');
    console.log('   SRC:', desc.replace(/\n/g, ' '));
    const scopeRef = (p1.internalProperties || []).find((x) => x.name === '[[Scopes]]');
    const entries = scopeRef && scopeRef.value && scopeRef.value.entries ? scopeRef.value.entries : [];
    for (const s of entries) {
      const sid = s.value && s.value.objectId; if (!sid) continue;
      const sp = await send('Runtime.getProperties', { objectId: sid, ownProperties: true });
      const names = (sp.result || []).map((x) => x.name);
      if (names.length) console.log('     scope[' + (s.value.description || '?').slice(0, 30) + ']:', names.slice(0, 20).join(','));
    }
  }
  ws.close(); process.exit(0);
})().catch((e) => { console.log('ERR', e.message); process.exit(1); });
