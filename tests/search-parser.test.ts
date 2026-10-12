import { describe, expect, test } from 'bun:test'
import {
  parseQuery,
  parseTokens,
  scanTokens,
  tokenize,
  type QueryGroup,
  type QueryTerm,
  type TermField,
} from '../src/frontend/search/parser'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a term, keeping the table-driven cases readable. */
function term(field: TermField, value: string, negated = false): QueryTerm {
  return { field, value, negated }
}

/** Assert on the exact group/term tree. */
function tree(groups: QueryGroup[]): Array<Array<[TermField, string, boolean]>> {
  return groups.map((group) => group.terms.map((t) => [t.field, t.value, t.negated]))
}

function parseOk(input: string) {
  const result = parseQuery(input)
  if (!result.ok) {
    throw new Error(`expected ${JSON.stringify(input)} to parse, got errors: ${JSON.stringify(result.errors)}`)
  }
  return result.query
}

// ---------------------------------------------------------------------------
// tokenize
// ---------------------------------------------------------------------------

describe('tokenize', () => {
  test('splits on whitespace and commas', () => {
    expect(tokenize('T:Elf T:Magic').tokens).toEqual(['T:Elf', 'T:Magic'])
    expect(tokenize('T:Elf, T:Magic').tokens).toEqual(['T:Elf', 'T:Magic'])
  })

  test('returns no tokens for empty or whitespace-only input', () => {
    expect(tokenize('').tokens).toEqual([])
    expect(tokenize('   ').tokens).toEqual([])
    expect(tokenize('\t \n ').tokens).toEqual([])
  })

  test('collapses repeated spaces and tabs', () => {
    expect(tokenize('T:Elf    T:Magic').tokens).toEqual(['T:Elf', 'T:Magic'])
    expect(tokenize('T:Elf\t\tT:Magic').tokens).toEqual(['T:Elf', 'T:Magic'])
    expect(tokenize('  T:Elf \t T:Magic  ').tokens).toEqual(['T:Elf', 'T:Magic'])
  })

  test('keeps punctuation inside term text', () => {
    expect(tokenize('Rin & Mei Sword-Art a.b').tokens).toEqual([
      'Rin',
      '&',
      'Mei',
      'Sword-Art',
      'a.b',
    ])
    expect(tokenize('-T:Dark').tokens).toEqual(['-T:Dark'])
    expect(tokenize('-').tokens).toEqual(['-'])
  })

  test('is deterministic', () => {
    expect(tokenize('C:John, T:Elf T:Magic')).toEqual(tokenize('C:John, T:Elf T:Magic'))
  })
})

describe('scanTokens', () => {
  test('records each token kind and start index', () => {
    expect(scanTokens('T:Elf T:Magic')).toEqual([
      { kind: 'term', text: 'T:Elf', index: 0 },
      { kind: 'term', text: 'T:Magic', index: 6 },
    ])
  })

  test('emits an explicit token per comma so empty groups are detectable', () => {
    expect(scanTokens('T:Elf,,T:Magic')).toEqual([
      { kind: 'term', text: 'T:Elf', index: 0 },
      { kind: 'comma', text: '', index: 5 },
      { kind: 'comma', text: '', index: 6 },
      { kind: 'term', text: 'T:Magic', index: 7 },
    ])
  })

  test('indexes point at the real offset after leading whitespace', () => {
    const tokens = scanTokens('   T:Elf, -')
    expect(tokens).toEqual([
      { kind: 'term', text: 'T:Elf', index: 3 },
      { kind: 'comma', text: '', index: 8 },
      { kind: 'term', text: '-', index: 10 },
    ])
  })

  test('treats a lone dash as a term token, not a special token', () => {
    expect(scanTokens('-')).toEqual([{ kind: 'term', text: '-', index: 0 }])
  })

  test('is deterministic', () => {
    expect(scanTokens('a,b')).toEqual(scanTokens('a,b'))
  })
})

// ---------------------------------------------------------------------------
// parseQuery — worked examples from the specification
// ---------------------------------------------------------------------------

