/**
 * Tests for the executor's result index and its per-character progress path.
 *
 * Two properties are load-bearing and neither is visible in the shape of a
 * report, so they are asserted directly:
 *
 *  1. `indexResults` resolves a `mutationId` to exactly the record an
 *     `Array.prototype.find` scan would have — including when an id is
 *     duplicated, where the first occurrence must win. A lookup that resolved
 *     to a different record would retarget a write, not just speed one up.
 *  2. `totals`/`status` stay DERIVED, never accumulated. Every snapshot the
 *     executor emits — and the final report — must agree with a fresh
 *     `computeTotals`/`deriveStatus` over that same snapshot's own results.
 *     Deriving them once per emission instead of three times is an optimisation
 *     only if it does not change a single value.
 */

import { describe, expect, test } from 'bun:test'

import type { CharacterMutationPort } from '../src/frontend/repository'
import type { BatchFailure } from '../src/shared/protocol'
import type { CharacterTags, LumiTagCharacter } from '../src/shared/types'
import type { MutationOp, OperationPreview, PlannedMutation } from '../src/frontend/mutations/planner'
import { indexResults, MutationExecutor } from '../src/frontend/mutations/executor'
import {
  computeTotals,
  deriveStatus,
  type MutationResult,
  type MutationState,
} from '../src/frontend/mutations/report'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

let uidCounter = 0
function uid(prefix: string): string {
  uidCounter += 1
  return `${prefix}${uidCounter}`
}

function result(
  mutationId: string,
  state: MutationState,
  characterId = `c-${mutationId}`,
): MutationResult {
  return {
    mutationId,
    characterId,
    characterName: characterId,
    op: 'assign',
    tag: 'Elf',
    sourceTags: [],
    addedTags: ['Elf'],
    removedTags: [],
    intendedChange: 'assign Elf',
    state,
    attempts: 1,
    retryable: state === 'failed' || state === 'conflict',
    uncertain: false,
  }
}

/** The scan `indexResults` replaces, kept verbatim as the oracle. */
function linearScan(results: readonly MutationResult[], mutationId: string): MutationResult | undefined {
  return results.find((r) => r.mutationId === mutationId)
}

/** Every state a result can hold, so the index is proved over all of them. */
const ALL_STATES: readonly MutationState[] = [
  'pending',
  'succeeded',
  'failed',
  'retrying',
  'resolved_on_retry',
  'conflict',
]

