/**
 * Execution reporting for tag mutations.
 *
 * Everything here is PURE: a report is a plain data structure and every
 * count/status on it is DERIVED from `results` by the functions in this file.
 * UI components never increment counters — they read `totals`/`status`, so a
 * bug can never leave the numbers disagreeing with the underlying results.
 */

import type { MutationOp, OperationPreview } from './planner'
import { tagKey } from '../tag-index'

/**
 * The classification of a thrown value, derived purely from it.
 *
 * Defined here next to `MutationErrorInfo`, which it becomes, so the whole
 * error vocabulary lives in exactly one place.
 */
export interface ClassifiedError {
  message: string
  code?: string
  retryable: boolean
  uncertain: boolean
}

/** Lifecycle of a single tag change on a single character. */
export type MutationState =
  | 'pending'
  | 'succeeded'
  | 'failed'
  | 'retrying'
  | 'resolved_on_retry'
  | 'conflict'

/**
 * A UI-safe failure description.
 *
 * `message` is ALWAYS a human sentence. A raw stack trace is never surfaced:
 * it leaks internals and is unreadable in a dialog.
 */
export interface MutationErrorInfo {
  /** Human-readable, UI-safe. NEVER a stack trace. */
  message: string
  /** Machine code when known, e.g. 'timeout' | 'forbidden' | 'not_found' | 'backend_unavailable'. */
  code?: string
}

/** The tracked outcome of one planned mutation. */
export interface MutationResult {
  mutationId: string
  characterId: string
  characterName: string
  op: MutationOp
  tag: string
  destTag?: string
  sourceTags: string[]
  addedTags: string[]
  removedTags: string[]
  intendedChange: string
  state: MutationState
  attempts: number
  error?: MutationErrorInfo
  /** Whether a retry could plausibly succeed. */
  retryable: boolean
  /**
   * True when the write outcome is UNKNOWN — e.g. a network timeout, where the
   * server may have applied the change before the response was lost.
   */
  uncertain: boolean
}

/** Operation-level status shown in the UI. */
export type OperationStatus =
  | 'pending'
  | 'running'
  | 'succeeded'
  | 'partially_completed'
  | 'failed'

export interface OperationTotals {
  total: number
  succeeded: number
  failed: number
  remaining: number
}

/** Everything known about one executed (or executing) operation. */
export interface OperationReport {
  opId: string
  op: MutationOp
  label: string
  tags: string[]
  startedAt: number
  finishedAt?: number
  status: OperationStatus
  results: MutationResult[]
  /** DERIVED — never incremented ad hoc by UI components. */
  totals: OperationTotals
}

/** A failed source→destination tag change, with every character that failed it. */
export interface FailureGroup {
  /** Stable group key: `${tagKey(tag)}->${tagKey(destTag)}` for rename/merge, else `tagKey(tag)`. */
  key: string
  op: MutationOp
  tag: string
  destTag?: string
  /** UI label, e.g. 'Mage → Magic'. */
  label: string
  failures: MutationResult[]
}

/** The states that are still outstanding failures a Retry button can act on. */
function isUnresolvedFailure(state: MutationState): boolean {
  return state === 'failed' || state === 'conflict'
}

/** The states that mean "this change is applied and needs no more work". */
function isResolvedState(state: MutationState): boolean {
  return state === 'succeeded' || state === 'resolved_on_retry'
}

/** True while the mutation still has an outstanding failure. */
export function isFailure(r: MutationResult): boolean {
  return isUnresolvedFailure(r.state)
}

/** True once the mutation reached a terminal good state. */
export function isResolved(r: MutationResult): boolean {
  return isResolvedState(r.state)
}

/** True when the mutation succeeded on its first attempt. */
export function isSuccess(r: MutationResult): boolean {
  return r.state === 'succeeded'
}

/** True when the mutation succeeded on a later attempt. */
export function isResolvedOnRetry(r: MutationResult): boolean {
  return r.state === 'resolved_on_retry'
}

/** True when a retry could plausibly succeed (mirrors `MutationResult.retryable`). */
export function isRetryable(r: MutationResult): boolean {
  return r.retryable === true
}

/**
 * Recount everything from the results.
 *
 * `remaining` is the still-unresolved failure count — i.e. exactly what a
 * "Retry failed" button would act on.
 */
