/**
 * Regression tests for the Tags section's search focus/caret restoration.
 *
 * ## Why there is a DOM stub in here
 *
 * LumiTag's unit tests are deliberately standalone (see `bunfig.toml`: no
 * preloaded host DOM shim, no dependency on Lumiverse's frontend globals), and
 * no DOM implementation is installed as a devDependency. `bun test` therefore
 * provides no `document` at all, and `ui/tags-section.ts` cannot be exercised
 * without one.
 *
 * Rather than add a dependency and a global preloading step — which would
 * change `package.json`, `bun.lock` and `bunfig.toml` for the whole suite — the
 * minimal DOM subset this renderer actually touches is implemented below and
 * installed on `globalThis` for the duration of each test.
 *
 * The stub is deliberately faithful on the three behaviours the tests are about:
 *
 *  1. `document.activeElement` is tracked, `focus()` blurs the previous element
 *     and then focuses the new one, and detaching a focused node falls back to
 *     `<body>` — the behaviour the module-level focus intent exists to survive.
 *  2. `classList.contains`, `dataset`, `selectionStart/End`, `focus()` and
 *     `setSelectionRange()` behave as the renderer expects, so `instanceof
 *     HTMLInputElement` and the `input.lt-search` query resolve correctly.
 *  3. Events are dispatched synchronously and are removed by `teardown()`,
 *     which is what lets the tests prove the listener lifecycle.
 *
 * It is NOT a general-purpose DOM: there is no layout, no event bubbling, no
 * parsing and no CSS. Anything that starts depending on those needs a real
 * implementation, not this file.
 */

import { afterEach, describe, expect, test } from 'bun:test'

import type { StoreView, TagListRow, TagManagerStore } from '../src/frontend/store'
import { buildTagIndex } from '../src/frontend/tag-index'
import { renderTagsSection } from '../src/frontend/ui/tags-section'
import type { LumiTagCharacter } from '../src/shared/types'

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
  activeElement: StubElement | null

  constructor() {
    this.body = new StubElement(this, 'body')
    this.activeElement = this.body
  }

  createElement(tag: string): StubElement {
    return tag === 'input' ? new HTMLInputElementStub(this, tag) : new StubElement(this, tag)
  }

  createTextNode(data: string): StubText {
    return new StubText(data)
  }
}

class StubElement {
  readonly nodeType = 1
  readonly childNodes: (StubElement | StubText)[] = []
  readonly attributes = new Map<string, string>()
  readonly handlers = new Map<string, Set<Handler>>()
  readonly dataset: Record<string, string> = {}
  parentNode: StubElement | null = null
  title = ''

  constructor(
    readonly ownerDocument: StubDocument,
    readonly tagName: string,
  ) {}

  // --- tree ---------------------------------------------------------------

  get firstChild(): StubElement | StubText | null {
    return this.childNodes[0] ?? null
  }

  get isConnected(): boolean {
    let node: StubElement = this
    while (node.parentNode !== null) node = node.parentNode
    return node === this.ownerDocument.body
  }

  appendChild(child: StubElement | StubText): StubElement | StubText {
    if (child instanceof StubElement && child.parentNode !== null) child.parentNode.removeChild(child)
    child.parentNode = this
    this.childNodes.push(child)
    return child
  }

  insertBefore(child: StubElement | StubText, ref: StubElement | StubText | null): StubElement | StubText {
    if (child instanceof StubElement && child.parentNode !== null) child.parentNode.removeChild(child)
    child.parentNode = this
    const at = ref === null ? -1 : this.childNodes.indexOf(ref)
    if (at < 0) this.childNodes.push(child)
    else this.childNodes.splice(at, 0, child)
    return child
  }

  removeChild(child: StubElement | StubText): StubElement | StubText {
    const at = this.childNodes.indexOf(child)
    if (at < 0) throw new Error('removeChild: node is not a child')
    this.childNodes.splice(at, 1)
    if (child instanceof StubElement) {
      child.parentNode = null
      this.releaseFocusHeldBy(child)
    }
    return child
  }

  /** Whether `node` is `this` or sits inside it. */
  owns(node: StubElement | null): boolean {
    let cur: StubElement | null = node
    while (cur !== null) {
      if (cur === this) return true
      cur = cur.parentNode
    }
    return false
  }

