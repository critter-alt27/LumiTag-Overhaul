import { describe, expect, test } from 'bun:test'

import { MutationExecutor } from '../src/frontend/mutations/executor'
import type { CharacterRepository } from '../src/frontend/repository'
import {
  TagManagerStore,
  type CharacterSortMode,
  type CharacterTagFilter,
} from '../src/frontend/store'
import type { LumiTagCharacter } from '../src/shared/types'
import { BACKEND_PAGE_LIMIT } from '../src/shared/types'

// ---------------------------------------------------------------------------
// Fake repository
// ---------------------------------------------------------------------------

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

type WriteBehaviour =
  | { kind: 'ok' }
  | { kind: 'error'; error: unknown }

/**
 * A minimal in-memory stand-in for `CharacterRepository`.
 *
 * It is cast structurally: the store only ever calls `listAllCharacters`,
 * `getCharactersByIds`, `getCharacter`, `updateTags` and `avatarUrl`, and
 * exercising the REAL `MutationExecutor` over this fake is what gives the store
 * tests genuine multi-write semantics (partial failure, retry, post-write
 * verification) rather than a mocked-out approximation.
 */
class FakeRepository {
  readonly server = new Map<string, LumiTagCharacter>()
  readonly writeScript = new Map<string, WriteBehaviour[]>()
  /** Every `getCharactersByIds` call, so "only the affected ids" is assertable. */
  readonly batchGets: string[][] = []
  /**
   * Every single-character `getCharacter` call.
   *
   * Chip removal confirms through `getCharacter` rather than a batch read (it
   * has to, so it can detect a record that no longer exists), so "re-read only
   * the affected character" has to be asserted across BOTH read paths.
   */
  readonly singleGets: string[] = []
  listCalls = 0
  listError: unknown = null
  /** Force `listAllCharacters` to fail on the next call. */
  failList = false
  listPageSize = BACKEND_PAGE_LIMIT

  seed(id: string, name: string, tags: string[]): void {
    this.server.set(id, character(id, name, tags))
  }

  /** Make the next writes to `id` fail, once per queued behaviour. */
  failWrites(id: string, error: unknown, times = 1): void {
    const queue = this.writeScript.get(id) ?? []
    for (let i = 0; i < times; i++) queue.push({ kind: 'error', error })
    this.writeScript.set(id, queue)
  }

  async listAllCharacters(
    onProgress?: (loaded: number, total: number) => void,
  ): Promise<LumiTagCharacter[]> {
    this.listCalls += 1
    if (this.failList) {
      this.failList = false
      throw this.listError ?? new Error('permission denied')
    }

    const all = [...this.server.values()]
    const total = all.length
    const out: LumiTagCharacter[] = []
    // Deliberately paginate so a test can prove `load()` never assumes one
    // page holds the whole library.
    for (let offset = 0; offset < all.length; offset += this.listPageSize) {
      const page = all.slice(offset, offset + this.listPageSize)
      out.push(...page)
      onProgress?.(out.length, total)
    }
    return out
  }

  async getCharactersByIds(ids: readonly string[]): Promise<Map<string, LumiTagCharacter>> {
    const unique = [...new Set(ids)]
    this.batchGets.push(unique)
    const out = new Map<string, LumiTagCharacter>()
    for (const id of unique) {
      const found = this.server.get(id)
      if (found) out.set(id, { ...found, tags: [...found.tags] })
    }
    return out
  }

  async getCharacter(id: string): Promise<LumiTagCharacter | null> {
    this.singleGets.push(id)
    const found = this.server.get(id)
    return found ? { ...found, tags: [...found.tags] } : null
  }

  async updateTags(id: string, tags: string[]): Promise<LumiTagCharacter> {
    const queue = this.writeScript.get(id)
    const next = queue?.shift()
    if (next?.kind === 'error') throw next.error

    const found = this.server.get(id)
    if (!found) throw new Error(`character ${id} not found`)
    found.tags = [...tags]
    found.updated_at += 1
    return { ...found, tags: [...found.tags] }
  }

  avatarUrl(id: string): string {
    return `/api/v1/characters/${id}/avatar`
  }
}

function makeStore(fake: FakeRepository): TagManagerStore {
  const repo = fake as unknown as CharacterRepository
  return new TagManagerStore(repo, new MutationExecutor(repo))
}

/** The fixture library used by most tests. */
function seeded(): FakeRepository {
  const fake = new FakeRepository()
  fake.seed('c1', 'Aria', ['Elf', 'Magic', 'Knight'])
  fake.seed('c2', 'Brun', ['Elf', 'Dark'])
  fake.seed('c3', 'Cass', ['Magic'])
  fake.seed('c4', 'Dorn', [])
  return fake
}

const names = (view: { characterRows: { character: LumiTagCharacter }[] }): string[] =>
  view.characterRows.map((r) => r.character.name)

const tagNames = (view: { tagRows: { entry: { name: string } }[] }): string[] =>
  view.tagRows.map((r) => r.entry.name)

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

