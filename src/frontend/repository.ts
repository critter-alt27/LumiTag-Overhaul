import type { BackendResponse } from '../shared/protocol'
import { BACKEND_PAGE_LIMIT, type CharacterListPage, type LumiTagCharacter } from '../shared/types'
import { mapWithConcurrency } from './concurrency'
import type { SpindleRpc } from './rpc'

/** Default number of simultaneous character `get` roundtrips. */
export const DEFAULT_GET_CONCURRENCY = 8

/** The narrow mutation surface the executor is allowed to depend on. */
export interface CharacterMutationPort {
  getCharacter(id: string): Promise<LumiTagCharacter | null>
  updateTags(id: string, tags: string[]): Promise<LumiTagCharacter>
}

function clampLimit(value: number | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return BACKEND_PAGE_LIMIT
  const floored = Math.floor(value)
  if (floored < 1) return 1
  return Math.min(floored, BACKEND_PAGE_LIMIT)
}

/**
 * Read/write access to characters over the Spindle backend worker.
 *
 * This class owns pagination and concurrency policy; it contains NO search,
 * tag-catalog or mutation logic. Errors are deliberately NOT translated here —
 * `SpindleRpcError.code` / `.retryable` are the executor's classification
 * inputs, so swallowing or reshaping them here would destroy that signal.
 */
export class CharacterRepository implements CharacterMutationPort {
  private readonly rpc: SpindleRpc

  constructor(rpc: SpindleRpc) {
    this.rpc = rpc
  }

  /** One page of characters. The caller owns the returned cursor arithmetic. */
  async listPage(offset: number, limit?: number): Promise<CharacterListPage> {
    const safeOffset = Number.isFinite(offset) && offset > 0 ? Math.floor(offset) : 0
    const response = await this.rpc.request<BackendResponse['type']>({
      type: 'characters.list',
      offset: safeOffset,
      limit: clampLimit(limit),
    })
    const page = response as Extract<BackendResponse, { type: 'characters.list.result' }>
    return { data: Array.isArray(page.data) ? page.data : [], total: page.total }
  }

  /**
   * Walk every page until the reported total is covered.
   *
   * Termination guards, in order:
   *  1. `data.length === 0` — an empty page means the host has nothing more;
   *     without this a lying `total` would spin forever.
   *  2. `offset + received >= total` — the exact-total boundary stops here with
   *     no extra roundtrip for a clean page multiple.
   *
   * Ids are de-duplicated because a concurrent host mutation (a character
   * created mid-walk shifts every later offset) can otherwise surface the same
   * row twice, which would double-apply tags downstream.
   */
  async listAllCharacters(
    onProgress?: (loaded: number, total: number) => void,
  ): Promise<LumiTagCharacter[]> {
    const seen = new Set<string>()
    const all: LumiTagCharacter[] = []
    let offset = 0

    for (;;) {
      const page = await this.listPage(offset, BACKEND_PAGE_LIMIT)
      const items = page.data
      if (items.length === 0) break

      for (const character of items) {
        if (seen.has(character.id)) continue
        seen.add(character.id)
        all.push(character)
      }

      offset += items.length
      onProgress?.(all.length, page.total)

      if (offset >= page.total) break
    }

    return all
  }

  async getCharacter(id: string): Promise<LumiTagCharacter | null> {
    const response = await this.rpc.request<BackendResponse['type']>({
      type: 'characters.get',
      characterId: id,
    })
    const result = response as Extract<BackendResponse, { type: 'characters.get.result' }>
    return result.character ?? null
  }

  /**
   * Fetch many characters with BOUNDED concurrency (never `Promise.all` over an
   * unbounded list, which would open one socket per character).
   *
   * Per-character failures are intentionally non-fatal: the id is simply
   * absent from the map. Bulk operations are partial-success by design, and one
   * deleted-character race must not abort a whole batch.
   */
  async getCharactersByIds(
    ids: readonly string[],
    concurrency: number = DEFAULT_GET_CONCURRENCY,
  ): Promise<Map<string, LumiTagCharacter>> {
    const out = new Map<string, LumiTagCharacter>()
    if (ids.length === 0) return out

    // De-duplicate up front so repeated ids do not burn a roundtrip each.
    const unique = [...new Set(ids)]

    const settled = await mapWithConcurrency(unique, concurrency, async (id) => this.getCharacter(id))

    for (let i = 0; i < settled.length; i++) {
      const result = settled[i]
      if (!result || result.status !== 'fulfilled') continue
      const character = result.value
      if (character) out.set(unique[i] as string, character)
    }

    return out
  }

  /**
   * Replace a character's tag array.
   *
   * Errors propagate UNMODIFIED. The executor classifies retryable vs terminal
   * failures from `SpindleRpcError.code` / `.retryable`, so this must not
   * catch-and-rethrow.
   */
  async updateTags(id: string, tags: string[]): Promise<LumiTagCharacter> {
    const response = await this.rpc.request<BackendResponse['type']>({
      type: 'characters.updateTags',
      characterId: id,
      tags,
    })
    const result = response as Extract<BackendResponse, { type: 'characters.updateTags.result' }>
    return result.character
  }

  /**
   * Avatar image URL for `<img src>`.
   *
   * Why a plain URL is acceptable here: it is a same-origin, GET-only,
   * session-authenticated endpoint (`/api/v1/characters/:id/avatar`) that the
   * host already authorizes per-user from the session cookie. Embedding it as an
   * image src carries no extension token, no bearer credential and no
   * user-supplied origin — the browser attaches the session cookie exactly as it
   * would for any other Lumiverse asset, and the host's existing ETag/If-None-Match
   * caching still applies. Fetching bytes through the backend instead would mean
   * base64 round-tripping megabytes of avatar data through the message channel
   * for zero added safety.
   *
   * Note the path is derived from the character id only; `image_id` is exposed
   * on the DTO but deliberately NOT used, because the resolver endpoint already
   * applies the crop/legacy-path fallback chain authoritatively.
   */
  avatarUrl(id: string): string {
    return `/api/v1/characters/${encodeURIComponent(id)}/avatar`
  }
}

