/**
 * THROWAWAY bench 4 — ONE N per process invocation, so JIT state and GC history
 * from a previous N cannot contaminate the next. Invoked as:
 *   bun run bench4.ts <mode> <N>
 */

import { installDom, counters } from './domshim'
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

function makeFullCoverage(n: number, mergeTagCount: number) {
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

/** Byte-for-byte replica of executor's cloneResult, for attribution only. */
function cloneResult(r: MutationResult): MutationResult {
  return { ...r, sourceTags: [...r.sourceTags], addedTags: [...r.addedTags], removedTags: [...r.removedTags], ...(r.error === undefined ? {} : { error: { ...r.error } }) }
}

async function modeExec(n: number): Promise<void> {
  const { characters, mergeTagNames } = makeFullCoverage(n, 5)
  const preview = planOperation(characters, { op: 'merge', primary: mergeTagNames[0]!, targets: mergeTagNames.slice(1) })
  const M = preview.mutations.length
  const executor = new MutationExecutor(mkPort(characters))
  await executor.execute(preview)
  const R = 7
  const times: number[] = []
  let last!: OperationReport
  for (let r = 0; r < R; r++) {
    const t0 = performance.now()
    last = await executor.execute(preview)
    times.push(performance.now() - t0)
  }
  times.sort((a, b) => a - b)
  const median = times[Math.floor(R / 2)]!
  const min = times[0]!

  // Attribution, measured on the exact array execute produced.
  const results = last.results
  const R2 = 3
  const cl: number[] = []
  for (let r = 0; r < R2; r++) {
    const t0 = performance.now()
    for (let i = 0; i < M; i++) { void results.map(cloneResult) }
    cl.push(performance.now() - t0)
  }
  cl.sort((a, b) => a - b)
  const cloneLoop = cl[Math.floor(R2 / 2)]!

  console.log(JSON.stringify({ n, M, median, min, cloneLoop, sharePct: (cloneLoop / median) * 100 }))
}

async function modeFull(n: number): Promise<void> {
  const { characters, mergeTagNames } = makeFullCoverage(n, 5)
  const port = mkPort(characters)
  const executor = new MutationExecutor(port)
  const repo = { async listAllCharacters() { return characters }, ...port } as unknown as CharacterRepository
  const store = new TagManagerStore(repo, executor)
  await store.load()
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
  let commits = 0
  store.subscribe(() => { commits++ })

  const R = 5
  counters.reset()
  const t0 = performance.now()
  for (let i = 0; i < R; i++) {
    store.actions.setTagSort(i % 2 ? 'name_zdesc' : 'name_asc')
  }
  const renderMs = (performance.now() - t0) / R
  const nodes = counters.nodes / R

  commits = 0
  const t1 = performance.now()
  await store.actions.runMergeTags(mergeTagNames[0]!, mergeTagNames.slice(1))
  const mergeMs = performance.now() - t1
  const res = store.view.reports[store.view.reports.length - 1]?.results.length ?? 0
  handle.destroy()
  console.log(JSON.stringify({ n, commits, renderMs, nodes, res, mergeMs }))
}

async function modeRetain(n: number, K: number): Promise<void> {
  const { characters, mergeTagNames } = makeFullCoverage(n, 5 * K)
  const port = mkPort(characters)
  const executor = new MutationExecutor(port)
  const repo = { async listAllCharacters() { return characters }, ...port } as unknown as CharacterRepository
  const store = new TagManagerStore(repo, executor)
  await store.load()

  for (let i = 0; i < 4; i++) { Bun.gc(true) }
  const base = process.memoryUsage().heapUsed

  for (let k = 0; k < K; k++) {
    const slice = mergeTagNames.slice(k * 5, k * 5 + 5)
    await store.actions.runMergeTags(slice[0]!, slice.slice(1))
  }
  for (let i = 0; i < 6; i++) { Bun.gc(true) }
  const after = process.memoryUsage().heapUsed

  const reports = store.view.reports
  const retained = reports.reduce((s, r) => s + r.results.length, 0)
  console.log(JSON.stringify({ n, K, reports: reports.length, retained, deltaMB: (after - base) / 1048576, bytesPerResult: retained ? (after - base) / retained : 0 }))
}

/** Total DOM nodes created across the whole post-write render burst. */
async function modeDom(n: number, expanded: number, section: 'tags' | 'characters'): Promise<void> {
  const { characters, mergeTagNames } = makeFullCoverage(n, 5)
  const port = mkPort(characters)
  const executor = new MutationExecutor(port)
  const repo = { async listAllCharacters() { return characters }, ...port } as unknown as CharacterRepository
  const store = new TagManagerStore(repo, executor)
  await store.load()
  if (section === 'characters') store.actions.setSection('characters')
  if (expanded > 0) {
    for (const k of store.view.tagRows.slice(0, expanded).map((r) => r.entry.key)) store.actions.toggleTagExpanded(k)
  }
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
  const R = 5
  counters.reset()
  const t0 = performance.now()
  for (let i = 0; i < R; i++) store.actions.setTagSort(i % 2 ? 'name_zdesc' : 'name_asc')
  const ms = (performance.now() - t0) / R
  const nodes = Math.round(counters.nodes / R)
  handle.destroy()
  console.log(JSON.stringify({ n, expanded, section, ms, nodes }))
}

const [mode, nStr, extra] = process.argv.slice(2)
void (async () => {
  installDom()
  const n = Number(nStr)
  if (mode === 'exec') await modeExec(n)
  else if (mode === 'full') await modeFull(n)
  else if (mode === 'retain') await modeRetain(n, Number(extra ?? 5))
  else if (mode === 'dom') await modeDom(n, Number(extra ?? 0), 'tags')
})()