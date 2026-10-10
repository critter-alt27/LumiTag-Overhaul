import type { LumiTagCharacter } from './types'

/**
 * Frontend -> backend request envelope. `requestId` correlates the reply.
 *
 * IMPORTANT: no request ever carries a `userId`. The host resolves user scope
 * for the extension's frontend message handler, and letting the frontend name
 * a user would be a privilege-escalation primitive.
 */
export type BackendRequest =
  | { type: 'characters.list'; requestId: string; offset: number; limit: number }
  | { type: 'characters.get'; requestId: string; characterId: string }
  | { type: 'characters.updateTags'; requestId: string; characterId: string; tags: string[] }

export type BackendResponse =
  | { type: 'characters.list.result'; requestId: string; data: LumiTagCharacter[]; total: number }
  | { type: 'characters.get.result'; requestId: string; character: LumiTagCharacter | null }
  | { type: 'characters.updateTags.result'; requestId: string; character: LumiTagCharacter }
  | { type: 'error'; requestId: string; code: string; message: string; retryable: boolean }

/** The backend worker is unreachable (not started, crashed, or host rejected the message). */
export const BACKEND_ERROR_UNAVAILABLE = 'backend_unavailable'
/** No reply arrived within the client's per-request deadline. */
export const BACKEND_ERROR_TIMEOUT = 'timeout'
/** The character does not exist or is not visible to this user. */
export const BACKEND_ERROR_NOT_FOUND = 'not_found'

/** Shape of an error reply, extracted from the union for reuse. */
export type BackendErrorResponse = Extract<BackendResponse, { type: 'error' }>