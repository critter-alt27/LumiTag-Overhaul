/** THROWAWAY bench 5 — computeView / buildTagIndex / characters-section, fresh process per N. */
import { installDom, counters } from './domshim'
import type { LumiTagCharacter, CharacterTags } from '../src/shared/types'
import { buildTagIndex } from '../src/frontend/tag-index'
import { MutationExecutor } from '../src/frontend/mutations/executor'
import type { CharacterRepository, CharacterMutationPort } from '../src/frontend/repository'
import { TagManagerStore } from '../src/frontend/store'
import { renderShell } from '../src/frontend/ui/shell'
import { renderTagsSection } from '../src/frontend/ui/tags-section'
import { renderCharactersSection } from '../src/frontend/ui/characters-section'
import { renderFailurePanel } from '../src/frontend/ui/failure-panel'

function mulberry32(seed: number): () => number {
  return function () { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296 }
}
function mk(n: number) {
  const rnd = mulberry32(7)
  const filler: string[] = []
  for (let i = 0; i < 3000; i++) filler.push(`tag_${i}`)
  const characters: LumiTagCharacter[] = []
  for (let i = 0; i < n; i++) {
    const extra = 5 + Math.floor(rnd() * 26)
    const tags: string[] = []
    for (let t = 0; t < extra; t++) tags.push(filler[Math.floor(rnd() * 3000)]!)
    characters.push({ id: `char_${i}`, name: `Character ${i}`, description: 'desc '.repeat(20), personality: 'p'.repeat(120), scenario: 's'.repeat(120), creator: 'c', creator_notes: 'n'.repeat(120), system_prompt: 'y'.repeat(120), tags, image_id: null, created_at: 0, updated_at: 0 })
  }
  return characters
}
function port(c: LumiTagCharacter[]): CharacterMutationPort {
  return {
    async getCharacter(id) { return c.find((x) => x.id === id) ?? null },
    async updateTags(id, tags) { const x = c.find((y) => y.id === id)!; x.tags = tags; return x },
    async getTagsBatch(ids) { const m = new Map<string, CharacterTags>(); for (const id of ids) { const x = c.find((y) => y.id === id); if (x) m.set(id, { id, tags: [...x.tags] }) } return m },
    async updateTagsBatch(u) { const upd: CharacterTags[] = []; for (const b of u) { const x = c.find((y) => y.id === b.characterId)!; x.tags = [...b.tags]; upd.push({ id: b.characterId, tags: [...b.tags] }) } return { updated: upd, failures: [] } },
  }
}

const mode = process.argv[2] ?? 'cv'
const n = Number(process.argv[3])
installDom()
const characters = mk(n)
const p = port(characters)
const executor = new MutationExecutor(p)
const repo = { async listAllCharacters() { return characters }, ...p } as unknown as CharacterRepository
const store = new TagManagerStore(repo, executor)
await store.load()

if (mode === 'ti') {
  for (let i = 0; i < 3; i++) buildTagIndex(characters)
  const R = 20
  const t0 = performance.now()
  for (let i = 0; i < R; i++) buildTagIndex(characters)
  console.log(JSON.stringify({ n, buildTagIndexMs: (performance.now() - t0) / R, tags: buildTagIndex(characters).tags.length }))
} else if (mode === 'cv') {
  const R = 40
  for (let i = 0; i < 5; i++) store.actions.setTagSort(i % 2 ? 'name_zdesc' : 'name_asc')
  const t0 = performance.now()
  for (let i = 0; i < R; i++) store.actions.setTagSort(i % 2 ? 'name_zdesc' : 'name_asc')
  console.log(JSON.stringify({ n, computeViewMs: (performance.now() - t0) / R, tagRows: store.view.tagRows.length, charRows: store.view.characterRows.length }))
} else if (mode === 'chars') {
  store.actions.setSection('characters')
  const doc = installDom()
  const root = doc.createElement('div')
  doc.body.appendChild(root)
  const handle = renderShell({ root: root as unknown as HTMLElement, store, renderTagsSection: (c) => { renderTagsSection({ container: c, store }) }, renderCharactersSection: (c) => { renderCharactersSection({ container: c, store }) }, renderFailurePanel: (c) => { renderFailurePanel({ container: c, store }) }, openDialog: () => {}, onShowSearchHelp: () => {} })
  const R = 5
  for (let i = 0; i < 3; i++) store.actions.setTagSort(i % 2 ? 'name_zdesc' : 'name_asc')
  counters.reset()
  const t0 = performance.now()
  for (let i = 0; i < R; i++) store.actions.setTagSort(i % 2 ? 'name_zdesc' : 'name_asc')
  console.log(JSON.stringify({ n, charsRenderMs: (performance.now() - t0) / R, nodes: Math.round(counters.nodes / R), rowsShown: Math.min(store.view.characterRows.length, 300) }))
  handle.destroy()
}