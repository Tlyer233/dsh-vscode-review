/* ONE session: take snapshot -> find element entries -> bridge snapshot ids to
 * LIVE objects -> full value + imageData. PURE READ. */
const WebSocket = require('/Users/xi/.vscode/extensions/dsn.dsh-review-vscode-0.1.177/node_modules/ws');
const http = require('http');
const fs = require('fs');
try { require('fs').mkdirSync(require('path').join(require('os').tmpdir(), 'dsh-probe'), { recursive: true }); } catch (e) { /* noop */ }
(async () => {
  const targets = await new Promise((res) => http.get('http://127.0.0.1:9223/json', (r) => { let d = ''; r.on('data', c => d += c); r.on('end', () => res(JSON.parse(d))); }));
  const wb = targets.find((x) => x.type === 'page' && (x.url || '').indexOf('vscode-file') === 0);
  const ws = new WebSocket(wb.webSocketDebuggerUrl);
  const handlers = {};
  const SNAP = require('path').join(require('os').tmpdir(), 'dsh-probe', 'tools/.livesnap.json');
  const fd = fs.openSync(SNAP, 'w');
  ws.on('message', (d) => {
    const m = JSON.parse(d.toString());
    if (m.method === 'HeapProfiler.addHeapSnapshotChunk' && m.params && m.params.chunk) fs.writeSync(fd, m.params.chunk);
    if (m.id && handlers[m.id]) { handlers[m.id](m); delete handlers[m.id]; }
  });
  let mid = 1;
  const send = (method, params) => new Promise((resolve) => { const myId = mid++; handlers[myId] = resolve; ws.send(JSON.stringify({ id: myId, method, params: params || {} })); });
  await new Promise((r) => { ws.on('open', r); });
  await send('HeapProfiler.enable');
  await send('HeapProfiler.takeHeapSnapshot', { reportProgress: false });
  fs.closeSync(fd);
  console.log('snapshot ok', (fs.statSync(SNAP).size / 1048576).toFixed(0) + 'MB');

  const data = JSON.parse(fs.readFileSync(SNAP, 'utf8'));
  const meta = data.snapshot.meta; const NF = meta.node_fields.length;
  const nodes = data.nodes, edges = data.edges, strings = data.strings;
  const typeNames = meta.node_types[0]; const edgeTypeNames = meta.edge_types[0];
  const iType = meta.node_fields.indexOf('type'), iName = meta.node_fields.indexOf('name'), iId = meta.node_fields.indexOf('id'), iEC = meta.node_fields.indexOf('edge_count');
  const TP = edgeTypeNames.indexOf('property');
  const nodeCount = nodes.length / NF;
  const es = new Float64Array(nodeCount + 1);
  for (let n = 0; n < nodeCount; n++) es[n + 1] = es[n] + nodes[n * NF + iEC] * 3;
  const tn = (o) => typeNames[nodes[o * NF + iType]];
  const sOf = (o) => { const t = tn(o); if (t === 'string' || t === 'concatenated string') { const s = strings[nodes[o * NF + iName]]; return typeof s === 'string' ? s : ''; } return null; };
  const hits = [];
  for (let n = 0; n < nodeCount && hits.length < 8; n++) {
    if (nodes[n * NF + iType] !== typeNames.indexOf('object')) continue;
    const s = es[n], e = es[n + 1]; let kind = null, val = null;
    for (let k = s; k < e; k += 3) {
      if (edges[k] !== TP) continue;
      const pn = strings[edges[k + 1]];
      if (pn === 'kind') kind = sOf(Math.floor(edges[k + 2] / NF));
      else if (pn === 'value') val = sOf(Math.floor(edges[k + 2] / NF));
      if (kind !== null && val !== null) break;
    }
    if (kind === 'element' && val && val.indexOf('Attached Element Context') === 0) hits.push(String(nodes[n * NF + iId]));
  // also try reverse order later
  }
  console.log('snapshot hits:', hits.length);
  const DUMP = `function(){ try {
    if (this.kind !== 'element') return JSON.stringify({ err: 'kind=' + this.kind });
    var img = '', imgLen = 0; var raw = this.imageData;
    if (raw) {
      if (typeof raw === 'function') raw = raw();
      var info = { ctor: raw && raw.constructor && raw.constructor.name, bl: raw && raw.byteLength, len: raw && raw.length, bufCtor: raw && raw.buffer && raw.buffer.constructor && raw.buffer.constructor.name, bufBl: raw && raw.buffer && raw.buffer.byteLength, bufOff: raw && raw.byteOffset };
      if (raw && !(raw instanceof Uint8Array)) raw = raw.buffer instanceof ArrayBuffer ? new Uint8Array(raw.buffer, raw.byteOffset || 0, raw.byteLength !== undefined ? raw.byteLength : undefined) : new Uint8Array(raw);
      info.h1 = raw && raw.length ? raw[0] : -1; info.h2 = raw && raw.length > 1 ? raw[1] : -1;
      imgDebug = JSON.stringify(info);
      imgLen = raw.length; var bin = ''; for (var j = 0; j < raw.length; j += 8192) bin += String.fromCharCode.apply(null, raw.subarray(j, j + 8192)); img = btoa(bin); }
    var imgDebug = '';
    return JSON.stringify({ dbg: imgDebug, name: this.name, fullName: this.fullName || this.name, id: this.id || '', value: String(this.value), img: img, imgLen: imgLen, mime: this.imageMimeType || 'image/jpeg', dims: this.dimensions || null, anc: (this.ancestors || []).length, attrs: this.attributes || null, inner: this.innerText || '' });
  } catch (e) { return JSON.stringify({ err: e.message }); } }`;
  const seen = new Set();
  const ORDER = hits.slice().reverse();
  for (let i = 0; i < ORDER.length; i++) {
    const sid = ORDER[i];
    const g = await send('HeapProfiler.getObjectByHeapObjectId', { heapSnapshotObjectId: sid, objectId: sid });
    const oid = g.result && g.result.result ? g.result.result.objectId : (g.result && g.result.objectId);
    if (!oid) { console.log('bridge fail', sid, JSON.stringify(g.error || g).slice(0, 120)); continue; }
    const d = await send('Runtime.callFunctionOn', { objectId: oid, functionDeclaration: DUMP, returnByValue: true, declaration: false });
    const E = JSON.parse(String(((d.result || {}).result || {}).value || '{}'));
    if (!E || E.err || !E.value) { console.log(i, 'dump fail', JSON.stringify(E).slice(0, 120)); continue; }
    const elLine = E.value.split('\n').find((l) => l.indexOf('Element:') === 0) || E.name;
    const key = String(elLine) + '|' + E.value.length;
    if (seen.has(key)) { console.log(i, 'dup'); continue; }
    seen.add(key);
    const tag = String(elLine).replace(/[^a-zA-Z0-9-]+/g, '_').slice(0, 46);
    const base = 'LIVE_map-' + seen.size + '-' + tag;
    let txt = '# element: ' + (E.fullName || E.name) + '\n# entry id: ' + E.id + '\n# dims: ' + JSON.stringify(E.dims) + ' ancestors: ' + E.anc + '\n# attrs: ' + JSON.stringify(E.attrs || {}).slice(0, 200) + '\n# innerText: ' + String(E.inner).slice(0, 150) + '\n# via: LIVE (heap snapshot id bridge, PURE READ, no hover/click)\n\n' + E.value + '\n';
    if (E.img) { const ext = E.mime === 'image/png' ? '.png' : '.jpg'; fs.writeFileSync(base + '.img' + ext, Buffer.from(E.img, 'base64')); txt += '\n## SCREENSHOT att.imageData ' + E.imgLen + 'B -> ' + base + '.img' + ext + '\n'; }
    fs.writeFileSync(base + '.txt', txt);
    console.log('WROTE', base, '| value', E.value.length + 'B | img', E.imgLen + 'B |', E.dbg);
  }
  try { await send('HeapProfiler.disable'); } catch (e) { /* noop */ }
  fs.unlinkSync(SNAP);
  ws.close(); process.exit(0);
})().catch((e) => { console.log('ERR', e.stack ? e.stack.slice(0, 300) : e.message); process.exit(1); });
