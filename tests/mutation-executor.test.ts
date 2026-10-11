import { describe, expect, test } from 'bun:test'

import type { CharacterMutationPort } from '../src/frontend/repository'
import type { BatchFailure } from '../src/shared/protocol'
import type { CharacterTags, LumiTagCharacter } from '../src/shared/types'
import type { MutationOp, OperationPreview, PlannedMutation } from '../src/frontend/mutations/planner'
import { planOperation } from '../src/frontend/mutations/planner'
import {
  classifyError,
  MutationExecutor,
  RETAINED_REPORT_LIMIT,
} from '../src/frontend/mutations/executor'
import {
  computeTotals,
  deriveStatus,
  failureDisplayName,
  groupFailures,
  isFailure,
  isResolved,
  type MutationResult,
  type OperationReport,
} from '../src/frontend/mutations/report'

// ---------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------

/** What a write should do for one call. */
type WriteBehaviour =
  | { kind: 'ok' }
  | { kind: 'error'; error: unknown }
  /** Apply the tags anyway, then fail the response (the ambiguous timeout). */
  | { kind: 'apply-then-error'; error: unknown }
  /** Succeed but silently drop the tags (verifies post-state checking). */
  | { kind: 'silent-noop' }

interface Script {
  [characterId: string]: WriteBehaviour[]
}

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
 * A programmable server: mutable state, per-character write scripting and full
 * call recording so tests can assert exactly which writes happened.
 *
 * `updateTagsBatch` mirrors the real backend: ONE call in, and per character
 * either an `updated` entry or a `failures[]` entry — never a throw, unless
 * `batchFails` is set, which stands for a whole-request transport failure.
 */
class MockPort implements CharacterMutationPort {
  readonly server = new Map<string, LumiTagCharacter>()
  readonly deleted = new Set<string>()
  readonly writes: { id: string; tags: string[] }[] = []
  readonly gets: string[] = []
  /** Every batched write request, so the transport's round-trip count is assertable. */
  readonly batchWrites: { updates: { characterId: string; tags: string[] }[] }[] = []
  /** When set, the NEXT batched write throws instead of answering. */
  batchFails: unknown = null
  /**
   * Optional rewrite of the assembled reply, standing in for a host whose
   * `updated` entries are LOSSY — one character silently absent, or carried
   * under a blank/misnamed `id`. The write still happened server-side; only the
   * evidence came back damaged.
   */
  batchReplyHook:
    | ((reply: { updated: CharacterTags[]; failures: BatchFailure[] }) => {
        updated: CharacterTags[]
        failures: BatchFailure[]
      })
    | null = null
  private readonly script: Script = {}
  private readonly getFailures = new Map<string, unknown>()
  private inFlight = 0
  maxInFlight = 0
  /** Optional gate used to observe concurrency while a call is parked. */
  gate: { promise: Promise<void>; release: () => void } | null = null

  seed(id: string, name: string, tags: string[]): void {
    this.server.set(id, character(id, name, tags))
  }

  scriptWrites(id: string, behaviours: WriteBehaviour[]): void {
    this.script[id] = behaviours
  }

  failGet(id: string, error: unknown): void {
    this.getFailures.set(id, error)
  }

  writesFor(id: string): { id: string; tags: string[] }[] {
    return this.writes.filter((w) => w.id === id)
  }

  tagsOf(id: string): string[] {
    return this.server.get(id)?.tags ?? []
  }

  async getCharacter(id: string): Promise<LumiTagCharacter | null> {
    this.gets.push(id)
    const failure = this.getFailures.get(id)
    if (failure !== undefined) throw failure
    if (this.deleted.has(id)) return null
    const found = this.server.get(id)
    return found ? { ...found, tags: [...found.tags] } : null
  }

  async updateTags(id: string, tags: string[]): Promise<LumiTagCharacter> {
    this.inFlight += 1
    this.maxInFlight = Math.max(this.maxInFlight, this.inFlight)
    try {
      if (this.gate) await this.gate.promise
      const calls = this.writesFor(id).length
      const behaviour: WriteBehaviour = this.script[id]?.[calls] ?? { kind: 'ok' }
      // Recorded exactly as received — proves a string[] was sent.
      this.writes.push({ id, tags })

      const apply = (next: string[]): LumiTagCharacter => {
        const record = this.server.get(id) ?? character(id, id, [])
        const updated = { ...record, tags: [...next] }
        this.server.set(id, updated)
        return { ...updated, tags: [...updated.tags] }
      }

      if (behaviour.kind === 'error') throw behaviour.error
      if (behaviour.kind === 'apply-then-error') {
        apply(tags)
        throw behaviour.error
      }
      if (behaviour.kind === 'silent-noop') return apply([])
      return apply(tags)
    } finally {
      this.inFlight -= 1
    }
  }

  async getTagsBatch(ids: readonly string[]): Promise<Map<string, CharacterTags>> {
    const out = new Map<string, CharacterTags>()
    for (const id of ids) {
      const found = this.server.get(id)
      if (found) out.set(id, { id, tags: [...found.tags] })
    }
    return out
  }

