/**
 * Bounded-concurrency mapping helper.
 *
 * Deliberately NEVER rejects: it returns settled results so one failed item can
 * never abort a whole batch. Callers inspect each result to decide what a
 * failure means for them.
 */

/** Clamp a caller-supplied concurrency to a sane, always-usable value. */
function clampLimit(limit: number): number {
  if (!Number.isFinite(limit)) return 1
  const floored = Math.floor(limit)
  return floored >= 1 ? floored : 1
}

/**
 * Run `fn` over `items` with at most `limit` in flight at once.
 *
 * - Input order is preserved in the output.
 * - Never rejects; failures appear as `{ status: 'rejected' }` entries.
 * - `limit < 1` is coerced to 1 rather than deadlocking.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<PromiseSettledResult<R>[]> {
  const results = new Array<PromiseSettledResult<R>>(items.length)
  if (items.length === 0) return results

  const width = Math.min(clampLimit(limit), items.length)
  let next = 0

  async function worker(): Promise<void> {
    for (;;) {
      const index = next++
      if (index >= items.length) return
      try {
        results[index] = { status: 'fulfilled', value: await fn(items[index] as T, index) }
      } catch (reason) {
        results[index] = { status: 'rejected', reason }
      }
    }
  }

  await Promise.all(Array.from({ length: width }, () => worker()))
  return results
}