describe('parseQuery — worked examples', () => {
  const cases: Array<[string, string, ReturnType<typeof tree>]> = [
    ['T:Elf T:Magic', 'AND of two tag terms', [[['tag', 'Elf', false], ['tag', 'Magic', false]]]],
    ['T:Elf, T:Magic', 'OR of two single-term groups', [[['tag', 'Elf', false]], [['tag', 'Magic', false]]]],
    [
      'C:John, T:Elf T:Magic',
      'mixed AND/OR: (C:John) OR (T:Elf AND T:Magic)',
      [[['char', 'John', false]], [['tag', 'Elf', false], ['tag', 'Magic', false]]],
    ],
    ['T:Elf -T:Dark', 'AND with negation', [[['tag', 'Elf', false], ['tag', 'Dark', true]]]],
    ['John', 'bare name term', [[['name', 'John', false]]]],
    ['C:John', 'character-name term', [[['char', 'John', false]]]],
  ]

  for (const [input, description, expected] of cases) {
    test(`${input} → ${description}`, () => {
      const result = parseQuery(input)
      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(tree(result.query.groups)).toEqual(expected)
    })
  }

  test('no prefix and C: produce different field kinds for the same value', () => {
    expect(parseOk('John').groups[0]!.terms[0]!.field).toBe('name')
    expect(parseOk('C:John').groups[0]!.terms[0]!.field).toBe('char')
  })
})

// ---------------------------------------------------------------------------
// parseQuery — prefixes
// ---------------------------------------------------------------------------

describe('parseQuery — prefixes', () => {
  test('recognises T: and C: and nothing else', () => {
    expect(parseOk('T:Elf').groups[0]!.terms[0]!.field).toBe('tag')
    expect(parseOk('C:Elf').groups[0]!.terms[0]!.field).toBe('char')
  })

  test('the retired A: prefix degrades to a plain name term', () => {
    // A: was removed rather than made an error, so a saved query using it keeps
    // working: it now means exactly what a bare term means.
    expect(parseOk('A:Elf').groups[0]!.terms[0]).toEqual(term('name', 'A:Elf'))
    expect(parseOk('-A:Goblin').groups[0]!.terms[0]).toEqual(term('name', 'A:Goblin', true))
  })

  test('prefix recognition is case-insensitive but value case is preserved', () => {
    expect(parseOk('t:elf').groups[0]!.terms[0]).toEqual(term('tag', 'elf'))
    expect(parseOk('c:JoHn').groups[0]!.terms[0]).toEqual(term('char', 'JoHn'))
  })

  test('an unknown prefix is NOT an error: the whole token is a bare name term', () => {
    const result = parseQuery('Z:foo')
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.errors).toEqual([])
    expect(result.query.groups).toEqual([{ terms: [term('name', 'Z:foo')] }])
  })

  test('ordinary text containing a colon still searches by name', () => {
    expect(parseOk('Time: 12').groups[0]!.terms[0]).toEqual(term('name', 'Time:'))
    // `3:1` has no recognised prefix, so it stays a name term rather than erroring.
    expect(tree(parseOk('ratio 3:1').groups)).toEqual([
      [
        ['name', 'ratio', false],
        ['name', '3:1', false],
      ],
    ])
  })

  test('colons after a recognised prefix stay in the value', () => {
    expect(parseOk('T:a:b').groups[0]!.terms[0]).toEqual(term('tag', 'a:b'))
    expect(parseOk('https://example.com').groups[0]!.terms[0]).toEqual(term('name', 'https://example.com'))
  })

  test('a bare token without a colon is a name term even if it is a prefix letter', () => {
    expect(parseOk('T').groups[0]!.terms[0]).toEqual(term('name', 'T'))
    expect(parseOk('tt').groups[0]!.terms[0]).toEqual(term('name', 'tt'))
  })
})

// ---------------------------------------------------------------------------
// parseQuery — whitespace
// ---------------------------------------------------------------------------

