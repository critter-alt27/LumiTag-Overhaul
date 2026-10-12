import { describe, expect, test } from 'bun:test'

import { SEARCHABLE_FIELDS, type LumiTagCharacter } from '../src/shared/types'
import { parseQuery, type ParsedQuery } from '../src/frontend/search/parser'
import {
  buildMatchContext,
  evaluateQuery,
  evaluateQueryWithContext,
  matchTerm,
  searchCharacters,
  searchCharactersWithContext,
} from '../src/frontend/search/evaluator'

let seq = 0

function makeCharacter(overrides: Partial<LumiTagCharacter> = {}): LumiTagCharacter {
  seq += 1
  return {
    id: `char-${seq}`,
    name: 'Unnamed',
    description: '',
    personality: '',
    scenario: '',
    creator: '',
    creator_notes: '',
    system_prompt: '',
    tags: [],
    image_id: null,
    created_at: 0,
    updated_at: 0,
    ...overrides,
  }
}

function q(input: string): ParsedQuery {
  const result = parseQuery(input)
  if (!result.ok) {
    throw new Error(`Unexpected parse error for "${input}": ${JSON.stringify(result.errors)}`)
  }
  return result.query
}

function ids(characters: LumiTagCharacter[]): string[] {
  return characters.map((c) => c.id)
}

/** Explicit fixture library. Field values are chosen so each one is unique. */
function makeFixtures(): LumiTagCharacter[] {
  return [
    makeCharacter({
      id: 'elf-mage',
      name: 'Aria the Wise',
      tags: ['Elf', 'Magic'],
      description: 'A scholar of the northern reaches.',
      creator: 'Rowan',
    }),
    makeCharacter({
      id: 'elf-dark',
      name: 'Thorn Blackbriar',
      tags: ['Elf', 'Dark'],
      description: 'A lurking blade.',
      creator: 'Rowan',
    }),
    makeCharacter({
      id: 'elfking',
      name: 'Grimwell',
      tags: ['ElfKing'],
      description: 'Ruler of the elves.',
      creator: 'Mira',
    }),
    makeCharacter({
      id: 'human-warrior',
      name: 'Bran Stonehand',
      tags: ['Human', 'Warrior'],
      description: 'A stubborn fighter.',
      personality: 'Brave and direct.',
      creator: 'Mira',
    }),
    makeCharacter({
      id: 'johnny',
      // Deliberately named so that "John" appears only in non-name fields.
      name: 'Eliza Marsh',
      tags: ['Human'],
      description: 'An orchard keeper named John for short.',
      creator_notes: 'Originally written by John Steinbeck.',
      scenario: 'An autumn valley.',
      personality: 'Warm and chatty.',
    }),
    makeCharacter({
      id: 'no-tags',
      name: 'Nameless Wanderer',
      tags: [],
      description: 'Nothing at all is known.',
    }),
  ]
}

describe('bare name search', () => {
  const fixtures = makeFixtures()

  test('matches a substring of the name', () => {
    const result = searchCharacters(q('aria'), fixtures)
    expect(ids(result)).toEqual(['elf-mage'])
  })

  test('is case-insensitive', () => {
    expect(ids(searchCharacters(q('ARIA'), fixtures))).toEqual(['elf-mage'])
    expect(ids(searchCharacters(q('wIsE'), fixtures))).toEqual(['elf-mage'])
  })

  test('matches in the middle of a name', () => {
    expect(ids(searchCharacters(q('the'), fixtures))).toEqual(['elf-mage'])
  })

  test('does not match other fields for a bare term', () => {
    // "scholar" only appears in the description, and a bare term is name-only.
    expect(searchCharacters(q('scholar'), fixtures)).toEqual([])
  })
})

describe('T: tag search', () => {
  const fixtures = makeFixtures()

  test('matches the whole tag name', () => {
    expect(ids(searchCharacters(q('T:Elf'), fixtures)).sort()).toEqual([
      'elf-dark',
      'elf-mage',
    ])
  })

  test('is case-insensitive for the value', () => {
    expect(ids(searchCharacters(q('T:ELF'), fixtures)).sort()).toEqual([
      'elf-dark',
      'elf-mage',
    ])
    expect(ids(searchCharacters(q('T:eLf'), fixtures)).sort()).toEqual([
      'elf-dark',
      'elf-mage',
    ])
  })

  test('does NOT substring-match longer tag names', () => {
    // Grimwell is tagged ElfKing, which is not Elf.
    expect(searchCharacters(q('T:Elf'), fixtures)).not.toContain(
      fixtures.find((c) => c.id === 'elfking')!,
    )
    expect(ids(searchCharacters(q('T:Elf'), fixtures))).not.toContain('elfking')
    // ...but the exact tag name does match it.
    expect(ids(searchCharacters(q('T:ElfKing'), fixtures))).toEqual(['elfking'])
  })
})

