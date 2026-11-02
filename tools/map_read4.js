/* map_read v4: chip -> listeners -> scope variables (values via getProperties
 * objectIds) -> probe each object value for the element entry or the widget
 * holding .attachment. PURE READ. */
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

  const PROBE = `function(){ try {
    if (this && typeof this === 'object') {
      if (this.kind === 'element' && this.value !== undefined) return 'ENTRY';
      if (this.attachment && this.attachment.kind === 'element') return 'WIDGET';
    }
    return '';
  } catch (e) { return ''; } }`;

  for (let idx = 0; idx < nChips; idx++) {
    const seed = await evObj(`(function(){
      var as=document.querySelectorAll('.chat-attached-context-attachment'); var el=null; var n=0;
      for(var i=0;i<as.length;i++){var a=as[i].getAttribute('aria-label')||'';if(a.indexOf('Attached element,')===0){if(n===${idx}){el=as[i];break;}n++;}}
      if(!el) return null;
      var l=getEventListeners(el);
      window.__L=[];
      Object.keys(l).forEach(function(ty){ (l[ty]||[]).forEach(function(x){ window.__L.push(x.listener); }); });
      return window.__L.length ? window.__L[0] : null;
    })()`);
    const nL = Number((await send('Runtime.evaluate', { expression: 'window.__L.length', returnByValue: true })).result.result.value || 0);
    let entryOid = null;
    for (let li = 0; li < nL && !entryOid; li++) {
      const lr = li === 0 ? seed : await evObj(`window.__L[${li}]`);
      const fid = lr.result && lr.result.result ? lr.result.result.objectId : null;
      if (!fid) continue;
      const p2m = await send('Runtime.getProperties', { objectId: fid, ownProperties: false });
      const R = p2m.result || {};
      const sc = (R.internalProperties || []).find((x) => x.name === '[[Scopes]]');
      if (!sc || !sc.value || !sc.value.objectId) continue;
      const coll = await send('Runtime.getProperties', { objectId: sc.value.objectId, ownProperties: false });
      const scopeObjs = (((coll.result || {}).result) || []).map((x) => x.value).filter((v) => v && v.objectId);
      for (const so of scopeObjs) {
        const sp = await send('Runtime.getProperties', { objectId: so.objectId, ownProperties: true, generatePreview: true });
        for (const pr of (((sp.result || {}).result) || [])) {
          const vo = pr.value;
          if (!vo || !vo.objectId) continue;
          const chk = await send('Runtime.callFunctionOn', { objectId: vo.objectId, functionDeclaration: PROBE, returnByValue: true, declaration: false });
          const v = ((chk.result || {}).result || {}).value || '';
          if (v === 'ENTRY') { entryOid = vo.objectId; console.log(idx, 'L' + li, 'direct ENTRY var', pr.name); break; }
          if (v === 'WIDGET') {
            entryOid = await (async () => { const a = await send('Runtime.callFunctionOn', { objectId: vo.objectId, functionDeclaration: 'function(){ return this.attachment; }', returnByValue: false }); return a.result && a.result.result ? a.result.result.objectId : null; })();
            console.log(idx, 'L' + li, 'WIDGET var', pr.name, '-> attachment'); break;
          }
        }
        if (entryOid) break;
      }
    }
    if (!entryOid) { console.log(idx, 'entry NOT found'); continue; }

    const dump = await send('Runtime.callFunctionOn', {
      objectId: entryOid,
      functionDeclaration: `function(){
        try {
          var a = this;
          var imgB64 = ''; var imgLen = 0; var mime = a.imageMimeType || 'image/jpeg';
          if (a.imageData) {
            var raw = a.imageData.buffer !== undefined ? a.imageData.buffer : a.imageData;
            var u8 = (raw instanceof Uint8Array) ? raw : new Uint8Array(raw);
            imgLen = u8.length;
            var bin = ''; for (var j = 0; j < u8.length; j += 8192) bin += String.fromCharCode.apply(null, u8.subarray(j, j + 8192));
            imgB64 = btoa(bin);
          }
          return JSON.stringify({ name: a.name, fullName: a.fullName || a.name, value: String(a.value), img: imgB64, imgLen: imgLen, mime: mime, dims: a.dimensions || null, anc: (a.ancestors || []).length, attrs: a.attributes || null, inner: (a.innerText || '').slice(0, 300), keys: Object.keys(a) });
        } catch (e) { return JSON.stringify({ err: e.message }); }
      }`,
      returnByValue: true, declaration: false
    });
    let E = null; try { E = JSON.parse(String((dump.result || {}).result ? dump.result.result.value : '{}')); } catch (e) { E = { err: 'parse' }; }
    if (!E || E.err) { console.log(idx, 'DUMP FAIL', JSON.stringify(E).slice(0, 160)); continue; }
    const safe = String(E.fullName || E.name || 'x').replace(/[^a-zA-Z0-9_-]+/g, '_').slice(0, 40);
    const base = OUT + '-' + stamp0 + '-' + (idx + 1) + '-' + safe;
    let txt = '# element: ' + (E.fullName || E.name) + '\n# time: ' + new Date().toString() +
      '\n# via: PURE-READ (getEventListeners -> scope var values -> element entry)' +
      '\n# keys: ' + (E.keys || []).join(',') +
      '\n# dims: ' + JSON.stringify(E.dims) + ' ancestors: ' + E.anc + ' attrs: ' + JSON.stringify(E.attrs || {}).slice(0, 140) +
      '\n# innerText: ' + E.inner.slice(0, 120) + '\n\n' + E.value + '\n';
    if (E.img) { const ext = E.mime === 'image/png' ? '.png' : '.jpg'; fs.writeFileSync(base + '.img' + ext, Buffer.from(E.img, 'base64')); txt += '\n## SCREENSHOT (att.imageData, ' + E.imgLen + 'B)\n文件: ' + base + '.img' + ext + '\n'; }
    fs.writeFileSync(base + '.txt', txt);
    console.log(idx, 'WROTE:', base, '| value', E.value.length + 'B | img', E.imgLen + 'B');
  }
  ws.close(); process.exit(0);
})().catch((e) => { console.log('ERR', e.message); process.exit(1); });
