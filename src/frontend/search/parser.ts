/**
 * LumiTag search query parser.
 *
 * Grammar (LumiTag spec, section 6):
 *
 *   query     := group (',' group)*
 *   group     := term (WS+ term)*
 *   term      := '-'? (prefixed | bare)
 *   prefixed  := ('T' | 'A' | 'C') ':' value   // prefix matched case-insensitively
 *   bare      := value                          // character-name search
 *
 * - Whitespace means AND within a group.
 * - Commas mean OR between groups.
 * - A leading `-` negates the whole predicate of the term it prefixes.
 * - Only whitespace and `,` delimit; every other character is part of the
 *   value, so `Rin & Mei`, `Sword-Art` and `a.b` survive intact.
 * - Only `T:`, `A:` and `C:` are prefixes. Anything else containing a colon
 *   (e.g. `Z:foo`) is plain text and becomes a bare name term, so ordinary
 *   search stays usable.
 *
 * Architecture: this file is strictly tokenizer + parser. Matching lives in the
 * evaluator, which consumes `ParsedQuery`.
 *
 * Original case is preserved here on purpose; the evaluator lowercases when
 * matching so prefix/value case never affects matching semantics.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Which part of a character a term targets. */
export type TermField = 'name' | 'tag' | 'any' | 'char'

export interface QueryTerm {
  field: TermField
  /** Value with surrounding whitespace trimmed; case preserved. */
  value: string
  /** True when the term was written with a leading `-`. */
  negated: boolean
}

export interface QueryGroup {
  /** AND-joined terms. Never empty. */
  terms: QueryTerm[]
}

export interface ParsedQuery {
  /** OR-joined groups. Empty means "match everything". */
  groups: QueryGroup[]
  /** True when the input held no terms at all (blank, or only commas). */
  empty: boolean
}

export interface QuerySyntaxError {
  /** Human-readable, suitable for direct display in the UI. */
  message: string
  /** The offending token, when one can be identified. */
  token?: string
  /** Character index in the original input where the problem starts. */
  index: number
}

export type ParseResult =
  | { ok: true; query: ParsedQuery; errors: [] }
  | { ok: false; query: ParsedQuery; errors: QuerySyntaxError[] }

// ---------------------------------------------------------------------------
// Stage 1: tokenization
// ---------------------------------------------------------------------------

/**
 * A single lexical unit. `comma` tokens carry no text and mark a group
 * boundary; `term` tokens carry the token text plus its index in the original
 * input so errors can point at the right character.
 */
export type TokenKind = 'term' | 'comma'

export interface QueryToken {
  kind: TokenKind
  /** Trimmed token text; `''` for commas. */
  text: string
  /** Index of the token's first character in the original input. */
  index: number
}

const WHITESPACE = /\s/

/**
 * Split raw input into term/comma tokens, retaining each token's start index.
 *
 * Whitespace (spaces, tabs, newlines and runs of them) is collapsed; every
 * comma becomes its own token, which is what lets the parser tell an ignorable
 * empty group (`a,,b`) apart from a dangling `-`.
 */
export function scanTokens(input: string): QueryToken[] {
  const tokens: QueryToken[] = []
  const length = input.length
  let i = 0

  while (i < length) {
    const char = input[i]!

    if (WHITESPACE.test(char)) {
      i++
      continue
    }

    if (char === ',') {
      tokens.push({ kind: 'comma', text: '', index: i })
      i++
      continue
    }

    // A term runs until the next whitespace or comma. Colons, dashes, ampersands
    // and dots are all ordinary value characters.
    const start = i
    while (i < length && !WHITESPACE.test(input[i]!) && input[i] !== ',') i++
    tokens.push({ kind: 'term', text: input.slice(start, i).trim(), index: start })
  }

  return tokens
}

/**
 * Convenience wrapper returning only term texts, in order.
 *
 * Group boundaries are not represented here; use `scanTokens` when grouping or
 * token positions matter.
 */
