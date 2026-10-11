/**
 * LumiTag application state store.
 *
 * This is THE contract the UI sections code against. It is deliberately
 * **DOM-free** so the whole of LumiTag's behaviour is unit-testable under
 * `bun test` with no document at all.
 *
 * ## The rules this store exists to enforce
 *
 *  1. **The derived index is the only source of truth for tags.** The catalog
 *     is rebuilt with `buildTagIndex` after every load and every write. There
 *     is no shadow tag database that can drift from reality.
 *  2. **Plans are computed over the FULL accessible character set**, never over
 *     the filtered/visible list. A user filtering to `Elf` and then deleting
 *     `Dark` must still delete `Dark` everywhere — filtering is a view concern,
 *     never a scope concern.
 *  3. **Never report success from optimistic state.** Every write is followed
 *     by a re-read of exactly the affected characters, so a failed write
 *     leaves its chip visible instead of silently dropping it.
 *  4. **Never re-fetch the whole library after a write.** `refresh()` re-reads
 *     only the ids the executor actually touched — and only their tag arrays,
 *     merged into the records already held (see `patchCharacterTags`).
 *  5. **Every operation produces a report**, including a fully successful one,
 *     so the user always gets a result confirmation.
 */

import type { CharacterTags, LumiTagCharacter } from '../shared/types'
import { searchCharactersWithContext } from './search/evaluator'
import type { ParsedQuery, QuerySyntaxError } from './search/parser'
import { parseQuery } from './search/parser'
import type { SearchHelpSection } from './search/search-help'
import { getSearchHelpSections } from './search/search-help'
import { buildTagIndex, tagKey, type TagEntry, type TagIndex } from './tag-index'
import { filterTagsByName, sortTags, type TagSortMode } from './tag-sorting'
import { classifyError } from './mutations/executor'
import type { MutationExecutor } from './mutations/executor'
import type { MutationResult, OperationReport } from './mutations/report'
import {
  planOperation,
  validateNewTagName,
  validateRenameTarget,
  type PlanInput,
} from './mutations/planner'
import type { CharacterRepository } from './repository'

// ---------------------------------------------------------------------------
// Public view contract
// ---------------------------------------------------------------------------

export type Section = 'tags' | 'characters'

export type LoadState = 'idle' | 'loading' | 'ready' | 'error'

export type TagMode = 'normal' | 'bulk_delete' | 'merge'

export type CharacterSortMode =
  | 'name_asc'
  | 'name_zdesc'
  | 'tags_desc'
  | 'tags_asc'
  | 'has_tags_first'
  | 'no_tags_first'

export type CharacterTagFilter = 'all' | 'any' | 'all_of' | 'has_tags' | 'no_tags'

/** One row of the Tags list: a catalog entry plus its UI-only state. */
export interface TagListRow {
  entry: TagEntry
  expanded: boolean
  selected: boolean
}

/** One row of the Characters list (or of a tag's expanded sub-list). */
export interface CharacterListRow {
  character: LumiTagCharacter
  tags: string[]
  selected: boolean
}

/**
 * An immutable snapshot of everything the UI renders.
 *
 * A new object is produced only when something actually changed, which is what
 * lets the shell skip a re-render instead of thrashing the DOM on every store
 * notification.
 */
export interface StoreView {
  section: Section
  loadState: LoadState
  loadError: string | null
  isRefreshing: boolean
  characters: LumiTagCharacter[]
  characterCount: number
  tagIndex: TagIndex
  // Tags section
  tagRows: TagListRow[]
  tagQuery: string
  tagQueryErrors: QuerySyntaxError[]
  /** True when the Tags query is in `C:` character-search mode. */
  tagQueryIsCharacterMode: boolean
  /** Characters matching a `C:` search in the Tags section, with their tags. */
  tagQueryCharacters: CharacterListRow[]
  tagSort: TagSortMode
  tagMode: TagMode
  selectedTagKeys: string[]
  selectedTagCount: number
  mergePrimaryKey: string | null
  mergeTargetKeys: string[]
  mergeValid: boolean
  // Characters section
  characterRows: CharacterListRow[]
  characterQuery: string
  characterQueryErrors: QuerySyntaxError[]
  characterSort: CharacterSortMode
  characterTagFilter: CharacterTagFilter
  activeFilterTagKeys: string[]
  selectedCharacterIds: string[]
  selectedAssignTagKeys: string[]
  // Reports
  reports: OperationReport[]
  activeReportOpId: string | null
  // Derived
  untaggedCount: number
  /** Wall-clock ms of the last successful (re)load, or `null` before the first. */
  lastRefreshedAt: number | null
}

/** Labels for the six character sort modes, rendered by the shell. */
export const CHARACTER_SORT_LABELS: Record<CharacterSortMode, string> = {
  name_asc: 'Name (A-Z)',
  name_zdesc: 'Name (Z-A)',
  tags_desc: 'Most tags first',
  tags_asc: 'Fewest tags first',
  has_tags_first: 'Tagged first',
  no_tags_first: 'Untagged first',
}