  /**
   * Detaching a focused node drops focus to `<body>` and fires `blur`, exactly
   * as a real engine does — which is why `tags-section` cannot tell a torn-down
   * panel from a reader who simply looked away without inspecting the node.
   */
  private releaseFocusHeldBy(detached: StubElement): void {
    const doc = this.ownerDocument
    const active = doc.activeElement
    if (!detached.owns(active)) return
    doc.activeElement = doc.body
    if (active !== null) active.dispatch('blur')
  }

  // --- attributes ---------------------------------------------------------

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value)
  }

  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null
  }

  get classList(): { contains(name: string): boolean } {
    const names = (this.attributes.get('class') ?? '').split(/\s+/).filter((n) => n !== '')
    return { contains: (name: string) => names.includes(name) }
  }

  // --- selectors ----------------------------------------------------------

  /** Supports exactly the `tag.class[.class…]` form used by the renderer. */
  querySelectorAll(selector: string): StubElement[] {
    const [tag, ...classes] = selector.split('.')
    const matches = (node: StubElement): boolean =>
      node.tagName === tag && classes.every((c) => node.classList.contains(c))
    const found: StubElement[] = []
    const walk = (node: StubElement): void => {
      for (const child of node.childNodes) {
        if (!(child instanceof StubElement)) continue
        if (matches(child)) found.push(child)
        walk(child)
      }
    }
    walk(this)
    return found
  }

  querySelector(selector: string): StubElement | null {
    return this.querySelectorAll(selector)[0] ?? null
  }

  // --- events -------------------------------------------------------------

  addEventListener(type: string, handler: Handler): void {
    const set = this.handlers.get(type) ?? new Set<Handler>()
    set.add(handler)
    this.handlers.set(type, set)
  }

  removeEventListener(type: string, handler: Handler): void {
    this.handlers.get(type)?.delete(handler)
  }

  dispatch(type: string): void {
    for (const handler of [...(this.handlers.get(type) ?? [])]) {
      handler({ type, target: this })
    }
  }

  /** Every listener still attached, so a leaked one is assertable. */
  listenerCount(type: string): number {
    return this.handlers.get(type)?.size ?? 0
  }

  // --- focus --------------------------------------------------------------

  focus(): void {
    const doc = this.ownerDocument
    const previous = doc.activeElement
    if (previous !== null && previous !== this) previous.dispatch('blur')
    doc.activeElement = this
    this.dispatch('focus')
  }
}

/**
 * The one input type the renderer builds. It doubles as the global
 * `HTMLInputElement`, because `tags-section` narrows with `instanceof
 * HTMLInputElement` — the global has to be the very class the stub hands out.
 */
class HTMLInputElementStub extends StubElement {
  value = ''
  checked = false
  disabled = false
  selectionStart: number | null = 0
  selectionEnd: number | null = 0

  setSelectionRange(start: number, end: number): void {
    this.selectionStart = start
    this.selectionEnd = end
  }
}

function installDom(): StubDocument {
  const doc = new StubDocument()
  const g = globalThis as unknown as Record<string, unknown>
  g['document'] = doc
  g['HTMLInputElement'] = HTMLInputElementStub
  return doc
}

function uninstallDom(): void {
  const g = globalThis as unknown as Record<string, unknown>
  delete g['document']
  delete g['HTMLInputElement']
}

let currentDoc: StubDocument | null = null

afterEach(() => {
  // Blur the search box through a real focus move so the module-level focus
  // intent does not leak into the next test (`destroy()` intentionally keeps it
  // for the incoming panel, so it is the test's job to clear it here).
  currentDoc?.body.focus()
  currentDoc = null
  uninstallDom()
})

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

function character(id: string, name: string, tags: string[]): LumiTagCharacter {
  return {
    id,
    name,
    description: '',
    personality: '',
    scenario: '',
    creator: '',
    creator_notes: '',
    system_prompt: '',
    tags: [...tags],
    image_id: null,
    created_at: 0,
    updated_at: 0,
  }
}

const CHARACTERS: LumiTagCharacter[] = [
  character('c1', 'Legolas', ['elf', 'forest']),
  character('c2', 'Aragorn', ['forest', 'ranger']),
]
const INDEX = buildTagIndex(CHARACTERS)

