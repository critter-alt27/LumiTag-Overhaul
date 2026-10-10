import { describe, expect, test } from 'bun:test'

import {
  buildTagIndex,
  charactersForTag,
  dedupeTagNames,
  findTagByKey,
  normalizeTagName,
  tagKey,
  tagsForCharacter,
  type TagIndex,
} from '../src/frontend/tag-index'
import type { LumiTagCharacter } from '../src/shared/types'

function character(id: string, name: string, tags?: unknown): LumiTagCharacter {
  return {
    id,
    name,
    description: '',
    personality: '',
    scenario: '',
    creator: '',
    creator_notes: '',
    system_prompt: '',
    tags: Array.isArray(tags) ? (tags as string[]) : [],
    image_id: null,
    created_at: 0,
    updated_at: 0,
  }
}

function rawCharacter(id: string, name: string, tags: unknown): LumiTagCharacter {
  return { ...character(id, name), tags } as unknown as LumiTagCharacter
}

const FIXTURE: LumiTagCharacter[] = [
  character('c1', 'Ayla', ['Elf', 'Magic']),
  character('c2', 'Bran', ['Elf', 'Warrior']),
  character('c3', 'Cira', ['Magic', 'Rogue', 'Elf']),
]

function names(index: TagIndex): string[] {
  return index.tags.map((t) => t.name)
}

describe('normalizeTagName / tagKey', () => {
  test('trims and rejects non-strings', () => {
    expect(normalizeTagName('  Elf  ')).toBe('Elf')
    expect(normalizeTagName('   ')).toBe('')
    expect(normalizeTagName('')).toBe('')
    expect(normalizeTagName(undefined)).toBe('')
    expect(normalizeTagName(null)).toBe('')
    expect(normalizeTagName(42)).toBe('')
    expect(normalizeTagName({})).toBe('')
  })

  test('key is trimmed and lowercased', () => {
    expect(tagKey('  ELF ')).toBe('elf')
    expect(tagKey('Elf')).toBe('elf')
  })
})

describe('dedupeTagNames', () => {
  test('drops empties and preserves first spelling and order', () => {
    expect(dedupeTagNames([' Elf', 'elf', 'ELF', 'Magic', '  ', 'magic'])).toEqual(['Elf', 'Magic'])
  })

  test('drops non-strings and tolerates non-arrays', () => {
    expect(dedupeTagNames(['Elf', 7, null, undefined, {}, 'Magic'])).toEqual(['Elf', 'Magic'])
    expect(dedupeTagNames(undefined as unknown as unknown[])).toEqual([])
  })
})

