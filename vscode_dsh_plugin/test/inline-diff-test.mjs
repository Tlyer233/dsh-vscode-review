import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const { diffHunks, splitLines } = require('../lib/inline-diff.js')
const NL = String.fromCharCode(10)

let failures = 0
function check(name, cond, extra) {
  if (cond) console.log('  ✓ ' + name)
  else { failures++; console.error('  ✗ ' + name + (extra !== undefined ? ' — ' + extra : '')) }
}
const line = (n) => 'L' + n

// case 1: middle replace
{
  const before = [line(1), line(2), line(3)].join(NL)
  const after = [line(1), 'CHANGED', line(3)].join(NL)
  const h = diffHunks(before, after)
  check('replace -> 1 hunk', h.length === 1, JSON.stringify(h))
  check('replace coords', h[0].beforeStart === 1 && h[0].beforeCount === 1 && h[0].afterStart === 1 && h[0].afterCount === 1)
}
// case 2: insertion in middle
{
  const before = [line(1), line(2)].join(NL)
  const after = [line(1), 'NEW', line(2)].join(NL)
  const h = diffHunks(before, after)
  check('insert -> 1 hunk', h.length === 1, JSON.stringify(h))
  check('insert coords', h[0].beforeCount === 0 && h[0].afterCount === 1 && h[0].afterStart === 1)
}
// case 3: deletion
{
  const before = [line(1), 'DEL', line(2)].join(NL)
  const after = [line(1), line(2)].join(NL)
  const h = diffHunks(before, after)
  check('delete -> 1 hunk', h.length === 1, JSON.stringify(h))
  check('delete coords', h[0].beforeCount === 1 && h[0].afterCount === 0 && h[0].beforeStart === 1)
}
// case 4: multiple hunks
{
  const before = [line(1), line(2), line(3), line(4), line(5)].join(NL)
  const after = ['X1', line(2), line(3), 'X4', line(5)].join(NL)
  const h = diffHunks(before, after)
  check('two hunks', h.length === 2, JSON.stringify(h))
}
// case 5: create
{
  const h = diffHunks(null, [line(1), line(2)].join(NL))
  check('create -> whole hunk', h.length === 1 && h[0].beforeStart === -1 && h[0].afterCount === 2, JSON.stringify(h))
}
// case 6: identical
{
  const h = diffHunks('a' + NL + 'b' + NL, 'a' + NL + 'b' + NL)
  check('identical -> 0 hunks', h.length === 0)
}
// case 7: append at end
{
  const before = [line(1)].join(NL)
  const after = [line(1), line(2)].join(NL)
  const h = diffHunks(before, after)
  check('append -> 1 hunk', h.length === 1 && h[0].beforeStart === 1 && h[0].beforeCount === 0 && h[0].afterStart === 1, JSON.stringify(h))
}
// case 8: splitLines no trailing empty
{
  const s = splitLines('a' + NL + 'b' + NL)
  check('splitLines strips trailing empty', s.length === 2 && s[0] === 'a' && s[1] === 'b')
}
console.log(NL + (failures === 0 ? 'ALL PASS' : failures + ' FAILURE(S)'))
process.exit(failures === 0 ? 0 : 1)