describe('parseQuery — whitespace handling', () => {
  test('ignores leading and trailing whitespace', () => {
    expect(tree(parseOk('  T:Elf T:Magic  ').groups)).toEqual([
      [['tag', 'Elf', false], ['tag', 'Magic', false]],
    ])
    expect(parseOk('\n T:Elf \t ').groups).toEqual(parseOk('T:Elf').groups)
  })

  test('ignores repeated spaces between terms', () => {
    expect(tree(parseOk('T:Elf     T:Magic').groups)).toEqual([
      [['tag', 'Elf', false], ['tag', 'Magic', false]],
    ])
  })

  test('treats tabs and newlines as term separators', () => {
    expect(tree(parseOk('T:Elf\tT:Magic').groups)).toEqual([
      [['tag', 'Elf', false], ['tag', 'Magic', false]],
    ])
    expect(tree(parseOk('T:Elf\nT:Magic').groups)).toEqual([
      [['tag', 'Elf', false], ['tag', 'Magic', false]],
    ])
    expect(tree(parseOk('\t T:Elf \t\t T:Magic \t').groups)).toEqual([
      [['tag', 'Elf', false], ['tag', 'Magic', false]],
    ])
  })

  test('values keep internal punctuation', () => {
    expect(tree(parseOk('T:Rin & Mei').groups)).toEqual([
      [
        ['tag', 'Rin', false],
        ['name', '&', false],
        ['name', 'Mei', false],
      ],
    ])
    expect(parseOk('a.b').groups[0]!.terms[0]).toEqual(term('name', 'a.b'))
    expect(parseOk('T:Sword-Art').groups[0]!.terms[0]).toEqual(term('tag', 'Sword-Art'))
    expect(parseOk('T:Fire/Ice').groups[0]!.terms[0]).toEqual(term('tag', 'Fire/Ice'))
  })
})

// ---------------------------------------------------------------------------
// parseQuery — empty groups
// ---------------------------------------------------------------------------

describe('parseQuery — empty groups', () => {
  const cases = ['T:Elf,,T:Magic', ',T:Elf,', 'T:Elf, ,T:Magic', ',,,', 'T:Elf,', ',T:Elf']

  for (const input of cases) {
    test(`${JSON.stringify(input)} → no error, empty groups ignored`, () => {
      const result = parseQuery(input)
      expect(result.ok).toBe(true)
      expect(result.errors).toEqual([])
    })
  }

  test('doubled commas collapse to the same tree as a single comma', () => {
    expect(parseOk('T:Elf,,T:Magic').groups).toEqual(parseOk('T:Elf,T:Magic').groups)
  })

  test('leading and trailing commas do not create empty groups', () => {
    expect(parseOk(',T:Elf,').groups).toEqual([{ terms: [term('tag', 'Elf')] }])
    expect(parseOk(',,,T:Elf,,,').groups).toEqual([{ terms: [term('tag', 'Elf')] }])
  })

  test('a query of only commas is treated as empty, not an error', () => {
    const result = parseQuery(',,,')
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.query.groups).toEqual([])
    expect(result.query.empty).toBe(true)
  })

  test('groups are never empty in the output tree', () => {
    for (const input of cases) {
      for (const group of parseOk(input).groups) {
        expect(group.terms.length).toBeGreaterThan(0)
      }
    }
  })
})

// ---------------------------------------------------------------------------
// parseQuery — empty query
// ---------------------------------------------------------------------------