describe('buildTagIndex', () => {
  test('derives distinct tags from a multi-character fixture', () => {
    const index = buildTagIndex(FIXTURE)
    expect(names(index)).toEqual(['Elf', 'Magic', 'Rogue', 'Warrior'])
    expect(index.characterCount).toBe(3)
    expect([...index.byCharacterId.keys()].sort()).toEqual(['c1', 'c2', 'c3'])
  })

  test('assignment counts and character ids are correct', () => {
    const index = buildTagIndex(FIXTURE)
    expect(index.byKey.get('elf')!.count).toBe(3)
    expect(index.byKey.get('magic')!.count).toBe(2)
    expect(index.byKey.get('rogue')!.count).toBe(1)
    expect(charactersForTag(index, 'Warrior')).toEqual(['c2'])
    expect(tagsForCharacter(index, 'c3')).toEqual(['Magic', 'Rogue', 'Elf'])
  })

  test('tags are sorted by key ascending deterministically', () => {
    const index = buildTagIndex([...FIXTURE].reverse())
    expect(index.tags.map((t) => t.key)).toEqual(['elf', 'magic', 'rogue', 'warrior'])
  })

  test('a tag disappears once its last assignment is removed', () => {
    const before = buildTagIndex(FIXTURE)
    expect(findTagByKey(before, 'Rogue')).toBeDefined()

    const after = buildTagIndex([
      character('c1', 'Ayla', ['Elf', 'Magic']),
      character('c2', 'Bran', ['Elf', 'Warrior']),
      character('c3', 'Cira', ['Magic', 'Elf']),
    ])
    expect(findTagByKey(after, 'Rogue')).toBeUndefined()
    expect(findTagByKey(after, 'rogue')).toBeUndefined()
    expect(after.byKey.has('rogue')).toBe(false)
    expect(names(after)).not.toContain('Rogue')
  })

  test('duplicate assignments within one character count once', () => {
    const index = buildTagIndex([character('c1', 'Ayla', ['Elf', 'Elf', ' elf ', 'Elf'])])
    const entry = index.byKey.get('elf')!
    expect(entry.count).toBe(1)
    expect(entry.characterIds).toEqual(['c1'])
    expect(tagsForCharacter(index, 'c1')).toEqual(['Elf'])
  })

  test('case-variant spellings collapse into one entry keeping the first spelling', () => {
    const index = buildTagIndex([
      character('c1', 'Ayla', ['ELF']),
      character('c2', 'Bran', ['elf']),
    ])
    expect(names(index)).toEqual(['ELF'])
    const entry = index.byKey.get('elf')!
    expect(entry.name).toBe('ELF')
    expect(entry.count).toBe(2)
    expect(entry.characterIds).toEqual(['c1', 'c2'])
  })

  test('whitespace-only and non-string tag entries are dropped', () => {
    const index = buildTagIndex([rawCharacter('c1', 'Ayla', ['Elf', '   ', '', 5, null, undefined, 'Magic'])])
    expect(names(index)).toEqual(['Elf', 'Magic'])
  })

  test('duplicate character ids do not inflate counts', () => {
    const index = buildTagIndex([
      character('c1', 'Ayla', ['Elf', 'Magic']),
      character('c1', 'Ayla dup', ['Elf', 'Magic']),
      character('c2', 'Bran', ['Elf']),
    ])
    const elf = index.byKey.get('elf')!
    expect(elf.count).toBe(2)
    expect(new Set(elf.characterIds).size).toBe(elf.characterIds.length)
    expect(index.characterCount).toBe(2)
  })

  test('duplicate ids: last occurrence wins for the tag set', () => {
    const index = buildTagIndex([
      character('c1', 'Ayla', ['Magic']),
      character('c1', 'Ayla dup', ['Elf']),
    ])
    expect(tagsForCharacter(index, 'c1')).toEqual(['Elf'])
    expect(findTagByKey(index, 'Magic')).toBeUndefined()
    expect(index.byKey.get('elf')!.count).toBe(1)
  })

  test('null / empty / garbage character list yields an empty index without throwing', () => {
    const fromNull = buildTagIndex(null as unknown as LumiTagCharacter[])
    expect(fromNull.tags).toEqual([])
    expect(fromNull.byKey.size).toBe(0)
    expect(fromNull.byCharacterId.size).toBe(0)
    expect(fromNull.characterCount).toBe(0)

    const fromUndefined = buildTagIndex(undefined as unknown as LumiTagCharacter[])
    expect(fromUndefined.tags).toEqual([])

    const fromEmpty = buildTagIndex([])
    expect(fromEmpty.tags).toEqual([])

    const fromGarbage = buildTagIndex([null, undefined, {}] as unknown as LumiTagCharacter[])
    expect(fromGarbage.tags).toEqual([])
    expect(fromGarbage.characterCount).toBe(0)
  })

  test('characters with missing or non-array tags are treated as untagged', () => {
    const index = buildTagIndex([
      rawCharacter('c1', 'Ayla', undefined),
      rawCharacter('c2', 'Bran', null),
      rawCharacter('c3', 'Cira', 'Magic'),
      character('c4', 'Dova', ['Elf']),
    ])
    expect(names(index)).toEqual(['Elf'])
    expect(index.characterCount).toBe(4)
    expect(tagsForCharacter(index, 'c1')).toEqual([])
    expect(tagsForCharacter(index, 'c3')).toEqual([])
    expect(tagsForCharacter(index, 'c4')).toEqual(['Elf'])
  })

  test('a character with the same tag twice in different casing contributes one id', () => {
    const index = buildTagIndex([character('c1', 'Ayla', ['Elf', 'ELF', 'elf'])])
    const entry = index.byKey.get('elf')!
    expect(entry.characterIds).toEqual(['c1'])
    expect(entry.characterIds).toHaveLength(1)
    expect(entry.count).toBe(1)
  })
})

describe('lookups', () => {
  const index = buildTagIndex(FIXTURE)

  test('findTagByKey is case-insensitive and safe on unknown input', () => {
    expect(findTagByKey(index, 'elf')!.name).toBe('Elf')
    expect(findTagByKey(index, 'ELF')!.name).toBe('Elf')
    expect(findTagByKey(index, '  eLf ')!.name).toBe('Elf')
    expect(findTagByKey(index, 'nope')).toBeUndefined()
    expect(findTagByKey(index, '')).toBeUndefined()
    expect(findTagByKey(index, undefined as unknown as string)).toBeUndefined()
    expect(findTagByKey(null as unknown as TagIndex, 'elf')).toBeUndefined()
  })

  test('charactersForTag is case-insensitive, returns a copy, and is safe when absent', () => {
    expect(charactersForTag(index, 'magic')).toEqual(['c1', 'c3'])
    expect(charactersForTag(index, 'MAGIC')).toEqual(['c1', 'c3'])
    expect(charactersForTag(index, 'missing')).toEqual([])
    const first = charactersForTag(index, 'elf')
    first.push('mutated')
    expect(charactersForTag(index, 'elf')).toEqual(['c1', 'c2', 'c3'])
  })

  test('tagsForCharacter is case-insensitive on the id, returns a copy, safe when absent', () => {
    expect(tagsForCharacter(index, 'c2')).toEqual(['Elf', 'Warrior'])
    expect(tagsForCharacter(index, 'nope')).toEqual([])
    expect(tagsForCharacter(index, '')).toEqual([])
    expect(tagsForCharacter(index, undefined as unknown as string)).toEqual([])
    expect(tagsForCharacter(null as unknown as TagIndex, 'c2')).toEqual([])
    const first = tagsForCharacter(index, 'c2')
    first.push('mutated')
    expect(tagsForCharacter(index, 'c2')).toEqual(['Elf', 'Warrior'])
  })
})