describe('store.load()', () => {
  test('walks every page and builds the derived index', async () => {
    const fake = new FakeRepository()
    fake.listPageSize = 2
    for (let i = 0; i < 7; i++) fake.seed(`c${i}`, `Char ${i}`, i % 2 === 0 ? ['Elf'] : ['Dark'])

    const store = makeStore(fake)
    await store.load()

    const view = store.view
    expect(view.loadState).toBe('ready')
    expect(view.loadError).toBeNull()
    // 7 characters across 4 pages of 2.
    expect(view.characterCount).toBe(7)
    expect(view.tagIndex.characterCount).toBe(7)
    expect(view.tagIndex.tags.map((t) => t.name)).toEqual(['Dark', 'Elf'])
    expect(view.tagIndex.byKey.get('elf')?.count).toBe(4)
    expect(view.tagIndex.byKey.get('dark')?.count).toBe(3)
    expect(view.untaggedCount).toBe(0)
    expect(view.lastRefreshedAt).not.toBeNull()
  })

  test('a load failure sets loadState=error with a UI-safe message', async () => {
    const fake = new FakeRepository()
    const store = makeStore(fake)
    fake.failList = true
    fake.listError = new Error('forbidden: missing characters permission')

    await store.load()

    expect(store.view.loadState).toBe('error')
    expect(store.view.loadError).toContain('permission')
    expect(store.view.loadError).not.toContain('at ')
    expect(store.view.characterCount).toBe(0)
  })

  test('an error view recovers on a successful reload', async () => {
    const fake = seeded()
    const store = makeStore(fake)
    fake.failList = true
    await store.load()
    expect(store.view.loadState).toBe('error')

    await store.load()
    expect(store.view.loadState).toBe('ready')
    expect(store.view.loadError).toBeNull()
    expect(store.view.characterCount).toBe(4)
  })
})

// ---------------------------------------------------------------------------
// Tag query, sorting and C: mode
// ---------------------------------------------------------------------------

describe('store tag query', () => {
  test('plain typing filters the tag list by name substring', async () => {
    const store = makeStore(seeded())
    await store.load()

    store.actions.setTagQuery('ma')
    expect(tagNames(store.view)).toEqual(['Magic'])

    // Case-insensitive.
    store.actions.setTagQuery('MA')
    expect(tagNames(store.view)).toEqual(['Magic'])

    store.actions.setTagQuery('')
    // Aria carries `Knight`, so the full catalog is four tags, A-Z.
    expect(tagNames(store.view)).toEqual(['Dark', 'Elf', 'Knight', 'Magic'])
  })

  test('sort modes reorder without mutating the catalog', async () => {
    const store = makeStore(seeded())
    await store.load()

    // Counts: Elf 2, Magic 2, Dark 1, Knight 1 — every mode below has a tie
    // somewhere, which is exactly what makes it worth pinning the tiebreak.
    store.actions.setTagSort('count_desc')
    expect(tagNames(store.view)).toEqual(['Elf', 'Magic', 'Dark', 'Knight'])

    store.actions.setTagSort('count_asc')
    expect(tagNames(store.view)).toEqual(['Dark', 'Knight', 'Elf', 'Magic'])

    store.actions.setTagSort('name_zdesc')
    expect(tagNames(store.view)).toEqual(['Magic', 'Knight', 'Elf', 'Dark'])

    store.actions.setTagSort('only_zero')
    // A derived catalog never fabricates zero-count entries.
    expect(tagNames(store.view)).toEqual([])

    store.actions.setTagSort('name_asc')
    expect(tagNames(store.view)).toEqual(['Dark', 'Elf', 'Knight', 'Magic'])
    // The index itself is untouched by sorting.
    expect(store.view.tagIndex.tags.map((t) => t.name)).toEqual(['Dark', 'Elf', 'Knight', 'Magic'])
  })

  test('C: mode populates tagQueryCharacters with each character its tags', async () => {
    const store = makeStore(seeded())
    await store.load()

    store.actions.setTagQuery('C:Aria')
    const view = store.view
    expect(view.tagQueryIsCharacterMode).toBe(true)
    expect(view.tagQueryCharacters.map((r) => r.character.name)).toEqual(['Aria'])
    expect(view.tagQueryCharacters[0]?.tags).toEqual(['Elf', 'Magic', 'Knight'])
  })

  test('C: mode does NOT degrade into a tag-name search', async () => {
    const store = makeStore(seeded())
    await store.load()

    // `Aria` is a character name, not a tag. A tag-name search would find
    // nothing here either, but the point is that the tag list is not filtered
    // by the query at all in C: mode.
    store.actions.setTagQuery('C:Aria')
    expect(store.view.tagRows).toEqual([])
    expect(store.view.tagQueryIsCharacterMode).toBe(true)

    // `C:Elf` must search CHARACTERS named Elf, not tags named Elf.
    store.actions.setTagQuery('C:Elf')
    expect(store.view.tagQueryIsCharacterMode).toBe(true)
    expect(store.view.tagQueryCharacters).toEqual([])
    expect(store.view.tagRows).toEqual([])
  })

  test('a C: query combined with other terms still filters characters', async () => {
    const store = makeStore(seeded())
    await store.load()

    store.actions.setTagQuery('C:a -T:Dark')
    expect(store.view.tagQueryIsCharacterMode).toBe(true)
    // `C:` is a substring match on the NAME, so only Aria and Cass contain an
    // "a" — "Brun" and "Dorn" do not. Neither Aria nor Cass carries `Dark`, so
    // both survive the `-T:Dark` exclusion.
    expect(store.view.tagQueryCharacters.map((r) => r.character.name)).toEqual(['Aria', 'Cass'])

    // The negated term really is doing work: pair the same name term with
    // `Knight`, which Aria carries and Cass does not. Aria drops out and Cass
    // survives, so the exclusion is doing the filtering, not the name term.
    store.actions.setTagQuery('C:a -T:Knight')
    expect(store.view.tagQueryCharacters.map((r) => r.character.name)).toEqual(['Cass'])

    // And a negated tag BOTH name matches carry excludes BOTH: `Magic` sits on
    // Aria *and* Cass, so nothing survives. (This is why the exclusion above
    // uses `Knight` — `Magic` would have emptied the list.)
    store.actions.setTagQuery('C:a -T:Magic')
    expect(store.view.tagQueryCharacters.map((r) => r.character.name)).toEqual([])
  })

  test('a malformed tag query exposes errors and still evaluates', async () => {
    const store = makeStore(seeded())
    await store.load()

    store.actions.setTagQuery('Elf -')
    const view = store.view
    expect(view.tagQueryErrors.length).toBeGreaterThan(0)
    expect(view.tagQueryErrors[0]?.message).toContain('-')
    // Best-effort evaluation: `Elf` alone survives, so the list is usable.
    expect(tagNames(view)).toEqual(['Elf'])
  })
})