  async updateTagsBatch(
    updates: { characterId: string; tags: string[] }[],
  ): Promise<{ updated: CharacterTags[]; failures: BatchFailure[] }> {
    this.batchWrites.push({ updates: updates.map((u) => ({ ...u, tags: [...u.tags] })) })
    if (this.batchFails !== null) {
      const failure = this.batchFails
      this.batchFails = null
      throw failure
    }

    const updated: CharacterTags[] = []
    const failures: BatchFailure[] = []
    for (const update of updates) {
      try {
        const written = await this.updateTags(update.characterId, update.tags)
        updated.push({ id: written.id, tags: [...written.tags] })
      } catch (error) {
        const classified = classifyError(error)
        failures.push({
          characterId: update.characterId,
          code: classified.code ?? 'internal',
          message: classified.message,
          retryable: classified.retryable,
        })
      }
    }
    return this.batchReplyHook === null ? { updated, failures } : this.batchReplyHook({ updated, failures })
  }
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

let seq = 0
function uid(prefix: string): string {
  seq += 1
  return `${prefix}${seq}`
}

interface Spec {
  characterId: string
  characterName?: string
  op?: MutationOp
  tag?: string
  destTag?: string
  addedTags?: string[]
  removedTags?: string[]
  /** What the character currently has on the server. */
  current?: string[]
  /**
   * The character's ONE intended final tag array. Every mutation of the same
   * character must agree on this — that is the planner's invariant, and what
   * lets several tag changes collapse into a single write.
   */
  targetTags?: string[]
}

function planMutation(spec: Spec): PlannedMutation {
  const addedTags = spec.addedTags ?? []
  const removedTags = spec.removedTags ?? []
  const current = spec.current ?? []
  return {
    mutationId: uid('m'),
    characterId: spec.characterId,
    characterName: spec.characterName ?? spec.characterId,
    op: spec.op ?? 'assign',
    tag: spec.tag ?? 'Elf',
    ...(spec.destTag === undefined ? {} : { destTag: spec.destTag }),
    sourceTags: removedTags,
    addedTags,
    removedTags,
    targetTags: spec.targetTags ?? [...current, ...addedTags],
    beforeTags: [...current],
    intendedChange: `${spec.op ?? 'assign'} ${spec.tag ?? 'Elf'}`,
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

function timeoutError(): Error {
  const e = new Error('Request timed out after 30000ms')
  e.name = 'TimeoutError'
  return e
}

function assertTotalsConsistent(report: OperationReport): void {
  expect(report.totals).toEqual(computeTotals(report.results))
  expect(report.status).toBe(deriveStatus(report.results, false))
}

// ---------------------------------------------------------------------------
// 1. All writes succeed
// ---------------------------------------------------------------------------

describe('1. all character writes succeed', () => {
  test('status succeeded, no failures', async () => {
    const port = new MockPort()
    port.seed('c1', 'A', [])
    port.seed('c2', 'B', [])
    const executor = new MutationExecutor(port)

    const report = await executor.execute(
      previewOf([
        planMutation({ characterId: 'c1', addedTags: ['Elf'] }),
        planMutation({ characterId: 'c2', addedTags: ['Elf'] }),
      ]),
    )

    expect(report.status).toBe('succeeded')
    expect(report.totals).toEqual({ total: 2, succeeded: 2, failed: 0, remaining: 0 })
    expect(groupFailures(report)).toEqual([])
    expect(port.tagsOf('c1')).toEqual(['Elf'])
    expect(port.tagsOf('c2')).toEqual(['Elf'])
    assertTotalsConsistent(report)
  })
})

// ---------------------------------------------------------------------------
// 2. One write fails, others succeed
// ---------------------------------------------------------------------------

describe('2. one write fails while others succeed', () => {
  test('partially_completed with exactly one failure', async () => {
    const port = new MockPort()
    port.seed('ok1', 'A', [])
    port.seed('bad', 'B', [])
    port.seed('ok2', 'C', [])
    port.scriptWrites('bad', [{ kind: 'error', error: new Error('Backend unavailable') }])
    const executor = new MutationExecutor(port)

    const report = await executor.execute(
      previewOf([
        planMutation({ characterId: 'ok1', addedTags: ['Elf'] }),
        planMutation({ characterId: 'bad', addedTags: ['Elf'] }),
        planMutation({ characterId: 'ok2', addedTags: ['Elf'] }),
      ]),
    )

    expect(report.status).toBe('partially_completed')
    expect(report.totals).toEqual({ total: 3, succeeded: 2, failed: 1, remaining: 1 })
    const failures = report.results.filter(isFailure)
    expect(failures).toHaveLength(1)
    expect(failures[0]?.characterId).toBe('bad')
    // The successful ones are untouched.
    const succeeded = report.results.filter(isResolved)
    expect(succeeded.map((r) => r.characterId).sort()).toEqual(['ok1', 'ok2'])
    expect(port.tagsOf('ok1')).toEqual(['Elf'])
    expect(port.tagsOf('ok2')).toEqual(['Elf'])
    expect(port.tagsOf('bad')).toEqual([])
    assertTotalsConsistent(report)
  })

  test('never reports complete success while a write failed', async () => {
    const port = new MockPort()
    port.seed('a', 'A', [])
    port.seed('b', 'B', [])
    port.scriptWrites('b', [{ kind: 'error', error: new Error('nope') }])
    const report = await new MutationExecutor(port).execute(
      previewOf([
        planMutation({ characterId: 'a', addedTags: ['Elf'] }),
        planMutation({ characterId: 'b', addedTags: ['Elf'] }),
      ]),
    )
    expect(report.status).not.toBe('succeeded')
  })
})

// ---------------------------------------------------------------------------
// 3. Several writes fail for different tags
// ---------------------------------------------------------------------------

describe('3. failures for different tags are distinguishable', () => {
  test('bulk delete: Elf fails on one character, Dark on another', async () => {
    const port = new MockPort()
    port.seed('c1', 'A', ['Elf', 'Dark'])
    port.seed('c2', 'B', ['Elf', 'Dark'])
    port.scriptWrites('c1', [{ kind: 'error', error: new Error('write rejected') }])
    port.scriptWrites('c2', [{ kind: 'error', error: new Error('write rejected') }])
    const executor = new MutationExecutor(port)

    const report = await executor.execute(
      previewOf(
        [
          planMutation({ characterId: 'c1', tag: 'Elf', op: 'delete', removedTags: ['Elf'], current: ['Elf', 'Dark'] }),
          planMutation({ characterId: 'c2', tag: 'Dark', op: 'delete', removedTags: ['Dark'], current: ['Elf', 'Dark'] }),
        ],
        'delete',
      ),
    )

    const groups = groupFailures(report)
    expect(groups.map((g) => g.key).sort()).toEqual(['dark', 'elf'])
    expect(groups.find((g) => g.key === 'elf')?.failures[0]?.characterId).toBe('c1')
    expect(groups.find((g) => g.key === 'dark')?.failures[0]?.characterId).toBe('c2')
    assertTotalsConsistent(report)
  })
})

// ---------------------------------------------------------------------------
// 4. A retry succeeds
// ---------------------------------------------------------------------------

describe('4. a retry succeeds', () => {
  test('failed mutation becomes resolved_on_retry', async () => {
    const port = new MockPort()
    port.seed('c1', 'A', [])
    port.scriptWrites('c1', [{ kind: 'error', error: new Error('temporary glitch') }])
    const executor = new MutationExecutor(port)

    const first = await executor.execute(
      previewOf([planMutation({ characterId: 'c1', addedTags: ['Elf'] })]),
    )
    const mutationId = first.results[0]!.mutationId

    const retried = await executor.retryOne(first, mutationId)
    const result = retried.results[0] as MutationResult
    expect(result.state).toBe('resolved_on_retry')
    expect(result.attempts).toBe(2)
    expect(result.error).toBeUndefined()
    expect(retried.status).toBe('succeeded')
    expect(port.tagsOf('c1')).toEqual(['Elf'])
    // A safe retry re-reads before it writes.
    expect(port.gets).toEqual(['c1'])
    assertTotalsConsistent(retried)
  })
})

// ---------------------------------------------------------------------------
// 5. A retry fails again
// ---------------------------------------------------------------------------

describe('5. a retry that fails again', () => {
  test('stays failed, attempts increments, LATEST error message kept', async () => {
    const port = new MockPort()
    port.seed('c1', 'A', [])
    port.scriptWrites('c1', [
      { kind: 'error', error: new Error('first failure') },
      { kind: 'error', error: new Error('second failure, different text') },
    ])
    const executor = new MutationExecutor(port)

    const first = await executor.execute(
      previewOf([planMutation({ characterId: 'c1', addedTags: ['Elf'] })]),
    )
    const mutationId = first.results[0]!.mutationId
    expect(first.results[0]?.error?.message).toBe('first failure')

    const retried = await executor.retryOne(first, mutationId)
    const result = retried.results[0] as MutationResult
    expect(result.state).toBe('failed')
    expect(result.attempts).toBe(2)
    expect(result.error?.message).toBe('second failure, different text')
    expect(result.error?.message).not.toBe('first failure')
    expect(retried.totals.remaining).toBe(1)
    assertTotalsConsistent(retried)
  })

  test('attempts keeps climbing across repeated retries', async () => {
    const port = new MockPort()
    port.seed('c1', 'A', [])
    port.scriptWrites('c1', [
      { kind: 'error', error: new Error('e1') },
      { kind: 'error', error: new Error('e2') },
      { kind: 'error', error: new Error('e3') },
    ])
    const executor = new MutationExecutor(port)
    let report = await executor.execute(previewOf([planMutation({ characterId: 'c1', addedTags: ['Elf'] })]))
    const mutationId = report.results[0]!.mutationId
    report = await executor.retryOne(report, mutationId)
    report = await executor.retryOne(report, mutationId)
    expect(report.results[0]?.attempts).toBe(3)
    expect(report.results[0]?.error?.message).toBe('e3')
  })
})

// ---------------------------------------------------------------------------
// 6. Ambiguous timeout: the write landed but the response was lost
// ---------------------------------------------------------------------------

describe('6. network timeout after the write may have succeeded', () => {
  test('first attempt is uncertain; retry detects the landed write and writes nothing', async () => {
    const port = new MockPort()
    port.seed('c1', 'A', [])
    port.scriptWrites('c1', [{ kind: 'apply-then-error', error: timeoutError() }])
    const executor = new MutationExecutor(port)

    const first = await executor.execute(
      previewOf([planMutation({ characterId: 'c1', addedTags: ['Elf'] })]),
    )
    const result = first.results[0] as MutationResult
    expect(result.state).toBe('failed')
    expect(result.uncertain).toBe(true)
    expect(result.retryable).toBe(true)
    expect(result.error?.code).toBe('timeout')
    expect(port.tagsOf('c1')).toEqual(['Elf'])
    const writesAfterFirst = port.writes.length

    const retried = await executor.retryOne(first, result.mutationId)
    expect((retried.results[0] as MutationResult).state).toBe('resolved_on_retry')
    // NO second write.
    expect(port.writes.length).toBe(writesAfterFirst)
    expect(port.tagsOf('c1')).toEqual(['Elf'])
    assertTotalsConsistent(retried)
  })
})

// ---------------------------------------------------------------------------
// 7. Retry finds the change already satisfied
// ---------------------------------------------------------------------------

describe('7. retry discovers the intended change is already satisfied', () => {
  test('resolved_on_retry with zero writes', async () => {
    const port = new MockPort()
    port.seed('c1', 'A', [])
    port.scriptWrites('c1', [{ kind: 'error', error: new Error('boom') }])
    const executor = new MutationExecutor(port)
    const first = await executor.execute(
      previewOf([planMutation({ characterId: 'c1', addedTags: ['Elf'] })]),
    )
    // Someone (or the earlier attempt) applied the tag outside our knowledge.
    port.server.set('c1', character('c1', 'A', ['Elf']))

    const before = port.writes.length
    const retried = await executor.retryOne(first, first.results[0]!.mutationId)
    expect((retried.results[0] as MutationResult).state).toBe('resolved_on_retry')
    expect(port.writes.length).toBe(before)
    expect(retried.status).toBe('succeeded')
  })

  test('a removal already applied elsewhere is detected too', async () => {
    const port = new MockPort()
    port.seed('c1', 'A', ['Elf'])
    port.scriptWrites('c1', [{ kind: 'error', error: new Error('boom') }])
    const executor = new MutationExecutor(port)
    const first = await executor.execute(
      previewOf([
        planMutation({ characterId: 'c1', tag: 'Elf', op: 'delete', removedTags: ['Elf'], current: ['Elf'] }),
      ], 'delete'),
    )
    port.server.set('c1', character('c1', 'A', []))
    const before = port.writes.length
    const retried = await executor.retryOne(first, first.results[0]!.mutationId)
    expect((retried.results[0] as MutationResult).state).toBe('resolved_on_retry')
    expect(port.writes.length).toBe(before)
  })
})

// ---------------------------------------------------------------------------
// 8. The character changes between attempt and retry
// ---------------------------------------------------------------------------

describe('8. a character changes between the original attempt and the retry', () => {
  test('the intervening unrelated tag survives; only the intended change is applied', async () => {
    const port = new MockPort()
    port.seed('c1', 'A', ['Elf'])
    port.scriptWrites('c1', [{ kind: 'error', error: new Error('boom') }])
    const executor = new MutationExecutor(port)

    const first = await executor.execute(
      previewOf([
        planMutation({ characterId: 'c1', tag: 'Dark', op: 'assign', addedTags: ['Dark'], current: ['Elf'] }),
      ]),
    )
    // The user adds an unrelated tag between the attempt and the retry.
    port.server.set('c1', character('c1', 'A', ['Elf', 'Dragon']))

    const retried = await executor.retryOne(first, first.results[0]!.mutationId)
    expect((retried.results[0] as MutationResult).state).toBe('resolved_on_retry')
    expect(port.tagsOf('c1').sort()).toEqual(['Dark', 'Dragon', 'Elf'])
    // A stale replay of beforeTags would have dropped Dragon.
    expect(port.tagsOf('c1')).toContain('Dragon')
    // A stale replay would have sent only the planned target tags.
    expect(port.writesFor('c1').at(-1)?.tags.sort()).toEqual(['Dark', 'Dragon', 'Elf'])
  })

  test('a tag the user re-added between attempts is respected on removal retry', async () => {
    const port = new MockPort()
    port.seed('c1', 'A', ['Elf', 'Dark'])
    port.scriptWrites('c1', [{ kind: 'error', error: new Error('boom') }])
    const executor = new MutationExecutor(port)
    const first = await executor.execute(
      previewOf([
        planMutation({ characterId: 'c1', tag: 'Elf', op: 'delete', removedTags: ['Elf'], current: ['Elf', 'Dark'] }),
      ], 'delete'),
    )
    port.server.set('c1', character('c1', 'A', ['Dark', 'Ancient']))
    await executor.retryOne(first, first.results[0]!.mutationId)
    expect(port.tagsOf('c1').sort()).toEqual(['Ancient', 'Dark'])
  })
})

// ---------------------------------------------------------------------------
// 9. The character became inaccessible
// ---------------------------------------------------------------------------

describe('9. the character is deleted or inaccessible', () => {
  test('getCharacter null → conflict, not retryable, no write attempted', async () => {
    const port = new MockPort()
    port.seed('c1', 'A', [])
    port.scriptWrites('c1', [{ kind: 'error', error: new Error('boom') }])
    const executor = new MutationExecutor(port)
    const first = await executor.execute(
      previewOf([planMutation({ characterId: 'c1', addedTags: ['Elf'] })]),
    )
    port.deleted.add('c1')

    const before = port.writes.length
    const retried = await executor.retryOne(first, first.results[0]!.mutationId)
    const result = retried.results[0] as MutationResult
    expect(result.state).toBe('conflict')
    expect(result.retryable).toBe(false)
    expect(result.error?.message).toMatch(/no longer accessible/i)
    expect(port.writes.length).toBe(before)
    assertTotalsConsistent(retried)
  })

  test('a throwing getCharacter is reported as a failure, not a silent success', async () => {
    const port = new MockPort()
    port.seed('c1', 'A', [])
    port.scriptWrites('c1', [{ kind: 'error', error: new Error('boom') }])
    const executor = new MutationExecutor(port)
    const first = await executor.execute(
      previewOf([planMutation({ characterId: 'c1', addedTags: ['Elf'] })]),
    )
    port.failGet('c1', new Error('backend unavailable'))
    const retried = await executor.retryOne(first, first.results[0]!.mutationId)
    expect((retried.results[0] as MutationResult).state).toBe('failed')
  })

  test('a conflict cannot be retried into a write', async () => {
    const port = new MockPort()
    port.seed('c1', 'A', [])
    port.scriptWrites('c1', [{ kind: 'error', error: new Error('boom') }])
    const executor = new MutationExecutor(port)
    let report = await executor.execute(
      previewOf([planMutation({ characterId: 'c1', addedTags: ['Elf'] })]),
    )
    port.deleted.add('c1')
    report = await executor.retryOne(report, report.results[0]!.mutationId)
    const before = port.writes.length
    report = await executor.retryAll(report)
    expect(port.writes.length).toBe(before)
    expect((report.results[0] as MutationResult).state).toBe('conflict')
  })
})

// ---------------------------------------------------------------------------
// 10. Same display name
// ---------------------------------------------------------------------------

describe('10. two characters share the same display name', () => {
  test('they stay distinguishable by id in the report and in failure labels', async () => {
    const port = new MockPort()
    port.seed('id-alpha', 'Elf', [])
    port.seed('id-beta', 'Elf', [])
    port.scriptWrites('id-beta', [{ kind: 'error', error: new Error('boom') }])
    const executor = new MutationExecutor(port)

    const report = await executor.execute(
      previewOf([
        planMutation({ characterId: 'id-alpha', characterName: 'Elf', addedTags: ['Dark'] }),
        planMutation({ characterId: 'id-beta', characterName: 'Elf', addedTags: ['Dark'] }),
      ]),
    )

    const alpha = report.results.find((r) => r.characterId === 'id-alpha')!
    const beta = report.results.find((r) => r.characterId === 'id-beta')!
    expect(alpha.characterName).toBe(beta.characterName)
    expect(alpha.characterId).not.toBe(beta.characterId)
    expect(failureDisplayName(alpha)).not.toBe(failureDisplayName(beta))
    expect(failureDisplayName(alpha)).toMatch(/^Elf \(id-a…\)$/)
    expect(failureDisplayName(beta)).toMatch(/^Elf \(id-b…\)$/)
  })
})

// ---------------------------------------------------------------------------
// 11 & 12. Retry scoping
// ---------------------------------------------------------------------------

describe('11 & 12. retrying one tag change does not re-run other tags', () => {
  test('a partially successful bulk delete: retrying the failed tag does not rewrite the successful one', async () => {
    const port = new MockPort()
    // Elf is deleted from four characters; two succeed and two fail.
    for (const id of ['elf-ok-1', 'elf-ok-2']) port.seed(id, id, ['Elf', 'Dark'])
    for (const id of ['elf-bad-1', 'elf-bad-2']) port.seed(id, id, ['Elf', 'Dark'])
    // A separate Dark deletion on two more characters.
    for (const id of ['dark-ok', 'dark-bad']) port.seed(id, id, ['Elf', 'Dark'])
    port.scriptWrites('elf-bad-1', [{ kind: 'error', error: new Error('boom') }])
    port.scriptWrites('elf-bad-2', [{ kind: 'error', error: new Error('boom') }])
    port.scriptWrites('dark-bad', [{ kind: 'error', error: new Error('boom') }])
    const executor = new MutationExecutor(port)

    const first = await executor.execute(
      previewOf(
        [
          planMutation({ characterId: 'elf-ok-1', tag: 'Elf', op: 'delete', removedTags: ['Elf'], current: ['Elf', 'Dark'], targetTags: ['Dark'] }),
          planMutation({ characterId: 'elf-ok-2', tag: 'Elf', op: 'delete', removedTags: ['Elf'], current: ['Elf', 'Dark'], targetTags: ['Dark'] }),
          planMutation({ characterId: 'elf-bad-1', tag: 'Elf', op: 'delete', removedTags: ['Elf'], current: ['Elf', 'Dark'], targetTags: ['Dark'] }),
          planMutation({ characterId: 'elf-bad-2', tag: 'Elf', op: 'delete', removedTags: ['Elf'], current: ['Elf', 'Dark'], targetTags: ['Dark'] }),
          planMutation({ characterId: 'dark-ok', tag: 'Dark', op: 'delete', removedTags: ['Dark'], current: ['Elf', 'Dark'], targetTags: ['Elf'] }),
          planMutation({ characterId: 'dark-bad', tag: 'Dark', op: 'delete', removedTags: ['Dark'], current: ['Elf', 'Dark'], targetTags: ['Elf'] }),
        ],
        'delete',
      ),
    )
    expect(first.status).toBe('partially_completed')
    expect(first.totals).toEqual({ total: 6, succeeded: 3, failed: 3, remaining: 3 })

    const writesBefore = {
      elfOk1: port.writesFor('elf-ok-1').length,
      elfOk2: port.writesFor('elf-ok-2').length,
      darkOk: port.writesFor('dark-ok').length,
      darkBad: port.writesFor('dark-bad').length,
    }

    const retried = await executor.retryGroup(first, 'elf')

    // The two failed Elf removals were retried and now succeeded.
    const elfBad = retried.results.filter((r) => r.characterId.startsWith('elf-bad'))
    expect(elfBad.every(isResolved)).toBe(true)
    expect(port.tagsOf('elf-bad-1')).toEqual(['Dark'])
    expect(port.tagsOf('elf-bad-2')).toEqual(['Dark'])

    // The SUCCESSFUL Elf deletions were not re-run.
    expect(port.writesFor('elf-ok-1').length).toBe(writesBefore.elfOk1)
    expect(port.writesFor('elf-ok-2').length).toBe(writesBefore.elfOk2)

    // The unrelated Dark changes were untouched, successful or not.
    expect(port.writesFor('dark-ok').length).toBe(writesBefore.darkOk)
    expect(port.writesFor('dark-bad').length).toBe(writesBefore.darkBad)
    const darkResults = retried.results.filter((r) => r.tag === 'Dark')
    expect(darkResults.filter(isFailure)).toHaveLength(1)
    expect(darkResults.filter(isResolved)).toHaveLength(1)
    assertTotalsConsistent(retried)
  })

  test('a bulk delete where one character has BOTH tag changes failing keeps them separately retryable', async () => {
    const port = new MockPort()
    port.seed('c1', 'A', ['Elf', 'Dark'])
    port.scriptWrites('c1', [{ kind: 'error', error: new Error('boom') }])
    const executor = new MutationExecutor(port)
    const first = await executor.execute(
      previewOf(
        [
          // Both changes share ONE intended final tag array: [].
          planMutation({ characterId: 'c1', tag: 'Elf', op: 'delete', removedTags: ['Elf'], current: ['Elf', 'Dark'], targetTags: [] }),
          planMutation({ characterId: 'c1', tag: 'Dark', op: 'delete', removedTags: ['Dark'], current: ['Elf', 'Dark'], targetTags: [] }),
        ],
        'delete',
      ),
    )
    expect(port.writesFor('c1')).toHaveLength(1)
    expect(first.totals.remaining).toBe(2)
    expect(groupFailures(first).map((g) => g.key).sort()).toEqual(['dark', 'elf'])

    // Retrying only Elf removes Elf and leaves Dark in place.
    const afterElf = await executor.retryGroup(first, 'elf')
    expect(port.tagsOf('c1')).toEqual(['Dark'])
    expect(afterElf.results.find((r) => r.tag === 'Dark')?.state).toBe('failed')
    // Retrying only Dark then finishes the job.
    const afterDark = await executor.retryGroup(afterElf, 'dark')
    expect(port.tagsOf('c1')).toEqual([])
    expect(afterDark.status).toBe('succeeded')
  })

  test('retryGroup on one tag never re-applies a successful assignment for another', async () => {
    const port = new MockPort()
    port.seed('c1', 'A', ['Dark'])
    port.seed('c1-dup', 'B', ['Elf'])
    port.scriptWrites('c1-dup', [{ kind: 'error', error: new Error('boom') }])
    const executor = new MutationExecutor(port)

    const first = await executor.execute(
      previewOf([
        planMutation({ characterId: 'c1', tag: 'Elf', op: 'assign', addedTags: ['Elf'], current: ['Dark'] }),
        planMutation({ characterId: 'c1-dup', tag: 'Elf', op: 'assign', addedTags: ['Elf'], current: ['Elf'] }),
      ]),
    )
    const writesForC1 = port.writesFor('c1').length
    const group = groupFailures(first)[0]!
    expect(group.key).toBe('elf')

    const retried = await executor.retryGroup(first, group.key)
    // Only c1-dup was outstanding; the successful c1 write was not repeated.
    expect(port.writesFor('c1').length).toBe(writesForC1)
    expect(port.tagsOf('c1').sort()).toEqual(['Dark', 'Elf'])
    expect((retried.results.find((r) => r.characterId === 'c1-dup'))?.state).toBe('resolved_on_retry')
  })

  test('retryGroup with an unknown key is a harmless no-op', async () => {
    const port = new MockPort()
    port.seed('c1', 'A', [])
    const executor = new MutationExecutor(port)
    const first = await executor.execute(previewOf([planMutation({ characterId: 'c1', addedTags: ['Elf'] })]))
    const before = port.writes.length
    const retried = await executor.retryGroup(first, 'does-not-exist')
    expect(port.writes.length).toBe(before)
    expect(retried.totals).toEqual(first.totals)
  })

  test('retryAll clears every remaining failure', async () => {
    const port = new MockPort()
    port.seed('c1', 'A', [])
    port.seed('c2', 'B', [])
    port.scriptWrites('c1', [{ kind: 'error', error: new Error('e1') }])
    port.scriptWrites('c2', [{ kind: 'error', error: new Error('e2') }])
    const executor = new MutationExecutor(port)
    const first = await executor.execute(
      previewOf([
        planMutation({ characterId: 'c1', addedTags: ['Elf'] }),
        planMutation({ characterId: 'c2', addedTags: ['Elf'] }),
      ]),
    )
    expect(first.totals.remaining).toBe(2)
    const retried = await executor.retryAll(first)
    expect(retried.status).toBe('succeeded')
    expect(retried.totals.remaining).toBe(0)
    assertTotalsConsistent(retried)
  })
})

// ---------------------------------------------------------------------------
// 13. Duplicate retries
// ---------------------------------------------------------------------------

describe('13. duplicate retries cannot create duplicate assignments', () => {
  test('two concurrent retryOne calls write once and leave no duplicate tags', async () => {
    const port = new MockPort()
    port.seed('c1', 'A', [])
    port.scriptWrites('c1', [{ kind: 'error', error: new Error('boom') }])
    const executor = new MutationExecutor(port)
    const first = await executor.execute(
      previewOf([planMutation({ characterId: 'c1', addedTags: ['Elf'] })]),
    )
    const mutationId = first.results[0]!.mutationId

    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    port.gate = { promise: gate, release }

    const a = executor.retryOne(first, mutationId)
    const b = executor.retryOne(first, mutationId)
    // Let both attempts reach the gate, then release.
    await Promise.resolve()
    release()
    const [ra, rb] = await Promise.all([a, b])

    // Bounded: at most one extra write for the retry (the other is skipped).
    expect(port.writes.length).toBeLessThanOrEqual(2)
    const finalTags = port.tagsOf('c1')
    expect(finalTags).toEqual(['Elf'])
    expect(new Set(finalTags).size).toBe(finalTags.length)
    expect((ra.results[0] as MutationResult).state).toBe('resolved_on_retry')
    expect((rb.results[0] as MutationResult).state).toBe('resolved_on_retry')
  })

  test('a retry after success is a no-op and never rewrites', async () => {
    const port = new MockPort()
    port.seed('c1', 'A', [])
    port.scriptWrites('c1', [{ kind: 'error', error: new Error('boom') }])
    const executor = new MutationExecutor(port)
    const first = await executor.execute(
      previewOf([planMutation({ characterId: 'c1', addedTags: ['Elf'] })]),
    )
    const mutationId = first.results[0]!.mutationId
    const retried = await executor.retryOne(first, mutationId)
    const writesAfterRetry = port.writes.length

    const again = await executor.retryOne(retried, mutationId)
    expect(port.writes.length).toBe(writesAfterRetry)
    expect(again.results[0]?.state).toBe('resolved_on_retry')
    expect(port.tagsOf('c1')).toEqual(['Elf'])
  })

  test('retrying a never-failed mutation is a no-op', async () => {
    const port = new MockPort()
    port.seed('c1', 'A', [])
    const executor = new MutationExecutor(port)
    const first = await executor.execute(previewOf([planMutation({ characterId: 'c1', addedTags: ['Elf'] })]))
    const before = port.writes.length
    const again = await executor.retryOne(first, first.results[0]!.mutationId)
    expect(port.writes.length).toBe(before)
    expect(again.results[0]?.state).toBe('succeeded')
    expect(again.results[0]?.attempts).toBe(first.results[0]?.attempts)
  })

  test('retryAll twice in a row does not double-apply', async () => {
    const port = new MockPort()
    port.seed('c1', 'A', [])
    port.scriptWrites('c1', [{ kind: 'error', error: new Error('boom') }])
    const executor = new MutationExecutor(port)
    const first = await executor.execute(previewOf([planMutation({ characterId: 'c1', addedTags: ['Elf'] })]))
    const once = await executor.retryAll(first)
    const writes = port.writes.length
    const twice = await executor.retryAll(once)
    expect(port.writes.length).toBe(writes)
    expect(port.tagsOf('c1')).toEqual(['Elf'])
    expect(twice.totals.remaining).toBe(0)
  })

  test('isRetrying reports an in-flight retry', async () => {
    const port = new MockPort()
    port.seed('c1', 'A', [])
    port.scriptWrites('c1', [{ kind: 'error', error: new Error('boom') }])
    const executor = new MutationExecutor(port)
    const first = await executor.execute(previewOf([planMutation({ characterId: 'c1', addedTags: ['Elf'] })]))
    const mutationId = first.results[0]!.mutationId

    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    port.gate = { promise: gate, release }

    expect(executor.isRetrying(first, mutationId)).toBe(false)
    const pending = executor.retryOne(first, mutationId)
    await new Promise((resolve) => setTimeout(resolve, 5))
    expect(executor.isRetrying(first, mutationId)).toBe(true)
    release()
    await pending
    expect(executor.isRetrying(first, mutationId)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// 14. Counts stay consistent
// ---------------------------------------------------------------------------

describe('14. counts and the remaining-failures list stay consistent', () => {
  test('totals equal a fresh recount after execute and every retry', async () => {
    const port = new MockPort()
    port.seed('c1', 'A', [])
    port.seed('c2', 'B', [])
    port.seed('c3', 'C', [])
    port.scriptWrites('c1', [{ kind: 'error', error: new Error('e') }])
    port.scriptWrites('c2', [{ kind: 'error', error: new Error('e') }])
    const executor = new MutationExecutor(port)

    let report = await executor.execute(
      previewOf([
        planMutation({ characterId: 'c1', addedTags: ['Elf'] }),
        planMutation({ characterId: 'c2', addedTags: ['Elf'] }),
        planMutation({ characterId: 'c3', addedTags: ['Elf'] }),
      ]),
    )
    assertTotalsConsistent(report)
    expect(report.totals.remaining).toBe(2)
    expect(groupFailures(report).reduce((n, g) => n + g.failures.length, 0)).toBe(2)
    expect(report.results.filter(isFailure)).toHaveLength(report.totals.remaining)

    report = await executor.retryOne(report, report.results[0]!.mutationId)
    assertTotalsConsistent(report)
    expect(report.totals.remaining).toBe(1)
    expect(report.results.filter(isFailure)).toHaveLength(1)

    report = await executor.retryAll(report)
    assertTotalsConsistent(report)
    expect(report.totals.remaining).toBe(0)
    expect(report.results.filter(isFailure)).toHaveLength(0)
    expect(groupFailures(report)).toEqual([])
  })

  test('the stored report and a fresh recount agree', async () => {
    const port = new MockPort()
    port.seed('c1', 'A', [])
    port.scriptWrites('c1', [{ kind: 'error', error: new Error('e') }])
    const executor = new MutationExecutor(port)
    const report = await executor.execute(previewOf([planMutation({ characterId: 'c1', addedTags: ['Elf'] })]))
    const stored = executor.getReport(report.opId)!
    expect(stored.totals).toEqual(computeTotals(stored.results))
    expect(stored.status).toBe('failed')
  })
})

// ---------------------------------------------------------------------------
// Write-shape invariants
// ---------------------------------------------------------------------------

describe('one write per character per attempt', () => {
  test('three planned tag changes on one character → exactly one updateTags call', async () => {
    const port = new MockPort()
    port.seed('c1', 'A', ['Elf', 'Dark'])
    const executor = new MutationExecutor(port)
    // All three changes share ONE intended final tag array.
    const final = ['Elf', 'Dark', 'Dragon', 'Ancient', 'Beast']
    const report = await executor.execute(
      previewOf([
        planMutation({ characterId: 'c1', tag: 'Dragon', addedTags: ['Dragon'], current: ['Elf', 'Dark'], targetTags: final }),
        planMutation({ characterId: 'c1', tag: 'Ancient', addedTags: ['Ancient'], current: ['Elf', 'Dark'], targetTags: final }),
        planMutation({ characterId: 'c1', tag: 'Beast', addedTags: ['Beast'], current: ['Elf', 'Dark'], targetTags: final }),
      ]),
    )
    expect(port.writesFor('c1')).toHaveLength(1)
    expect(report.results).toHaveLength(3)
    expect(report.results.every((r) => r.state === 'succeeded')).toBe(true)
    expect(port.tagsOf('c1').sort()).toEqual(['Ancient', 'Beast', 'Dark', 'Dragon', 'Elf'])
  })

  test('a single failing write fails every mutation of that character, each retryable', async () => {
    const port = new MockPort()
    port.seed('c1', 'A', [])
    port.scriptWrites('c1', [{ kind: 'error', error: new Error('boom') }])
    const executor = new MutationExecutor(port)
    const report = await executor.execute(
      previewOf([
        planMutation({ characterId: 'c1', tag: 'Elf', addedTags: ['Elf'], targetTags: ['Elf', 'Dark'] }),
        planMutation({ characterId: 'c1', tag: 'Dark', addedTags: ['Dark'], targetTags: ['Elf', 'Dark'] }),
      ]),
    )
    expect(port.writesFor('c1')).toHaveLength(1)
    expect(report.totals).toEqual({ total: 2, succeeded: 0, failed: 2, remaining: 2 })
    expect(report.results.every((r) => r.retryable)).toBe(true)
    // Both still name which tag change failed.
    expect(groupFailures(report).map((g) => g.key).sort()).toEqual(['dark', 'elf'])
  })

  test('a write whose tags disagree across mutations becomes a conflict, not a guess', async () => {
    const port = new MockPort()
    port.seed('c1', 'A', [])
    const executor = new MutationExecutor(port)
    const a = planMutation({ characterId: 'c1', tag: 'Elf', addedTags: ['Elf'] })
    const b = planMutation({ characterId: 'c1', tag: 'Dark', addedTags: ['Dark'] })
    ;(b as PlannedMutation).targetTags = ['Totally', 'Different']

    const report = await executor.execute(previewOf([a, b]))
    expect(port.writesFor('c1')).toHaveLength(0)
    expect(report.results.every((r) => r.state === 'conflict')).toBe(true)
    expect(report.results.every((r) => r.retryable === false)).toBe(true)
  })
})

describe('only the tag array is ever sent', () => {
  test('the port receives a string[] and never a character snapshot', async () => {
    const port = new MockPort()
    port.seed('c1', 'A', [])
    const executor = new MutationExecutor(port)
    await executor.execute(previewOf([planMutation({ characterId: 'c1', addedTags: ['Elf'] })]))
    const write = port.writes[0]!
    expect(Array.isArray(write.tags)).toBe(true)
    expect(write.tags.every((t) => typeof t === 'string')).toBe(true)
    expect(write.tags).toEqual(['Elf'])
  })

  test('unrelated fields of the character are untouched by a write', async () => {
    const port = new MockPort()
    port.seed('c1', 'A', ['Elf'])
    port.server.set('c1', { ...character('c1', 'A', ['Elf']), description: 'original description' })
    const executor = new MutationExecutor(port)
    const report = await executor.execute(
      previewOf([planMutation({ characterId: 'c1', addedTags: ['Dark'], current: ['Elf'] })]),
    )
    expect(report.status).toBe('succeeded')
    expect(port.server.get('c1')?.description).toBe('original description')
    expect(port.server.get('c1')?.tags.sort()).toEqual(['Dark', 'Elf'])
  })

  test('unrelated tags are preserved in every write', async () => {
    const port = new MockPort()
    port.seed('c1', 'A', ['Keep', 'Also'])
    const executor = new MutationExecutor(port)
    await executor.execute(
      previewOf([planMutation({ characterId: 'c1', addedTags: ['New'], current: ['Keep', 'Also'] })]),
    )
    expect(port.tagsOf('c1').sort()).toEqual(['Also', 'Keep', 'New'])
  })
})

describe('batched write transport', () => {
  test('twelve characters cost ONE request, not twelve', async () => {
    const port = new MockPort()
    const ids = Array.from({ length: 12 }, (_, i) => `c${i}`)
    for (const id of ids) port.seed(id, id, [])

    const report = await new MutationExecutor(port).execute(
      previewOf(ids.map((characterId) => planMutation({ characterId, addedTags: ['Elf'] }))),
    )

    // The whole point of batching: the message channel sees one message, and the
    // per-character writes all still happen inside it.
    expect(port.batchWrites).toHaveLength(1)
    expect(port.batchWrites[0]?.updates.map((u) => u.characterId)).toEqual(ids)
    expect(port.writes).toHaveLength(12)
    expect(report.status).toBe('succeeded')
  })

  test('the write concurrency option no longer multiplies round trips', async () => {
    const port = new MockPort()
    const ids = Array.from({ length: 9 }, (_, i) => `c${i}`)
    for (const id of ids) port.seed(id, id, [])
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    port.gate = { promise: gate, release }

    const pending = new MutationExecutor(port, { concurrency: 3 }).execute(
      previewOf(ids.map((characterId) => planMutation({ characterId, addedTags: ['Elf'] }))),
    )
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(port.batchWrites).toHaveLength(1)
    release()
    expect((await pending).status).toBe('succeeded')
  })

  test('a concurrency below 1 is clamped, not a deadlock', async () => {
    const port = new MockPort()
    port.seed('c1', 'A', [])
    port.seed('c2', 'B', [])
    const report = await new MutationExecutor(port, { concurrency: 0 }).execute(
      previewOf([
        planMutation({ characterId: 'c1', addedTags: ['Elf'] }),
        planMutation({ characterId: 'c2', addedTags: ['Elf'] }),
      ]),
    )
    expect(report.status).toBe('succeeded')
    expect(port.batchWrites).toHaveLength(1)
  })

  test('an empty preview never reaches the transport', async () => {
    const port = new MockPort()
    const report = await new MutationExecutor(port).execute(previewOf([]))
    expect(port.batchWrites).toHaveLength(0)
    expect(report.results).toHaveLength(0)
  })

  test('a conflicting character is excluded from the batch, not written', async () => {
    const port = new MockPort()
    port.seed('c1', 'A', [])
    port.seed('c2', 'B', [])
    const a = planMutation({ characterId: 'c1', addedTags: ['Elf'] })
    const b = planMutation({ characterId: 'c1', addedTags: ['Dark'] })
    ;(b as PlannedMutation).targetTags = ['Totally', 'Different']

    const report = await new MutationExecutor(port).execute(
      previewOf([a, b, planMutation({ characterId: 'c2', addedTags: ['Elf'] })]),
    )

    // The disagreement is never sent; the well-formed character still is.
    expect(port.batchWrites[0]?.updates.map((u) => u.characterId)).toEqual(['c2'])
    expect(port.tagsOf('c1')).toEqual([])
    expect(port.tagsOf('c2')).toEqual(['Elf'])
    expect(report.results.filter((r) => r.state === 'conflict')).toHaveLength(2)
    expect(report.results.filter((r) => r.state === 'succeeded')).toHaveLength(1)
  })
})

describe('batch failures', () => {
  test('one item failing leaves every other character written and reported', async () => {
    const port = new MockPort()
    port.seed('ok1', 'A', [])
    port.seed('bad', 'B', [])
    port.seed('ok2', 'C', [])
    port.scriptWrites('bad', [{ kind: 'error', error: new Error('Character not found') }])

    const report = await new MutationExecutor(port).execute(
      previewOf([
        planMutation({ characterId: 'ok1', addedTags: ['Elf'] }),
        planMutation({ characterId: 'bad', addedTags: ['Elf'] }),
        planMutation({ characterId: 'ok2', addedTags: ['Elf'] }),
      ]),
    )

    expect(report.status).toBe('partially_completed')
    expect(report.totals).toEqual({ total: 3, succeeded: 2, failed: 1, remaining: 1 })
    const failure = report.results.find((r) => r.characterId === 'bad') as MutationResult
    expect(failure.state).toBe('failed')
    expect(failure.error?.message).toBe('Character not found')
    // `not found` is terminal: a retry can never fix a deleted character.
    expect(failure.retryable).toBe(false)
    expect(port.tagsOf('bad')).toEqual([])
    expect(port.tagsOf('ok1')).toEqual(['Elf'])
    expect(port.tagsOf('ok2')).toEqual(['Elf'])
    assertTotalsConsistent(report)
  })

  test('a per-item failure keeps its own code and retryability', async () => {
    const port = new MockPort()
    port.seed('bad', 'B', [])
    port.scriptWrites('bad', [{ kind: 'error', error: new Error('network unreachable') }])

    const report = await new MutationExecutor(port).execute(
      previewOf([planMutation({ characterId: 'bad', addedTags: ['Elf'] })]),
    )

    const failure = report.results[0] as MutationResult
    expect(failure.state).toBe('failed')
    expect(failure.retryable).toBe(true)
    expect(failure.error?.code).toBe('timeout')
    // The host may have written before it failed, so the outcome is unknown.
    expect(failure.uncertain).toBe(true)
    expect(failure.attempts).toBe(1)
  })

  test('a failed item of a multi-mutation character fails only that character', async () => {
    const port = new MockPort()
    port.seed('bad', 'B', [])
    port.seed('ok', 'O', [])
    port.scriptWrites('bad', [{ kind: 'error', error: new Error('boom') }])

    const report = await new MutationExecutor(port).execute(
      previewOf([
        planMutation({ characterId: 'bad', tag: 'Elf', addedTags: ['Elf'], targetTags: ['Elf', 'Dark'] }),
        planMutation({ characterId: 'bad', tag: 'Dark', addedTags: ['Dark'], targetTags: ['Elf', 'Dark'] }),
        planMutation({ characterId: 'ok', addedTags: ['Elf'] }),
      ]),
    )

    expect(report.results.filter((r) => r.characterId === 'bad').every((r) => r.state === 'failed')).toBe(true)
    expect(report.results.filter((r) => r.characterId === 'ok').every((r) => r.state === 'succeeded')).toBe(true)
    // Both of the failed character's mutations are individually retryable.
    expect(report.results.filter((r) => r.characterId === 'bad').every((r) => r.retryable)).toBe(true)
  })

  test('a whole-request transport failure fails every mutation in the batch', async () => {
    const port = new MockPort()
    port.seed('c1', 'A', [])
    port.seed('c2', 'B', [])
    port.batchFails = timeoutError()

    const report = await new MutationExecutor(port).execute(
      previewOf([
        planMutation({ characterId: 'c1', addedTags: ['Elf'] }),
        planMutation({ characterId: 'c2', addedTags: ['Elf'] }),
      ]),
    )

    expect(report.status).toBe('failed')
    expect(report.totals).toEqual({ total: 2, succeeded: 0, failed: 2, remaining: 2 })
    for (const result of report.results as MutationResult[]) {
      expect(result.error?.code).toBe('timeout')
      expect(result.uncertain).toBe(true)
      expect(result.retryable).toBe(true)
      // The attempt was counted even though the request never landed.
      expect(result.attempts).toBe(1)
    }
    assertTotalsConsistent(report)
  })

  test('a transport failure is still safely retryable per character', async () => {
    const port = new MockPort()
    port.seed('c1', 'A', [])
    port.batchFails = timeoutError()
    const executor = new MutationExecutor(port)
    const first = await executor.execute(previewOf([planMutation({ characterId: 'c1', addedTags: ['Elf'] })]))

    const retried = await executor.retryOne(first, first.results[0]!.mutationId)
    expect((retried.results[0] as MutationResult).state).toBe('resolved_on_retry')
    expect(port.tagsOf('c1')).toEqual(['Elf'])
  })

  test('hooks still fire once per mutation, and progress once per character', async () => {
    const port = new MockPort()
    port.seed('ok1', 'A', [])
    port.seed('bad', 'B', [])
    port.seed('ok2', 'C', [])
    port.scriptWrites('bad', [{ kind: 'error', error: new Error('boom') }])

    const onResult: string[] = []
    const progressCounts: number[] = []
    await new MutationExecutor(port).execute(
      previewOf([
        planMutation({ characterId: 'ok1', addedTags: ['Elf'] }),
        planMutation({ characterId: 'bad', addedTags: ['Elf'] }),
        planMutation({ characterId: 'ok2', tag: 'Dark', addedTags: ['Dark'] }),
      ]),
      {
        onResult: (r) => onResult.push(`${r.characterId}:${r.state}`),
        onProgress: (r) => progressCounts.push(r.results.filter((x) => x.state !== 'pending').length),
      },
    )

    expect(onResult.sort()).toEqual(['bad:failed', 'ok1:succeeded', 'ok2:succeeded'])
    // One per character while it settles, then the final report — never fewer.
    expect(progressCounts[progressCounts.length - 1]).toBe(3)
    expect(progressCounts.length).toBe(4)
  })

  test('the returned report is a separate object from the executor state', async () => {
    const port = new MockPort()
    port.seed('c1', 'A', [])
    const executor = new MutationExecutor(port)
    const report = await executor.execute(previewOf([planMutation({ characterId: 'c1', addedTags: ['Elf'] })]))

    report.results[0]!.state = 'failed'
    report.results[0]!.sourceTags.push('not-a-real-tag')

    const stored = executor.getReport(report.opId)!
    expect(stored.results[0]!.state).toBe('succeeded')
    expect(stored.status).toBe('succeeded')
  })
})

/* -------------------------------------------------------------------------- */
/* Never report success from optimistic state                                   */
/* -------------------------------------------------------------------------- */

describe('an unverified batch entry is not a success', () => {
  /**
   * The reply's `updated` is the ONLY host evidence a bulk write produces, so
   * any character it fails to name has an unknown outcome — whatever the host
   * actually stored. Falling back to the array we INTENDED to write would make
   * `intentSatisfied` true by construction and report a save that was never
   * confirmed, which is exactly the invariant this codebase is built around.
   */
  test('a character the reply omits entirely is failed, not succeeded', async () => {
    const port = new MockPort()
    port.seed('ok1', 'A', [])
    port.seed('lost', 'B', [])
    port.batchReplyHook = ({ updated, failures }) => ({
      updated: updated.filter((entry) => entry.id !== 'lost'),
      failures,
    })

    const report = await new MutationExecutor(port).execute(
      previewOf([
        planMutation({ characterId: 'ok1', addedTags: ['Elf'] }),
        planMutation({ characterId: 'lost', addedTags: ['Elf'] }),
      ]),
    )

    // The write DID reach the host — `lost` really has the tag. That is exactly
    // why the result must be `uncertain` rather than a confident failure.
    expect(port.tagsOf('lost')).toEqual(['Elf'])
    const lost = report.results.find((r) => r.characterId === 'lost') as MutationResult
    expect(lost.state).toBe('failed')
    expect(lost.retryable).toBe(true)
    expect(lost.uncertain).toBe(true)
    expect(report.results.find((r) => r.characterId === 'ok1')?.state).toBe('succeeded')
    assertTotalsConsistent(report)
  })

  test('an entry the host names with a blank or absent id is not a success', async () => {
    // `normalizeCharacterTagsOnly` yields `id: ''` for a missing/blank host id
    // and never throws, so a misnamed id silently misses the correlation map.
    for (const badId of ['', 'some-other-id']) {
      const port = new MockPort()
      port.seed('c1', 'A', [])
      port.batchReplyHook = ({ updated, failures }) => ({
        updated: updated.map((entry) => ({ id: badId, tags: entry.tags })),
        failures,
      })

      const report = await new MutationExecutor(port).execute(
        previewOf([planMutation({ characterId: 'c1', addedTags: ['Elf'] })]),
      )

      expect(report.results[0]!.state).toBe('failed')
      expect(report.results[0]!.uncertain).toBe(true)
      expect(report.results[0]!.retryable).toBe(true)
      assertTotalsConsistent(report)
    }
  })

  test('an uncertain failure resolves on retry instead of double-applying', async () => {
    const port = new MockPort()
    port.seed('c1', 'A', [])
    port.batchReplyHook = ({ updated, failures }) => ({ updated: updated.filter(() => false), failures })
    const executor = new MutationExecutor(port)
    const first = await executor.execute(previewOf([planMutation({ characterId: 'c1', addedTags: ['Elf'] })]))

    // The retry RE-READS: the write did land, so it recognises its own work and
    // re-applies nothing.
    const retried = await executor.retryOne(first, first.results[0]!.mutationId)
    expect((retried.results[0] as MutationResult).state).toBe('resolved_on_retry')
    expect(port.writesFor('c1')).toHaveLength(1)
    expect(port.tagsOf('c1')).toEqual(['Elf'])
  })
})

describe('rename and merge safety', () => {
  test('source gone AND destination absent → conflict, no write', async () => {
    const port = new MockPort()
    port.seed('c1', 'A', ['Mage'])
    port.scriptWrites('c1', [{ kind: 'error', error: new Error('boom') }])
    const executor = new MutationExecutor(port)
    const first = await executor.execute(
      previewOf([
        planMutation({
          characterId: 'c1',
          op: 'rename',
          tag: 'Mage',
          destTag: 'Magic',
          addedTags: ['Magic'],
          removedTags: ['Mage'],
          current: ['Mage'],
        }),
      ], 'rename'),
    )
    // Someone removed Mage entirely and never added Magic.
    port.server.set('c1', character('c1', 'A', []))

    const before = port.writes.length
    const retried = await executor.retryOne(first, first.results[0]!.mutationId)
    const result = retried.results[0] as MutationResult
    expect(result.state).toBe('conflict')
    expect(result.retryable).toBe(false)
    expect(result.error?.message).toContain('Mage')
    expect(port.writes.length).toBe(before)
  })

  test('a merge retry never reintroduces an already-removed source tag', async () => {
    const port = new MockPort()
    port.seed('c1', 'A', ['Mage', 'Fire'])
    port.scriptWrites('c1', [{ kind: 'error', error: new Error('boom') }])
    const executor = new MutationExecutor(port)
    const first = await executor.execute(
      previewOf([
        planMutation({
          characterId: 'c1',
          op: 'merge',
          tag: 'Mage',
          destTag: 'Magic',
          addedTags: ['Magic'],
          removedTags: ['Mage'],
          current: ['Mage', 'Fire'],
        }),
      ], 'merge'),
    )
    // The source vanished, but the destination is present, so the merge is
    // simply already complete.
    port.server.set('c1', character('c1', 'A', ['Magic', 'Fire']))
    const before = port.writes.length
    const retried = await executor.retryOne(first, first.results[0]!.mutationId)
    expect((retried.results[0] as MutationResult).state).toBe('resolved_on_retry')
    expect(port.writes.length).toBe(before)
    expect(port.tagsOf('c1')).not.toContain('Mage')
  })

  test('merging when the character already has the primary tag produces no duplicate', async () => {
    const port = new MockPort()
    port.seed('c1', 'A', ['Magic', 'Mage'])
    port.scriptWrites('c1', [{ kind: 'error', error: new Error('boom') }])
    const executor = new MutationExecutor(port)
    const first = await executor.execute(
      previewOf([
        planMutation({
          characterId: 'c1',
          op: 'merge',
          tag: 'Mage',
          destTag: 'Magic',
          addedTags: ['Magic'],
          removedTags: ['Mage'],
          current: ['Magic', 'Mage'],
        }),
      ], 'merge'),
    )
    const retried = await executor.retryOne(first, first.results[0]!.mutationId)
    expect((retried.results[0] as MutationResult).state).toBe('resolved_on_retry')
    const tags = port.tagsOf('c1')
    expect(tags).toEqual(['Magic'])
    expect(tags.filter((t) => t.toLowerCase() === 'magic')).toHaveLength(1)
  })

  test('a rename that still needs work removes the source and adds the destination', async () => {
    const port = new MockPort()
    port.seed('c1', 'A', ['Mage', 'Fire'])
    port.scriptWrites('c1', [{ kind: 'error', error: new Error('boom') }])
    const executor = new MutationExecutor(port)
    const first = await executor.execute(
      previewOf([
        planMutation({
          characterId: 'c1',
          op: 'rename',
          tag: 'Mage',
          destTag: 'Magic',
          addedTags: ['Magic'],
          removedTags: ['Mage'],
          current: ['Mage', 'Fire'],
        }),
      ], 'rename'),
    )
    const retried = await executor.retryOne(first, first.results[0]!.mutationId)
    expect((retried.results[0] as MutationResult).state).toBe('resolved_on_retry')
    expect(port.tagsOf('c1').sort()).toEqual(['Fire', 'Magic'])
  })

  test('merge failure groups key by source->destination', async () => {
    const port = new MockPort()
    port.seed('c1', 'A', ['Mage'])
    port.seed('c2', 'B', ['Mage'])
    port.scriptWrites('c1', [{ kind: 'error', error: new Error('boom') }])
    port.scriptWrites('c2', [{ kind: 'error', error: new Error('boom') }])
    const executor = new MutationExecutor(port)
    const report = await executor.execute(
      previewOf([
        planMutation({ characterId: 'c1', op: 'merge', tag: 'Mage', destTag: 'Magic', addedTags: ['Magic'], removedTags: ['Mage'], current: ['Mage'] }),
        planMutation({ characterId: 'c2', op: 'merge', tag: 'Mage', destTag: 'Magic', addedTags: ['Magic'], removedTags: ['Mage'], current: ['Mage'] }),
      ], 'merge'),
    )
    const groups = groupFailures(report)
    expect(groups).toHaveLength(1)
    expect(groups[0]?.key).toBe('mage->magic')
    expect(groups[0]?.label).toBe('Mage → Magic')
  })
})

describe('end to end: a real planner preview through the executor', () => {
  /** `count` characters carrying `tags`. */
  function bulk(count: number, tags: string[]): LumiTagCharacter[] {
    return Array.from({ length: count }, (_, i) =>
      character(`c${String(i + 1).padStart(4, '0')}`, `Char ${String(i + 1).padStart(4, '0')}`, tags),
    )
  }

  test('a collapsed bulk delete writes once per character and reports one failure per character', async () => {
    const port = new MockPort()
    const set = bulk(4, ['Elf', 'Dark', 'Knight'])
    for (const c of set) port.seed(c.id, c.name, [...c.tags])
    port.scriptWrites('c0003', [{ kind: 'error', error: new Error('boom') }])

    const preview = planOperation(set, { op: 'delete', tags: ['Elf', 'Dark'] })
    expect(preview.mutations).toHaveLength(4)

    const report = await new MutationExecutor(port).execute(preview)
    // One write per character, carrying the FULL final array.
    expect(port.batchWrites).toHaveLength(1)
    expect(port.batchWrites[0]?.updates).toHaveLength(4)
    for (const update of port.batchWrites[0]?.updates ?? []) {
      expect(update.tags).toEqual(['Knight'])
    }
    expect(report.totals).toEqual({ total: 4, succeeded: 3, failed: 1, remaining: 1 })

    // The single collapsed mutation's group names BOTH removed tags.
    const groups = groupFailures(report)
    expect(groups).toHaveLength(1)
    expect(groups[0]?.key).toBe('dark+elf')
    expect(groups[0]?.label).toBe('Dark, Elf')
    expect(groups[0]?.failures.map((f) => f.characterId)).toEqual(['c0003'])

    // retryGroup resolves that key back to the right mutation, and only it.
    const retried = await new MutationExecutor(port).retryGroup(report, groups[0]!.key)
    expect(port.tagsOf('c0003')).toEqual(['Knight'])
    expect(retried.totals).toEqual({ total: 4, succeeded: 4, failed: 0, remaining: 0 })
    assertTotalsConsistent(retried)
  })

  test('a collapsed bulk merge applies every source in one write, retryable as a unit', async () => {
    const port = new MockPort()
    const set = bulk(3, ['Elf', 'Dark', 'Mage', 'Fire'])
    for (const c of set) port.seed(c.id, c.name, [...c.tags])
    port.scriptWrites('c0002', [{ kind: 'error', error: new Error('boom') }])

    const preview = planOperation(set, {
      op: 'merge',
      primary: 'Magic',
      targets: ['Elf', 'Dark', 'Mage'],
    })
    expect(preview.mutations).toHaveLength(3)

    const executor = new MutationExecutor(port)
    const report = await executor.execute(preview)
    expect(port.tagsOf('c0001')).toEqual(['Magic', 'Fire'])
    expect(report.totals).toEqual({ total: 3, succeeded: 2, failed: 1, remaining: 1 })

    const groups = groupFailures(report)
    expect(groups).toHaveLength(1)
    expect(groups[0]?.key).toBe('dark+elf+mage->magic')
    expect(groups[0]?.label).toBe('Dark, Elf, Mage → Magic')

    const writesBeforeRetry = port.writesFor('c0002').length
    const retried = await executor.retryGroup(report, groups[0]!.key)
    // All three sources folded in by ONE retry write; Fire survived.
    expect(port.writesFor('c0002').length).toBe(writesBeforeRetry + 1)
    // The retry recomputes from the freshly read record rather than replaying
    // the planned array, so Magic lands after the untouched tag — same SET.
    expect(port.tagsOf('c0002').sort()).toEqual(['Fire', 'Magic'])
    expect(retried.totals.remaining).toBe(0)
  })

  test('a character that already carries only one of the sources gets a one-tag record', async () => {
    const port = new MockPort()
    const set = [character('a', 'A', ['Elf', 'Knight']), character('b', 'B', ['Dark', 'Elf', 'Knight'])]
    for (const c of set) port.seed(c.id, c.name, [...c.tags])

    const preview = planOperation(set, { op: 'delete', tags: ['Elf', 'Dark'] })
    const groups = groupFailures(
      await new MutationExecutor(port).execute(preview).then((r) => ({ ...r, results: r.results.map((x) => ({ ...x, state: 'failed' as const })) })),
    )
    // Different source sets → different groups, so a retry never spans writes
    // that are not the same change.
    expect(groups.map((g) => g.key).sort()).toEqual(['dark+elf', 'elf'])
    expect(groups.find((g) => g.key === 'elf')?.label).toBe('Elf')
    expect(groups.find((g) => g.key === 'dark+elf')?.label).toBe('Dark, Elf')
  })
})

describe('post-state verification', () => {
  test('a write that silently drops the tags is reported as a failure', async () => {
    const port = new MockPort()
    port.seed('c1', 'A', [])
    port.scriptWrites('c1', [{ kind: 'silent-noop' }])
    const executor = new MutationExecutor(port)
    const report = await executor.execute(previewOf([planMutation({ characterId: 'c1', addedTags: ['Elf'] })]))
    expect(report.status).toBe('failed')
    expect(report.results[0]?.state).toBe('failed')
    expect(report.results[0]?.error?.message).toMatch(/did not change/i)
  })
})

describe('empty preview', () => {
  test('succeeds trivially with zero writes', async () => {
    const port = new MockPort()
    const executor = new MutationExecutor(port)
    const report = await executor.execute(previewOf([], 'delete'))
    expect(report.status).toBe('succeeded')
    expect(report.totals).toEqual({ total: 0, succeeded: 0, failed: 0, remaining: 0 })
    expect(port.writes).toHaveLength(0)
    expect(port.gets).toHaveLength(0)
    const again = await executor.retryAll(report)
    expect(again.status).toBe('succeeded')
    expect(port.writes).toHaveLength(0)
  })
})

describe('hooks', () => {
  test('onProgress and onResult fire for a normal run', async () => {
    const port = new MockPort()
    port.seed('c1', 'A', [])
    port.seed('c2', 'B', [])
    const progress: OperationReport[] = []
    const seen: MutationResult[] = []
    const executor = new MutationExecutor(port, { now: () => 1234 })
    const report = await executor.execute(
      previewOf([
        planMutation({ characterId: 'c1', addedTags: ['Elf'] }),
        planMutation({ characterId: 'c2', addedTags: ['Elf'] }),
      ]),
      {
        onProgress: (r) => progress.push(r),
        onResult: (r) => seen.push(r),
      },
    )
    expect(seen).toHaveLength(2)
    expect(progress.length).toBeGreaterThan(0)
    expect(progress.some((p) => p.status === 'running')).toBe(true)
    expect(progress.at(-1)?.status).toBe('succeeded')
    expect(report.startedAt).toBe(1234)
    expect(report.finishedAt).toBe(1234)
  })
})

// ---------------------------------------------------------------------------
// classifyError
// ---------------------------------------------------------------------------

describe('classifyError', () => {
  test('timeout → retryable and uncertain', () => {
    for (const message of [
      'Request timed out',
      'Network unreachable',
      'fetch failed',
      'The operation was aborted',
      'Socket timeout of 5000ms exceeded',
    ]) {
      const classified = classifyError(new Error(message))
      expect(classified.retryable).toBe(true)
      expect(classified.uncertain).toBe(true)
      expect(classified.code).toBe('timeout')
    }
  })

  test('permission → not retryable, not uncertain', () => {
    for (const message of ['Permission denied', 'Forbidden', 'Unauthorized', 'Permission not granted']) {
      const classified = classifyError(new Error(message))
      expect(classified.retryable).toBe(false)
      expect(classified.uncertain).toBe(false)
      expect(classified.code).toBe('forbidden')
    }
  })

  test('not found → not retryable', () => {
    for (const message of ['Character not found', 'HTTP 404', 'No such character', 'Character was deleted']) {
      const classified = classifyError(new Error(message))
      expect(classified.retryable).toBe(false)
      expect(classified.uncertain).toBe(false)
      expect(classified.code).toBe('not_found')
    }
  })

  test('anything else → retryable, not uncertain', () => {
    const classified = classifyError(new Error('Something odd happened'))
    expect(classified.retryable).toBe(true)
    expect(classified.uncertain).toBe(false)
    expect(classified.code).toBeUndefined()
  })

  test('an explicit error.code is honoured and kept', () => {
    const error = Object.assign(new Error('weird'), { code: 'backend_unavailable' })
    const classified = classifyError(error)
    expect(classified.code).toBe('backend_unavailable')
    expect(classified.retryable).toBe(true)
    expect(classified.uncertain).toBe(false)
  })

  test('a code alone can drive the classification', () => {
    const classified = classifyError(Object.assign(new Error('opaque'), { code: 'timeout' }))
    expect(classified.retryable).toBe(true)
    expect(classified.uncertain).toBe(true)
  })

  test('a thrown non-Error value is still described', () => {
    expect(classifyError('plain string failure').message).toBe('plain string failure')
    expect(classifyError(42).message).toBe('42')
    const nullish = classifyError(null)
    expect(nullish.message).toBe('Unknown error')
    expect(nullish.retryable).toBe(true)
    const obj = classifyError({ message: 'object shaped failure' })
    expect(obj.message).toBe('object shaped failure')
    expect(classifyError(undefined).message).toBe('Unknown error')
    const circular: Record<string, unknown> = {}
    circular.self = circular
    expect(classifyError(circular).message).toBe('Unknown error')
  })

  test('a thrown non-Error timeout string is still uncertain', () => {
    expect(classifyError('network timeout').uncertain).toBe(true)
  })
})

describe('messages are never stack traces', () => {
  test('an Error with a .stack is surfaced as a clean message', () => {
    const error = new Error('Write failed badly')
    expect(typeof error.stack).toBe('string')
    const classified = classifyError(error)
    expect(classified.message).toBe('Write failed badly')
    expect(classified.message).not.toContain('at ')
    expect(classified.message).not.toContain('.ts:')
  })

  test('a multi-line message with stack frames is stripped', () => {
    const error = new Error(
      'Update rejected\n    at MutationExecutor.execute (src/frontend/mutations/executor.ts:210:11)\n    at async run (/app/bundle.js:1:2)',
    )
    const classified = classifyError(error)
    expect(classified.message).toBe('Update rejected')
    expect(classified.message).not.toContain('at ')
    expect(classified.message).not.toContain('executor.ts')
  })

  test('no reported failure message contains stack-frame syntax', async () => {
    const port = new MockPort()
    port.seed('c1', 'A', [])
    port.seed('c2', 'B', [])
    port.scriptWrites('c1', [{ kind: 'error', error: new Error('kaput\n    at deep (a.js:1:1)') }])
    port.scriptWrites('c2', [{ kind: 'error', error: Object.assign(new Error('nope'), { code: 'forbidden' }) }])
    const executor = new MutationExecutor(port)
    const report = await executor.execute(
      previewOf([
        planMutation({ characterId: 'c1', addedTags: ['Elf'] }),
        planMutation({ characterId: 'c2', addedTags: ['Elf'] }),
      ]),
    )
    for (const r of report.results) {
      if (r.error === undefined) continue
      expect(r.error.message).not.toContain('at ')
      expect(r.error.message).not.toContain('.js:')
    }
  })

  test('conflict messages are readable prose, not stack frames', async () => {
    const port = new MockPort()
    port.seed('c1', 'A', ['Mage'])
    port.scriptWrites('c1', [{ kind: 'error', error: new Error('boom') }])
    const executor = new MutationExecutor(port)
    const first = await executor.execute(
      previewOf([
        planMutation({
          characterId: 'c1',
          op: 'rename',
          tag: 'Mage',
          destTag: 'Magic',
          addedTags: ['Magic'],
          removedTags: ['Mage'],
          current: ['Mage'],
        }),
      ], 'rename'),
    )
    port.server.set('c1', character('c1', 'A', []))
    const retried = await executor.retryOne(first, first.results[0]!.mutationId)
    expect(retried.results[0]?.error?.message).not.toContain('at ')
  })
})

// ---------------------------------------------------------------------------
// Report immutability
// ---------------------------------------------------------------------------

describe('returned reports are snapshots', () => {
  test('mutating a returned report does not corrupt the executor state', async () => {
    const port = new MockPort()
    port.seed('c1', 'A', [])
    port.scriptWrites('c1', [{ kind: 'error', error: new Error('boom') }])
    const executor = new MutationExecutor(port)
    const report = await executor.execute(previewOf([planMutation({ characterId: 'c1', addedTags: ['Elf'] })]))
    report.results[0]!.state = 'succeeded'
    const stored = executor.getReport(report.opId)!
    expect(stored.results[0]?.state).toBe('failed')
  })

  test('an unknown opId has no report', () => {
    const executor = new MutationExecutor(new MockPort())
    expect(executor.getReport('nope')).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// Report retention
// ---------------------------------------------------------------------------

describe('retained reports are a bounded LRU window', () => {
  /** The store's own panel cap, mirrored so the UI's reach is what is asserted. */
  const UI_REPORT_LIMIT = 20

  /**
   * Run `count` distinct single-character operations and return their opIds in
   * execution order. Distinct characters keep every opId distinct, so each one
   * occupies its own slot in the window.
   */
  async function runOperations(
    executor: MutationExecutor,
    port: MockPort,
    count: number,
  ): Promise<string[]> {
    const opIds: string[] = []
    for (let i = 0; i < count; i++) {
      const id = `c${i}`
      port.seed(id, `C${i}`, [])
      const report = await executor.execute(
        previewOf([planMutation({ characterId: id, addedTags: ['Elf'] })]),
      )
      opIds.push(report.opId)
    }
    return opIds
  }

  test('evicts once the window is exceeded, keeping the count at the limit', async () => {
    const port = new MockPort()
    const executor = new MutationExecutor(port)
    const opIds = await runOperations(executor, port, RETAINED_REPORT_LIMIT + 10)

    // Every id is now past the window, so the oldest ones must be gone...
    expect(executor.getReport(opIds[0]!)).toBeUndefined()
    expect(executor.getReport(opIds[9]!)).toBeUndefined()
    // ...and the window holds exactly RETAINED_REPORT_LIMIT reports, no more.
    const survivors = opIds.filter((id) => executor.getReport(id) !== undefined)
    expect(survivors).toHaveLength(RETAINED_REPORT_LIMIT)
  })

  test('a report read recently survives a flood that would otherwise evict it', async () => {
    const port = new MockPort()
    const executor = new MutationExecutor(port)
    const opIds = await runOperations(executor, port, RETAINED_REPORT_LIMIT)
    const oldest = opIds[0]!

    // Reading it makes it the most-recently-used entry, so it is promoted past
    // the whole rest of the window...
    expect(executor.getReport(oldest)).toBeDefined()

    // ...and a flood that would have evicted it on its first write does not.
    await runOperations(executor, port, RETAINED_REPORT_LIMIT - 1)
    expect(executor.getReport(oldest)).toBeDefined()

    // It is genuinely LRU-ordered, not simply exempt: the untouchled next-oldest
    // is what the flood evicted instead.
    expect(executor.getReport(opIds[1]!)).toBeUndefined()
  })

  test('a report still inside the failure panel\'s window is never evicted', async () => {
    const port = new MockPort()
    const executor = new MutationExecutor(port)
    // More operations than the store can show, so the panel has genuinely
    // dropped the early ones by the time the later ones are running.
    const opIds = await runOperations(executor, port, UI_REPORT_LIMIT + RETAINED_REPORT_LIMIT)

    // Exactly the opIds the store would still be holding, oldest first.
    const visible = opIds.slice(opIds.length - UI_REPORT_LIMIT)
    for (const id of visible) {
      expect(executor.getReport(id)).toBeDefined()
    }
  })

  test('runRetry against a retained report still retries it', async () => {
    const port = new MockPort()
    port.seed('c1', 'A', [])
    port.scriptWrites('c1', [{ kind: 'error', error: new Error('boom') }])
    const executor = new MutationExecutor(port)
    const report = await executor.execute(
      previewOf([planMutation({ characterId: 'c1', addedTags: ['Elf'] })]),
    )
    expect(report.totals.failed).toBe(1)

    // Fill the window past the limit: `report` is now near eviction.
    await runOperations(executor, port, RETAINED_REPORT_LIMIT + 1)

    const retried = await executor.retryOne(report, report.results[0]!.mutationId)
    expect(retried.results[0]?.state).toBe('resolved_on_retry')
    assertTotalsConsistent(retried)
    expect(executor.getReport(report.opId)?.totals.failed).toBe(0)
  })

  test('a retry on an already-evicted report falls back to the caller\'s copy', async () => {
    const port = new MockPort()
    port.seed('c1', 'A', [])
    port.scriptWrites('c1', [{ kind: 'error', error: new Error('boom') }])
    const executor = new MutationExecutor(port)
    const report = await executor.execute(
      previewOf([planMutation({ characterId: 'c1', addedTags: ['Elf'] })]),
    )

    await runOperations(executor, port, RETAINED_REPORT_LIMIT + 5)
    expect(executor.getReport(report.opId)).toBeUndefined()

    // The store always passes its own report object, so a retry is still fully
    // functional — it just cannot be silently a no-op.
    const retried = await executor.retryOne(report, report.results[0]!.mutationId)
    expect(retried.results[0]?.state).toBe('resolved_on_retry')
  })

  test('an operation still running is not evicted by the operations after it', async () => {
    const port = new MockPort()
    const executor = new MutationExecutor(port)
    port.seed('live', 'Live', [])

    let release!: () => void
    const parked = new Promise<void>((resolve) => {
      release = resolve
    })
    port.gate = { promise: parked, release }

    const live = previewOf([planMutation({ characterId: 'live', addedTags: ['Elf'] })])
    const running = executor.execute(live)
    // Let the write reach the gate so the report is genuinely unfinished.
    await Promise.resolve()
    await Promise.resolve()

    // Only the live write parks; the flood after it must run to completion.
    port.gate = null
    await runOperations(executor, port, RETAINED_REPORT_LIMIT + 2)

    // Still resident, and still the LIVE object — not replaced by a stale
    // snapshot — so a progress read or a retry racing the write sees the
    // running state rather than a finished report that never happened.
    const midFlight = executor.getReport(live.opId)
    expect(midFlight?.finishedAt).toBeUndefined()
    expect(midFlight?.status).toBe('running')

    release()
    const finished = await running
    expect(finished.status).toBe('succeeded')
    expect(executor.getReport(finished.opId)?.status).toBe('succeeded')
  })
})