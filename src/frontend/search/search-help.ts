/**
 * Pure data for the search-help UI popover, so the UI layer does not
 * hand-write documentation strings.
 */

export interface SearchHelpEntry {
  syntax: string
  description: string
}

export interface SearchHelpSection {
  title: string
  entries: SearchHelpEntry[]
}

function prefixSections(characterPrefixNote: string): SearchHelpSection[] {
  return [
    {
      title: 'Prefixes',
      entries: [
        {
          syntax: 'Elf',
          description: 'No prefix searches character names, matching any part of the name.',
        },
        {
          syntax: 'T:Elf',
          description:
            'Tag name search. Matches the whole tag name, so T:Elf does not match a tag called ElfKing.',
        },
        {
          syntax: 'C:John',
          description: characterPrefixNote,
        },
      ],
    },
    {
      title: 'Combining terms',
      entries: [
        {
          syntax: 'T:Elf T:Magic',
          description: 'Spaces mean AND — the character needs both tags.',
        },
        {
          syntax: 'T:Elf, T:Magic',
          description: 'Commas mean OR — the character needs either tag.',
        },
        {
          syntax: 'C:John, T:Elf T:Magic',
          description: 'Mixes both: this reads as (C:John) OR (T:Elf AND T:Magic).',
        },
      ],
    },
    {
      title: 'Excluding results',
      entries: [
        {
          syntax: '-T:Dark',
          description:
            'Put - in front of a term to exclude matches. Negation applies to the whole term.',
        },
        {
          syntax: 'T:Elf -T:Dark',
          description:
            'Characters tagged Elf but not Dark. A character tagged with something else entirely, such as Magic, is not returned.',
        },
      ],
    },
    {
      title: 'Good to know',
      entries: [
        {
          syntax: 'elf',
          description:
            'Matching ignores case for both prefixes and values, so T:elf and t:ELF behave like T:Elf.',
        },
        {
          syntax: '(empty search box)',
          description:
            'A blank search returns every character rather than no results.',
        },
      ],
    },
  ]
}

export function getSearchHelpSections(context: 'tags' | 'characters'): SearchHelpSection[] {
  if (context === 'tags') {
    const sections = prefixSections(
      'In the Tags section, C: finds characters by name so you can inspect the tags assigned to them. It is not a search across other fields.',
    )

    sections.push({
      title: 'Searching the tag list',
      entries: [
        {
          syntax: 'Elf',
          description: 'Plain typing filters the tag list by tag name.',
        },
        {
          syntax: 'T:Elf',
          description:
            'Finds the tag Elf itself. To see the characters behind a tag, combine it with C:, for example T:Elf C:Aria.',
        },
      ],
    })

    return sections
  }

  const sections = prefixSections(
    'In the Characters section, C: behaves the same as a plain name search — both match character names only.',
  )

  sections.push({
    title: 'Finding characters by their tags',
    entries: [
      {
        syntax: 'T:Elf',
        description:
          'In the Characters section this filters the character list down to the characters carrying that tag, whether or not their name contains Elf.',
      },
    ],
  })

  return sections
}