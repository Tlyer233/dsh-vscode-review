/* Recapture clean screenshots: hide the injected comment host during capture. */
const WebSocket = require('/Users/xi/.vscode/extensions/dsn.dsh-review-vscode-0.1.177/node_modules/ws');
const http = require('http');
const fs = require('fs');
try { require('fs').mkdirSync(require('path').join(require('os').tmpdir(), 'dsh-probe'), { recursive: true }); } catch (e) { /* noop */ }

(async () => {
  const targets = await new Promise((res) => http.get('http://127.0.0.1:9223/json', (r) => { let d = ''; r.on('data', c => d += c); r.on('end', () => res(JSON.parse(d))); }));
  const t = targets.find((x) => (x.url || '').indexOf('10.99.0.106:8005') !== -1);
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  const handlers = {};
  ws.on('message', (d) => { const m = JSON.parse(d.toString()); if (m.id && handlers[m.id]) { handlers[m.id](m); delete handlers[m.id]; } });
  let mid = 1;
  const send = (method, params) => new Promise((resolve) => { const myId = mid++; handlers[myId] = resolve; ws.send(JSON.stringify({ id: myId, method, params: params || {} })); });
  await new Promise((r) => { ws.on('open', r); });
  const ev = async (expr) => { const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true }); return r.result && r.result.result ? r.result.result.value : null; };

  const jobs = [
    { base: require('path').join(require('os').tmpdir(), 'dsh-probe', 'probe_pins-2026-11-02T04-51-46-1'), rect: { x: 303.85546875, y: 105.12890625, w: 78.85546875, h: 24 } },
    { base: require('path').join(require('os').tmpdir(), 'dsh-probe', 'probe_pins-2026-11-02T04-51-46-2'), rect: { x: 495.4921875, y: 105.12890625, w: 76.546875, h: 24 } },
  ];
  for (const j of jobs) {
    await ev('var h=document.querySelector("[data-vscode-pick-host]"); if(h){h.setAttribute("data-dshr-bak",h.style.visibility||"");h.style.visibility="hidden";} "ok"');
    const shot = await send('Page.captureScreenshot', { format: 'png', clip: { x: Math.max(0, j.rect.x - 8), y: Math.max(0, j.rect.y - 8), width: Math.max(1, j.rect.w + 16), height: Math.max(1, j.rect.h + 16), scale: 1 } });
    await ev('var h=document.querySelector("[data-vscode-pick-host]"); if(h){h.style.visibility=h.getAttribute("data-dshr-bak")||"";h.removeAttribute("data-dshr-bak");} "ok"');
    if (shot.result && shot.result.data) { fs.writeFileSync(j.base + '.png', Buffer.from(shot.result.data, 'base64')); console.log('RECUT', j.base + '.png'); }
    else console.log('ERR', JSON.stringify(shot).slice(0, 150));
  }
  ws.close(); process.exit(0);
})().catch((e) => { console.log('ERR', e.message); process.exit(1); });
