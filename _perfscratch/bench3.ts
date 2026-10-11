/**
 * THROWAWAY bench 3 — attribution + stability.
 *
 * Q1: Is executor.execute() really quadratic in M? (repeat runs, log-log slope)
 * Q2: WHERE does the quadratic come from? (attribute to progress()->snapshot()->cloneResults)
 * Q3: How many commits + DOM nodes does ONE merge cost end-to-end?
 * Q4: What is retained after `merges` full-coverage merges?
 */

import { installDom, counters, StubDocument } from './domshim'
import type { LumiTagCharacter, CharacterTags } from '../src/shared/types'
import { planOperation } from '../src/frontend/mutations/planner'
import { MutationExecutor } from '../src/frontend/mutations/executor'
import type { MutationResult, OperationReport } from '../src/frontend/mutations/report'
import type { CharacterRepository, CharacterMutationPort } from '../src/frontend/repository'
import { TagManagerStore } from '../src/frontend/store'
import { renderShell } from '../src/frontend/ui/shell'
import { renderTagsSection } from '../src/frontend/ui/tags-section'
import { renderCharactersSection } from '../src/frontend/ui/characters-section'
import { renderFailurePanel } from '../src/frontend/ui/failure-panel'

function mulberry32(seed: number): () => number {
  return function () {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const TAG_CATALOG = 3000

function makeFullCoverage(n: number, mergeTagCount: number): { characters: LumiTagCharacter[]; mergeTagNames: string[] } {
  const rnd = mulberry32(7)
  const mergeTagNames: string[] = []
  for (let i = 0; i < mergeTagCount; i++) mergeTagNames.push(`MERGE_${i}`)
  const filler: string[] = []
  for (let i = 0; i < TAG_CATALOG; i++) filler.push(`tag_${i}`)
  const characters: LumiTagCharacter[] = []
  for (let i = 0; i < n; i++) {
    const extra = 5 + Math.floor(rnd() * 26)
    const tags = [...mergeTagNames]
    for (let t = 0; t < extra; t++) tags.push(filler[Math.floor(rnd() * TAG_CATALOG)]!)
    characters.push({
      id: `char_${i}`, name: `Character ${i}`,
      description: 'desc '.repeat(20), personality: 'pers '.repeat(20), scenario: 'scen '.repeat(20),
      creator: 'creator', creator_notes: 'notes '.repeat(20), system_prompt: 'sys '.repeat(20),
      tags, image_id: null, created_at: 0, updated_at: 0,
    })
  }
  return { characters, mergeTagNames }
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

/** Byte-for-byte replica of executor's cloneResult (for attribution only). */
function cloneResult(r: MutationResult): MutationResult {
  return { ...r, sourceTags: [...r.sourceTags], addedTags: [...r.addedTags], removedTags: [...r.removedTags], ...(r.error === undefined ? {} : { error: { ...r.error } }) }
}

// ---------------------------------------------------------------------------
// Q1 + Q2: execute() scaling + attribution
// ---------------------------------------------------------------------------

async function q1q2(Ns: number[], repeats: number): Promise<void> {
  console.log('=== Q1/Q2: executor.execute() with M=N, median of ' + repeats + ' runs ===')
  console.log('   N     M   exec(ms)   ms/M^2(us)  cloneLoop-alone(ms)  cloneLoop/M^2(us)  share%')
  const pts: { n: number; ms: number }[] = []
  for (const n of Ns) {
    const { characters, mergeTagNames } = makeFullCoverage(n, 5)
    const preview = planOperation(characters, { op: 'merge', primary: mergeTagNames[0]!, targets: mergeTagNames.slice(1) })
    const M = preview.mutations.length
    const executor = new MutationExecutor(mkPort(characters))
    await executor.execute(preview)

    const times: number[] = []
    let lastReport!: OperationReport
    for (let r = 0; r < repeats; r++) {
      const t0 = performance.now()
      lastReport = await executor.execute(preview)
      times.push(performance.now() - t0)
    }
    times.sort((a, b) => a - b)
    const ms = times[Math.floor(times.length / 2)]!

    // Attribution: time the M x cloneResults(M) loop in isolation, on the very
    // results array execute() produced.
    const results = lastReport.results
    const t1 = performance.now()
    for (let i = 0; i < M; i++) { void results.map(cloneResult) }
    const cloneLoop = performance.now() - t1

    const perM2 = (ms * 1000) / (M * M)
    const perM2c = (cloneLoop * 1000) / (M * M)
    console.log(
      String(n).padStart(5), String(M).padStart(6), ms.toFixed(1).padStart(9),
      perM2.toFixed(4).padStart(11), cloneLoop.toFixed(1).padStart(19),
      perM2c.toFixed(4).padStart(18), ((cloneLoop / ms) * 100).toFixed(0).padStart(7),
    )
    pts.push({ n, ms })
  }
  const xs = pts.map((p) => Math.log(p.n))
  const ys = pts.map((p) => Math.log(p.ms))
  const mx = xs.reduce((a, b) => a + b) / xs.length
  const my = ys.reduce((a, b) => a + b) / ys.length
  let num = 0, den = 0
  for (let i = 0; i < xs.length; i++) { num += (xs[i]! - mx) * (ys[i]! - my); den += (xs[i]! - mx) ** 2 }
  console.log(`   >>> log-log exponent of execute() vs N: ${(num / den).toFixed(2)}   (1.0=linear, 2.0=quadratic)`)
}

// ---------------------------------------------------------------------------
// Q3: one merge end-to-end — commits and DOM nodes
// ---------------------------------------------------------------------------

async function q3(Ns: number[]): Promise<void> {
  console.log('\n=== Q3: ONE full-coverage merge end-to-end (commits + DOM nodes) ===')
  console.log('   N    commits  computeView(ms)  shell.render(ms)  DOMnodes/render  reportResults')
  for (const n of Ns) {
    const { characters, mergeTagNames } = makeFullCoverage(n, 5)
    const port = mkPort(characters)
    const executor = new MutationExecutor(port)
    const repo = { async listAllCharacters() { return characters }, ...port } as unknown as CharacterRepository
    const store = new TagManagerStore(repo, executor)
    await store.load()

    let commits = 0
    store.subscribe(() => { commits++ })

    const doc = installDom()
    const root = doc.createElement('div')
    doc.body.appendChild(root)
    const handle = renderShell({
      root: root as unknown as HTMLElement, store,
      renderTagsSection: (c) => { renderTagsSection({ container: c, store }) },
      renderCharactersSection: (c) => { renderCharactersSection({ container: c, store }) },
      renderFailurePanel: (c) => { renderFailurePanel({ container: c, store }) },
      openDialog: () => {}, onShowSearchHelp: () => {},
    })

    // Measure a bare commit (computeView + full DOM rebuild).
    counters.reset()
    const t0 = performance.now()
    store.actions.setTagSort('name_zdesc')
    store.actions.setTagSort('name_asc')
    const renderMs = (performance.now() - t0) / 2
    const nodesPerRender = Math.round(counters.nodes / 2)

    commits = 0
    const tMerge = performance.now()
    await store.actions.runMergeTags(mergeTagNames[0]!, mergeTagNames.slice(1))
    const mergeMs = performance.now() - tMerge

    const res = store.view.reports[store.view.reports.length - 1]?.results.length ?? 0
    console.log(
      String(n).padStart(5), String(commits).padStart(9),
      renderMs.toFixed(1).padStart(16), renderMs.toFixed(1).padStart(15),
      String(nodesPerRender).padStart(16), String(res).padStart(14),
    )
    console.log(`        -> full runMergeTags() wall clock = ${mergeMs.toFixed(1)}ms`)
    handle.destroy()
  }
}

// ---------------------------------------------------------------------------
// Q4: retained reports after K full-coverage merges
// ---------------------------------------------------------------------------

async function q4(Ns: number[], K: number): Promise<void> {
  console.log(`\n=== Q4: RETAINED after ${K} full-coverage merges (each touches ALL N) ===`)
  console.log('   N  storeReports  MutationResultsRetained  MB/reportResults  MB/executorReports(est)  totalDelta(MB)')
  for (const n of Ns) {
    // Each merge gets a DISJOINT merge-tag set so all K operations have M = N.
    const totalMergeTags = 5 * K
    const { characters, mergeTagNames } = makeFullCoverage(n, totalMergeTags)
    const port = mkPort(characters)
    const executor = new MutationExecutor(port)
    const repo = { async listAllCharacters() { return characters }, ...port } as unknown as CharacterRepository
    const store = new TagManagerStore(repo, executor)
    await store.load()

    Bun.gc(true); Bun.gc(true)
    const base = process.memoryUsage().heapUsed

    for (let k = 0; k < K; k++) {
      const slice = mergeTagNames.slice(k * 5, k * 5 + 5)
      await store.actions.runMergeTags(slice[0]!, slice.slice(1))
    }
    Bun.gc(true); Bun.gc(true)
    const after = process.memoryUsage().heapUsed

    const reports = store.view.reports
    const retained = reports.reduce((s, r) => s + r.results.length, 0)
    // One MutationResult ~ (13 fields + 3 arrays of ~17 strings + strings).
    // Measure empirically instead: bytes per retained result.
    const bytesPerResult = retained > 0 ? (after - base) / retained : 0
    console.log(
      String(n).padStart(5), String(reports.length).padStart(13), String(retained).padStart(23),
      ((bytesPerResult * n) / 1048576).toFixed(2).padStart(16),
      ((bytesPerResult * 32 * n) / 1048576).toFixed(2).padStart(27),
      ((after - base) / 1048576).toFixed(2).padStart(15),
    )
    console.log(`        -> measured ${bytesPerResult.toFixed(0)} bytes per retained MutationResult`)
  }
}

async function main(): Promise<void> {
  installDom()
  await q1q2([100, 200, 400, 800, 1200, 1600], 5)
  await q3([100, 300, 600, 1000])
  await q4([300, 600, 1000], 5)
}

void main()