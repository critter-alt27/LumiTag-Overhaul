/**
 * Mutation executor: turns a reviewed preview into real writes, tracks every
 * change independently, and makes retries SAFE.
 *
 * Two invariants drive the whole design:
 *
 *  1. **One write per character per attempt.** All of a character's planned
 *     mutations share one intended final tag array, so they collapse into a
 *     single `updateTags` call. Only the tag ARRAY is sent — never a stale
 *     full-character snapshot — so a write can never clobber unrelated fields.
 *
 *  2. **Never replay a stale snapshot.** Every retry re-reads the character and
 *     recomputes the intended change against the CURRENT tags. A user edit
 *     made between attempts survives, and a write that actually landed before
 *     a timeout is detected instead of being applied twice.
 */

import type { CharacterMutationPort } from '../repository'
import type { LumiTagCharacter } from '../../shared/types'
import { mapWithConcurrency } from '../concurrency'
import { dedupeTagNames, tagKey } from '../tag-index'
import type { MutationOp, OperationPreview, PlannedMutation } from './planner'
import {
  computeTotals,
  deriveStatus,
  groupFailures,
  type ClassifiedError,
  type MutationResult,
  type OperationReport,
} from './report'

/** Default number of simultaneous character writes. */
export const DEFAULT_WRITE_CONCURRENCY = 4

export interface ExecutorOptions {
  /** Max simultaneous character writes. Default 4. */
  concurrency?: number
  /** Injectable clock for deterministic tests. */
  now?: () => number
}

export interface ExecuteHooks {
  onProgress?: (report: OperationReport) => void
  onResult?: (result: MutationResult) => void
}

const TIMEOUT_PATTERN = /timeout|timed out|network|fetch failed|aborted/i
const FORBIDDEN_PATTERN = /permission|forbidden|unauthorized|not granted/i
const NOT_FOUND_PATTERN = /not found|404|no such character|deleted/i

/**
 * Turn an arbitrary thrown value into a UI-safe, machine-classified error.
 *
 * Never surfaces a stack trace: only the human line is kept, stack-frame
 * syntax (`at fn (file:1:1)`) and `file:line:col` noise are stripped, and
 * non-Error throws (`throw 'boom'`, `throw 42`) are still described.
 *
 * Retryability comes from the KIND of failure, not the message:
 * - timeout / network → retryable AND **uncertain** (the write may have landed)
 * - permission / forbidden → never retryable
 * - not found / deleted → never retryable
 * - anything else → retryable
 */
export function classifyError(error: unknown): ClassifiedError {
  const rawCode = readStringField(error, 'code')
  const message = sanitizeMessage(extractRawMessage(error))
  const code = rawCode
  const haystack = code !== undefined ? `${code} ${message}` : message

  // Order matters: a specific non-retryable reason wins over a generic one.
  if (FORBIDDEN_PATTERN.test(haystack)) {
    return { message, code: code ?? 'forbidden', retryable: false, uncertain: false }
  }
  if (NOT_FOUND_PATTERN.test(haystack)) {
    return { message, code: code ?? 'not_found', retryable: false, uncertain: false }
  }
  if (TIMEOUT_PATTERN.test(haystack)) {
    // The server may have applied the write before the response was lost.
    return { message, code: code ?? 'timeout', retryable: true, uncertain: true }
  }
  return { message, code, retryable: true, uncertain: false }
}

function readStringField(error: unknown, field: 'code' | 'message'): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined
  const value = (error as Record<string, unknown>)[field]
  return typeof value === 'string' && value !== '' ? value : undefined
}

function extractRawMessage(error: unknown): string {
  if (typeof error === 'string') return error
  if (error instanceof Error) return error.message
  const fromField = readStringField(error, 'message')
  if (fromField !== undefined) return fromField
  if (error === null) return 'Unknown error'
  if (typeof error === 'number' || typeof error === 'boolean') return String(error)
  try {
    const json = JSON.stringify(error)
    if (typeof json === 'string' && json !== '' && json !== '{}') return json
  } catch {
    // Circular / exotic values fall through to the generic message below.
  }
  return 'Unknown error'
}