describe('parseQuery — empty query', () => {
  for (const input of ['', '   ', '\t', '\n', '  \t \n ']) {
    test(`${JSON.stringify(input)} → empty query, ok:true, evaluator matches everything`, () => {
      const result = parseQuery(input)
      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(result.query).toEqual({ groups: [], empty: true })
    })
  }

  test('an empty query is not an error', () => {
    expect(parseQuery('').errors).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// parseQuery — negation
// ---------------------------------------------------------------------------

describe('parseQuery — negation', () => {
  test('negates bare terms', () => {
    expect(parseOk('-John').groups[0]!.terms[0]).toEqual(term('name', 'John', true))
  })

  test('negation applies to the whole predicate of prefixed terms', () => {
    expect(parseOk('-T:Elf').groups[0]!.terms[0]).toEqual(term('tag', 'Elf', true))
    expect(parseOk('-C:Elf').groups[0]!.terms[0]).toEqual(term('char', 'Elf', true))
  })

  test('negation is preserved with lowercase prefixes and mixed case values', () => {
    expect(parseOk('-t:DarkElf').groups[0]!.terms[0]).toEqual(term('tag', 'DarkElf', true))
  })

  test('negation combined with OR', () => {
    expect(tree(parseOk('T:Elf -T:Dark, T:Beast').groups)).toEqual([
      [
        ['tag', 'Elf', false],
        ['tag', 'Dark', true],
      ],
      [['tag', 'Beast', false]],
    ])
  })

  test('a negated term does not create a group on its own', () => {
    const query = parseOk('-T:Dark')
    expect(query.groups).toHaveLength(1)
    expect(query.groups[0]!.terms).toHaveLength(1)
    expect(query.groups[0]!.terms[0]!.negated).toBe(true)
  })

  test('multiple negations inside one group', () => {
    expect(tree(parseOk('T:Elf -T:Dark -C:Goblin').groups)).toEqual([
      [
        ['tag', 'Elf', false],
        ['tag', 'Dark', true],
        ['char', 'Goblin', true],
      ],
    ])
  })

  test('a leading dash inside a value is not negation', () => {
    expect(parseOk('Sword-Art').groups[0]!.terms[0]).toEqual(term('name', 'Sword-Art'))
    expect(parseOk('T:Sword-Art').groups[0]!.terms[0]).toEqual(term('tag', 'Sword-Art'))
    expect(parseOk('T:-Dark').groups[0]!.terms[0]).toEqual(term('tag', '-Dark'))
  })
})

// ---------------------------------------------------------------------------
// parseQuery — syntax errors
// ---------------------------------------------------------------------------

describe('parseQuery — empty prefixed terms', () => {
  for (const [input, field] of [
    ['T:', 'tag'],
    ['C:', 'char'],
    ['t:', 'tag'],
    ['c:', 'char'],
  ] as Array<[string, TermField]>) {
    test(`${JSON.stringify(input)} → syntax error`, () => {
      const result = parseQuery(input)
      expect(result.ok).toBe(false)
      if (result.ok) return
      expect(result.errors).toHaveLength(1)
      expect(result.errors[0]!.message).toContain('requires a value')
      expect(result.errors[0]!.token).toBe(input)
      expect(result.errors[0]!.index).toBe(0)
      expect(field).toBeTruthy()
    })
  }

  test('the error token and index point at the token, not the query', () => {
    const result = parseQuery('T:Elf C:')
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.errors[0]!.token).toBe('C:')
    expect(result.errors[0]!.index).toBe(6)
  })

  test('a negated empty prefixed term is still an error naming that token', () => {
    const result = parseQuery('-T:')
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.errors[0]!.message).toContain('`T:` requires a value')
    expect(result.errors[0]!.token).toBe('-T:')
  })
})

describe('parseQuery — dangling negation operator', () => {
  test('a token that is exactly "-" is a syntax error', () => {
    const result = parseQuery('-')
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.errors).toHaveLength(1)
    expect(result.errors[0]!.message).toContain('Dangling')
    expect(result.errors[0]!.token).toBe('-')
    expect(result.errors[0]!.index).toBe(0)
  })

  test('a dash surrounded by spaces is a dangling operator too', () => {
    const result = parseQuery('T:Elf - T:Magic')
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.errors).toHaveLength(1)
    expect(result.errors[0]!.token).toBe('-')
    expect(result.errors[0]!.index).toBe(6)
    // The surrounding well-formed terms survive for partial results.
    expect(tree(result.query.groups)).toEqual([
      [
        ['tag', 'Elf', false],
        ['tag', 'Magic', false],
      ],
    ])
  })
})

