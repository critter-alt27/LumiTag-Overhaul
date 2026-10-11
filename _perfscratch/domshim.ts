/**
 * THROWAWAY measurement harness. Delete this whole directory when done.
 *
 * A DOM stub modelled on tests/tags-section.test.ts, extended with the bits
 * ui/shell.ts needs (scrollTop/offsetTop/clientHeight/scrollHeight/removeAttribute/
 * textContent/tabIndex/id) plus a NODE COUNTER so a render can be measured in
 * "how many DOM nodes did this create".
 *
 * NO layout, NO image loading, NO GC, NO real engine. Wall-clock here is pure JS
 * object churn time and is NOT a phone number.
 */

export const counters = {
  elements: 0,
  textNodes: 0,
  /** Reset before each measured render. */
  reset(): void {
    this.elements = 0
    this.textNodes = 0
  },
  get nodes(): number {
    return this.elements + this.textNodes
  },
}

type Handler = (ev: { type: string; target: StubElement }) => void

export class StubText {
  readonly nodeType = 3
  parentNode: StubElement | null = null
  data: string
  constructor(data: string) {
    this.data = data
    counters.textNodes++
  }
}

export class StubElement {
  readonly nodeType = 1
  readonly childNodes: (StubElement | StubText)[] = []
  readonly attributes = new Map<string, string>()
  readonly handlers = new Map<string, Set<Handler>>()
  readonly dataset: Record<string, string> = {}
  parentNode: StubElement | null = null
  title = ''
  id = ''
  tabIndex = 0
  disabled = false
  /** Layout-ish fields: shells read them; the stub answers with constants. */
  scrollTop = 0
  scrollHeight = 1000
  clientHeight = 500
  offsetTop = 0

  constructor(
    readonly ownerDocument: StubDocument,
    readonly tagName: string,
  ) {
    counters.elements++
  }

  get firstChild(): StubElement | StubText | null {
    return this.childNodes[0] ?? null
  }

  get lastChild(): StubElement | StubText | null {
    return this.childNodes[this.childNodes.length - 1] ?? null
  }

  get isConnected(): boolean {
    let node: StubElement = this
    while (node.parentNode !== null) node = node.parentNode
    return node === this.ownerDocument.body
  }

  get textContent(): string {
    let out = ''
    for (const c of this.childNodes) {
      if (c instanceof StubText) out += c.data
      else out += c.textContent
    }
    return out
  }
  set textContent(value: string) {
    this.childNodes.length = 0
    if (value !== '') this.appendChild(new StubText(value))
  }

  appendChild(child: StubElement | StubText): any {
    if (child instanceof StubElement && child.parentNode !== null) child.parentNode.removeChild(child)
    child.parentNode = this
    this.childNodes.push(child)
    return child
  }

  insertBefore(child: StubElement | StubText, ref: StubElement | StubText | null): any {
    if (child instanceof StubElement && child.parentNode !== null) child.parentNode.removeChild(child)
    child.parentNode = this
    const at = ref === null ? -1 : this.childNodes.indexOf(ref)
    if (at < 0) this.childNodes.push(child)
    else this.childNodes.splice(at, 1), this.childNodes.splice(at, 0, child)
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

  owns(node: StubElement | null): boolean {
    let cur: StubElement | null = node
    while (cur !== null) {
      if (cur === this) return true
      cur = cur.parentNode
    }
    return false
  }

  private releaseFocusHeldBy(detached: StubElement): void {
    const doc = this.ownerDocument
    const active = doc.activeElement
    if (!detached.owns(active)) return
    doc.activeElement = doc.body
    if (active !== null) active.dispatch('blur')
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

  get classList(): { contains(name: string): boolean; add(n: string): void } {
    const names = () => (this.attributes.get('class') ?? '').split(/\s+/).filter((n) => n !== '')
    return {
      contains: (n) => names().includes(n),
      add: (n) => {
        const cur = names()
        if (!cur.includes(n)) this.attributes.set('class', [...cur, n].join(' '))
      },
    }
  }

  querySelectorAll(selector: string): StubElement[] {
    const [tag, ...classes] = selector.split('.')
    const matches = (n: StubElement) => n.tagName === tag && classes.every((c) => n.classList.contains(c))
    const found: StubElement[] = []
    const walk = (n: StubElement): void => {
      for (const c of n.childNodes) {
        if (!(c instanceof StubElement)) continue
        if (matches(c)) found.push(c)
        walk(c)
      }
    }
    walk(this)
    return found
  }
  querySelector(selector: string): StubElement | null {
    return this.querySelectorAll(selector)[0] ?? null
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
    for (const h of [...(this.handlers.get(type) ?? [])]) h({ type, target: this })
  }
  listenerCount(type: string): number {
    return this.handlers.get(type)?.size ?? 0
  }

  focus(): void {
    const prev = this.ownerDocument.activeElement
    if (prev !== null && prev !== this) prev.dispatch('blur')
    this.ownerDocument.activeElement = this
    this.dispatch('focus')
  }
  setSelectionRange(): void {}
}

export class HTMLInputElementStub extends StubElement {
  value = ''
  checked = false
  selectionStart: number | null = 0
  selectionEnd: number | null = 0
}

export class StubDocument {
  readonly body: StubElement
  activeElement: StubElement | null
  constructor() {
    this.body = new StubElement(this as unknown as StubDocument, 'body')
    this.activeElement = this.body
  }
  createElement(tag: string): StubElement {
    return tag === 'input'
      ? (new HTMLInputElementStub(this, tag) as unknown as StubElement)
      : new StubElement(this, tag)
  }
  createTextNode(data: string): StubText {
    return new StubText(data)
  }
}

export function installDom(): StubDocument {
  const doc = new StubDocument()
  const g = globalThis as unknown as Record<string, unknown>
  g['document'] = doc
  g['HTMLInputElement'] = HTMLInputElementStub
  return doc
}