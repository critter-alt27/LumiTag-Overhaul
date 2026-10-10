import { describe, expect, test } from 'bun:test'

import { normalizeCharacter, normalizeCharacterTags } from '../src/shared/normalize'
import type { BackendRequest, BackendResponse } from '../src/shared/protocol'
import { BACKEND_PAGE_LIMIT, type LumiTagCharacter } from '../src/shared/types'
import { mapWithConcurrency } from '../src/frontend/concurrency'
import { SpindleRpc, SpindleRpcError } from '../src/frontend/rpc'
import { CharacterRepository } from '../src/frontend/repository'

/* -------------------------------------------------------------------------- */
/* helpers                                                                    */
/* -------------------------------------------------------------------------- */

function character(id: string, overrides: Partial<LumiTagCharacter> = {}): LumiTagCharacter {
  return {
    id,
    name: `Character ${id}`,
    description: '',
    personality: '',
    scenario: '',
    creator: '',
    creator_notes: '',
    system_prompt: '',
    tags: [],
    image_id: null,
    created_at: 1,
    updated_at: 1,
    ...overrides,
  }
}

/** Distributes `Omit` over the response union so each variant stays usable. */
type ResponseInit = BackendResponse extends infer T
  ? T extends BackendResponse
    ? Omit<T, 'requestId'>
    : never
  : never

/**
 * A fake frontend transport. `sendToBackend` hands the request to `onSend`, and
 * `emit` pushes a reply back through the registered backend-message listener —
 * exactly the shape the real `SpindleFrontendContext` provides.
 */
function createFakeCtx() {
  const listeners: Array<(payload: unknown) => void> = []
  const sent: BackendRequest[] = []
  let onSend: (req: BackendRequest) => void = () => {}

  const ctx = {
    sendToBackend(payload: unknown) {
      const req = payload as BackendRequest
      sent.push(req)
      onSend(req)
    },
    onBackendMessage(handler: (payload: unknown) => void) {
      listeners.push(handler)
      return () => {
        const idx = listeners.indexOf(handler)
        if (idx >= 0) listeners.splice(idx, 1)
      }
    },
  }

  return {
    ctx,
    sent,
    get listenerCount() {
      return listeners.length
    },
    onSend(fn: (req: BackendRequest) => void) {
      onSend = fn
    },
    /** Reply to a specific request, correlating by the request's own id. */
    reply(req: BackendRequest, response: ResponseInit) {
      for (const listener of [...listeners]) listener({ ...response, requestId: req.requestId })
    },
    emit(payload: unknown) {
      for (const listener of [...listeners]) listener(payload)
    },
  }
}

/** Resolve after the microtask queue drains, letting awaited chains complete. */
function flush(times = 6): Promise<void> {
  let p = Promise.resolve()
  for (let i = 0; i < times; i++) p = p.then(() => undefined)
  return p
}

/* -------------------------------------------------------------------------- */
/* normalizeCharacterTags                                                      */
/* -------------------------------------------------------------------------- */

describe('normalizeCharacterTags', () => {
  test('trims surrounding whitespace', () => {
    expect(normalizeCharacterTags(['  Elf  ', ' Wizard\n'])).toEqual(['Elf', 'Wizard'])
  })

  test('drops empty and whitespace-only entries', () => {
    expect(normalizeCharacterTags(['Elf', '', '   ', '\t\n'])).toEqual(['Elf'])
  })

  test('drops non-string entries', () => {
    const input = ['Elf', 42, null, undefined, {}, [], true, 'Wizard'] as unknown[]
    expect(normalizeCharacterTags(input)).toEqual(['Elf', 'Wizard'])
  })

  test('dedupes case-insensitively, preserving the first spelling', () => {
    expect(normalizeCharacterTags(['Elf', 'elf', 'ELF', 'Elf '])).toEqual(['Elf'])
    expect(normalizeCharacterTags(['WIZARD', 'wizard'])).toEqual(['WIZARD'])
  })

  test('preserves input order', () => {
    expect(normalizeCharacterTags(['zeta', 'Alpha', 'mu'])).toEqual(['zeta', 'Alpha', 'mu'])
  })

  test('returns [] for non-array input', () => {
    expect(normalizeCharacterTags(null)).toEqual([])
    expect(normalizeCharacterTags(undefined)).toEqual([])
    expect(normalizeCharacterTags('Elf')).toEqual([])
    expect(normalizeCharacterTags({ 0: 'Elf' })).toEqual([])
    expect(normalizeCharacterTags(7)).toEqual([])
  })

  test('does not mutate the input array', () => {
    const input = [' Elf ', 'elf']
    const copy = [...input]
    normalizeCharacterTags(input)
    expect(input).toEqual(copy)
  })
})