/**
 * A full, hand-built `StoreView`.
 *
 * Written as a complete literal rather than a partial stub so that a new field
 * on the real interface is a type error here instead of a silent `undefined`
 * in a test that is supposed to be modelling the real render.
 */
function makeView(overrides: Partial<StoreView> = {}): StoreView {
  const tagRows: TagListRow[] = INDEX.tags.map((entry) => ({
    entry,
    expanded: false,
    selected: false,
  }))
  return {
    section: 'tags',
    loadState: 'ready',
    loadError: null,
    isRefreshing: false,
    characters: CHARACTERS,
    characterCount: CHARACTERS.length,
    tagIndex: INDEX,
    tagRows,
    tagQuery: '',
    tagQueryErrors: [],
    tagQueryIsCharacterMode: false,
    tagQueryCharacters: [],
    tagSort: 'name_asc',
    tagMode: 'normal',
    selectedTagKeys: [],
    selectedTagCount: 0,
    mergePrimaryKey: null,
    mergeTargetKeys: [],
    mergeValid: false,
    characterRows: [],
    characterQuery: '',
    characterQueryErrors: [],
    characterSort: 'name_asc',
    characterTagFilter: 'all',
    activeFilterTagKeys: [],
    selectedCharacterIds: [],
    selectedAssignTagKeys: [],
    reports: [],
    activeReportOpId: null,
    untaggedCount: 0,
    lastRefreshedAt: null,
    ...overrides,
  }
}

/**
 * `render()` only reads `store.view`; every action is reached through a
 * listener, and no test dispatches one, so the actions bag is left empty rather
 * than mocked into a shape that could drift from the real store.
 */
function fakeStore(view: StoreView): TagManagerStore {
  return { view, actions: {} } as unknown as TagManagerStore
}

function mount(container: StubElement, view: StoreView): { destroy(): void } {
  return renderTagsSection({ container: container as unknown as HTMLElement, store: fakeStore(view) })
}

function newContainer(doc: StubDocument): StubElement {
  const container = doc.createElement('div')
  doc.body.appendChild(container)
  return container
}

function searchIn(container: StubElement): HTMLInputElementStub {
  const found = container.querySelectorAll('input.lt-search')
  expect(found.length).toBe(1)
  return found[0] as HTMLInputElementStub
}

