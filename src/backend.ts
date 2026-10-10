/**
 * LumiTag backend worker.
 *
 * The worker is the ONLY place that touches host character APIs. It owns:
 *  - DTO normalization (`normalizeCharacter` / `normalizeCharacterTags`)
 *  - pagination clamping (host hard-caps `characters.list` at 200/page)
 *  - error classification into `{ code, message, retryable }`
 *
 * It never trusts its input: every field of every inbound message is validated
 * before use, because the frontend transport is not a trusted boundary.
 *
 * It never forwards a `userId` it was told to forward either — the inbound
 * message carries no userId at all, and the host resolves user scope from the
 * message envelope.
 */

import { normalizeCharacter, normalizeCharacterTags } from './shared/normalize'
import {
  BACKEND_ERROR_NOT_FOUND,
  BACKEND_ERROR_TIMEOUT,
  BACKEND_ERROR_UNAVAILABLE,
  type BackendResponse,
} from './shared/protocol'
import { BACKEND_PAGE_LIMIT } from './shared/types'

declare const spindle: import('lumiverse-spindle-types').SpindleAPI

const ERROR_INVALID_INPUT = 'invalid_input'
const ERROR_FORBIDDEN = 'forbidden'
const ERROR_INTERNAL = 'internal'

/**
 * Classify a thrown host error into a wire-safe error code + retryability.
 *
 * The host surfaces failures as plain `Error`s whose message is the only
 * signal available, so classification is message-shape driven. The rules are
 * deliberately ordered most-specific-first.
 */
function classifyError(err: unknown): { code: string; message: string; retryable: boolean } {
  const raw = err instanceof Error ? err.message : String(err)
  // Never forward a stack trace: only the message crosses the boundary.
  const message = (raw && raw.length > 0 ? raw : 'Unknown error').slice(0, 500)
  const text = message.toLowerCase()

  // Permission / auth — retrying without a permission grant cannot succeed.
  if (
    text.includes('permission') ||
    text.includes('forbidden') ||
    text.includes('unauthorized') ||
    text.includes('not allowed') ||
    text.includes('access denied')
  ) {
    return { code: ERROR_FORBIDDEN, message, retryable: false }
  }

  // Missing character or otherwise non-existent resource.
  if (text.includes('not found') || text.includes('does not exist') || text.includes('enoent')) {
    return { code: BACKEND_ERROR_NOT_FOUND, message, retryable: false }
  }

  // Malformed input rejected by the host — retrying the same input is futile.
  if (
    text.includes('invalid') ||
    text.includes('validation') ||
    text.includes('must be') ||
    text.includes('required')
  ) {
    return { code: ERROR_INVALID_INPUT, message, retryable: false }
  }

  // Transient conditions — retrying may well work.
  if (
    text.includes('timeout') ||
    text.includes('timed out') ||
    text.includes('etimedout') ||
    text.includes('aborted') ||
    text.includes('econnreset') ||
    text.includes('econnrefused') ||
    text.includes('socket hang up') ||
    text.includes('network') ||
    text.includes('temporarily') ||
    text.includes('rate limit') ||
    text.includes('too many requests') ||
    text.includes('service unavailable')
  ) {
    return { code: BACKEND_ERROR_TIMEOUT, message, retryable: true }
  }

  // Unknown failure: assume transient so the UI offers a safe retry.
  return { code: ERROR_INTERNAL, message, retryable: true }
}

function sendError(
  requestId: string,
  userId: string,
  classified: { code: string; message: string; retryable: boolean },
): void {
  spindle.sendToFrontend(
    {
      type: 'error',
      requestId,
      code: classified.code,
      message: classified.message,
      retryable: classified.retryable,
    } satisfies BackendResponse,
    userId,
  )
}

/** Clamp a caller-supplied page size into the host's accepted range. */
function clampLimit(value: unknown): number {
  const raw = typeof value === 'number' && Number.isFinite(value) ? Math.floor(value) : BACKEND_PAGE_LIMIT
  if (raw < 1) return 1
  if (raw > BACKEND_PAGE_LIMIT) return BACKEND_PAGE_LIMIT
  return raw
}

