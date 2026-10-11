import type { CharacterTags, LumiTagCharacter } from './types'

/**
 * Frontend -> backend request envelope. `requestId` correlates the reply.
 *
 * IMPORTANT: no request ever carries a `userId`. The host resolves user scope
 * for the extension's frontend message handler, and letting the frontend name
 * a user would be a privilege-escalation primitive.
 *
 * BULK REQUESTS ARE BATCHES ON PURPOSE. The bulk-edit transport used to make
 * one round trip per character and carry a full character DTO each way, which
 * is what exhausted the Termux/Android WebView host on large renames. The
 * `*Batch` requests carry many characters in one message and answer with
 * {@link CharacterTags} only; the single-character requests remain for the
 * retry path, which re-reads exactly one character on purpose.
 */
export type BackendRequest =
  | { type: 'characters.list'; requestId: string; offset: number; limit: number }
  | { type: 'characters.get'; requestId: string; characterId: string }
  | { type: 'characters.updateTags'; requestId: string; characterId: string; tags: string[] }
  | { type: 'characters.updateTagsBatch'; requestId: string; updates: { characterId: string; tags: string[] }[] }
  | { type: 'characters.getBatch'; requestId: string; characterIds: string[] }

export type BackendResponse =
  | { type: 'characters.list.result'; requestId: string; data: LumiTagCharacter[]; total: number }
  | { type: 'characters.get.result'; requestId: string; character: LumiTagCharacter | null }
  | { type: 'characters.updateTags.result'; requestId: string; character: LumiTagCharacter }
  | { type: 'characters.updateTagsBatch.result'; requestId: string; updated: CharacterTags[]; failures: BatchFailure[] }
  | { type: 'characters.getBatch.result'; requestId: string; characters: CharacterTags[] }
  | { type: 'error'; requestId: string; code: string; message: string; retryable: boolean }

/**
 * One character's failure inside an otherwise successful batch.
 *
 * Bulk operations are PARTIAL-SUCCESS by design: a single deleted-character
 * race, or one host rejection, must not roll back or abort the characters that
 * did land. These travel as ordinary DATA in the
 * batch reply rather than as a thrown error, because the request as a whole
 * succeeded — only these items did not. `code`/`message`/`retryable` are the
 * same triple `classifyError` produces, so the frontend classifies a per-item
 * failure exactly as it would classify a thrown one.
 */
export interface BatchFailure {
  characterId: string
  code: string
  message: string
  retryable: boolean
}

/** The backend worker is unreachable (not started, crashed, or host rejected the message). */
export const BACKEND_ERROR_UNAVAILABLE = 'backend_unavailable'
/** No reply arrived within the client's per-request deadline. */
export const BACKEND_ERROR_TIMEOUT = 'timeout'
/** The character does not exist or is not visible to this user. */
export const BACKEND_ERROR_NOT_FOUND = 'not_found'

/** Shape of an error reply, extracted from the union for reuse. */
export type BackendErrorResponse = Extract<BackendResponse, { type: 'error' }>