/** THROWAVERY bench 6 — hard structural count of executor.execute() clone work. */
import { installDom } from './domshim'
import type { LumiTagCharacter, CharacterTags } from '../src/shared/types'
import { planOperation } from '../src/frontend/mutations/planner'
import { MutationExecutor } from '../src/frontend/mutations/executor'
import type { OperationReport } from '../src/frontend/mutations/report'
import type { CharacterMutationPort } from '../src/frontend/repository'

function mulberry32(seed: number): () => number {
  return function () { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296 }
}
function mk(n: number) {
  const rnd = mulberry32(7)
  const filler: string[] = []
  for (let i = 0; i < 3000; i++) filler.push(`tag_${i}`)
  const merge: string[] = []
  for (let i = 0; i < 5; i++) merge.push(`MERGE_${i}`)
  const characters: LumiTagCharacter[] = []
  for (let i = 0; i < n; i++) {
    const extra = 5 + Math.floor(rnd() * 26)
    const tags = [...merge]
    for (let t = 0; t < extra; t++) tags.push(filler[Math.floor(rnd() * 3000)]!)
    characters.push({ id: `c${i}`, name: `C${i}`, description: '', personality: '', scenario: '', creator: '', creator_notes: '', system_prompt: '', tags, image_id: null, created_at: 0, updated_at: 0 })
  }
  return { characters, merge }
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

// Count onProgress emissions (each = one snapshot() = one cloneResults(M)).
// ALSO record the identity of the results array each snapshot hands back: a NEW
// array means a real clone happened.
let emissions = 0
const seenArrays = new Set<readonly unknown[]>()
const executor = new MutationExecutor(port)
const report = await executor.execute(preview, {
  onProgress: (r: OperationReport) => { emissions++; seenArrays.add(r.results) },
})

console.log(JSON.stringify({
  N: n,
  mutations_M: M,
  onProgress_emissions: emissions,
  distinct_result_arrays_built: seenArrays.size,
  distinct_result_OBJECTS_across_snapshots: seenArrays.size * M,
  predicted_clones_if_snapshot_per_batch: M * M,
  final_report_results: report.results.length,
}))