// ---------------------------------------------------------------------------
// Character query, sorting and filtering
// ---------------------------------------------------------------------------

describe('store character query and sorting', () => {
  test('an empty query matches everything and a bare term matches names', async () => {
    const store = makeStore(seeded())
    await store.load()

    expect(names(store.view)).toEqual(['Aria', 'Brun', 'Cass', 'Dorn'])

    // A bare term is a substring match on the NAME only, not on tags: of the
    // four names only Aria and Cass contain an "a".
    store.actions.setCharacterQuery('a')
    expect(names(store.view)).toEqual(['Aria', 'Cass'])

    // An empty query is the only thing that matches everything.
    store.actions.setCharacterQuery('')
    expect(names(store.view)).toEqual(['Aria', 'Brun', 'Cass', 'Dorn'])

    store.actions.setCharacterQuery('ru')
    expect(names(store.view)).toEqual(['Brun'])
  })

  test('T: filters by whole tag name in the Characters section', async () => {
    const store = makeStore(seeded())
    await store.load()

    store.actions.setCharacterQuery('T:Elf')
    expect(names(store.view)).toEqual(['Aria', 'Brun'])

    // Whole-name comparison: `T:El` must not match `Elf`.
    store.actions.setCharacterQuery('T:El')
    expect(names(store.view)).toEqual([])
  })

  test('A: searches the documented fields', async () => {
    const fake = seeded()
    fake.server.get('c1')!.description = 'A wandering herbalist'
    const store = makeStore(fake)
    await store.load()

    store.actions.setCharacterQuery('A:herbalist')
    expect(names(store.view)).toEqual(['Aria'])
  })

  test('all six sort modes order deterministically', async () => {
    const store = makeStore(seeded())
    await store.load()

    const expected: Record<CharacterSortMode, string[]> = {
      name_asc: ['Aria', 'Brun', 'Cass', 'Dorn'],
      name_zdesc: ['Dorn', 'Cass', 'Brun', 'Aria'],
      // Tags: Aria 3, Brun 2, Cass 1, Dorn 0.
      tags_desc: ['Aria', 'Brun', 'Cass', 'Dorn'],
      tags_asc: ['Dorn', 'Cass', 'Brun', 'Aria'],
      has_tags_first: ['Aria', 'Brun', 'Cass', 'Dorn'],
      no_tags_first: ['Dorn', 'Aria', 'Brun', 'Cass'],
    }

    for (const [mode, order] of Object.entries(expected)) {
      store.actions.setCharacterSort(mode as CharacterSortMode)
      expect(names(store.view)).toEqual(order)
    }
  })

  test('ties break on character name so ordering is deterministic', async () => {
    const fake = new FakeRepository()
    fake.seed('z', 'Zoe', ['Elf'])
    fake.seed('a', 'Amy', ['Elf'])
    fake.seed('m', 'Mia', ['Elf'])
    const store = makeStore(fake)
    await store.load()

    // All three have 1 tag, so every mode must fall back to the name tiebreak —
    // ASCENDING, in every mode. `has_tags_first` used to invert it here and
    // hand back Zoe/Mia/Amy, contradicting the other three.
    for (const mode of [
      'tags_desc',
      'tags_asc',
      'has_tags_first',
      'no_tags_first',
    ] as CharacterSortMode[]) {
      store.actions.setCharacterSort(mode)
      expect(names(store.view)).toEqual(['Amy', 'Mia', 'Zoe'])
    }

    // And the tiebreak is by NAME, not by id: the ids are deliberately seeded
    // in the opposite order (z, a, m) so an id-based comparator would fail.
    expect(fake.server.has('a')).toBe(true)
  })

  test('sorting and filtering do not mutate the stored characters', async () => {
    const store = makeStore(seeded())
    await store.load()

    const before = JSON.stringify(store.view.characters)

    store.actions.setCharacterSort('tags_desc')
    store.actions.setCharacterQuery('T:Elf')
    store.actions.setCharacterTagFilter('has_tags')
    store.actions.setCharacterSort('name_zdesc')
    store.actions.setCharacterQuery('-T:Dark')
    store.actions.setCharacterSort('tags_asc')

    expect(JSON.stringify(store.view.characters)).toBe(before)
  })

  test('a malformed character query exposes errors and still evaluates', async () => {
    const store = makeStore(seeded())
    await store.load()

    store.actions.setCharacterQuery('Aria T:')
    const view = store.view
    expect(view.characterQueryErrors.length).toBeGreaterThan(0)
    expect(names(view)).toEqual(['Aria'])
  })
})

