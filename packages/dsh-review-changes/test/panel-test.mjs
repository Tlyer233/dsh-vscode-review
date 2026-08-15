import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { computeReviewEntries } = require('../lib/index.js')

let failures = 0
function check(name, cond, extra) {
  if (cond) console.log('  ✓ ' + name)
  else { failures++; console.error('  ✗ ' + name + (extra !== undefined ? ' — ' + extra : '')) }
}

const root = mkdtempSync(join(tmpdir(), 'review-changes-test-'))
const store = join(root, 'changes')
mkdirSync(store, { recursive: true })
const wbA = join(root, 'wbA')
const wbB = join(root, 'wbB')
mkdirSync(wbA, { recursive: true })
mkdirSync(wbB, { recursive: true })
const NL = '\n'

function putEntry(id, workbenchId, filePath, operation, before, after, status = 'committed', at) {
  writeFileSync(join(store, id + '.json'), JSON.stringify({
    id, at: at || '2026-08-15T10:00:00.000Z', tool: 'edit', filePath, operation, status,
  }))
  if (workbenchId !== null) {
    const e = JSON.parse(require('node:fs').readFileSync(join(store, id + '.json'), 'utf8'))
    e.workbenchId = workbenchId
    writeFileSync(join(store, id + '.json'), JSON.stringify(e, null, 2))
  }
  if (before !== undefined) writeFileSync(join(store, id + '.before'), before)
  if (after !== undefined) writeFileSync(join(store, id + '.after'), after)
}

// A workbench, one file with an unreviewed hunk
const f1 = join(wbA, 'a.py')
putEntry('a1', wbA, f1, 'update', 'x = 1' + NL, 'x = 2' + NL)
writeFileSync(f1, 'x = 2' + NL)

// B workbench, same file name and shape — must not leak into A
const f2 = join(wbB, 'a.py')
putEntry('b1', wbB, f2, 'update', 'x = 1' + NL, 'x = 2' + NL)
writeFileSync(f2, 'x = 2' + NL)

// Legacy entry without workbenchId — must never show
const f3 = join(wbA, 'legacy.py')
putEntry('legacy1', null, f3, 'update', 'a' + NL, 'b' + NL)
writeFileSync(f3, 'b' + NL)

// A workbench file whose decisions cover all hunks (legacy fallback)
const f4 = join(wbA, 'done.py')
putEntry('a2', wbA, f4, 'update', 'y = 1' + NL, 'y = 2' + NL)
writeFileSync(join(store, 'a2.decisions.json'), JSON.stringify([{ oa: 0, oc: 1, text: 'y = 2', type: 'accept' }]))
writeFileSync(f4, 'y = 2' + NL)

// A workbench file reviewed by the VSCode core: core.original == current -> hidden
const f5 = join(wbA, 'accepted-core.py')
putEntry('a3', wbA, f5, 'update', 'z = 1' + NL, 'z = 2' + NL)
writeFileSync(join(store, 'a3.core'), JSON.stringify({ id: 'a3', original: 'z = 2' + NL, modified: 'z = 2' + NL }))
writeFileSync(f5, 'z = 2' + NL)

// Same file with an older and a newer committed entry: panel uses newest
const f6 = join(wbA, 'multi.py')
putEntry('a4-old', wbA, f6, 'update', 'v = 1' + NL, 'v = 2' + NL, 'committed', '2026-08-15T09:00:00.000Z')
putEntry('a4-new', wbA, f6, 'update', 'v = 2' + NL, 'v = 3' + NL, 'committed', '2026-08-15T11:00:00.000Z')
writeFileSync(f6, 'v = 3' + NL)

// Newest entry already accepted: the file must NOT fall back to older committed
const f7 = join(wbA, 'resolved-newest.py')
putEntry('a5-old', wbA, f7, 'update', 'w = 1' + NL, 'w = 2' + NL, 'committed', '2026-08-15T09:00:00.000Z')
putEntry('a5-new', wbA, f7, 'update', 'w = 2' + NL, 'w = 3' + NL, 'accepted', '2026-08-15T11:00:00.000Z')
writeFileSync(f7, 'w = 3' + NL)

console.log('\n[1] workbench isolation + reviewed filtering')
{
  const entries = computeReviewEntries(store, wbA)
  check('only workbench A entries', entries.length === 2, JSON.stringify(entries.map(e => e.id)))
  check('a1 shown', entries.some(e => e.id === 'a1'))
  check('multi.py uses newest entry', entries.find(e => e.filePath === f6)?.id === 'a4-new')
  check('legacy no-workbenchId hidden', !entries.some(e => e.id === 'legacy1'))
  check('decisions-covered file hidden', !entries.some(e => e.id === 'a2'))
  check('core-accepted file hidden', !entries.some(e => e.id === 'a3'))
  check('newest-accepted file hides older committed', !entries.some(e => e.id === 'a5-old'))
}

console.log('\n[2] other workbench isolation')
{
  const entries = computeReviewEntries(store, wbB)
  check('workbench B sees only b1', entries.length === 1 && entries[0].id === 'b1')
  check('unknown workbench sees nothing', computeReviewEntries(store, join(root, 'nope')).length === 0)
}

console.log('\n[3] counts')
{
  const entries = computeReviewEntries(store, wbA)
  const a1 = entries.find(e => e.id === 'a1')
  check('a1 one hunk +1/-1', a1?.unreviewedHunks === 1 && a1?.additions === 1 && a1?.deletions === 1)
  const multi = entries.find(e => e.id === 'a4-new')
  check('multi one hunk', multi?.unreviewedHunks === 1)
}

rmSync(root, { recursive: true, force: true })
console.log('\n' + (failures === 0 ? 'ALL PASS' : failures + ' FAILURE(S)'))
process.exit(failures === 0 ? 0 : 1)
