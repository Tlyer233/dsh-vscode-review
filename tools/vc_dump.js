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
  function attrsStr(n) { const a = n.attributes || []; const p = []; for (let i = 0; i + 1 < a.length; i += 2) p.push(a[i] + '=' + String(a[i + 1]).slice(0, 70)); return p.join(' '); }
  function dump(n, depth, inTree) {
    if (!n || depth > 30) return;
    const interesting = inTree || /vscode-comment|comment/i.test(attrsStr(n)) || n.nodeName === 'IFRAME';
    if (interesting) {
      console.log('  '.repeat(Math.min(depth, 12)) + n.nodeName + (n.shadowRootType ? '[shadow:' + n.shadowRootType + ']' : '') + ' ' + attrsStr(n).slice(0, 150) + (n.nodeValue && String(n.nodeValue).trim() ? ' TEXT=' + String(n.nodeValue).trim().slice(0, 40) : ''));
    }
    for (const c of (n.children || [])) dump(c, depth + 1, interesting);
    for (const s of (n.shadowRoots || [])) dump(s, depth + 1, true);
  }
  // find the anchor chain: host elements that own shadow roots containing vscode-comment
  function findHosts(n, chain, depth) {
    if (!n || depth > 40) return;
    const hasVC = /vscode-comment/.test(attrsStr(n));
    if (hasVC) {
      console.log('VC NODE:', chain.concat([n.nodeName + ' ' + attrsStr(n).slice(0, 120)]).join(' > ').slice(0, 600));
    }
    const nchain = chain.concat([n.nodeName + (attrsStr(n).match(/id=[^\s]+/) ? ' ' + attrsStr(n).match(/id=[^\s]+/)[0] : '')]).slice(-4);
    for (const c of (n.children || [])) findHosts(c, nchain, depth + 1);
    for (const s of (n.shadowRoots || [])) { if (s.shadowRootType === 'user-agent') continue; console.log('SHADOW of <' + n.nodeName + '> ' + attrsStr(n).slice(0, 110) + ' type=' + (s.shadowRootType || '?')); dump(s, 0, false); }
  }
  findHosts(doc.result.root, [], 0);
  ws.close(); process.exit(0);
})().catch((e) => { console.log('ERR', e.message); process.exit(1); });
