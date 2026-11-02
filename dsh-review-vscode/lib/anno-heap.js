/* anno-heap.js — Heap-Bridge capture for the annotation pipeline (0.1.178).
 *
 * WHY: every Copilot attachment chip's FULL content (the official R8s string
 * + pick-time screenshot bytes) is frozen in the workbench renderer's JS heap
 * at annotation time; hovering is only a projection of it. This module reads
 * the source of truth directly — NO hover, NO click — via CDP:
 *   collectGarbage (drop stale) -> takeHeapSnapshot -> scan nodes for
 *   kind:'element' (value starts 'Attached Element Context') and kind:'image'
 *   -> HeapProfiler.getObjectByHeapObjectId bridges a snapshot id back to the
 *   LIVE object (same session!) -> read entry.value (full, no 1024B snapshot
 *   truncation) + entry.imageData / image value bytes.
 *
 * Pitfalls encoded here (paid for):
 *  - getObjectByHeapObjectId works ONLY in the same CDP session as the
 *    snapshot; response nests at result.result.objectId; param names differ
 *    across versions -> send both.
 *  - snapshot strings are truncated at 1024B (even concatenated pieces), so
 *    the bridge to live objects is mandatory for the full value.
 *  - imageData is a VSBuffer: take a.view = new Uint8Array(buf, byteOffset,
 *    byteLength) or you get the 64KB pool (starts 04 02 06, not FFD8).
 *  - the workbench title identifies the window; prefer the caller's title. */
'use strict'
const http = require('http')
const fs = require('fs')
const os = require('os')
const path = require('path')

function getTargets(port) {
  return new Promise((resolve, reject) => {
    const req = http.get('http://127.0.0.1:' + port + '/json', (res) => {
      let d = ''
      res.on('data', (c) => { d += c })
      res.on('end', () => { try { resolve(JSON.parse(d)) } catch (e) { reject(e) } })
    })
    req.on('error', reject)
    req.setTimeout(3000, () => { req.destroy(new Error('CDP /json timeout')) })
  })
}

const DUMP_ELEMENT = `function(){ try {
  var raw = this.imageData; var img = '', imgLen = 0;
  if (raw) {
    if (typeof raw === 'function') raw = raw();
    if (raw && !(raw instanceof Uint8Array)) raw = (raw.buffer instanceof ArrayBuffer) ? new Uint8Array(raw.buffer, raw.byteOffset || 0, raw.byteLength !== undefined ? raw.byteLength : undefined) : new Uint8Array(raw);
    if (!(raw instanceof Uint8Array)) raw = new Uint8Array(0);
    imgLen = raw.length; var bin = '';
    for (var j = 0; j < raw.length; j += 8192) bin += String.fromCharCode.apply(null, raw.subarray(j, j + 8192));
    img = btoa(bin);
  }
  var v = this.value; if (typeof v === 'function') v = v();
  return JSON.stringify({ name: this.name || '', fullName: this.fullName || this.name || '', id: this.id || '', value: String(v), img: img, imgLen: imgLen, mime: this.imageMimeType || 'image/jpeg', dims: this.dimensions || null, anc: (this.ancestors || []).length, attrs: this.attributes || null, inner: this.innerText || '' });
} catch (e) { return JSON.stringify({ err: e.message }); } }`

const DUMP_MISC = `function(){ try {
  var out = { kind: String(this.kind || ''), name: this.name || '', fullName: this.fullName || this.name || '', id: String(this.id || '') };
  var v = this.value;
  if (typeof v === 'function') { try { v = v(); } catch (e) { v = undefined; } }
  if (v && typeof v === 'object') {
    if (v.uri && (v.uri.fsPath || v.uri.path)) { out.uri = String(v.uri.fsPath || v.uri.path); if (v.range) { try { out.range = { start: v.range.startLineNumber || 1, end: v.range.endLineNumber || 1 }; } catch (e) { /* noop */ } } }
    else if (v.fsPath !== undefined || (v.path && v.scheme)) out.uri = String(v.fsPath || v.path);
    else { try { out.text = JSON.stringify(v).slice(0, 4000); } catch (e) { out.text = ''; } }
  } else if (v !== undefined && v !== null) out.text = String(v);
  return JSON.stringify(out);
} catch (e) { return JSON.stringify({ err: e.message }); } }`