export function tokenize(input: string): { tokens: string[] } {
  const tokens: string[] = []
  for (const token of scanTokens(input)) {
    if (token.kind === 'term') tokens.push(token.text)
  }
  return { tokens }
}

// ---------------------------------------------------------------------------
// Stage 2: parsing
// ---------------------------------------------------------------------------

/** `T:`, `A:` or `C:` — matched case-insensitively, value captured verbatim. */
const PREFIX_PATTERN = /^([TAC]):(.*)$/i

/** Canonical (upper-case) prefix spelling for each recognised prefix. */
const PREFIX_FIELDS = {
  T: 'tag',
  A: 'any',
  C: 'char',
} as const satisfies Record<string, TermField>

/** Canonical prefix spelling used in error messages, keyed by field. */
const FIELD_PREFIX: Record<TermField, string> = {
  name: '',
  tag: 'T:',
  any: 'A:',
  char: 'C:',
}

interface TermResolution {
  term?: QueryTerm
  error?: QuerySyntaxError
}

/**
 * Resolve one term token: negation first, then prefix, then emptiness.
 *
 * A malformed term yields an error and no term, so the parser can drop it and
 * still return the surrounding well-formed terms.
 */
function resolveTerm(token: QueryToken): TermResolution {
  const raw = token.text

  // Negation. A leading `-` is only meaningful when something follows it.
  let negated = false
  let body = raw

  if (body.startsWith('-')) {
    body = body.slice(1)
    if (body === '') {
      return {
        error: {
          message: 'Dangling `-` — put a term after it, like `-T:Dark`.',
          token: raw,
          index: token.index,
        },
      }
    }
    negated = true
  }

  // Prefix recognition is case-insensitive; the value keeps its original case.
  const match = PREFIX_PATTERN.exec(body)

  if (!match) {
    // No recognised prefix: `Z:foo` or `Time: 12` is ordinary text, so it is a
    // bare character-name term.
    return { term: { field: 'name', value: body, negated } }
  }

  const field = PREFIX_FIELDS[match[1]!.toUpperCase() as keyof typeof PREFIX_FIELDS]
  const value = match[2]!

  if (value === '') {
    const prefix = FIELD_PREFIX[field]
    return {
      error: {
        message: `\`${prefix}\` requires a value — try \`${prefix}Elf\`.`,
        token: raw,
        index: token.index,
      },
    }
  }

  return { term: { field, value, negated } }
}

/** Raw output of the parsing stage, before the `ok` wrapper is applied. */
export interface ParseOutput {
  query: ParsedQuery
  errors: QuerySyntaxError[]
}

/**
 * Pure parsing stage: tokens in, best-effort query plus errors out.
 *
 * Exported separately from `parseQuery` so the grammar can be tested without
 * going through the public result wrapper, and so the evaluator can reuse it.
 */
export function parseTokens(tokens: QueryToken[]): ParseOutput {
  const groups: QueryGroup[] = []
  const errors: QuerySyntaxError[] = []
  let current: QueryTerm[] = []
  let sawTermToken = false

  for (const token of tokens) {
    if (token.kind === 'comma') {
      // Leading, trailing and doubled commas all land here: empty groups are
      // simply ignored rather than treated as errors.
      if (current.length > 0) {
        groups.push({ terms: current })
        current = []
      }
      continue
    }

    sawTermToken = true

    const { term, error } = resolveTerm(token)
    if (error) {
      errors.push(error)
      continue
    }
    if (term) current.push(term)
  }

  if (current.length > 0) groups.push({ terms: current })

  return { query: { groups, empty: !sawTermToken }, errors }
}

/**
 * Parse a user-typed search query.
 *
 * Returns `ok: false` when at least one syntax error was found, but always
 * includes the best-effort `query` so the UI can show partial results next to
 * the errors. Every error found is reported, not just the first.
 */
export function parseQuery(input: string): ParseResult {
  const { query, errors } = parseTokens(scanTokens(input))

  if (errors.length > 0) return { ok: false, query, errors }
  return { ok: true, query, errors: [] }
}