/* Extract <chip -> attachment entry> from EXISTING chips, no hover:
 * pause in the listener wrapper, read the closure chain, NEUTRALIZE the
 * handler (setVariableValue noop) before resume => zero side effects. */
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
  let pausedCb = null;
  ws.on('message', (d) => {
    const m = JSON.parse(d.toString());
    if (m.method === 'Debugger.paused' && pausedCb) { const cb = pausedCb; pausedCb = null; cb(m.params); return; }
    if (m.id && handlers[m.id]) { handlers[m.id](m); delete handlers[m.id]; }
  });
  let mid = 1;
  const send = (method, params) => new Promise((resolve) => { const myId = mid++; handlers[myId] = resolve; ws.send(JSON.stringify({ id: myId, method, params: params || {} })); });
  await new Promise((r) => { ws.on('open', r); });
  await send('Runtime.enable'); await send('Debugger.enable');

  // listener wrapper location (shared monaco registration site) — from earlier probe
  const SITE = { scriptId: '9', lineNumber: 2556, columnNumber: 59984 };
  const bp = await send('Debugger.setBreakpoint', { location: SITE });
  const bpId = bp.result && bp.result.breakpointId;
  console.log('bp:', bpId, JSON.stringify((bp.result || {}).actualLocation || 'pending'));

  const chipsPos = JSON.parse(String((await send('Runtime.evaluate', { expression: `(function(){var as=document.querySelectorAll('.chat-attached-context-attachment');var out=[];for(var i=0;i<as.length;i++){var a=as[i].getAttribute('aria-label')||'';if(a.indexOf('Attached element,')===0&&as[i].offsetParent){var r=as[i].getBoundingClientRect();out.push({aria:a,x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2),i:out.length});}}return JSON.stringify(out);})()`, returnByValue: true })).result.result.value));
  console.log('CHIPS:', JSON.stringify(chipsPos.map((c) => ({ i: c.i, x: c.x, y: c.y }))));

  const stamp0 = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  for (const chip of chipsPos) {
    const pausedP = new Promise((resolve) => { pausedCb = resolve; });
    const timer = new Promise((r) => setTimeout(() => r(null), 5000));
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: chip.x, y: chip.y, button: 'left', clickCount: 1, buttons: 1 });
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: chip.x, y: chip.y, button: 'left', clickCount: 1, buttons: 0 });
    const p = await Promise.race([pausedP, timer]);
    if (!p) { console.log('chip', chip.i, 'NOT PAUSED'); continue; }
    // scan all frames' scope chains for an object with kind==='element'
    let found = null; let entry = null;
    for (let fi = 0; fi < p.callFrames.length && !entry; fi++) {
      const f = p.callFrames[fi];
      for (let si = 0; si < f.scopeChain.length && !entry; si++) {
        const sc = f.scopeChain[si];
        const oid = sc.object && sc.object.objectId;
        if (!oid) continue;
        const props = await send('Runtime.getProperties', { objectId: oid, ownProperties: true });
        for (const pr of (props.result || [])) {
          const probe = await send('Runtime.callFunctionOn', {
            objectId: oid,
            functionDeclaration: `function(){ try { var v = this[${JSON.stringify(pr.name)}]; if (!v || typeof v !== 'object') return ''; if (v.kind === 'element' && v.value !== undefined) return JSON.stringify({ kind: v.kind, name: v.name, fullName: v.fullName, keys: Object.keys(v), valLen: String(v.value).length, imageLen: v.imageData ? v.imageData.length || (v.imageData.buffer ? v.imageData.buffer.byteLength : 0) : 0, anc: (v.ancestors || []).length, dims: v.dimensions || null, attrs: v.attributes || null, inner: (v.innerText || '').slice(0, 200) }); return ''; } catch (e) { return ''; } }`,
            returnByValue: true, declaration: false
          });
          const v = probe.result && probe.result.result ? probe.result.result.value : '';
          if (v) { found = { frame: fi, scope: si, varName: pr.name, scopeOid: oid }; entry = JSON.parse(String(v)); break; }
        }
      }
    }
    if (!entry) { console.log('chip', chip.i, ': paused but no element entry in frames'); }
    else {
      console.log('chip', chip.i, 'ENTRY:', JSON.stringify(entry).slice(0, 300));
      // pull the FULL value + imageData out via the scope object
      const full = await send('Runtime.callFunctionOn', {
        objectId: found.scopeOid,
        functionDeclaration: `function(){ try { var v = this[${JSON.stringify(found.varName)}]; var img = ''; if (v.imageData) { var b = v.imageData.buffer || v.imageData; if (b) { var u = new Uint8Array(b.byteLength || b.length); for (var i2 = 0; i2 < u.length; i2++) u[i2] = (b[i2] !== undefined ? b[i2] : b.buffer ? new Uint8Array(b)[i2] : 0); var bin = ''; for (var j = 0; j < u.length; j += 8192) bin += String.fromCharCode.apply(null, u.subarray(j, j + 8192)); img = btoa(bin); } } return JSON.stringify({ value: String(v.value), img: img, mime: v.imageMimeType || 'image/jpeg' }); } catch (e) { return JSON.stringify({ value: '', img: '', err: e.message }); } }`,
        returnByValue: true, declaration: false
      });
      const F = JSON.parse(String(full.result && full.result.result ? full.result.result.value : '{}'));
      const safe = (entry.name || 'x').replace(/[^a-zA-Z0-9_-]+/g, '_').slice(0, 40);
      const base = OUT + '-' + stamp0 + '-' + (chip.i + 1) + '-' + safe;
      let txt = '# element: ' + (entry.fullName || entry.name) + '\n# time: ' + new Date().toString() +
        '\n# via: closure-pierce (NO hover, NO click-executed, NO browser)\n' +
        (entry.dims ? '# dims: ' + JSON.stringify(entry.dims) + '\n' : '') +
        (entry.anc !== undefined ? '# ancestors: ' + entry.anc + '\n' : '') +
        (entry.inner ? '# innerText: ' + entry.inner.slice(0, 120) + '\n' : '') +
        '\n' + F.value + '\n';
      if (F.img) { fs.writeFileSync(base + '.img' + (F.mime === 'image/png' ? '.png' : '.jpg'), Buffer.from(F.img, 'base64')); txt += '\n## SCREENSHOT (att.imageData)\n文件: ' + base + '.img' + (F.mime === 'image/png' ? '.png' : '.jpg') + '\n'; }
      fs.writeFileSync(base + '.txt', txt);
      console.log('WROTE:', base, 'value', F.value.length + 'B', 'img', F.img ? 'y' : 'n', F.err || '');
    }
    // neutralize: replace the wrapper's user listener in-frame, then resume
    try {
      const f0 = p.callFrames[0];
      let neutralized = false;
      for (let si = 0; si < f0.scopeChain.length && !neutralized; si++) {
        const sc = f0.scopeChain[si];
        const oid = sc.object && sc.object.objectId;
        if (!oid) continue;
        const props = await send('Runtime.getProperties', { objectId: oid, ownProperties: true });
        for (const pr of (props.result || [])) {
          if (pr.name === 'listener' || pr.name === 'userListener' || pr.name === 'callback') {
            const sv = await send('Debugger.setVariableValue', { callFrameId: f0.callFrameId, scopeChainIndex: String(si), variableName: pr.name, value: { expression: 'function(){}' } });
            if (!sv.error) { neutralized = true; console.log('  neutralized via', pr.name); }
            break;
          }
        }
      }
      if (!neutralized) console.log('  (not neutralized; editor may open)');
    } catch (e) { console.log('  neutralize err', String(e).slice(0, 80)); }
    await send('Debugger.resume');
    await new Promise((r) => setTimeout(r, 250));
  }
  if (bpId) await send('Debugger.removeBreakpoint', { breakpointId: bpId });
  await send('Debugger.disable');
  ws.close(); process.exit(0);
})().catch((e) => { console.log('ERR', e.message); process.exit(1); });
