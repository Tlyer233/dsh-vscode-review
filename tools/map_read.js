/* PURE-READ map extraction v2 (no click, no hover, no breakpoint).
 * getEventListeners(chip) -> every click/mouseup-family listener ->
 * monaco .wrapper unwrap -> [[Scopes]] chain -> entry {kind:'element'} ->
 * serialize value + imageData. */
const WebSocket = require('/Users/xi/.vscode/extensions/dsn.dsh-review-vscode-0.1.177/node_modules/ws');
const http = require('http');
const fs = require('fs');
try { require('fs').mkdirSync(require('path').join(require('os').tmpdir(), 'dsh-probe'), { recursive: true }); } catch (e) { /* noop */ }
const OUT = require('path').join(require('os').tmpdir(), 'dsh-probe', 'probe_map');

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

  const stamp0 = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const countR = await send('Runtime.evaluate', { expression: `(function(){var as=document.querySelectorAll('.chat-attached-context-attachment');var n=0;for(var i=0;i<as.length;i++){var a=as[i].getAttribute('aria-label')||'';if(a.indexOf('Attached element,')===0)n++;}return n;})()`, returnByValue: true });
  const nChips = Number(countR.result.result.value || 0);
  console.log('CHIPS:', nChips);

  const PROBE_FN = (varName) => `function(){ try { var v = this[${JSON.stringify(varName)}]; if (v && typeof v === 'object' && v.kind === 'element' && v.value !== undefined) return ${JSON.stringify(varName)}; return ''; } catch (e) { return ''; } }`;

  for (let idx = 0; idx < nChips; idx++) {
    const seed = await evObj(`(function(){
      var as=document.querySelectorAll('.chat-attached-context-attachment'); var el=null; var n=0;
      for(var i=0;i<as.length;i++){var a=as[i].getAttribute('aria-label')||'';if(a.indexOf('Attached element,')===0){if(n===${idx}){el=as[i];break;}n++;}}
      if(!el) return null;
      var l=getEventListeners(el);
      window.__dshrAll=[];
      ['click','mouseup','auxclick','dblclick','mousedown','keydown'].forEach(function(ty){ (l[ty]||[]).forEach(function(x){ window.__dshrAll.push(x.listener); }); });
      return window.__dshrAll.length ? window.__dshrAll[0] : null;
    })()`);
    const firstId = seed.result && seed.result.result ? seed.result.result.objectId : null;
    if (!firstId) { console.log(idx, 'no listeners'); continue; }
    const nL = Number((await send('Runtime.evaluate', { expression: 'window.__dshrAll.length', returnByValue: true })).result.result.value || 1);

    let hitScope = null; let hitVar = null;
    for (let li = 0; li < nL && !hitScope; li++) {
      let fid = firstId;
      if (li > 0) { const lr = await evObj(`window.__dshrAll[${li}]`); fid = lr.result && lr.result.result ? lr.result.result.objectId : null; if (!fid) continue; }
      const p1m = await send('Runtime.getProperties', { objectId: fid, ownProperties: true });
      const wrap = ((p1m.result && p1m.result.result) || []).find((x) => x.name === 'wrapper');
      const realId = wrap && wrap.value && wrap.value.objectId ? wrap.value.objectId : fid;
      const p2m = await send('Runtime.getProperties', { objectId: realId, ownProperties: true });
      const scopeRef = ((p2m.result && p2m.result.internalProperties) || []).find((x) => x.name === '[[Scopes]]');
      let scopeObjs = [];
      if (scopeRef && scopeRef.value && scopeRef.value.objectId) {
        const coll = await send('Runtime.getProperties', { objectId: scopeRef.value.objectId, ownProperties: false });
        scopeObjs = (((coll.result || {}).result) || []).map((x) => x.value).filter((v) => v && v.objectId);
      }
      if (scopeObjs.length) console.log(idx, 'L' + li, 'scopes:', scopeObjs.length);
      const stack = scopeObjs.slice();
      const seen = new Set();
      while (stack.length && !hitScope) {
        const so = stack.shift();
        if (seen.has(so.objectId)) continue; seen.add(so.objectId);
        const spm = await send('Runtime.getProperties', { objectId: so.objectId, ownProperties: true });
        const sp = spm.result || {};
        if (sp.parent) stack.push(sp.parent);
        for (const pr of (sp.result || [])) {
          const probe = await send('Runtime.callFunctionOn', { objectId: so.objectId, functionDeclaration: PROBE_FN(pr.name), returnByValue: true, declaration: false });
          if (probe.result && probe.result.result && probe.result.result.value) { hitScope = so.objectId; hitVar = String(probe.result.result.value); break; }
        }
      }
    }
    if (!hitScope) { console.log(idx, 'entry NOT found'); continue; }
    console.log(idx, 'FOUND var', hitVar);

    const dump = await send('Runtime.callFunctionOn', {
      objectId: hitScope,
      functionDeclaration: `function(){
        try {
          var v = this[${JSON.stringify(hitVar)}];
          var imgB64 = ''; var mime = v.imageMimeType || 'image/jpeg'; var imgLen = 0;
          if (v.imageData) {
            var raw = v.imageData.buffer !== undefined ? v.imageData.buffer : v.imageData;
            var u8 = (raw instanceof Uint8Array) ? raw : new Uint8Array(raw);
            imgLen = u8.length;
            var bin = ''; for (var j = 0; j < u8.length; j += 8192) bin += String.fromCharCode.apply(null, u8.subarray(j, j + 8192));
            imgB64 = btoa(bin);
          }
          return JSON.stringify({ name: v.name, fullName: v.fullName || v.name, value: String(v.value), img: imgB64, imgLen: imgLen, mime: mime, dims: v.dimensions || null, anc: (v.ancestors || []).length, attrs: v.attributes ? Object.keys(v.attributes).length : 0, inner: (v.innerText || '').slice(0, 200), keys: Object.keys(v) });
        } catch (e) { return JSON.stringify({ err: e.message }); }
      }`,
      returnByValue: true, declaration: false
    });
    let E = null; try { E = JSON.parse(String(dump.result && dump.result.result ? dump.result.result.value : '{}')); } catch (e) { E = { err: 'parse' }; }
    if (!E || E.err) { console.log(idx, 'DUMP FAIL', JSON.stringify(E).slice(0, 150)); continue; }
    const safe = String(E.fullName || E.name || 'x').replace(/[^a-zA-Z0-9_-]+/g, '_').slice(0, 40);
    const base = OUT + '-' + stamp0 + '-' + (idx + 1) + '-' + safe;
    let txt = '# element: ' + (E.fullName || E.name) + '\n# time: ' + new Date().toString() +
      '\n# via: PURE-READ closure pierce (no click/hover/bp); keys=' + (E.keys || []).join(',') +
      '\n# dims: ' + JSON.stringify(E.dims) + ' ancestors: ' + E.anc + ' attrs: ' + E.attrs +
      '\n# innerText: ' + E.inner + '\n\n' + E.value + '\n';
    if (E.img) { const ext = E.mime === 'image/png' ? '.png' : '.jpg'; fs.writeFileSync(base + '.img' + ext, Buffer.from(E.img, 'base64')); txt += '\n## SCREENSHOT (att.imageData, ' + E.imgLen + 'B)\n文件: ' + base + '.img' + ext + '\n'; }
    fs.writeFileSync(base + '.txt', txt);
    console.log(idx, 'WROTE:', base, '| value', E.value.length + 'B | img', E.imgLen + 'B');
  }
  ws.close(); process.exit(0);
})().catch((e) => { console.log('ERR', e.message); process.exit(1); });
