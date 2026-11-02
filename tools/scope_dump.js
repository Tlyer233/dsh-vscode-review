/* Diagnostic: dump scope variable names + shapes for every listener of chip0 */
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
  const evObj = (expression) => send('Runtime.evaluate', { expression, returnByValue: false, includeCommandLineAPI: true });
  await new Promise((r) => { ws.on('open', r); });

  await evObj(`(function(){
    var as=document.querySelectorAll('.chat-attached-context-attachment'); var el=null;
    for(var i=0;i<as.length;i++){var a=as[i].getAttribute('aria-label')||'';if(a.indexOf('Attached element,')===0){el=as[i];break;}}
    var l=getEventListeners(el);
    window.__dshrAll=[];
    Object.keys(l).forEach(function(ty){ (l[ty]||[]).forEach(function(x){ window.__dshrAll.push({ty:ty, fn:x.listener}); }); });
    return window.__dshrAll.length;
  })()`);
  const n = Number((await send('Runtime.evaluate', { expression: 'window.__dshrAll.length', returnByValue: true })).result.result.value);
  console.log('ALL LISTENERS:', n);

  for (let li = 0; li < n; li++) {
    const meta = await send('Runtime.evaluate', { expression: `window.__dshrAll[${li}].ty`, returnByValue: true });
    const lr = await evObj(`window.__dshrAll[${li}].fn`);
    const fid = lr.result && lr.result.result ? lr.result.result.objectId : null;
    if (!fid) continue;
    const p1 = await send('Runtime.getProperties', { objectId: fid, ownProperties: true });
    const props = ((p1.result || {}).result) || [];
    const wrap = props.find((x) => x.name === 'wrapper');
    const realId = wrap && wrap.value && wrap.value.objectId ? wrap.value.objectId : fid;
    const srcR = await send('Runtime.callFunctionOn', { objectId: realId, functionDeclaration: 'function(){ return this.toString().slice(0,110); }', returnByValue: true });
    const src = String((srcR.result || {}).result ? srcR.result.result.value : '?').replace(/\n/g, ' ');
    const p2 = await send('Runtime.getProperties', { objectId: realId, ownProperties: false });
    const R = p2.result || {};
    const sc = (R.internalProperties || []).find((x) => x.name === '[[Scopes]]');
    let names = [];
    if (sc && sc.value && sc.value.objectId) {
      const coll = await send('Runtime.getProperties', { objectId: sc.value.objectId, ownProperties: false });
      const scopeObjs = (((coll.result || {}).result) || []).map((x) => x.value).filter((v) => v && v.objectId);
      for (const so of scopeObjs) {
        const sp = await send('Runtime.getProperties', { objectId: so.objectId, ownProperties: true });
        for (const pr of (((sp.result || {}).result) || [])) {
          const shape = await send('Runtime.callFunctionOn', {
            objectId: so.objectId,
            functionDeclaration: `function(){ try { var v = this[${JSON.stringify(pr.name)}]; if (v === null) return 'null'; var t = typeof v; if (t !== 'object') return t; var ks = Object.keys(v).slice(0, 8); return 'obj{kind:' + (v.kind || '?') + ' keys:' + ks.join(',') + '}'; } catch (e) { return 'ERR'; } }`,
            returnByValue: true, declaration: false
          });
          names.push(pr.name + ':' + String(((shape.result || {}).result || {}).value || '?'));
        }
      }
    }
    console.log('== L', li, meta.result.result.value, '|', wrap ? 'WRAPPED' : 'raw');
    console.log('   SRC:', src);
    if (names.length) console.log('   VARS:', names.slice(0, 14).join(' | ').slice(0, 420));
  }
  ws.close(); process.exit(0);
})().catch((e) => { console.log('ERR', e.message); process.exit(1); });
