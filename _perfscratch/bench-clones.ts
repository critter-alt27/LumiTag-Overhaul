/**
 * THROWAORY bench — cost of `MutationExecutor.execute()` on a bulk merge.
 *
 * Counts the `cloneResults` calls an execute() performs WITHOUT editing the
 * executor: `snapshot()` clones via `results.map(cloneResult)`, and nothing else
 * in the module maps over a result list, so an `Array.prototype.map` spy that
 * recognises the produced records counts clone passes exactly.
 */

import type { CharacterMutationPort } from '../src/frontend/repository'
import type { CharacterTags, LumiTagCharacter } from '../src/shared/types'
import type { OperationPreview, PlannedMutation } from '../src/frontend/mutations/planner'
import { MutationExecutor } from '../src/frontend/mutations/executor'
import { type MutationResult, type OperationReport } from '../src/frontend/mutations/report'

const nativeMap = Array.prototype.map
let clonePasses = 0

Array.prototype.map = function patched<T, U>(
  this: T[],
  cb: (v: T, i: number, a: T[]) => U,
  thisArg?: unknown,
): U[] {
  const out = nativeMap.call(this, cb, thisArg)
  if (out.length > 0) {
    const head = out[0] as unknown
    if (typeof head === 'object' && head !== null && 'mutationId' in head) clonePasses++
  }
  return out
}

function character(id: string, tags: string[]): LumiTagCharacter {
  return {
    id,
    name: id,
    description: '',
    personality: '',
    scenario: '',
    creator: '',
    creator_notes: '',
    system_prompt: '',
    tags: [...tags],
    image_id: null,
    created_at: 0,
    updated_at: 0,
  }
}

/** 5 source tags merged into one primary, across every character. */
const SOURCES = ['Dragon', 'Wyrm', 'Serpent', 'Drake', 'Hydra']

class MergePort implements CharacterMutationPort {
  private readonly server = new Map<string, LumiTagCharacter>()
  seed(count: number): void {
    for (let i = 0; i < count; i++) this.server.set(`c${i}`, character(`c${i}`, [...SOURCES]))
  }
  async getCharacter(id: string): Promise<LumiTagCharacter | null> {
    return this.server.get(id) ?? null
  }
  async listCharacters(): Promise<LumiTagCharacter[]> {
    return [...this.server.values()]
  }
  async updateTags(characterId: string, tags: string[]): Promise<LumiTagCharacter> {
    const c = this.server.get(characterId)!
    c.tags = [...tags]
    return c
  }
  async updateTagsBatch(updates: { characterId: string; tags: string[] }[]): Promise<{
    updated: CharacterTags[]
    failures: []
  }> {
    const updated: CharacterTags[] = []
    for (const u of updates) {
      this.server.get(u.characterId)!.tags = [...u.tags]
      updated.push({ id: u.characterId, tags: [...u.tags] })
    }
    return { updated, failures: [] }
  }
}

function mergePreview(count: number): OperationPreview {
  const mutations: PlannedMutation[] = []
  for (let i = 0; i < count; i++) {
    mutations.push({
      mutationId: `m${i}`,
      characterId: `c${i}`,
      characterName: `c${i}`,
      op: 'merge',
      tag: 'Dragon',
      destTag: 'Dragon',
      sourceTags: [...SOURCES],
      addedTags: [],
      removedTags: [...SOURCES.slice(1)],
      targetTags: ['Dragon'],
      beforeTags: [...SOURCES],
      intendedChange: 'merge Dragon, Hydra, Serpent, Wyrm → Dragon',
    })
  }
  return {
    opId: `op-${count}`,
    op: 'merge',
    label: 'merge operation',
    tags: [...SOURCES],
    mutations,
    skipped: [],
    affectedCharacterIds: mutations.map((m) => m.characterId),
    affectedCharacterCount: count,
    changeCount: count,
  }
}

/** Count the MutationResult objects a run causes to be allocated. */
async function measure(count: number, hooks: boolean): Promise<{ clones: number; ms: number }> {
  const port = new MergePort()
  port.seed(count)
  const executor = new MutationExecutor(port)

  let emissions = 0
  const handed = new Set<MutationResult>()
  const listeners = hooks
    ? {
        onProgress: (r: OperationReport) => {
          emissions++
          for (const res of r.results) handed.add(res)
        },
        onResult: (r: MutationResult) => handed.add(r),
      }
    : undefined

  const before = clonePasses
  const t0 = performance.now()
  const report = await executor.execute(mergePreview(count), listeners)
  const ms = performance.now() - t0
  const passes = clonePasses - before
  if (report.results.length !== count) throw new Error('bad report')
  void handed
  return { clones: passes, ms }
}

console.log(`\nexecute() on a ${SOURCES.length}-source merge, all characters affected\n`)
console.log(
  `${String(process.env.MODE === 'hooks' ? 'WITH' : 'NO').padEnd(5)} M     clonePasses  MutationResults  ratio   ms`,
)
let prev = 0
for (const m of [100, 200, 400, 800]) {
  const { clones, ms } = await measure(m, process.env.MODE === 'hooks')
  const objs = clones * m
  const ratio = prev === 0 ? 1 : objs / prev
  console.log(
    `${(process.env.MODE === 'hooks' ? 'hooks' : 'none').padEnd(5)} ${String(m).padStart(4)}  ${String(clones).padStart(11)}  ${String(objs).padStart(14)}  ${ratio.toFixed(2).padStart(5)}  ${ms.toFixed(1).padStart(7)}`,
  )
  prev = objs
}
Array.prototype.map = nativeMap
console.log()