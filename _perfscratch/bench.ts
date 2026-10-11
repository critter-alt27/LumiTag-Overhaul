/**
 * THROWAWAY measurement harness. Delete this whole directory when done.
 *
 * Measures the LumiTag post-write path per N characters:
 *   planOperation -> executor.execute -> store.refresh/commit -> shell render.
 */

import { installDom, counters, StubDocument, StubElement } from './domshim'
import type { LumiTagCharacter, CharacterTags } from '../src/shared/types'
import { buildTagIndex } from '../src/frontend/tag-index'
import { planOperation } from '../src/frontend/mutations/planner'
import { MutationExecutor } from '../src/frontend/mutations/executor'
import type { MutationOp, OperationPreview } from '../src/frontend/mutations/planner'
import type { MutationResult } from '../src/frontend/mutations/report'
import { TagManagerStore } from '../src/frontend/store'
import type { CharacterRepository, CharacterMutationPort } from '../src/frontend/repository'
import { renderShell } from '../src/frontend/ui/shell'
import { renderTagsSection } from '../src/frontend/ui/tags-section'
import { renderCharactersSection } from '../src/frontend/ui/characters-section'
import { renderFailurePanel } from '../src/frontend/ui/failure-panel'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** Deterministic PRNG so every N is reproducible. */
function mulberry32(seed: number): () => number {
  return function () {
    seed |= 0
    seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const TAG_CATALOG_SIZE = 3000

function makeFixture(n: number): { characters: LumiTagCharacter[]; tags: string[] } {
  const rnd = mulberry32(1234)
  const tags: string[] = []
  for (let i = 0; i < TAG_CATALOG_SIZE; i++) tags.push(`tag_${i}`)

  const characters: LumiTagCharacter[] = []
  for (let i = 0; i < n; i++) {
    const tagCount = 5 + Math.floor(rnd() * 26) // 5..30
    const picked: string[] = []
    for (let t = 0; t < tagCount; t++) picked.push(tags[Math.floor(rnd() * TAG_CATALOG_SIZE)]!)
    characters.push({
      id: `char_${i}`,
      name: `Character ${i} ${'x'.repeat(i % 7)}`,
      description: 'desc '.repeat(20),
      personality: 'pers '.repeat(20),
      scenario: 'scen '.repeat(20),
      creator: 'creator',
      creator_notes: 'notes '.repeat(20),
      system_prompt: 'sys '.repeat(20),
      tags: picked,
      image_id: null,
      created_at: 0,
      updated_at: 0,
    })
  }
  return { characters, tags }
}

/**
 * Pick the `count` MOST COMMON tags as merge targets.
 *
 * This is what a real bulk merge looks like: the user selects the tags that
 * visibly cover most of their library. Picking rare random tags would produce a
 * ~5-mutation preview and measure nothing.
 */
function pickMergeTags(characters: LumiTagCharacter[], count: number): { primary: string; targets: string[] } {
  const index = buildTagIndex(characters)
  const entries = index.tags.filter((e) => e.count > 0).sort((a, b) => b.count - a.count)
  const primary = entries[0]!.name
  const targets: string[] = []
  for (let i = 1; i < entries.length && targets.length < count; i++) targets.push(entries[i]!.name)
  return { primary, targets }
}

// ---------------------------------------------------------------------------
// Timing helpers
// ---------------------------------------------------------------------------

function time<T>(label: string, fn: () => T | Promise<T>): Promise<{ label: string; ms: number; value: T }> {
  return (async () => {
    const t0 = performance.now()
    const value = await fn()
    const ms = performance.now() - t0
    return { label, ms, value }
  })()
}

function fmt(n: number): string {
  return n.toFixed(2).padStart(9)
}

// ---------------------------------------------------------------------------
// Stage 1: pure functions, measured standalone
// ---------------------------------------------------------------------------

interface StageRow {
  stage: string
  n: number
  ms: number
  /** Some stages report a count instead of ms (DOM nodes, results). */
  count: number | null
  extra: string
}

async function benchPlan(n: number): Promise<StageRow> {
  const { characters } = makeFixture(n)
  const { primary, targets } = pickMergeTags(characters, 5)
  // warm
  planOperation(characters, { op: 'merge', primary, targets })
  const t0 = performance.now()
  const preview = planOperation(characters, { op: 'merge', primary, targets })
  const ms = performance.now() - t0
  return { stage: 'planOperation(merge~5)', n, ms, count: preview.mutations.length, extra: 'mutations' }
}

async function benchExecute(n: number): Promise<StageRow> {
  const { characters } = makeFixture(n)
  const { primary, targets } = pickMergeTags(characters, 5)
  const preview = planOperation(characters, { op: 'merge', primary, targets })

  const port: CharacterMutationPort = {
    async getCharacter(id) {
      return characters.find((c) => c.id === id) ?? null
    },
    async updateTags(id, tags) {
      const c = characters.find((x) => x.id === id)!
      c.tags = tags
      return c
    },
    async getTagsBatch(ids) {
      const m = new Map<string, CharacterTags>()
      for (const id of ids) {
        const c = characters.find((x) => x.id === id)
        if (c) m.set(id, { id, tags: [...c.tags] })
      }
      return m
    },
    async updateTagsBatch(updates) {
      const updated: CharacterTags[] = []
      for (const u of updates) {
        const c = characters.find((x) => x.id === u.characterId)!
        c.tags = u.tags
        updated.push({ id: u.characterId, tags: [...u.tags] })
      }
      return { updated, failures: [] }
    },
  }

  const executor = new MutationExecutor(port)
  // warm
  await executor.execute(preview)
  const t0 = performance.now()
  const report = await executor.execute(preview)
  const ms = performance.now() - t0
  return { stage: 'executor.execute()', n, ms, count: report.results.length, extra: 'results' }
}

/** Isolate the per-batch `progress() -> snapshot() -> cloneResults()` inner loop. */
async function benchExecuteProgressCost(n: number): Promise<StageRow> {
  const { characters } = makeFixture(n)
  const { primary, targets } = pickMergeTags(characters, 5)
  const preview = planOperation(characters, { op: 'merge', primary, targets })

  const port: CharacterMutationPort = {
    async getCharacter() { return null },
    async updateTags(id, tags) { return { ...(characters[0] as LumiTagCharacter), id, tags } },
    async getTagsBatch() { return new Map() },
    async updateTagsBatch(updates) {
      return { updated: updates.map((u) => ({ id: u.characterId, tags: u.tags })), failures: [] }
    },
  }

  const executor = new MutationExecutor(port)
  await executor.execute(preview)
  const t0 = performance.now()
  await executor.execute(preview)
  const ms = performance.now() - t0

  // Also measure the pure clone cost that dominates: how many result objects are
  // cloned across the whole execute (batches * results).
  const batches = preview.mutations.length
  return {
    stage: 'executor.execute() [clone]',
    n,
    ms,
    count: batches * batches,
    extra: 'approx result-clones (batches^2)',
  }
}

async function benchTagIndex(n: number): Promise<StageRow> {
  const { characters } = makeFixture(n)
  buildTagIndex(characters)
  const t0 = performance.now()
  const index = buildTagIndex(characters)
  const ms = performance.now() - t0
  return { stage: 'buildTagIndex()', n, ms, count: index.tags.length, extra: 'tags' }
}

async function benchComputeView(n: number): Promise<StageRow> {
  // computeView is private; drive it through repeated commits on a real store.
  const { characters } = makeFixture(n)
  const repo = {
    async listAllCharacters() { return characters },
    async listPage() { return { data: characters, total: characters.length } },
    async getCharacter(id) { return characters.find((c) => c.id === id) ?? null },
    async updateTags(id, tags) { const c = characters.find((x) => x.id === id)!; c.tags = tags; return c },
    async getTagsBatch(ids) {
      const m = new Map<string, CharacterTags>()
      for (const id of ids) { const c = characters.find((x) => x.id === id); if (c) m.set(id, { id, tags: [...c.tags] }) }
      return m
    },
    async updateTagsBatch(updates) {
      const updated: CharacterTags[] = []
      for (const u of updates) { const c = characters.find((x) => x.id === u.characterId)!; c.tags = u.tags; updated.push({ id: u.characterId, tags: [...u.tags] }) }
      return { updated, failures: [] }
    },
  } as unknown as CharacterRepository

  const executor = new MutationExecutor(repo as unknown as CharacterMutationPort)
  const store = new TagManagerStore(repo, executor)
  await store.load()

  // warm
  store.actions.setSection('tags')
  store.actions.setSection('characters')
  store.actions.setSection('tags')

  // Time a batch of commits; each commit = one computeView.
  const ITER = 20
  const t0 = performance.now()
  for (let i = 0; i < ITER; i++) {
    store.actions.setSection(i % 2 === 0 ? 'tags' : 'characters')
  }
  const ms = (performance.now() - t0) / ITER
  return { stage: 'computeView()/commit', n, ms, count: ITER, extra: 'ms per commit' }
}

/** Full post-write flow: execute -> refresh -> the commits that follow. */
async function benchRunPlanAndCommit(n: number): Promise<StageRow> {
  const { characters } = makeFixture(n)
  const { primary, targets } = pickMergeTags(characters, 5)
  const repo = {
    async listAllCharacters() { return characters },
    async listPage() { return { data: characters, total: characters.length } },
    async getCharacter(id) { return characters.find((c) => c.id === id) ?? null },
    async updateTags(id, tags) { const c = characters.find((x) => x.id === id)!; c.tags = tags; return c },
    async getTagsBatch(ids) {
      const m = new Map<string, CharacterTags>()
      for (const id of ids) { const c = characters.find((x) => x.id === id); if (c) m.set(id, { id, tags: [...c.tags] }) }
      return m
    },
    async updateTagsBatch(updates) {
      const updated: CharacterTags[] = []
      for (const u of updates) { const c = characters.find((x) => x.id === u.characterId)!; c.tags = u.tags; updated.push({ id: u.characterId, tags: [...u.tags] }) }
      return { updated, failures: [] }
    },
  } as unknown as CharacterRepository

  const executor = new MutationExecutor(repo as unknown as CharacterMutationPort)
  const store = new TagManagerStore(repo, executor)
  await store.load()

  const t0 = performance.now()
  await store.actions.runMergeTags(primary, targets)
  const ms = performance.now() - t0
  const v = store.view
  return { stage: 'store.runMergeTags()', n, ms, count: v.reports[0]?.results.length ?? 0, extra: 'results in report' }
}

// ---------------------------------------------------------------------------
// Stage 2: DOM rebuild — the shell render
// ---------------------------------------------------------------------------

function mountShell(store: TagManagerStore, doc: StubDocument): () => void {
  const root = doc.createElement('div')
  doc.body.appendChild(root)
  const handle = renderShell({
    root: root as unknown as HTMLElement,
    store,
    renderTagsSection: (c) => { renderTagsSection({ container: c, store }) },
    renderCharactersSection: (c) => { renderCharactersSection({ container: c, store }) },
    renderFailurePanel: (c) => { renderFailurePanel({ container: c, store }) },
    openDialog: () => {},
    onShowSearchHelp: () => {},
  })
  return () => { handle.destroy(); root.removeChild }
}

// Async version so load() completes before rendering.
async function benchShellRender(
  n: number,
  section: 'tags' | 'characters',
  expandedCount: number,
): Promise<StageRow> {
  const { characters } = makeFixture(n)
  const { primary, targets } = pickMergeTags(characters, 5)
  const repo = {
    async listAllCharacters() { return characters },
    async listPage() { return { data: characters, total: characters.length } },
    async getCharacter(id) { return characters.find((c) => c.id === id) ?? null },
    async updateTags(id, tags) { const c = characters.find((x) => x.id === id)!; c.tags = tags; return c },
    async getTagsBatch(ids) {
      const m = new Map<string, CharacterTags>()
      for (const id of ids) { const c = characters.find((x) => x.id === id); if (c) m.set(id, { id, tags: [...c.tags] }) }
      return m
    },
    async updateTagsBatch(updates) {
      const updated: CharacterTags[] = []
      for (const u of updates) { const c = characters.find((x) => x.id === u.characterId)!; c.tags = u.tags; updated.push({ id: u.characterId, tags: [...u.tags] }) }
      return { updated, failures: [] }
    },
  } as unknown as CharacterRepository

  const executor = new MutationExecutor(repo as unknown as CharacterMutationPort)
  const store = new TagManagerStore(repo, executor)
  await store.load()
  if (section === 'characters') store.actions.setSection('characters')

  // Expand `expandedCount` tags (tags section only).
  if (expandedCount > 0 && section === 'tags') {
    const keys = store.view.tagRows.slice(0, expandedCount).map((r) => r.entry.key)
    for (const k of keys) store.actions.toggleTagExpanded(k)
  }

  const doc = installDom()
  const destroy = mountShell(store, doc)

  // The shell renders on EVERY commit. `setTagSort` is a harmless commit that
  // bumps `store.version` every time (no early-return on an unchanged value),
  // so alternating it forces exactly R full DOM rebuilds of the ACTIVE section.
  const RENDERS = 5
  for (let i = 0; i < 3; i++) store.actions.setTagSort(i % 2 ? 'name_zdesc' : 'name_asc') // warm

  counters.reset()
  const t0 = performance.now()
  for (let i = 0; i < RENDERS; i++) store.actions.setTagSort(i % 2 ? 'name_zdesc' : 'name_asc')
  const ms = performance.now() - t0
  const nodes = Math.round(counters.nodes / RENDERS)
  destroy()
  return {
    stage: `shell.render[${section}${expandedCount ? ` x${expandedCount}exp` : ''}]`,
    n, ms: ms / RENDERS, count: nodes, extra: 'DOM nodes per render',
  }
}

// ---------------------------------------------------------------------------
// Stage 3: failure panel render for a report with N results
// ---------------------------------------------------------------------------

async function benchFailurePanel(n: number, allFailed: boolean): Promise<StageRow> {
  const { characters } = makeFixture(n)
  const executor = new MutationExecutor({
    async getCharacter() { return null },
    async updateTags(id, tags) { return { ...(characters[0] as LumiTagCharacter), id, tags } },
    async getTagsBatch() { return new Map() },
    async updateTagsBatch(updates) {
      if (!allFailed) {
        return { updated: updates.map((u) => ({ id: u.characterId, tags: u.tags })), failures: [] }
      }
      return {
        updated: [],
        failures: updates.map((u) => ({ characterId: u.characterId, message: 'write failed', code: 'x', retryable: true })),
      }
    },
  } as unknown as CharacterMutationPort)

  const { primary, targets } = pickMergeTags(characters, 5)
  const preview = planOperation(characters, { op: 'merge', primary, targets })
  const report = await executor.execute(preview)

  const store = new TagManagerStore(
    { async listAllCharacters() { return characters } } as unknown as CharacterRepository,
    executor,
  )
  await store.load()
  // Inject the report via dismissReport-free path: push through a rejected run is
  // complex; instead reach the private state by triggering a real run.
  // Simpler: monkeypatch after a real merge by calling runMergeTags is heavy. We
  // instead craft the store's reports by executing a real merge then forcing
  // the failure report to remain. For measurement we just render the panel with
  // the report present. Use actions.dismissReport? No. Use showReport? Needs presence.
  // Direct approach: run the merge for real so a report lands in store.view.reports.
  // Re-run with a failing port:
  void report

  // Give the store a failing executor run so reports contain the failures.
  const failingExecutor = new MutationExecutor({
    async getCharacter() { return null },
    async updateTags(id, tags) { return { ...(characters[0] as LumiTagCharacter), id, tags } },
    async getTagsBatch() { return new Map() },
    async updateTagsBatch(updates) {
      return {
        updated: [],
        failures: updates.map((u) => ({ characterId: u.characterId, message: 'write failed', code: 'x', retryable: true })),
      }
    },
  } as unknown as CharacterMutationPort)
  const store2 = new TagManagerStore(
    {
      async listAllCharacters() { return characters },
      async getTagsBatch(ids) { const m = new Map<string, CharacterTags>(); for (const id of ids) { const c = characters.find((x) => x.id === id); if (c) m.set(id, { id, tags: [...c.tags] }) } return m },
      async getCharacter(id) { return characters.find((c) => c.id === id) ?? null },
    } as unknown as CharacterRepository,
    failingExecutor,
  )
  await store2.load()
  await store2.actions.runMergeTags(primary, targets)
  store2.actions.showReport(store2.view.reports[0]!.opId)

  const doc = installDom()
  const container = doc.createElement('div')
  doc.body.appendChild(container)
  renderFailurePanel({ container: container as unknown as HTMLElement, store: store2 })

  counters.reset()
  // Force one more render by toggling showReport off/on.
  const t0 = performance.now()
  store2.actions.showReport(null)
  store2.actions.showReport(store2.view.reports[0]!.opId)
  const ms = performance.now() - t0
  const nodes = counters.nodes
  const resultCount = store2.view.reports[0]?.results.length ?? 0
  return {
    stage: `failurePanel.render[${allFailed ? 'all-fail' : 'ok'}]`,
    n, ms: ms / 2, count: nodes, extra: `DOM nodes per render; report has ${resultCount} results`,
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

/**
 * Directly COUNT how many MutationResult objects executor.execute() allocates,
 * by wrapping the structuredClone-visible shape. There is no hook for cloneResult,
 * so instead we count via a Proxy-free approach: measure allocation by counting
 * array copies. We monkeypatch nothing in src (read-only), so we approximate with
 * batches^2 (progress() runs once per batch and snapshot() clones all results)
 * AND separately count `pendingResult` (one per mutation) + `cloneResult` in
 * onResult (one per mutation) + `snapshot` (2 at the end, each cloning all N).
 * The dominant term is batches * results from the per-batch progress() calls.
 */
async function benchExecuteAllocation(n: number): Promise<StageRow> {
  const { characters } = makeFixture(n)
  const { primary, targets } = pickMergeTags(characters, 5)
  const preview = planOperation(characters, { op: 'merge', primary, targets })
  const M = preview.mutations.length
  // Exact model of allocations inside execute() for M mutations / M batches:
  const pendingResult = M                       // results array built once
  const progressClones = M * M                  // progress() per batch x snapshot(clone all M)
  const onResultClones = M                      // cloneResult per mutation
  const finalSnapshots = 2 * M                  // report + this.store(snapshot(...))
  const total = pendingResult + progressClones + onResultClones + finalSnapshots
  return {
    stage: 'executor.execute() [ALLOC]',
    n, ms: 0, count: total,
    extra: `MutationResult allocs (M=${M}); progress term = ${progressClones} (M*M)`,
  }
}

async function main(): Promise<void> {
  installDom()
  const Ns = [100, 300, 600, 1000]
  const rows: StageRow[] = []

  for (const n of Ns) {
    rows.push(await benchPlan(n))
    rows.push(await benchExecute(n))
    rows.push(await benchExecuteProgressCost(n))
    rows.push(await benchExecuteAllocation(n))
    rows.push(await benchTagIndex(n))
    rows.push(await benchComputeView(n))
    rows.push(await benchRunPlanAndCommit(n))
    rows.push(await benchShellRender(n, 'tags', 0))
    rows.push(await benchShellRender(n, 'characters', 0))
    rows.push(await benchShellRender(n, 'tags', 10))
    rows.push(await benchShellRender(n, 'tags', 50))
    rows.push(await benchFailurePanel(n, true))
  }

  console.log('\n=== STAGE TIMINGS (ms, wall-clock; synthetic DOM, no GC) ===')
  console.log('stage'.padEnd(38), 'N'.padStart(6), 'ms'.padStart(11), 'count'.padStart(10), '  extra')
  for (const r of rows) {
    console.log(
      r.stage.padEnd(38),
      String(r.n).padStart(6),
      fmt(r.ms).padStart(11),
      String(r.count).padStart(10),
      '  ' + r.extra,
    )
  }

  console.log('\n=== SCALING EXPONENTS (log-log slope over N) ===')
  const byStage = new Map<string, StageRow[]>()
  for (const r of rows) {
    if (!byStage.has(r.stage)) byStage.set(r.stage, [])
    byStage.get(r.stage)!.push(r)
  }
  for (const [stage, list] of byStage) {
    if (list.length < 2) continue
    const xs = list.map((r) => Math.log(r.n))
    const ys = list.map((r) => Math.log(Math.max(r.ms, 1e-6)))
    // least squares slope
    const mx = xs.reduce((a, b) => a + b) / xs.length
    const my = ys.reduce((a, b) => a + b) / ys.length
    let num = 0, den = 0
    for (let i = 0; i < xs.length; i++) { num += (xs[i]! - mx) * (ys[i]! - my); den += (xs[i]! - mx) ** 2 }
    const slope = num / den
    console.log(stage.padEnd(38), 'exponent', slope.toFixed(2))
  }
}

void main()