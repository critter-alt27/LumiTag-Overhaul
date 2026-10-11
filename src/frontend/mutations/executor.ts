/**
 * Mutation executor: turns a reviewed preview into real writes, tracks every
 * change independently, and makes retries SAFE.
 *
 * Two invariants drive the whole design:
 *
 *  1. **One write per character per attempt.** A character produces exactly ONE
 *     planned mutation carrying its complete intended final tag array, and that
 *     array — never a stale full-character snapshot — is what is sent. A write
 *     can therefore never clobber unrelated fields. The whole operation's
 *     writes travel in ONE `updateTagsBatch` call: a round trip per character
 *     is what exhausted the Termux/WebView host on a large bulk edit.
 *
 *  2. **Never replay a stale snapshot.** Every retry re-reads the character and
 *     recomputes the intended change against the CURRENT tags. A user edit
 *     made between attempts survives, and a write that actually landed before
 *     a timeout is detected instead of being applied twice.
 *
 *  3. **Retained reports are a bounded window, never the whole session.**
 *     {@link RETAINED_REPORT_LIMIT} is the executor's LRU ceiling; nothing else
 *     may let the retained set grow past it. A report is evicted ONLY once the
 *     failure panel has had no way to reference it for a whole panel-window, so
 *     retention is a memory bound and never a visibility change.
 */

import type { CharacterMutationPort } from '../repository'
import type { LumiTagCharacter } from '../../shared/types'
import type { BatchFailure } from '../../shared/protocol'
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

/** Default number of simultaneous character writes during a retry. */
export const DEFAULT_WRITE_CONCURRENCY = 4

/**
 * How many finished operation reports stay resident in this executor.
 *
 * The failure panel is what the only two readers — `getReport()` and
 * `runRetry()` — exist to serve, and the store already caps what the panel can
 * show at `REPORT_LIMIT = 20` (`store.ts`), trimming from the OLDEST end.
 * Anything the panel can still reference is therefore among the last 20
 * completed operations.
 *
 * 32 rather than 20: `execute()` records each operation TWICE (a live entry at
 * start, a snapshot at the end), so executor recency and store recency drift by
 * one, and `runRetry` re-inserts an OLD opId — moving it to the front of the
 * LRU while the store keeps it in place. A margin of one full panel-window over
 * the store's own 20 makes eviction unreachable for anything the panel holds,
 * while still capping the session's report memory at a small constant instead of
 * letting every bulk edit's `results` array accumulate for the extension's life.
 */
export const RETAINED_REPORT_LIMIT = 32

