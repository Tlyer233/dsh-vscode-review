/* Official-recipe proof: for EVERY current Copilot chip, collect element data
 * with the same CDP commands the browser-view inspector uses
 * (DOM.getBoxModel / CSS.getMatchedStylesForNode / CSS.getComputedStyleForNode /
 * DOM.getOuterHTML / DOM.requestNode) and write one file per chip (+png),
 * formatted like the official R8s "Attached Element Context". */
const WebSocket = require('/Users/xi/.vscode/extensions/dsn.dsh-review-vscode-0.1.177/node_modules/ws');
const http = require('http');
const fs = require('fs');
try { require('fs').mkdirSync(require('path').join(require('os').tmpdir(), 'dsh-probe'), { recursive: true }); } catch (e) { /* noop */ }
const OUT = require('path').join(require('os').tmpdir(), 'dsh-probe', 'official_chip');

class CDP {
  constructor(url) { this.url = url; this.id = 1; this.h = {}; }
  open() {
    return new Promise((res, rej) => {
      this.ws = new WebSocket(this.url);
      this.ws.on('message', (d) => { const m = JSON.parse(d.toString()); if (m.id && this.h[m.id]) { this.h[m.id](m); delete this.h[m.id]; } });
      this.ws.on('open', res); this.ws.on('error', rej);
    });
  }
  send(method, params) { return new Promise((res) => { const myId = this.id++; this.h[myId] = res; this.ws.send(JSON.stringify({ id: myId, method, params: params || {} })); }); }
  async ev(expr, byValue) { const r = await this.send('Runtime.evaluate', { expression: expr, returnByValue: byValue !== false }); return r.result; }
  close() { try { this.ws.close(); } catch (e) { /* noop */ } }
}

