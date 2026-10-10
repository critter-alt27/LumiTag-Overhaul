/** Normalized character shape used by the whole extension. */
export interface LumiTagCharacter {
  id: string
  name: string
  description: string
  personality: string
  scenario: string
  creator: string
  creator_notes: string
  system_prompt: string
  tags: string[]
  image_id: string | null
  created_at: number
  updated_at: number
}

export interface CharacterListPage {
  data: LumiTagCharacter[]
  total: number
}

/**
 * Fields exposed to the `A:` (any-field) search operator. This list is the
 * documented contract for `A:` — the UI help panel renders it verbatim, so
 * users always know exactly which fields a bare `A:` query can reach.
 */
export const SEARCHABLE_FIELDS = [
  'name',
  'description',
  'personality',
  'scenario',
  'creator',
  'creator_notes',
] as const
export type SearchableField = (typeof SEARCHABLE_FIELDS)[number]

/**
 * Hard page cap enforced by the host worker RPC (`characters.list` clamps to
 * 200). The response does NOT echo limit/offset, so the client must track its
 * own cursor and page with this value.
 */
export const BACKEND_PAGE_LIMIT = 200