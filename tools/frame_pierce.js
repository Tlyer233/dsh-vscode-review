/* Debugger-frame proof: pause INSIDE the chip click listener (registered by the
 * widget, closure contains the attachment entry), read it from the call frame
 * WITHOUT hover, then resume. */
const WebSocket = require('/Users/xi/.vscode/extensions/dsn.dsh-review-vscode-0.1.177/node_modules/ws');
const http = require('http');
(async () => {
  const targets = await new Promise((res) => http.get('http://127.0.0.1:9223/json', (r) => { let d = ''; r.on('data', c => d += c); r.on('end', () => res(JSON.parse(d))); }));
  const wb = targets.find((x) => x.type === 'page' && (x.url || '').indexOf('vscode-file') === 0);
  const ws = new WebSocket(wb.webSocketDebuggerUrl);
  const handlers = {};
  let pausedCb = null;
  ws.on('message', (d) => {
    const m = JSON.parse(d.toString());
    if (m.method === 'Debugger.paused' && pausedCb) { pausedCb(m.params); return; }
    if (m.id && handlers[m.id]) { handlers[m.id](m); delete handlers[m.id]; }
  });
  let mid = 1;
  const send = (method, params) => new Promise((resolve) => { const myId = mid++; handlers[myId] = resolve; ws.send(JSON.stringify({ id: myId, method, params: params || {} })); });
  await new Promise((r) => { ws.on('open', r); });
  await send('Runtime.enable'); await send('Debugger.enable'); await send('DOM.enable');

  // locate chip position for a real click
  const posR = await send('Runtime.evaluate', { expression: `(function(){var as=document.querySelectorAll('.chat-attached-context-attachment');for(var i=0;i<as.length;i++){var a=as[i].getAttribute('aria-label')||'';if(a.indexOf('Attached element,')===0){var r=as[i].getBoundingClientRect();return JSON.stringify({x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2),aria:a});}}return '{}';})()`, returnByValue: true });
  const pos = JSON.parse(String(posR.result.result.value));
  console.log('CHIP AT:', JSON.stringify(pos));
  if (!pos.x) process.exit(0);

  // listeners -> pick click
  const chipObj = await send('Runtime.evaluate', { expression: `(function(){var as=document.querySelectorAll('.chat-attached-context-attachment');for(var i=0;i<as.length;i++){var a=as[i].getAttribute('aria-label')||'';if(a.indexOf('Attached element,')===0)return as[i];}return null;})()` });
  const chipId = chipObj.result.result.objectId;
  const ls = await send('DOMDebugger.getEventListeners', { objectId: chipId });
  const click = (ls.result.listeners || []).filter((l) => l.type === 'click' && !l.useCapture)[0] || (ls.result.listeners || []).filter((l) => l.type === 'click')[0];
  if (!click) { console.log('no click listener'); process.exit(0); }
  console.log('click listener @ script', click.scriptId, click.lineNumber, click.columnNumber);

  const bp = await send('Debugger.setBreakpoint', { location: { scriptId: click.scriptId, lineNumber: click.lineNumber, columnNumber: click.columnNumber }, condition: 'this&&this.getAttribute&&this.getAttribute("aria-label")&&this.getAttribute("aria-label").indexOf("Attached element,")===0' });
  console.log('breakpoint set:', bp.result && bp.result.actualLocation ? JSON.stringify(bp.result.actualLocation) : 'pending');

  const paused = new Promise((resolve) => { pausedCb = resolve; });
  // real click
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: pos.x, y: pos.y, button: 'left', clickCount: 1, buttons: 1 });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: pos.x, y: pos.y, button: 'left', clickCount: 1, buttons: 0 });

  const p = await Promise.race([paused, new Promise((r) => setTimeout(() => r(null), 6000))]);
  if (!p) { console.log('NOT PAUSED (bp missed?)'); process.exit(0); }
  const frame = p.callFrames[0];
  console.log('PAUSED IN:', frame.functionName || '(anon)', '@', frame.location.lineNumber);
  const read = await send('Debugger.evaluateOnCallFrame', {
    callFrameId: frame.callFrameId,
    expression: `(function(){
      var out={names:[],hits:[]};
      var sc=frame ? null : null;
      // scope chain via frame.scopeChain
      return JSON.stringify({ scopeChain: (function(){ return arguments.callee; })() });
    })()`, returnByValue: true
  }); void read;
  // dump scope chain summary
  for (const sc of frame.scopeChain) {
    const objId = sc.object && sc.object.objectId;
    if (!objId) continue;
    const props = await send('Runtime.getProperties', { objectId: objId, ownProperties: true });
    const names = (props.result || []).map((x) => x.name);
    if (names.length) console.log('SCOPE', sc.type, ':', names.slice(0, 25).join(','));
    for (const n of names) {
      const ev = await send('Debugger.evaluateOnCallFrame', { callFrameId: frame.callFrameId, expression: `(function(){try{var v=${n};if(!v||typeof v!=='object')return '';var s=JSON.stringify({n:${JSON.stringify(n)},kind:v.kind||'',keys:Object.keys(v).slice(0,16)});return s;}catch(e){return''}})()`, returnByValue: true });
      const v = ev.result && ev.result.result ? ev.result.result.value : '';
      if (v && /"kind":"element"/.test(String(v))) console.log('   *** ENTRY CANDIDATE:', String(v).slice(0, 240));
    }
  }
  // grab the value directly from `e` if it exists in scope
  const eVal = await send('Debugger.evaluateOnCallFrame', { callFrameId: frame.callFrameId, expression: `(function(){try{return JSON.stringify({kind:e.kind,name:e.name,valLen:(e.value||'').length,valHead:String(e.value||'').slice(0,160),img:!!e.imageData,anc:(e.ancestors||[]).length});}catch(err){return 'e? '+err.message}})()`, returnByValue: true });
  console.log('e =', String(eVal.result && eVal.result.result ? eVal.result.result.value : eVal.result).slice(0, 400));

  await send('Debugger.resume');
  await send('Debugger.removeBreakpoint', { breakpointId: bp.result.breakpointId });
  // close the untitled editor the click opened (Ctrl+W via workbench keybinding)
  await new Promise((r) => setTimeout(r, 400));
  await send('Input.dispatchKeyEvent', { type: 'keyDown', modifiers: 2, key: 'w', code: 'KeyW', windowsVirtualKeyCode: 87 });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', modifiers: 2, key: 'w', code: 'KeyW', windowsVirtualKeyCode: 87 });
  console.log('resumed + tried Ctrl+W to close opened editor');
  await send('Debugger.disable');
  ws.close(); process.exit(0);
})().catch((e) => { console.log('ERR', e.message); process.exit(1); });