/** Keep the human part of a message and drop every trace of a stack. */
function sanitizeMessage(raw: string): string {
  let text = (raw ?? '').trim()
  if (text === '') return 'Unknown error'
  text = text
    .split(/\r?\n/)
    .filter((line) => !/^\s*at\s/.test(line))
    .join(' ')
    .replace(/\s+at\s+[^\s(]+(?:\s+\([^)]*\))?/g, '')
    .replace(/[\w./\\-]+:\d+:\d+/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim()
  return text === '' ? 'Unknown error' : text
}

function hasTag(tags: readonly string[], tag: string): boolean {
  const key = tagKey(tag)
  return tags.some((t) => tagKey(t) === key)
}

/** True when the tag array already satisfies a mutation's intent. */
export function intentSatisfied(tags: readonly string[], m: PlannedMutation): boolean {
  for (const added of m.addedTags) if (!hasTag(tags, added)) return false
  for (const removed of m.removedTags) if (hasTag(tags, removed)) return false
  return true
}

/**
 * Apply a mutation's intent to the CURRENT tags.
 *
 * Recomputation (rather than replaying `targetTags`) is what preserves tags the
 * user added or a concurrent edit introduced after the original attempt.
 */
export function applyIntent(
  current: readonly string[],
  added: readonly string[],
  removed: readonly string[],
): string[] {
  const removeKeys = new Set(removed.map(tagKey))
  const out = dedupeTagNames(current.filter((t) => !removeKeys.has(tagKey(t))))
  const present = new Set(out.map(tagKey))
  for (const tag of added) {
    const key = tagKey(tag)
    if (present.has(key)) continue
    present.add(key)
    out.push(tag)
  }
  return dedupeTagNames(out)
}

function cloneResult(r: MutationResult): MutationResult {
  return {
    ...r,
    sourceTags: [...r.sourceTags],
    addedTags: [...r.addedTags],
    removedTags: [...r.removedTags],
    ...(r.error === undefined ? {} : { error: { ...r.error } }),
  }
}

function cloneResults(results: readonly MutationResult[]): MutationResult[] {
  return results.map(cloneResult)
}

function snapshot(report: OperationReport, running: boolean): OperationReport {
  return {
    ...report,
    results: cloneResults(report.results),
    totals: computeTotals(report.results),
    status: deriveStatus(report.results, running),
  }
}

function sameTagSet(a: readonly string[], b: readonly string[]): boolean {
  const left = new Set(dedupeTagNames(a).map(tagKey))
  const right = new Set(dedupeTagNames(b).map(tagKey))
  if (left.size !== right.size) return false
  for (const key of left) if (!right.has(key)) return false
  return true
}

function isRenameLike(op: MutationOp): boolean {
  return op === 'rename' || op === 'merge'
}

function findResult(report: OperationReport, mutationId: string): MutationResult | undefined {
  return report.results.find((r) => r.mutationId === mutationId)
}

/**
 * Copy a retry's outcome onto another result object.
 *
 * A concurrent duplicate retry must report the SAME outcome as the attempt it
 * joined, but each caller owns a separate snapshot, so the fields are copied
 * rather than the reference shared.
 */
function copyState(target: MutationResult, source: MutationResult): void {
  target.state = source.state
  target.attempts = source.attempts
  target.retryable = source.retryable
  target.uncertain = source.uncertain
  target.error = source.error === undefined ? undefined : { ...source.error }
}

/** Tracks in-flight retries so a duplicate retry can never double-apply a write. */
export class MutationExecutor {
  private readonly port: CharacterMutationPort
  private readonly concurrency: number
  private readonly now: () => number
  private readonly reports = new Map<string, OperationReport>()
  /**
   * In-flight retries, keyed by mutationId. The value is the shared promise
   * for that attempt: a duplicate retry AWAITS it and adopts its outcome
   * instead of starting a second, overlapping write.
   */
  private readonly inFlight = new Map<string, Promise<MutationResult>>()

  constructor(port: CharacterMutationPort, options?: ExecutorOptions) {
    this.port = port
    const limit = options?.concurrency
    this.concurrency =
      typeof limit === 'number' && Number.isFinite(limit) && Math.floor(limit) >= 1
        ? Math.floor(limit)
        : DEFAULT_WRITE_CONCURRENCY
    this.now = typeof options?.now === 'function' ? options.now : () => Date.now()
  }

  /** Execute a reviewed preview: one write per character, results per mutation. */
  async execute(preview: OperationPreview, hooks?: ExecuteHooks): Promise<OperationReport> {
    const startedAt = this.now()
    const live: OperationReport = {
      opId: preview.opId,
      op: preview.op,
      label: preview.label,
      tags: [...preview.tags],
      startedAt,
      status: 'running',
      results: preview.mutations.map((m) => this.pendingResult(m)),
      totals: computeTotals([]),
    }
    live.totals = computeTotals(live.results)
    this.reports.set(preview.opId, live)

    const byCharacter = new Map<string, PlannedMutation[]>()
    for (const m of preview.mutations) {
      const list = byCharacter.get(m.characterId)
      if (list) list.push(m)
      else byCharacter.set(m.characterId, [m])
    }

    const progress = (): void => {
      live.totals = computeTotals(live.results)
      live.status = deriveStatus(live.results, true)
      hooks?.onProgress?.(snapshot(live, true))
    }

    await mapWithConcurrency([...byCharacter.entries()], this.concurrency, async ([id, muts]) => {
      // Defensive invariant: the planner guarantees ONE intended final tag
      // array per character. If it is ever violated we refuse to guess which
      // one the user meant, and report a conflict instead of writing.
      const first = muts[0] as PlannedMutation
      if (!muts.every((m) => sameTagSet(m.targetTags, first.targetTags))) {
        for (const m of muts) {
          const result = findResult(live, m.mutationId)
          if (result) {
            result.state = 'conflict'
            result.retryable = false
            result.error = {
              message:
                'Planned changes for this character disagree on the final tag set, so nothing was written.',
              code: 'conflict',
            }
          }
        }
        progress()
        return
      }

      const tags = dedupeTagNames(first.targetTags)
      for (const m of muts) {
        const result = findResult(live, m.mutationId)
        if (result) result.attempts += 1
      }
      try {
        // ONLY the tag array is sent — never a full-character snapshot.
        const updated = await this.port.updateTags(id, tags)
        const post = Array.isArray(updated?.tags) ? updated.tags : tags
        this.verifyWrite(live, muts, post)
      } catch (error) {
        // One write, but EVERY mutation of that character failed with it, so
        // the report can still name which tag change failed.
        const classified = classifyError(error)
        for (const m of muts) {
          const result = findResult(live, m.mutationId)
          if (result) this.markFailure(result, classified)
        }
      }
      for (const m of muts) {
        const result = findResult(live, m.mutationId)
        if (result) hooks?.onResult?.(cloneResult(result))
      }
      progress()
    })

    live.finishedAt = this.now()
    live.status = deriveStatus(live.results, false)
    live.totals = computeTotals(live.results)
    const report = snapshot(live, false)
    // Store a SEPARATE snapshot so a caller mutating what it got back can
    // never corrupt the executor's own state.
    this.reports.set(preview.opId, snapshot(live, false))
    hooks?.onProgress?.(report)
    return report
  }

  /** Retry exactly one failed mutation. */
  retryOne(report: OperationReport, mutationId: string): Promise<OperationReport> {
    return this.runRetry(report, [mutationId])
  }

  /** Retry every remaining failure for ONE specific tag change (groupKey from groupFailures). */
  retryGroup(report: OperationReport, groupKey: string): Promise<OperationReport> {
    const group = groupFailures(report).find((g) => g.key === groupKey)
    const ids = group ? group.failures.map((f) => f.mutationId) : []
    return this.runRetry(report, ids)
  }

  /** Retry every remaining failure for the whole operation. */
  retryAll(report: OperationReport): Promise<OperationReport> {
    const ids = report.results
      .filter((r) => r.state === 'failed' || r.state === 'conflict')
      .map((r) => r.mutationId)
    return this.runRetry(report, ids)
  }

  getReport(opId: string): OperationReport | undefined {
    const stored = this.reports.get(opId)
    return stored === undefined ? undefined : snapshot(stored, stored.finishedAt === undefined)
  }

  listReports(): OperationReport[] {
    return [...this.reports.values()].map((r) => snapshot(r, r.finishedAt === undefined))
  }

  /** True when this exact mutation currently has a retry in flight. */
  isRetrying(report: OperationReport, mutationId: string): boolean {
    void report
    return this.inFlight.has(mutationId)
  }

  /**
   * The safe-retry core shared by retryOne / retryGroup / retryAll.
   *
   * Each targeted mutation is re-fetched, re-evaluated against the CURRENT
   * record, and only then rewritten. Nothing is ever replayed from
   * `beforeTags`.
   */
  private async runRetry(
    report: OperationReport,
    mutationIds: readonly string[],
  ): Promise<OperationReport> {
    const base = this.reports.get(report.opId) ?? report
    const working: OperationReport = {
      ...base,
      results: cloneResults(base.results),
      finishedAt: undefined,
    }
    working.status = deriveStatus(working.results, true)
    working.totals = computeTotals(working.results)

    const targets = new Set<string>()
    for (const id of mutationIds) {
      const r = findResult(working, id)
      // Already resolved, or unknown → no-op. A retry must never re-apply a
      // change that is already applied.
      if (!r) continue
      if (r.state !== 'failed' && r.state !== 'conflict') continue
      targets.add(id)
    }

    // One pass per character keeps a character's mutations strictly ordered,
    // so a later one always observes the earlier one's write.
    const byCharacter = new Map<string, string[]>()
    for (const id of targets) {
      const r = findResult(working, id) as MutationResult
      const list = byCharacter.get(r.characterId)
      if (list) list.push(id)
      else byCharacter.set(r.characterId, [id])
    }

    await mapWithConcurrency([...byCharacter.entries()], this.concurrency, async ([, ids]) => {
      for (const id of ids) {
        const mine = findResult(working, id) as MutationResult

        // Duplicate retry: an attempt for this exact mutation is already
        // running. Starting a second one could double-apply the write, so we
        // adopt the outcome of the attempt already in flight.
        const existing = this.inFlight.get(id)
        if (existing !== undefined) {
          const outcome = await existing
          copyState(mine, outcome)
          continue
        }

        const attempt = this.retryOnce(mine)
        this.inFlight.set(id, attempt)
        try {
          copyState(mine, await attempt)
        } finally {
          this.inFlight.delete(id)
        }
      }
    })

    working.finishedAt = this.now()
    working.status = deriveStatus(working.results, false)
    working.totals = computeTotals(working.results)
    const final = snapshot(working, false)
    this.reports.set(working.opId, snapshot(working, false))
    return final
  }

  private async retryOnce(result: MutationResult): Promise<MutationResult> {
    const planned = toPlanned(result)
    result.state = 'retrying'
    result.attempts += 1
    result.uncertain = false

    let current: LumiTagCharacter | null
    try {
      current = await this.port.getCharacter(result.characterId)
    } catch (error) {
      this.markFailure(result, classifyError(error))
      return result
    }

    if (current === null) {
      result.state = 'conflict'
      result.retryable = false
      result.uncertain = false
      result.error = {
        message:
          'This character is no longer accessible — it may have been deleted, so nothing was changed.',
        code: 'not_found',
      }
      return result
    }

    const currentTags = Array.isArray(current.tags) ? current.tags : []

    // Already applied — possibly by the original write whose response was
    // lost. Recognising this is what makes an ambiguous timeout safe.
    if (intentSatisfied(currentTags, planned)) {
      result.state = 'resolved_on_retry'
      result.retryable = false
      result.uncertain = false
      result.error = undefined
      return result
    }

    // Rename/merge ambiguity: neither the destination nor the source is
    // present, so we cannot know whether the user deliberately removed the
    // tag elsewhere. Never reintroduce a source tag that is already gone.
    if (
      isRenameLike(result.op) &&
      typeof result.destTag === 'string' &&
      result.destTag !== '' &&
      !hasTag(currentTags, result.destTag) &&
      !hasTag(currentTags, result.tag)
    ) {
      result.state = 'conflict'
      result.retryable = false
      result.uncertain = false
      result.error = {
        message: `"${result.tag}" is already gone and "${result.destTag}" is missing, so this change cannot be applied automatically.`,
        code: 'conflict',
      }
      return result
    }

    const next = applyIntent(currentTags, result.addedTags, result.removedTags)
    try {
      const updated = await this.port.updateTags(result.characterId, next)
      const post = Array.isArray(updated?.tags) ? updated.tags : next
      if (intentSatisfied(post, planned)) {
        result.state = 'resolved_on_retry'
        result.retryable = false
        result.uncertain = false
        result.error = undefined
      } else {
        result.state = 'failed'
        result.retryable = true
        result.uncertain = false
        result.error = {
          message: 'The update was saved but the tags did not change as intended.',
          code: 'unverified',
        }
      }
    } catch (error) {
      this.markFailure(result, classifyError(error))
    }
    return result
  }

  /** Confirm the returned record actually satisfies every mutation's intent. */
  private verifyWrite(
    report: OperationReport,
    muts: readonly PlannedMutation[],
    postTags: readonly string[],
  ): void {
    for (const m of muts) {
      const result = findResult(report, m.mutationId)
      if (result === undefined) continue
      if (intentSatisfied(postTags, m)) {
        result.state = 'succeeded'
        result.retryable = false
        result.uncertain = false
        result.error = undefined
      } else {
        result.state = 'failed'
        result.retryable = true
        result.uncertain = false
        result.error = {
          message: 'The update was saved but the tags did not change as intended.',
          code: 'unverified',
        }
      }
    }
  }

  private pendingResult(m: PlannedMutation): MutationResult {
    return {
      mutationId: m.mutationId,
      characterId: m.characterId,
      characterName: m.characterName,
      op: m.op,
      tag: m.tag,
      ...(m.destTag === undefined ? {} : { destTag: m.destTag }),
      sourceTags: [...m.sourceTags],
      addedTags: [...m.addedTags],
      removedTags: [...m.removedTags],
      intendedChange: m.intendedChange,
      state: 'pending',
      attempts: 0,
      retryable: false,
      uncertain: false,
    }
  }

  private markFailure(result: MutationResult, classified: ClassifiedError): void {
    result.state = 'failed'
    result.retryable = classified.retryable
    result.uncertain = classified.uncertain
    result.error = {
      message: classified.message,
      ...(classified.code === undefined ? {} : { code: classified.code }),
    }
  }
}

/** Rebuild the planner-shaped view a retry needs from a tracked result. */
function toPlanned(result: MutationResult): PlannedMutation {
  return {
    mutationId: result.mutationId,
    characterId: result.characterId,
    characterName: result.characterName,
    op: result.op,
    tag: result.tag,
    ...(result.destTag === undefined ? {} : { destTag: result.destTag }),
    sourceTags: result.sourceTags,
    addedTags: result.addedTags,
    removedTags: result.removedTags,
    // Deliberately NOT the stale beforeTags/targetTags: a retry recomputes
    // from the freshly fetched record instead of replaying a snapshot.
    targetTags: [],
    beforeTags: [],
    intendedChange: result.intendedChange,
  }
}