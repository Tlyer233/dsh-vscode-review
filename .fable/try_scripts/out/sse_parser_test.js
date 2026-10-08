'use strict'
function makeSseParser(onEvent) {
  const decoder = new TextDecoder('utf-8')
  let pending = '', curEvent = '', dataLines = []
  return { feed(chunk) {
    pending += decoder.decode(chunk, { stream: true })
    let nl
    while ((nl = pending.indexOf('\n')) !== -1) {
      let line = pending.slice(0, nl); pending = pending.slice(nl + 1)
      if (line.endsWith('\r')) line = line.slice(0, -1)
      if (line === '') {
        if (dataLines.length > 0) onEvent(curEvent || 'message', dataLines.join('\n'))
        curEvent = ''; dataLines = []; continue
      }
      if (line.charAt(0) === ':') continue
      const colon = line.indexOf(':')
      const field = colon === -1 ? line : line.slice(0, colon)
      let value = colon === -1 ? '' : line.slice(colon + 1)
      if (value.startsWith(' ')) value = value.slice(1)
      if (field === 'event') curEvent = value
      else if (field === 'data') dataLines.push(value)
    }
  } }
}
const got = []
const p = makeSseParser((ev, data) => got.push({ ev, data }))
const full =
  ': connected\n\n' +
  ':hb\n\n' +
  'event: job\r\ndata: {"id":"bash-1","kind":"bash","label":"tick","status":"running","cwd":"/ws"}\r\n\r\n' +
  'event: output\ndata: {"id":"bash-1","text":"line1\\nline2 中文"}\n\n'
const buf = Buffer.from(full, 'utf8')
p.feed(buf.subarray(0, 5)); p.feed(buf.subarray(5, 40)); p.feed(buf.subarray(40))
const job = got.find((g) => g.ev === 'job')
const out = got.find((g) => g.ev === 'output')
const ok = got.length === 2
  && job && job.data === '{"id":"bash-1","kind":"bash","label":"tick","status":"running","cwd":"/ws"}'
  && out && JSON.parse(out.data).text === 'line1\nline2 中文'
console.log('events:', got.length, '| job ok:', !!job, '| output ok:', !!out, '| text:', out && JSON.stringify(JSON.parse(out.data).text))
console.log(ok ? 'PASS' : 'FAIL')
process.exit(ok ? 0 : 1)
