import { describe, expect, test } from 'bun:test'

import type { MutationOp, OperationPreview, PlannedMutation } from '../src/frontend/mutations/planner'
import {
  buildReport,
  computeTotals,
  deriveStatus,
  failureDisplayName,
  failureGroupKey,
  failureGroupLabel,
  groupFailures,
  isFailure,
  isResolved,
  isRetryable,
  isSuccess,
  summarizeReport,
  type MutationResult,
  type MutationState,
  type OperationReport,
} from '../src/frontend/mutations/report'

let seq = 0

function planned(partial: Partial<PlannedMutation> & { characterId: string }): PlannedMutation {
  seq += 1
  return {
    mutationId: `m${seq}`,
    characterName: partial.characterId,
    op: 'assign',
    tag: 'Elf',
    sourceTags: [],
    addedTags: ['Elf'],
    removedTags: [],
    targetTags: ['Elf'],
    beforeTags: [],
    intendedChange: 'assign Elf',
    ...partial,
  }
}

function result(state: MutationState, partial: Partial<MutationResult> = {}): MutationResult {
  seq += 1
  return {
    mutationId: partial.mutationId ?? `r${seq}`,
    characterId: partial.characterId ?? `c${seq}`,
    characterName: partial.characterName ?? 'Character',
    op: partial.op ?? 'assign',
    tag: partial.tag ?? 'Elf',
    sourceTags: [],
    addedTags: [],
    removedTags: [],
    intendedChange: 'change',
    state,
    attempts: partial.attempts ?? 1,
    retryable: partial.retryable ?? false,
    uncertain: partial.uncertain ?? false,
    ...partial,
  }
}

function previewOf(mutations: PlannedMutation[], op: MutationOp = 'assign'): OperationPreview {
  return {
    opId: `op-${seq}`,
    op,
    label: op === 'delete' ? 'Delete tag Elf' : 'Assign tag Elf',
    tags: ['Elf'],
    mutations,
    skipped: [],
    affectedCharacterIds: [...new Set(mutations.map((m) => m.characterId))],
    affectedCharacterCount: new Set(mutations.map((m) => m.characterId)).size,
    changeCount: mutations.length,
  }
}

function reportOf(results: MutationResult[], overrides: Partial<OperationReport> = {}): OperationReport {
  return {
    opId: 'op-1',
    op: 'delete',
    label: 'Delete tags',
    tags: ['Elf', 'Dark'],
    startedAt: 1000,
    finishedAt: 2000,
    status: deriveStatus(results, false),
    results,
    totals: computeTotals(results),
    ...overrides,
  }
}

describe('state predicates', () => {
  test('isSuccess only for a first-attempt success', () => {
    expect(isSuccess(result('succeeded'))).toBe(true)
    expect(isSuccess(result('resolved_on_retry'))).toBe(false)
  })

  test('isResolved covers succeeded and resolved_on_retry only', () => {
    expect(isResolved(result('succeeded'))).toBe(true)
    expect(isResolved(result('resolved_on_retry'))).toBe(true)
    for (const state of ['pending', 'failed', 'retrying', 'conflict'] as const) {
      expect(isResolved(result(state))).toBe(false)
    }
  })

  test('isFailure covers the states a Retry button acts on', () => {
    expect(isFailure(result('failed'))).toBe(true)
    expect(isFailure(result('conflict'))).toBe(true)
    expect(isFailure(result('succeeded'))).toBe(false)
    expect(isFailure(result('resolved_on_retry'))).toBe(false)
    expect(isFailure(result('pending'))).toBe(false)
    expect(isFailure(result('retrying'))).toBe(false)
  })

  test('isRetryable reads the tracked flag', () => {
    expect(isRetryable(result('failed', { retryable: true }))).toBe(true)
    expect(isRetryable(result('failed', { retryable: false }))).toBe(false)
  })
})