/** Simulate the reader typing `value` and leaving the caret at `caret`. */
function type(search: HTMLInputElementStub, value: string, caret: number): void {
  search.value = value
  search.setSelectionRange(caret, caret)
  search.dispatch('keyup')
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('tags section search focus restoration', () => {
  test('render does not throw while a tag search box holds focus', () => {
    currentDoc = installDom()
    const doc = currentDoc
    const container = newContainer(doc)

    // A search box that is still connected AND still focused — the state a
    // re-render sees when the search control survives the rebuild. `render()`
    // reads it as the focus intent and then hands that intent to the box it is
    // about to build, which is the path that used to throw
    // `ReferenceError: prevValue is not defined`.
    const live = doc.createElement('input') as HTMLInputElementStub
    live.setAttribute('class', 'lt-search')
    doc.body.appendChild(live)
    live.value = 'forest'
    live.setSelectionRange(3, 3)
    live.focus()

    expect(() => mount(container, makeView({ tagQuery: 'forest' }))).not.toThrow()

    const after = searchIn(container)
    expect(doc.activeElement).toBe(after)
    expect(after.selectionStart).toBe(3)
  })

  test('render does not throw when the search box is focused and the panel rebuilds', () => {
    currentDoc = installDom()
    const doc = currentDoc
    const container = newContainer(doc)

    let handle = mount(container, makeView())
    const before = searchIn(container)
    type(before, 'forest', 3)

    // The shell rebuilds a section by releasing the outgoing one and mounting a
    // fresh one, so this is the exact sequence a store commit produces.
    expect(() => {
      handle.destroy()
      handle = mount(container, makeView({ tagQuery: 'forest' }))
    }).not.toThrow()

    const after = searchIn(container)
    expect(after).not.toBe(before)
    expect(after.value).toBe('forest')
    expect(container.querySelectorAll('input.lt-search').length).toBe(1)
  })

  test('a rebuilt panel regains focus and puts the caret back where it was', () => {
    currentDoc = installDom()
    const doc = currentDoc
    const container = newContainer(doc)

    let handle = mount(container, makeView())
    const before = searchIn(container)
    before.focus()
    type(before, 'forest', 3)

    handle.destroy()
    handle = mount(container, makeView({ tagQuery: 'forest' }))

    const after = searchIn(container)
    expect(doc.activeElement).toBe(after)
    expect(after.selectionStart).toBe(3)
    expect(after.selectionEnd).toBe(3)
  })

  test('a caret at offset 0 in a non-empty query is still restored', () => {
    currentDoc = installDom()
    const doc = currentDoc
    const container = newContainer(doc)

    let handle = mount(container, makeView())
    const before = searchIn(container)
    before.focus()
    type(before, 'forest', 0)

    handle.destroy()
    handle = mount(container, makeView({ tagQuery: 'forest' }))

    const after = searchIn(container)
    expect(doc.activeElement).toBe(after)
    expect(after.selectionStart).toBe(0)
  })

  test('an empty query at offset 0 does not take focus back', () => {
    currentDoc = installDom()
    const doc = currentDoc
    const container = newContainer(doc)

    let handle = mount(container, makeView())
    searchIn(container).focus()

    handle.destroy()
    handle = mount(container, makeView())

    // There is nothing to restore, so the rebuilt box must not pull focus back
    // from wherever the reader has since moved to.
    expect(doc.activeElement).toBe(doc.body)
    expect(container.querySelectorAll('input.lt-search').length).toBe(1)
  })

  test('focus the reader genuinely gave up is not stolen back', () => {
    currentDoc = installDom()
    const doc = currentDoc
    const container = newContainer(doc)

    let handle = mount(container, makeView())
    const before = searchIn(container)
    before.focus()
    type(before, 'forest', 3)

    // A real focus move, with the input still in the document.
    doc.body.focus()
    expect(before.isConnected).toBe(true)

    handle.destroy()
    handle = mount(container, makeView({ tagQuery: 'forest' }))

    expect(doc.activeElement).toBe(doc.body)
  })

  test('a panel torn down while the search box is focused hands the intent on', () => {
    currentDoc = installDom()
    const doc = currentDoc
    const container = newContainer(doc)

    let handle = mount(container, makeView())
    const before = searchIn(container)
    before.focus()
    type(before, 'forest', 3)

    handle.destroy()
    // `destroy()` detaches the focused input, which blurs it. The panel is
    // being REPLACED, not abandoned, so the intent has to survive that blur.
    expect(doc.activeElement).toBe(doc.body)

    handle = mount(container, makeView({ tagQuery: 'forest' }))
    const after = searchIn(container)
    expect(doc.activeElement).toBe(after)
    expect(after.selectionStart).toBe(3)
  })

  test('the loading frame restores focus too', () => {
    currentDoc = installDom()
    const doc = currentDoc
    const container = newContainer(doc)

    let handle = mount(container, makeView())
    const before = searchIn(container)
    before.focus()
    type(before, 'forest', 3)

    handle.destroy()
    handle = mount(container, makeView({ loadState: 'loading', tagQuery: 'forest' }))

    const after = searchIn(container)
    expect(doc.activeElement).toBe(after)
    expect(after.selectionStart).toBe(3)

    // …and the intent survives into the loaded frame that replaces it.
    handle.destroy()
    handle = mount(container, makeView({ tagQuery: 'forest' }))
    const loaded = searchIn(container)
    expect(doc.activeElement).toBe(loaded)
    expect(loaded.selectionStart).toBe(3)
  })

  test('destroy releases every listener it attached', () => {
    currentDoc = installDom()
    const doc = currentDoc
    const container = newContainer(doc)

    const handle = mount(container, makeView())
    const before = searchIn(container)
    before.focus()

    handle.destroy()

    expect(before.listenerCount('input')).toBe(0)
    expect(before.listenerCount('focus')).toBe(0)
    expect(before.listenerCount('blur')).toBe(0)
    expect(before.listenerCount('keyup')).toBe(0)
    expect(before.listenerCount('select')).toBe(0)
    expect(container.childNodes.length).toBe(0)
  })
})