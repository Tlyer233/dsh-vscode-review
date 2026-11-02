const WebSocket = require('/Users/xi/.vscode/extensions/dsn.dsh-review-vscode-0.1.177/node_modules/ws');
const http = require('http');
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
  const found = [];
  (function walk(n, depth) {
    if (!n || depth > 40 || found.length > 12) return;
    const attrs = n.attributes || [];
    let cls = '', id = '', txt = '';
    for (let i = 0; i + 1 < attrs.length; i += 2) {
      if (attrs[i] === 'class') cls = attrs[i + 1];
      if (attrs[i] === 'id') id = attrs[i + 1];
    }
    if (n.childNodeCount === 0 && n.nodeValue && /^[1-9]$/.test(String(n.nodeValue).trim())) {
      found.push({ text: String(n.nodeValue).trim(), parentTag: n.parent && n.parent.nodeName, outerHint: (n.nodeName || '') + ' cls=' + cls.slice(0, 60) + ' id=' + id.slice(0, 30) });
      console.log('NUM NODE:', n.nodeName, 'cls=', cls.slice(0, 70), 'id=', id.slice(0, 30), 'value=', String(n.nodeValue).trim(), 'shadowRootType=', (n.parent && n.parent.shadowRootType) || '-');
    }
    if ((cls + ' ' + id).match(/pin|comment|marker|badge/) && (cls + id).match(/browser|vscode|element/i)) {
      console.log('CLASS HIT:', n.nodeName, cls.slice(0, 80), id.slice(0, 40));
    }
    for (const c of (n.children || [])) walk(c, depth + 1);
    if (n.shadowRoots) for (const s of n.shadowRoots) walk(s, depth + 1);
    if (n.pseudoElements) for (const p of n.pseudoElements) walk(p, depth + 1);
    if (n.contentDocument) walk(n.contentDocument, depth + 1);
  })(doc.result && doc.result.root, 0);
  console.log('total numeric-text nodes pierced:', found.length);
  ws.close(); process.exit(0);
})().catch((e) => { console.log('ERR', e.message); process.exit(1); });