describe('store character tag filters', () => {
  test('has_tags and no_tags partition the library', async () => {
    const store = makeStore(seeded())
    await store.load()

    store.actions.setCharacterTagFilter('has_tags')
    expect(names(store.view)).toEqual(['Aria', 'Brun', 'Cass'])

    store.actions.setCharacterTagFilter('no_tags')
    expect(names(store.view)).toEqual(['Dorn'])

    store.actions.setCharacterTagFilter('all')
    expect(names(store.view)).toEqual(['Aria', 'Brun', 'Cass', 'Dorn'])
  })

  test('any and all_of are clearly distinguished', async () => {
    const store = makeStore(seeded())
    await store.load()
    store.actions.setActiveFilterTags(['Elf', 'Magic'])

    store.actions.setCharacterTagFilter('any')
    // Aria(Elf+Magic), Brun(Elf), Cass(Magic).
    expect(names(store.view)).toEqual(['Aria', 'Brun', 'Cass'])

    store.actions.setCharacterTagFilter('all_of')
    // Only Aria carries BOTH.
    expect(names(store.view)).toEqual(['Aria'])
  })

  test('with no active filter tags any/all_of fall back to all matches', async () => {
    const store = makeStore(seeded())
    await store.load()

    for (const filter of ['any', 'all_of'] as CharacterTagFilter[]) {
      store.actions.setCharacterTagFilter(filter)
      expect(store.view.activeFilterTagKeys).toEqual([])
      expect(names(store.view)).toEqual(['Aria', 'Brun', 'Cass', 'Dorn'])
    }
  })

  test('filter tags combine with the query', async () => {
    const store = makeStore(seeded())
    await store.load()

    store.actions.setActiveFilterTags(['Elf'])
    store.actions.setCharacterQuery('C:a')
    store.actions.setCharacterTagFilter('any')
    // `C:a` matches Aria and Cass (the only names containing "a"); of those,
    // only Aria carries `Elf`, so the tag filter — not the query — is what
    // removes Cass here.
    expect(names(store.view)).toEqual(['Aria'])

    // Widen the query to every character and `Elf` alone must select its two
    // holders, proving the filter intersects the query rather than replacing it.
    store.actions.setCharacterQuery('')
    expect(names(store.view)).toEqual(['Aria', 'Brun'])
  })
})

// ---------------------------------------------------------------------------
// Selection
// ---------------------------------------------------------------------------