/* -------------------------------------------------------------------------- */
/* normalizeCharacter                                                          */
/* -------------------------------------------------------------------------- */

describe('normalizeCharacter', () => {
  test('fills missing fields with safe defaults', () => {
    const result = normalizeCharacter({ id: 'c1' })
    expect(result).toEqual({
      id: 'c1',
      name: '',
      description: '',
      personality: '',
      scenario: '',
      creator: '',
      creator_notes: '',
      system_prompt: '',
      tags: [],
      image_id: null,
      created_at: 0,
      updated_at: 0,
    })
  })

  test('defaults missing tags to []', () => {
    expect(normalizeCharacter({ id: 'c1' }).tags).toEqual([])
    expect(normalizeCharacter({ id: 'c1', tags: null }).tags).toEqual([])
    expect(normalizeCharacter({ id: 'c1', tags: 'Elf' }).tags).toEqual([])
  })

  test('normalizes a full DTO and drops unknown fields', () => {
    const result = normalizeCharacter({
      id: 'c1',
      name: 'A',
      description: 'B',
      personality: 'C',
      scenario: 'D',
      creator: 'E',
      creator_notes: 'F',
      system_prompt: 'G',
      tags: [' Elf ', 'elf', 'Wizard'],
      image_id: 'img-1',
      created_at: 10,
      updated_at: 20,
      extensions: { lumitag: {} },
      first_mes: 'ignored',
    })
    expect(result.tags).toEqual(['Elf', 'Wizard'])
    expect(result.image_id).toBe('img-1')
    expect(result.created_at).toBe(10)
    expect(result).not.toHaveProperty('extensions')
  })

  test('null / undefined / non-object input does not throw', () => {
    expect(() => normalizeCharacter(null)).not.toThrow()
    expect(normalizeCharacter(null).id).toBe('')
    expect(normalizeCharacter(undefined).id).toBe('')
    expect(normalizeCharacter('nope').tags).toEqual([])
    expect(normalizeCharacter(42).image_id).toBe(null)
  })

  test('coerces a non-finite numeric timestamp to 0 and blank image_id to null', () => {
    const result = normalizeCharacter({ id: 'c', created_at: NaN, updated_at: 'x', image_id: '' })
    expect(result.created_at).toBe(0)
    expect(result.updated_at).toBe(0)
    expect(result.image_id).toBe(null)
  })
})

/* -------------------------------------------------------------------------- */
/* SpindleRpc                                                                 */
/* -------------------------------------------------------------------------- */

