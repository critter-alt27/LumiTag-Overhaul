import {
  BACKEND_ERROR_NOT_FOUND,
  BACKEND_ERROR_TIMEOUT,
  BACKEND_ERROR_UNAVAILABLE,
  type BackendRequest,
  type BackendResponse,
} from '../shared/protocol'

/** Structural type for just the transport slice of the frontend context. */
type SpindleRpcContext = Pick<
  import('lumiverse-spindle-types').SpindleFrontendContext,
  'sendToBackend' | 'onBackendMessage'
>

const DEFAULT_TIMEOUT_MS = 20_000

const ERROR_PROTOCOL = 'protocol_error'
const ERROR_DISPOSED = 'disposed'

/** Distributes `Omit` across a union so each variant stays independently usable. */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never

/** A request as callers supply it: the union minus its correlation id. */
export type BackendRequestInit = DistributiveOmit<BackendRequest, 'requestId'>

/**
 * Error thrown for every failed LumiTag backend roundtrip.
 *
 * `code` is a stable machine-readable string; `retryable` is the executor's
 * signal for whether offering a retry button is honest.
 */
export class SpindleRpcError extends Error {
  readonly code: string
  readonly retryable: boolean

  constructor(code: string, message: string, retryable: boolean) {
    super(message)
    this.name = 'SpindleRpcError'
    this.code = code
    this.retryable = retryable
  }
}

interface PendingEntry {
  resolve: (response: BackendResponse) => void
  reject: (error: SpindleRpcError) => void
  timer: ReturnType<typeof setTimeout> | undefined
  expectedType: BackendResponse['type']
}

let requestCounter = 0