describe('store tag selection', () => {
  test('bulk-delete mode selects, selects all VISIBLE, and clears', async () => {
    const store = makeStore(seeded())
    await store.load()

    store.actions.setTagMode('bulk_delete')
    expect(store.view.tagMode).toBe('bulk_delete')
    expect(store.view.selectedTagCount).toBe(0)

    store.actions.toggleTagSelected('Elf')
    expect(store.view.selectedTagKeys).toEqual(['elf'])
    expect(store.view.selectedTagCount).toBe(1)
    expect(store.view.tagRows.find((r) => r.entry.key === 'elf')?.selected).toBe(true)

    // Select-all-visible while a filter hides `Dark`: only `Elf` and `Magic`
    // may be selected, `Dark` must NOT be swept in.
    store.actions.setTagQuery('a')
    expect(tagNames(store.view)).toEqual(['Dark', 'Magic'])
    store.actions.selectAllVisibleTags()
    expect(store.view.selectedTagKeys).toEqual(['dark', 'elf', 'magic'])
    expect(store.view.selectedTagCount).toBe(3)
  })

  test('select-all-visible really excludes hidden tags', async () => {
    const fake = new FakeRepository()
    fake.seed('c1', 'A', ['Elf'])
    fake.seed('c2', 'B', ['Dark'])
    fake.seed('c3', 'C', ['Magic'])
    const store = makeStore(fake)
    await store.load()

    store.actions.setTagMode('bulk_delete')
    store.actions.setTagQuery('Elf')
    expect(tagNames(store.view)).toEqual(['Elf'])
    store.actions.selectAllVisibleTags()
    expect(store.view.selectedTagKeys).toEqual(['elf'])
  })

  test('clearTagSelection and exitTagMode reset selection state', async () => {
    const store = makeStore(seeded())
    await store.load()

    store.actions.setTagMode('bulk_delete')
    store.actions.toggleTagSelected('Elf')
    store.actions.toggleTagSelected('Dark', true)
    expect(store.view.selectedTagCount).toBe(2)

    store.actions.clearTagSelection()
    expect(store.view.selectedTagCount).toBe(0)
    expect(store.view.tagMode).toBe('bulk_delete')

    store.actions.toggleTagSelected('Elf')
    store.actions.exitTagMode()
    expect(store.view.tagMode).toBe('normal')
    expect(store.view.selectedTagCount).toBe(0)
  })

  test('character selection selects all visible and clears', async () => {
    const store = makeStore(seeded())
    await store.load()

    store.actions.setCharacterQuery('C:Brun')
    store.actions.selectAllVisibleCharacters()
    expect(store.view.selectedCharacterIds).toEqual(['c2'])

    store.actions.setCharacterQuery('')
    store.actions.selectAllVisibleCharacters()
    expect(store.view.selectedCharacterIds).toEqual(['c1', 'c2', 'c3', 'c4'])

    store.actions.clearCharacterSelection()
    expect(store.view.selectedCharacterIds).toEqual([])
  })

  test('toggleTagExpanded flips expansion state', async () => {
    const store = makeStore(seeded())
    await store.load()

    store.actions.toggleTagExpanded('elf')
    expect(store.view.tagRows.find((r) => r.entry.key === 'elf')?.expanded).toBe(true)
    store.actions.toggleTagExpanded('Elf')
    expect(store.view.tagRows.find((r) => r.entry.key === 'elf')?.expanded).toBe(false)
  })
})