describe('SpindleRpc', () => {
  test('resolves the response matching the requestId', async () => {
    const fake = createFakeCtx()
    const rpc = new SpindleRpc(fake.ctx)

    const pending = rpc.request({ type: 'characters.get', characterId: 'c1' })
    await flush()

    expect(fake.sent).toHaveLength(1)
    const req = fake.sent[0]!
    expect(req.type).toBe('characters.get')
    expect((req as { characterId: string }).characterId).toBe('c1')
    expect(typeof (req as { requestId: string }).requestId).toBe('string')

    fake.reply(req, { type: 'characters.get.result', character: character('c1') })

    const result = await pending
    expect(result.type).toBe('characters.get.result')
    expect((result as { character: LumiTagCharacter }).character.id).toBe('c1')
    expect(rpc.pendingCount).toBe(0)
    rpc.dispose()
  })

  test('assigns unique requestIds to concurrent requests and demultiplexes', async () => {
    const fake = createFakeCtx()
    const rpc = new SpindleRpc(fake.ctx)

    const first = rpc.request({ type: 'characters.get', characterId: 'a' })
    const second = rpc.request({ type: 'characters.get', characterId: 'b' })
    await flush()

    expect(fake.sent).toHaveLength(2)
    expect(fake.sent[0]!.requestId).not.toBe(fake.sent[1]!.requestId)

    // Reply OUT OF ORDER to prove correlation is by id, not arrival order.
    fake.reply(fake.sent[1]!, { type: 'characters.get.result', character: character('b') })
    fake.reply(fake.sent[0]!, { type: 'characters.get.result', character: character('a') })

    expect((await first as { character: LumiTagCharacter }).character.id).toBe('a')
    expect((await second as { character: LumiTagCharacter }).character.id).toBe('b')
    rpc.dispose()
  })

  test('rejects on timeout with code `timeout` and retryable true', async () => {
    const fake = createFakeCtx()
    const rpc = new SpindleRpc(fake.ctx, { timeoutMs: 15 })

    const pending = rpc.request({ type: 'characters.get', characterId: 'c1' })
    await expect(pending).rejects.toMatchObject({ code: 'timeout', retryable: true })
    expect(rpc.pendingCount).toBe(0)
    rpc.dispose()
  })

  test('clears the timer after a successful settle (no leak)', async () => {
    const fake = createFakeCtx()
    const rpc = new SpindleRpc(fake.ctx, { timeoutMs: 10_000 })

    const pending = rpc.request({ type: 'characters.get', characterId: 'c1' })
    await flush()
    fake.reply(fake.sent[0]!, { type: 'characters.get.result', character: null })
    await pending

    // If the timer were still armed, bun would keep the process alive / this
    // would fire; asserting the map is empty is the observable contract.
    expect(rpc.pendingCount).toBe(0)
    rpc.dispose()
  })

  test('unwraps an error response into a thrown error preserving code/retryable', async () => {
    const fake = createFakeCtx()
    const rpc = new SpindleRpc(fake.ctx)

    const pending = rpc.request({ type: 'characters.get', characterId: 'nope' })
    await flush()

    fake.reply(fake.sent[0]!, {
      type: 'error',
      code: 'not_found',
      message: 'Character not found',
      retryable: false,
    })

    await expect(pending).rejects.toMatchObject({
      code: 'not_found',
      retryable: false,
      message: 'Character not found',
    })
    rpc.dispose()
  })

  test('preserves retryable: true from a backend error', async () => {
    const fake = createFakeCtx()
    const rpc = new SpindleRpc(fake.ctx)

    const pending = rpc.request({ type: 'characters.list', offset: 0, limit: 200 })
    await flush()
    fake.reply(fake.sent[0]!, {
      type: 'error',
      code: 'internal',
      message: 'boom',
      retryable: true,
    })

    await expect(pending).rejects.toMatchObject({ retryable: true })
    rpc.dispose()
  })

  test('rejects all pending requests on dispose()', async () => {
    const fake = createFakeCtx()
    const rpc = new SpindleRpc(fake.ctx)

    const first = rpc.request({ type: 'characters.get', characterId: 'a' })
    const second = rpc.request({ type: 'characters.get', characterId: 'b' })
    await flush()
    expect(rpc.pendingCount).toBe(2)

    rpc.dispose()

    await expect(first).rejects.toBeInstanceOf(SpindleRpcError)
    await expect(second).rejects.toBeInstanceOf(SpindleRpcError)
    expect(rpc.pendingCount).toBe(0)
    // Listener detached: nothing left to leak.
    expect(fake.listenerCount).toBe(0)
  })

  test('refuses new requests after dispose()', async () => {
    const fake = createFakeCtx()
    const rpc = new SpindleRpc(fake.ctx)
    rpc.dispose()
    await expect(rpc.request({ type: 'characters.get', characterId: 'a' })).rejects.toMatchObject({
      code: 'disposed',
    })
  })

  test('ignores responses with unknown requestIds', async () => {
    const fake = createFakeCtx()
    const rpc = new SpindleRpc(fake.ctx)

    const pending = rpc.request({ type: 'characters.get', characterId: 'a' }, )
    await flush()

    // Stray traffic: wrong id, non-object, missing type.
    fake.emit({ type: 'characters.get.result', requestId: 'nobody-asked', character: null })
    fake.emit('not-an-object')
    fake.emit({ type: 'characters.get.result' })
    fake.emit(null)

    fake.reply(fake.sent[0]!, { type: 'characters.get.result', character: character('a') })
    const result = await pending
    expect((result as { character: LumiTagCharacter }).character.id).toBe('a')
    rpc.dispose()
  })

  test('rejects a malformed response shape', async () => {
    const fake = createFakeCtx()
    const rpc = new SpindleRpc(fake.ctx)

    const pending = rpc.request({ type: 'characters.list', offset: 0, limit: 200 })
    await flush()

    // Right requestId, wrong payload for the expected response type.
    fake.emit({ type: 'characters.list.result', requestId: fake.sent[0]!.requestId, data: 'not-an-array', total: 1 })

    await expect(pending).rejects.toMatchObject({ code: 'protocol_error', retryable: false })
    expect(rpc.pendingCount).toBe(0)
    rpc.dispose()
  })

  test('rejects when the transport itself throws on send', async () => {
    const fake = createFakeCtx()
    fake.ctx.sendToBackend = () => {
      throw new Error('channel closed')
    }
    const rpc = new SpindleRpc(fake.ctx)

    await expect(rpc.request({ type: 'characters.get', characterId: 'a' })).rejects.toMatchObject({
      code: 'backend_unavailable',
      retryable: true,
    })
    expect(rpc.pendingCount).toBe(0)
    rpc.dispose()
  })
})

