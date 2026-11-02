/* HEAP SCAN PROOF: find <kind:'element', value:'Attached Element Context...'>
 * objects living in the workbench heap RIGHT NOW (no click, no hover).
 * Also prints who retains them (the map's owner chain). */
const WebSocket = require('/Users/xi/.vscode/extensions/dsn.dsh-review-vscode-0.1.177/node_modules/ws');
const http = require('http');
const fs = require('fs');
try { require('fs').mkdirSync(require('path').join(require('os').tmpdir(), 'dsh-probe'), { recursive: true }); } catch (e) { /* noop */ }

(async () => {
  const targets = await new Promise((res) => http.get('http://127.0.0.1:9223/json', (r) => { let d = ''; r.on('data', c => d += c); r.on('end', () => res(JSON.parse(d))); }));
  const wb = targets.find((x) => x.type === 'page' && (x.url || '').indexOf('vscode-file') === 0);
  const ws = new WebSocket(wb.webSocketDebuggerUrl);
  let mid = 1; const handlers = {};
  ws.on('message', (d) => { const m = JSON.parse(d.toString()); if (m.id && handlers[m.id]) { handlers[m.id](m); delete handlers[m.id]; } });
  const send = (method, params) => new Promise((resolve) => { const myId = mid++; handlers[myId] = resolve; ws.send(JSON.stringify({ id: myId, method, params: params || {} })); });
  const snap0 = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const SNAP = require('path').join(require('os').tmpdir(), 'dsh-probe', 'probe_heap-') + snap0 + '.heapsnapshot';
  const fd = fs.openSync(SNAP, 'w');
  ws.on('message', (d) => { const m = JSON.parse(d.toString()); if (m.method === 'HeapProfiler.addHeapSnapshotChunk' && m.params && m.params.chunk) fs.writeSync(fd, m.params.chunk); });
  await new Promise((r) => { ws.on('open', r); });
  await send('HeapProfiler.enable');
  console.log('taking snapshot (page GC-pauses briefly)...');
  const t0 = Date.now();
  await send('HeapProfiler.takeHeapSnapshot', { reportProgress: false });
  fs.closeSync(fd);
  const size = fs.statSync(SNAP).size;
  console.log('snapshot:', (size / 1048576).toFixed(1) + 'MB in', ((Date.now() - t0) / 1000).toFixed(1) + 's');

  const data = JSON.parse(fs.readFileSync(SNAP, 'utf8'));
  const meta = data.snapshot.meta;
  const NF = meta.node_fields.length;
  const typeNames = meta.node_types[0];
  const edgeTypeNames = meta.edge_types[0];
  const EF = meta.edge_fields.length;
  const nodes = data.nodes; const edges = data.edges; const strings = data.strings;
  const nodeCount = nodes.length / NF;
  const iType = meta.node_fields.indexOf('type');
  const iName = meta.node_fields.indexOf('name');
  const iId = meta.node_fields.indexOf('id');
  const iEdgeCount = meta.node_fields.indexOf('edge_count');
  const eType = meta.edge_fields.indexOf('type');
  const eName = meta.edge_fields.indexOf('name_or_index');
  const eTo = meta.edge_fields.indexOf('to_node');
  const T_PROPERTY = edgeTypeNames.indexOf('property');
  const T_STRING = typeNames.indexOf('string');
  const T_OBJECT = typeNames.indexOf('object');

  // precompute edge start per node
  const edgeStart = new Float64Array(nodeCount + 1);
  for (let n = 0; n < nodeCount; n++) edgeStart[n + 1] = edgeStart[n] + nodes[n * NF + iEdgeCount] * EF;

  const nodeTypeName = (ord) => typeNames[nodes[ord * NF + iType]];
  const nodeNameStr = (ord) => { const si = nodes[ord * NF + iName]; return typeof strings[si] === 'string' ? strings[si] : ''; };

  // find object nodes with property edges 'kind'->'element' and 'value'->string
  const hits = [];
  const NAMESET = new Set(['kind', 'value', 'name', 'fullName', 'imageData', 'ancestors', 'attributes', 'computedStyles', 'dimensions', 'innerText', 'description', 'id', 'metadata', 'modelDescription']);
  for (let n = 0; n < nodeCount; n++) {
    if (nodes[n * NF + iType] !== T_OBJECT) continue;
    if (nodes[n * NF + iEdgeCount] < 6) continue;
    let kindEl = false; let valueStr = null; let nameStr = null; let hasImg = false; let hasAnc = false; let hasDims = false;
    const s = edgeStart[n]; const e = edgeStart[n + 1];
    for (let k = s; k < e; k += EF) {
      if (edges[k + eType] !== T_PROPERTY) continue;
      const pn = strings[edges[k + eName]];
      if (pn === 'kind') { const to = edges[k + eTo] / NF; if (nodeTypeName(to) === 'string' && nodeNameStr(to) === 'element') kindEl = true; }
      else if (pn === 'value') { const to = edges[k + eTo] / NF; if (nodeTypeName(to) === 'string') { const v = nodeNameStr(to); if (v.indexOf('Attached Element Context') === 0) valueStr = v; } }
      else if (pn === 'name') { const to = edges[k + eTo] / NF; if (nodeTypeName(to) === 'string') nameStr = nodeNameStr(to); }
      else if (pn === 'imageData') hasImg = true;
      else if (pn === 'ancestors') hasAnc = true;
      else if (pn === 'dimensions') hasDims = true;
      if (kindEl && valueStr && nameStr !== undefined) break;
    }
    if (kindEl && valueStr) hits.push({ ord: n, id: nodes[n * NF + iId], name: nameStr, value: valueStr, hasImg, hasAnc, hasDims });
    if (hits.length >= 2) break;
  }
  console.log('HITS:', hits.length);
  hits.forEach((h, i) => { console.log('#' + (i + 1), 'nodeId', h.id, 'name:', h.name, '| value', h.value.length + 'B | img', h.hasImg, 'anc', h.hasAnc, 'dims', h.hasDims, '| head:', JSON.stringify(h.value.slice(0, 80)) | 0, JSON.stringify(h.value.slice(0, 90))); });

  // reverse BFS retainer chain for first hit (up to 10 levels)
  if (hits.length) {
    // build reverse parents map lazily per level via full edge scan (few levels only)
    let cur = hits[0].ord;
    const chain = [];
    for (let lvl = 0; lvl < 10; lvl++) {
      let found = null;
      for (let n = 0; n < nodeCount && !found; n++) {
        const s = edgeStart[n]; const e = edgeStart[n + 1];
        for (let k = s; k < e; k += EF) {
          if (Math.floor(edges[k + eTo] / NF) === cur) { found = { n, et: edges[k + eType], en: edges[k + eName] }; break; }
        }
      }
      if (!found) break;
      const label = (edgeTypeNames[found.et] || '?') + (found.et === T_PROPERTY ? ' ' + strings[found.en] : (found.et === 0 || found.et === 2 ? ' idx' + found.en : ''));
      chain.push(nodeTypeName(found.n) + ' ' + JSON.stringify(nodeNameStr(found.n)).slice(0, 50) + ' --[' + label + ']--> ' + nodeTypeName(cur));
      cur = found.n;
    }
    console.log('RETAINER CHAIN (inner->outer):');
    chain.forEach((c) => console.log('   ', c));
  }
  ws.close(); process.exit(0);
})().catch((e) => { console.log('ERR', e.stack ? e.stack.slice(0, 500) : e.message); process.exit(1); });
