/** THROWAVERY bench 7 — what is RETAINED after merges, precisely. */
import { installDom } from './domshim'
import type { LumiTagCharacter, CharacterTags } from '../src/shared/types'
import { planOperation } from '../src/frontend/mutations/planner'
import { MutationExecutor } from '../src/frontend/mutations/executor'
import type { CharacterRepository, CharacterMutationPort } from '../src/frontend/repository'
import { TagManagerStore } from '../src/frontend/store'

function mulberry32(seed: number): () => number {
  return function () { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296 }
}
/** Prose-sized DTOs, like real character cards. */
function mk(n: number, mergeTagCount: number) {
  const rnd = mulberry32(7)
  const filler: string[] = []
  for (let i = 0; i < 3000; i++) filler.push(`tag_${i}`)
  const merge: string[] = []
  for (let i = 0; i < mergeTagCount; i++) merge.push(`MERGE_${i}`)
  const PROSE = 'The quick brown fox jumps over the lazy dog. '.repeat(20) // ~880 chars each field
  const characters: LumiTagCharacter[] = []
  for (let i = 0; i < n; i++) {
    const extra = 5 + Math.floor(rnd() * 26)
    const tags = mergeTagCount > 0 ? [...merge.slice(0, 5)] : []
    for (let t = 0; t < extra; t++) tags.push(filler[Math.floor(rnd() * 3000)]!)
    characters.push({ id: `c${i}`, name: `C${i}`, description: PROSE, personality: PROSE, scenario: PROSE, creator: 'creator', creator_notes: PROSE, system_prompt: PROSE, tags, image_id: null, created_at: 0, updated_at: 0 })
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

for (let k = 0; k < K; k++) {
  const s = merge.slice(k * 5, k * 5 + 5)
  await store.actions.runMergeTags(s[0]!, s.slice(1))
}
for (let i = 0; i < 8; i++) Bun.gc(true)
const after = process.memoryUsage().heapUsed

// Reach the executor's private retained-report Map at runtime (JS has no
// real privacy) to count exactly what it holds.
const execReports = (executor as unknown as { reports: Map<string, { results: unknown[] }> }).reports
const execRetained = [...execReports.values()].reduce((s, r) => s + r.results.length, 0)
const storeReports = (store as unknown as { state: { reports: { results: unknown[] }[] } }).state.reports
const storeRetained = storeReports.reduce((s, r) => s + r.results.length, 0)
const liveChars = store.view.characters.length

console.log(JSON.stringify({
  N: n, K,
  heapAfterLoadMB: +(base / 1048576).toFixed(2),
  heapDeltaMB: +((after - base) / 1048576).toFixed(2),
  storeReports: storeReports.length,
  storeMutationResultsRetained: storeRetained,
  executorReports: execReports.size,
  executorMutationResultsRetained: execRetained,
  totalMutationResultObjects: storeRetained + execRetained,
  bytesPerMutationResult: storeRetained + execRetained ? +((after - base) / (storeRetained + execRetained)).toFixed(0) : 0,
  fullCharacterDTOsHeld: liveChars,
}))