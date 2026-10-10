import { describe, expect, test } from 'bun:test'

import { buildTagIndex } from '../src/frontend/tag-index'
import {
  TAG_SORT_LABELS,
  TAG_SORT_MODES,
  filterTagsByName,
  sortTags,
  type TagSortMode,
} from '../src/frontend/tag-sorting'
import type { TagEntry } from '../src/frontend/tag-index'

/** Deliberately shuffled, with deliberate tie groups. */
const SHUFFLED: TagEntry[] = [
  { name: 'Rogue', key: 'rogue', count: 2, characterIds: ['c3'] },
  { name: 'Elf', key: 'elf', count: 3, characterIds: ['c1', 'c2', 'c3'] },
  { name: 'magic', key: 'magic', count: 3, characterIds: ['c1'] },
  { name: 'Warrior', key: 'warrior', count: 1, characterIds: ['c2'] },
  { name: 'Arcane', key: 'arcane', count: 2, characterIds: ['c4'] },
  { name: 'bard', key: 'bard', count: 2, characterIds: ['c5'] },
]

function clone(): TagEntry[] {
  return SHUFFLED.map((t) => ({ ...t, characterIds: [...t.characterIds] }))
}

function keys(input: TagEntry[]): string[] {
  return input.map((t) => t.key)
}

describe('sort modes metadata', () => {
  test('every declared mode has a label', () => {
    expect(TAG_SORT_MODES).toEqual(['name_asc', 'name_zdesc', 'count_desc', 'count_asc', 'only_zero'])
    for (const mode of TAG_SORT_MODES) {
      expect(typeof TAG_SORT_LABELS[mode]).toBe('string')
      expect(TAG_SORT_LABELS[mode].length).toBeGreaterThan(0)
    }
  })
})

describe('sortTags', () => {
  test('name_asc orders case-insensitively by name', () => {
    expect(keys(sortTags(clone(), 'name_asc'))).toEqual(['arcane', 'bard', 'elf', 'magic', 'rogue', 'warrior'])
  })

  test('name_zdesc reverses name_asc with the same tie-breaking', () => {
    const asc = keys(sortTags(clone(), 'name_asc'))
    const desc = keys(sortTags(clone(), 'name_zdesc'))
    expect(desc).toEqual([...asc].reverse())
  })

  test('count_desc orders by count then key ascending', () => {
    // counts: elf 3, magic 3, arcane 2, bard 2, rogue 2, warrior 1
    expect(keys(sortTags(clone(), 'count_desc'))).toEqual([
      'elf',
      'magic',
      'arcane',
      'bard',
      'rogue',
      'warrior',
    ])
  })

  test('count_asc orders by count then key ascending', () => {
    expect(keys(sortTags(clone(), 'count_asc'))).toEqual([
      'warrior',
      'arcane',
      'bard',
      'rogue',
      'elf',
      'magic',
    ])
  })

  test('only_zero filters to count === 0 and fabricates nothing on a live catalog', () => {
    expect(sortTags(clone(), 'only_zero')).toEqual([])
  })

  test('only_zero does return genuine zero-count entries when present', () => {
    const withZero: TagEntry[] = [
      { name: 'Zeta', key: 'zeta', count: 0, characterIds: [] },
      { name: 'Alpha', key: 'alpha', count: 2, characterIds: ['c1'] },
    ]
    expect(keys(sortTags(withZero, 'only_zero'))).toEqual(['zeta'])
  })

  test('ties are broken deterministically by key ascending regardless of input order', () => {
    const forward = clone()
    const reversed = [...clone()].reverse()
    for (const mode of TAG_SORT_MODES) {
      expect(keys(sortTags(forward, mode))).toEqual(keys(sortTags(reversed, mode)))
    }
    // Shuffling repeatedly still yields the identical order.
    let current = clone()
    for (let i = 0; i < 5; i++) {
      current = current.slice(1).concat(current.slice(0, 1))
      expect(keys(sortTags(current, 'name_asc'))).toEqual(['arcane', 'bard', 'elf', 'magic', 'rogue', 'warrior'])
      expect(keys(sortTags(current, 'count_desc'))).toEqual(['elf', 'magic', 'arcane', 'bard', 'rogue', 'warrior'])
    }
  })

  test('repeated calls on the same input return equal output (purity)', () => {
    for (const mode of TAG_SORT_MODES) {
      const a = sortTags(clone(), mode)
      const b = sortTags(clone(), mode)
      const c = sortTags(clone(), mode)
      expect(a).toEqual(b)
      expect(b).toEqual(c)
      expect(keys(a)).toEqual(keys(b))
    }
  })

  test('sorting does not mutate the input array', () => {
    for (const mode of TAG_SORT_MODES) {
      const input = clone()
      const before = keys(input)
      const snapshot = input.map((t) => ({ ...t, characterIds: [...t.characterIds] }))
      sortTags(input, mode)
      expect(keys(input)).toEqual(before)
      expect(input).toEqual(snapshot)
    }
  })

  test('tolerates an empty or invalid list', () => {
    expect(sortTags([], 'name_asc')).toEqual([])
    expect(sortTags(null as unknown as TagEntry[], 'count_desc')).toEqual([])
    expect(sortTags(undefined as unknown as TagEntry[], 'only_zero')).toEqual([])
  })
})

describe('filterTagsByName', () => {
  test('matches case-insensitively on substrings of the display name', () => {
    expect(keys(filterTagsByName(clone(), 'ma'))).toEqual(['magic'])
    expect(keys(filterTagsByName(clone(), 'MA'))).toEqual(['magic'])
    // Filtering preserves the input order (it does not sort).
    expect(keys(filterTagsByName(clone(), 'ar'))).toEqual(['warrior', 'arcane', 'bard'])
    expect(keys(filterTagsByName(clone(), 'roGue'))).toEqual(['rogue'])
  })

  test('trims the query', () => {
    expect(keys(filterTagsByName(clone(), '  elf  '))).toEqual(['elf'])
  })

  test('empty and whitespace-only queries return the input unchanged', () => {
    const input = clone()
    expect(filterTagsByName(input, '')).toBe(input)
    expect(filterTagsByName(input, '   ')).toBe(input)
    expect(keys(filterTagsByName(input, ''))).toEqual(keys(SHUFFLED))
  })

  test('no match returns an empty array', () => {
    expect(filterTagsByName(clone(), 'zzz')).toEqual([])
  })

  test('does not mutate the input array', () => {
    const input = clone()
    const before = keys(input)
    filterTagsByName(input, 'ar')
    expect(keys(input)).toEqual(before)
  })

  test('tolerates an invalid list', () => {
    expect(filterTagsByName(null as unknown as TagEntry[], 'a')).toEqual([])
  })
})

describe('integration with the derived catalog', () => {
  test('only_zero on a freshly derived catalog is empty', () => {
    const index = buildTagIndex([
      { id: 'c1', name: 'A', description: '', personality: '', scenario: '', creator: '', creator_notes: '', system_prompt: '', tags: ['Elf', 'Magic'], image_id: null, created_at: 0, updated_at: 0 },
      { id: 'c2', name: 'B', description: '', personality: '', scenario: '', creator: '', creator_notes: '', system_prompt: '', tags: ['elf'], image_id: null, created_at: 0, updated_at: 0 },
    ])
    const modes: TagSortMode[] = [...TAG_SORT_MODES]
    expect(sortTags(index.tags, 'only_zero')).toEqual([])
    expect(sortTags(index.tags, modes[0])).toHaveLength(2)
    expect(index.tags.every((t) => t.count >= 1)).toBe(true)
  })
})