(async () => {
  const targets = await new Promise((res) => http.get('http://127.0.0.1:9223/json', (r) => { let d = ''; r.on('data', c => d += c); r.on('end', () => res(JSON.parse(d))); }));
  const cop = targets.find((x) => (x.title || '').indexOf('— dsh-review-plugin') !== -1 && (x.url || '').indexOf('10.99.0.106') === -1 && x.type === 'page' && (x.url || '').indexOf('vscode-file') === 0 && (x.title || '').indexOf('Strata (') === -1) ||
              targets.find((x) => (x.title || '').indexOf('Comment on Elements') !== -1);
  const guest = targets.find((x) => (x.url || '').indexOf('10.99.0.106:8005') !== -1);
  if (!guest) throw new Error('no guest target');

  // 1) enumerate pins (comment + rect via hover-materialize) on the guest
  await new Promise((r) => setTimeout(r, 50));
  const g = new CDP(guest.webSocketDebuggerUrl);
  await g.open();
  await g.send('DOM.enable'); await g.send('CSS.enable');
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const getPins = async () => {
    const doc = await g.send('DOM.getDocument', { depth: -1, pierce: true });
    const pins = [];
    (function walk(n) {
      if (!n) return;
      const a = n.attributes || []; const at = {};
      for (let k = 0; k + 1 < a.length; k += 2) at[a[k]] = a[k + 1];
      if (/comment-pin\b/.test(at.class || '') && /Element comment/.test(at['aria-label'] || '')) {
        const m = /left:\s*([\d.]+)px.*?top:\s*([\d.]+)px/.exec(at.style || '');
        pins.push({ aria: at['aria-label'], left: m ? +m[1] : 0, top: m ? +m[2] : 0 });
      }
      for (const c of (n.children || [])) walk(c);
      for (const sh of (n.shadowRoots || [])) walk(sh);
    })(doc.result.root);
    return pins;
  };
  const getShownRect = async () => {
    const d2 = await g.send('DOM.getDocument', { depth: -1, pierce: true });
    let shown = null;
    (function w2(n) {
      if (!n || shown) return;
      const a = n.attributes || []; const at = {};
      for (let k = 0; k + 1 < a.length; k += 2) at[a[k]] = a[k + 1];
      if (/highlight-shape/.test(at.class || '') && !/display:\s*none/.test(at.style || '')) shown = { x: +at.x, y: +at.y, w: +at.width, h: +at.height };
      for (const c of (n.children || [])) w2(c);
      for (const sh of (n.shadowRoots || [])) w2(sh);
    })(d2.result.root);
    return shown;
  };
  const pinList = await getPins();
  console.log('PINS:', JSON.stringify(pinList.map((p) => p.aria)));
  if (!pinList.length) throw new Error('no pins on page');
  const pinRects = [];
  for (const p of pinList) {
    await g.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: p.left + 9, y: p.top + 9 });
    await g.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: p.left + 9.5, y: p.top + 9.5 });
    await sleep(280);
    let rr = await getShownRect();
    if (!rr) {
      await g.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 5, y: 600 }); await sleep(200);
      await g.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: p.left + 9, y: p.top + 9 });
      await g.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: p.left + 9.5, y: p.top + 9.5 });
      await sleep(320);
      rr = await getShownRect();
    }
    pinRects.push(rr);
    await g.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 5, y: 600 });
    await sleep(150);
  }
  let chips = pinList.map((p, idx) => ({ aria: p.aria, rect: pinRects[idx] }));
  const stamp0 = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);

  for (let i = 0; i < chips.length; i++) {
    const pinInfo = chips[i];
    const name = 'pin#' + (i + 1);
    const R = pinInfo.rect;
    if (!R) { console.log(i + 1, 'NO RECT'); continue; }
    const locExpr = `(function(){var L=${JSON.stringify(R)};var els=document.querySelectorAll('*');for(var i=0;i<els.length;i++){var r=els[i].getBoundingClientRect();if(Math.abs(r.left-L.x)<1.5&&Math.abs(r.top-L.y)<1.5&&Math.abs(r.width-L.w)<1.5&&Math.abs(r.height-L.h)<1.5)return els[i];}return null;})()`;
    // locate element: unique selector from chip name; get objectId + simple fields
    const selExpr = `(function(){
      var N=${JSON.stringify(name)};
      var m=N.match(/^(?:([a-zA-Z][a-zA-Z0-9]*)#)?([a-zA-Z][a-zA-Z0-9-]*)/); if(!m) return {err:'bad-name'};
      var sel=(m[1]||'')+(m[2]?'#'+m[2]:''); if(!sel) sel=m[1]||'*';
      var all=document.querySelectorAll(sel); if(all.length!==1) return {err:'count='+all.length, sel:sel};
      var el=all[0];
      return { el: el };
    })()`;
    const found = await g.send('Runtime.evaluate', { expression: `(function(){var L=${JSON.stringify(R)};var els=document.querySelectorAll('*');var hit=null;for(var i=0;i<els.length;i++){var r=els[i].getBoundingClientRect();if(Math.abs(r.left-L.x)<1.5&&Math.abs(r.top-L.y)<1.5&&Math.abs(r.width-L.w)<1.5&&Math.abs(r.height-L.h)<1.5){hit=els[i];break;}}if(!hit)return JSON.stringify({err:'no-element-at-rect'});var attrs=Array.prototype.slice.call(hit.attributes).map(function(x){return x.name+'='+x.value});var pathArr=[];var n2=hit;while(n2&&n2.tagName&&pathArr.length<30){var nm=n2.tagName.toLowerCase();if(n2.id)nm+='#'+n2.id;else if(n2.className&&typeof n2.className==='string'&&n2.className.trim())nm+='.'+n2.className.trim().split(/\s+/).join('.');pathArr.unshift(nm);n2=n2.parentElement;}return JSON.stringify({url:location.href,attrs:attrs,inner:(hit.innerText||'').trim().slice(0,2000),path:pathArr.join(' > '),name:hit.tagName.toLowerCase()+(hit.id?'#'+hit.id:(hit.className&&String(hit.className).trim()?'.'+String(hit.className).trim().split(/\s+/).join('.'):''))});})()`, returnByValue: true });
    let simple = null; try { simple = JSON.parse(String(found.result.result ? found.result.result.value : '')); } catch (e) { simple = { err: 'parse-simple' }; }
    if (!simple || simple.err) { console.log(i + 1, name, 'LOCATE', JSON.stringify(simple)); }

    const obj = await g.send('Runtime.evaluate', { expression: locExpr, returnByValue: false });
    const objectId = obj.result && obj.result.result ? obj.result.result.objectId : null;
    if (!objectId) { console.log(i + 1, name, 'no objectId (', simple && simple.err, ')'); continue; }
    const rn = await g.send('DOM.requestNode', { objectId });
    const nodeId = rn.result && rn.result.nodeId;
    if (!nodeId) { console.log(i + 1, name, 'no nodeId'); continue; }
    const box = await g.send('DOM.getBoxModel', { nodeId });
    const bm = box.result && box.result.model;
    const outer = await g.send('DOM.getOuterHTML', { nodeId });
    const ms = await g.send('CSS.getMatchedStylesForNode', { nodeId });
    const cs = await g.send('CSS.getComputedStyleForNode', { nodeId });

    // official-style assembly
    let rulesText = ''; const authorNames = new Set(); const referencedVars = new Set();
    const matched = (ms.result && ms.result.matchedCSSRules) || [];
    for (const mr of matched) {
      const rule = mr.rule || {}; const selTxt = (rule.selectors || [])[mr.matchedSelectors && mr.matchedSelectors[0] ? mr.matchedSelectors[0].ruleIndexes && 0 || 0 : 0] || (rule.selectors || [''])[0];
      const css = rule.style && rule.style.cssText || '';
      if (!css) continue;
      rulesText += selTxt + ' { ' + css + ' }\n';
      const props = css.split(';');
      for (const pr of props) { const nm2 = (pr.split(':')[0] || '').trim(); if (nm2) authorNames.add(nm2); }
      let vm; const vre = /var\(\s*(--[a-zA-Z0-9_-]+)/g; while ((vm = vre.exec(css))) referencedVars.add(vm[1]);
    }
    const comp = {}; for (const e2 of ((cs.result && cs.result.computedStyle) || [])) if (e2.name) comp[e2.name] = e2.value;
    const resolved = []; for (const p of authorNames) if (comp[p] !== undefined) resolved.push(p + ': ' + comp[p]);
    const varLines = []; for (const v of referencedVars) if (comp[v] !== undefined) varLines.push(v + ': ' + comp[v]);
    let cssBlock = rulesText.trim();
    if (resolved.length) cssBlock += '\n\n/* Resolved values */\n' + resolved.join('\n');
    if (varLines.length) cssBlock += '\n\n/* CSS variables */\n' + varLines.join('\n');

    // bounds from box model (border quad, axis aligned)
    let dims = null;
    if (bm && bm.border) { const xs = [bm.border[0], bm.border[2], bm.border[4], bm.border[6]]; const ys = [bm.border[1], bm.border[3], bm.border[5], bm.border[7]]; dims = { left: Math.min(...xs), top: Math.min(...ys), width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys) }; }

    // screenshot
    const shot = await g.send('Page.captureScreenshot', { format: 'png', clip: dims ? { x: Math.max(0, dims.left - 8), y: Math.max(0, dims.top - 8), width: Math.max(1, dims.width + 16), height: Math.max(1, dims.height + 16), scale: 1 } : undefined });

    const base = OUT + '-' + stamp0 + '-' + (i + 1);
    const comment = (pinInfo.aria || '').replace(/^Element comment \d+: /, '');
    let txt = '# element: ' + name + '\n# comment: ' + comment + '\n# time: ' + new Date().toString() +
      '\n# via: official-recipe CDP (getBoxModel+getMatchedStyles+getComputedStyle+getOuterHTML+requestNode)\n\n' +
      '## SCREENSHOT\n文件: ' + base + '.png\n\n' +
      'Attached Element Context from Integrated Browser\n\nElement: ' + name +
      '\n\nURL: ' + (simple && simple.url || guest.url) +
      '\n\nHTML Path: ' + (simple && simple.path || '?') +
      '\n\nOuter HTML:\n```html\n' + String(outer.result && outer.result.outerHTML).slice(0, 4000) + '\n```\n\n' +
      'Dimensions:\n' + (dims ? '- top: ' + Math.round(dims.top) + 'px\n- left: ' + Math.round(dims.left) + 'px\n- width: ' + Math.round(dims.width) + 'px\n- height: ' + Math.round(dims.height) + 'px' : '(no box)') + '\n\n' +
      'Inner Text:\n' + (simple && simple.inner || '') + '\n\n' +
      'Attributes:\n' + ((simple && simple.attrs || []).join('\n') || '(无)') + '\n\n' +
      'CSS:\n```css\n' + cssBlock + '\n```\n';
    fs.writeFileSync(base + '.txt', txt);
    if (shot.result && shot.result.data) fs.writeFileSync(base + '.png', Buffer.from(shot.result.data, 'base64'));
    console.log('WROTE:', base, dims ? JSON.stringify(dims) : '(no dims)', 'rules~' + cssBlock.length + 'B');
  }
  g.close(); process.exit(0);
})().catch((e) => { console.log('ERR', e.message); process.exit(1); });
