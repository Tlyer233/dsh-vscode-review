import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const { ReviewCore } = require('../lib/review-core.js')

const NL = '\n'
const line = (n) => 'L' + n

let failures = 0
function check(name, cond, extra) {
  if (cond) console.log('  ✓ ' + name)
  else { failures++; console.error('  ✗ ' + name + (extra !== undefined ? ' — ' + extra : '')) }
}

const base = [line(1), line(2), line(3), line(4), line(5)].join(NL)
const ai = ['X1', line(2), line(3), 'X4', line(5)].join(NL)

console.log('\n[1] initial diff')
{
  const c = new ReviewCore({ original: base, modified: ai })
  const h = c.hunks()
  check('two hunks', h.length === 2, JSON.stringify(h))
  check('not done', c.done === false)
}

console.log('\n[2] accept hunks one by one')
{
  const c = new ReviewCore({ original: base, modified: ai })
  const a1 = c.acceptHunk(0)
  check('accept hunk 0 ok', a1 && a1.remaining.length === 1, JSON.stringify(a1 && a1.remaining))
  check('baseline advanced', c.originalText === ['X1', line(2), line(3), line(4), line(5)].join(NL), JSON.stringify(c.originalText))
  const a2 = c.acceptHunk(0)
  check('accept last hunk ok', a2 && a2.remaining.length === 0)
  check('done after accepting all', c.done === true)
  check('original == modified', c.originalText === c.modifiedText)
}

console.log('\n[3] reject hunks one by one')
{
  const c = new ReviewCore({ original: base, modified: ai })
  const r1 = c.rejectHunk(1)
  check('reject hunk 1 ok', r1 && r1.remaining.length === 1, JSON.stringify(r1 && r1.remaining))
  check('doc block restored', c.modifiedText === ['X1', line(2), line(3), line(4), line(5)].join(NL), JSON.stringify(c.modifiedText)) 
  const r2 = c.rejectHunk(0)
  check('reject hunk 0 ok', r2 && r2.remaining.length === 0)
  check('done after rejecting all', c.done === true)
  check('modified == original', c.modifiedText === c.originalText)
}

console.log('\n[4] mixed accept/reject')
{
  const c = new ReviewCore({ original: base, modified: ai })
  c.acceptHunk(0)
  c.rejectHunk(0)
  check('accept then reject converges', c.done === true && c.originalText === c.modifiedText)
}

console.log('\n[5] pure insertion')
{
  const before = [line(1), line(2)].join(NL)
  const after = [line(1), 'NEW', line(2)].join(NL)
  const acc = new ReviewCore({ original: before, modified: after })
  acc.acceptHunk(0)
  check('accept insertion absorbs into baseline', acc.done === true && acc.originalText === acc.modifiedText)

  const rej = new ReviewCore({ original: before, modified: after })
  rej.rejectHunk(0)
  check('reject insertion removes it', rej.done === true && rej.modifiedText === rej.originalText)
}

console.log('\n[6] pure deletion')
{
  const before = [line(1), 'DEL', line(2)].join(NL)
  const after = [line(1), line(2)].join(NL)
  const acc = new ReviewCore({ original: before, modified: after })
  acc.acceptHunk(0)
  check('accept deletion drops baseline row', acc.done === true && acc.originalText === acc.modifiedText)

  const rej = new ReviewCore({ original: before, modified: after })
  rej.rejectHunk(0)
  check('reject deletion restores row', rej.done === true && rej.modifiedText === rej.originalText)
}

console.log('\n[7] acceptAll / rejectAll')
{
  const a = new ReviewCore({ original: base, modified: ai })
  a.acceptAll()
  check('acceptAll -> baseline = doc', a.done === true && a.originalText === a.modifiedText)

  const b = new ReviewCore({ original: base, modified: ai })
  b.rejectAll()
  check('rejectAll -> doc = baseline', b.done === true && b.modifiedText === b.originalText)
}

console.log('\n[8] guards + serialization')
{
  const c = new ReviewCore({ original: base, modified: ai })
  check('invalid index -> null', c.acceptHunk(-1) === null && c.acceptHunk(99) === null && c.rejectHunk(1.5) === null)
  check('no mutation on invalid index', c.hunks().length === 2)

  const round = ReviewCore.fromJSON(JSON.parse(JSON.stringify(c)))
  check('roundtrip preserves id/texts', round.id === c.id && round.originalText === c.originalText && round.modifiedText === c.modifiedText)
}

console.log('\n' + (failures === 0 ? 'ALL PASS' : failures + ' FAILURE(S)'))
process.exit(failures === 0 ? 0 : 1)