export interface ExecutorOptions {
  /**
   * Max simultaneous character writes during a RETRY. Default 4.
   *
   * `execute()` no longer consults it: a bulk edit is one batched write, so
   * there is nothing left to fan out. Retries stay per-character on purpose —
   * each one re-reads a single record before deciding what to write — and that
   * is where the cap still does work.
   */
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

/**
 * Classify a batch reply's per-item failure.
 *
 * The backend already did the classification work on its side of the boundary,
 * where it had the real host error, so its `code`/`retryable` are taken
 * verbatim — re-deriving them here from the message text alone would lose the
 * one signal the frontend cannot compute for itself.
 *
 * `uncertain` is still derived, and for the same reason the single-character
 * path derives it: a transient host failure may have written the tags before
 * it reported the error, so the write's outcome is genuinely unknown and the
 * safe retry must re-read rather than assume.
 */
function classifyBatchFailure(failure: BatchFailure): ClassifiedError {
  const message = sanitizeMessage(failure.message)
  return {
    message,
    code: failure.code,
    retryable: failure.retryable,
    uncertain: TIMEOUT_PATTERN.test(`${failure.code} ${message}`),
  }
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

/** `mutationId` → its tracked result, for the whole of one operation. */
export type ResultIndex = ReadonlyMap<string, MutationResult>

/**
 * Index a result list by `mutationId`.
 *
 * Every write in an operation is looked up several times — once to bump its
 * attempt, once to record its outcome, once to hand it to `onResult` — so a
 * linear scan made the executor quadratic: a 300-character bulk edit spent
 * ~90,000 string comparisons doing bookkeeping it could have done in one pass.
 *
 * `mutationId` is unique within an operation, but a hand-built report is a
 * public input, so a duplicate id keeps the FIRST occurrence. That is what
 * `Array.prototype.find` returned, and a lookup that changed which record it
 * resolved to would silently retarget a write.
 *
 * The index holds REFERENCES to the result objects and is therefore valid for
 * as long as the array is only ever mutated in place: results change state
 * during an operation, and an index rebuilt to follow that would cost a pass
 * per lookup, which is what it exists to avoid.
 */
export function indexResults(results: readonly MutationResult[]): ResultIndex {
  const index = new Map<string, MutationResult>()
  for (const r of results) {
    if (!index.has(r.mutationId)) index.set(r.mutationId, r)
  }
  return index
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

  /**
   * Execute a reviewed preview: one batched write, results per mutation.
   *
   * Every non-conflicting character goes out in a single `updateTagsBatch`
   * request. Each written character is then announced through `onResult`
   * individually, so the UI's per-item reporting is unchanged by the batching;
   * a character whose planned changes disagree is announced through
   * `onProgress` only, as it was before batching, because nothing was attempted
   * for it.
   */
  async execute(preview: OperationPreview, hooks?: ExecuteHooks): Promise<OperationReport> {
    const startedAt = this.now()
    const results = preview.mutations.map((m) => this.pendingResult(m))
    const live: OperationReport = {
      opId: preview.opId,
      op: preview.op,
      label: preview.label,
      tags: [...preview.tags],
      startedAt,
      status: 'running',
      results,
      totals: computeTotals(results),
    }
    this.store(preview.opId, live)
    // `results` is only ever mutated in place from here on, so the index built
    // once here stays correct for the whole operation.
    const index = indexResults(results)

    const byCharacter = new Map<string, PlannedMutation[]>()
    for (const m of preview.mutations) {
      const list = byCharacter.get(m.characterId)
      if (list) list.push(m)
      else byCharacter.set(m.characterId, [m])
    }

    /**
     * Emit one progress snapshot.
     *
     * `snapshot()` already derives the totals and status from the results, and
     * it is the ONLY derivation here: this runs once per character, so deriving
     * before taking the snapshot as well walked the same results three more
     * times for numbers the snapshot was about to recompute anyway.
     */
    const progress = (): void => {
      const emitted = snapshot(live, true)
      live.totals = emitted.totals
      live.status = emitted.status
      hooks?.onProgress?.(emitted)
    }

    // Characters are resolved into ONE write batch. A conflicting character is
    // excluded from it rather than guessed at, so a disagreement is never sent
    // to the host at all.
    const batches: { id: string; tags: string[]; muts: PlannedMutation[] }[] = []
    for (const [, muts] of byCharacter) {
      // Defensive invariant, NOT a live code path: the planner emits exactly one
      // mutation per character, so this loop body only ever sees one record and
      // the check is vacuously true. It stays because a hand-built or mutated
      // `OperationPreview` is a public input, and disagreeing final arrays must
      // never be resolved by guessing which one the user meant.
      const first = muts[0] as PlannedMutation
      if (!muts.every((m) => sameTagSet(m.targetTags, first.targetTags))) {
        for (const m of muts) {
          const result = index.get(m.mutationId)
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
        continue
      }

      for (const m of muts) {
        const result = index.get(m.mutationId)
        if (result) result.attempts += 1
      }
      batches.push({ id: first.characterId, tags: dedupeTagNames(first.targetTags), muts })
    }

    if (batches.length > 0) {
      let outcome: { tagsById: Map<string, string[]>; failures: Map<string, BatchFailure> } | null = null
      try {
        // ONE request for the whole operation, and ONLY tag arrays — never a
        // full-character snapshot.
        const response = await this.port.updateTagsBatch(
          batches.map((b) => ({ characterId: b.id, tags: b.tags })),
        )
        outcome = {
          tagsById: new Map(response.updated.map((entry) => [entry.id, entry.tags])),
          failures: new Map(response.failures.map((failure) => [failure.characterId, failure])),
        }
      } catch (error) {
        // A transport-level failure means NOTHING in this batch is known to have
        // landed, so every mutation it carried failed with that one error —
        // exactly as it would have when each character was written separately.
        const classified = classifyError(error)
        for (const batch of batches) {
          for (const m of batch.muts) {
            const result = index.get(m.mutationId)
            if (result) this.markFailure(result, classified)
          }
        }
      }

      if (outcome !== null) {
        for (const batch of batches) {
          const failure = outcome.failures.get(batch.id)
          if (failure) {
            // A per-item failure fails ONLY that character's mutations, so the
            // report can still name which tag change failed.
            const classified = classifyBatchFailure(failure)
            for (const m of batch.muts) {
              const result = index.get(m.mutationId)
              if (result) this.markFailure(result, classified)
            }
          } else {
            const stored = outcome.tagsById.get(batch.id)
            if (stored === undefined) {
              // The host mentioned this character in NEITHER half of the reply:
              // not as written, not as failed. That is not a success and not a
              // failure — it is no evidence at all, which is what `uncertain`
              // means. Falling back to the array we INTENDED to write would make
              // `intentSatisfied` true by construction and report a write the
              // host never confirmed. Marked retryable so the retry path re-reads
              // the character and finds the truth either way.
              for (const m of batch.muts) {
                const result = index.get(m.mutationId)
                if (result) {
                  this.markFailure(result, {
                    message: 'The host did not report this character back, so the change cannot be confirmed as saved.',
                    code: 'unverified',
                    retryable: true,
                    uncertain: true,
                  })
                }
              }
            } else {
              this.verifyWrite(index, batch.muts, stored)
            }
          }
        }
      }

      for (const batch of batches) {
        for (const m of batch.muts) {
          const result = index.get(m.mutationId)
          if (result) hooks?.onResult?.(cloneResult(result))
        }
        progress()
      }
    }

    live.finishedAt = this.now()
    // The snapshot carries the derived totals/status, so they are adopted from
    // it rather than recomputed: the returned report and the executor's own
    // copy then come from ONE derivation of the same results.
    const report = snapshot(live, false)
    live.status = report.status
    live.totals = report.totals
    // Store a SEPARATE snapshot so a caller mutating what it got back can
    // never corrupt the executor's own state.
    this.store(preview.opId, snapshot(live, false))
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
    const stored = this.touch(opId)
    return stored === undefined ? undefined : snapshot(stored, stored.finishedAt === undefined)
  }

  /**
   * Record a report and drop whatever fell out of the retention window.
   *
   * Re-storing an opId both REPLACES its entry and refreshes its recency, which
   * is what makes a report the user just retried the least likely to be the one
   * evicted next.
   */
  private store(opId: string, report: OperationReport): void {
    // Delete first: a Map's iteration order is insertion order, so re-setting
    // an existing key would otherwise leave the stale position in place.
    this.reports.delete(opId)
    this.reports.set(opId, report)
    this.prune()
  }

  /** Read a report and mark it most-recently-used. */
  private touch(opId: string): OperationReport | undefined {
    const stored = this.reports.get(opId)
    if (stored === undefined) return undefined
    this.reports.delete(opId)
    this.reports.set(opId, stored)
    return stored
  }

  /**
   * Evict least-recently-stored reports until the window is back within
   * {@link RETAINED_REPORT_LIMIT}.
   *
   * A report with no `finishedAt` is STILL RUNNING and is never a candidate:
   * `execute()` stores the live object up front so a progress read or a retry
   * racing the write still finds it, and dropping it mid-flight would leave
   * `runRetry` to silently retry a stale snapshot — the exact failure invariant
   * 2 exists to prevent. The window is sized far above the number of operations
   * a user can have in flight at once, so skipping live entries can never make
   * the bound unreachable in practice.
   */
  private prune(): void {
    for (const [opId, report] of this.reports) {
      if (this.reports.size <= RETAINED_REPORT_LIMIT) return
      if (report.finishedAt === undefined) continue
      this.reports.delete(opId)
    }
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
    // `touch`, not `get`: a retry the user just asked for is the strongest
    // signal that this report is still wanted, so it must refresh recency
    // before the writes below can push it out of the window. The caller's own
    // report is the fallback precisely so an evicted entry can never leave a
    // retry operating on nothing.
    const base = this.touch(report.opId) ?? report
    const working: OperationReport = {
      ...base,
      results: cloneResults(base.results),
      finishedAt: undefined,
    }
    working.status = deriveStatus(working.results, true)
    working.totals = computeTotals(working.results)
    const index = indexResults(working.results)

    const targets = new Set<string>()
    for (const id of mutationIds) {
      const r = index.get(id)
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
      const r = index.get(id) as MutationResult
      const list = byCharacter.get(r.characterId)
      if (list) list.push(id)
      else byCharacter.set(r.characterId, [id])
    }

    await mapWithConcurrency([...byCharacter.entries()], this.concurrency, async ([, ids]) => {
      for (const id of ids) {
        const mine = index.get(id) as MutationResult

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
    const final = snapshot(working, false)
    working.status = final.status
    working.totals = final.totals
    this.store(working.opId, snapshot(working, false))
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
    index: ResultIndex,
    muts: readonly PlannedMutation[],
    postTags: readonly string[],
  ): void {
    for (const m of muts) {
      const result = index.get(m.mutationId)
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