const DUMP_IMAGE = `function(){ try {
  var raw = this.value; if (typeof raw === 'function') raw = raw();
  if (raw && !(raw instanceof Uint8Array)) raw = (raw.buffer instanceof ArrayBuffer) ? new Uint8Array(raw.buffer, raw.byteOffset || 0, raw.byteLength !== undefined ? raw.byteLength : undefined) : (raw.buffer ? new Uint8Array(raw.buffer) : new Uint8Array(raw));
  if (!(raw instanceof Uint8Array)) raw = new Uint8Array(0);
  var bin = ''; for (var j = 0; j < raw.length; j += 8192) bin += String.fromCharCode.apply(null, raw.subarray(j, j + 8192));
  return JSON.stringify({ name: this.name || '', id: this.id || '', mime: this.mimeType || this.imageMimeType || 'image/png', b: btoa(bin), len: raw.length });
} catch (e) { return JSON.stringify({ err: e.message }); } }`

/**
 * capture({ port, preferTitle, log }) ->
 *   { entries: [{name,fullName,id,value,img(b64),imgLen,mime,dims,anc,attrs,inner}],
 *     images:  [{name,id,mime,b(b64),len}] }
 * Throws on any unmet precondition (no CDP, no target, parse failure) so the
 * caller can fall back to the hover-card chain.
 */
