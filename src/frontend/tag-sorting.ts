/**
 * Pure, UI-independent sorting / filtering over the derived tag catalog.
 * The UI layer must consume these helpers rather than re-implementing them.
 */

import type { TagEntry } from './tag-index'

export type TagSortMode =
  | 'name_asc'
  | 'name_zdesc'
  | 'count_desc'
  | 'count_asc'
  | 'only_zero'

export const TAG_SORT_MODES: readonly TagSortMode[] = [
  'name_asc',
  'name_zdesc',
  'count_desc',
  'count_asc',
  'only_zero',
]

export const TAG_SORT_LABELS: Record<TagSortMode, string> = {
  name_asc: 'Name (A-Z)',
  name_zdesc: 'Name (Z-A)',
  count_desc: 'Most used',
  count_asc: 'Least used',
  only_zero: 'Unused tags',
}

function compareKeys(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

function keyOf(entry: TagEntry): string {
  return (entry.key ?? entry.name ?? '').toLowerCase()
}

/**
 * Sort the given tags. Never mutates the input array. Whenever the primary
 * sort key ties, entries are ordered by `key` ascending so the result is fully
 * deterministic.
 *
 * `only_zero` filters to entries with `count === 0`. Because the catalog is
 * derived from live assignments this is normally empty, and that is correct:
 * the function never fabricates entries.
 */
export function sortTags(tags: readonly TagEntry[], mode: TagSortMode): TagEntry[] {
  if (!Array.isArray(tags)) return []
  const list = [...tags]

  if (mode === 'only_zero') {
    return list.filter((entry) => (entry?.count ?? 0) === 0)
  }

  if (mode === 'name_asc' || mode === 'name_zdesc') {
    const dir = mode === 'name_asc' ? 1 : -1
    return list.sort((a, b) => {
      const byName = compareKeys(keyOf(a), keyOf(b))
      if (byName !== 0) return byName * dir
      return compareKeys(keyOf(a), keyOf(b))
    })
  }

  if (mode === 'count_desc' || mode === 'count_asc') {
    const dir = mode === 'count_desc' ? -1 : 1
    return list.sort((a, b) => {
      const ca = a?.count ?? 0
      const cb = b?.count ?? 0
      if (ca !== cb) return (ca - cb) * dir
      return compareKeys(keyOf(a), keyOf(b))
    })
  }

  return list.sort((a, b) => compareKeys(keyOf(a), keyOf(b)))
}

/**
 * Case-insensitive substring filter over the display `name`.
 * An empty/whitespace-only query returns the input array unchanged
 * (by reference, and never mutated).
 */
export function filterTagsByName(tags: readonly TagEntry[], query: string): TagEntry[] {
  if (!Array.isArray(tags)) return []
  const q = typeof query === 'string' ? query.trim().toLowerCase() : ''
  if (q === '') return tags as TagEntry[]
  return tags.filter((entry) => (entry?.name ?? '').toLowerCase().includes(q))
}
