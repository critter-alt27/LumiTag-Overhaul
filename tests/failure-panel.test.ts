/**
 * Tests for the failure panel's bounded failure-row rendering.
 *
 * ## Why there is a DOM stub in here
 *
 * `bun test` provides no `document` (see `bunfig.toml`: no preloaded host shim)
 * and no DOM implementation is installed as a devDependency, so this renderer
 * cannot be exercised without one. `tests/tags-section.test.ts` builds the same
 * idea for the Tags section; this file mirrors its approach — a hand-rolled
 * subset installed on `globalThis` per test — and deliberately does NOT add a
 * jsdom/happy-dom dependency or touch `package.json`.
 *
 * The stub covers exactly what `ui/failure-panel.ts` and `ui/dom.ts` touch:
 * element/text creation, the tree, attributes, `dataset`, `textContent`,
 * `disabled`, and synchronous event dispatch. There is no layout, no CSS, no
 * event bubbling and no parsing — anything that starts needing those needs a
 * real implementation, not this file.
 *
 * ## What is asserted
 *
 * The panel must render at most `FAILURE_ROW_LIMIT` rows per group AND say so.
 * A capped list that looks like a complete one is the failure mode: a reader
 * concludes that a character was never attempted. The second half of that is
 * reachability — the hidden failures must still be retryable, which the tests
 * prove by clicking the group button and the Retry All button.
 */

import { afterEach, describe, expect, test } from 'bun:test'

import type { StoreView, TagManagerStore } from '../src/frontend/store'
import type { MutationResult, OperationReport } from '../src/frontend/mutations/report'
import { computeTotals, deriveStatus } from '../src/frontend/mutations/report'
import { renderFailurePanel } from '../src/frontend/ui/failure-panel'

// ---------------------------------------------------------------------------
// Minimal DOM stub
// ---------------------------------------------------------------------------

type Handler = (ev: { type: string; target: StubElement }) => void

class StubText {
  readonly nodeType = 3
  parentNode: StubElement | null = null
  constructor(readonly data: string) {}
}

class StubDocument {
  readonly body: StubElement

  constructor() {
    this.body = new StubElement('body')
  }

  createElement(tag: string): StubElement {
    return new StubElement(tag)
  }

  createTextNode(data: string): StubText {
    return new StubText(data)
  }
}

class StubElement {
  readonly nodeType = 1
  readonly childNodes: (StubElement | StubText)[] = []
  readonly attributes = new Map<string, string>()
  readonly dataset: Record<string, string> = {}
  parentNode: StubElement | null = null
  title = ''
  disabled = false

  private readonly handlers = new Map<string, Set<Handler>>()

  constructor(readonly tagName: string) {}

  get firstChild(): StubElement | StubText | null {
    return this.childNodes[0] ?? null
  }

  /** Concatenated text of every descendant, which is what a reader perceives. */
  get textContent(): string {
    return this.childNodes
      .map((c) => (c instanceof StubText ? c.data : c.textContent))
      .join('')
  }

  set textContent(value: string) {
    this.childNodes.length = 0
    if (value !== '') this.appendChild(new StubText(value))
  }

  appendChild(child: StubElement | StubText): StubElement | StubText {
    if (child instanceof StubElement && child.parentNode !== null) child.parentNode.removeChild(child)
    child.parentNode = this
    this.childNodes.push(child)
    return child
  }

  removeChild(child: StubElement | StubText): StubElement | StubText {
    const at = this.childNodes.indexOf(child)
    if (at < 0) throw new Error('removeChild: node is not a child')
    this.childNodes.splice(at, 1)
    if (child instanceof StubElement) child.parentNode = null
    return child
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value)
  }

  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null
  }

  removeAttribute(name: string): void {
    this.attributes.delete(name)
  }

  addEventListener(type: string, handler: Handler): void {
    const set = this.handlers.get(type) ?? new Set<Handler>()
    set.add(handler)
    this.handlers.set(type, set)
  }

  removeEventListener(type: string, handler: Handler): void {
    this.handlers.get(type)?.delete(handler)
  }

  dispatch(type: string): void {
    for (const handler of [...(this.handlers.get(type) ?? [])]) handler({ type, target: this })
  }

  /** Every descendant with the given tag name, in document order. */
  findAll(tag: string): StubElement[] {
    const found: StubElement[] = []
    const walk = (node: StubElement): void => {
      for (const child of node.childNodes) {
        if (!(child instanceof StubElement)) continue
        if (child.tagName === tag) found.push(child)
        walk(child)
      }
    }
    walk(this)
    return found
  }
}