function nextRequestId(): string {
  requestCounter += 1
  const random = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : Math.random().toString(36).slice(2)
  return `lt-${random}-${requestCounter}`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Validates a backend reply's shape against the response type the caller asked
 * for. A reply whose `type` disagrees with the request is a protocol violation,
 * not a legitimate answer, so it is rejected rather than returned.
 */
function isWellFormedFor(response: Record<string, unknown>, expectedType: BackendResponse['type']): boolean {
  // An error reply is valid for ANY request: it is the backend's way of saying
  // "this request failed". It must be validated on its own terms, never against
  // the success shape the caller asked for — otherwise its code/retryable would
  // be discarded and replaced by a generic protocol error.
  if (response.type === 'error') {
    return typeof response.code === 'string' && typeof response.message === 'string'
  }

  switch (expectedType) {
    case 'characters.list.result':
      return (
        response.type === 'characters.list.result' &&
        Array.isArray(response.data) &&
        typeof response.total === 'number'
      )
    case 'characters.get.result':
      return response.type === 'characters.get.result' && 'character' in response
    case 'characters.updateTags.result':
      return response.type === 'characters.updateTags.result' && response.character !== null
    case 'error':
      return typeof response.code === 'string' && typeof response.message === 'string'
    default:
      return false
  }
}

/**
 * Request/response client over the Spindle frontend<->backend message channel.
 *
 * Responsibilities:
 *  - mint unique request ids and correlate replies
 *  - enforce a per-request deadline (default 20s) that rejects as RETRYABLE
 *  - unwrap `{ type: 'error' }` replies into thrown `SpindleRpcError`s
 *  - guarantee no listener or timer survives a settled request or `dispose()`
 */
export class SpindleRpc {
  private readonly ctx: SpindleRpcContext
  private readonly pending = new Map<string, PendingEntry>()
  private readonly unsubscribe: () => void
  private timeoutMs: number
  private disposed = false

  constructor(ctx: SpindleRpcContext, options?: { timeoutMs?: number }) {
    this.ctx = ctx
    this.timeoutMs =
      typeof options?.timeoutMs === 'number' && Number.isFinite(options.timeoutMs) && options.timeoutMs > 0
        ? options.timeoutMs
        : DEFAULT_TIMEOUT_MS

    this.unsubscribe = this.ctx.onBackendMessage((payload: unknown) => {
      this.handleMessage(payload)
    })
  }

  /** Overrides the per-request deadline for subsequent requests. */
  setTimeoutMs(timeoutMs: number): void {
    if (Number.isFinite(timeoutMs) && timeoutMs > 0) this.timeoutMs = timeoutMs
  }

  /** Number of in-flight requests. Exposed for leak assertions in tests. */
  get pendingCount(): number {
    return this.pending.size
  }

  request<T extends BackendResponse['type']>(
    req: BackendRequestInit,
  ): Promise<Extract<BackendResponse, { type: T }>> {
    if (this.disposed) {
      return Promise.reject(
        new SpindleRpcError(ERROR_DISPOSED, 'LumiTag backend client was disposed', false),
      )
    }

    const requestId = nextRequestId()
    // The response type is derived from the request type; a mismatch can only
    // come from a backend bug, and is caught by the shape check below.
    const expectedType = expectedResponseType(req.type)

    return new Promise<Extract<BackendResponse, { type: T }>>((resolve, reject) => {
      const entry: PendingEntry = {
        resolve: (response) => resolve(response as Extract<BackendResponse, { type: T }>),
        reject,
        timer: undefined,
        expectedType,
      }

      entry.timer = setTimeout(() => {
        // Drop the entry first so the timeout is the single settle point.
        this.pending.delete(requestId)
        reject(
          new SpindleRpcError(
            BACKEND_ERROR_TIMEOUT,
            `LumiTag backend request '${req.type}' timed out after ${this.timeoutMs}ms`,
            true,
          ),
        )
      }, this.timeoutMs)

      this.pending.set(requestId, entry)

      try {
        this.ctx.sendToBackend({ ...req, requestId })
      } catch (err) {
        // Transport failure: the message never left, so nothing will reply.
        this.settle(requestId)
        reject(
          new SpindleRpcError(
            BACKEND_ERROR_UNAVAILABLE,
            err instanceof Error ? err.message : 'Failed to send request to LumiTag backend',
            true,
          ),
        )
      }
    })
  }

  /** Rejects every in-flight request and detaches the backend listener. */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true

    for (const requestId of [...this.pending.keys()]) {
      const entry = this.pending.get(requestId)
      this.clearTimer(entry)
      this.pending.delete(requestId)
      entry?.reject(
        new SpindleRpcError(
          ERROR_DISPOSED,
          'LumiTag backend client was disposed before the request completed',
          false,
        ),
      )
    }

    try {
      this.unsubscribe()
    } catch {
      // A failing disposer must not prevent the rest of teardown; there is
      // nothing further to release, so swallow deliberately.
    }
  }

  private clearTimer(entry: PendingEntry | undefined): void {
    if (entry?.timer !== undefined) {
      clearTimeout(entry.timer)
      entry.timer = undefined
    }
  }

  private handleMessage(payload: unknown): void {
    if (!isRecord(payload)) return

    const requestId = payload.requestId
    if (typeof requestId !== 'string') return

    const entry = this.pending.get(requestId)
    // Unknown/expired requestId: a late reply to an already-settled request.
    // Ignore it rather than creating a spurious rejection.
    if (!entry) return

    if (typeof payload.type !== 'string' || !isWellFormedFor(payload, entry.expectedType)) {
      this.settle(requestId)
      entry.reject(
        new SpindleRpcError(
          ERROR_PROTOCOL,
          `Malformed response from LumiTag backend for request ${requestId}`,
          false,
        ),
      )
      return
    }

    this.settle(requestId)

    if (payload.type === 'error') {
      const code = typeof payload.code === 'string' ? payload.code : ERROR_PROTOCOL
      const message = typeof payload.message === 'string' ? payload.message : 'LumiTag backend error'
      const retryable = payload.retryable === true
      entry.reject(new SpindleRpcError(code, message, retryable))
      return
    }

    entry.resolve(payload as unknown as BackendResponse)
  }

  /** Removes the pending entry and clears its timer exactly once. */
  private settle(requestId: string): void {
    const entry = this.pending.get(requestId)
    if (!entry) return
    this.clearTimer(entry)
    this.pending.delete(requestId)
  }
}

function expectedResponseType(requestType: BackendRequest['type']): BackendResponse['type'] {
  switch (requestType) {
    case 'characters.list':
      return 'characters.list.result'
    case 'characters.get':
      return 'characters.get.result'
    case 'characters.updateTags':
      return 'characters.updateTags.result'
    default:
      return 'error'
  }
}

export { BACKEND_ERROR_NOT_FOUND, BACKEND_ERROR_TIMEOUT, BACKEND_ERROR_UNAVAILABLE }