/**
 * THROWAWAY bench 2 — the FULL-COVERAGE merge (M = N) and the RETAINED set.
 *
 * bench.ts used the most-common tags, which only touched ~5% of the library.
 * A real bulk merge selects tags the user can SEE covering most of their
 * library, so M ≈ N. This file forces M = N and measures:
 *   1. executor.execute() wall-clock and ALLOCATED bytes, with a forced GC so
 *      the number is live-heap, not garbage.
 *   2. the exact count of MutationResult objects allocated (by monkeypatching
 *      nothing in src — we count by tracking Array.prototype spread? No: we
 *      count by the structural model AND by total allocated bytes).
 *   3. RETAINED memory: store.state.reports (20) + executor.reports (32).
 *   4. the renderExpanded O(expanded x characters) hypothesis, measured directly.
 */

import { installDom, counters, StubDocument, StubElement } from './domshim'
import type { LumiTagCharacter, CharacterTags } from '../src/shared/types'
import { buildTagIndex, charactersForTag } from '../src/frontend/tag-index'
import { planOperation } from '../src/frontend/mutations/planner'
import { MutationExecutor } from '../src/frontend/mutations/executor'
import type { CharacterRepository, CharacterMutationPort } from '../src/frontend/repository'
import { TagManagerStore } from '../src/frontend/store'
import { renderTagsSection } from '../src/frontend/ui/tags-section'
import { renderFailurePanel } from '../src/frontend/ui/failure-panel'

// ---------------------------------------------------------------------------