/* -------------------------------------------------------------------------- */
/* listAllCharacters                                                          */
/* -------------------------------------------------------------------------- */

/** Fake RPC stub driven by a page function. */
function listRpc(pages: (offset: number, limit: number) => { data: LumiTagCharacter[]; total: number }) {
  const calls: Array<{ offset: number; limit: number }> = []
  const rpc = {
    request: async (req: unknown) => {
      const r = req as { offset: number; limit: number }
      calls.push({ offset: r.offset, limit: r.limit })
      const page = pages(r.offset, r.limit)
      return { type: 'characters.list.result', requestId: 'x', data: page.data, total: page.total } as BackendResponse
    },
  }
  return { rpc: rpc as unknown as SpindleRpc, calls }
}

describe('CharacterRepository.listAllCharacters', () => {
  test('walks multiple pages: full first page, partial second page', async () => {
    const first = Array.from({ length: BACKEND_PAGE_LIMIT }, (_, i) => character(`c${i}`))
    const second = [character('c200'), character('c201'), character('c202')]
    const { rpc, calls } = listRpc((offset) => ({
      data: offset === 0 ? first : second,
      total: first.length + second.length,
    }))

    const all = await new CharacterRepository(rpc).listAllCharacters()

    expect(all).toHaveLength(203)
    expect(calls).toHaveLength(2)
    expect(calls[0]).toEqual({ offset: 0, limit: BACKEND_PAGE_LIMIT })
    expect(calls[1]).toEqual({ offset: BACKEND_PAGE_LIMIT, limit: BACKEND_PAGE_LIMIT })
  })

  test('stops at an exact-total boundary without an extra request', async () => {
    const page = Array.from({ length: BACKEND_PAGE_LIMIT }, (_, i) => character(`c${i}`))
    const { rpc, calls } = listRpc(() => ({ data: page, total: BACKEND_PAGE_LIMIT }))

    const all = await new CharacterRepository(rpc).listAllCharacters()

    expect(all).toHaveLength(BACKEND_PAGE_LIMIT)
    // Exactly one request: asking for page 2 here would be a wasted roundtrip.
    expect(calls).toHaveLength(1)
  })

  test('terminates when a page returns zero items', async () => {
    // `total` deliberately lies (claims 10,000 more) to prove the empty-page
    // guard is what stops the loop, not the total.
    const { rpc, calls } = listRpc((offset) => ({
      data: offset === 0 ? [character('a'), character('b')] : [],
      total: 10_000,
    }))

    const all = await new CharacterRepository(rpc).listAllCharacters()

    expect(all.map((c) => c.id)).toEqual(['a', 'b'])
    expect(calls).toHaveLength(2)
  })

  test('handles total smaller than the first page', async () => {
    const page = [character('a'), character('b'), character('c')]
    const { rpc, calls } = listRpc(() => ({ data: page, total: 2 }))

    const all = await new CharacterRepository(rpc).listAllCharacters()

    expect(all).toHaveLength(3)
    expect(calls).toHaveLength(1)
  })

  test('returns [] immediately for an empty library', async () => {
    const { rpc, calls } = listRpc(() => ({ data: [], total: 0 }))
    const all = await new CharacterRepository(rpc).listAllCharacters()
    expect(all).toEqual([])
    expect(calls).toHaveLength(1)
  })

  test('reports progress with running loaded count and host total', async () => {
    const first = Array.from({ length: 10 }, (_, i) => character(`a${i}`))
    const second = Array.from({ length: 5 }, (_, i) => character(`b${i}`))
    const { rpc } = listRpc((offset) => ({ data: offset === 0 ? first : second, total: 15 }))

    const seen: Array<[number, number]> = []
    await new CharacterRepository(rpc).listAllCharacters((loaded, total) => seen.push([loaded, total]))

    expect(seen).toEqual([
      [10, 15],
      [15, 15],
    ])
  })

  test('dedupes repeated ids across pages', async () => {
    const { rpc } = listRpc((offset) => ({
      data: offset === 0 ? [character('a'), character('b')] : [character('b'), character('c')],
      total: 4,
    }))

    const all = await new CharacterRepository(rpc).listAllCharacters()

    expect(all.map((c) => c.id)).toEqual(['a', 'b', 'c'])
  })
})

