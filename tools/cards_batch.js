/* Probe-only batch: for every Copilot element chip, capture its hover card via
 * mount-observer (one shot), lift the card image, write txt+png files. */
const WebSocket = require('/Users/xi/.vscode/extensions/dsn.dsh-review-vscode-0.1.177/node_modules/ws');
const http = require('http');
const fs = require('fs');
try { require('fs').mkdirSync(require('path').join(require('os').tmpdir(), 'dsh-probe'), { recursive: true }); } catch (e) { /* noop */ }
const OUT = require('path').join(require('os').tmpdir(), 'dsh-probe', 'probe_card');

(async () => {
  const targets = await new Promise((res) => http.get('http://127.0.0.1:9223/json', (r) => { let d = ''; r.on('data', c => d += c); r.on('end', () => res(JSON.parse(d))); }));
  const wb = targets.find((x) => x.type === 'page' && (x.url || '').indexOf('vscode-file') === 0);
  const ws = new WebSocket(wb.webSocketDebuggerUrl);
  const handlers = {};
  ws.on('message', (d) => { const m = JSON.parse(d.toString()); if (m.id && handlers[m.id]) { handlers[m.id](m); delete handlers[m.id]; } });
  let mid = 1;
  const send = (method, params) => new Promise((resolve) => { const myId = mid++; handlers[myId] = resolve; ws.send(JSON.stringify({ id: myId, method, params: params || {} })); });
  await new Promise((r) => { ws.on('open', r); });
  const ev = async (expr) => { const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }); return r.result && r.result.result ? r.result.result.value : JSON.stringify(r.result && r.result.exceptionDetails ? r.result.exceptionDetails.text : r.result).slice(0, 200); };

  const names = await ev(`JSON.stringify((function(){var o=[];var as=document.querySelectorAll('.chat-attached-context-attachment');for(var i=0;i<as.length;i++){var a=as[i].getAttribute('aria-label')||'';if(a.indexOf('Attached element,')===0)o.push(a.slice(18,a.length-9));}return o;})())`);
  const chips = JSON.parse(String(names || '[]'));
  console.log('CHIPS:', JSON.stringify(chips));
  if (!chips.length) { console.log('no chips — annotate something first'); process.exit(0); }

  // best-effort comment lines from the copilot input
  const linesRaw = await ev(`JSON.stringify((function(){var o=[];var eds=document.querySelectorAll('.chat-input [contenteditable="true"],[data-composer-card] [contenteditable="true"]');for(var i=0;i<eds.length;i++){var t=(eds[i].innerText||'').trim();if(t)o.push(t);}return o;})())`);
  const lines = JSON.parse(String(linesRaw || '[]'));
  console.log('LINES:', JSON.stringify(lines));

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const realMove = async (x, y) => { await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y }); };
  const chipPos = async (idx) => JSON.parse(String(await ev("(function(){var as=document.querySelectorAll('.chat-attached-context-attachment');var n=0;for(var i=0;i<as.length;i++){var a=as[i].getAttribute('aria-label')||'';if(a.indexOf('Attached element,')===0){if(n===" + String(idx) + "){var r=as[i].getBoundingClientRect();return JSON.stringify({x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)});}n++;}}return '{}';})()")));
  const stamp0 = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  for (let i = 0; i < chips.length; i++) {
    const name = chips[i];
    await realMove(5, 600); await sleep(400);
    const cleanState = await ev(`document.querySelector('.chat-element-hover')?'still-mounted':'clean'`);
    if (String(cleanState) !== 'clean') { await realMove(2, 300); await sleep(500); }
    const arm = (async () => { const p = await ev(`(function(){
      var as=document.querySelectorAll('.chat-attached-context-attachment'); var el=null; var n=0;
      var as=document.querySelectorAll('.chat-attached-context-attachment'); var el=null;
      for(var i2=0;i2<as.length;i2++){var a=as[i2].getAttribute('aria-label')||'';if(a.indexOf('Attached element,')===0){if(n===${i}){el=as[i2];break;}n++;}}
      if(!el) return JSON.stringify({err:'chip-gone'});
      return new Promise(function(resolve){
        var t0=Date.now();
        var mo=new MutationObserver(function(){
          var hv=document.querySelector('.chat-element-hover');
          if(hv){
            mo.disconnect();
            var img=hv.querySelector('img'); var imgData=''; var imgKind='';
            if(img){ imgKind = img.src.slice(0,20); if(img.src.indexOf('data:')===0) imgData=img.src.slice(img.src.indexOf(',')+1); else if(img.src.indexOf('blob:')===0){ try{ var cv=document.createElement('canvas'); cv.width=img.naturalWidth; cv.height=img.naturalHeight; cv.getContext('2d').drawImage(img,0,0); imgData=cv.toDataURL('image/png').split(',')[1]; imgKind='blob->png'; }catch(e){ imgKind='blob-taint:'+e.message; } } }
            resolve(JSON.stringify({ ms:Date.now()-t0, text:(hv.textContent||''), img:imgData||null, imgKind:imgKind }));
          }
        });
        mo.observe(document.body,{childList:true,subtree:true});
        var rr=el.getBoundingClientRect();
        window.__armTarget={x:Math.round(rr.left+rr.width/2),y:Math.round(rr.top+rr.height/2)};
        setTimeout(function(){ mo.disconnect(); resolve(JSON.stringify({err:'timeout-4s'})); },4000);
      });
    })()`, true); return p; })();
    const pos = await chipPos(i);
    if (pos.x) { await realMove(pos.x - 3, pos.y - 3); await realMove(pos.x, pos.y); }
    const one = await arm;
    let card = null; try { card = JSON.parse(String(one)); } catch (e) { card = { err: 'parse:' + String(one).slice(0, 80) }; }
    if (!card || card.err) { console.log(i + 1, name, 'FAIL', JSON.stringify(card).slice(0, 120)); continue; }
    const lineHit = lines.find((l) => l.indexOf('@' + name) !== -1);
    const comment = lineHit ? lineHit.slice(lineHit.indexOf('@' + name) + name.length + 1).trim() : '';
    const text2 = String(card.text).replace(/KEY COMPUTED STYLES[\s\S]*?HTML PATH/, '(computed styles omitted) HTML PATH');
    const safe = name.replace(/[^a-zA-Z0-9_-]+/g, '_').slice(0, 40);
    const base = OUT + '-' + stamp0 + '-' + (i + 1) + '-' + safe;
    let pngRef = '';
    if (card.img) { fs.writeFileSync(base + '.png', Buffer.from(card.img, 'base64')); pngRef = '## SCREENSHOT\n文件: ' + base + '.png\n\n'; }
    const head = '# element: ' + name + '\n# comment: ' + comment + '\n# time: ' + new Date().toString() +
      '\n# via: probe (mount-capture ' + card.ms + 'ms, img=' + (card.imgKind || 'none') + ')\n\n';
    fs.writeFileSync(base + '.txt', head + pngRef + text2 + '\n');
    console.log('WROTE:', base, 'text', String(card.text).length + 'B', 'png', card.img ? 'y' : 'n', 'ms', card.ms);
  }
  ws.close(); process.exit(0);
})().catch((e) => { console.log('ERR', e.message); process.exit(1); });