describe('parseQuery — multiple errors in one query', () => {
  test('reports both an empty prefixed term and a dangling "-"', () => {
    const result = parseQuery('T: -')
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.errors).toHaveLength(2)
    expect(result.errors[0]!.message).toContain('`T:` requires a value')
    expect(result.errors[1]!.message).toContain('Dangling')
    expect(result.errors.map((e) => e.index)).toEqual([0, 3])
  })

  test('reports every error, not just the first', () => {
    const result = parseQuery('T: - C: -')
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.errors).toHaveLength(4)
    expect(result.errors.map((e) => e.token)).toEqual(['T:', '-', 'C:', '-'])
    expect(result.errors.map((e) => e.index)).toEqual([0, 3, 5, 8])
  })

  test('still returns the well-formed terms alongside the errors', () => {
    const result = parseQuery('T:Elf T: -C:Goblin C:Rin')
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(tree(result.query.groups)).toEqual([
      [
        ['tag', 'Elf', false],
        ['char', 'Goblin', true],
        ['char', 'Rin', false],
      ],
    ])
    expect(result.errors).toHaveLength(1)
    expect(result.errors[0]!.token).toBe('T:')
  })
})

describe('parseQuery — best-effort results on error', () => {
  test('ok:false still carries a usable query object', () => {
    const result = parseQuery('T:Elf -')
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.query.groups).toEqual([{ terms: [term('tag', 'Elf')] }])
    expect(result.query.empty).toBe(false)
  })

  test('ok:true always carries an empty error list', () => {
    const result = parseQuery('T:Elf')
    expect(result.errors).toEqual([])
  })

  test('error messages are display-ready single sentences without jargon', () => {
    const samples = [parseQuery('T:'), parseQuery('-')]
    for (const result of samples) {
      expect(result.ok).toBe(false)
      if (result.ok) continue
      for (const error of result.errors) {
        expect(typeof error.message).toBe('string')
        expect(error.message.length).toBeGreaterThan(0)
        expect(error.message).not.toMatch(/Error:|undefined|null|\bat \w+/)
      }
    }
  })
})

// ---------------------------------------------------------------------------
// parseTokens — the isolated parsing stage
// ---------------------------------------------------------------------------

describe('parseTokens', () => {
  test('accepts tokens directly, bypassing raw-input scanning', () => {
    const output = parseTokens([
      { kind: 'term', text: 'T:Elf', index: 0 },
      { kind: 'comma', text: '', index: 6 },
      { kind: 'term', text: '-T:Dark', index: 7 },
    ])
    expect(output.errors).toEqual([])
    expect(tree(output.query.groups)).toEqual([
      [['tag', 'Elf', false]],
      [['tag', 'Dark', true]],
    ])
  })

  test('empty token list yields an empty query', () => {
    expect(parseTokens([]).query).toEqual({ groups: [], empty: true })
  })

  test('only commas yields an empty query with no errors', () => {
    expect(parseTokens([{ kind: 'comma', text: '', index: 0 }]).query).toEqual({ groups: [], empty: true })
  })
})

// ---------------------------------------------------------------------------
// Composition and determinism
// ---------------------------------------------------------------------------

describe('parseQuery — composition and determinism', () => {
  test('parseQuery equals scanTokens followed by parseTokens', () => {
    const input = 'C:John, T:Elf -T:Dark'
    expect(parseQuery(input)).toEqual({ ok: true, query: parseTokens(scanTokens(input)).query, errors: [] })
  })

  const inputs = [
    '',
    '   ',
    ',,,',
    'John',
    'C:John',
    'T:Elf T:Magic',
    'T:Elf, T:Magic',
    'C:John, T:Elf T:Magic',
    'T:Elf -T:Dark, T:Beast',
    'Z:foo',
    'A:John',
    't:elf c:john',
    'Rin & Mei',
    'T:',
    '-',
    'T: -',
  ]

  for (const input of inputs) {
    test(`parsing ${JSON.stringify(input)} twice yields deep-equal results`, () => {
      expect(parseQuery(input)).toEqual(parseQuery(input))
    })
  }

  test('parseTokens does not mutate or alias its input tokens', () => {
    const tokens = scanTokens('T:Elf T:Magic')
    const snapshot = structuredClone(tokens)
    parseTokens(tokens)
    expect(tokens).toEqual(snapshot)
  })
})