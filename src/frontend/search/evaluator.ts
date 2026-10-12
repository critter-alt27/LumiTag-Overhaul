/**
 * Search evaluator (Phase 5).
 *
 * Evaluates a parsed query against characters. This module owns all
 * field-specific matching behaviour; the parser only produces structure.
 *
 * Semantics:
 *   - An empty query (no groups) matches EVERY character.
 *   - Groups are OR-ed; terms within a group are AND-ed.
 *   - A negated term matches when its positive predicate is false.
 *   - All matching is case-insensitive.
 *   - `tag` (T:) is a case-insensitive comparison of the WHOLE tag name.
 *   - `name` (bare) and `char` (C:) are case-insensitive substring matches
 *     against the character name only.
 *   - An empty term value is treated as a non-matching positive predicate
 *     (and therefore a matching negated one). The parser already rejects
 *     empty prefixed values, so this is a defensive edge case only.
 */

import type { LumiTagCharacter } from '../../shared/types'
import type { ParsedQuery, QueryTerm } from './parser'

export interface MatchContext {
  /** Lowercased character name. */
  name: string
  /** Lowercased tag names. */
  tagKeys: Set<string>
}

function readString(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

/**
 * Defensive tag accessor: characters may arrive with missing, null or
 * non-array `tags`. Returns an empty list rather than throwing.
 */
function readTags(character: LumiTagCharacter): string[] {
  const tags = (character as { tags?: unknown }).tags
  return Array.isArray(tags) ? tags.filter((tag): tag is string => typeof tag === 'string') : []
}

/**
 * Builds the reusable per-character match context.
 *
 * Build this ONCE per character and pass it to `evaluateQueryWithContext` for
 * a filter pass and subsequent sort passes. Building it repeatedly inside
 * nested loops is what keeps large libraries slow.
 */
export function buildMatchContext(character: LumiTagCharacter): MatchContext {
  // `name` is read explicitly rather than derived from a field list: it is the
  // only character field the search language reaches, and routing it through a
  // list is what made removing that list silently break bare/C: search.
  const name = readString(character.name).toLowerCase()

  const tagKeys = new Set<string>()
  for (const tag of readTags(character)) {
    tagKeys.add(tag.toLowerCase())
  }

  return { name, tagKeys }
}

/**
 * Positive predicate for a single term, ignoring negation.
 */
function matchesPositive(term: QueryTerm, ctx: MatchContext): boolean {
  const value = term.value.toLowerCase()

  // Defensive: an empty value must never match everything silently.
  if (value.length === 0) return false

  switch (term.field) {
    case 'tag':
      // Whole-name comparison, not a substring: T:Elf must not match ElfKing.
      return ctx.tagKeys.has(value)

    case 'char':
    case 'name':
      // Name only. `C:` locates characters by name; it is NOT a field search.
      return ctx.name.includes(value)

    default:
      return false
  }
}

/** Evaluates a single term, applying negation. */
export function matchTerm(term: QueryTerm, ctx: MatchContext): boolean {
  const positive = matchesPositive(term, ctx)
  return term.negated ? !positive : positive
}

/**
 * OR over groups, AND over the terms inside each group.
 * An empty query matches everything.
 */
export function evaluateQueryWithContext(query: ParsedQuery, ctx: MatchContext): boolean {
  if (query.empty || query.groups.length === 0) return true

  for (const group of query.groups) {
    if (group.terms.length === 0) continue

    let all = true
    for (const term of group.terms) {
      if (!matchTerm(term, ctx)) {
        all = false
        break
      }
    }

    if (all) return true
  }

  return false
}

/** Convenience wrapper that builds the context inline. */
export function evaluateQuery(query: ParsedQuery, character: LumiTagCharacter): boolean {
  return evaluateQueryWithContext(query, buildMatchContext(character))
}

/**
 * Filters characters by query. Each context is built exactly once per
 * character, giving O(N * terms) rather than rebuilding fields per term.
 * The input array and characters are never mutated.
 */
export function searchCharactersWithContext(
  query: ParsedQuery,
  characters: readonly LumiTagCharacter[],
): LumiTagCharacter[] {
  if (query.empty || query.groups.length === 0) return characters.slice()

  const results: LumiTagCharacter[] = []

  for (const character of characters) {
    const ctx = buildMatchContext(character)
    if (evaluateQueryWithContext(query, ctx)) results.push(character)
  }

  return results
}

/** Convenience wrapper equivalent to `searchCharactersWithContext`. */
export function searchCharacters(
  query: ParsedQuery,
  characters: readonly LumiTagCharacter[],
): LumiTagCharacter[] {
  return searchCharactersWithContext(query, characters)
}