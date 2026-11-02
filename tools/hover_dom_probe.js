/* Is the element-attachment hover content DOM present WITHOUT hovering? */
const WebSocket = require('/Users/xi/.vscode/extensions/dsn.dsh-review-vscode-0.1.177/node_modules/ws');
const http = require('http');
(async () => {
  const targets = await new Promise((res) => http.get('http://127.0.0.1:9223/json', (r) => { let d = ''; r.on('data', c => d += c); r.on('end', () => res(JSON.parse(d))); }));
  const wb = targets.find((x) => x.type === 'page' && (x.url || '').indexOf('vscode-file') === 0);
  const ws = new WebSocket(wb.webSocketDebuggerUrl);
  ws.on('message', (d) => {
    const m = JSON.parse(d.toString());
    if (m.id === 9) {
      console.log('IN-DOCUMENT:', String(m.result && m.result.result ? m.result.result.value : JSON.stringify(m.result)).slice(0, 900));
      ws.close(); process.exit(0);
    }
  });
  await new Promise((r) => { ws.on('open', r); });
  const EXPR = `(function(){
    var q=function(sel){return Array.prototype.slice.call(document.querySelectorAll(sel))};
    var hovers=q('.chat-attached-context-hover');
    var elem=q('.chat-element-hover');
    var views=q('.context-view');
    var info=function(list){return list.map(function(el){var r=el.getBoundingClientRect?el.getBoundingClientRect():{};return {cls:String(el.className).slice(0,70),inDoc:document.contains(el),w:Math.round(r.width||0),h:Math.round(r.height||0),txt:(el.textContent||'').trim().slice(0,80)}})};
    return JSON.stringify({contextHover:info(hovers),elementHover:info(elem),contextViews:info(views)}, null, 1);
  })()`;
  ws.send(JSON.stringify({ id: 9, method: 'Runtime.evaluate', params: { expression: EXPR, returnByValue: true } }));
})().catch((e) => { console.log('ERR', e.message); process.exit(1); });