describe('A: was removed and degrades to a name search', () => {
  test('SEARCHABLE_FIELDS is now name-only', () => {
    expect([...SEARCHABLE_FIELDS]).toEqual(['name'])
  })

  test('a retired A: term is a plain name search for the literal text', () => {
    const fixtures = makeFixtures()
    // The prefix is no longer special, so `A:Aria` searches names for the
    // SUBSTRING "a:aria" — which no name contains. It degrades rather than
    // erroring, so a saved query keeps running instead of failing.
    expect(ids(searchCharacters(q('A:Aria'), fixtures))).toEqual([])
    // The same characters without the retired prefix still match.
    expect(ids(searchCharacters(q('Aria'), fixtures))).toEqual(['elf-mage'])
  })

  test('prose fields are no longer reachable by any operator', () => {
    // The regression this guards: prose search is gone, so a value that only
    // exists in `description` must match NOTHING, not fall back to a field
    // search that still exists.
    const subject = makeCharacter({ description: 'zzunique-scholar-prose' })
    for (const query of ['A:zzunique-scholar-prose', 'zzunique-scholar-prose']) {
      expect(searchCharacters(q(query), [subject]), query).toEqual([])
    }
  })

  test('name and C: still work after the field list collapsed to one entry', () => {
    // `ctx.name` used to be derived by iterating SEARCHABLE_FIELDS; removing all
    // but `name` must not have emptied it.
    const fixtures = makeFixtures()
    expect(ids(searchCharacters(q('Aria'), fixtures))).toEqual(['elf-mage'])
    expect(ids(searchCharacters(q('C:Aria'), fixtures))).toEqual(['elf-mage'])
    expect(ids(searchCharacters(q('c:ARIA'), fixtures))).toEqual(['elf-mage'])
  })
})

describe('C: character search', () => {
  const fixtures = makeFixtures()

  test('matches by character name', () => {
    expect(ids(searchCharacters(q('C:Aria'), fixtures))).toEqual(['elf-mage'])
    expect(ids(searchCharacters(q('C:thOrN'), fixtures))).toEqual(['elf-dark'])
  })

  test('is not a search across other fields', () => {
    // Johnny's description mentions "John" but his name does not. With A:
    // removed there is no operator that can reach prose any more, so NO
    // operator finds him.
    expect(ids(searchCharacters(q('C:John'), fixtures))).toEqual([])
    expect(ids(searchCharacters(q('A:John'), fixtures))).toEqual([])
    expect(ids(searchCharacters(q('John'), fixtures))).toEqual([])
  })
})

describe('AND groups', () => {
  const fixtures = makeFixtures()

  test('T:Elf T:Magic requires both tags', () => {
    expect(ids(searchCharacters(q('T:Elf T:Magic'), fixtures))).toEqual(['elf-mage'])
  })

  test('a group with only one satisfied term does not match', () => {
    expect(ids(searchCharacters(q('T:Elf T:Warrior'), fixtures))).toEqual([])
  })
})

describe('OR groups', () => {
  const fixtures = makeFixtures()

  test('T:Elf, T:Magic matches either tag', () => {
    expect(ids(searchCharacters(q('T:Elf, T:Magic'), fixtures)).sort()).toEqual([
      'elf-dark',
      'elf-mage',
    ])
  })
})

describe('mixed AND/OR', () => {
  const fixtures = makeFixtures()

  test('C:John, T:Elf T:Magic reads as (C:John) OR (T:Elf AND T:Magic)', () => {
    const actual = ids(searchCharacters(q('C:John, T:Elf T:Magic'), fixtures)).sort()

    const orResult = ids(
      searchCharacters(q('C:John'), fixtures).concat(searchCharacters(q('T:Elf T:Magic'), fixtures)),
    )
    expect(actual).toEqual([...new Set(orResult)].sort())
    // `C:` is name-only, so the name arm contributes nobody here; the result is
    // the tag arm alone. The OR structure is what this test is about.
    expect(actual).toEqual(['elf-mage'])
  })
})