/* -------------------------------------------------------------------------- */
/* getCharactersByIds                                                         */
/* -------------------------------------------------------------------------- */

describe('CharacterRepository.getCharactersByIds', () => {
  test('never exceeds the concurrency cap', async () => {
    let inFlight = 0
    let peak = 0
    const releases: Array<() => void> = []

    const rpc = {
      request: async (req: unknown) => {
        const { characterId } = req as { characterId: string }
        inFlight += 1
        peak = Math.max(peak, inFlight)
        await new Promise<void>((resolve) => releases.push(resolve))
        inFlight -= 1
        return {
          type: 'characters.get.result',
          requestId: 'x',
          character: character(characterId),
        } as BackendResponse
      },
    }
    const repo = new CharacterRepository(rpc as unknown as SpindleRpc)

    const ids = Array.from({ length: 40 }, (_, i) => `c${i}`)
    const pending = repo.getCharactersByIds(ids, 5)

    // Let the scheduler start the initial batch, then release it one wave at a
    // time so the pool is continuously exercised.
    for (let wave = 0; wave < 12; wave++) {
      await flush(3)
      for (const release of releases.splice(0)) release()
    }

    const map = await pending
    expect(peak).toBeLessThanOrEqual(5)
    expect(peak).toBeGreaterThan(1)
    expect(map.size).toBe(40)
  })

  test('omits ids whose character is null', async () => {
    const rpc = {
      request: async (req: unknown) => {
        const { characterId } = req as { characterId: string }
        const found = characterId === 'b' ? null : character(characterId)
        return { type: 'characters.get.result', requestId: 'x', character: found } as BackendResponse
      },
    }

    const map = await new CharacterRepository(rpc as unknown as SpindleRpc).getCharactersByIds(['a', 'b', 'c'])

    expect(map.has('a')).toBe(true)
    expect(map.has('b')).toBe(false)
    expect(map.has('c')).toBe(true)
  })

  test('one failing id does not fail the whole call', async () => {
    const rpc = {
      request: async (req: unknown) => {
        const { characterId } = req as { characterId: string }
        if (characterId === 'bad') {
          throw new SpindleRpcError('not_found', 'gone', false)
        }
        if (characterId === 'slow') {
          await flush(4)
        }
        return { type: 'characters.get.result', requestId: 'x', character: character(characterId) } as BackendResponse
      },
    }

    const map = await new CharacterRepository(rpc as unknown as SpindleRpc).getCharactersByIds([
      'a',
      'bad',
      'c',
      'slow',
      'd',
    ])

    expect([...map.keys()].sort()).toEqual(['a', 'c', 'd', 'slow'])
    expect(map.has('bad')).toBe(false)
  })

  test('deduplicates ids before issuing requests', async () => {
    let calls = 0
    const rpc = {
      request: async (req: unknown) => {
        calls += 1
        const { characterId } = req as { characterId: string }
        return { type: 'characters.get.result', requestId: 'x', character: character(characterId) } as BackendResponse
      },
    }

    const map = await new CharacterRepository(rpc as unknown as SpindleRpc).getCharactersByIds([
      'a',
      'b',
      'a',
      'b',
      'a',
    ])

    expect(calls).toBe(2)
    expect(map.size).toBe(2)
  })

  test('returns an empty map for an empty id list without any request', async () => {
    let calls = 0
    const rpc = {
      request: async () => {
        calls += 1
        throw new Error('should not be called')
      },
    }
    const map = await new CharacterRepository(rpc as unknown as SpindleRpc).getCharactersByIds([])
    expect(map.size).toBe(0)
    expect(calls).toBe(0)
  })
})

