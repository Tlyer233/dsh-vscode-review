/* Deep-walk every __dshrCap closure variable (+2 levels inside objects)
 * hunting for the element entry. PURE READ. */
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
  await new Promise((r) => { ws.on('open', r); });
  const n = Number((await send('Runtime.evaluate', { expression: 'window.__dshrCap.length', returnByValue: true })).result.result.value);
  const PROBE = `function(){ try {
    var seen = new WeakSet();
    function looks(v, path, depth) {
      try {
        if (!v || typeof v !== 'object' || seen.has(v)) return null; seen.add(v);
        if (v.kind === 'element' && v.value !== undefined) return path;
        if (depth <= 0) return null;
        var ks = Object.keys(v);
        for (var i = 0; i < ks.length && i < 14; i++) {
          var k = ks[i];
          if (k[0] === '_') continue;
          var r = looks(v[k], path + '.' + k, depth - 1);
          if (r) return r;
        }
        return null;
      } catch (e) { return null; }
    }
    return looks(this, 'this', 2) || '';
  } catch (e) { return ''; } }`;
  for (let ci = 0; ci < n; ci++) {
    const fr = await send('Runtime.evaluate', { expression: 'window.__dshrCap[' + ci + '].fn', returnByValue: false });
    const fid = fr.result && fr.result.result ? fr.result.result.objectId : null;
    if (!fid) continue;
    const p2 = await send('Runtime.getProperties', { objectId: fid, ownProperties: false });
    const sc = ((p2.result || {}).internalProperties || []).find((x) => x.name === '[[Scopes]]');
    if (!sc || !sc.value || !sc.value.objectId) continue;
    const coll = await send('Runtime.getProperties', { objectId: sc.value.objectId, ownProperties: false });
    const kids = (((coll.result || {}).result) || []).map((x) => x.value).filter((v) => v && v.objectId);
    const closure = kids.find((k) => String(k.description).indexOf('Closure') === 0);
    if (!closure) continue;
    const sp = await send('Runtime.getProperties', { objectId: closure.objectId, ownProperties: true });
    const vars = (sp.result || {}).result || [];
    let hit = null;
    for (const pr of vars) {
      if (!pr.value || !pr.value.objectId) continue;
      const chk = await send('Runtime.callFunctionOn', { objectId: pr.value.objectId, functionDeclaration: PROBE, returnByValue: true, declaration: false });
      const v = ((chk.result || {}).result || {}).value || '';
      if (v) { hit = { var: pr.name, path: v }; break; }
    }
    if (hit) { console.log('cap[' + ci + ']', closure.description, '=> HIT', JSON.stringify(hit)); process.exit(0); }
    else console.log('cap[' + ci + ']', closure.description, 'vars:', vars.map((x) => x.name + '(' + (x.value ? x.value.className || x.value.type : '?') + ')').join(' ').slice(0, 160));
  }
  console.log('NO HIT in any cap closure');
  ws.close(); process.exit(0);
})().catch((e) => { console.log('ERR', e.message); process.exit(1); });