function installDom(): StubDocument {
  const doc = new StubDocument()
  ;(globalThis as unknown as Record<string, unknown>)['document'] = doc
  return doc
}

afterEach(() => {
  delete (globalThis as unknown as Record<string, unknown>)['document']
})

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

let uidCounter = 0

function failed(characterId: string): MutationResult {
  uidCounter += 1
  return {
    mutationId: `m${uidCounter}`,
    characterId,
    characterName: characterId,
    op: 'remove',
    tag: 'Dragon',
    sourceTags: ['Dragon'],
    addedTags: [],
    removedTags: ['Dragon'],
    intendedChange: 'remove Dragon',
    state: 'failed',
    attempts: 1,
    retryable: true,
    uncertain: false,
    error: { message: 'The host refused the write.', code: 'forbidden' },
  }
}

function reportOf(results: MutationResult[], opId = 'op1'): OperationReport {
  return {
    opId,
    op: 'remove',
    label: 'remove Dragon',
    tags: ['Dragon'],
    startedAt: 0,
    finishedAt: 1,
    status: deriveStatus(results, false),
    results,
    totals: computeTotals(results),
  }
}

/** What the panel calls, so a test can prove a hidden failure is still covered. */
interface RetryCalls {
  retryOne: { opId: string; mutationId: string }[]
  retryGroup: { opId: string; groupKey: string }[]
  retryAll: { opId: string }[]
}

/**
 * `render()` reads only `store.view` and `store.version`; every action is
 * reached through a real button click, so the actions bag records the calls
 * rather than being an empty stub that could drift from the real store.
 */
function fakeStore(view: StoreView, calls: RetryCalls, subscribe: (l: () => void) => () => void): TagManagerStore {
  const actions = {
    retryOne: async (opId: string, mutationId: string): Promise<void> => {
      calls.retryOne.push({ opId, mutationId })
    },
    retryGroup: async (opId: string, groupKey: string): Promise<void> => {
      calls.retryGroup.push({ opId, groupKey })
    },
    retryAll: async (opId: string): Promise<void> => {
      calls.retryAll.push({ opId })
    },
    dismissReport: (): void => {},
    showReport: (): void => {},
  }
  return { view, actions, version: 1, subscribe } as unknown as TagManagerStore
}

/** `renderFailurePanel` only touches `reports`/`activeReportOpId` of the view. */
function viewFor(reports: OperationReport[]): StoreView {
  return { reports, activeReportOpId: reports[0]?.opId ?? null } as unknown as StoreView
}

function mount(container: StubElement, report: OperationReport) {
  const calls: RetryCalls = { retryOne: [], retryGroup: [], retryAll: [] }
  const listeners = new Set<() => void>()
  const store = fakeStore(viewFor([report]), calls, (l: () => void) => {
    listeners.add(l)
    return () => listeners.delete(l)
  })
  const handle = renderFailurePanel({
    container: container as unknown as HTMLElement,
    store,
  })
  return { handle, calls, listeners }
}

/** The rendered `<tbody>` rows — one per failure, plus the header row. */
function bodyRows(container: StubElement): StubElement[] {
  const tbodies = container.findAll('tbody')
  expect(tbodies.length).toBe(1)
  return tbodies[0].findAll('tr')
}

