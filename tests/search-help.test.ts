import { describe, expect, test } from 'bun:test'

import { SEARCHABLE_FIELDS } from '../src/shared/types'
import {
  getSearchHelpSections,
  SEARCHABLE_FIELD_LABELS,
  type SearchHelpSection,
} from '../src/frontend/search/search-help'

function allEntries(sections: SearchHelpSection[]): string[] {
  return sections.flatMap((section) => section.entries.map((entry) => entry.syntax))
}

function allText(sections: SearchHelpSection[]): string {
  return JSON.stringify(sections)
}

describe('getSearchHelpSections', () => {
  test('returns non-empty sections for both contexts', () => {
    for (const context of ['tags', 'characters'] as const) {
      const sections = getSearchHelpSections(context)
      expect(sections.length, `${context} should have sections`).toBeGreaterThan(0)
      for (const section of sections) {
        expect(section.title.length).toBeGreaterThan(0)
        expect(section.entries.length, `${context}/${section.title} should have entries`).toBeGreaterThan(0)
        for (const entry of section.entries) {
          expect(entry.syntax.length).toBeGreaterThan(0)
          expect(entry.description.length).toBeGreaterThan(0)
        }
      }
    }
  })

  test('every prefix appears in the tags context', () => {
    const entries = allEntries(getSearchHelpSections('tags'))
    for (const prefix of ['T:', 'A:', 'C:']) {
      expect(
        entries.some((syntax) => syntax.includes(prefix)),
        `tags context should document ${prefix}`,
      ).toBe(true)
    }
  })

  test('every prefix appears in the characters context', () => {
    const entries = allEntries(getSearchHelpSections('characters'))
    for (const prefix of ['T:', 'A:', 'C:']) {
      expect(
        entries.some((syntax) => syntax.includes(prefix)),
        `characters context should document ${prefix}`,
      ).toBe(true)
    }
  })

  test('bare name search is documented in both contexts', () => {
    for (const context of ['tags', 'characters'] as const) {
      const text = allText(getSearchHelpSections(context))
      expect(text).toContain('No prefix searches character names')
    }
  })

  test('documents AND, OR, negation, case-insensitivity and empty queries', () => {
    for (const context of ['tags', 'characters'] as const) {
      const text = allText(getSearchHelpSections(context))
      expect(text, `${context}: AND`).toContain('AND')
      expect(text, `${context}: OR`).toContain('OR')
      expect(text, `${context}: negation`).toContain('Negation')
      expect(text, `${context}: case-insensitivity`).toContain('ignores case')
      expect(text, `${context}: empty query`).toContain('blank search returns every character')
    }
  })

  test('includes the four required worked examples in both contexts', () => {
    for (const context of ['tags', 'characters'] as const) {
      const entries = allEntries(getSearchHelpSections(context))
      for (const example of ['T:Elf T:Magic', 'T:Elf, T:Magic', 'A:John, T:Elf T:Magic', 'T:Elf -T:Dark']) {
        expect(entries, `${context} should show ${example}`).toContain(example)
      }
    }
  })

  test('the tags context explains that C: locates characters by name', () => {
    const text = allText(getSearchHelpSections('tags'))
    expect(text).toContain('C: finds characters by name')
    expect(text).toContain('not a search across other fields')
  })

  test('the characters context notes C: matches names only', () => {
    const text = allText(getSearchHelpSections('characters'))
    expect(text).toContain('C: behaves the same as a plain name search')
  })

  test('the tags context lists the exact A: searchable fields', () => {
    const text = allText(getSearchHelpSections('tags'))
    for (const field of SEARCHABLE_FIELDS) {
      expect(text, `tags help should list A: field ${field}`).toContain(
        SEARCHABLE_FIELD_LABELS[field],
      )
    }
  })

  test('tag matching is documented as whole-name', () => {
    const text = allText(getSearchHelpSections('tags'))
    expect(text).toContain('whole tag name')
    expect(text).toContain('ElfKing')
  })

  test('returns a fresh array each call so the UI cannot mutate shared data', () => {
    const first = getSearchHelpSections('tags')
    first.length = 0
    expect(getSearchHelpSections('tags').length).toBeGreaterThan(0)
  })
})

describe('SEARCHABLE_FIELD_LABELS', () => {
  test('keys match SEARCHABLE_FIELDS exactly, in both directions', () => {
    const labelKeys = Object.keys(SEARCHABLE_FIELD_LABELS).sort()
    const fieldKeys = [...SEARCHABLE_FIELDS].sort()
    expect(labelKeys).toEqual(fieldKeys)
    expect(labelKeys.length).toBe(fieldKeys.length)
  })

  test('every label is a non-empty human-readable string', () => {
    for (const field of SEARCHABLE_FIELDS) {
      const label = SEARCHABLE_FIELD_LABELS[field]
      expect(typeof label).toBe('string')
      expect(label.length).toBeGreaterThan(0)
    }
  })
})