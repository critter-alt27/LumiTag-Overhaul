/** THROWAVERY bench 8 — corrected retention + PEAK transient heap during execute(). */
import { installDom } from './domshim'
import type { LumiTagCharacter, CharacterTags } from '../src/shared/types'
import { planOperation } from '../src/frontend/mutations/planner'
import { MutationExecutor } from '../src/frontend/mutations/executor'
import type { CharacterRepository, CharacterMutationPort } from '../src/frontend/repository'
import { TagManagerStore } from '../src/frontend/store'

function mulberry32(seed: number): () => number {
  return function () { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296 }
}
function mk(n: number, mergeTagCount: number) {
  const rnd = mulberry32(7)
  const filler: string[] = []
  for (let i = 0; i < 3000; i++) filler.push(`tag_${i}`)
  const merge: string[] = []
  for (let i = 0; i < mergeTagCount; i++) merge.push(`MERGE_${i}`)
  const PROSE = 'The quick brown fox jumps over the lazy dog. '.repeat(20)
  const characters: LumiTagCharacter[] = []
  for (let i = 0; i < n; i++) {
    const extra = 5 + Math.floor(rnd() * 26)
    // EVERY character carries ALL merge tags => each of the K merges touches all N.
    const tags = [...merge]
    for (let t = 0; t < extra; t++) tags.push(filler[Math.floor(rnd() * 3000)]!)
    characters.push({ id: `c${i}`, name: `C${i}`, description: PROSE, personality: PROSE, scenario: PROSE, creator: 'cr', creator_notes: PROSE, system_prompt: PROSE, tags, image_id: null, created_at: 0, updated_at: 0 })
  }
  return { characters, merge }
}

const n = Number(process.argv[2]!)
const K = Number(process.argv[3] ?? 5)
installDom()
const { characters, merge } = mk(n, 5 * K)
const p: CharacterMutationPort = {
  async getCharacter(id) { return characters.find((x) => x.id === id) ?? null },
  async updateTags(id, tags) { const x = characters.find((y) => y.id === id)!; x.tags = tags; return x },
  async getTagsBatch(ids) { const m = new Map<string, CharacterTags>(); for (const id of ids) { const x = characters.find((y) => y.id === id); if (x) m.set(id, { id, tags: [...x.tags] }) } return m },
  async updateTagsBatch(u) { const upd: CharacterTags[] = []; for (const b of u) { const x = characters.find((y) => y.id === b.characterId)!; x.tags = [...b.tags]; upd.push({ id: b.characterId, tags: [...b.tags] }) } return { updated: upd, failures: [] } },
}
const executor = new MutationExecutor(p)
const repo = { async listAllCharacters() { return characters }, ...p } as unknown as CharacterRepository
const store = new TagManagerStore(repo, executor)
await store.load()

for (let i = 0; i < 5; i++) Bun.gc(true)
const base = process.memoryUsage().heapUsed

// Sample peak heap DURING the first merge to catch the transient M^2 clone storm.
let peak = 0
const sampler = setInterval(() => { const h = process.memoryUsage().heapUsed; if (h > peak) peak = h }, 2)

const times: number[] = []
for (let k = 0; k < K; k++) {
  const s = merge.slice(k * 5, k * 5 + 5)
  const t0 = performance.now()
  await store.actions.runMergeTags(s[0]!, s.slice(1))
  times.push(performance.now() - t0)
}
clearInterval(sampler)
for (let i = 0; i < 8; i++) Bun.gc(true)
const settled = process.memoryUsage().heapUsed

const execReports = (executor as unknown as { reports: Map<string, { results: unknown[] }> }).reports
const execRetained = [...execReports.values()].reduce((s, r) => s + r.results.length, 0)
const storeReports = (store as unknown as { state: { reports: { results: unknown[] }[] } }).state.reports
const storeRetained = storeReports.reduce((s, r) => s + r.results.length, 0)
const total = execRetained + storeRetained

console.log(JSON.stringify({
  N: n, K,
  heapAfterLoadMB: +(base / 1048576).toFixed(2),
  peakDuringMergesMB: +(peak / 1048576).toFixed(2),
  peakMinusSettledMB: +((peak - settled) / 1048576).toFixed(2),
  settledAfterGCMB: +(settled / 1048576).toFixed(2),
  retainedDeltaMB: +((settled - base) / 1048576).toFixed(2),
  storeReports: storeReports.length, storeResults: storeRetained,
  executorReports: execReports.size, executorResults: execRetained,
  totalMutationResultObjects: total,
  bytesPerMutationResult: total ? +((settled - base) / total).toFixed(0) : 0,
  merge1_ms: +times[0]!.toFixed(1),
  mergeLast_ms: +times[times.length - 1]!.toFixed(1),
  characterDTOsHeld: store.view.characters.length,
}))