/** The button whose visible label contains `fragment`. */
function buttonLabelled(container: StubElement, fragment: string): StubElement {
  const found = container
    .findAll('button')
    .filter((b) => b.textContent.includes(fragment))
  expect(found.length).toBeGreaterThan(0)
  return found[0]
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('failure row cap', () => {
  test('a group under the cap renders every row and claims no truncation', () => {
    const doc = installDom()
    const container = doc.createElement('div')
    const report = reportOf(Array.from({ length: 5 }, (_, i) => failed(`c${i}`)))
    mount(container, report)

    expect(bodyRows(container)).toHaveLength(5)
    expect(container.textContent).not.toContain('Showing')
  })

  test('a group over the cap renders exactly the cap and says how many are hidden', () => {
    const doc = installDom()
    const container = doc.createElement('div')
    const report = reportOf(Array.from({ length: 320 }, (_, i) => failed(`c${i}`)))
    mount(container, report)

    expect(bodyRows(container)).toHaveLength(300)
    const text = container.textContent
    // The honest part: the count of what is NOT on screen, in visible text.
    expect(text).toContain('Showing 300 of 320')
    // And the direction of the overflow — "320 failures", never "300 failures".
    expect(text).toContain('320 failures')
  })

  test('the table caption tells a screen reader the row list is partial', () => {
    const doc = installDom()
    const container = doc.createElement('div')
    mount(container, reportOf(Array.from({ length: 400 }, (_, i) => failed(`c${i}`))))

    const captions = container.findAll('caption')
    expect(captions).toHaveLength(1)
    expect(captions[0].textContent).toContain('the first 300 of 400 failed characters')
    // The caption must NOT still claim "one row per character" while capping.
    expect(captions[0].textContent).not.toContain('one row per character')
  })

  test('the tag badge counts the tags it does not name', () => {
    const doc = installDom()
    const container = doc.createElement('div')
    const report = reportOf([failed('c0')])
    report.tags = Array.from({ length: 20 }, (_, i) => `tag${i}`)
    mount(container, report)

    // Twelve names plus an explicit count: a truncated tag list is never
    // presented as the whole one. The full summary below it is deliberately
    // untruncated, so the check is scoped to the badge.
    const badge = container.findAll('span').filter((s) => s.textContent.startsWith('tags:'))
    expect(badge).toHaveLength(1)
    expect(badge[0].textContent).toContain('tag11 +8 more')
    expect(badge[0].textContent).not.toContain('tag12')
  })

  test('a hidden failure is still retried by the group button', async () => {
    const doc = installDom()
    const container = doc.createElement('div')
    const results = Array.from({ length: 320 }, (_, i) => failed(`c${i}`))
    const { calls, handle } = mount(container, reportOf(results))

    buttonLabelled(container, 'Retry 320 failed').dispatch('click')
    await Promise.resolve()
    await Promise.resolve()

    expect(calls.retryGroup).toHaveLength(1)
    // The call carries the GROUP key, and the executor expands it over every
    // failure in the group — the 20 rows the panel never rendered included.
    expect(calls.retryGroup[0].opId).toBe('op1')
    expect(calls.retryGroup[0].groupKey).toBe('dragon')
    handle.destroy()
  })

  test('every hidden failure is still retried by Retry All', async () => {
    const doc = installDom()
    const container = doc.createElement('div')
    const results = Array.from({ length: 320 }, (_, i) => failed(`c${i}`))
    const { calls, handle } = mount(container, reportOf(results))

    buttonLabelled(container, 'Retry All Remaining Failures').dispatch('click')
    await Promise.resolve()
    await Promise.resolve()

    expect(calls.retryAll).toEqual([{ opId: 'op1' }])
    expect(container.textContent).toContain('320 characters still outstanding')
    handle.destroy()
  })

  test('the truncation notice names the controls that still cover the hidden rows', () => {
    const doc = installDom()
    const container = doc.createElement('div')
    mount(container, reportOf(Array.from({ length: 320 }, (_, i) => failed(`c${i}`))))

    const notice = container
      .findAll('p')
      .filter((p) => p.textContent.includes('Showing 300 of 320'))
    expect(notice).toHaveLength(1)
    expect(notice[0].textContent).toContain('Retry 320 failed')
    expect(notice[0].textContent).toContain('Retry All Remaining Failures')
    expect(notice[0].textContent).toContain('full summary')
  })

  test('the full summary still names every failure, rendered or not', () => {
    const doc = installDom()
    const container = doc.createElement('div')
    const results = Array.from({ length: 320 }, (_, i) => failed(`c${i}`))
    mount(container, reportOf(results))

    const pre = container.findAll('pre')
    expect(pre).toHaveLength(1)
    // `summarizeReport` is untruncated by contract, so nothing is unreachable.
    for (const i of [0, 250, 319]) expect(pre[0].textContent).toContain(`c${i}`)
  })

  test('a re-render rebuilds the capped list without leaking rows into it', () => {
    const doc = installDom()
    const container = doc.createElement('div')
    const results = Array.from({ length: 320 }, (_, i) => failed(`c${i}`))
    const { handle, listeners } = mount(container, reportOf(results))

    expect(bodyRows(container)).toHaveLength(300)
    for (const listener of listeners) listener()
    // `clear()` empties the container first, so a re-render cannot append a
    // second capped table on top of the first.
    expect(container.findAll('tbody')).toHaveLength(1)
    expect(bodyRows(container)).toHaveLength(300)
    handle.destroy()
    expect(container.childNodes).toHaveLength(0)
  })
})