describe('negation', () => {
  const fixtures = makeFixtures()

  test('T:Elf -T:Dark excludes the Dark-tagged character', () => {
    expect(ids(searchCharacters(q('T:Elf -T:Dark'), fixtures))).toEqual(['elf-mage'])
  })

  test('a negated term does not match on unrelated tags', () => {
    // human-warrior has the Human tag but neither Elf nor Dark, so it must
    // not be pulled in by the negated -T:Dark term.
    const result = searchCharacters(q('T:Elf -T:Dark'), fixtures)
    expect(ids(result)).not.toContain('human-warrior')
  })

  test('a character with no tags does not match T:Elf -T:Dark', () => {
    expect(ids(searchCharacters(q('T:Elf -T:Dark'), fixtures))).not.toContain('no-tags')
  })

  test('a negated term alone matches everything without the excluded value', () => {
    expect(ids(searchCharacters(q('-T:Elf'), fixtures)).sort()).toEqual([
      'elfking',
      'human-warrior',
      'johnny',
      'no-tags',
    ])
  })
})

describe('case-insensitivity of prefixes and values', () => {
  const fixtures = makeFixtures()

  test('lowercase prefixes behave like uppercase ones', () => {
    expect(ids(searchCharacters(q('t:elf'), fixtures)).sort()).toEqual([
      'elf-dark',
      'elf-mage',
    ])
    expect(ids(searchCharacters(q('c:aria'), fixtures))).toEqual(['elf-mage'])
    expect(ids(searchCharacters(q('t:ELF'), fixtures)).sort()).toEqual([
      'elf-dark',
      'elf-mage',
    ])
  })
})

describe('empty query', () => {
  test('matches every character', () => {
    const fixtures = makeFixtures()
    expect(searchCharacters(q(''), fixtures).length).toBe(fixtures.length)
    expect(searchCharacters(q('   '), fixtures).length).toBe(fixtures.length)
    expect(searchCharacters(q(',,,'), fixtures).length).toBe(fixtures.length)
  })

  test('an explicitly empty parsed query matches every character', () => {
    const fixtures = makeFixtures()
    const empty: ParsedQuery = { groups: [], empty: true }
    expect(searchCharacters(empty, fixtures).length).toBe(fixtures.length)
  })
})

describe('defensive handling of missing tags', () => {
  test('null tags do not throw', () => {
    const subject = { ...makeCharacter({ id: 'null-tags' }), tags: null } as unknown as LumiTagCharacter
    expect(() => searchCharacters(q('T:Elf'), [subject])).not.toThrow()
    expect(searchCharacters(q('T:Elf'), [subject])).toEqual([])
  })

  test('undefined tags do not throw', () => {
    const subject = { ...makeCharacter({ id: 'undef-tags' }) }
    delete (subject as Partial<LumiTagCharacter>).tags
    expect(() => searchCharacters(q('T:Elf'), [subject])).not.toThrow()
    expect(searchCharacters(q('T:Elf'), [subject])).toEqual([])
  })

  test('a non-array tags value does not throw', () => {
    const subject = {
      ...makeCharacter({ id: 'bad-tags' }),
      tags: 'Elf',
    } as unknown as LumiTagCharacter
    expect(() => searchCharacters(q('T:Elf'), [subject])).not.toThrow()
    expect(searchCharacters(q('T:Elf'), [subject])).toEqual([])
  })

  test('a missing string field does not throw', () => {
    const subject = { ...makeCharacter({ id: 'missing-desc' }) }
    delete (subject as Partial<LumiTagCharacter>).description
    expect(() => searchCharacters(q('A:anything'), [subject])).not.toThrow()
  })
})

describe('empty term value (defensive)', () => {
  const fixtures = makeFixtures()

  test('an empty positive value matches nothing', () => {
    for (const field of ['name', 'tag', 'char'] as const) {
      const result = searchCharacters({ groups: [{ terms: [{ field, value: '', negated: false }] }], empty: false }, fixtures)
      expect(result, `empty ${field} value must not match`).toEqual([])
    }
  })

  test('an empty negated value matches everything', () => {
    const query: ParsedQuery = {
      groups: [{ terms: [{ field: 'tag', value: '', negated: true }] }],
      empty: false,
    }
    expect(searchCharacters(query, fixtures).length).toBe(fixtures.length)
  })
})

describe('purity', () => {
  test('does not mutate the input array or the characters', () => {
    const fixtures = makeFixtures()
    const before = JSON.stringify(fixtures)

    searchCharacters(q('T:Elf -T:Dark'), fixtures)
    searchCharacters(q('C:John, T:Elf T:Magic'), fixtures)

    expect(JSON.stringify(fixtures)).toBe(before)
  })

  test('does not mutate the parsed query', () => {
    const query = q('T:Elf, -T:Dark')
    const before = JSON.stringify(query)
    searchCharacters(query, makeFixtures())
    expect(JSON.stringify(query)).toBe(before)
  })

  test('returns a new array rather than the input array', () => {
    const fixtures = makeFixtures()
    const result = searchCharacters(q(''), fixtures)
    expect(result).not.toBe(fixtures)
    expect(result).toEqual(fixtures)
  })

  test('buildMatchContext does not mutate the character', () => {
    const subject = makeCharacter({ tags: ['Elf'] })
    const before = JSON.stringify(subject)
    buildMatchContext(subject)
    expect(JSON.stringify(subject)).toBe(before)
  })
})

