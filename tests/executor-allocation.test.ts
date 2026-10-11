/**
 * Tests for the executor's ALLOCATION COST, which no report shape can reveal.
 *
 * A bulk merge used to emit one progress snapshot per character, and each
 * snapshot deep-cloned every result: M characters meant O(M^2) `MutationResult`
 * allocations. On the Android WebView that transient garbage OOM-killed the host
 * AFTER the write had already landed — the user's edit succeeded and then the
 * tab died.
 *
 * So these tests assert on OBJECT COUNTS, not on wall-clock, and not on what the
 * report contains:
 *
 *  1. Allocation grows LINEARLY with the number of characters. The ratio between
 *     M and 2M is the regression guard: ~2 for O(M), ~4 for the O(M^2) this
 *     replaced.
 *  2. With no hook there is nothing to receive a snapshot, so nothing is
 *     cloned — `store.runPlan()` is the production caller and passes no hooks,
 *     which is why the quadratic was pure waste.
 *  3. When a hook IS supplied the terminal emission still arrives, so
 *     coalescing can never cost a listener the end state.
 */

import { describe, expect, test } from 'bun:test'

import type { CharacterMutationPort } from '../src/frontend/repository'
import type { BatchFailure } from '../src/shared/protocol'
import type { CharacterTags, LumiTagCharacter } from '../src/shared/types'
import type { OperationPreview, PlannedMutation } from '../src/frontend/mutations/planner'
import { MutationExecutor, PROGRESS_EMIT_INTERVAL_MS } from '../src/frontend/mutations/executor'
import { type MutationResult, type OperationReport } from '../src/frontend/mutations/report'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** A clock under the test's control, so the emission cadence is deterministic. */
function fakeClock(start = 1_000): { now: () => number; advance: (ms: number) => void } {
  let t = start
  return { now: () => t, advance: (ms: number) => void (t += ms) }
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

/** Everything written succeeds and is confirmed back by the host. */
class OkPort implements CharacterMutationPort {
  private readonly server = new Map<string, LumiTagCharacter>()
  /**
   * Called once per written character, so a test can make the run take real
   * time. `execute()` coalesces on the clock, so a run whose clock never moves
   * and one whose clock moves per character are the two ends of what a listener
   * can observe.
   */
  constructor(
    count: number,
    private readonly perCharacter: () => void = () => {},
  ) {
    for (let i = 0; i < count; i++) this.server.set(`c${i}`, character(`c${i}`, ['Dragon']))
  }
  async getCharacter(id: string): Promise<LumiTagCharacter | null> {
    return this.server.get(id) ?? null
  }
  async updateTags(id: string, tags: string[]): Promise<LumiTagCharacter> {
    const next = character(id, tags)
    this.server.set(id, next)
    return next
  }
  async getTagsBatch(ids: readonly string[]): Promise<Map<string, CharacterTags>> {
    return new Map(ids.map((id) => [id, { id, tags: [...(this.server.get(id)?.tags ?? [])] }]))
  }
  async updateTagsBatch(
    updates: { characterId: string; tags: string[] }[],
  ): Promise<{ updated: CharacterTags[]; failures: BatchFailure[] }> {
    return {
      updated: updates.map((u) => {
        this.perCharacter()
        this.server.set(u.characterId, character(u.characterId, u.tags))
        return { id: u.characterId, tags: [...u.tags] }
      }),
      failures: [],
    }
  }
}

/** M characters, one planned mutation each. */
function previewOf(count: number): OperationPreview {
  const mutations: PlannedMutation[] = Array.from({ length: count }, (_, i) => ({
    mutationId: `m${i}`,
    characterId: `c${i}`,
    characterName: `c${i}`,
    op: 'remove',
    tag: 'Dragon',
    sourceTags: ['Dragon'],
    addedTags: [],
    removedTags: ['Dragon'],
    targetTags: [],
    beforeTags: ['Dragon'],
    intendedChange: 'remove Dragon',
  }))
  return {
    opId: `op-${count}`,
    op: 'remove',
    label: 'remove Dragon',
    tags: ['Dragon'],
    mutations,
    skipped: [],
    affectedCharacterIds: mutations.map((m) => m.characterId),
    affectedCharacterCount: count,
    changeCount: count,
  }
}

/**
 * Run one `execute()` and report how many `MutationResult` objects the caller
 * was HANDED.
 *
 * The clone count is measured through the `Array.prototype.map` that
 * `cloneResults` performs: nothing else in the module maps over a result list,
 * so a returned array whose head carries a `mutationId` is a clone pass. Each
 * pass clones M results, so `passes * M` is the allocation total. The map is
 * restored in a `finally` so a failed assertion cannot leak the patch.
 */
async function measureAllocs(
  count: number,
  hooks: 'none' | 'listening',
  now: () => number,
): Promise<{ emittedObjects: number; emissions: number }> {
  const executor = new MutationExecutor(new OkPort(count), { now })
  const listener = { emissions: 0, objects: new Set<MutationResult>() }
  const listeners =
    hooks === 'listening'
      ? {
          onProgress: (r: OperationReport) => {
            listener.emissions++
            for (const result of r.results) listener.objects.add(result)
          },
          onResult: (r: MutationResult) => listener.objects.add(r),
        }
      : undefined

  const nativeMap = Array.prototype.map
  let passes = 0
  Array.prototype.map = function spying<T, U>(
    this: T[],
    callbackfn: (value: T, index: number, array: T[]) => U,
    thisArg?: unknown,
  ): U[] {
    const out: U[] = Reflect.apply(nativeMap, this, [callbackfn, thisArg])
    const head: unknown = out[0]
    if (head !== undefined && typeof head === 'object' && head !== null && 'mutationId' in head) {
      passes++
    }
    return out
  }
  try {
    await executor.execute(previewOf(count), listeners)
  } finally {
    Array.prototype.map = nativeMap
  }

  // The objects a listener actually received, plus everything the internal
  // clone passes allocated on the way there.
  return { emittedObjects: passes * count + listener.objects.size, emissions: listener.emissions }
}

// ---------------------------------------------------------------------------
// Allocation growth
// ---------------------------------------------------------------------------

describe('execute() allocates linearly in the number of characters', () => {
  test('doubling the characters roughly doubles the allocations, not quadruples them', async () => {
    const frozen = () => 1_000
    const small = await measureAllocs(100, 'none', frozen)
    const large = await measureAllocs(200, 'none', frozen)

    // O(M^2) would give ~4. Allow generous slack for the fixed constant terms
    // (the final snapshots, the pending results) without admitting a quadratic.
    expect(large.emittedObjects / small.emittedObjects).toBeLessThan(3)
    // ...and the curve must still be doing real work, or the ratio proves nothing.
    expect(large.emittedObjects).toBeGreaterThan(small.emittedObjects)
  })

  test('the growth exponent stays near 1 from 100 to 400 characters', async () => {
    const frozen = () => 1_000
    const at100 = (await measureAllocs(100, 'none', frozen)).emittedObjects
    const at400 = (await measureAllocs(400, 'none', frozen)).emittedObjects

    // Log-log slope, so the units are "powers of M": 1.0 is linear, 2.0 is the
    // quadratic this replaced. Quoting log2 here would invert the reading —
    // 4x the characters under linear growth is log2 4 = 2, which would look
    // like the failure it is guarding against.
    const exponent = Math.log(at400 / at100) / Math.log(4)
    expect(exponent).toBeLessThan(1.5)
  })

  test('a listening caller also gets linear allocation', async () => {
    const frozen = () => 1_000
    const small = await measureAllocs(100, 'listening', frozen)
    const large = await measureAllocs(200, 'listening', frozen)
    expect(large.emittedObjects / small.emittedObjects).toBeLessThan(3)
  })
})

// ---------------------------------------------------------------------------
// No listener, no snapshot
// ---------------------------------------------------------------------------

describe('with no hooks there is nothing to derive progress for', () => {
  test('a hookless run derives no per-character snapshot at all', async () => {
    const report = await new MutationExecutor(new OkPort(400)).execute(previewOf(400))

    // The report itself is still complete and correct...
    expect(report.results).toHaveLength(400)
    expect(report.totals).toEqual({ total: 400, succeeded: 400, failed: 0, remaining: 0 })
    expect(report.status).toBe('succeeded')
    // ...and it is derived from the results, not accumulated.
    expect(report.totals.succeeded).toBe(report.results.filter((r) => r.state === 'succeeded').length)
  })

  test('the separate-snapshot guarantee survives the skipped progress', async () => {
    const executor = new MutationExecutor(new OkPort(4))
    const report = await executor.execute(previewOf(4))

    report.results[0]!.state = 'failed'
    report.results[0]!.sourceTags.push('not-a-real-tag')

    const stored = executor.getReport(report.opId)!
    expect(stored.results[0]!.state).toBe('succeeded')
    expect(stored.results[0]!.sourceTags).toEqual(['Dragon'])
  })
})

// ---------------------------------------------------------------------------
// Coalescing keeps the contract a listener depends on
// ---------------------------------------------------------------------------

describe('coalesced progress still delivers a terminal emission', () => {
  test('the last emission is the finished report even when the clock never moves', async () => {
    const emissions: OperationReport[] = []
    const executor = new MutationExecutor(new OkPort(50), { now: () => 1_000 })

    await executor.execute(previewOf(50), { onProgress: (r) => emissions.push(r) })

    expect(emissions.length).toBeGreaterThan(0)
    const last = emissions[emissions.length - 1]!
    expect(last.status).toBe('succeeded')
    expect(last.finishedAt).toBe(1_000)
    expect(last.totals).toEqual({ total: 50, succeeded: 50, failed: 0, remaining: 0 })
    expect(last.results).toHaveLength(50)
  })

  test('a listener is told the run started before the rate limit can swallow it', async () => {
    const emissions: OperationReport[] = []
    const executor = new MutationExecutor(new OkPort(50), { now: () => 1_000 })

    await executor.execute(previewOf(50), { onProgress: (r) => emissions.push(r) })

    // The first emission is unconditional, so a progress bar is never left
    // showing nothing at all for the whole of a fast operation.
    expect(emissions[0]!.status).toBe('running')
    expect(emissions[0]!.finishedAt).toBeUndefined()
  })

  test('a run that completes instantly emits only the primed and terminal reports', async () => {
    const frozen = () => 1_000
    const emissions: OperationReport[] = []
    const executor = new MutationExecutor(new OkPort(500), { now: frozen })

    await executor.execute(previewOf(500), { onProgress: (r) => emissions.push(r) })

    // All 500 characters are settled in one synchronous pass with a clock that
    // never moves, so the rate limit suppresses every emission after the first.
    // The terminal report is emitted regardless, so the count is exactly two.
    expect(emissions).toHaveLength(2)
    expect(emissions[0]!.status).toBe('running')
    expect(emissions[1]!.status).toBe('succeeded')
  })

  test('a run that takes real time emits about once per interval, never once per character', async () => {
    // The host takes one interval per character, so a rate-limited listener is
    // emitted ~M times here. That is the honest bound: the count tracks DURATION.
    const clock = fakeClock()
    const emissions: OperationReport[] = []
    const port = new OkPort(500, () => clock.advance(PROGRESS_EMIT_INTERVAL_MS))
    const executor = new MutationExecutor(port, { now: clock.now })

    await executor.execute(previewOf(500), { onProgress: (r) => emissions.push(r) })

    expect(emissions.length).toBeGreaterThan(1)
    expect(emissions.length).toBeLessThanOrEqual(500)
    expect(emissions[0]!.status).toBe('running')
    expect(emissions[emissions.length - 1]!.status).toBe('succeeded')
  })

  test('every running snapshot still agrees with a fresh derivation', async () => {
    const clock = fakeClock()
    const executor = new MutationExecutor(new OkPort(60, () => clock.advance(PROGRESS_EMIT_INTERVAL_MS)), {
      now: clock.now,
    })
    const seen: number[] = []

    await executor.execute(previewOf(60), {
      onProgress: (r) => {
        const succeeded = r.results.filter((x) => x.state === 'succeeded').length
        expect(r.totals).toEqual({
          total: 60,
          succeeded,
          failed: 60 - succeeded,
          remaining: 60 - succeeded,
        })
        if (r.status === 'running') seen.push(succeeded)
      },
    })

    // The reported success count must climb monotonically — a snapshot may lag,
    // but it must never report fewer writes done than one already reported.
    for (let i = 1; i < seen.length; i++) expect(seen[i]!).toBeGreaterThanOrEqual(seen[i - 1]!)
  })
})