function mulberry32(seed: number): () => number {
  return function () {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const TAG_CATALOG_SIZE = 3000
const MERGE_TAGS = 5

/** Fixture where EVERY character carries all MERGE_TAGS => M = N. */
function makeFullCoverage(n: number): { characters: LumiTagCharacter[]; mergeTagNames: string[] } {
  const rnd = mulberry32(99)
  const mergeTagNames: string[] = []
  for (let i = 0; i < MERGE_TAGS; i++) mergeTagNames.push(`MERGE_${i}`)
  const filler: string[] = []
  for (let i = 0; i < TAG_CATALOG_SIZE; i++) filler.push(`tag_${i}`)

  const characters: LumiTagCharacter[] = []
  for (let i = 0; i < n; i++) {
    const extra = 5 + Math.floor(rnd() * 26) // 5..30 filler tags
    const tags = [...mergeTagNames]
    for (let t = 0; t < extra; t++) tags.push(filler[Math.floor(rnd() * TAG_CATALOG_SIZE)]!)
    characters.push({
      id: `char_${i}`,
      name: `Character ${i}`,
      description: 'desc '.repeat(20),
      personality: 'pers '.repeat(20),
      scenario: 'scen '.repeat(20),
      creator: 'creator',
      creator_notes: 'notes '.repeat(20),
      system_prompt: 'sys '.repeat(20),
      tags,
      image_id: null,
      created_at: 0,
      updated_at: 0,
    })
  }
  return { characters, mergeTagNames }
}

function liveHeap(): number {
  Bun.gc(true)
  return process.memoryUsage().heapUsed
}

function mkPort(characters: LumiTagCharacter[]): CharacterMutationPort {
  return {
    async getCharacter(id) { return characters.find((c) => c.id === id) ?? null },
    async updateTags(id, tags) { const c = characters.find((x) => x.id === id)!; c.tags = tags; return c },
    async getTagsBatch(ids) {
      const m = new Map<string, CharacterTags>()
      for (const id of ids) { const c = characters.find((x) => x.id === id); if (c) m.set(id, { id, tags: [...c.tags] }) }
      return m
    },
    async updateTagsBatch(updates) {
      const updated: CharacterTags[] = []
      for (const u of updates) { const c = characters.find((x) => x.id === u.characterId)!; c.tags = [...u.tags]; updated.push({ id: u.characterId, tags: [...u.tags] }) }
      return { updated, failures: [] }
    },
  }
}

// ---------------------------------------------------------------------------
// 1 + 2: executor.execute() with M = N
// ---------------------------------------------------------------------------

async function benchExecuteFull(n: number): Promise<void> {
  const { characters, mergeTagNames } = makeFullCoverage(n)
  const primary = mergeTagNames[0]!
  const targets = mergeTagNames.slice(1)
  const preview = planOperation(characters, { op: 'merge', primary, targets })
  const M = preview.mutations.length

  const executor = new MutationExecutor(mkPort(characters))
  await executor.execute(preview) // warm

  const before = liveHeap()
  const t0 = performance.now()
  const report = await executor.execute(preview)
  const ms = performance.now() - t0
  const afterPeak = process.memoryUsage().heapUsed
  Bun.gc(true)
  const afterGc = process.memoryUsage().heapUsed

  const retained = afterGc - before
  const churn = afterPeak - before
  // Structural allocation model for execute():
  //   progress() runs once per batch; each snapshot() clones ALL M results.
  const progressClones = M * M
  const onResultClones = M
  const finalSnapshots = 3 * M // report snapshot + stored snapshot + (getReport-style) — conservative
  const modeledAllocs = progressClones + onResultClones + finalSnapshots + M

  console.log(
    `N=${String(n).padStart(5)}  M=${String(M).padStart(5)}  ` +
    `execute()=${ms.toFixed(1).padStart(9)}ms  ` +
    `alloc-churn=${(churn / 1048576).toFixed(2).padStart(8)}MB  ` +
    `retained-after-GC=${(retained / 1048576).toFixed(2).padStart(7)}MB  ` +
    `result-objects-allocated(model)=${String(modeledAllocs).padStart(9)}  (progress term=${progressClones})`,
  )
}

// ---------------------------------------------------------------------------
// 3: RETAINED reports — store (20) + executor (32)
// ---------------------------------------------------------------------------

async function benchRetained(n: number, numMerges: number): Promise<void> {
  const { characters, mergeTagNames } = makeFullCoverage(n)
  const primary = mergeTagNames[0]!
  const targets = mergeTagNames.slice(1)
  const executor = new MutationExecutor(mkPort(characters))
  const repo = {
    async listAllCharacters() { return characters },
    async getCharacter(id) { return characters.find((c) => c.id === id) ?? null },
    async updateTags(id, tags) { const c = characters.find((x) => x.id === id)!; c.tags = tags; return c },
    async getTagsBatch(ids) {
      const m = new Map<string, CharacterTags>()
      for (const id of ids) { const c = characters.find((x) => x.id === id); if (c) m.set(id, { id, tags: [...c.tags] }) }
      return m
    },
    async updateTagsBatch(updates) {
      const updated: CharacterTags[] = []
      for (const u of updates) { const c = characters.find((x) => x.id === u.characterId)!; c.tags = [...u.tags]; updated.push({ id: u.characterId, tags: [...u.tags] }) }
      return { updated, failures: [] }
    },
  } as unknown as CharacterRepository

  const store = new TagManagerStore(repo, executor)
  await store.load()

  // Character DTO baseline held by the store.
  const base = liveHeap()
  const dtoBytes = base - 0

  // Run `numMerges` distinct merges so both retention windows fill.
  for (let i = 0; i < numMerges; i++) {
    // Vary the target set so each opId differs (needed to fill both windows).
    const t = [...mergeTagNames.slice(1), `tag_${i}`]
    await store.actions.runMergeTags(primary, t)
  }
  Bun.gc(true)
  const after = process.memoryUsage().heapUsed

  const reports = store.view.reports
  const totalResults = reports.reduce((s, r) => s + r.results.length, 0)

  console.log(
    `  RETAINED after ${numMerges} merges: store.reports=${reports.length} (cap 20), ` +
    `total MutationResults retained=${totalResults}, ` +
    `heap growth over baseline=${((after - base) / 1048576).toFixed(2)}MB ` +
    `(baseline with ${n} character DTOs = ${(dtoBytes / 1048576).toFixed(2)}MB)`,
  )
}

// ---------------------------------------------------------------------------
// 4: renderExpanded hypothesis — measured directly
// ---------------------------------------------------------------------------

async function benchRenderExpanded(n: number, expandedCount: number): Promise<void> {
  const { characters } = makeFullCoverage(n)
  const store = new TagManagerStore(
    { async listAllCharacters() { return characters } } as unknown as CharacterRepository,
    new MutationExecutor(mkPort(characters)),
  )
  await store.load()

  // Expand the first `expandedCount` tags (tags with high counts, so each
  // expanded list is large).
  const keys = store.view.tagRows.slice(0, expandedCount).map((r) => r.entry.key)
  for (const k of keys) store.actions.toggleTagExpanded(k)

  const view = store.view
  const index = view.tagIndex
  let idsRendered = 0
  for (const row of view.tagRows.slice(0, expandedCount)) {
    idsRendered += Math.min(charactersForTag(index, row.entry.name).length, 200)
  }

  // Time renderTagsSection directly (no shell).
  const doc = installDom()
  const container = doc.createElement('div')
  doc.body.appendChild(container)

  const RENDERS = 20
  counters.reset()
  let totalNodes = 0
  const t0 = performance.now()
  for (let i = 0; i < RENDERS; i++) {
    container.childNodes.length = 0
    const h = renderTagsSection({ container: container as unknown as HTMLElement, store })
    h.destroy()
  }
  const ms = (performance.now() - t0) / RENDERS
  totalNodes = counters.nodes / RENDERS

  // Time JUST the names-Map rebuild that renderExpanded does per expanded row.
  const tNames = performance.now()
  for (let r = 0; r < RENDERS; r++) {
    for (let e = 0; e < expandedCount; e++) {
      const names = new Map<string, string>()
      for (const c of view.characters) { if (c?.id) names.set(c.id, c.name) }
      void names
    }
  }
  const namesMs = (performance.now() - tNames) / RENDERS

  console.log(
    `  renderExpanded: N=${String(n).padStart(5)} expanded=${String(expandedCount).padStart(4)}  ` +
    `tagsSection.render=${ms.toFixed(2).padStart(8)}ms  ` +
    `namesMapRebuild(alone)=${namesMs.toFixed(2).padStart(8)}ms  ` +
    `idsRendered=${String(idsRendered).padStart(6)}  ` +
    `DOM nodes/render=${String(Math.round(totalNodes)).padStart(7)}`,
  )
  void totalNodes
}

// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  installDom()
  const Ns = [100, 300, 600, 1000, 1500]

  console.log('=== 1) executor.execute() with FULL-COVERAGE merge (M=N) ===')
  for (const n of Ns) await benchExecuteFull(n)

  console.log('\n=== 2) RETAINED memory after repeated merges ===')
  for (const n of [300, 600, 1000]) {
    for (const merges of [1, 5, 20, 40]) await benchRetained(n, merges)
  }

  console.log('\n=== 3) renderExpanded: names-Map rebuild cost ===')
  for (const n of [100, 300, 600, 1000]) {
    for (const exp of [0, 10, 50, 200, 500]) await benchRenderExpanded(n, exp)
  }
}

void main()