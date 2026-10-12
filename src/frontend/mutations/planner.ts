/**
 * MUTATION PLANNER (Phase 5/6) — pure, network-free change computation.
 *
 * ## Why this module exists
 *
 * `CharacterRepository.update` performs a **full-array replace** of a
 * character's `tags` field (`update` is a partial per-field merge, but `tags`
 * itself is replaced wholesale — omitting a tag silently deletes it). So a
 * wrong plan overwrites data. This module therefore computes, without touching
 * the network, *exactly* which characters must change and what their tag arrays
 * must become.
 *
 * ## Invariants
 *
 * 1. **Additive & non-destructive.** Every target array is derived from the
 *    character's ORIGINAL tags. Unrelated tags are never dropped, and a
 *    character's array is never replaced by just the selected tags.
 * 2. **Deduplicated.** Case-insensitively, preserving the first spelling seen.
 * 3. **No-ops are skipped, not written.** They are still reported in
 *    `skipped` so the UI can say "nothing to change".
 * 4. **rename / merge / delete operate over the ENTIRE accessible character
 *    set** passed in. This module never filters it.
 * 5. **Identity is `characterId`.** Two characters sharing a display name are
 *    distinct.
 * 6. **One mutation per character.** The executor writes a character once and
 *    folds its mutations by `characterId`, so emitting one mutation per
 *    (character × source tag) only multiplied the full tag arrays each record
 *    carried without changing a single write. Multi-tag information lives in
 *    `sourceTags` / `removedTags` / `addedTags`, and is never split into
 *    several records.
 *
 * This module is pure: no DOM, no network, no module-level mutable state other
 * than the operation-id counter/suffix.
 */

import { dedupeTagNames, normalizeTagName, tagKey, type TagEntry } from '../tag-index'
import type { LumiTagCharacter } from '../../shared/types'

// ---------------------------------------------------------------------------
// Contract types
// ---------------------------------------------------------------------------

export type MutationOp = 'assign' | 'remove' | 'rename' | 'merge' | 'delete'

/** One intended tag change on one character. */
export interface PlannedMutation {
  /**
   * Stable id derived from `opId` + `characterId`.
   *
   * Derivation (documented contract):
   * ```
   * mutationId = `${opId}:${characterId}`
   * ```
   * A character is the unit of work — it is written exactly once — so its id
   * must NOT depend on which of the operation's tags happened to be picked as
   * the primary `tag`: that choice is a reporting convenience, not part of the
   * record's identity. It is a pure function of `opId` + `characterId`, so
   * re-planning the same operation with the same `opId` produces byte-identical
   * ids and a retry can reuse the id and therefore can never double-apply. It
   * is also safe as a `Map` key (plain string; `opId` is minted here and never
   * contains `:`).
   */
  mutationId: string
  characterId: string
  characterName: string
  op: MutationOp
  /**
   * The PRIMARY tag this mutation concerns: the tag for assign/remove/delete,
   * the SOURCE tag for rename/merge. When several source tags touch this
   * character, the primary is the one with the LOWEST `tagKey`, compared
   * codepoint-wise — a total order over the set, so it never depends on
   * `Map`/`Set` iteration order. `sourceTags` always carries the complete list;
   * this is the label, not the identity.
   */
  tag: string
  /** Destination tag for rename/merge only. */
  destTag?: string
  /**
   * Every source tag of this multi-source operation that touches THIS
   * character (assign/remove/rename/merge/delete). A character produces exactly
   * ONE mutation, so this list — not `tag` alone — is the full picture of what
   * the single write does. `removedTags` is its destructive half.
   */
  sourceTags: string[]
  /** Tags this mutation adds to the character (deduped, original spelling). */
  addedTags: string[]
  /** Tags this mutation removes from the character (deduped, original spelling). */
  removedTags: string[]
  /** The character's complete intended final tag array, from its ORIGINAL tags. */
  targetTags: string[]
  /** The character's tag array before the operation. */
  beforeTags: string[]
  /** One-line, UI-safe description of the intended change. */
  intendedChange: string
}

export interface SkippedMutation {
  characterId: string
  characterName: string
  /** Why nothing changed, e.g. 'already assigned' / 'tag not present'. */
  reason: string
}