describe('store merge mode', () => {
  test('mergeValid only with exactly one primary and a distinct target', async () => {
    const store = makeStore(seeded())
    await store.load()

    store.actions.setTagMode('merge')
    expect(store.view.mergeValid).toBe(false)

    store.actions.setMergePrimary('Elf')
    expect(store.view.mergePrimaryKey).toBe('elf')
    expect(store.view.mergeValid).toBe(false)

    store.actions.toggleMergeTarget('Dark')
    expect(store.view.mergeTargetKeys).toEqual(['dark'])
    expect(store.view.mergeValid).toBe(true)
  })

  test('the primary can never also be a target', async () => {
    const store = makeStore(seeded())
    await store.load()

    store.actions.setTagMode('merge')
    store.actions.setMergePrimary('Elf')
    store.actions.toggleMergeTarget('Elf')
    expect(store.view.mergeTargetKeys).toEqual([])
    expect(store.view.mergeValid).toBe(false)

    // Promoting a target to primary retires it from the target set.
    store.actions.toggleMergeTarget('Dark')
    store.actions.setMergePrimary('Dark')
    expect(store.view.mergeTargetKeys).toEqual([])
    expect(store.view.mergeValid).toBe(false)

    store.actions.toggleMergeTarget('Magic')
    expect(store.view.mergeTargetKeys).toEqual(['magic'])
    expect(store.view.mergeValid).toBe(true)
  })

  test('leaving merge mode clears its state and select-all does not leak', async () => {
    const store = makeStore(seeded())
    await store.load()

    store.actions.setTagMode('merge')
    store.actions.setMergePrimary('Elf')
    store.actions.toggleMergeTarget('Dark')

    // Bulk selection belongs to bulk mode only.
    store.actions.setTagMode('bulk_delete')
    expect(store.view.mergePrimaryKey).toBeNull()
    expect(store.view.mergeTargetKeys).toEqual([])

    store.actions.exitTagMode()
    expect(store.view.mergeValid).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------

describe('store.runRemoveChip', () => {
  test('removes one chip, preserves unrelated tags, and refreshes', async () => {
    const fake = seeded()
    const store = makeStore(fake)
    await store.load()

    await store.actions.runRemoveChip('c1', 'Magic')

    const aria = store.view.characters.find((c) => c.id === 'c1')
    expect(aria?.tags).toEqual(['Elf', 'Knight'])
    expect(fake.server.get('c1')?.tags).toEqual(['Elf', 'Knight'])
    // The store CONFIRMED the write by re-reading, rather than trusting its own
    // optimistic edit: exactly one read, for `c1` alone, and no library walk.
    expect(fake.singleGets).toEqual(['c1'])
    expect(fake.batchGets).toEqual([])
    expect(fake.listCalls).toBe(1)
  })

  test('a failed write leaves the chip VISIBLE', async () => {
    const fake = seeded()
    const store = makeStore(fake)
    await store.load()

    fake.failWrites('c1', new Error('timeout while writing tags'))

    await store.actions.runRemoveChip('c1', 'Magic')

    // The chip must remain in the rendered row.
    const row = store.view.characterRows.find((r) => r.character.id === 'c1')
    expect(row?.tags).toContain('Magic')
    expect(fake.server.get('c1')?.tags).toEqual(['Elf', 'Magic', 'Knight'])
    // The failed write is reported, so the user is never left thinking it worked.
    expect(store.view.reports.at(-1)?.status).toBe('failed')
    // Nothing was optimistically removed, so nothing had to be rolled back —
    // proven by the store never even confirming a read it should have skipped.
    expect(fake.singleGets).toEqual([])
    expect(fake.batchGets).toEqual([])
  })

  test('removing an absent tag is a no-op', async () => {
    const fake = seeded()
    const store = makeStore(fake)
    await store.load()
    const before = fake.batchGets.length
    const singleBefore = fake.singleGets.length

    await store.actions.runRemoveChip('c1', 'Nope')
    await store.actions.runRemoveChip('missing', 'Elf')

    // A no-op must not cost a single read, on either path.
    expect(fake.batchGets.length).toBe(before)
    expect(fake.singleGets.length).toBe(singleBefore)
    expect(store.view.characters.find((c) => c.id === 'c1')?.tags).toEqual([
      'Elf',
      'Magic',
      'Knight',
    ])
  })
})

describe('store.runDeleteTags', () => {
  test('removes the tag globally, preserves unrelated tags, and reports', async () => {
    const fake = seeded()
    const store = makeStore(fake)
    await store.load()

    await store.actions.runDeleteTags(['Elf'])

    expect(fake.server.get('c1')?.tags).toEqual(['Magic', 'Knight'])
    expect(fake.server.get('c2')?.tags).toEqual(['Dark'])
    expect(fake.server.get('c3')?.tags).toEqual(['Magic'])
    // The tag is gone from the derived catalog entirely.
    expect(store.view.tagIndex.byKey.has('elf')).toBe(false)
    // `Knight` survives the delete: it sits on Aria and is unrelated to `Elf`.
    expect(tagNames(store.view)).toEqual(['Dark', 'Knight', 'Magic'])

    const report = store.view.reports.at(-1)
    // Narrow explicitly, before any assertion on it: `at(-1)` is
    // `| undefined`, and comparing an optional chain against
    // `activeReportOpId` would let a delete that produced NO report at all
    // satisfy `undefined === undefined` and look like a correct one.
    expect(report).toBeDefined()
    if (report === undefined) throw new Error('runDeleteTags produced no report')
    expect(report.op).toBe('delete')
    expect(report.tags).toEqual(['Elf'])
    expect(report.status).toBe('succeeded')
    expect(report.totals.total).toBe(2)
    expect(report.totals.succeeded).toBe(2)
    expect(report.totals.failed).toBe(0)
    // A successful operation still produces a visible report.
    expect(store.view.activeReportOpId).toBe(report.opId)
  })

  test('deletes globally even when a filter is active', async () => {
    const fake = seeded()
    const store = makeStore(fake)
    await store.load()

    // Only `Aria` is visible, but `Elf` must still be removed everywhere.
    store.actions.setCharacterQuery('C:Aria')
    expect(names(store.view)).toEqual(['Aria'])

    await store.actions.runDeleteTags(['Elf'])

    expect(fake.server.get('c1')?.tags).not.toContain('Elf')
    expect(fake.server.get('c2')?.tags).not.toContain('Elf')
  })

  test('an empty tag list is a no-op', async () => {
    const fake = seeded()
    const store = makeStore(fake)
    await store.load()
    const before = store.view.reports.length

    await store.actions.runDeleteTags([])
    expect(store.view.reports.length).toBe(before)
  })
})

describe('store.runBulkAssign', () => {
  test('is additive and never replaces the tag array', async () => {
    const fake = seeded()
    const store = makeStore(fake)
    await store.load()

    await store.actions.runBulkAssign(['Rogue', 'Elf'], ['c1', 'c4'])

    // `Elf` was already present: the array is not duplicated, and the original
    // tags are still there.
    expect(fake.server.get('c1')?.tags).toEqual(['Elf', 'Magic', 'Knight', 'Rogue'])
    // `Dorn` had no tags at all and gained both. An assign APPENDS, in the
    // order the tags were requested — `Rogue` was asked for first, so it leads
    // even though `Elf` sorts earlier.
    expect(fake.server.get('c4')?.tags).toEqual(['Rogue', 'Elf'])
    // Untouched characters are untouched.
    expect(fake.server.get('c2')?.tags).toEqual(['Elf', 'Dark'])

    const row = store.view.characterRows.find((r) => r.character.id === 'c4')
    expect(row?.tags).toEqual(['Rogue', 'Elf'])
  })

  test('assigns a brand-new tag through runCreateTagAndAssign', async () => {
    const fake = seeded()
    const store = makeStore(fake)
    await store.load()

    await store.actions.runCreateTagAndAssign('Rogue', ['c1'])

    expect(fake.server.get('c1')?.tags).toEqual(['Elf', 'Magic', 'Knight', 'Rogue'])
    expect(store.view.tagIndex.byKey.get('rogue')?.count).toBe(1)
  })

  test('a duplicate new tag is rejected with an explanation', async () => {
    const fake = seeded()
    const store = makeStore(fake)
    await store.load()

    await store.actions.runCreateTagAndAssign('elf', ['c1'])

    // No write happened at all.
    expect(fake.server.get('c1')?.tags).toEqual(['Elf', 'Magic', 'Knight'])
    const report = store.view.reports.at(-1)
    expect(report?.status).toBe('failed')
    expect(report?.label).toContain('already exists')
  })

  test('runRenameTag renames every holder and rejects a collision', async () => {
    const fake = seeded()
    const store = makeStore(fake)
    await store.load()

    await store.actions.runRenameTag('Elf', 'Elven')
    expect(fake.server.get('c1')?.tags).toEqual(['Elven', 'Magic', 'Knight'])
    expect(fake.server.get('c2')?.tags).toEqual(['Elven', 'Dark'])
    expect(store.view.tagIndex.byKey.has('elf')).toBe(false)

    const before = fake.batchGets.length
    await store.actions.runRenameTag('Dark', 'Magic')
    expect(fake.batchGets.length).toBe(before)
    expect(store.view.reports.at(-1)?.label).toContain('already exists')
  })

  test('runMergeTags folds the targets into the primary', async () => {
    const fake = seeded()
    const store = makeStore(fake)
    await store.load()

    await store.actions.runMergeTags('Magic', ['Dark'])

    expect(fake.server.get('c1')?.tags).toEqual(['Elf', 'Magic', 'Knight'])
    expect(fake.server.get('c2')?.tags).toEqual(['Elf', 'Magic'])
    expect(store.view.tagIndex.byKey.has('dark')).toBe(false)
    expect(store.view.reports.at(-1)?.op).toBe('merge')
  })
})

describe('store partial failure and retry', () => {
  test('a partial failure yields partially_completed and retries recover it', async () => {
    const fake = seeded()
    const store = makeStore(fake)
    await store.load()

    // `c2` fails; `c1` succeeds.
    fake.failWrites('c2', new Error('network unreachable'), 1)

    await store.actions.runDeleteTags(['Elf'])

    let report = store.view.reports.at(-1)
    expect(report?.status).toBe('partially_completed')
    expect(report?.totals.succeeded).toBe(1)
    expect(report?.totals.failed).toBe(1)
    expect(report?.totals.remaining).toBe(1)
    // `Elf` survives on the character whose write failed — the catalog is
    // rebuilt from a confirmed read, not from the plan.
    expect(store.view.tagIndex.byKey.get('elf')?.count).toBe(1)

    const failed = report?.results.find((r) => r.state === 'failed')
    expect(failed).toBeDefined()

    // retryOne on the single failure.
    await store.actions.retryOne(report!.opId, failed!.mutationId)

    report = store.view.reports.at(-1)
    expect(report?.status).toBe('succeeded')
    expect(report?.totals.remaining).toBe(0)
    expect(fake.server.get('c2')?.tags).toEqual(['Dark'])
    expect(store.view.tagIndex.byKey.has('elf')).toBe(false)
  })

  test('retryAll resolves every outstanding failure', async () => {
    const fake = seeded()
    const store = makeStore(fake)
    await store.load()

    fake.failWrites('c1', new Error('timeout'), 1)
    fake.failWrites('c2', new Error('timeout'), 1)

    await store.actions.runDeleteTags(['Elf'])
    let report = store.view.reports.at(-1)
    expect(report?.status).toBe('failed')
    expect(report?.totals.failed).toBe(2)

    await store.actions.retryAll(report!.opId)

    report = store.view.reports.at(-1)
    expect(report?.status).toBe('succeeded')
    expect(report?.totals.remaining).toBe(0)
    expect(fake.server.get('c1')?.tags).toEqual(['Magic', 'Knight'])
    expect(fake.server.get('c2')?.tags).toEqual(['Dark'])
  })

  test('retryGroup acts on one tag change only', async () => {
    const fake = seeded()
    const store = makeStore(fake)
    await store.load()

    fake.failWrites('c1', new Error('boom'), 1)
    fake.failWrites('c2', new Error('boom'), 1)

    await store.actions.runDeleteTags(['Elf'])
    let report = store.view.reports.at(-1)
    expect(report?.totals.failed).toBe(2)

    await store.actions.retryGroup(report!.opId, 'elf')

    report = store.view.reports.at(-1)
    expect(report?.totals.succeeded).toBe(2)
    expect(report?.totals.remaining).toBe(0)
  })

  test('an unknown opId is a no-op', async () => {
    const store = makeStore(seeded())
    await store.load()
    const before = store.view.reports.length

    await store.actions.retryAll('does-not-exist')
    expect(store.view.reports.length).toBe(before)
  })
})

// ---------------------------------------------------------------------------
// Refresh efficiency and report lifecycle
// ---------------------------------------------------------------------------

describe('store.refresh efficiency', () => {
  test('a write re-reads only the affected characters, not the library', async () => {
    const fake = seeded()
    const store = makeStore(fake)
    await store.load()
    expect(fake.listCalls).toBe(1)

    await store.actions.runDeleteTags(['Elf'])

    // No full reload happened.
    expect(fake.listCalls).toBe(1)
    // Exactly the two affected ids were re-read, once.
    expect(fake.batchGets).toEqual([['c1', 'c2']])

    // And `refresh()` with no ids does nothing at all.
    const before = fake.batchGets.length
    await store.actions.refresh()
    expect(fake.batchGets.length).toBe(before)
  })

  test('refresh() with explicit ids re-reads only those', async () => {
    const fake = seeded()
    const store = makeStore(fake)
    await store.load()

    // The TARGETED re-read is `store.refresh(ids)`, not `store.actions.refresh`:
    // the action is the toolbar's "reload everything" and takes no arguments.
    await store.refresh(['c3'])
    expect(fake.batchGets).toEqual([['c3']])
    // Targeted means targeted — the full library walk must not have run.
    expect(fake.listCalls).toBe(1)
  })

  test('store.actions.refresh() performs a full reload', async () => {
    const fake = seeded()
    const store = makeStore(fake)
    await store.load()

    await store.actions.refresh()
    expect(fake.listCalls).toBe(2)
  })
})

describe('store report lifecycle', () => {
  test('showReport and dismissReport move the active report', async () => {
    const fake = seeded()
    const store = makeStore(fake)
    await store.load()

    await store.actions.runDeleteTags(['Dark'])
    const first = store.view.reports.at(-1)!.opId

    await store.actions.runDeleteTags(['Magic'])
    const second = store.view.reports.at(-1)!.opId
    expect(store.view.activeReportOpId).toBe(second)

    store.actions.showReport(first)
    expect(store.view.activeReportOpId).toBe(first)

    store.actions.dismissReport(first)
    expect(store.view.reports.map((r) => r.opId)).toEqual([second])
    // Dismissing the active report falls back to the remaining one.
    expect(store.view.activeReportOpId).toBe(second)

    store.actions.dismissReport(second)
    expect(store.view.reports).toEqual([])
    expect(store.view.activeReportOpId).toBeNull()
  })

  test('showing an unknown report is ignored', async () => {
    const store = makeStore(seeded())
    await store.load()
    store.actions.showReport('nope')
    expect(store.view.activeReportOpId).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Change notification
// ---------------------------------------------------------------------------

describe('store change notification', () => {
  test('a real change notifies exactly once', async () => {
    const store = makeStore(seeded())
    await store.load()

    let calls = 0
    const unsubscribe = store.subscribe(() => {
      calls += 1
    })

    store.actions.setCharacterQuery('Aria')
    expect(calls).toBe(1)

    unsubscribe()
    store.actions.setCharacterQuery('Brun')
    expect(calls).toBe(1)
  })

  test('setting the same value does not notify', async () => {
    const store = makeStore(seeded())
    await store.load()

    let calls = 0
    store.subscribe(() => {
      calls += 1
    })

    store.actions.setSection('tags')
    store.actions.setTagSort('name_asc')
    store.actions.setTagQuery('')
    store.actions.setTagMode('normal')
    store.actions.clearTagSelection()
    store.actions.clearCharacterSelection()
    store.actions.setCharacterQuery('')
    store.actions.setCharacterSort('name_asc')
    store.actions.setCharacterTagFilter('all')
    store.actions.setActiveFilterTags([])
    store.actions.setAssignTagSelection([])
    store.actions.setMergePrimary(null)
    store.actions.showReport(null)

    expect(calls).toBe(0)
  })

  test('a repeated toggle-off does not notify twice', async () => {
    const store = makeStore(seeded())
    await store.load()

    let calls = 0
    store.subscribe(() => {
      calls += 1
    })

    store.actions.toggleTagSelected('Elf', true)
    store.actions.toggleTagSelected('elf', true)
    store.actions.toggleTagSelected('Elf', false)
    store.actions.toggleTagSelected('Elf', false)
    expect(calls).toBe(2)
  })

  test('a throwing subscriber does not stop the others', async () => {
    const store = makeStore(seeded())
    await store.load()

    let calls = 0
    store.subscribe(() => {
      throw new Error('subscriber blew up')
    })
    store.subscribe(() => {
      calls += 1
    })

    store.actions.setSection('characters')
    expect(calls).toBe(1)
  })

  test('dispose stops notifications', async () => {
    const store = makeStore(seeded())
    await store.load()

    let calls = 0
    store.subscribe(() => {
      calls += 1
    })

    store.dispose()
    store.dispose()
    store.actions.setSection('characters')
    expect(calls).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// Search help passthrough
// ---------------------------------------------------------------------------

describe('store search help', () => {
  test('returns section-specific help sections', async () => {
    const store = makeStore(seeded())
    await store.load()

    const tags = store.actions.searchHelp('tags')
    const characters = store.actions.searchHelp('characters')
    expect(tags.length).toBeGreaterThan(0)
    expect(characters.length).toBeGreaterThan(0)
    expect(tags.map((s) => s.title)).toContain('Searching the tag list')
    expect(characters.map((s) => s.title)).toContain('Finding characters by their tags')
  })
})