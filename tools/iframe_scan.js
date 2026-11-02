const WebSocket = require('/Users/xi/.vscode/extensions/dsn.dsh-review-vscode-0.1.177/node_modules/ws');
const http = require('http');

const EXPR = require('fs').readFileSync(require('path').join(require('os').tmpdir(), 'dsh-probe', 'tools/pin_wb_probe.js'),'utf8');

(async () => {
  const targets = await new Promise((res) => http.get('http://127.0.0.1:9223/json', (r) => { let d = ''; r.on('data', c => d += c); r.on('end', () => res(JSON.parse(d))); }));
  const ts = targets.filter((x) => x.webSocketDebuggerUrl && (x.type === 'iframe' || x.type === 'page'));
  for (const t of ts) {
    try {
      const ws = new WebSocket(t.webSocketDebuggerUrl);
      const handlers = {};
      ws.on('message', (d) => { const m = JSON.parse(d.toString()); if (m.id && handlers[m.id]) { handlers[m.id](m); delete handlers[m.id]; } });
      await new Promise((r, rj) => { ws.on('open', r); ws.on('error', rj); setTimeout(rj, 3000); });
      const r = await new Promise((resolve) => { handlers[9] = resolve; ws.send(JSON.stringify({ id: 9, method: 'Runtime.evaluate', params: { expression: EXPR, returnByValue: true } })); });
      const v = r && r.result && r.result.result ? r.result.result.value : JSON.stringify(r && r.result ? r.result : r).slice(0, 120);
      console.log('## ' + (t.title || t.url || '?').slice(0, 46) + '\n   ' + String(v).slice(0, 700));
      ws.close();
    } catch (e) { console.log('## ' + (t.title || '').slice(0, 30) + ' ERR ' + String(e).slice(0, 60)); }
  }
  process.exit(0);
})().catch((e) => { console.log('ERR', e.message); process.exit(1); });
