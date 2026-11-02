const WebSocket = require('/Users/xi/.vscode/extensions/dsn.dsh-review-vscode-0.1.177/node_modules/ws');
const http = require('http');
(async () => {
  const targets = await new Promise((res) => http.get('http://127.0.0.1:9223/json', (r) => { let d = ''; r.on('data', c => d += c); r.on('end', () => res(JSON.parse(d))); }));
  const t = targets.find((x) => x.type === 'page' && (x.title || '').indexOf('Strata (') !== -1);
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  const handlers = {};
  ws.on('message', (d) => { const m = JSON.parse(d.toString()); if (m.id && handlers[m.id]) { handlers[m.id](m); delete handlers[m.id]; } });
  let mid = 1;
  const send = (method, params) => new Promise((resolve) => { const myId = mid++; handlers[myId] = resolve; ws.send(JSON.stringify({ id: myId, method, params: params || {} })); });
  await new Promise((r) => { ws.on('open', r); });
  await send('DOM.enable');
  // probe several candidate points along the pin (from screenshot analysis)
  const pts = [[617, 125], [612, 120], [623, 130], [617, 104], [400, 400]];
  for (const [x, y] of pts) {
    const r = await send('DOM.getNodeForLocation', { x, y, fromPoint: true, includeUserAgentShadowDOM: true });
    console.log('at', x, y, '->', JSON.stringify(r.result || r.error).slice(0, 120));
    const bnid = r.result && r.result.backendNodeId;
    if (bnid) {
      const d = await send('DOM.describeNode', { backendNodeId: bnid });
      const n = d.result && d.result.node;
      console.log('   node:', n ? (n.nodeName + ' frame=' + String(r.result.frameId).slice(0, 12) + ' attrs=' + String(n.attributes || []).join('|').slice(0, 140)) : 'none');
    }
  }
  ws.close(); process.exit(0);
})().catch((e) => { console.log('ERR', e.message); process.exit(1); });