export interface OperationPreview {
  /** Stable operation id, unique per operation instance. */
  opId: string
  op: MutationOp
  /** UI-safe operation label, e.g. 'Merge: Mage → Magic'. */
  label: string
  /** Tags involved. For rename/merge the primary/destination tag comes first. */
  tags: string[]
  mutations: PlannedMutation[]
  skipped: SkippedMutation[]
  affectedCharacterIds: string[]
  affectedCharacterCount: number
  /** Distinct characters whose tags this operation will actually change. */
  changeCount: number
}

export type PlanInput =
  | { op: 'assign'; tag: string; selectedIds: readonly string[] }
  | { op: 'assign'; tags: readonly string[]; selectedIds: readonly string[] }
  /**
   * Removal is library-wide by default. When `selectedIds` is supplied the
   * removal is SCOPED: only those characters are considered, and a selected id
   * that cannot be resolved is reported in `skipped` rather than silently
   * dropped. Omitting `selectedIds` is the original, whole-library behaviour.
   */
  | { op: 'remove'; tags: readonly string[]; selectedIds?: readonly string[] }
  | { op: 'rename'; from: string; to: string }
  | { op: 'merge'; primary: string; targets: readonly string[] }
  | { op: 'delete'; tags: readonly string[] }

export type TagNameValidation =
  | { ok: true; value: string }
  | { ok: false; reason: 'blank' | 'duplicate'; existing?: TagEntry; message: string }

export type RenameTargetValidation =
  | { ok: true; value: string }
  | { ok: false; reason: 'blank' | 'collision' | 'unchanged'; message: string }

// ---------------------------------------------------------------------------
// Operation ids
// ---------------------------------------------------------------------------

/**
 * Monotonic counter + a module-level pseudo-random suffix.
 *
 * Combined with a timestamp this guarantees that two *separate* operation
 * instances never share an id even if they run in the same millisecond, while
 * remaining safe for `Map` keys and UI display.
 */
let opCounter = 0
const OP_NONCE = `${Math.random().toString(36).slice(2, 8)}${Math.random().toString(36).slice(2, 6)}`

/** FNV-1a 32-bit hash rendered as 8 lowercase hex chars. */
function fnv1a32(value: string): string {
  let hash = 0x811c9dc5
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i)
    // hash *= 16777619, kept in 32-bit range without BigInt.
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(16).padStart(8, '0')
}

/**
 * Produce an operation id.
 *
 * - **Without a seed**: `op-<counter>-<timestamp36>-<nonce>` — unique per
 *   operation instance.
 * - **With a seed**: `op-<hash(seed)>` — fully deterministic, so a caller that
 *   replays the same logical operation (e.g. a retry) reuses the same id.
 *   The op name is mixed into the hash so ids cannot collide across operation
 *   types even for identical seeds.
 */
export function createOperationId(op: MutationOp, seed?: string): string {
  if (typeof seed === 'string' && seed !== '') {
    return `${op}-${fnv1a32(`${op}\x00${seed}`)}`
  }
  opCounter += 1
  return `${op}-${opCounter.toString(36)}-${Date.now().toString(36)}-${OP_NONCE}`
}

// ---------------------------------------------------------------------------
// Small pure helpers
// ---------------------------------------------------------------------------

