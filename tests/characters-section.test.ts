/**
 * Regression tests for the Characters section's search focus/caret
 * restoration across the shell's full rebuilds.
 *
 * ## Why there is a DOM stub in here
 *
 * LumiTag's unit tests are deliberately standalone (see `bunfig.toml`: no
 * preloaded host DOM shim, no dependency on Lumiverse's frontend globals), and
 * no DOM implementation is installed as a devDependency. `bun test` therefore
 * provides no `document` at all, and `ui/characters-section.ts` cannot be
 * exercised without one.
 *
 * Rather than add a dependency and a global preloading step — which would
 * change `package.json`, `bun.lock` and `bunfig.toml` for the whole suite — the
 * minimal DOM subset this renderer actually touches is implemented below and
 * installed on `globalThis` for the duration of each test. It is the same
 * approach, and largely the same stub, as `tests/tags-section.test.ts`.
 *
 * The stub is deliberately faithful on the behaviours the tests are about:
 *
 *  1. `document.activeElement` is tracked, `focus()` blurs the previous element
 *     and then focuses the new one, and detaching a focused node falls back to
 *     `<body>` and fires `blur` — the behaviour the module-level focus intent
 *     exists to survive.
 *  2. `classList.contains`, `dataset` (including the `data-lt-search` →
 *     `dataset.ltSearch` reflection), `selectionStart/End`, `focus()`,
 *     `setSelectionRange()` and `open` behave as the renderer expects, so the
 *     `tag[attr="value"]`, `.class` and `tag.class` selectors resolve.
 *  3. Events are dispatched synchronously and are removed by `teardown()`,
 *     which is what lets the tests prove the listener lifecycle.
 *
 * It is NOT a general-purpose DOM: there is no layout, no event bubbling, no
 * parsing and no CSS.
 */

import { afterEach, describe, expect, jest, test } from 'bun:test'

import type { CharacterListRow, StoreView, TagManagerStore } from '../src/frontend/store'
import { buildTagIndex } from '../src/frontend/tag-index'
import { renderCharactersSection, SEARCH_DEBOUNCE_MS } from '../src/frontend/ui/characters-section'
import { setDialogOpener } from '../src/frontend/ui/dialog-host'
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