describe('computeTotals', () => {
  test('empty result set', () => {
    expect(computeTotals([])).toEqual({ total: 0, succeeded: 0, failed: 0, remaining: 0 })
  })

  test('succeeded counts both success and retry-resolved', () => {
    const totals = computeTotals([
      result('succeeded'),
      result('resolved_on_retry'),
      result('failed'),
      result('conflict'),
      result('pending'),
    ])
    expect(totals).toEqual({ total: 5, succeeded: 2, failed: 2, remaining: 2 })
  })

  test('all six states together', () => {
    const states: MutationState[] = ['pending', 'succeeded', 'failed', 'retrying', 'resolved_on_retry', 'conflict']
    expect(computeTotals(states.map((s) => result(s)))).toEqual({
      total: 6,
      succeeded: 2,
      failed: 2,
      remaining: 2,
    })
  })

  test('failed and remaining are both the outstanding-failure count', () => {
    const totals = computeTotals([result('failed'), result('failed'), result('succeeded')])
    expect(totals.failed).toBe(2)
    expect(totals.remaining).toBe(2)
  })

  test('unresolved pending/retrying are neither succeeded nor failed', () => {
    expect(computeTotals([result('pending'), result('retrying')])).toEqual({
      total: 2,
      succeeded: 0,
      failed: 0,
      remaining: 0,
    })
  })
})

describe('deriveStatus', () => {
  test('running wins over everything', () => {
    expect(deriveStatus([result('failed')], true)).toBe('running')
    expect(deriveStatus([], true)).toBe('running')
  })

  test('empty and all-resolved → succeeded', () => {
    expect(deriveStatus([], false)).toBe('succeeded')
    expect(deriveStatus([result('succeeded'), result('resolved_on_retry')], false)).toBe('succeeded')
  })

  test('all failed → failed', () => {
    expect(deriveStatus([result('failed'), result('conflict')], false)).toBe('failed')
  })

  test('mixed successes and failures → partially_completed, never failed', () => {
    const status = deriveStatus([result('succeeded'), result('failed')], false)
    expect(status).toBe('partially_completed')
    expect(status).not.toBe('failed')
    expect(status).not.toBe('succeeded')
  })

  test('mixed retry-resolved and failure → partially_completed', () => {
    expect(deriveStatus([result('resolved_on_retry'), result('conflict')], false)).toBe(
      'partially_completed',
    )
  })

  test('any unresolved pending work → pending', () => {
    expect(deriveStatus([result('succeeded'), result('pending')], false)).toBe('pending')
    expect(deriveStatus([result('failed'), result('retrying')], false)).toBe('pending')
  })
})

