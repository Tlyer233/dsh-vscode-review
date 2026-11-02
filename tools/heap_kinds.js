/* Inventory ALL copilot attachment kinds in the workbench heap:
 * group entries by kind, bridge one sample per kind, dump its full field set.
 * PURE READ. */
const WebSocket = require('/Users/xi/.vscode/extensions/dsn.dsh-review-vscode-0.1.182/node_modules/ws');
const http = require('http');
const fs = require('fs');
(async () => {
  const targets = await new Promise((res) => http.get('http://127.0.0.1:9223/json', (r) => { let d = ''; r.on('data', c => d += c); r.on('end', () => res(JSON.parse(d))); }));
  const wb = targets.find((x) => x.type === 'page' && (x.url || '').indexOf('vscode-file') === 0);
  const ws = new WebSocket(wb.webSocketDebuggerUrl);
  const handlers = {};
  const SNAP = '/tmp/heap_kinds.snap';
  let fd = fs.openSync(SNAP, 'w');
  ws.on('message', (d) => {
    const m = JSON.parse(d.toString());
    if (m.method === 'HeapProfiler.addHeapSnapshotChunk' && m.params && m.params.chunk) fs.writeSync(fd, m.params.chunk);
    if (m.id && handlers[m.id]) { handlers[m.id](m); delete handlers[m.id]; }
  });
  let mid = 1;
  const send = (method, params) => new Promise((resolve) => { const myId = mid++; handlers[myId] = resolve; ws.send(JSON.stringify({ id: myId, method, params: params || {} })); });
  await new Promise((r) => { ws.on('open', r); });
  const dom = await send('Runtime.evaluate', { expression: `(function(){
    var as=document.querySelectorAll('.chat-attached-context-attachment'); var o=[];
    for(var i=0;i<as.length;i++){var a=as[i].getAttribute('aria-label')||'';o.push(a);}
    return JSON.stringify(o);})()`, returnByValue: true });
  console.log('DOM CHIPS NOW:', String(((dom.result || {}).result || {}).value || '?'));
  await send('HeapProfiler.enable');
  await send('HeapProfiler.collectGarbage');
  await send('HeapProfiler.takeHeapSnapshot', { reportProgress: false });
  fs.closeSync(fd);
  console.log('snap MB', Math.round(fs.statSync(SNAP).size / 1048576));
  const data = JSON.parse(fs.readFileSync(SNAP, 'utf8'));
  fs.unlinkSync(SNAP);
  const meta = data.snapshot.meta; const NF = meta.node_fields.length;
  const nodes = data.nodes, edges = data.edges, strings = data.strings;
  const typeNames = meta.node_types[0], edgeTypeNames = meta.edge_types[0];
  const iType = meta.node_fields.indexOf('type'), iName = meta.node_fields.indexOf('name'), iId = meta.node_fields.indexOf('id'), iEC = meta.node_fields.indexOf('edge_count');
  const TP = edgeTypeNames.indexOf('property');
  const nodeCount = nodes.length / NF;
  const starts = new Float64Array(nodeCount + 1);
  for (let n = 0; n < nodeCount; n++) starts[n + 1] = starts[n] + nodes[n * NF + iEC] * 3;
  const tn = (o) => typeNames[nodes[o * NF + iType]];
  const sOf = (o) => { const t = tn(o); if (t === 'string' || t === 'concatenated string') { const s = strings[nodes[o * NF + iName]]; return typeof s === 'string' ? s : ''; } return null; };
  const KINDS = new Set(['element', 'image', 'file', 'directory', 'symbol', 'code', 'variable', 'output', 'terminal', 'scm', 'instruction', 'model', 'attachment', 'promptFile', 'warning']);
  const byKind = new Map();
  for (let n = 0; n < nodeCount; n++) {
    if (nodes[n * NF + iType] !== typeNames.indexOf('object')) continue;
    if (nodes[n * NF + iEC] < 3) continue;
    const s = starts[n], e = starts[n + 1];
    let kind = null, name = null, valType = '', valHead = '';
    for (let k = s; k < e; k += 3) {
      if (edges[k] !== TP) continue;
      const pn = strings[edges[k + 1]];
      const to = Math.floor(edges[k + 2] / NF);
      if (pn === 'kind') kind = sOf(to);
      else if (pn === 'name') name = sOf(to);
      else if (pn === 'value') { valType = tn(to); const sv = sOf(to); valHead = sv === null ? (valType + ' obj') : sv.slice(0, 50); }
      if (kind && name !== null && valHead) break;
    }
    const ATT = new Set(['element','image','file','directory','symbol','code','variable','output','terminal','scm','instruction','selection','snippet','promptFile','attachment'])
    if (kind && ATT.has(kind)) {
      const key = kind;
      if (!byKind.has(key)) byKind.set(key, []);
      const arr = byKind.get(key);
      if (arr.length < 10) arr.push({ id: String(nodes[n * NF + iId]), name, valType, valHead });
    }
  }
  console.log('KIND INVENTORY:');
  for (const [kind, arr] of byKind) console.log(' ', kind, 'x' + arr.length, '::', arr.map((a) => a.name + ' [' + a.valType + ' ' + JSON.stringify(a.valHead).slice(0, 40) + ']').join(' | ').slice(0, 200));
  // bridge one sample per non-element/image kind for full field dump
  const DUMP = `function(){ try {
    var out = { kind: this.kind, name: this.name, fullName: this.fullName || '', keys: Object.keys(this).join(','), modelDescription: this.modelDescription || '' };
    var v = this.value;
    if (typeof v === 'function') { try { v = v(); } catch (e) { v = 'fn-call-err'; } }
    if (v instanceof Uint8Array) { out.valueType = 'bytes'; out.valueLen = v.length; }
    else if (v && typeof v === 'object') { out.valueType = 'object'; out.valueKeys = Object.keys(v).slice(0, 10).join(','); try { out.valueJson = JSON.stringify(v).slice(0, 300); } catch (e) { /* noop */ } }
    else { out.valueType = typeof v; out.value = String(v).slice(0, 300); }
    if (this.range) { try { out.range = JSON.stringify(this.range).slice(0, 120); } catch (e) { /* noop */ } }
    if (this.metadata) { try { out.metadata = JSON.stringify(this.metadata).slice(0, 200); } catch (e) { /* noop */ } }
    return JSON.stringify(out);
  } catch (e) { return JSON.stringify({ err: e.message }); } }`;
  for (const [kind, arr] of byKind) {
    if (!arr.length) continue;
    for (const sample of arr.slice(0, 5)) {
    const sid = sample.id;
    const g = await send('HeapProfiler.getObjectByHeapObjectId', { heapSnapshotObjectId: sid, objectId: sid });
    const oid = g.result && g.result.result ? g.result.result.objectId : (g.result && g.result.objectId);
    if (!oid) continue;
    const d = await send('Runtime.callFunctionOn', { objectId: oid, functionDeclaration: DUMP, returnByValue: true, declaration: false });
    const V = String(((d.result || {}).result || {}).value || '').slice(0, 700);
    if (V && V.indexOf('keys') !== -1) console.log('FULL[' + kind + ']:', V);
    }
  }
  ws.close(); process.exit(0);
})().catch((e) => { console.log('ERR', e.stack ? e.stack.slice(0, 300) : e.message); process.exit(1); });
