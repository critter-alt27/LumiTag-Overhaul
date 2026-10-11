/** THROWAVERY bench 9 — allocation churn of execute() with NO gc inside the window. */
import type { LumiTagCharacter } from '../src/shared/types'
import { planOperation } from '../src/frontend/mutations/planner'
import { MutationExecutor } from '../src/frontend/mutations/executor'
import type { MutationResult, OperationReport } from '../src/frontend/mutations/report'
import type { CharacterMutationPort } from '../src/frontend/repository'

function mulberry32(seed: number): () => number {
  return function () { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296 }
}
function mk(n: number) {
  const rnd = mulberry32(7)
  const filler: string[] = []
  for (let i = 0; i < 3000; i++) filler.push(`tag_${i}`)
  const merge = ['MERGE_0', 'MERGE_1', 'MERGE_2', 'MERGE_3', 'MERGE_4']
  const characters: LumiTagCharacter[] = []
  for (let i = 0; i < n; i++) {
    const extra = 5 + Math.floor(rnd() * 26)
    const tags = [...merge]
    for (let t = 0; t < extra; t++) tags.push(filler[Math.floor(rnd() * 3000)]!)
    characters.push({ id: `c${i}`, name: `C${i}`, description: 'd'.repeat(880), personality: 'p'.repeat(880), scenario: 's'.repeat(880), creator: 'cr', creator_notes: 'n'.repeat(880), system_prompt: 'y'.repeat(880), tags, image_id: null, created_at: 0, updated_at: 0 })
  }
  return { characters, merge }
}
function cloneResult(r: MutationResult): MutationResult {
  return { ...r, sourceTags: [...r.sourceTags], addedTags: [...r.addedTags], removedTags: [...r.removedTags], ...(r.error === undefined ? {} : { error: { ...r.error } }) }
}

const n = Number(process.argv[2]!)
const { characters, merge } = mk(n)
const preview = planOperation(characters, { op: 'merge', primary: merge[0]!, targets: merge.slice(1) })
const M = preview.mutations.length

const port: CharacterMutationPort = {
  async getCharacter() { return null },
  async updateTags(id, tags) { return { ...(characters[0] as LumiTagCharacter), id, tags } },
  async getTagsBatch() { return new Map() },
  async updateTagsBatch(u) { return { updated: u.map((x) => ({ id: x.characterId, tags: x.tags })), failures: [] } },
}
const executor = new MutationExecutor(port)
await executor.execute(preview) // warm/JIT

// --- 1. Byte size of ONE cloned MutationResult -----------------------------
const sample = await executor.execute(preview)
const one = cloneResult(sample.results[0]!)
const heapBeforeOne = process.memoryUsage().heapUsed
const copies: MutationResult[] = []
for (let i = 0; i < 100000; i++) copies.push(cloneResult(one))
const heapAfterOne = process.memoryUsage().heapUsed
const bytesPerClone = (heapAfterOne - heapBeforeOne) / 100000
void copies

// --- 2. Allocation churn of the real execute() (no GC in window) ----------
const h0 = process.memoryUsage().heapUsed
const t0 = performance.now()
await executor.execute(preview)
const ms = performance.now() - t0
const h1 = process.memoryUsage().heapUsed

console.log(JSON.stringify({
  N: n, M,
  bytesPerClonedResult: +bytesPerClone.toFixed(1),
  execute_ms: +ms.toFixed(1),
  clonesPerformed: M * M + M,
  modelledCloneBytesMB: +((M * M + M) * bytesPerClone / 1048576).toFixed(1),
  observedHeapGrowthNoGC_MB: +((h1 - h0) / 1048576).toFixed(1),
}))