describe('determinism', () => {
  const fixtures = makeFixtures()

  test('same input twice yields the same order', () => {
    const a = ids(searchCharacters(q('T:Elf, T:Human'), fixtures))
    const b = ids(searchCharacters(q('T:Elf, T:Human'), fixtures))
    expect(a).toEqual(b)
  })

  test('withContext and searchCharacters agree', () => {
    const query = q('A:John, T:Elf -T:Dark')
    const direct = searchCharacters(query, fixtures)
    const viaContext = searchCharactersWithContext(query, fixtures)
    expect(viaContext).toEqual(direct)
  })
})

describe('lower-level API', () => {
  const fixtures = makeFixtures()
  const ctx = buildMatchContext(fixtures[0])

  test('buildMatchContext lowercases the name and tag names', () => {
    expect(ctx.name).toBe('aria the wise')
    expect(ctx.tagKeys.has('elf')).toBe(true)
    expect(ctx.tagKeys.has('magic')).toBe(true)
  })

  test('matchTerm honours negation', () => {
    const ctx2 = buildMatchContext(fixtures.find((c) => c.id === 'elf-dark')!)
    expect(matchTerm({ field: 'tag', value: 'Elf', negated: false }, ctx2)).toBe(true)
    expect(matchTerm({ field: 'tag', value: 'Dark', negated: false }, ctx2)).toBe(true)
    expect(matchTerm({ field: 'tag', value: 'Dark', negated: true }, ctx2)).toBe(false)
    expect(matchTerm({ field: 'tag', value: 'Magic', negated: true }, ctx2)).toBe(true)
  })

  test('evaluateQueryWithContext agrees with evaluateQuery', () => {
    const query = q('T:Elf')
    for (const character of fixtures) {
      expect(evaluateQueryWithContext(query, buildMatchContext(character))).toBe(
        evaluateQuery(query, character),
      )
    }
  })

  test('buildMatchContext is reusable across calls without changing results', () => {
    const reused = buildMatchContext(fixtures[1])
    expect(evaluateQueryWithContext(q('T:Elf'), reused)).toBe(true)
    expect(evaluateQueryWithContext(q('T:Elf'), reused)).toBe(true)
    expect(evaluateQueryWithContext(q('T:Magic'), reused)).toBe(false)
  })
})

describe('large synthetic library', () => {
  function makeLibrary(count: number): LumiTagCharacter[] {
    const out: LumiTagCharacter[] = []
    for (let i = 0; i < count; i += 1) {
      const tags: string[] = []
      if (i % 2 === 0) tags.push('Elf')
      if (i % 3 === 0) tags.push('Magic')
      if (i % 5 === 0) tags.push('Dark')
      out.push(
        makeCharacter({
          id: `lib-${i}`,
          name: `Character ${i}`,
          tags,
          description: `Description for character ${i}`,
          creator: i % 2 === 0 ? 'Rowan' : 'Mira',
        }),
      )
    }
    return out
  }

  const library = makeLibrary(2000)

  test('returns the expected count for T:Elf', () => {
    // Even indices only.
    expect(searchCharacters(q('T:Elf'), library).length).toBe(1000)
  })

  test('returns the expected count for T:Elf -T:Dark', () => {
    const expected = Array.from({ length: 2000 }, (_, i) => i).filter(
      (i) => i % 2 === 0 && !(i % 5 === 0),
    ).length
    expect(searchCharacters(q('T:Elf -T:Dark'), library).length).toBe(expected)
  })

  test('handles mixed AND/OR correctly at scale', () => {
    const and = searchCharacters(q('T:Elf T:Magic'), library).length
    expect(and).toBe(Array.from({ length: 2000 }, (_, i) => i).filter((i) => i % 2 === 0 && i % 3 === 0).length)

    const or = searchCharacters(q('T:Elf, T:Dark'), library).length
    expect(or).toBe(Array.from({ length: 2000 }, (_, i) => i).filter((i) => i % 2 === 0 || i % 5 === 0).length)
  })

  test('an empty query returns the whole library', () => {
    expect(searchCharacters(q(''), library).length).toBe(library.length)
  })
})