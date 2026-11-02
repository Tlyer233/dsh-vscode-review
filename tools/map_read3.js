/* map_read v3: chip -> any arrow listener -> scope '(this)' = widget ->
 * widget.attachment = the <chip, CDP-content> entry. PURE READ. */
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

  for (let idx = 0; idx < nChips; idx++) {
    // seed: first listener fn of this chip
    const seed = await evObj(`(function(){
      var as=document.querySelectorAll('.chat-attached-context-attachment'); var el=null; var n=0;
      for(var i=0;i<as.length;i++){var a=as[i].getAttribute('aria-label')||'';if(a.indexOf('Attached element,')===0){if(n===${idx}){el=as[i];break;}n++;}}
      if(!el) return null;
      var l=getEventListeners(el);
      window.__L=[];
      Object.keys(l).forEach(function(ty){ (l[ty]||[]).forEach(function(x){ window.__L.push(x.listener); }); });
      return window.__L.length ? window.__L[0] : null;
    })()`);
    let widgetOid = null;
    const nL = Number((await send('Runtime.evaluate', { expression: 'window.__L.length', returnByValue: true })).result.result.value || 0);
    for (let li = 0; li < nL && !widgetOid; li++) {
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
        const sp = await send('Runtime.getProperties', { objectId: so.objectId, ownProperties: true });
        const prs = ((sp.result || {}).result) || [];
        console.log(idx, 'L' + li, 'scope vars:', prs.map((x) => x.name).slice(0, 12).join(',') || '(none)');
        for (const pr of prs) {
          if (pr.name === '(this)' && pr.value && pr.value.objectId) {
            // candidate receiver: is it an attachment widget?
            const chk = await send('Runtime.callFunctionOn', {
              objectId: pr.value.objectId,
              functionDeclaration: `function(){ try { var a = this.attachment; if (!a || a.kind !== 'element') return ''; return JSON.stringify({ name: a.name, fullName: a.fullName || a.name, valLen: String(a.value).length, hasImg: !!a.imageData, imgLen: a.imageData && a.imageData.buffer ? a.imageData.buffer.byteLength : (a.imageData && a.imageData.length ? a.imageData.length : 0), anc: (a.ancestors || []).length, dims: a.dimensions || null, inner: (a.innerText || '').slice(0, 100) }); } catch (e) { return ''; } }`,
              returnByValue: true, declaration: false
            });
            const v = (chk.result || {}).result ? chk.result.result.value : '';
            if (v) { widgetOid = pr.value.objectId; console.log(idx, 'L' + li, 'WIDGET HIT:', String(v).slice(0, 220)); break; }
            const who = await send('Runtime.callFunctionOn', { objectId: pr.value.objectId, functionDeclaration: `function(){ try { return (this.constructor && this.constructor.name) + ' :: ' + Object.keys(this).slice(0,18).join(','); } catch(e){ return 'ERR'; } }`, returnByValue: true, declaration: false });
            console.log(idx, 'L' + li, '(this) =', String(((who.result || {}).result || {}).value || '?').slice(0, 220));
          }
        }
        if (widgetOid) break;
      }
    }
    if (!widgetOid) { console.log(idx, 'no widget with .attachment found'); continue; }

    const dump = await send('Runtime.callFunctionOn', {
      objectId: widgetOid,
      functionDeclaration: `function(){
        try {
          var a = this.attachment;
          var imgB64 = ''; var imgLen = 0; var mime = a.imageMimeType || 'image/jpeg';
          if (a.imageData) {
            var raw = a.imageData.buffer !== undefined ? a.imageData.buffer : a.imageData;
            var u8 = (raw instanceof Uint8Array) ? raw : new Uint8Array(raw);
            imgLen = u8.length;
            var bin = ''; for (var j = 0; j < u8.length; j += 8192) bin += String.fromCharCode.apply(null, u8.subarray(j, j + 8192));
            imgB64 = btoa(bin);
          }
          return JSON.stringify({ name: a.name, fullName: a.fullName || a.name, value: String(a.value), img: imgB64, imgLen: imgLen, mime: mime, dims: a.dimensions || null, anc: (a.ancestors || []).length, attrs: a.attributes || null, inner: (a.innerText || '').slice(0, 300), url: a.description || a.fullDescription || '', keys: Object.keys(a) });
        } catch (e) { return JSON.stringify({ err: e.message }); }
      }`,
      returnByValue: true, declaration: false
    });
    let E = null; try { E = JSON.parse(String((dump.result || {}).result ? dump.result.result.value : '{}')); } catch (e) { E = { err: 'parse:' + String((dump.result || {}).result && dump.result.result ? dump.result.result.value : '').slice(0, 80) }; }
    if (!E || E.err) { console.log(idx, 'DUMP FAIL', JSON.stringify(E).slice(0, 160)); continue; }
    const safe = String(E.fullName || E.name || 'x').replace(/[^a-zA-Z0-9_-]+/g, '_').slice(0, 40);
    const base = OUT + '-' + stamp0 + '-' + (idx + 1) + '-' + safe;
    let txt = '# element: ' + (E.fullName || E.name) + '\n# time: ' + new Date().toString() +
      '\n# via: PURE-READ (chip -> listener closure -> (this) -> widget.attachment)' +
      '\n# keys: ' + (E.keys || []).join(',') +
      '\n# dims: ' + JSON.stringify(E.dims) + ' ancestors: ' + E.anc + ' attrs: ' + JSON.stringify(E.attrs || {}).slice(0, 120) +
      '\n# innerText: ' + E.inner.slice(0, 120) + '\n\n' + E.value + '\n';
    if (E.img) { const ext = E.mime === 'image/png' ? '.png' : '.jpg'; fs.writeFileSync(base + '.img' + ext, Buffer.from(E.img, 'base64')); txt += '\n## SCREENSHOT (att.imageData, ' + E.imgLen + 'B)\n文件: ' + base + '.img' + ext + '\n'; }
    fs.writeFileSync(base + '.txt', txt);
    console.log(idx, 'WROTE:', base, '| value', E.value.length + 'B | img', E.imgLen + 'B');
  }
  ws.close(); process.exit(0);
})().catch((e) => { console.log('ERR', e.message); process.exit(1); });