describe('groupFailures', () => {
  test('ignores resolved mutations', () => {
    const report = reportOf([
      result('succeeded', { tag: 'Elf', characterId: 'c1' }),
      result('resolved_on_retry', { tag: 'Dark', characterId: 'c2' }),
    ])
    expect(groupFailures(report)).toEqual([])
  })

  test('keys a single removal by its tag key', () => {
    const report = reportOf([
      result('failed', { tag: 'Elf', characterId: 'c1' }),
      result('failed', { tag: 'Elf', characterId: 'c2' }),
    ])
    const groups = groupFailures(report)
    expect(groups).toHaveLength(1)
    expect(groups[0]?.key).toBe('elf')
    expect(groups[0]?.failures.map((f) => f.characterId).sort()).toEqual(['c1', 'c2'])
  })

  test('separates two failed removals on the SAME character', () => {
    const report = reportOf([
      result('failed', { tag: 'Elf', characterId: 'same' }),
      result('failed', { tag: 'Dark', characterId: 'same' }),
    ])
    const groups = groupFailures(report)
    expect(groups.map((g) => g.key).sort()).toEqual(['dark', 'elf'])
    expect(groups.every((g) => g.failures.length === 1)).toBe(true)
  })

  test('merge groups by source->destination with an arrow label', () => {
    const report = reportOf(
      [
        result('failed', { op: 'merge', tag: 'Mage', destTag: 'Magic', characterId: 'c1' }),
        result('failed', { op: 'merge', tag: 'mage', destTag: 'MAGIC', characterId: 'c2' }),
      ],
      { op: 'merge', tags: ['Mage', 'Magic'] },
    )
    const groups = groupFailures(report)
    expect(groups).toHaveLength(1)
    expect(groups[0]?.key).toBe('mage->magic')
    expect(groups[0]?.label).toBe('Mage → Magic')
    expect(groups[0]?.destTag).toBe('Magic')
    expect(groups[0]?.failures).toHaveLength(2)
  })

  test('a rename to a different destination is a different group', () => {
    const report = reportOf([
      result('failed', { op: 'rename', tag: 'Mage', destTag: 'Magic', characterId: 'c1' }),
      result('failed', { op: 'rename', tag: 'Mage', destTag: 'Sorcery', characterId: 'c2' }),
    ])
    expect(groupFailures(report).map((g) => g.key).sort()).toEqual(['mage->magic', 'mage->sorcery'])
  })

  test('a rename without a destination falls back to the source key', () => {
    const report = reportOf([result('failed', { op: 'rename', tag: 'Mage', characterId: 'c1' })])
    expect(groupFailures(report)[0]?.key).toBe('mage')
  })

  test('conflict mutations are grouped as failures too', () => {
    const report = reportOf([result('conflict', { tag: 'Elf', characterId: 'c1' })])
    expect(groupFailures(report).map((g) => g.key)).toEqual(['elf'])
  })

  test('a collapsed multi-source remove labels ALL its sources, not just the primary', () => {
    // One character, ONE write that removed both tags: it must not read as a
    // single-tag failure.
    const report = reportOf([
      result('failed', {
        op: 'remove',
        tag: 'Dark',
        sourceTags: ['Elf', 'Dark'],
        removedTags: ['Elf', 'Dark'],
        characterId: 'c1',
      }),
    ])
    const groups = groupFailures(report)
    expect(groups).toHaveLength(1)
    expect(groups[0]?.key).toBe('dark+elf')
    expect(groups[0]?.label).toBe('Dark, Elf')
  })

  test('the group key is the full source SET, so differing sets never merge', () => {
    const report = reportOf([
      result('failed', { op: 'remove', tag: 'Elf', sourceTags: ['Elf'], characterId: 'c1' }),
      result('failed', { op: 'remove', tag: 'Dark', sourceTags: ['Elf', 'Dark'], characterId: 'c2' }),
    ])
    // Different sets = different writes = different retry scopes.
    expect(groupFailures(report).map((g) => g.key).sort()).toEqual(['dark+elf', 'elf'])
  })

  test('characters sharing one source set collapse into a single group', () => {
    const report = reportOf([
      result('failed', { op: 'remove', tag: 'Elf', sourceTags: ['Elf', 'Dark'], characterId: 'c1' }),
      result('failed', { op: 'remove', tag: 'Dark', sourceTags: ['Dark', 'Elf'], characterId: 'c2' }),
    ])
    const groups = groupFailures(report)
    expect(groups).toHaveLength(1)
    expect(groups[0]?.failures.map((f) => f.characterId)).toEqual(['c1', 'c2'])
  })

  test('a collapsed merge group labels every source against the destination', () => {
    const report = reportOf(
      [
        result('failed', {
          op: 'merge',
          tag: 'Dark',
          destTag: 'Magic',
          sourceTags: ['Mage', 'Dark', 'Elf'],
          characterId: 'c1',
        }),
        result('failed', {
          op: 'merge',
          tag: 'Dark',
          destTag: 'Magic',
          sourceTags: ['Mage', 'Dark', 'Elf'],
          characterId: 'c2',
        }),
      ],
      { op: 'merge', tags: ['Magic', 'Mage', 'Dark', 'Elf'] },
    )
    const groups = groupFailures(report)
    expect(groups).toHaveLength(1)
    expect(groups[0]?.key).toBe('dark+elf+mage->magic')
    expect(groups[0]?.label).toBe('Dark, Elf, Mage → Magic')
    expect(groups[0]?.failures).toHaveLength(2)
  })

  test('the group key does not depend on sourceTags order or case', () => {
    const a = result('failed', { op: 'remove', tag: 'Elf', sourceTags: ['Elf', 'Dark'] })
    const b = result('failed', { op: 'remove', tag: 'elf', sourceTags: ['dark', 'ELF'] })
    expect(failureGroupKey(a)).toBe(failureGroupKey(b))
    expect(failureGroupLabel(a)).toBe('Dark, Elf')
  })

  test('an empty sourceTags falls back to the primary tag', () => {
    // The chip-removal report is hand-built and leaves sourceTags as the
    // character's full list; a result with nothing usable still groups.
    const bare = result('failed', { op: 'remove', tag: 'Elf', sourceTags: [] })
    expect(failureGroupKey(bare)).toBe('elf')
    expect(failureGroupLabel(bare)).toBe('Elf')
  })
})

