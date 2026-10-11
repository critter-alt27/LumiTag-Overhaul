/** THROWAORY bench 10 — exact per-clone byte cost of a MutationResult, GC-defeated. */
import type { LumiTagCharacter } from '../src/shared/types'
import { planOperation } from '../src/frontend/mutations/planner'
import { MutationExecutor } from '../src/frontend/mutations/executor'
import type { MutationResult } from '../src/frontend/mutations/report'
import type { CharacterMutationPort } from '../src/frontend/repository'

function mulberry32(seed: number): () => number {
  return function () { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296 }
}
const merge = ['MERGE_0', 'MERGE_1', 'MERGE_2', 'MERGE_3', 'MERGE_4']
const rnd = mulberry32(7)
const filler: string[] = []
for (let i = 0; i < 3000; i++) filler.push(`tag_${i}`)
const characters: LumiTagCharacter[] = []
for (let i = 0; i < 200; i++) {
  const extra = 5 + Math.floor(rnd() * 26)
  const tags = [...merge]
  for (let t = 0; t < extra; t++) tags.push(filler[Math.floor(rnd() * 3000)]!)
  characters.push({ id: `c${i}`, name: `C${i}`, description: '', personality: '', scenario: '', creator: '', creator_notes: '', system_prompt: '', tags, image_id: null, created_at: 0, updated_at: 0 })
}
const preview = planOperation(characters, { op: 'merge', primary: merge[0]!, targets: merge.slice(1) })
const port: CharacterMutationPort = {
  async getCharacter() { return null },
  async updateTags(id, tags) { return { ...(characters[0] as LumiTagCharacter), id, tags } },
  async getTagsBatch() { return new Map() },
  async updateTagsBatch(u) { return { updated: u.map((x) => ({ id: x.characterId, tags: x.tags })), failures: [] } },
}
const executor = new MutationExecutor(port)
const report = await executor.execute(preview)
const sample = report.results[0]!

function cloneResult(r: MutationResult): MutationResult {
  return { ...r, sourceTags: [...r.sourceTags], addedTags: [...r.addedTags], removedTags: [...r.removedTags], ...(r.error === undefined ? {} : { error: { ...r.error } }) }
}

// Grow a sink so nothing can be optimised away, and measure over several
// passes taking the max observed per-clone cost (minimises GC-skew downward).
const BATCH = 50_000
let best = 0
let sink: MutationResult[] = []
for (let pass = 0; pass < 12; pass++) {
  const h0 = process.memoryUsage().heapUsed
  const out: MutationResult[] = new Array(BATCH)
  for (let i = 0; i < BATCH; i++) out[i] = cloneResult(sample)
  const h1 = process.memoryUsage().heapUsed
  const per = (h1 - h0) / BATCH
  if (per > best) best = per
  sink = out
  // keep alive across the measurement, drop after
}
void sink.length

const structural =
  3 * 8 +                                    // 3 array headers approx
  (sample.sourceTags.length + sample.addedTags.length + sample.removedTags.length) * 8 +
  120                                        // the result object itself + strings are shared refs

console.log(JSON.stringify({
  sample_sourceTags: sample.sourceTags.length,
  sample_addedTags: sample.addedTags.length,
  sample_removedTags: sample.removedTags.length,
  measuredBytesPerClone_maxPass: +best.toFixed(1),
  structuralEstimateBytes: structural,
  modelled_M1000_MB: +((1000 * 1000 + 1000) * best / 1048576).toFixed(1),
  modelled_M2000_MB: +((2000 * 2000 + 2000) * best / 1048576).toFixed(1),
  modelled_M3000_MB: +((3000 * 3000 + 3000) * best / 1048576).toFixed(1),
}))