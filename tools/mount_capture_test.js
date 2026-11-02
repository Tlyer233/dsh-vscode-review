/* Proof of the fast-capture theory: one mouseover + MutationObserver on the
 * mount = COMPLETE content in one shot (no settle wait). Measures time-to-full
 * and section presence. */
const WebSocket = require('/Users/xi/.vscode/extensions/dsn.dsh-review-vscode-0.1.177/node_modules/ws');
const http = require('http');
(async () => {
  const targets = await new Promise((res) => http.get('http://127.0.0.1:9223/json', (r) => { let d = ''; r.on('data', c => d += c); r.on('end', () => res(JSON.parse(d))); }));
  const wb = targets.find((x) => x.type === 'page' && (x.url || '').indexOf('vscode-file') === 0);
  const ws = new WebSocket(wb.webSocketDebuggerUrl);
  ws.on('message', (d) => {
    const m = JSON.parse(d.toString());
    if (m.id === 9) { console.log(String(m.result && m.result.result ? m.result.result.value : JSON.stringify(m.result)).slice(0, 1200)); ws.close(); process.exit(0); }
  });
  await new Promise((r) => { ws.on('open', r); });
  const EXPR = `(function(){
    var as=document.querySelectorAll('.chat-attached-context-attachment');
    var el=null;
    for(var i=0;i<as.length;i++){var a=as[i].getAttribute('aria-label')||'';if(a.indexOf('Attached element,')===0){el=as[i];break;}}
    if(!el) return JSON.stringify({err:'no element chip', total:as.length});
    return new Promise(function(resolve){
      var t0=Date.now();
      var mo=new MutationObserver(function(){
        var hv=document.querySelector('.chat-element-hover');
        if(hv){
          mo.disconnect();
          var txt=hv.textContent||'';
          var r=JSON.stringify({
            ms: Date.now()-t0,
            len: txt.length,
            hasInner: txt.indexOf('INNER TEXT')!==-1,
            hasPath: txt.indexOf('HTML PATH')!==-1,
            hasAttrs: txt.indexOf('ATTRIBUTES')!==-1,
            hasImg: !!hv.querySelector('img'),
            head: txt.slice(0,120)
          });
          // unmount
          var rr=el.getBoundingClientRect();
          var o={bubbles:true,cancelable:true,clientX:rr.left+5,clientY:rr.top+5,view:window};
          el.dispatchEvent(new PointerEvent('pointerout',Object.assign({pointerId:1,pointerType:'mouse',isPrimary:true},o)));
          el.dispatchEvent(new MouseEvent('mouseout',o));
          resolve(r);
        }
      });
      mo.observe(document.body,{childList:true,subtree:true});
      var rr=el.getBoundingClientRect();
      var o={bubbles:true,cancelable:true,clientX:rr.left+rr.width/2,clientY:rr.top+rr.height/2,view:window,buttons:0};
      el.dispatchEvent(new PointerEvent('pointerover',Object.assign({pointerId:1,pointerType:'mouse',isPrimary:true},o)));
      el.dispatchEvent(new MouseEvent('mouseover',o));
      el.dispatchEvent(new MouseEvent('mousemove',o));
      setTimeout(function(){ mo.disconnect(); resolve(JSON.stringify({err:'no-mount-3s', total:as.length})); },3000);
    });
  })()`;
  ws.send(JSON.stringify({ id: 9, method: 'Runtime.evaluate', params: { expression: EXPR, returnByValue: true, awaitPromise: true } }));
})().catch((e) => { console.log('ERR', e.message); process.exit(1); });