export const CHARACTER_SORT_MODES: readonly CharacterSortMode[] = [
  'name_asc',
  'name_zdesc',
  'tags_desc',
  'tags_asc',
  'has_tags_first',
  'no_tags_first',
]

export const CHARACTER_TAG_FILTER_LABELS: Record<CharacterTagFilter, string> = {
  all: 'All characters',
  any: 'Has ANY of these tags',
  all_of: 'Has ALL of these tags',
  has_tags: 'Has any tag',
  no_tags: 'Has no tags',
}

export const CHARACTER_TAG_FILTER_MODES: readonly CharacterTagFilter[] = [
  'all',
  'any',
  'all_of',
  'has_tags',
  'no_tags',
]

// ---------------------------------------------------------------------------
// Actions contract
// ---------------------------------------------------------------------------

export interface TagManagerActions {
  refresh(): Promise<void>
  setSection(s: Section): void
  setTagQuery(q: string): void
  setTagSort(m: TagSortMode): void
  toggleTagExpanded(key: string): void
  setTagMode(m: TagMode): void
  setMergePrimary(key: string | null): void
  toggleMergeTarget(key: string): void
  toggleTagSelected(key: string, selected?: boolean): void
  selectAllVisibleTags(): void
  clearTagSelection(): void
  exitTagMode(): void
  setCharacterQuery(q: string): void
  setCharacterSort(m: CharacterSortMode): void
  setCharacterTagFilter(f: CharacterTagFilter): void
  setActiveFilterTags(keys: string[]): void
  toggleCharacterSelected(id: string, selected?: boolean): void
  selectAllVisibleCharacters(): void
  clearCharacterSelection(): void
  setAssignTagSelection(keys: string[]): void
  runCreateTagAndAssign(name: string, characterIds: string[]): Promise<void>
  runRenameTag(from: string, to: string): Promise<void>
  runMergeTags(primary: string, targets: string[]): Promise<void>
  runDeleteTags(tags: string[]): Promise<void>
  runBulkAssign(tags: string[], characterIds: string[]): Promise<void>
  runRemoveChip(characterId: string, tag: string): Promise<void>
  retryOne(opId: string, mutationId: string): Promise<void>
  retryGroup(opId: string, groupKey: string): Promise<void>
  retryAll(opId: string): Promise<void>
  dismissReport(opId: string): void
  showReport(opId: string | null): void
  /** Search-help sections for a section, straight from the shared source. */
  searchHelp(context: 'tags' | 'characters'): SearchHelpSection[]
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/** Most recent reports are kept; older ones are dropped so the panel stays bounded. */
const REPORT_LIMIT = 20

const EMPTY_INDEX: TagIndex = buildTagIndex([])

function readName(character: LumiTagCharacter): string {
  return typeof character?.name === 'string' ? character.name : ''
}

function readTags(character: LumiTagCharacter): string[] {
  return Array.isArray(character?.tags) ? character.tags : []
}

/** Lowercased name for ordering; falls back to the id so ties stay deterministic. */
function nameKey(character: LumiTagCharacter): string {
  const name = readName(character).toLowerCase()
  return name !== '' ? name : `￿${character.id}`
}

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

/** A UI-safe message for an arbitrary thrown value. Never a stack trace. */
function uiSafeMessage(error: unknown, fallback: string): string {
  const message = classifyError(error).message
  return message.trim() === '' ? fallback : message
}

function hasAnyQueryTerm(raw: string): boolean {
  const match = /(?:^|[\s,])-?c:/i.exec(raw)
  return match !== null
}

/** Raw, mutable store state. Nothing here is handed to the UI directly. */
interface StoreState {
  section: Section
  loadState: LoadState
  loadError: string | null
  isRefreshing: boolean
  characters: LumiTagCharacter[]
  lastRefreshedAt: number | null
  tagIndex: TagIndex
  expandedTagKeys: Set<string>
  selectedTagKeys: Set<string>
  tagQuery: string
  tagSort: TagSortMode
  tagMode: TagMode
  mergePrimaryKey: string | null
  mergeTargetKeys: Set<string>
  characterQuery: string
  characterSort: CharacterSortMode
  characterTagFilter: CharacterTagFilter
  activeFilterTagKeys: Set<string>
  selectedCharacterIds: Set<string>
  selectedAssignTagKeys: Set<string>
  reports: OperationReport[]
  activeReportOpId: string | null
}

function initialState(): StoreState {
  return {
    section: 'tags',
    loadState: 'idle',
    loadError: null,
    isRefreshing: false,
    characters: [],
    lastRefreshedAt: null,
    tagIndex: EMPTY_INDEX,
    expandedTagKeys: new Set(),
    selectedTagKeys: new Set(),
    tagQuery: '',
    tagSort: 'name_asc',
    tagMode: 'normal',
    mergePrimaryKey: null,
    mergeTargetKeys: new Set(),
    characterQuery: '',
    characterSort: 'name_asc',
    characterTagFilter: 'all',
    activeFilterTagKeys: new Set(),
    selectedCharacterIds: new Set(),
    selectedAssignTagKeys: new Set(),
    reports: [],
    activeReportOpId: null,
  }
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export class TagManagerStore {
  private readonly repo: CharacterRepository
  private readonly executor: MutationExecutor
  private readonly listeners = new Set<() => void>()
  private state: StoreState = initialState()
  private snapshot: StoreView
  private disposed = false

  /** Bumped on every real change; the shell uses it to skip redundant renders. */
  version = 0

  constructor(repo: CharacterRepository, executor: MutationExecutor) {
    this.repo = repo
    this.executor = executor
    this.snapshot = this.computeView()
  }

  /** The current immutable view snapshot. */
  get view(): StoreView {
    return this.snapshot
  }

  /**
   * Subscribe to changes. The listener receives NO arguments — it is expected
   * to read `store.view`, which is guaranteed to be a complete, consistent
   * snapshot at the moment it is called.
   */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /** Drop every subscriber. Idempotent; part of a complete teardown. */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.listeners.clear()
  }

  // -------------------------------------------------------------------------
  // Loading
  // -------------------------------------------------------------------------

  /**
   * Load every accessible character and rebuild the derived index.
   *
   * `listAllCharacters` walks all pages, so this never assumes the library fits
   * in one page. A failure leaves the previous data untouched and exposes a
   * UI-safe message.
   */
  async load(): Promise<void> {
    this.state.loadState = 'loading'
    this.state.loadError = null
    this.commit()

    let characters: LumiTagCharacter[]
    try {
      characters = await this.repo.listAllCharacters()
    } catch (error) {
      if (this.disposed) return
      this.state.loadState = 'error'
      this.state.loadError = uiSafeMessage(
        error,
        'LumiTag could not load your characters. Check that the extension has permission to read them.',
      )
      this.commit()
      return
    }

    if (this.disposed) return

    this.state.characters = Array.isArray(characters) ? characters.slice() : []
    this.state.tagIndex = buildTagIndex(this.state.characters)
    this.state.loadState = 'ready'
    this.state.loadError = null
    this.state.isRefreshing = false
    this.state.lastRefreshedAt = Date.now()
    this.pruneSelections()
    this.commit()
  }

  /**
   * Re-read only the characters an operation actually changed.
   *
   * `load()` is the only full read. After a write we know exactly which ids the
   * executor touched, so re-reading them and rebuilding the index keeps the
   * catalog truthful without paying for the whole library.
   */
  async refresh(
    affectedIds?: readonly string[],
    options: { deferSuccessCommit?: boolean } = {},
  ): Promise<void> {
    const ids = [...new Set((affectedIds ?? []).filter((id) => typeof id === 'string' && id !== ''))]
    if (ids.length === 0) return

    this.state.isRefreshing = true
    this.commit()

    let updated: Map<string, CharacterTags>
    try {
      updated = await this.repo.getTagsBatch(ids)
    } catch (error) {
      if (this.disposed) return
      this.state.isRefreshing = false
      // A refresh failure must not hide the library: keep the data and say why.
      this.state.loadError = uiSafeMessage(error, 'LumiTag could not refresh the changed characters.')
      this.commit()
      return
    }

    if (this.disposed) return

    this.state.isRefreshing = false
    this.patchCharacterTags(updated)
    this.state.lastRefreshedAt = Date.now()
    if (!options.deferSuccessCommit) {
      this.commit()
    }
  }

  /**
   * Merge a tags-only read into the records already held.
   *
   * Deliberately NOT `patchCharacters`: a batch read carries `{ id, tags }`, so
   * replacing a whole record with it would blank out every field the store does
   * not re-read — `name`, `description`, the rest — which is data loss wearing
   * the costume of a fresh read. Merging takes the one thing a bulk write can
   * actually have changed and leaves the body exactly as loaded.
   *
   * An id the backend could not read is left untouched, which is the same
   * honest outcome a failed re-read has always had: the previously known value
   * stands. An id the store has never loaded is skipped rather than appended,
   * because a tags-only payload has no body to merge into and appending one
   * would invent a nameless character.
   */
  private patchCharacterTags(updated: ReadonlyMap<string, CharacterTags>): void {
    if (updated.size === 0) return

    const next = this.state.characters.slice()
    const positions = new Map<string, number>()
    for (let i = 0; i < next.length; i++) positions.set((next[i] as LumiTagCharacter).id, i)

    for (const [id, tagsOnly] of updated) {
      const at = positions.get(id)
      if (at === undefined) continue
      next[at] = { ...(next[at] as LumiTagCharacter), tags: [...tagsOnly.tags] }
    }

    this.state.characters = next
    this.state.tagIndex = buildTagIndex(next)
    this.pruneSelections()
  }

  /** Replace changed records in place and rebuild the derived index. */
  private patchCharacters(updated: ReadonlyMap<string, LumiTagCharacter>): void {
    const next = this.state.characters.slice()
    const positions = new Map<string, number>()
    for (let i = 0; i < next.length; i++) positions.set((next[i] as LumiTagCharacter).id, i)

    for (const [id, character] of updated) {
      const at = positions.get(id)
      // A character that appeared since the last load is appended rather than
      // dropped, so a concurrent host-side create is not silently lost.
      if (at === undefined) next.push(character)
      else next[at] = character
    }

    this.state.characters = next
    this.state.tagIndex = buildTagIndex(next)
    this.pruneSelections()
  }

  /**
   * Drop selected ids/keys that no longer exist.
   *
   * Without this, a selection made before a write could point at a deleted tag
   * and silently produce an operation over nothing.
   */
  private pruneSelections(): void {
    const index = this.state.tagIndex
    for (const key of [...this.state.expandedTagKeys]) {
      if (!index.byKey.has(key)) this.state.expandedTagKeys.delete(key)
    }
    for (const key of [...this.state.selectedTagKeys]) {
      if (!index.byKey.has(key)) this.state.selectedTagKeys.delete(key)
    }
    for (const key of [...this.state.mergeTargetKeys]) {
      if (!index.byKey.has(key)) this.state.mergeTargetKeys.delete(key)
    }
    if (this.state.mergePrimaryKey !== null && !index.byKey.has(this.state.mergePrimaryKey)) {
      this.state.mergePrimaryKey = null
    }
    for (const key of [...this.state.activeFilterTagKeys]) {
      if (!index.byKey.has(key)) this.state.activeFilterTagKeys.delete(key)
    }
    const live = new Set(this.state.characters.map((c) => c.id))
    for (const id of [...this.state.selectedCharacterIds]) {
      if (!live.has(id)) this.state.selectedCharacterIds.delete(id)
    }
  }

  // -------------------------------------------------------------------------
  // Mutation execution
  // -------------------------------------------------------------------------

  /**
   * Plan over the FULL accessible set, execute, then re-read what changed.
   *
   * This is the single write path: `run*` actions only differ in how they build
   * their `PlanInput`. The refresh happens BEFORE the report is surfaced, so
   * the panel and the list can never disagree about what was saved.
   */
  private async runPlan(input: PlanInput): Promise<void> {
    const preview = planOperation(this.state.characters, input)
    const report = await this.executor.execute(preview)
    // The report publication below is the final commit for this operation.
    // Defer the successful refresh commit so we don't compute/publish the full
    // derived view twice back-to-back after a mutation.
    await this.refresh(report.results.map((r) => r.characterId), {
      deferSuccessCommit: true,
    })
    if (this.disposed) return
    this.addReport(report, true)
  }

  /**
   * Store a report, capped at {@link REPORT_LIMIT}, and surface it.
   *
   * A fully successful operation is stored too: it is the user's confirmation
   * that the change actually landed.
   */
  private addReport(report: OperationReport, activate: boolean): void {
    const existing = this.state.reports.findIndex((r) => r.opId === report.opId)
    if (existing >= 0) this.state.reports.splice(existing, 1)
    this.state.reports.push(report)
    if (this.state.reports.length > REPORT_LIMIT) {
      this.state.reports.splice(0, this.state.reports.length - REPORT_LIMIT)
    }
    if (activate) this.state.activeReportOpId = report.opId
    this.commit()
  }

  private async runRetry(
    opId: string,
    pick: (report: OperationReport) => Promise<OperationReport>,
  ): Promise<void> {
    const report = this.state.reports.find((r) => r.opId === opId)
    if (!report) return
    const updated = await pick(report)
    await this.refresh(updated.results.map((r) => r.characterId), {
      deferSuccessCommit: true,
    })
    if (this.disposed) return
    this.addReport(updated, true)
  }

  // -------------------------------------------------------------------------
  // View computation
  // -------------------------------------------------------------------------

  private commit(): void {
    this.version += 1
    this.snapshot = this.computeView()
    for (const listener of [...this.listeners]) {
      try {
        listener()
      } catch {
        // A throwing subscriber must not stop the others from being notified.
      }
    }
  }

  /** Build the character sub-rows for a tag's expanded sub-list. */
  private subRowsForTag(entry: { characterIds: string[] }): CharacterListRow[] {
    const byId = new Map<string, LumiTagCharacter>()
    for (const character of this.state.characters) byId.set(character.id, character)
    const out: CharacterListRow[] = []
    for (const id of entry.characterIds) {
      const character = byId.get(id)
      if (!character) continue
      out.push({
        character,
        tags: readTags(character),
        selected: this.state.selectedCharacterIds.has(character.id),
      })
    }
    out.sort((a, b) => compareStrings(nameKey(a.character), nameKey(b.character)))
    return out
  }

  private computeTagRows(): {
    rows: TagListRow[]
    errors: QuerySyntaxError[]
    isCharacterMode: boolean
    characters: CharacterListRow[]
  } {
    const s = this.state
    const parsed = parseQuery(s.tagQuery)
    const isCharacterMode = hasAnyQueryTerm(s.tagQuery)

    // In `C:` mode the query describes CHARACTERS, not tags. Falling back to a
    // tag-name search here would silently answer a different question, so the
    // tag list is empty in this mode and the character results take over.
    //
    // A malformed query is still evaluated best-effort — exactly as the
    // Characters section does — so `Elf -` still narrows the list to `Elf`
    // instead of matching the literal text `elf -` and showing nothing. Only
    // when the query parsed cleanly is the raw text used verbatim, so ordinary
    // typing keeps its exact substring semantics.
    const nameFiltered = isCharacterMode
      ? []
      : parsed.errors.length > 0
        ? filterByBestEffortTerms(s.tagIndex.tags, parsed.query)
        : filterTagsByName(s.tagIndex.tags, s.tagQuery)
    const sorted = sortTags(nameFiltered, s.tagSort)
    const rows = sorted.map((entry) => ({
      entry,
      expanded: s.expandedTagKeys.has(entry.key),
      selected: s.selectedTagKeys.has(entry.key),
    }))

    let characters: CharacterListRow[] = []
    if (isCharacterMode) {
      const matched = searchCharactersWithContext(parsed.query, s.characters)
      characters = matched.map((character) => ({
        character,
        tags: readTags(character),
        selected: s.selectedCharacterIds.has(character.id),
      }))
      characters.sort((a, b) => compareStrings(nameKey(a.character), nameKey(b.character)))
    }

    return { rows, errors: parsed.errors, isCharacterMode, characters }
  }

  private computeCharacterRows(): { rows: CharacterListRow[]; errors: QuerySyntaxError[] } {
    const s = this.state

    // The query is ALWAYS evaluated, including when it failed to parse: the
    // parser returns a best-effort query alongside its errors, and hiding
    // every match because of one dangling `-` would be worse than showing
    // slightly-off results next to a syntax error.
    const parsed = parseQuery(s.characterQuery)
    const searched = searchCharactersWithContext(parsed.query, s.characters)

    const filterTags = [...s.activeFilterTagKeys].map((key) => s.tagIndex.byKey.get(key)?.key ?? key)
    const filter = s.characterTagFilter

    const filtered = searched.filter((character) => {
      const keys = new Set(readTags(character).map((t) => t.toLowerCase()))
      switch (filter) {
        case 'all':
          return true
        case 'has_tags':
          return keys.size > 0
        case 'no_tags':
          return keys.size === 0
        case 'any':
          // With no active filter tags there is nothing to be "any of", so the
          // filter falls back to showing every otherwise-matching character.
          if (filterTags.length === 0) return true
          return filterTags.some((key) => keys.has(key))
        case 'all_of':
          if (filterTags.length === 0) return true
          return filterTags.every((key) => keys.has(key))
        default:
          return true
      }
    })

    const rows = filtered.map((character) => ({
      character,
      tags: readTags(character),
      selected: s.selectedCharacterIds.has(character.id),
    }))

    rows.sort((a, b) => {
      const byName = compareStrings(nameKey(a.character), nameKey(b.character))
      switch (s.characterSort) {
        case 'name_asc':
          return byName
        case 'name_zdesc':
          return -byName
        case 'tags_desc':
          return b.tags.length - a.tags.length || byName
        case 'tags_asc':
          return a.tags.length - b.tags.length || byName
        case 'has_tags_first':
          // More tags first; equal counts fall back to the SAME ascending name
          // tiebreak every other mode uses. Inverting it here made `has_tags_first`
          // the one mode whose tie order contradicted the others, so a list of
          // equally-tagged characters came out Z-A.
          return b.tags.length - a.tags.length ? 1 : byName
        case 'no_tags_first':
          return a.tags.length === 0 ? (b.tags.length === 0 ? byName : -1) : b.tags.length === 0 ? 1 : byName
        default:
          return byName
      }
    })

    return { rows, errors: parsed.errors }
  }

  private computeView(): StoreView {
    const s = this.state
    const tagSide = this.computeTagRows()
    const characterSide = this.computeCharacterRows()
    const selectedAssign = [...s.selectedAssignTagKeys].sort()

    return {
      section: s.section,
      loadState: s.loadState,
      loadError: s.loadError,
      isRefreshing: s.isRefreshing,
      characters: s.characters,
      characterCount: s.characters.length,
      tagIndex: s.tagIndex,
      tagRows: tagSide.rows,
      tagQuery: s.tagQuery,
      tagQueryErrors: tagSide.errors,
      tagQueryIsCharacterMode: tagSide.isCharacterMode,
      tagQueryCharacters: tagSide.characters,
      tagSort: s.tagSort,
      tagMode: s.tagMode,
      selectedTagKeys: [...s.selectedTagKeys].sort(),
      selectedTagCount: s.selectedTagKeys.size,
      mergePrimaryKey: s.mergePrimaryKey,
      mergeTargetKeys: [...s.mergeTargetKeys].sort(),
      mergeValid:
        s.mergePrimaryKey !== null &&
        s.mergeTargetKeys.size > 0 &&
        !s.mergeTargetKeys.has(s.mergePrimaryKey),
      characterRows: characterSide.rows,
      characterQuery: s.characterQuery,
      characterQueryErrors: characterSide.errors,
      characterSort: s.characterSort,
      characterTagFilter: s.characterTagFilter,
      activeFilterTagKeys: [...s.activeFilterTagKeys].sort(),
      selectedCharacterIds: [...s.selectedCharacterIds].sort(),
      selectedAssignTagKeys: selectedAssign,
      reports: [...s.reports],
      activeReportOpId: s.activeReportOpId,
      untaggedCount: s.characters.reduce((n, c) => (readTags(c).length === 0 ? n + 1 : n), 0),
      lastRefreshedAt: s.lastRefreshedAt,
    }
  }

  // -------------------------------------------------------------------------
  // Actions
  // -------------------------------------------------------------------------

  readonly actions: TagManagerActions = {
    refresh: async () => {
      await this.load()
    },

    setSection: (section) => {
      if (this.state.section === section) return
      this.state.section = section
      this.commit()
    },

    setTagQuery: (tagQuery) => {
      if (this.state.tagQuery === tagQuery) return
      this.state.tagQuery = tagQuery
      this.commit()
    },

    setTagSort: (tagSort) => {
      if (this.state.tagSort === tagSort) return
      this.state.tagSort = tagSort
      this.commit()
    },

    toggleTagExpanded: (key) => {
      const k = tagKey(key)
      if (k === '') return
      const set = this.state.expandedTagKeys
      if (set.has(k)) set.delete(k)
      else set.add(k)
      this.commit()
    },

    setTagMode: (tagMode) => {
      if (this.state.tagMode === tagMode) return
      this.state.tagMode = tagMode
      // The two bulk modes use disjoint state; carrying one into the other
      // would produce an operation the user never described.
      if (tagMode === 'merge') this.state.selectedTagKeys.clear()
      else {
        this.state.mergePrimaryKey = null
        this.state.mergeTargetKeys.clear()
      }
      this.commit()
    },

    setMergePrimary: (key) => {
      const k = key === null ? null : tagKey(key)
      if (k !== null && !this.state.tagIndex.byKey.has(k)) return
      if (this.state.mergePrimaryKey === k) return
      this.state.mergePrimaryKey = k
      // A tag cannot be its own merge target: promoting it to primary must
      // retire it from the target set, or the preview would be incoherent.
      if (k !== null) this.state.mergeTargetKeys.delete(k)
      this.commit()
    },

    toggleMergeTarget: (key) => {
      const k = tagKey(key)
      if (k === '') return
      if (k === this.state.mergePrimaryKey) return
      const set = this.state.mergeTargetKeys
      if (set.has(k)) set.delete(k)
      else set.add(k)
      this.commit()
    },

    toggleTagSelected: (key, selected) => {
      const k = tagKey(key)
      if (k === '') return
      const set = this.state.selectedTagKeys
      const next = selected ?? !set.has(k)
      if (set.has(k) === next) return
      if (next) set.add(k)
      else set.delete(k)
      this.commit()
    },

    selectAllVisibleTags: () => {
      // ONLY what the user can currently see — never the whole catalog.
      const visible = this.view.tagRows.map((row) => row.entry.key)
      const set = this.state.selectedTagKeys
      const before = set.size
      for (const key of visible) set.add(key)
      if (set.size === before) return
      this.commit()
    },

    clearTagSelection: () => {
      if (this.state.selectedTagKeys.size === 0) return
      this.state.selectedTagKeys.clear()
      this.commit()
    },

    exitTagMode: () => {
      if (
        this.state.tagMode === 'normal' &&
        this.state.selectedTagKeys.size === 0 &&
        this.state.mergePrimaryKey === null &&
        this.state.mergeTargetKeys.size === 0
      ) {
        return
      }
      this.state.tagMode = 'normal'
      this.state.selectedTagKeys.clear()
      this.state.mergePrimaryKey = null
      this.state.mergeTargetKeys.clear()
      this.commit()
    },

    setCharacterQuery: (characterQuery) => {
      if (this.state.characterQuery === characterQuery) return
      this.state.characterQuery = characterQuery
      this.commit()
    },

    setCharacterSort: (characterSort) => {
      if (this.state.characterSort === characterSort) return
      this.state.characterSort = characterSort
      this.commit()
    },

    setCharacterTagFilter: (characterTagFilter) => {
      if (this.state.characterTagFilter === characterTagFilter) return
      this.state.characterTagFilter = characterTagFilter
      this.commit()
    },

    setActiveFilterTags: (keys) => {
      const next = new Set((Array.isArray(keys) ? keys : []).map((k) => tagKey(k)).filter((k) => k !== ''))
      if (sameSet(next, this.state.activeFilterTagKeys)) return
      this.state.activeFilterTagKeys = next
      this.commit()
    },

    toggleCharacterSelected: (id, selected) => {
      if (typeof id !== 'string' || id === '') return
      const set = this.state.selectedCharacterIds
      const next = selected ?? !set.has(id)
      if (set.has(id) === next) return
      if (next) set.add(id)
      else set.delete(id)
      this.commit()
    },

    selectAllVisibleCharacters: () => {
      const visible = this.view.characterRows.map((row) => row.character.id)
      const set = this.state.selectedCharacterIds
      const before = set.size
      for (const id of visible) set.add(id)
      if (set.size === before) return
      this.commit()
    },

    clearCharacterSelection: () => {
      if (this.state.selectedCharacterIds.size === 0) return
      this.state.selectedCharacterIds.clear()
      this.commit()
    },

    setAssignTagSelection: (keys) => {
      const next = new Set((Array.isArray(keys) ? keys : []).map((k) => tagKey(k)).filter((k) => k !== ''))
      if (sameSet(next, this.state.selectedAssignTagKeys)) return
      this.state.selectedAssignTagKeys = next
      this.commit()
    },

    /**
     * Create a brand-new tag and assign it. The only action that mints a tag
     * name, so it is the only one that can hit a duplicate.
     */
    runCreateTagAndAssign: async (name, characterIds) => {
      const validation = validateNewTagName(name, this.state.tagIndex.tags)
      if (!validation.ok) {
        this.addReport(
          rejectedOperation('assign', 'Create tag', [name], validation.message),
          true,
        )
        return
      }
      await this.runPlan({ op: 'assign', tag: validation.value, selectedIds: characterIds })
    },

    runRenameTag: async (from, to) => {
      const validation = validateRenameTarget(to, from, this.state.tagIndex.tags)
      if (!validation.ok) {
        this.addReport(rejectedOperation('rename', `Rename ${from}`, [from], validation.message), true)
        return
      }
      await this.runPlan({ op: 'rename', from, to: validation.value })
    },

    runMergeTags: async (primary, targets) => {
      const distinct = [...new Set(targets.filter((t) => tagKey(t) !== tagKey(primary)))]
      if (distinct.length === 0) {
        this.addReport(
          rejectedOperation('merge', `Merge into ${primary}`, [primary], 'Pick at least one tag to merge in.'),
          true,
        )
        return
      }
      await this.runPlan({ op: 'merge', primary, targets: distinct })
    },

    /** Removes a tag from EVERY character that carries it, library-wide. */
    runDeleteTags: async (tags) => {
      if (!Array.isArray(tags) || tags.length === 0) return
      await this.runPlan({ op: 'delete', tags })
    },

    /** Additive: `planOperation` derives each target array from the original. */
    runBulkAssign: async (tags, characterIds) => {
      if (!Array.isArray(tags) || tags.length === 0) return
      if (!Array.isArray(characterIds) || characterIds.length === 0) return
      await this.runPlan({ op: 'assign', tags, selectedIds: characterIds })
    },

    /**
     * Remove one chip from one character — the only unconfirmed mutation.
     *
     * There is NO optimistic removal: the chip disappears only once the write
     * has been re-read and confirmed. A failed write must leave the chip
     * visible, because a chip that silently vanishes teaches the user the tags
     * are gone when they are not.
     */
    runRemoveChip: async (characterId, tag) => {
      const character = this.state.characters.find((c) => c.id === characterId)
      if (!character) return
      if (!readTags(character).some((t) => tagKey(t) === tagKey(tag))) return

      try {
        await this.repo.updateTags(characterId, readTags(character).filter((t) => tagKey(t) !== tagKey(tag)))
      } catch (error) {
        // Deliberately silent in LOCAL state: nothing was optimistically changed,
        // so there is nothing to roll back and the chip correctly stays put. But
        // "silent in local state" must not mean "invisible" — a failure that is
        // never recorded is indistinguishable from a success from the store's
        // side, so it goes through the same report mechanism as every other
        // write failure and lands in the failure panel.
        if (!this.disposed) {
          this.addReport(chipRemovalFailure(character, tag, classifyError(error)), true)
        }
        return
      }

      if (this.disposed) return

      // Confirm against the server before the chip is allowed to disappear.
      let confirmed: LumiTagCharacter | null = null
      try {
        confirmed = await this.repo.getCharacter(characterId)
      } catch {
        return
      }
      if (this.disposed) return

      if (confirmed) {
        this.patchCharacters(new Map([[confirmed.id, confirmed]]))
        this.state.lastRefreshedAt = Date.now()
        this.commit()
      } else {
        // The record is gone; fall back to the record the write returned so the
        // list does not keep rendering a character that no longer exists.
        this.state.characters = this.state.characters.filter((c) => c.id !== characterId)
        this.state.tagIndex = buildTagIndex(this.state.characters)
        this.commit()
      }
    },

    retryOne: async (opId, mutationId) => {
      await this.runRetry(opId, (report) => this.executor.retryOne(report, mutationId))
    },

    retryGroup: async (opId, groupKey) => {
      await this.runRetry(opId, (report) => this.executor.retryGroup(report, groupKey))
    },

    retryAll: async (opId) => {
      await this.runRetry(opId, (report) => this.executor.retryAll(report))
    },

    dismissReport: (opId) => {
      const at = this.state.reports.findIndex((r) => r.opId === opId)
      if (at < 0) return
      this.state.reports.splice(at, 1)
      if (this.state.activeReportOpId === opId) {
        const last = this.state.reports[this.state.reports.length - 1]
        this.state.activeReportOpId = last ? last.opId : null
      }
      this.commit()
    },

    showReport: (opId) => {
      if (this.state.activeReportOpId === opId) return
      if (opId !== null && !this.state.reports.some((r) => r.opId === opId)) return
      this.state.activeReportOpId = opId
      this.commit()
    },

    searchHelp: (context) => getSearchHelpSections(context),
  }
}

/**
 * Filter the tag catalog by the name terms that SURVIVED a failed parse.
 *
 * The Characters section evaluates the parser's best-effort query so a single
 * dangling `-` never blanks the list. This is the same courtesy for the Tags
 * section: `Elf -` filters down to `Elf` instead of filtering on the literal
 * text `elf -` and matching nothing.
 *
 * Only `name` terms are used — a `T:`/`A:` term says nothing about a tag's
 * NAME, so applying it here would filter on a syntax the tag list does not
 * speak. Negated name terms are skipped for the same reason `filterTagsByName`
 * is a plain positive substring match. With no usable name term at all, the
 * catalog is returned unfiltered: showing everything beats showing nothing.
 */
function filterByBestEffortTerms(tags: readonly TagEntry[], query: ParsedQuery): TagEntry[] {
  const nameTerms: string[] = []
  for (const group of query.groups) {
    for (const term of group.terms) {
      if (term.field === 'name' && !term.negated && term.value !== '') nameTerms.push(term.value)
    }
  }
  if (nameTerms.length === 0) return [...tags]

  let out: readonly TagEntry[] = tags
  for (const term of nameTerms) out = filterTagsByName(out, term)
  return out === tags ? [...tags] : [...out]
}

function sameSet(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  if (a.size !== b.size) return false
  for (const value of a) if (!b.has(value)) return false
  return true
}

/**
 * A report describing one chip removal whose write threw.
 *
 * Chip removal is the only mutation that never goes through the planner, so it
 * never goes through the executor either — which means this report is built by
 * hand rather than derived from an `OperationPreview`. It is deliberately a
 * FIRST-CLASS report, not a rejection: the write WAS attempted against the
 * server and failed, exactly like a bulk failure.
 *
 * The result is a real `MutationResult` rather than an empty list, so the
 * failure panel renders a row with the character, the intended change and the
 * server's reason — and so `retryOne` works: `MutationExecutor.retryOnce`
 * rebuilds the intent from `removedTags`, re-reads the character and writes
 * only if the tag is still there.
 *
 * `uncertain` is carried straight from `classifyError`, so a timeout that may
 * already have landed on the server is labelled as such instead of inviting a
 * blind second write.
 */
function chipRemovalFailure(
  character: LumiTagCharacter,
  tag: string,
  classified: ReturnType<typeof classifyError>,
): OperationReport {
  const now = Date.now()
  const opId = `chip-remove-${now.toString(36)}-${Math.random().toString(36).slice(2, 8)}`
  const name = readName(character)
  const result: MutationResult = {
    // Same derivation as the planner's `mutationId` (opId + characterId), so
    // this hand-built record is indistinguishable from a planned one to every
    // id-keyed consumer: `findResult`, the in-flight retry map, group retry.
    mutationId: `${opId}:${character.id}`,
    characterId: character.id,
    characterName: name,
    op: 'remove',
    tag,
    sourceTags: readTags(character),
    addedTags: [],
    removedTags: [tag],
    intendedChange: `Remove tag “${tag}” from ${name === '' ? 'this character' : name}`,
    state: 'failed',
    attempts: 1,
    error: { message: classified.message, ...(classified.code === undefined ? {} : { code: classified.code }) },
    retryable: classified.retryable,
    uncertain: classified.uncertain,
  }
  return {
    opId,
    op: 'remove',
    label: `Remove “${tag}” from ${name === '' ? 'this character' : name}`,
    tags: [tag],
    startedAt: now,
    finishedAt: now,
    status: 'failed',
    results: [result],
    // Same shape `computeTotals` derives for a single failed result: the counts
    // must never disagree with the `results` the panel reads.
    totals: { total: 1, succeeded: 0, failed: 1, remaining: 1 },
  }
}

/**
 * A report describing an operation the store refused to even plan.
 *
 * Rejections go through the same panel as real failures so the user always
 * finds out WHY nothing happened, instead of clicking a button that silently
 * does nothing. The reason is carried in `label` — the only free-text field
 * `OperationReport` has — so the failure panel can render it verbatim.
 */
function rejectedOperation(
  op: OperationReport['op'],
  label: string,
  tags: readonly string[],
  reason: string,
): OperationReport {
  const now = Date.now()
  return {
    opId: `rejected-${op}-${now.toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    op,
    label: `${label} — not applied: ${reason}`,
    tags: [...tags],
    startedAt: now,
    finishedAt: now,
    status: 'failed',
    results: [],
    totals: { total: 0, succeeded: 0, failed: 0, remaining: 0 },
  }
}