/** `data-foo-bar` → `fooBar`, the `dataset` naming rule. */
function datasetKey(attribute: string): string {
  return attribute.replace(/^data-/, '').replace(/-([a-z])/g, (_m, c: string) => c.toUpperCase())
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
  readonly dataset: Record<string, string | undefined> = {}
  readonly style: Record<string, string> = {}
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

  /** `<details open>`; the renderer reads `open` after setting the attribute. */
  get open(): boolean {
    return this.attributes.has('open')
  }

  get textContent(): string {
    return this.childNodes.map((c) => (c instanceof StubText ? c.data : c.textContent)).join('')
  }

  set textContent(value: string) {
    this.childNodes.length = 0
    if (value !== '') this.childNodes.push(new StubText(value))
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
   * as a real engine does — which is why `characters-section` cannot tell a
   * torn-down panel from a reader who simply looked away without inspecting the
   * node.
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
    // Real `dataset` reflects `data-*`; `render()` reads `dataset.ltSearch` off
    // a box that was built through `setAttribute`, so the stub must too.
    if (name.startsWith('data-')) this.dataset[datasetKey(name)] = value
  }

  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null
  }

  removeAttribute(name: string): void {
    this.attributes.delete(name)
    if (name.startsWith('data-')) delete this.dataset[datasetKey(name)]
  }

  get classList(): { contains(name: string): boolean } {
    const names = (this.attributes.get('class') ?? '').split(/\s+/).filter((n) => n !== '')
    return { contains: (name: string) => names.includes(name) }
  }

  // --- selectors ----------------------------------------------------------

  /**
   * The three selector shapes this renderer uses: `.class`, `tag.class…` and
   * `tag[data-attr="value"]`.
   */
  private matches(selector: string, node: StubElement): boolean {
    const parsed = /^([a-zA-Z]*)(?:\[([a-zA-Z-]+)="([^"]*)"\])?((?:\.[^.[\s]+)*)$/.exec(selector)
    if (parsed === null) throw new Error(`stub selector unsupported: ${selector}`)
    const [, tag, attr, value, classPart] = parsed
    if (tag !== '' && node.tagName !== tag.toLowerCase()) return false
    if (attr !== undefined && node.getAttribute(attr) !== value) return false
    return classPart
      .split('.')
      .filter((c) => c !== '')
      .every((c) => node.classList.contains(c))
  }

  querySelectorAll(selector: string): StubElement[] {
    const found: StubElement[] = []
    const walk = (node: StubElement): void => {
      for (const child of node.childNodes) {
        if (!(child instanceof StubElement)) continue
        if (this.matches(selector, child)) found.push(child)
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
 * `HTMLInputElement`, because `characters-section` narrows with `instanceof
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
  jest.useRealTimers()
  // Blur the search box through a real focus move so the module-level focus
  // intent does not leak into the next test. `destroy()` intentionally keeps it
  // for the incoming panel, so clearing it is the test's job, and only the
  // connected-input `blur` path can do it — the same path a real reader takes
  // when they click away.
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
 * on the real interface is a type error here instead of a silent `undefined` in
 * a test that is supposed to be modelling the real render.
 */
function makeView(overrides: Partial<StoreView> = {}): StoreView {
  const characterRows: CharacterListRow[] = CHARACTERS.map((c) => ({
    character: c,
    tags: [...c.tags],
    selected: false,
  }))
  return {
    section: 'characters',
    tagPage: 0,
    tagPageCount: 1,
    tagPageRows: [],
    characterPage: 0,
    characterPageCount: 1,
    characterPageRows: characterRows,
    loadState: 'ready',
    loadError: null,
    isRefreshing: false,
    characters: CHARACTERS,
    characterCount: CHARACTERS.length,
    tagIndex: INDEX,
    tagRows: [],
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
    characterRows,
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
 * `render()` only reads `store.view`; the actions bag is a bag of no-ops rather
 * than a mock shape, because the debounced search commit really does fire here
 * (under fake timers) and must not throw out of a timer callback.
 */
function fakeStore(view: StoreView): TagManagerStore {
  const noop = (): void => {}
  return {
    view,
    actions: {
      setCharacterQuery: noop,
      setTagQuery: noop,
      setCharacterSort: noop,
      setCharacterTagFilter: noop,
      toggleCharacterSelected: noop,
      setActiveFilterTags: noop,
      setAssignTagSelection: noop,
      clearCharacterSelection: noop,
      selectAllVisibleCharacters: noop,
    },
  } as unknown as TagManagerStore
}

function mount(container: StubElement, view: StoreView): { destroy(): void } {
  return renderCharactersSection({
    container: container as unknown as HTMLElement,
    store: fakeStore(view),
  })
}

function newContainer(doc: StubDocument): StubElement {
  const container = doc.createElement('div')
  doc.body.appendChild(container)
  return container
}

/** The search box for a slot, addressed the way the renderer addresses it. */
function searchIn(container: StubElement, slot: string): HTMLInputElementStub {
  const found = container.querySelector(`input[data-lt-search="${slot}"]`)
  expect(found).not.toBeNull()
  return found as HTMLInputElementStub
}

/** Every search box the frame built, in document order. */
function allSearches(container: StubElement): HTMLInputElementStub[] {
  return container.querySelectorAll('input.lt-search') as HTMLInputElementStub[]
}

/** Simulate the reader typing `value` and leaving the caret at `caret`. */
function type(search: HTMLInputElementStub, value: string, caret: number): void {
  search.value = value
  search.setSelectionRange(caret, caret)
  search.dispatch('keyup')
}

/**
 * Type into a PICKER box and let its debounce fire.
 *
 * A picker's query is view state the panel re-renders itself on, so this is the
 * real commit path for those slots — no shell rebuild involved.
 */
function typeIntoPickerAndCommit(
  search: HTMLInputElementStub,
  value: string,
  caret: number,
): void {
  jest.useFakeTimers()
  search.value = value
  search.setSelectionRange(caret, caret)
  search.dispatch('input')
  // The REAL debounce, not a literal: a hardcoded 1000 here outlived the
  // source's debounce change and left these tests asserting against a rebuild
  // that never happened.
  jest.advanceTimersByTime(SEARCH_DEBOUNCE_MS)
  jest.useRealTimers()
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('characters section search focus restoration', () => {
  test('the panel builds one search box per slot', () => {
    currentDoc = installDom()
    const doc = currentDoc
    const container = newContainer(doc)

    mount(container, makeView())

    // The multi-slot design is the point: the main search plus one per picker,
    // and focus has to be restorable in ANY of them.
    expect(allSearches(container).map((s) => s.getAttribute('data-lt-search'))).toEqual([
      'characters',
      'active-filter-tags',
      'assign-tags',
    ])
  })

  test('a rebuilt panel regains focus and puts the caret back where it was', () => {
    currentDoc = installDom()
    const doc = currentDoc
    const container = newContainer(doc)

    let handle = mount(container, makeView())
    const before = searchIn(container, 'characters')
    before.focus()
    type(before, 'forest', 3)

    // The shell rebuilds a section by releasing the outgoing one and mounting a
    // fresh one, so this is the exact sequence a store commit produces.
    handle.destroy()
    handle = mount(container, makeView({ characterQuery: 'forest' }))

    const after = searchIn(container, 'characters')
    expect(after).not.toBe(before)
    expect(doc.activeElement).toBe(after)
    expect(after.selectionStart).toBe(3)
    expect(after.selectionEnd).toBe(3)
  })

  test('a caret at offset 0 in a non-empty query is still restored', () => {
    currentDoc = installDom()
    const doc = currentDoc
    const container = newContainer(doc)

    let handle = mount(container, makeView())
    const before = searchIn(container, 'characters')
    before.focus()
    type(before, 'forest', 0)

    handle.destroy()
    handle = mount(container, makeView({ characterQuery: 'forest' }))

    const after = searchIn(container, 'characters')
    expect(doc.activeElement).toBe(after)
    expect(after.selectionStart).toBe(0)
  })

  test('an empty query at offset 0 does not take focus back', () => {
    currentDoc = installDom()
    const doc = currentDoc
    const container = newContainer(doc)

    let handle = mount(container, makeView())
    searchIn(container, 'characters').focus()

    handle.destroy()
    handle = mount(container, makeView())

    // There is nothing to restore, so the rebuilt box must not pull focus back
    // from wherever the reader has since moved to.
    expect(doc.activeElement).toBe(doc.body)
    expect(allSearches(container).length).toBe(3)
  })

  test('focus the reader genuinely gave up is not stolen back', () => {
    currentDoc = installDom()
    const doc = currentDoc
    const container = newContainer(doc)

    let handle = mount(container, makeView())
    const before = searchIn(container, 'characters')
    before.focus()
    type(before, 'forest', 3)

    // A real focus move, with the input still in the document.
    doc.body.focus()
    expect(before.isConnected).toBe(true)

    handle.destroy()
    handle = mount(container, makeView({ characterQuery: 'forest' }))

    expect(doc.activeElement).toBe(doc.body)
  })

  test('a panel torn down while the search box is focused hands the intent on', () => {
    currentDoc = installDom()
    const doc = currentDoc
    const container = newContainer(doc)

    let handle = mount(container, makeView())
    const before = searchIn(container, 'characters')
    before.focus()
    type(before, 'forest', 3)

    handle.destroy()
    // `destroy()` detaches the focused input, which blurs it. The panel is
    // being REPLACED, not abandoned, so the intent has to survive that blur.
    expect(doc.activeElement).toBe(doc.body)

    handle = mount(container, makeView({ characterQuery: 'forest' }))
    const after = searchIn(container, 'characters')
    expect(doc.activeElement).toBe(after)
    expect(after.selectionStart).toBe(3)
  })

  test('a picker slot keeps focus and caret through a rebuild', () => {
    currentDoc = installDom()
    const doc = currentDoc
    const container = newContainer(doc)

    let handle = mount(container, makeView())
    const before = searchIn(container, 'assign-tags')
    before.focus()
    // The picker query is view state the panel re-renders itself from, so the
    // commit path is the debounce rather than a shell rebuild.
    typeIntoPickerAndCommit(before, 'forest', 4)

    const rebuilt = searchIn(container, 'assign-tags')
    expect(rebuilt).not.toBe(before)
    expect(rebuilt.value).toBe('forest')
    expect(doc.activeElement).toBe(rebuilt)
    expect(rebuilt.selectionStart).toBe(4)

    // …and the shell's own rebuild keeps it in the same slot.
    handle.destroy()
    handle = mount(container, makeView())
    const after = searchIn(container, 'assign-tags')
    expect(doc.activeElement).toBe(after)
    expect(after.value).toBe('forest')
    expect(after.selectionStart).toBe(4)
  })

  test('a caret at offset 0 in a non-empty picker query is still restored', () => {
    currentDoc = installDom()
    const doc = currentDoc
    const container = newContainer(doc)

    mount(container, makeView())
    const before = searchIn(container, 'active-filter-tags')
    before.focus()
    typeIntoPickerAndCommit(before, 'elf', 0)

    const after = searchIn(container, 'active-filter-tags')
    expect(after.value).toBe('elf')
    expect(doc.activeElement).toBe(after)
    expect(after.selectionStart).toBe(0)
  })

  test('focus in one slot is never restored into another', () => {
    currentDoc = installDom()
    const doc = currentDoc
    const container = newContainer(doc)

    let handle = mount(container, makeView())
    const main = searchIn(container, 'characters')
    main.focus()
    type(main, 'forest', 3)

    // Moving between slots records the new one; the intent is a SLOT NAME, not
    // a boolean, so the rebuild has to follow the reader.
    const picker = searchIn(container, 'assign-tags')
    picker.focus()
    type(picker, 'elf', 1)

    handle.destroy()
    handle = mount(container, makeView({ characterQuery: 'forest' }))

    expect(doc.activeElement).toBe(searchIn(container, 'assign-tags'))
    expect(searchIn(container, 'characters').isConnected).toBe(true)
  })

  test('a caret moved inside the box is restored, with no keyup at all', () => {
    currentDoc = installDom()
    const doc = currentDoc
    const container = newContainer(doc)

    let handle = mount(container, makeView())
    const before = searchIn(container, 'characters')
    before.focus()
    // A click into the box raises `select`, never `keyup`.
    before.value = 'forest'
    before.setSelectionRange(4, 4)
    before.dispatch('select')

    handle.destroy()
    handle = mount(container, makeView({ characterQuery: 'forest' }))

    // The offset can only have come from the `select` listener: a build with
    // `keyup` alone leaves the recorded offset at 0 and restores it here.
    const after = searchIn(container, 'characters')
    expect(doc.activeElement).toBe(after)
    expect(after.selectionStart).toBe(4)

    // Select-all collapses to the selection's START, which the guard treats as
    // a real caret because the query is non-empty.
    after.setSelectionRange(0, 6)
    after.dispatch('select')
    handle.destroy()
    handle = mount(container, makeView({ characterQuery: 'forest' }))

    const reselected = searchIn(container, 'characters')
    expect(doc.activeElement).toBe(reselected)
    expect(reselected.selectionStart).toBe(0)
    expect(reselected.selectionEnd).toBe(0)
  })

  test('the loading frame restores focus too', () => {
    currentDoc = installDom()
    const doc = currentDoc
    const container = newContainer(doc)

    let handle = mount(container, makeView())
    const before = searchIn(container, 'characters')
    before.focus()
    type(before, 'forest', 3)

    handle.destroy()
    handle = mount(container, makeView({ loadState: 'loading', characterQuery: 'forest' }))

    const after = searchIn(container, 'characters')
    expect(doc.activeElement).toBe(after)
    expect(after.selectionStart).toBe(3)

    // …and the intent survives into the loaded frame that replaces it.
    handle.destroy()
    handle = mount(container, makeView({ characterQuery: 'forest' }))
    const loaded = searchIn(container, 'characters')
    expect(doc.activeElement).toBe(loaded)
    expect(loaded.selectionStart).toBe(3)
  })

  test('a slot the loading frame omits keeps its intent for the frame that builds it', () => {
    currentDoc = installDom()
    const doc = currentDoc
    const container = newContainer(doc)

    let handle = mount(container, makeView())
    const before = searchIn(container, 'assign-tags')
    before.focus()
    typeIntoPickerAndCommit(before, 'forest', 4)

    // An empty library renders only the main search, so the picker slot does
    // not exist in this frame. The intent must be left intact rather than
    // dropped on the floor.
    handle.destroy()
    handle = mount(container, makeView({ loadState: 'loading', characterCount: 0, characterRows: [] }))
    expect(allSearches(container).map((s) => s.getAttribute('data-lt-search'))).toEqual(['characters'])
    expect(doc.activeElement).toBe(doc.body)

    handle.destroy()
    handle = mount(container, makeView())
    const after = searchIn(container, 'assign-tags')
    expect(doc.activeElement).toBe(after)
    expect(after.selectionStart).toBe(4)
  })

  test('a picker with more options than one page pages them instead of hiding them', () => {
    currentDoc = installDom()
    const doc = currentDoc
    const container = newContainer(doc)

    // 205 distinct tags — one more than the picker's 200-per-page.
    const many: LumiTagCharacter[] = []
    for (let i = 0; i < 205; i += 1) many.push(character(`m${i}`, `Character ${i}`, [`tag-${i}`]))
    const bigIndex = buildTagIndex(many)

    mount(container, makeView({ characters: many, characterCount: many.length, tagIndex: bigIndex, characterRows: [] }))

    // The picker query is module state that deliberately survives renders, so an
    // earlier test's query would silently change what matches here. Set one that
    // matches every tag so this test stands on its own.
    typeIntoPickerAndCommit(searchIn(container, 'assign-tags'), 'tag-', 4)

    // The overflow is PAGED, not truncated: the picker shows exactly one page
    // of options and offers the rest.
    const checkboxes = container.querySelectorAll('input[type="checkbox"]')
    expect(checkboxes.length).toBeGreaterThanOrEqual(200)
    expect(checkboxes.length).toBeLessThanOrEqual(400)

    const pickers = container.querySelectorAll('.lt-pager')
    expect(pickers.length).toBeGreaterThan(0)
    const overflow = pickers.find((p) => p.textContent.includes('of 205 tags'))
    expect(overflow).toBeDefined()
    expect(overflow!.textContent).toContain('Showing 1–200 of 205 tags')
    expect(overflow!.textContent).toContain('Page 1 of 2')
  })

test('truncating the tag options does not cost the focused picker box its focus', () => {
    currentDoc = installDom()
    const doc = currentDoc

    // More tags than TAG_OPTION_LIMIT (200), so the picker's option list is
    // truncated while its search box is still on screen and focused.
    const many: LumiTagCharacter[] = []
    for (let i = 0; i < 205; i++) many.push(character(`m${i}`, `Character ${i}`, [`tag-${i}`]))
    const bigIndex = buildTagIndex(many)
    const container = newContainer(doc)

    mount(container, makeView({ characters: many, characterCount: many.length, tagIndex: bigIndex, characterRows: [] }))
    const before = searchIn(container, 'assign-tags')
    before.focus()
    typeIntoPickerAndCommit(before, 'tag-', 4)

    expect(container.querySelector('.lt-state__detail')).not.toBeNull()
    const after = searchIn(container, 'assign-tags')
    expect(doc.activeElement).toBe(after)
    expect(after.selectionStart).toBe(4)
  })

  test('destroy releases every listener it attached', () => {
    currentDoc = installDom()
    const doc = currentDoc
    const container = newContainer(doc)

    const handle = mount(container, makeView())
    const searches = allSearches(container)
    expect(searches.length).toBe(3)
    searches[0].focus()

    handle.destroy()

    for (const search of searches) {
      expect(search.listenerCount('input')).toBe(0)
      expect(search.listenerCount('focus')).toBe(0)
      expect(search.listenerCount('blur')).toBe(0)
      expect(search.listenerCount('keyup')).toBe(0)
      expect(search.listenerCount('select')).toBe(0)
    }
    expect(container.childNodes.length).toBe(0)
  })

  test('destroy is idempotent', () => {
    currentDoc = installDom()
    const doc = currentDoc
    const container = newContainer(doc)

    const handle = mount(container, makeView())
    expect(() => {
      handle.destroy()
      handle.destroy()
    }).not.toThrow()
    expect(container.childNodes.length).toBe(0)
  })
})

describe('characters section paging', () => {
  function buttonByLabel(container: StubElement, label: string): StubElement {
    for (const found of container.querySelectorAll('button')) {
      if (found.textContent.trim() === label) return found
    }
    throw new Error(`no button labelled "${label}"`)
  }

  /** A view whose character list spans `pages` pages of `pageSize`. */
  function pagedView(total: number, pageSize: number): Partial<StoreView> {
    const characters = Array.from({ length: total }, (_, i) =>
      character(`c${i}`, `Char ${String(i).padStart(4, '0')}`, ['elf']),
    )
    const rows = characters.map((c) => ({ character: c, tags: [...c.tags], selected: false }))
    const page = 0
    return {
      characters,
      characterCount: total,
      characterRows: rows,
      characterPageRows: rows.slice(page * pageSize, (page + 1) * pageSize),
      characterPage: page,
      characterPageCount: Math.max(1, Math.ceil(total / pageSize)),
    }
  }

  test('a list that fits on one page shows no pager', () => {
    currentDoc = installDom()
    const container = newContainer(currentDoc)

    mount(container, makeView({ characterRows: [], characterPageRows: [] }))

    // Inert controls are worse than none: they look like they should do
    // something.
    expect(container.querySelector('.lt-pager')).toBeNull()
  })

  test('a multi-page list shows a pager with an honest range', () => {
    currentDoc = installDom()
    const container = newContainer(currentDoc)

    const total = 620
    const pageSize = 300
    const view = makeView(pagedView(total, pageSize))
    mount(container, view)

    const pagerEl = container.querySelector('.lt-pager')
    expect(pagerEl).not.toBeNull()
    // "Showing 1–300 of 620" — the reader can tell a page from the whole set.
    expect(pagerEl!.textContent).toContain('Showing 1–300 of 620 characters')
    expect(pagerEl!.textContent).toContain('Page 1 of 3')
  })

  test('only the current page of rows is rendered', () => {
    currentDoc = installDom()
    const container = newContainer(currentDoc)

    const view = makeView(pagedView(620, 300))
    mount(container, view)

    const list = container.querySelector('.lt-list')
    // Query the CONTAINER: `.lt-list` also matches the bulk block's tag-picker
    // option list, which is rendered earlier in the frame.
    const rendered = container.querySelectorAll('.lt-character-row').length
    expect(rendered).toBe(300)
  })

  test('Next and Previous request the neighbouring page', () => {
    currentDoc = installDom()
    const container = newContainer(currentDoc)

    const requested: number[] = []
    const view = makeView(pagedView(620, 300))
    const fake = fakeStore(view)
    fake.actions.setCharacterPage = (page: number) => {
      requested.push(page)
    }
    renderCharactersSection({
      container: container as unknown as HTMLElement,
      store: fake,
    })

    buttonByLabel(container, 'Next').dispatch('click')
    expect(requested).toEqual([1])

    buttonByLabel(container, 'First').dispatch('click')
    expect(requested).toEqual([1, 0])

    buttonByLabel(container, 'Last').dispatch('click')
    expect(requested).toEqual([1, 0, 2])
  })

  test('Previous is disabled on the first page and Next on the last', () => {
    currentDoc = installDom()
    const container = newContainer(currentDoc)

    const base = pagedView(620, 300)
    // First page.
    mount(container, makeView(base))
    expect(buttonByLabel(container, 'Previous').getAttribute('aria-disabled')).toBe('true')
    expect(buttonByLabel(container, 'Next').getAttribute('aria-disabled')).toBe('false')

    // Last page.
    const last = pagedView(620, 300)
    last.characterPage = 2
    last.characterPageRows = (last.characterRows as CharacterListRow[]).slice(600, 900)
    mount(container, makeView(last))
    expect(buttonByLabel(container, 'Previous').getAttribute('aria-disabled')).toBe('false')
    expect(buttonByLabel(container, 'Next').getAttribute('aria-disabled')).toBe('true')
  })

  test('the pager sits BELOW the rows, not above them', () => {
    currentDoc = installDom()
    const container = newContainer(currentDoc)

    mount(container, makeView(pagedView(620, 300)))

    // Flatten the frame in DOCUMENT order, the way the stub's own walker does.
    const inOrder: StubElement[] = []
    const walk = (node: StubElement): void => {
      for (const child of (node as unknown as { childNodes: (StubElement | StubText)[] })
        .childNodes) {
        if (child instanceof StubText) continue
        inOrder.push(child)
        walk(child)
      }
    }
    walk(container)

    // The stub stores `class` as an attribute, not a DOM property.
    const classOf = (n: StubElement): string => n.getAttribute('class') ?? ''
    const lastRow = inOrder.map(classOf).lastIndexOf('lt-character-row')
    const pagerAt = inOrder.findIndex((n) => classOf(n).includes('lt-pager'))
    expect(lastRow).toBeGreaterThanOrEqual(0)
    expect(pagerAt).toBeGreaterThan(lastRow)
  })
})

describe('characters section bulk assign / unassign controls', () => {
  /** The button whose visible label is exactly `label`. */
  function buttonByLabel(container: StubElement, label: string): StubElement {
    for (const found of container.querySelectorAll('button')) {
      if (found.textContent.trim() === label) return found
    }
    throw new Error(`no button labelled "${label}"`)
  }

  function bulkButtons(container: StubElement): {
    assign: StubElement
    unassign: StubElement
  } {
    return {
      assign: buttonByLabel(container, 'Assign Tags'),
      unassign: buttonByLabel(container, 'Unassign Tags'),
    }
  }

  test('Unassign Tags sits in the same block, right after Assign Tags', () => {
    currentDoc = installDom()
    const container = newContainer(currentDoc)

    mount(container, makeView())

    const { assign, unassign } = bulkButtons(container)
    // Same parent = the same block, and assign immediately precedes unassign, so
    // the pair reads as add/remove on one shared selection.
    expect(unassign.parentNode).toBe(assign.parentNode)
    const siblings = (assign.parentNode as unknown as { childNodes: StubElement[] }).childNodes
    expect(siblings.indexOf(unassign)).toBe(siblings.indexOf(assign) + 1)
  })

  /**
   * The stub has no `disabled` property, so assert on the `aria-disabled`
   * mirror `setDisabled` always writes alongside it.
   */
  function isDisabled(element: StubElement): boolean {
    return element.getAttribute('aria-disabled') === 'true'
  }

  test('both are disabled until characters AND tags are selected', () => {
    currentDoc = installDom()
    const container = newContainer(currentDoc)
    let handle = mount(container, makeView())

    const { assign, unassign } = bulkButtons(container)
    expect(isDisabled(assign)).toBe(true)
    expect(isDisabled(unassign)).toBe(true)

    // Characters but no tags: still nothing to do, either way.
    handle.destroy()
    handle = mount(container, makeView({ selectedCharacterIds: ['c1'] }))
    expect(isDisabled(bulkButtons(container).unassign)).toBe(true)

    // Both selected: both become live.
    handle.destroy()
    handle = mount(container, makeView({ selectedCharacterIds: ['c1'], selectedAssignTagKeys: ['elf'] }))
    expect(isDisabled(bulkButtons(container).assign)).toBe(false)
    expect(isDisabled(bulkButtons(container).unassign)).toBe(false)
  })

  test('the two buttons request different dialogs', () => {
    currentDoc = installDom()
    const container = newContainer(currentDoc)

    const opened: string[] = []
    setDialogOpener((request) => opened.push(request.kind))
    try {
      mount(container, makeView({ selectedCharacterIds: ['c1'], selectedAssignTagKeys: ['elf'] }))
      const { assign, unassign } = bulkButtons(container)

      assign.dispatch('click')
      unassign.dispatch('click')

      // They must not share a review dialog: the wording, the scope and the
      // confirm variant all differ.
      expect(opened).toEqual(['bulk_assign_review', 'bulk_unassign_review'])
    } finally {
      setDialogOpener(() => {})
    }
  })

  test('the unassign control tells the reader it is scoped to the selection', () => {
    currentDoc = installDom()
    const container = newContainer(currentDoc)

    mount(container, makeView({ selectedCharacterIds: ['c1'], selectedAssignTagKeys: ['elf'] }))

    const { unassign } = bulkButtons(container)
    // An unassign control that does not say it is scoped reads as a library-wide
    // delete of the tag — the exact misreading that loses data.
    expect(unassign.getAttribute('aria-label')).toContain('selected characters only')
    expect(unassign.getAttribute('title')).toContain('only the selected characters')
  })

  test('one shared tag picker feeds both buttons', () => {
    currentDoc = installDom()
    const container = newContainer(currentDoc)

    mount(container, makeView({ selectedCharacterIds: ['c1'], selectedAssignTagKeys: ['elf'] }))

    // Still exactly ONE assign-tags slot: the pair shares one selection rather
    // than carrying two independent tag sets that can disagree.
    expect(allSearches(container).map((s) => s.getAttribute('data-lt-search'))).toEqual([
      'characters',
      'active-filter-tags',
      'assign-tags',
    ])
  })
})