/** Make a tag safe to embed in a UI-safe one-liner / label. */
function safe(value: unknown): string {
  return String(value ?? '').replace(/[\r\n\t]+/g, ' ').replace(/"/g, "'").trim()
}

/** Format a tag list for a one-liner: `"a", "b", "c"`. */
function quoteList(tags: readonly string[]): string {
  return tags.map((tag) => `"${safe(tag)}"`).join(', ')
}

/** A defensively-read, deduped copy of a character's original tags. */
function beforeTagsOf(character: LumiTagCharacter): string[] {
  const raw = (character as { tags?: unknown } | null | undefined)?.tags
  return dedupeTagNames(Array.isArray(raw) ? raw : [])
}

/** Defensively-read a stable string id. Blank ids are unusable as identity. */
function idOf(character: LumiTagCharacter): string {
  const id = (character as { id?: unknown } | null | undefined)?.id
  if (typeof id !== 'string') return ''
  return id.trim()
}

/** Defensively-read a display name for UI/report output. */
function nameOf(character: LumiTagCharacter): string {
  const name = (character as { name?: unknown } | null | undefined)?.name
  if (typeof name !== 'string') return ''
  return name
}

/** Dedupe a caller-supplied tag list, preserving first spelling + first order. */
function cleanTagList(input: unknown): string[] {
  if (!Array.isArray(input)) return []
  return dedupeTagNames(input)
}

/** Sorted keys of a tag list, for O(n) membership tests. */
function keySet(tags: readonly string[]): Set<string> {
  return new Set(tags.map((tag) => tagKey(tag)))
}

/** Names in `names` that are absent from `existingKeys`. */
function namesMissingFrom(names: readonly string[], existingKeys: ReadonlySet<string>): string[] {
  return names.filter((name) => !existingKeys.has(tagKey(name)))
}

/** Locale-independent string ordering (codepoint-wise). */
function compareStrings(a: string, b: string): number {
  if (a === b) return 0
  return a < b ? -1 : 1
}

/**
 * Deterministic comparator for the mutations array (see contract).
 *
 * Plain codepoint comparison, NOT `localeCompare`: sorting must not depend on
 * the host's locale. `mutationId` is the last tiebreak, which is enough to
 * make the order total even if a caller hands us two records for one character.
 */
function compareMutations(a: PlannedMutation, b: PlannedMutation): number {
  if (a.characterName !== b.characterName) return a.characterName < b.characterName ? -1 : 1
  if (a.characterId !== b.characterId) return a.characterId < b.characterId ? -1 : 1
  return compareStrings(a.mutationId, b.mutationId)
}

/**
 * The PRIMARY tag of a multi-source record: the one with the lowest `tagKey`.
 *
 * Codepoint-wise lowest is a total order over any source set, so the choice is
 * reproducible across runs and platforms — a `Set`/`Map` iteration order is not,
 * and must never leak into a record's identity or its user-visible label.
 */
function primarySource(sources: readonly string[]): string {
  let best = ''
  for (const source of sources) {
    const key = tagKey(source)
    if (best === '' || compareStrings(key, tagKey(best)) < 0) best = source
  }
  return best
}

/** Deterministic comparator for the skipped array. */
function compareSkipped(a: SkippedMutation, b: SkippedMutation): number {
  if (a.characterName !== b.characterName) return compareStrings(a.characterName, b.characterName)
  if (a.characterId !== b.characterId) return compareStrings(a.characterId, b.characterId)
  return compareStrings(a.reason, b.reason)
}

/** Assemble the preview and compute the affected/change counters. */
function finalize(
  opId: string,
  op: MutationOp,
  label: string,
  tags: string[],
  mutations: PlannedMutation[],
  skipped: SkippedMutation[],
): OperationPreview {
  mutations.sort(compareMutations)
  skipped.sort(compareSkipped)

  const affectedCharacterIds: string[] = []
  const seen = new Set<string>()
  for (const mutation of mutations) {
    if (seen.has(mutation.characterId)) continue
    seen.add(mutation.characterId)
    affectedCharacterIds.push(mutation.characterId)
  }

  return {
    opId,
    op,
    label,
    tags,
    mutations,
    skipped,
    affectedCharacterIds,
    affectedCharacterCount: affectedCharacterIds.length,
    // Every mutation produced here represents a real, non-no-op change, so the
    // distinct set of changed characters is the affected set.
    changeCount: affectedCharacterIds.length,
  }
}

/** Build the deterministic `mutationId`. See `PlannedMutation.mutationId`. */
function mutationIdFor(opId: string, characterId: string): string {
  return `${opId}:${characterId}`
}

// ---------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------

interface Ctx {
  opId: string
  character: LumiTagCharacter
  characterId: string
  characterName: string
  beforeTags: string[]
}

/**
 * assign — additive. Adds the given tag(s) to each selected character while
 * preserving every existing tag. Characters that already carry the tag
 * (case-insensitively) are skipped.
 */
function planAssign(
  opId: string,
  characters: readonly LumiTagCharacter[],
  assignTags: string[],
  selectedIds: readonly string[],
): OperationPreview {
  const mutations: PlannedMutation[] = []
  const skipped: SkippedMutation[] = []

  const byId = new Map<string, LumiTagCharacter>()
  for (const character of characters) {
    if (!character || typeof character !== 'object') continue
    const id = idOf(character)
    if (id !== '') byId.set(id, character)
  }

  for (const rawId of Array.isArray(selectedIds) ? selectedIds : []) {
    if (typeof rawId !== 'string') continue
    const id = rawId.trim()
    const character = byId.get(id)
    if (!character) {
      // Defensive: a stale selection referring to a character we could not
      // read. Reported (not silently dropped) so the UI never lies.
      skipped.push({ characterId: id, characterName: '', reason: 'character not found' })
      continue
    }

    const ctx: Ctx = {
      opId,
      character,
      characterId: id,
      characterName: nameOf(character),
      beforeTags: beforeTagsOf(character),
    }

    if (assignTags.length === 0) {
      skipped.push({ characterId: ctx.characterId, characterName: ctx.characterName, reason: 'no tag to assign' })
      continue
    }

    const existingKeys = keySet(ctx.beforeTags)
    const missing = namesMissingFrom(assignTags, existingKeys)

    if (missing.length === 0) {
      skipped.push({ characterId: ctx.characterId, characterName: ctx.characterName, reason: 'already assigned' })
      continue
    }

    const targetTags = dedupeTagNames([...ctx.beforeTags, ...missing])
    mutations.push({
      mutationId: mutationIdFor(opId, ctx.characterId),
      characterId: ctx.characterId,
      characterName: ctx.characterName,
      op: 'assign',
      tag: primarySource(missing),
      sourceTags: missing,
      addedTags: missing,
      removedTags: [],
      targetTags,
      beforeTags: ctx.beforeTags,
      intendedChange:
        missing.length === 1
          ? `Add tag ${quoteList(missing)} to ${safe(ctx.characterName)}`
          : `Add ${missing.length} tags (${quoteList(missing)}) to ${safe(ctx.characterName)}`,
    })
  }

  const label =
    assignTags.length === 1 ? `Assign tag: ${safe(assignTags[0])}` : `Assign ${assignTags.length} tags`

  return finalize(opId, 'assign', label, assignTags, mutations, skipped)
}

/**
 * remove / delete — remove the given tag(s) from every character that has them.
 *
 * ONE mutation per character, carrying every source tag that touches it in
 * `sourceTags` and the UNION of what those sources remove in `removedTags`.
 * The executor applies `removedTags` as a set against the freshly read record
 * and `targetTags` as the character's complete final array, so the union is the
 * single write's true intent — splitting it per source tag produced N records
 * for one write and made a bulk delete's failure report indistinguishable from
 * a single-tag one.
 */
function planRemoval(
  opId: string,
  op: 'remove' | 'delete',
  characters: readonly LumiTagCharacter[],
  removeTags: string[],
  selectedIds?: readonly string[],
): OperationPreview {
  const mutations: PlannedMutation[] = []
  const skipped: SkippedMutation[] = []

  const removeKeys = new Set(removeTags.map((tag) => tagKey(tag)))

  // A scope restricts WHICH characters are examined; it never filters `characters`
  // beyond membership. `undefined` (delete) keeps the library-wide contract.
  const scopedIds = Array.isArray(selectedIds) ? selectedIds : null
  const scope = scopedIds === null ? null : new Set(scopedIds)

  // A scoped removal walks the selection in the caller's order and resolves each
  // id, so a selection referring to a character we cannot read is REPORTED
  // instead of quietly narrowing the operation.
  const scoped: LumiTagCharacter[] = []
  if (scopedIds !== null) {
    const byId = new Map<string, LumiTagCharacter>()
    for (const character of characters) {
      if (!character || typeof character !== 'object') continue
      const id = idOf(character)
      if (id !== '') byId.set(id, character)
    }
    for (const rawId of scopedIds) {
      if (typeof rawId !== 'string') continue
      const id = rawId.trim()
      const character = byId.get(id)
      if (character) scoped.push(character)
      else skipped.push({ characterId: id, characterName: '', reason: 'character not found' })
    }
  }

  for (const character of scope === null ? characters : scoped) {
    if (!character || typeof character !== 'object') continue
    const ctx: Ctx = {
      opId,
      character,
      characterId: idOf(character),
      characterName: nameOf(character),
      beforeTags: beforeTagsOf(character),
    }

    if (ctx.characterId === '') continue
    if (removeTags.length === 0) {
      skipped.push({ characterId: ctx.characterId, characterName: ctx.characterName, reason: 'no tag to remove' })
      continue
    }

    const touched = ctx.beforeTags.filter((tag) => removeKeys.has(tagKey(tag)))

    if (touched.length === 0) {
      skipped.push({ characterId: ctx.characterId, characterName: ctx.characterName, reason: 'tag not present' })
      continue
    }

    // `targetTags` and `touched` are computed by complementary filters over
    // `beforeTags`, so `touched` IS the union of tags this one write removes —
    // every tag it touches matches `removeKeys` and therefore cannot survive
    // into the target array. Kept as its own binding because it is the single
    // most load-bearing field in the record: it is what a retry re-applies.
    const removedTags = touched
    const targetTags = dedupeTagNames(ctx.beforeTags.filter((tag) => !removeKeys.has(tagKey(tag))))
    const primary = primarySource(touched)

    mutations.push({
      mutationId: mutationIdFor(opId, ctx.characterId),
      characterId: ctx.characterId,
      characterName: ctx.characterName,
      op,
      tag: primary,
      sourceTags: touched,
      addedTags: [],
      removedTags,
      targetTags,
      beforeTags: ctx.beforeTags,
      intendedChange:
        touched.length === 1
          ? `${op === 'delete' ? 'Delete' : 'Remove'} tag ${quoteList([primary])} from ${safe(ctx.characterName)}`
          : `${op === 'delete' ? 'Delete' : 'Remove'} ${removedTags.length} tags (${quoteList(removedTags)}) from ${safe(ctx.characterName)}`,
    })
  }

  const verb = op === 'delete' ? 'Delete' : 'Remove'
  // A scoped removal says so in its label: the report panel must never show a
  // selection-scoped operation under a label that reads as library-wide.
  const scopeNote = scope === null ? '' : ' from selection'
  const label =
    removeTags.length === 1
      ? `${verb} tag: ${safe(removeTags[0])}${scopeNote}`
      : `${verb} ${removeTags.length} tags${scopeNote}`

  return finalize(opId, op, label, removeTags, mutations, skipped)
}

/**
 * rename — replace `from` with `to` on EVERY accessible character carrying
 * `from`. Unrelated tags are preserved; if the character already had `to` the
 * result still contains `to` exactly once.
 */
function planRename(
  opId: string,
  characters: readonly LumiTagCharacter[],
  from: string,
  to: string,
): OperationPreview {
  const mutations: PlannedMutation[] = []
  const skipped: SkippedMutation[] = []

  const fromTag = normalizeTagName(from)
  const toTag = normalizeTagName(to)
  const label = `Rename: ${safe(fromTag)} → ${safe(toTag)}`

  for (const character of characters) {
    if (!character || typeof character !== 'object') continue
    const ctx: Ctx = {
      opId,
      character,
      characterId: idOf(character),
      characterName: nameOf(character),
      beforeTags: beforeTagsOf(character),
    }
    if (ctx.characterId === '') continue

    const carriesFrom = ctx.beforeTags.some((tag) => tagKey(tag) === tagKey(fromTag))
    if (!carriesFrom) {
      skipped.push({ characterId: ctx.characterId, characterName: ctx.characterName, reason: 'tag not present' })
      continue
    }

    if (fromTag === '' || toTag === '') {
      skipped.push({ characterId: ctx.characterId, characterName: ctx.characterName, reason: 'invalid tag name' })
      continue
    }

    if (tagKey(fromTag) === tagKey(toTag)) {
      // Renaming a tag to a case-variant of itself is a pure no-op for this
      // character: the resulting array is identical.
      skipped.push({ characterId: ctx.characterId, characterName: ctx.characterName, reason: 'already named this' })
      continue
    }

    const targetTags = dedupeTagNames(
      ctx.beforeTags.map((tag) => (tagKey(tag) === tagKey(fromTag) ? toTag : tag)),
    )
    const beforeKeys = keySet(ctx.beforeTags)
    const targetKeys = keySet(targetTags)

    mutations.push({
      mutationId: mutationIdFor(opId, ctx.characterId),
      characterId: ctx.characterId,
      characterName: ctx.characterName,
      op: 'rename',
      tag: fromTag,
      destTag: toTag,
      sourceTags: [fromTag],
      addedTags: targetTags.filter((tag) => !beforeKeys.has(tagKey(tag))),
      removedTags: ctx.beforeTags.filter((tag) => !targetKeys.has(tagKey(tag))),
      targetTags,
      beforeTags: ctx.beforeTags,
      intendedChange: `Rename ${quoteList([fromTag])} to ${quoteList([toTag])} on ${safe(ctx.characterName)}`,
    })
  }

  return finalize(opId, 'rename', label, [fromTag, toTag], mutations, skipped)
}

/**
 * merge — replace each target with the primary across the whole accessible set.
 *
 * A target equal to the primary (case-insensitively) is dropped: the primary is
 * never selectable as its own target and must never produce a self-merge.
 *
 * A character touched by several targets produces ONE mutation carrying the
 * combined `targetTags` and every source that touched it. This is critical: the
 * executor writes once per character, and `targetTags` is a FULL-ARRAY REPLACE
 * on the host, so the merged array must be computed — and carried — whole.
 */
function planMerge(
  opId: string,
  characters: readonly LumiTagCharacter[],
  primary: string,
  targets: readonly string[],
): OperationPreview {
  const mutations: PlannedMutation[] = []
  const skipped: SkippedMutation[] = []

  const primaryTag = normalizeTagName(primary)
  const primaryKey = tagKey(primaryTag)
  // Drop self-merge targets (case-insensitively) and case-variant duplicates.
  const mergeTargets = cleanTagList(targets).filter((target) => tagKey(target) !== primaryKey)
  const mergeKeys = new Set(mergeTargets.map((target) => tagKey(target)))

  const label =
    mergeTargets.length === 1
      ? `Merge: ${safe(mergeTargets[0])} → ${safe(primaryTag)}`
      : `Merge ${mergeTargets.length} tags → ${safe(primaryTag)}`

  for (const character of characters) {
    if (!character || typeof character !== 'object') continue
    const ctx: Ctx = {
      opId,
      character,
      characterId: idOf(character),
      characterName: nameOf(character),
      beforeTags: beforeTagsOf(character),
    }
    if (ctx.characterId === '') continue

    if (primaryTag === '' || mergeTargets.length === 0) {
      skipped.push({
        characterId: ctx.characterId,
        characterName: ctx.characterName,
        reason: primaryTag === '' ? 'invalid tag name' : 'nothing to merge',
      })
      continue
    }

    // Which targets actually touch THIS character, in the caller's order.
    const sourceTags = mergeTargets.filter((target) =>
      ctx.beforeTags.some((tag) => tagKey(tag) === tagKey(target)),
    )

    if (sourceTags.length === 0) {
      skipped.push({ characterId: ctx.characterId, characterName: ctx.characterName, reason: 'tag not present' })
      continue
    }

    const sourceKeySet = keySet(sourceTags)
    // The combined final array: every source replaced by the primary, then
    // deduped. A character that already had the primary keeps it exactly once.
    const targetTags = dedupeTagNames(
      ctx.beforeTags.map((tag) => (sourceKeySet.has(tagKey(tag)) ? primaryTag : tag)),
    )
    const beforeKeys = keySet(ctx.beforeTags)
    const targetKeys = keySet(targetTags)

    mutations.push({
      mutationId: mutationIdFor(opId, ctx.characterId),
      characterId: ctx.characterId,
      characterName: ctx.characterName,
      op: 'merge',
      tag: primarySource(sourceTags),
      destTag: primaryTag,
      // Full list of targets touching this character.
      sourceTags,
      addedTags: targetTags.filter((tag) => !beforeKeys.has(tagKey(tag))),
      removedTags: ctx.beforeTags.filter((tag) => !targetKeys.has(tagKey(tag))),
      targetTags,
      beforeTags: ctx.beforeTags,
      intendedChange:
        sourceTags.length === 1
          ? `Merge ${quoteList([sourceTags[0] as string])} into ${quoteList([primaryTag])} on ${safe(ctx.characterName)}`
          : `Merge ${sourceTags.length} tags (${quoteList(sourceTags)}) into ${quoteList([primaryTag])} on ${safe(ctx.characterName)}`,
    })
  }

  return finalize(opId, 'merge', label, [primaryTag, ...mergeTargets], mutations, skipped)
}

// ---------------------------------------------------------------------------
// Public entry points
// ---------------------------------------------------------------------------

/**
 * Compute a full operation preview over `characters`.
 *
 * `characters` must be the ENTIRE accessible set for rename/merge/delete —
 * this function never filters it, by design.
 */
export function planOperation(
  characters: readonly LumiTagCharacter[],
  input: PlanInput,
): OperationPreview {
  const safeCharacters: readonly LumiTagCharacter[] = Array.isArray(characters) ? characters : []
  const opId = createOperationId(input?.op as MutationOp)
  const safeInput = (input ?? { op: 'delete', tags: [] }) as PlanInput

  switch (safeInput.op) {
    case 'assign': {
      const tags =
        'tag' in safeInput && typeof safeInput.tag === 'string'
          ? cleanTagList([safeInput.tag])
          : cleanTagList((safeInput as { tags?: readonly string[] }).tags)
      return planAssign(opId, safeCharacters, tags, safeInput.selectedIds ?? [])
    }
    case 'remove':
      return planRemoval(
        opId,
        'remove',
        safeCharacters,
        cleanTagList(safeInput.tags),
        'selectedIds' in safeInput ? safeInput.selectedIds : undefined,
      )
    case 'rename':
      return planRename(opId, safeCharacters, safeInput.from, safeInput.to)
    case 'merge':
      return planMerge(opId, safeCharacters, safeInput.primary, safeInput.targets)
    case 'delete':
      return planRemoval(opId, 'delete', safeCharacters, cleanTagList(safeInput.tags))
    default: {
      // Defensive: unknown op → an empty, well-formed preview.
      return finalize(opId, 'delete', 'Unknown operation', [], [], [])
    }
  }
}

/**
 * Every accessible character carrying `tag` (case-insensitively), in input
 * order. Used by the UI to size an operation before confirming it.
 */
export function affectedCharactersForTag(
  characters: readonly LumiTagCharacter[],
  tag: string,
): LumiTagCharacter[] {
  if (!Array.isArray(characters)) return []
  const key = tagKey(tag)
  if (key === '') return []
  const out: LumiTagCharacter[] = []
  for (const character of characters) {
    if (!character || typeof character !== 'object') continue
    for (const raw of beforeTagsOf(character)) {
      if (tagKey(raw) === key) {
        out.push(character)
        break
      }
    }
  }
  return out
}

/**
 * Validate a brand-new tag name for "create tag and assign".
 *
 * Rejects blank/whitespace-only names and — per the spec's "prevent accidental
 * duplicates / no visually confusing case-variant duplicates" — rejects any
 * name that case-insensitively equals an existing tag, while RETURNING that
 * existing entry so the UI can offer "assign the existing tag instead".
 */
export function validateNewTagName(name: string, existing: readonly TagEntry[]): TagNameValidation {
  const value = normalizeTagName(name)

  if (value === '') {
    return { ok: false, reason: 'blank', message: 'Tag name cannot be empty.' }
  }

  const hit = findEntry(value, existing)
  if (hit) {
    return {
      ok: false,
      reason: 'duplicate',
      existing: hit,
      message: `Tag "${value}" already exists. Assign the existing tag instead.`,
    }
  }

  return { ok: true, value }
}

/**
 * Validate a rename destination.
 *
 * Rejects blank, rejects an exact same-spelling no-op rename, and rejects a
 * collision with a *different* existing tag (including a case-only variant of
 * it). Renaming `elf` → `Elf` when `elf` IS the current tag is accepted: that is
 * not a collision with a different tag.
 */
export function validateRenameTarget(
  name: string,
  currentTag: string,
  existing: readonly TagEntry[],
): RenameTargetValidation {
  const value = normalizeTagName(name)
  const current = normalizeTagName(currentTag)

  if (value === '') {
    return { ok: false, reason: 'blank', message: 'Tag name cannot be empty.' }
  }

  if (value === current) {
    return { ok: false, reason: 'unchanged', message: `Tag is already named "${value}".` }
  }

  const hit = findEntry(value, existing)
  if (hit && tagKey(hit.name) !== tagKey(current)) {
    return {
      ok: false,
      reason: 'collision',
      message: `A different tag "${hit.name}" already exists.`,
    }
  }

  return { ok: true, value }
}

/** Case-insensitive lookup in a `TagEntry[]`. Never throws. */
function findEntry(name: string, existing: readonly TagEntry[]): TagEntry | undefined {
  if (!Array.isArray(existing)) return undefined
  const key = tagKey(name)
  if (key === '') return undefined
  return existing.find((entry) => !!entry && tagKey(entry.name) === key)
}