export function computeTotals(results: readonly MutationResult[]): OperationTotals {
  let succeeded = 0
  let failed = 0
  for (const r of results) {
    if (isResolvedState(r.state)) succeeded++
    else if (isUnresolvedFailure(r.state)) failed++
  }
  return {
    total: results.length,
    succeeded,
    failed,
    remaining: failed,
  }
}

/**
 * Derive the operation status from the results.
 *
 * A partially successful operation is reported as `partially_completed` and
 * NEVER as plain `succeeded` or plain `failed` — collapsing the two is how a
 * user ends up believing an edit was applied when it was not.
 */
export function deriveStatus(
  results: readonly MutationResult[],
  running: boolean,
): OperationStatus {
  if (running) return 'running'
  if (results.length === 0) return 'succeeded'

  const totals = computeTotals(results)
  const outstanding = results.length - totals.succeeded - totals.failed
  if (outstanding > 0) return 'pending'
  if (totals.failed === 0) return 'succeeded'
  if (totals.succeeded === 0) return 'failed'
  return 'partially_completed'
}

/** Assemble a report from a preview plus the executed results. */
export function buildReport(
  preview: OperationPreview,
  results: MutationResult[],
  startedAt: number,
  finishedAt?: number,
): OperationReport {
  return {
    opId: preview.opId,
    op: preview.op,
    label: preview.label,
    tags: [...preview.tags],
    startedAt,
    ...(finishedAt === undefined ? {} : { finishedAt }),
    status: deriveStatus(results, finishedAt === undefined),
    results,
    totals: computeTotals(results),
  }
}

/** The stable grouping key for a failed tag change. */
export function failureGroupKey(r: MutationResult): string {
  const source = tagKey(r.tag)
  if ((r.op === 'rename' || r.op === 'merge') && typeof r.destTag === 'string') {
    return `${source}->${tagKey(r.destTag)}`
  }
  return source
}

/** The human label for a failed tag change. */
export function failureGroupLabel(r: MutationResult): string {
  if ((r.op === 'rename' || r.op === 'merge') && typeof r.destTag === 'string' && r.destTag !== '') {
    return `${r.tag} → ${r.destTag}`
  }
  return r.tag
}

/**
 * Group still-unresolved failures by the SPECIFIC tag change.
 *
 * Keying by character would be useless here: in a bulk delete the same
 * character can fail both its `Elf` and its `Dark` removal, and a
 * character-level group would hide which tag change actually needs retrying.
 */
export function groupFailures(report: OperationReport): FailureGroup[] {
  const byKey = new Map<string, FailureGroup>()
  for (const r of report.results) {
    if (!isUnresolvedFailure(r.state)) continue
    const key = failureGroupKey(r)
    let group = byKey.get(key)
    if (!group) {
      group = {
        key,
        op: r.op,
        tag: r.tag,
        ...(typeof r.destTag === 'string' ? { destTag: r.destTag } : {}),
        label: failureGroupLabel(r),
        failures: [],
      }
      byKey.set(key, group)
    }
    group.failures.push(r)
  }
  return [...byKey.values()]
}

/** A readable, multi-line summary of what an operation actually did. */
export function summarizeReport(report: OperationReport): string {
  const totals = computeTotals(report.results)
  const lines: string[] = []
  lines.push(`${report.label} (${report.op})`)
  if (report.tags.length > 0) lines.push(`Tags: ${report.tags.join(', ')}`)
  lines.push(`Updates attempted: ${totals.total}`)
  lines.push(`Succeeded: ${totals.succeeded}`)
  lines.push(`Failed: ${totals.failed}`)
  lines.push(`Remaining: ${totals.remaining}`)

  const groups = groupFailures(report)
  if (groups.length > 0) {
    lines.push('')
    lines.push('Failed changes:')
    for (const group of groups) {
      lines.push(
        `- ${group.label}: ${group.failures.length} failed — ${group.failures
          .map(failureDisplayName)
          .join(', ')}`,
      )
    }
  }
  return lines.join('\n')
}

/**
 * A character name that stays distinguishable in a failure list.
 *
 * Two characters may legitimately share a display name, so a bare name is
 * ambiguous in a report that lists many failures. The short id suffix makes
 * every row uniquely identifiable without shouting the whole id.
 */
export function failureDisplayName(r: MutationResult): string {
  const name = typeof r.characterName === 'string' && r.characterName !== '' ? r.characterName : '(unnamed)'
  const id = typeof r.characterId === 'string' ? r.characterId : ''
  if (id === '') return name
  return `${name} (${id.slice(0, 4)}…)`
}