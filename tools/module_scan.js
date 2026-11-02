/* Scan MODULE-scope variables (preview-filtered) for the element entry. PURE READ. */
const WebSocket = require('/Users/xi/.vscode/extensions/dsn.dsh-review-vscode-0.1.177/node_modules/ws');
const http = require('http');
const fs = require('fs');
(async () => {
  const targets = await new Promise((res) => http.get('http://127.0.0.1:9223/json', (r) => { let d = ''; r.on('data', c => d += c); r.on('end', () => res(JSON.parse(d))); }));
  const wb = targets.find((x) => x.type === 'page' && (x.url || '').indexOf('vscode-file') === 0);
  const ws = new WebSocket(wb.webSocketDebuggerUrl);
  const handlers = {};
  ws.on('message', (d) => { const m = JSON.parse(d.toString()); if (m.id && handlers[m.id]) { handlers[m.id](m); delete handlers[m.id]; } });
  let mid = 1;
  const send = (method, params) => new Promise((resolve) => { const myId = mid++; handlers[myId] = resolve; ws.send(JSON.stringify({ id: myId, method, params: params || {} })); });
  await new Promise((r) => { ws.on('open', r); });
  const fr = await send('Runtime.evaluate', { expression: 'window.__dshrCap[1].fn', returnByValue: false });
  const p2 = await send('Runtime.getProperties', { objectId: fr.result.result.objectId, ownProperties: false });
  const sc = ((p2.result || {}).internalProperties || []).find((x) => x.name === '[[Scopes]]');
  const coll = await send('Runtime.getProperties', { objectId: sc.value.objectId, ownProperties: false });
  const kids = (((coll.result || {}).result) || []).map((x) => x.value).filter((v) => v && v.objectId);
  console.log('scopes:', kids.map((k) => k.description).join(' | '));
  const found = [];
  for (const k of kids) {
    if (String(k.description).indexOf('Module') === -1) continue;
    const sp = await send('Runtime.getProperties', { objectId: k.objectId, ownProperties: true, generatePreview: true });
    for (const pr of ((sp.result || {}).result) || []) {
      const v = pr.value || {};
      if (v.type !== 'object' || !v.objectId) continue;
      const chk = await send('Runtime.callFunctionOn', { objectId: v.objectId, functionDeclaration: 'function(){ try { return (this.kind === "element" && this.value !== undefined && String(this.value).indexOf("Attached Element Context") === 0) ? "HIT" : ""; } catch(e){ return ""; } }', returnByValue: true, declaration: false });
      if (((chk.result || {}).result || {}).value === 'HIT') {
        found.push({ name: pr.name, oid: v.objectId, preview: (v.description || '') });
      }
    }
  }
  console.log('CANDIDATES:', found.length);
  found.slice(0, 6).forEach((f) => console.log('  var', f.name, '::', f.preview));
  // full-extract each candidate confirmed kind==='element'
  const DUMP = 'function(){ try { if (this.kind !== "element") return ""; var img = "", imgLen = 0; var raw = this.imageData; if (raw) { if (raw.buffer !== undefined) raw = raw.buffer; if (!(raw instanceof Uint8Array)) raw = new Uint8Array(raw); imgLen = raw.length; var bin = ""; for (var j = 0; j < raw.length; j += 8192) bin += String.fromCharCode.apply(null, raw.subarray(j, j + 8192)); img = btoa(bin); } return JSON.stringify({ name: this.name, fullName: this.fullName || this.name, value: String(this.value), img: img, imgLen: imgLen, mime: this.imageMimeType || "image/jpeg", dims: this.dimensions || null, anc: (this.ancestors || []).length, attrs: this.attributes || null, inner: this.innerText || "", keys: Object.keys(this).join(",") }); } catch(e){ return JSON.stringify({ err: e.message }); } }';
  const seen = new Set();
  for (const f of found) {
    const d = await send('Runtime.callFunctionOn', { objectId: f.oid, functionDeclaration: DUMP, returnByValue: true, declaration: false });
    const E = JSON.parse(String(((d.result || {}).result || {}).value || '{}'));
    if (!E || E.err || !E.value) continue;
    const key = E.value.slice(0, 140);
    if (key.indexOf('Attached Element Context') !== 0 || seen.has(key)) continue;
    seen.add(key);
    const elLine = E.value.split('\n').find((l) => l.indexOf('Element:') === 0) || E.name;
    const tag = elLine.replace(/[^a-zA-Z0-9-]+/g, '_').slice(0, 40);
    const base = 'REAL_map-' + (seen.size) + '-' + tag;
    let txt = '# element: ' + (E.fullName || E.name) + '\n# via: PURE-READ (Module scope var -> live entry .value 无截断)\n# dims: ' + JSON.stringify(E.dims) + ' ancestors: ' + E.anc + ' keys: ' + E.keys + '\n# innerText: ' + (E.inner || '').slice(0, 150) + '\n\n' + E.value + '\n';
    if (E.img) { const ext = E.mime === 'image/png' ? '.png' : '.jpg'; fs.writeFileSync(base + '.img' + ext, Buffer.from(E.img, 'base64')); txt += '\n## SCREENSHOT att.imageData ' + E.imgLen + 'B -> ' + base + '.img' + ext + '\n'; }
    fs.writeFileSync(base + '.txt', txt);
    console.log('WROTE', base, 'value', E.value.length + 'B img', E.imgLen + 'B');
  }
  console.log('UNIQUE:', seen.size);
  ws.close(); process.exit(0);
})().catch((e) => { console.log('ERR', e.stack ? e.stack.slice(0, 300) : e.message); process.exit(1); });
