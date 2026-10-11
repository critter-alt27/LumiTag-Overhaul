import type { CharacterTags, LumiTagCharacter } from './types'

function readString(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function readNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

/**
 * Coerce an arbitrary value into a clean tag list.
 *
 * Rules:
 *  - non-array input becomes `[]`
 *  - non-string entries are dropped
 *  - entries are trimmed
 *  - entries that are empty after trimming are dropped
 *  - duplicates are removed CASE-INSENSITIVELY, keeping the FIRST spelling seen
 *  - input order is preserved
 *
 * Tag identity in LumiTag is case-insensitive (see the query evaluator), so
 * "Elf" and "elf" are the same tag and must never both be stored.
 */
export function normalizeCharacterTags(tags: unknown): string[] {
  if (!Array.isArray(tags)) return []

  const seen = new Set<string>()
  const out: string[] = []

  for (const entry of tags) {
    if (typeof entry !== 'string') continue
    const trimmed = entry.trim()
    if (trimmed.length === 0) continue
    const key = trimmed.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(trimmed)
  }

  return out
}

export function normalizeCharacterTagsOnly(raw: unknown): CharacterTags {
  const source: Record<string, unknown> =
    typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {}
  return { id: readString(source.id), tags: normalizeCharacterTags(source.tags) }
}

/**
 * Normalize a raw (possibly partial, possibly not-an-object) character DTO into
 * the extension's character shape.
 *
 * This NEVER throws: unknown/garbage input yields a zero-valued character with
 * an empty `id`. The worker boundary is untrusted (messages come off a
 * transport), so a single malformed DTO must not be able to take down the
 * backend worker.
 */
export function normalizeCharacter(raw: unknown): LumiTagCharacter {
  const source: Record<string, unknown> =
    typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {}

  const imageId = source.image_id

  return {
    id: readString(source.id),
    name: readString(source.name),
    description: readString(source.description),
    personality: readString(source.personality),
    scenario: readString(source.scenario),
    creator: readString(source.creator),
    creator_notes: readString(source.creator_notes),
    system_prompt: readString(source.system_prompt),
    tags: normalizeCharacterTags(source.tags),
    image_id: typeof imageId === 'string' && imageId.length > 0 ? imageId : null,
    created_at: readNumber(source.created_at),
    updated_at: readNumber(source.updated_at),
  }
}