/* -------------------------------------------------------------------------- */
/* mapWithConcurrency                                                         */
/* -------------------------------------------------------------------------- */

describe('mapWithConcurrency', () => {
  test('preserves input order despite out-of-order completion', async () => {
    const delays = [30, 1, 20, 2, 10]
    const results = await mapWithConcurrency(delays, 5, async (ms, index) => {
      await new Promise((resolve) => setTimeout(resolve, ms))
      return index
    })
    expect(results.map((r) => (r.status === 'fulfilled' ? r.value : r.reason))).toEqual([0, 1, 2, 3, 4])
  })

  test('resolves settled results instead of rejecting when items fail', async () => {
    const results = await mapWithConcurrency([1, 2, 3], 2, async (n) => {
      if (n === 2) throw new Error('nope')
      return n * 10
    })
    expect(results).toHaveLength(3)
    expect(results[0]).toEqual({ status: 'fulfilled', value: 10 })
    expect(results[1]!.status).toBe('rejected')
    expect((results[1] as PromiseRejectedResult).reason.message).toBe('nope')
    expect(results[2]).toEqual({ status: 'fulfilled', value: 30 })
  })

  test('respects the concurrency cap', async () => {
    let inFlight = 0
    let peak = 0
    await mapWithConcurrency(Array.from({ length: 25 }, (_, i) => i), 4, async () => {
      inFlight += 1
      peak = Math.max(peak, inFlight)
      await flush(2)
      inFlight -= 1
    })
    expect(peak).toBeLessThanOrEqual(4)
    expect(peak).toBeGreaterThan(1)
  })

  test('guards limit < 1 by clamping to 1', async () => {
    let inFlight = 0
    let peak = 0
    await mapWithConcurrency([1, 2, 3, 4], 0, async () => {
      inFlight += 1
      peak = Math.max(peak, inFlight)
      await flush(2)
      inFlight -= 1
    })
    expect(peak).toBe(1)
  })

  test('handles an empty input array', async () => {
    expect(await mapWithConcurrency([], 4, async () => 1)).toEqual([])
  })
})

/* -------------------------------------------------------------------------- */
/* repository mutation + avatar                                               */
/* -------------------------------------------------------------------------- */

describe('CharacterRepository.updateTags', () => {
  test('sends the tags array and returns the updated character', async () => {
    let seen: unknown
    const rpc = {
      request: async (req: unknown) => {
        seen = req
        return {
          type: 'characters.updateTags.result',
          requestId: 'x',
          character: character('c1', { tags: ['Elf'] }),
        } as BackendResponse
      },
    }

    const updated = await new CharacterRepository(rpc as unknown as SpindleRpc).updateTags('c1', ['Elf'])
    expect(seen).toEqual({ type: 'characters.updateTags', characterId: 'c1', tags: ['Elf'] })
    expect(updated.tags).toEqual(['Elf'])
  })

  test('propagates backend errors as-is', async () => {
    const failure = new SpindleRpcError('forbidden', 'Missing characters permission', false)
    const rpc = {
      request: async () => {
        throw failure
      },
    }

    const repo = new CharacterRepository(rpc as unknown as SpindleRpc)
    // Same object identity: the executor classifies on code/retryable, so the
    // repository must not wrap or translate it.
    await expect(repo.updateTags('c1', ['Elf'])).rejects.toBe(failure)
  })
})

describe('CharacterRepository.avatarUrl', () => {
  test('builds the read-only avatar endpoint and encodes the id', () => {
    const repo = new CharacterRepository({} as unknown as SpindleRpc)
    expect(repo.avatarUrl('abc-123')).toBe('/api/v1/characters/abc-123/avatar')
    expect(repo.avatarUrl('a/b?c=d')).toBe('/api/v1/characters/a%2Fb%3Fc%3Dd/avatar')
  })
})