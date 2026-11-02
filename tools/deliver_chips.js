/* DELIVER: one file per CURRENT copilot chip, no click/hover.
 * 1) drop our own refs (__dshrCap) + collectGarbage => heap keeps only entries
 *    the app really holds (current chips)
 * 2) snapshot -> find kind:'element' entries -> bridge to LIVE
 * 3) read input-line comments (all contenteditables)
 * 4) write chip-N.txt (+jpg) per chip, count == DOM chip count */
const WebSocket = require('/Users/xi/.vscode/extensions/dsn.dsh-review-vscode-0.1.177/node_modules/ws');
const http = require('http');
const fs = require('fs');
try { require('fs').mkdirSync(require('path').join(require('os').tmpdir(), 'dsh-probe'), { recursive: true }); } catch (e) { /* noop */ }
const DIR = require('path').join(require('os').tmpdir(), 'dsh-probe', 'chip_file');
const DIR_IMG = require('path').join(require('os').tmpdir(), 'dsh-probe', 'chip_shot');
(async () => {
  const targets = await new Promise((res) => http.get('http://127.0.0.1:9223/json', (r) => { let d = ''; r.on('data', c => d += c); r.on('end', () => res(JSON.parse(d))); }));
  const wb = targets.find((x) => x.type === 'page' && (x.url || '').indexOf('vscode-file') === 0);
  const ws = new WebSocket(wb.webSocketDebuggerUrl);
  const handlers = {};
  const SNAP = DIR + '-snap.tmp';
  const fd = fs.openSync(SNAP, 'w');
  ws.on('message', (d) => {
    const m = JSON.parse(d.toString());
    if (m.method === 'HeapProfiler.addHeapSnapshotChunk' && m.params && m.params.chunk) fs.writeSync(fd, m.params.chunk);
    if (m.id && handlers[m.id]) { handlers[m.id](m); delete handlers[m.id]; }
  });
  let mid = 1;
  const send = (method, params) => new Promise((resolve) => { const myId = mid++; handlers[myId] = resolve; ws.send(JSON.stringify({ id: myId, method, params: params || {} })); });
  const ev = async (expression) => { const r = await send('Runtime.evaluate', { expression, returnByValue: true }); return r.result && r.result.result ? r.result.result.value : null; };
  await new Promise((r) => { ws.on('open', r); });

  // 0) current chips + input lines (live DOM)
  const chipsJson = await ev(`(function(){var o=[];var as=document.querySelectorAll('.chat-attached-context-attachment');for(var i=0;i<as.length;i++){var a=as[i].getAttribute('aria-label')||'';if(a.indexOf('Attached element,')===0)o.push(a.slice(18,a.length-9));}return JSON.stringify(o);})()`);
  const chips = JSON.parse(String(chipsJson || '[]'));
  const linesJson = await ev(`(function(){var o=[];var eds=document.querySelectorAll('[contenteditable="true"], [contenteditable], textarea');for(var i=0;i<eds.length;i++){var t=((eds[i].innerText||eds[i].value)||'').trim();if(t&&t.indexOf('@')!==-1)o.push(t.slice(0,300));}return JSON.stringify(o);})()`);
  const lines = JSON.parse(String(linesJson || '[]'));
  console.log('CHIPS:', JSON.stringify(chips));
  console.log('LINES:', JSON.stringify(lines.map((l) => l.slice(0, 80))));

  // 1) drop our refs + GC
  await ev('window.__dshrCap = []; "ok"');
  await send('HeapProfiler.enable');
  await send('HeapProfiler.collectGarbage');
  await send('HeapProfiler.collectGarbage');
  await new Promise((r) => setTimeout(r, 300));

  // 2) snapshot + scan
  await send('HeapProfiler.takeHeapSnapshot', { reportProgress: false });
  fs.closeSync(fd);
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
  const hits = []; const imgs = [];
  for (let n = 0; n < nodeCount && hits.length < 12; n++) {
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
    else if (kind === 'image') imgs.push(String(nodes[n * NF + iId]));
  }
  console.log('post-GC element entries:', hits.length, 'image entries:', imgs.length);
  const seenIds = new Set(); let imgCount = 0;

  // 3) bridge each to live + full dump
  const DUMP = `function(){ try {
    var raw = this.imageData; var img = '', imgLen = 0;
    if (raw) {
      if (typeof raw === 'function') raw = raw();
      if (raw && !(raw instanceof Uint8Array)) raw = raw.buffer instanceof ArrayBuffer ? new Uint8Array(raw.buffer, raw.byteOffset || 0, raw.byteLength !== undefined ? raw.byteLength : undefined) : new Uint8Array(raw);
      imgLen = raw.length; var bin = ''; for (var j = 0; j < raw.length; j += 8192) bin += String.fromCharCode.apply(null, raw.subarray(j, j + 8192)); img = btoa(bin);
    }
    var v = this.value; if (typeof v === 'function') v = v();
    return JSON.stringify({ name: this.name, fullName: this.fullName || this.name, id: this.id || '', value: String(v), img: img, imgLen: imgLen, mime: this.imageMimeType || 'image/jpeg', dims: this.dimensions || null, anc: (this.ancestors || []).length, attrs: this.attributes || null, inner: this.innerText || '' });
  } catch (e) { return JSON.stringify({ err: e.message }); } }`;
  const IMGDUMP = `function(){ try {
    var raw = this.value; if (typeof raw === 'function') raw = raw();
    if (raw && !(raw instanceof Uint8Array)) raw = raw.buffer instanceof ArrayBuffer ? new Uint8Array(raw.buffer, raw.byteOffset || 0, raw.byteLength !== undefined ? raw.byteLength : undefined) : (raw.buffer ? new Uint8Array(raw.buffer) : new Uint8Array(raw));
    else if (!(raw instanceof Uint8Array)) raw = new Uint8Array(0);
    var bin = ''; for (var j = 0; j < raw.length; j += 8192) bin += String.fromCharCode.apply(null, raw.subarray(j, j + 8192));
    return JSON.stringify({ name: this.name || '', id: this.id || '', mime: this.mimeType || this.imageMimeType || '', ext: this.extname || '', w: this.width || null, h: this.height || null, b: btoa(bin), len: raw.length, keys: Object.keys(this).join(',') });
  } catch (e) { return JSON.stringify({ err: e.message }); } }`;
  for (const sid of imgs) {
    const g = await send('HeapProfiler.getObjectByHeapObjectId', { heapSnapshotObjectId: sid, objectId: sid });
    const oid = g.result && g.result.result ? g.result.result.objectId : null;
    if (!oid) { console.log('img bridge fail', sid); continue; }
    const d = await send('Runtime.callFunctionOn', { objectId: oid, functionDeclaration: IMGDUMP, returnByValue: true, declaration: false });
    const I = JSON.parse(String(((d.result || {}).result || {}).value || '{}'));
    if (!I || I.err || !I.b) { console.log('img dump fail', JSON.stringify(I).slice(0, 100)); continue; }
    if (seenIds.has(sid)) continue; seenIds.add(sid);
    imgCount++;
    const base = DIR_IMG + '-shot' + imgCount + '-' + String(I.name || 'x').replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 40);
    fs.writeFileSync(base + (I.ext && I.ext.indexOf('.') === 0 ? I.ext : '.png'), Buffer.from(I.b, 'base64'));
    console.log('IMG WROTE', base, '|', I.len + 'B', 'mime', I.mime, 'dims', I.w + 'x' + I.h, 'name', I.name, 'keys', I.keys.slice(0, 80));
  }
  const entries = [];
  for (const sid of hits) {
    const g = await send('HeapProfiler.getObjectByHeapObjectId', { heapSnapshotObjectId: sid, objectId: sid });
    const oid = g.result && g.result.result ? g.result.result.objectId : null;
    if (!oid) { console.log('bridge fail', sid); continue; }
    const d = await send('Runtime.callFunctionOn', { objectId: oid, functionDeclaration: DUMP, returnByValue: true, declaration: false });
    const E = JSON.parse(String(((d.result || {}).result || {}).value || '{}'));
    if (E && !E.err) entries.push(E);
  }
  entries.sort((a, b) => String(a.id).localeCompare(String(b.id)));
  console.log('live entries:', entries.map((e) => e.id).join(','));

  // 4) pair by creation order with DOM chips (chips render in model order = id order)
  function commentFor(name, idx) {
    for (const l of lines) {
      const tok = '@' + name;
      const p = l.indexOf(tok);
      if (p !== -1) { let rest = l.slice(p + tok.length).split('\n')[0].trim(); if (rest) return rest; }
    }
    const l = lines[idx] || '';
    const at = l.indexOf('@');
    return at !== -1 ? l.slice(at).split('\n')[0].replace(/^@\S+\s*/, '') : '';
  }
  // pair: for each chip, among entries whose 'Element:' tag matches chip name, take newest id; consume
  const used = new Set();
  const pairs = [];
  const pickFor = (name) => {
    const nm = String(name).trim();
    const hash = nm.indexOf('#');
    const tag = hash === -1 ? nm : nm.slice(0, hash);
    const idPart = hash === -1 ? null : nm.slice(hash + 1).split(/[.\s]/)[0];
    let best = null;
    for (const E of entries) {
      if (used.has(E.id)) continue;
      const elLine = String(E.value).split('\n').find((l) => l.indexOf('Element:') === 0) || '';
      const el = elLine.slice(9).trim();
      if (el.split(/[#.\s]/)[0] !== tag) continue;
      const elHash = el.indexOf('#');
      if (idPart) { if (elHash === -1 || el.slice(elHash + 1).split(/[.\s]/)[0] !== idPart) continue; }
      else if (elHash !== -1) continue;
      if (!best || String(E.id) > String(best.id)) best = E;
    }
    return best;
  };
  for (let i = 0; i < chips.length; i++) {
    const E = pickFor(chips[i]);
    if (!E) break;
    used.add(E.id);
    const elLine = String(E.value).split('\n').find((l) => l.indexOf('Element:') === 0) || '';
    pairs.push({ chip: chips[i], id: E.id, el: elLine.slice(9) });
    const base = DIR + '-chip' + (i + 1);
    let txt = '# chip: ' + (i + 1) + '/' + chips.length + '  name: ' + chips[i] + '\n# comment: ' + commentFor(chips[i], i) + '\n# entry id: ' + E.id + '\n# dims: ' + JSON.stringify(E.dims) + ' ancestors: ' + E.anc + '\n# attrs: ' + JSON.stringify(E.attrs || {}).slice(0, 200) + '\n# innerText: ' + String(E.inner).slice(0, 150) + '\n# via: LIVE via heap-GC bridge (no click/hover)\n\n' + E.value + '\n';
    if (E.img) { fs.writeFileSync(base + '.jpg', Buffer.from(E.img, 'base64')); txt += '\n## SCREENSHOT (att.imageData, ' + E.imgLen + 'B)\n文件: ' + base + '.jpg\n'; }
    fs.writeFileSync(base + '.txt', txt);
    console.log('WROTE', base, '| el:', elLine.slice(9, 60), '| img', E.imgLen + 'B');
  }
  console.log('PAIRS:', JSON.stringify(pairs));
  fs.unlinkSync(SNAP);
  ws.close(); process.exit(0);
})().catch((e) => { console.log('ERR', e.stack ? e.stack.slice(0, 400) : e.message); process.exit(1); });
