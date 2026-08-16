import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const { diffHunks, rejectHunk, acceptHunk, removedLinesForHunk } = require('../lib/inline-diff.js')
const NL = String.fromCharCode(10)
let failures = 0
function check(name, cond, extra) {
  if (cond) console.log('  ✓ ' + name)
  else { failures++; console.error('  ✗ ' + name + (extra !== undefined ? ' — ' + extra : '')) }
}

// reject restores the before content exactly
{
  const before = 'a' + NL + 'b' + NL + 'c' + NL
  const after = 'a' + NL + 'B2' + NL + 'd' + NL + 'c' + NL
  const hs = diffHunks(before, after)
  let cur = after
  for (const h of hs.reverse()) cur = rejectHunk(before, cur, h)
  check('reject-all restores before', cur === before, cur)
}
// accept then reject is identity-ish on the surviving text
{
  const before = 'a' + NL + 'b' + NL
  const after = 'a' + NL + 'X' + NL + 'b' + NL
  const hs = diffHunks(before, after)
  check('one hunk', hs.length === 1)
  const b2 = acceptHunk(before, after, hs[0])
  check('accept absorbs block', b2 === after, b2)
}
// reject one of two hunks, recompute, reject the rest
{
  const before = 'l1' + NL + 'l2' + NL + 'l3' + NL + 'l4' + NL
  const after = 'X1' + NL + 'l2' + NL + 'l3' + NL + 'X4' + NL + 'l5' + NL
  const hs = diffHunks(before, after)
  check('two hunks', hs.length === 2, JSON.stringify(hs))
  const after1 = rejectHunk(before, after, hs[0]) // revert X1
  const hs2 = diffHunks(before, after1)
  check('remaining tracked', hs2.length === 1, JSON.stringify(hs2))
  const after2 = rejectHunk(before, after1, hs2[0])
  check('final equals before', after2 === before, after2)
}
// deletion visibility helper
{
  const before = 'keep1' + NL + 'GONE' + NL + 'GONE2' + NL + 'keep2' + NL
  const after = 'keep1' + NL + 'keep2' + NL
  const hs = diffHunks(before, after)
  check('one del hunk', hs.length === 1 && hs[0].afterCount === 0)
  const removed = removedLinesForHunk(before, hs[0])
  check('removed lines listed', removed.length === 2 && removed[0] === 'GONE' && removed[1] === 'GONE2', JSON.stringify(removed))
}
// create: accept -> baseline is that block; reject -> empty
{
  const after = 'p1' + NL + 'p2' + NL
  const hs = diffHunks(null, after)
  const acc = acceptHunk(null, after, hs[0])
  check('create accept = after', acc === after)
  const rej = rejectHunk(null, after, hs[0])
  check('create reject = empty', rej === '', rej)
}
console.log(NL + (failures === 0 ? 'ALL PASS' : failures + ' FAILURE(S)'))
process.exit(failures === 0 ? 0 : 1)

// accept pure-deletion removes the rows from the baseline too
{
  const before = 'a' + NL + 'GONE' + NL + 'b' + NL
  const after = 'a' + NL + 'b' + NL
  const hs = diffHunks(before, after)
  check('one del hunk for accept test', hs.length === 1 && hs[0].afterCount === 0)
  const nb = acceptHunk(before, after, hs[0])
  check('accept del absorbs into baseline', nb === 'a' + NL + 'b' + NL, nb)
  check('diff now empty', diffHunks(nb, after).length === 0)
}