describe('summarizeReport', () => {
  test('includes operation, tags and every count', () => {
    const report = reportOf([
      result('succeeded', { characterName: 'A' }),
      result('succeeded', { characterName: 'B' }),
      result('failed', { characterName: 'C' }),
    ])
    const text = summarizeReport(report)
    expect(text).toContain('Delete tags')
    expect(text).toContain('delete')
    expect(text).toContain('Elf, Dark')
    expect(text).toContain('Updates attempted: 3')
    expect(text).toContain('Succeeded: 2')
    expect(text).toContain('Failed: 1')
    expect(text).toContain('Remaining: 1')
  })

  test('is multi-line and lists failing characters', () => {
    const report = reportOf([
      result('succeeded'),
      result('failed', { tag: 'Dark', characterName: 'Lyra', characterId: 'lyra1234' }),
    ])
    const lines = summarizeReport(report).split('\n')
    expect(lines.length).toBeGreaterThan(5)
    expect(lines.some((l) => l.includes('Dark'))).toBe(true)
    expect(lines.some((l) => l.includes('Lyra'))).toBe(true)
  })

  test('a clean run has no failure section', () => {
    const report = reportOf([result('succeeded'), result('resolved_on_retry')])
    expect(summarizeReport(report)).not.toContain('Failed changes')
  })
})

describe('failureDisplayName', () => {
  test('disambiguates same-named characters with a short id', () => {
    const a = result('failed', { characterName: 'Elf', characterId: 'a1b2c3d4' })
    const b = result('failed', { characterName: 'Elf', characterId: 'f9e8d7c6' })
    expect(failureDisplayName(a)).toBe('Elf (a1b2…)')
    expect(failureDisplayName(b)).toBe('Elf (f9e8…)')
    expect(failureDisplayName(a)).not.toBe(failureDisplayName(b))
  })

  test('falls back for a nameless character', () => {
    expect(failureDisplayName(result('failed', { characterName: '', characterId: 'abcd' }))).toBe(
      '(unnamed) (abcd…)',
    )
    expect(failureDisplayName(result('failed', { characterName: 'X', characterId: '' }))).toBe('X')
  })
})

describe('buildReport', () => {
  test('wires preview metadata and derives totals and status', () => {
    const preview = previewOf([planned({ characterId: 'c1' }), planned({ characterId: 'c2' })])
    const report = buildReport(preview, [result('succeeded'), result('failed')], 10, 20)
    expect(report.opId).toBe(preview.opId)
    expect(report.op).toBe(preview.op)
    expect(report.label).toBe(preview.label)
    expect(report.tags).toEqual(preview.tags)
    expect(report.startedAt).toBe(10)
    expect(report.finishedAt).toBe(20)
    expect(report.status).toBe('partially_completed')
    expect(report.totals).toEqual({ total: 2, succeeded: 1, failed: 1, remaining: 1 })
  })

  test('an unfinished build is running', () => {
    const preview = previewOf([planned({ characterId: 'c1' })])
    const report = buildReport(preview, [result('succeeded')], 10)
    expect(report.status).toBe('running')
    expect(report.finishedAt).toBeUndefined()
  })

  test('copies the tag list so later preview edits cannot mutate the report', () => {
    const preview = previewOf([planned({ characterId: 'c1' })])
    const report = buildReport(preview, [], 1, 2)
    preview.tags.push('Injected')
    expect(report.tags).toEqual(['Elf'])
  })
})

describe('totals stay a pure function of results', () => {
  test('a fresh recount always matches the stored totals', () => {
    const report = reportOf([
      result('succeeded'),
      result('resolved_on_retry'),
      result('failed'),
      result('conflict'),
    ])
    expect(report.totals).toEqual(computeTotals(report.results))
    expect(groupFailures(report).reduce((n, g) => n + g.failures.length, 0)).toBe(
      report.totals.remaining,
    )
  })
})