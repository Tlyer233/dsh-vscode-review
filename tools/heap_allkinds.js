/* Deliver files for ALL current copilot attachments (file/code-snippet/generic/terminal), PURE READ. */
const WebSocket = require('/Users/xi/.vscode/extensions/dsn.dsh-review-vscode-0.1.182/node_modules/ws');
const http = require('http');
const fs = require('fs');
(async () => {
  const targets = await new Promise((res) => http.get('http://127.0.0.1:9223/json', (r) => { let d = ''; r.on('data', c => d += c); r.on('end', () => res(JSON.parse(d))); }));
  const wb = targets.find((x) => x.type === 'page' && (x.url || '').indexOf('vscode-file') === 0);
  const ws = new WebSocket(wb.webSocketDebuggerUrl);
  const handlers = {};
  const SNAP = '/tmp/heap_all.snap';
  let fd = fs.openSync(SNAP, 'w');
  ws.on('message', (d) => {
    const m = JSON.parse(d.toString());
    if (m.method === 'HeapProfiler.addHeapSnapshotChunk' && m.params && m.params.chunk) fs.writeSync(fd, m.params.chunk);
    if (m.id && handlers[m.id]) { handlers[m.id](m); delete handlers[m.id]; }
  });
  let mid = 1;
  const send = (method, params) => new Promise((resolve) => { const myId = mid++; handlers[myId] = resolve; ws.send(JSON.stringify({ id: myId, method, params: params || {} })); });
  await new Promise((r) => { ws.on('open', r); });
  await send('HeapProfiler.enable');
  await send('HeapProfiler.collectGarbage');
  await send('HeapProfiler.takeHeapSnapshot', { reportProgress: false });
  fs.closeSync(fd);
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
  // collect ids of file/generic entries that have name+value
  const ids = [];
  for (let n = 0; n < nodeCount; n++) {
    if (nodes[n * NF + iType] !== typeNames.indexOf('object')) continue;
    if (nodes[n * NF + iEC] < 4 || nodes[n * NF + iEC] > 10) continue;
    const s = starts[n], e = starts[n + 1];
    let kind = null, name = null, hasVal = false, idStr = null;
    for (let k = s; k < e; k += 3) {
      if (edges[k] !== TP) continue;
      const pn = strings[edges[k + 1]];
      const to = Math.floor(edges[k + 2] / NF);
      if (pn === 'kind') kind = sOf(to);
      else if (pn === 'name') name = sOf(to);
      else if (pn === 'value') hasVal = true;
      else if (pn === 'id') idStr = sOf(to);
    }
    if ((kind === 'file' || kind === 'generic') && name && hasVal && idStr && (idStr.startsWith('file-') || idStr.startsWith('terminal-') || idStr.includes('-'))) ids.push(String(nodes[n * NF + iId]));
  }
  console.log('candidate entries:', ids.length);
  const DUMP = `function(){ try {
    var v = this.value;
    var out = { kind: this.kind, name: this.name, fullName: this.fullName || this.name || '', id: this.id || '' };
    if (v && typeof v === 'object') {
      if (v.uri) { out.uri = (v.uri.fsPath || v.uri.path || String(v.uri)); if (v.range) { try { out.range = JSON.stringify({ s: v.range.startLineNumber, e: v.range.endLineNumber }); } catch (e) { out.range = 'range?' } } }
      else if (v.fsPath !== undefined || v.path !== undefined) out.uri = v.fsPath || v.path;
      else { out.valueObj = Object.keys(v).slice(0, 8).join(','); }
    } else out.text = String(v === undefined ? '' : v);
    return JSON.stringify(out);
  } catch (e) { return JSON.stringify({ err: e.message }); } }`;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const DIR = require('path').join(require('os').tmpdir(), 'dsh-probe');
  try { fs.mkdirSync(DIR, { recursive: true }); } catch (e) { /* noop */ }
  const seen = new Set();
  for (const sid of ids) {
    const g = await send('HeapProfiler.getObjectByHeapObjectId', { heapSnapshotObjectId: sid, objectId: sid });
    const oid = g.result && g.result.result ? g.result.result.objectId : null;
    if (!oid) continue;
    const d = await send('Runtime.callFunctionOn', { objectId: oid, functionDeclaration: DUMP, returnByValue: true, declaration: false });
    const E = JSON.parse(String(((d.result || {}).result || {}).value || '{}'));
    if (!E || E.err || !E.name || seen.has(E.id || (E.kind + E.name + (E.uri || '')))) continue;
    seen.add(E.id || (E.kind + E.name + (E.uri || '')));
    let body = '# kind: ' + E.kind + '\n# name: ' + E.name + '\n# id: ' + E.id + '\n';
    if (E.uri) {
      body += '# path: ' + E.uri + (E.range ? '  lines ' + E.range : '') + '\n\n';
      try {
        const raw = fs.readFileSync(E.uri, 'utf8');
        if (E.range) { const r = JSON.parse(E.range); body += raw.split('\n').slice(Math.max(0, (r.s || 1) - 1), r.e || undefined).join('\n'); }
        else body += raw;
      } catch (err) { body += '(读取失败: ' + err.message + ')'; }
    } else if (E.text) {
      body += '\n' + E.text + '\n';
    } else body += '\n(object: ' + (E.valueObj || '?') + ')\n';
    const safe = String(E.name).replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 40);
    const base = DIR + '/allkinds-' + stamp + '-' + E.kind + '-' + safe;
    fs.writeFileSync(base + '.txt', body);
    console.log('WROTE', base, '| uri:', E.uri || '-', '| text', E.text ? E.text.length + 'B' : '-', '| range', E.range || '-');
  }
  ws.close(); process.exit(0);
})().catch((e) => { console.log('ERR', e.stack ? e.stack.slice(0, 300) : e.message); process.exit(1); });