function character(id: string, name: string, tags: string[]): LumiTagCharacter {
  return {
    id,
    name,
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

/**
 * A port whose batched write fails every character named in `failIds` and
 * succeeds for the rest, so one operation can be a real mix of outcomes.
 */
class MixPort implements CharacterMutationPort {
  readonly writes: string[] = []
  constructor(
    private readonly server: Map<string, LumiTagCharacter>,
    private readonly failIds: ReadonlySet<string>,
  ) {}

  async getCharacter(id: string): Promise<LumiTagCharacter | null> {
    return this.server.get(id) ?? null
  }

  async updateTags(id: string, tags: string[]): Promise<LumiTagCharacter> {
    const existing = this.server.get(id) ?? character(id, id, [])
    const next = character(id, existing.name, tags)
    this.server.set(id, next)
    return next
  }

  async getTagsBatch(ids: readonly string[]): Promise<Map<string, CharacterTags>> {
    return new Map(ids.map((id) => [id, { id, tags: [...(this.server.get(id)?.tags ?? [])] }]))
  }

  async updateTagsBatch(
    updates: { characterId: string; tags: string[] }[],
  ): Promise<{ updated: CharacterTags[]; failures: BatchFailure[] }> {
    const updated: CharacterTags[] = []
    const failures: BatchFailure[] = []
    for (const update of updates) {
      this.writes.push(update.characterId)
      if (this.failIds.has(update.characterId)) {
        failures.push({
          characterId: update.characterId,
          code: 'forbidden',
          message: 'The host refused the write.',
          retryable: false,
        })
        continue
      }
      const existing = this.server.get(update.characterId) ?? character(update.characterId, update.characterId, [])
      this.server.set(update.characterId, character(update.characterId, existing.name, update.tags))
      updated.push({ id: update.characterId, tags: [...update.tags] })
    }
    return { updated, failures }
  }
}

interface Spec {
  characterId: string
  tag?: string
  addedTags?: string[]
  removedTags?: string[]
  current?: string[]
  targetTags?: string[]
  op?: MutationOp
}

function planMutation(spec: Spec): PlannedMutation {
  const addedTags = spec.addedTags ?? []
  const removedTags = spec.removedTags ?? []
  const current = spec.current ?? []
  const tag = spec.tag ?? 'Elf'
  return {
    mutationId: uid('m'),
    characterId: spec.characterId,
    characterName: spec.characterId,
    op: spec.op ?? 'assign',
    tag,
    sourceTags: removedTags,
    addedTags,
    removedTags,
    targetTags: spec.targetTags ?? [...current, ...addedTags],
    beforeTags: [...current],
    intendedChange: `${spec.op ?? 'assign'} ${tag}`,
  }
}

function previewOf(mutations: PlannedMutation[], op: MutationOp = 'assign'): OperationPreview {
  const ids = [...new Set(mutations.map((m) => m.characterId))]
  return {
    opId: uid('op'),
    op,
    label: `${op} operation`,
    tags: [...new Set(mutations.map((m) => m.tag))],
    mutations,
    skipped: [],
    affectedCharacterIds: ids,
    affectedCharacterCount: ids.length,
    changeCount: mutations.length,
  }
}

/** A 300-character delete, which is the size the index exists for. */
function bulkPreview(size: number): OperationPreview {
  return previewOf(
    Array.from({ length: size }, (_, i) =>
      planMutation({
        characterId: `c${i}`,
        tag: 'Dragon',
        removedTags: ['Dragon'],
        current: ['Dragon'],
        // The whole intended final array: a delete writes the empty list, so a
        // succeeded write is distinguishable from a silently-dropped one.
        targetTags: [],
      }),
    ),
    'remove',
  )
}

// ---------------------------------------------------------------------------
// The index
// ---------------------------------------------------------------------------

describe('indexResults', () => {
  test('resolves every id to the record the linear scan resolved', () => {
    const results = ALL_STATES.map((state, i) => result(`m${i}`, state))
    const index = indexResults(results)
    for (const r of results) {
      expect(index.get(r.mutationId)).toBe(linearScan(results, r.mutationId))
    }
  })

  test('a duplicated id resolves to the FIRST occurrence, as find() did', () => {
    const first = result('dup', 'succeeded')
    const second = result('dup', 'failed')
    const results = [first, second]
    const index = indexResults(results)
    expect(index.get('dup')).toBe(first)
    expect(index.get('dup')).toBe(linearScan(results, 'dup'))
  })

  test('an id that is not in the results resolves to undefined', () => {
    const index = indexResults([result('m1', 'succeeded')])
    expect(index.get('nope')).toBeUndefined()
    expect(linearScan([result('m1', 'succeeded')], 'nope')).toBeUndefined()
  })

  test('an empty result list indexes to an empty lookup', () => {
    expect(indexResults([]).size).toBe(0)
  })

  test('a result mutated after indexing is seen through the index', () => {
    // The index holds references, which is what lets `execute()` build it once
    // and keep it for the whole operation: state changes land on the very
    // record the next lookup will return.
    const r = result('m1', 'pending')
    const index = indexResults([r])
    r.state = 'succeeded'
    expect(index.get('m1')?.state).toBe('succeeded')
  })

  test('a 300-result operation indexes in one pass and stays exact', () => {
    const results = Array.from({ length: 300 }, (_, i) => result(`m${i}`, 'pending'))
    const index = indexResults(results)
    expect(index.size).toBe(300)
    for (const r of results) expect(index.get(r.mutationId)).toBe(r)
  })
})

// ---------------------------------------------------------------------------
// Totals and status are still derived, once per emission
// ---------------------------------------------------------------------------

describe('derived totals and status survive the single-pass progress path', () => {
  test('every progress snapshot agrees with a fresh recount of its own results', async () => {
    const server = new Map<string, LumiTagCharacter>()
    for (let i = 0; i < 12; i++) server.set(`c${i}`, character(`c${i}`, `C${i}`, ['Dragon']))
    const failing = new Set(['c1', 'c4', 'c9'])
    const executor = new MutationExecutor(new MixPort(server, failing))

    const emitted: {
      totals: unknown
      status: string
      results: MutationResult[]
      running: boolean
    }[] = []
    const report = await executor.execute(bulkPreview(12), {
      onProgress: (r) =>
        emitted.push({
          totals: r.totals,
          status: r.status,
          results: r.results,
          running: r.finishedAt === undefined,
        }),
    })

    expect(emitted.length).toBeGreaterThan(0)
    for (const snapshot of emitted) {
      expect(snapshot.totals).toEqual(computeTotals(snapshot.results))
      expect(snapshot.status).toBe(deriveStatus(snapshot.results, snapshot.running))
    }

    expect(report.totals).toEqual(computeTotals(report.results))
    expect(report.status).toBe(deriveStatus(report.results, false))
    expect(report.totals).toEqual({ total: 12, succeeded: 9, failed: 3, remaining: 3 })
    expect(report.status).toBe('partially_completed')
  })

  test('the executor keeps no record that disagrees with its own final report', async () => {
    const server = new Map<string, LumiTagCharacter>([['c1', character('c1', 'C1', ['Dragon'])]])
    const executor = new MutationExecutor(new MixPort(server, new Set(['c1'])))
    const report = await executor.execute(bulkPreview(1))

    const stored = executor.getReport(report.opId)!
    expect(stored.totals).toEqual(report.totals)
    expect(stored.status).toBe(report.status)
    expect(stored.results).toEqual(report.results)
  })

  test('a 300-character all-failing operation still reports every failure', async () => {
    const server = new Map<string, LumiTagCharacter>()
    for (let i = 0; i < 300; i++) server.set(`c${i}`, character(`c${i}`, `C${i}`, ['Dragon']))
    const failing = new Set([...server.keys()])
    const port = new MixPort(server, failing)
    const executor = new MutationExecutor(port)

    const report = await executor.execute(bulkPreview(300))
    // One record per character, one write per character: the index resolves
    // every one of them without a single merge or drop.
    expect(port.writes).toHaveLength(300)
    expect(report.totals).toEqual({ total: 300, succeeded: 0, failed: 300, remaining: 300 })
    expect(report.status).toBe('failed')
    // The index must not merge or drop records on a bulk-sized operation.
    expect(new Set(report.results.map((r) => r.mutationId)).size).toBe(300)
    expect(report.results.every((r) => r.state === 'failed')).toBe(true)
  })

  test('a retry re-derives its report from the results it was given', async () => {
    const server = new Map<string, LumiTagCharacter>()
    for (let i = 0; i < 6; i++) server.set(`c${i}`, character(`c${i}`, `C${i}`, ['Dragon']))
    const executor = new MutationExecutor(new MixPort(server, new Set(['c0', 'c2', 'c3'])))
    const report = await executor.execute(bulkPreview(6))

    // Clear the failures server-side, so the retries genuinely resolve.
    for (const id of ['c0', 'c2', 'c3']) server.set(id, character(id, id, []))

    const retried = await executor.retryAll(report)
    expect(retried.totals).toEqual(computeTotals(retried.results))
    expect(retried.status).toBe(deriveStatus(retried.results, false))
    expect(retried.totals).toEqual({ total: 6, succeeded: 6, failed: 0, remaining: 0 })
    expect(retried.status).toBe('succeeded')
  })
})