async function capture(opts) {
  const WebSocket = require('ws')
  const log = (opts && opts.log) || { appendLine: () => {} }
  const port = (opts && opts.port) || 9223
  const prefer = (opts && opts.preferTitle) || ''
  const includeMisc = !!(opts && opts.includeMisc) // (0.1.184) 文件/代码段/终端: opt-in
  const targets = await getTargets(port)
  const pages = targets.filter((x) => x.type === 'page' && String(x.url || '').indexOf('vscode-file') === 0)
  if (!pages.length) throw new Error('no workbench CDP target on ' + port)
  const t = pages.find((p) => prefer && String(p.title || '').indexOf(prefer) !== -1) || pages[0]
  const ws = new WebSocket(t.webSocketDebuggerUrl, { maxPayload: 256 * 1024 * 1024 })
  const handlers = {}
  let mid = 1
  const snapPath = path.join(os.tmpdir(), 'dsh-anno-heap-' + Date.now() + '.heapsnapshot')
  let fd = null
  // (0.1.186) EVERY CDP call now has a deadline: the 15:12 round showed a
  // bridge response that NEVER arrived (getObjectByHeapObjectId on a GC-racing
  // node) — no error, no response — promise hung, annoSendSync stuck, prepared
  // never posted, client degraded to self-composed "(待补)" blocks.
  const send = (method, params, timeoutMs) => new Promise((resolve, reject) => {
    const myId = mid++
    let tk = null
    const settle = (fn) => (v) => { clearTimeout(tk); fn(v) }
    handlers[myId] = (m) => { if (m.error) reject(new Error(method + ': ' + m.error.message)); else resolve(m) }
    tk = setTimeout(() => { delete handlers[myId]; reject(new Error(method + ' TIMED OUT ' + (timeoutMs || 25000) + 'ms')) }, timeoutMs || 25000)
    ws.send(JSON.stringify({ id: myId, method, params: params || {} }))
    setTimeout(() => { if (handlers[myId]) { delete handlers[myId]; reject(new Error(method + ' timeout')) } }, 40000)
  })
  const onMessage = (d) => {
    let m = null
    try { m = JSON.parse(d.toString()) } catch (e) { return }
    if (m.method === 'HeapProfiler.addHeapSnapshotChunk' && m.params && m.params.chunk) {
      if (!fd) fd = fs.openSync(snapPath, 'w')
      fs.writeSync(fd, m.params.chunk)
      return
    }
    if (m.id && handlers[m.id]) { handlers[m.id](m); delete handlers[m.id] }
  }
  try {
    await new Promise((resolve, reject) => { ws.on('open', resolve); ws.on('error', reject) })
    ws.on('message', onMessage)
    await send('HeapProfiler.enable')
    await send('HeapProfiler.collectGarbage')
    await send('HeapProfiler.collectGarbage')
    log.appendLine('[anno][heap] snapshotting workbench heap...')
    await send('HeapProfiler.takeHeapSnapshot', { reportProgress: false }, 120000)
    if (fd !== null) { fs.closeSync(fd); fd = null }
    const size = fs.existsSync(snapPath) ? fs.statSync(snapPath).size : 0
    if (!size) throw new Error('empty snapshot')
    log.appendLine('[anno][heap] snapshot ' + Math.round(size / 1048576) + 'MB — scanning')
    const data = JSON.parse(fs.readFileSync(snapPath, 'utf8'))
    const meta = data.snapshot.meta
    const NF = meta.node_fields.length
    const nodes = data.nodes, edges = data.edges, strings = data.strings
    const typeNames = meta.node_types[0], edgeTypeNames = meta.edge_types[0]
    const iType = meta.node_fields.indexOf('type'), iName = meta.node_fields.indexOf('name')
    const iId = meta.node_fields.indexOf('id'), iEC = meta.node_fields.indexOf('edge_count')
    const TO = meta.edge_fields.indexOf('type'), TN = meta.edge_fields.indexOf('name_or_index'), TT = meta.edge_fields.indexOf('to_node')
    const TP = edgeTypeNames.indexOf('property')
    const T_OBJ = typeNames.indexOf('object')
    const nodeCount = nodes.length / NF
    const starts = new Float64Array(nodeCount + 1)
    for (let n = 0; n < nodeCount; n++) starts[n + 1] = starts[n] + nodes[n * NF + iEC] * 3
    const tn = (o) => typeNames[nodes[o * NF + iType]]
    const sOf = (o) => { const tt = tn(o); if (tt === 'string' || tt === 'concatenated string') { const s = strings[nodes[o * NF + iName]]; return typeof s === 'string' ? s : '' } return null }
    const elementIds = [], imageIds = [], miscIds = []
    for (let n = 0; n < nodeCount; n++) {
      if (nodes[n * NF + iType] !== T_OBJ) continue
      if (nodes[n * NF + iEC] < 3) continue
      const s = starts[n], e = starts[n + 1]
      let kind = null, val = null
      for (let k = s; k < e; k += 3) {
        if (edges[k + TO] !== TP) continue
        const pn = strings[edges[k + TN]]
        if (pn === 'kind') kind = sOf(Math.floor(edges[k + TT] / NF))
        else if (pn === 'value') val = sOf(Math.floor(edges[k + TT] / NF))
        if (kind !== null && (kind === 'image' || val !== null)) break
      }
      if (kind === 'element' && val && val.indexOf('Attached Element Context') === 0) elementIds.push(String(nodes[n * NF + iId]))
      else if (kind === 'image') imageIds.push(String(nodes[n * NF + iId]))
      else if (includeMisc && kind && kind !== 'element' && kind !== 'image') miscIds.push(String(nodes[n * NF + iId]))
    }
    // drop the giant graph before bridging (memory)
    log.appendLine('[anno][heap] scan: ' + elementIds.length + ' element, ' + imageIds.length + ' image entries — bridging live')
    const entries = [], images = []
    const bridge = async (sid, fn, out) => {
      // (0.1.185) one dead snapshot node ("Object is not available" — GC'd
      // between snapshot and bridge) must NOT sink the whole batch.
      let g = null
      try {
        g = await send('HeapProfiler.getObjectByHeapObjectId', { heapSnapshotObjectId: sid, objectId: sid })
      } catch (e) { return }
      if (!g || g.error) return
      const oid = g.result && g.result.result ? g.result.result.objectId : (g.result && g.result.objectId)
      if (!oid) return
      try {
        const d = await send('Runtime.callFunctionOn', { objectId: oid, functionDeclaration: fn, returnByValue: true, declaration: false })
        const E = JSON.parse(String(((d.result || {}).result || {}).value || '{}'))
        if (E && !E.err) out.push(E)
      } catch (e) { /* one bad entry must not sink the batch */ }
    }
    for (const sid of elementIds) await bridge(sid, DUMP_ELEMENT, entries)
    for (const sid of imageIds) await bridge(sid, DUMP_IMAGE, images)
    const misc = []
    for (const sid of miscIds) await bridge(sid, DUMP_MISC, misc)
    if (!entries.length && !images.length) throw new Error('heap held no attachment entries (bridge empty)')
    return { entries, images, misc }
  } finally {
    if (fd !== null) { try { fs.closeSync(fd) } catch (e) { /* noop */ } }
    try { fs.unlinkSync(snapPath) } catch (e) { /* noop */ }
    try { ws.close() } catch (e) { /* noop */ }
  }
}

module.exports = { capture }