function readOffset(value: unknown): number {
  const raw = typeof value === 'number' && Number.isFinite(value) ? Math.floor(value) : 0
  return raw > 0 ? raw : 0
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Recover a usable requestId from an otherwise malformed payload, if possible. */
function recoverRequestId(payload: unknown): string | null {
  if (!isRecord(payload)) return null
  const id = payload.requestId
  return typeof id === 'string' && id.length > 0 ? id : null
}

async function handleList(payload: Record<string, unknown>, userId: string): Promise<void> {
  const requestId = recoverRequestId(payload)
  if (!requestId) return

  const limit = clampLimit(payload.limit)
  const offset = readOffset(payload.offset)

  try {
    const page = await spindle.characters.list({ limit, offset })
    const data = Array.isArray(page?.data) ? page.data.map(normalizeCharacter) : []
    const total = typeof page?.total === 'number' && Number.isFinite(page.total) ? page.total : data.length

    spindle.sendToFrontend(
      { type: 'characters.list.result', requestId, data, total } satisfies BackendResponse,
      userId,
    )
  } catch (err) {
    sendError(requestId, userId, classifyError(err))
  }
}

async function handleGet(payload: Record<string, unknown>, userId: string): Promise<void> {
  const requestId = recoverRequestId(payload)
  if (!requestId) return

  const characterId = payload.characterId
  if (typeof characterId !== 'string' || characterId.length === 0) {
    sendError(requestId, userId, {
      code: ERROR_INVALID_INPUT,
      message: 'characters.get requires a non-empty characterId',
      retryable: false,
    })
    return
  }

  try {
    const character = await spindle.characters.get(characterId)
    spindle.sendToFrontend(
      {
        type: 'characters.get.result',
        requestId,
        character: character === null || character === undefined ? null : normalizeCharacter(character),
      } satisfies BackendResponse,
      userId,
    )
  } catch (err) {
    sendError(requestId, userId, classifyError(err))
  }
}

async function handleUpdateTags(payload: Record<string, unknown>, userId: string): Promise<void> {
  const requestId = recoverRequestId(payload)
  if (!requestId) return

  const characterId = payload.characterId
  if (typeof characterId !== 'string' || characterId.length === 0) {
    sendError(requestId, userId, {
      code: ERROR_INVALID_INPUT,
      message: 'characters.updateTags requires a non-empty characterId',
      retryable: false,
    })
    return
  }

  if (!Array.isArray(payload.tags)) {
    sendError(requestId, userId, {
      code: ERROR_INVALID_INPUT,
      message: 'characters.updateTags requires a tags array',
      retryable: false,
    })
    return
  }

  // Normalize BEFORE sending: `tags` is a full-array replace on the host, so
  // storing un-normalized values would persist duplicates/case variants that the
  // tag index and query evaluator would then disagree about.
  const tags = normalizeCharacterTags(payload.tags)

  try {
    const character = await spindle.characters.update(characterId, { tags })
    spindle.sendToFrontend(
      {
        type: 'characters.updateTags.result',
        requestId,
        character: normalizeCharacter(character),
      } satisfies BackendResponse,
      userId,
    )
  } catch (err) {
    sendError(requestId, userId, classifyError(err))
  }
}

spindle.onFrontendMessage((payload: unknown, userId: string) => {
  if (!isRecord(payload)) {
    // Nothing to correlate a reply to; drop it.
    spindle.log.warn(`${BACKEND_ERROR_UNAVAILABLE}: dropped a non-object frontend message`)
    return
  }

  switch (payload.type) {
    case 'characters.list':
      void handleList(payload, userId)
      return
    case 'characters.get':
      void handleGet(payload, userId)
      return
    case 'characters.updateTags':
      void handleUpdateTags(payload, userId)
      return
    default: {
      // Malformed/unknown message: reply with an error only if we can correlate
      // it, so the caller's timeout does not fire for a request we saw.
      const requestId = recoverRequestId(payload)
      if (requestId) {
        sendError(requestId, userId, {
          code: ERROR_INVALID_INPUT,
          message: `Unsupported LumiTag request type: ${String(payload.type)}`,
          retryable: false,
        })
      }
    }
  }
})

spindle.log.info('LumiTag backend ready')