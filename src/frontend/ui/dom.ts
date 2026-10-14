/**
 * LumiTag shared DOM toolkit.
 *
 * Every other LumiTag UI module builds elements through THIS file and nowhere
 * else. The rules it enforces are the reason it exists:
 *
 *  1. **No `innerHTML`, ever.** User data (character names, tag names, backend
 *     error messages) is always appended as a real `Text` node via `text()`,
 *     so no character can inject markup or attributes into the host document.
 *     The only geometry-bearing nodes are the three STATIC icon constants at the
 *     bottom of this file, built with `createElementNS` — not with markup
 *     injection — and none of them ever carries user data.
 *  2. **Every icon-only / destructive control carries an `aria-label`.** A
 *     control that only shows an "×" or "?" glyph is unreadable otherwise.
 *  3. **Listeners are disposable.** `on()` returns an unsubscribe function.
 *     Helpers that bake a listener into a node they hand back (`checkbox`,
 *     `select`, `searchInput`, `chip`, `avatar`) register it against that node,
 *     and {@link clear} releases every registered listener in the subtree it
 *     detaches — which is the shell's re-render path, so a baked listener can no
 *     longer outlive its node.
 *  4. **Dependency-free and DOM-only.** No imports from the store or any other
 *     LumiTag module, so any UI module can depend on it without a cycle.
 *
 * ## Why these shapes and not the host's components
 *
 * The host's shared components are React, and the shell rebuilds its whole
 * subtree on every store commit, which destroys any host-owned mount. So each
 * helper here is a small DOM adapter that reproduces the host's class structure
 * and lets `styles.ts` supply the host's exact values. Class names are the
 * contract with `styles.ts`; several are queried by the test suite and must not
 * be renamed.
 */

/** Attribute bag accepted by {@link el}. `null`/`undefined` attributes are skipped. */
export type Attrs = Record<string, string | number | boolean | null | undefined>

function appendChildren(
  parent: Node,
  children: readonly (Node | string | null | undefined)[],
): void {
  for (const child of children) {
    if (child === null || child === undefined) continue
    parent.appendChild(typeof child === 'string' ? text(child) : child)
  }
}

function applyAttrs(node: Element, attrs: Attrs | undefined): void {
  if (!attrs) return
  for (const [name, value] of Object.entries(attrs)) {
    if (value === null || value === undefined || value === false) continue
    // `false` is skipped above; `true` becomes the HTML boolean-attribute form.
    node.setAttribute(name, value === true ? '' : String(value))
  }
}

/**
 * Create an element with attributes and children.
 *
 * This is the ONLY element factory in LumiTag. Strings in `children` become text
 * nodes — never markup.
 */
export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs?: Attrs,
  children?: (Node | string | null | undefined)[],
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  applyAttrs(node, attrs)
  if (children) appendChildren(node, children)
  return node
}

/**
 * Listeners a helper attached to a node it does not own the lifecycle of.
 *
 * Keyed by the node, so they die with it: {@link clear} releases everything
 * registered for the subtree it detaches. This is what makes `checkbox()`,
 * `select()`, `searchInput()` and `chip()` safe inside the shell's rebuild loop.
 */
const ownedListeners = new WeakMap<Element, Set<() => void>>()

/** Register a disposer to run when `target`'s subtree is cleared. */
function own(target: Element, dispose: () => void): void {
  const set = ownedListeners.get(target) ?? new Set<() => void>()
  set.add(dispose)
  ownedListeners.set(target, set)
}

/**
 * Release every registered listener in `node`'s subtree.
 *
 * Called from {@link clear} for each detached child, so a helper-baked listener
 * cannot outlive the node it was attached to.
 */
function releaseOwned(node: Node): void {
  const element = node as Element
  const set = ownedListeners.get(element)
  if (set !== undefined) {
    ownedListeners.delete(element)
    for (const dispose of set) {
      try {
        dispose()
      } catch {
        // A failing disposer must not strand the others.
      }
    }
  }
  // `children` is empty for text nodes, so this walks elements only.
  for (const child of Array.from(element.children ?? [])) releaseOwned(child)
}

/** Remove every child of `node`, releasing any helper-owned listener in it. */
export function clear(node: Element): void {
  while (node.firstChild !== null) {
    const child = node.firstChild
    releaseOwned(child)
    node.removeChild(child)
  }
}

/** Create a detached `Text` node. The ONLY safe way to show user data. */
export function text(value: string): Text {
  return document.createTextNode(value)
}

/**
 * Attach a listener and return its unsubscribe function.
 *
 * `once`/`passive`/`capture` are passed through, so a delegated shell listener
 * can opt into `{ passive: true }` without a second code path.
 */
export function on<K extends keyof HTMLElementEventMap>(
  target: EventTarget,
  type: K,
  handler: (ev: HTMLElementEventMap[K]) => void,
  opts?: AddEventListenerOptions,
): () => void {
  target.addEventListener(type, handler as EventListener, opts)
  return () => {
    target.removeEventListener(type, handler as EventListener, opts)
  }
}

/** Class names joined into one `class` attribute, skipping blanks. */
function classAttr(...parts: (string | null | undefined)[]): string {
  return parts.filter((p): p is string => typeof p === 'string' && p !== '').join(' ')
}

/**
 * Add / remove one class name.
 *
 * Goes through `classList` where the environment provides it and falls back to
 * rewriting the `class` attribute otherwise, so the helper works against the
 * hand-rolled DOM stubs the unit tests install (they model attributes, not the
 * full `classList` API).
 */
function addClass(node: Element, name: string): void {
  if (node.classList) {
    node.classList.add(name)
    return
  }
  node.setAttribute('class', classAttr(node.getAttribute('class'), name))
}

function removeClass(node: Element, name: string): void {
  if (node.classList) {
    node.classList.remove(name)
    return
  }
  const kept = (node.getAttribute('class') ?? '').split(/\s+/).filter((c) => c !== '' && c !== name)
  node.setAttribute('class', kept.join(' '))
}

/* ------------------------------------------------------------------ */
/* Buttons                                                            */
/* ------------------------------------------------------------------ */

/**
 * The host's button vocabulary (FormComponents.module.css:166-265):
 * a default/secondary outline, a filled primary, a borderless ghost, a filled
 * danger, a quiet danger-ghost, plus the `sm` and the two square icon sizes.
 * `styles.ts` maps each of these onto the host's exact values.
 */
export type ButtonVariant =
  | 'default'
  | 'secondary'
  | 'primary'
  | 'ghost'
  | 'danger'
  | 'danger-ghost'
  | 'sm'
  | 'icon'
  | 'icon-sm'

export interface ButtonOptions {
  /**
   * The host's variant set. `'default'` and `'secondary'` are the same button
   * under the host's two names; `'sm'`, `'icon'` and `'icon-sm'` are sizes
   * accepted here so a call site can express "a small button" or "a square
   * icon-only button" in one word.
   */
  variant?: ButtonVariant
  /** Renders the destructive tone on top of `variant` (row-level Delete). */
  danger?: boolean
  title?: string
  /** Required whenever `label` is not meaningful on its own (icon-only buttons). */
  ariaLabel?: string
  disabled?: boolean
  /** Build the button already busy: `aria-busy`, disabled, `busyLabel` swapped in. */
  busy?: boolean
  busyLabel?: string
  onClick?: (ev: MouseEvent) => void
}

/**
 * A styled `<button type="button">`.
 *
 * `type="button"` is set explicitly: without it a button inside a host form
 * would submit it, which is never what an extension control wants.
 *
 * An empty `label` with no `ariaLabel` would produce an unnamed control, so the
 * combination is rejected in development terms by being called out here rather
 * than by throwing: a throwing build helper would take the whole panel down over
 * a cosmetic mistake.
 */
export function button(label: string, opts?: ButtonOptions): HTMLButtonElement {
  const variant = opts?.variant ?? 'default'
  const node = el('button', {
    class: classAttr('lt-btn', `lt-btn--${variant}`, opts?.danger === true ? 'lt-btn--danger-ghost' : ''),
    type: 'button',
    ...(opts?.title === undefined ? {} : { title: opts.title }),
    ...(opts?.ariaLabel === undefined ? {} : { 'aria-label': opts.ariaLabel }),
    ...(opts?.disabled === true ? { disabled: true } : {}),
  })
  if (opts?.onClick) on(node, 'click', opts.onClick)
  if (label !== '') node.appendChild(text(label))
  if (opts?.busy === true) {
    setBusy(node, true, opts?.busyLabel)
  }
  return node
}

/** Enable/disable a button. */
export function setDisabled(b: HTMLButtonElement, disabled: boolean): void {
  b.disabled = disabled
  b.setAttribute('aria-disabled', disabled ? 'true' : 'false')
}

/**
 * Put a button into (or out of) a busy state.
 *
 * Disables the control and marks it `aria-busy` so the state is announced
 * rather than merely looking different. When `busyLabel` is given the label is
 * temporarily swapped; it is restored verbatim when the button goes idle, which
 * is why the caller passes the *same* label string back.
 */
export function setBusy(b: HTMLButtonElement, busy: boolean, busyLabel?: string): void {
  if (busy) {
    b.dataset['ltOriginalLabel'] = b.dataset['ltOriginalLabel'] ?? (b.textContent ?? '')
    if (busyLabel !== undefined && busyLabel !== '') b.textContent = busyLabel
    b.setAttribute('aria-busy', 'true')
    addClass(b, 'lt-btn--loading')
    b.disabled = true
    return
  }
  const original = b.dataset['ltOriginalLabel']
  if (original !== undefined) {
    b.textContent = original
    delete b.dataset['ltOriginalLabel']
  }
  b.removeAttribute('aria-busy')
  removeClass(b, 'lt-btn--loading')
  b.disabled = false
}

/* ------------------------------------------------------------------ */
/* Avatars                                                            */
/* ------------------------------------------------------------------ */

/**
 * Initials for the avatar fallback: at most two letters, derived from the
 * name's word boundaries, falling back to `?` for a name with no letters.
 */
export function initialsOf(name: string): string {
  const words = String(name ?? '')
    .trim()
    .split(/\s+/)
    .filter((w) => w !== '')
  if (words.length === 0) return '?'
  const letters: string[] = []
  for (const word of words) {
    const first = [...word][0] ?? ''
    if (first !== '') letters.push(first)
    if (letters.length === 2) break
  }
  if (letters.length === 0) return '?'
  return letters.join('').toUpperCase()
}

/**
 * An avatar image with an initials fallback.
 *
 * The fallback is ALWAYS rendered behind the image; the image hides it on
 * `load`. A null `src` or a broken image therefore degrades to initials
 * instead of a broken-image glyph, and `alt` names the character so a screen
 * reader announces something meaningful. Both baked listeners are registered
 * against the box, so they are released with it.
 */
export function avatar(src: string | null, name: string, size = 32): HTMLElement {
  const box = el('span', {
    class: 'lt-avatar',
    style: `width:${size}px;height:${size}px;`,
    'aria-hidden': 'true',
  })
  box.appendChild(el('span', { class: 'lt-avatar__initials' }, [initialsOf(name)]))

  if (typeof src === 'string' && src !== '') {
    const img = el('img', {
      class: 'lt-avatar__img',
      src,
      alt: name === '' ? 'Character avatar' : `Avatar of ${name}`,
      loading: 'lazy',
      decoding: 'async',
    })
    // Only reveal the image once it actually decoded, so a 404 avatar flashes
    // no broken frame.
    own(box, on(img, 'load', () => {
      box.dataset['ltLoaded'] = 'true'
    }))
    own(box, on(img, 'error', () => {
      box.removeChild(img)
    }))
    box.appendChild(img)
  }

  return box
}

/* ------------------------------------------------------------------ */
/* Chips and badges                                                  */
/* ------------------------------------------------------------------ */

/**
 * Tone ladder shared by {@link chip} and {@link badge}.
 *
 * Neutral is the default for counts, labels and mere associations; the primary
 * tone is reserved for an ACTIVE selection; the status tones are reserved for
 * errors, warnings and successes. `styles.ts` maps each onto the host's Badge /
 * entry-chip colour values.
 */
export type Tone = 'default' | 'neutral' | 'muted' | 'accent' | 'primary'
  | 'danger' | 'warning' | 'success' | 'info'

export interface ChipOptions {
  /** When present the chip renders a real removal `<button>`. */
  onRemove?: () => void
  removeLabel?: string
  tone?: Tone
}

/**
 * An inline tag chip — a genuine association ("this character carries this
 * tag"), so it uses the host's in-row pill vocabulary.
 *
 * The remove control is a real `<button type="button">` with an accessible label
 * naming the tag, so it is reachable by keyboard and announced as "Remove tag
 * Elf" rather than as "button".
 */
export function chip(label: string, opts?: ChipOptions): HTMLElement {
  const tone = opts?.tone ?? 'default'
  const node = el('span', { class: classAttr('lt-chip', `lt-chip--${tone}`) })
  node.appendChild(el('span', { class: 'lt-chip__label' }, [label]))

  if (opts?.onRemove) {
    const removeLabel = opts.removeLabel ?? `Remove tag ${label}`
    const remove = button('×', {
      variant: 'icon-sm',
      ariaLabel: removeLabel,
      title: removeLabel,
    })
    own(node, on(remove, 'click', () => opts.onRemove?.()))
    node.appendChild(remove)
  }

  return node
}

export interface BadgeOptions {
  tone?: Tone
  /** `title` — the host's only tooltip mechanism for a badge. */
  title?: string
}

/**
 * A compact count/status badge (host `Badge`, `sm` size: 2px 6px, 10px, r4).
 *
 * Neutral by default so a count never out-shouts the tag name beside it.
 */
export function badge(label: string, opts?: BadgeOptions): HTMLElement {
  const tone = opts?.tone ?? 'default'
  return el(
    'span',
    {
      class: classAttr('lt-badge', `lt-badge--${tone}`),
      ...(opts?.title === undefined ? {} : { title: opts.title }),
    },
    [label],
  )
}

/* ------------------------------------------------------------------ */
/* Form controls                                                      */
/* ------------------------------------------------------------------ */

/**
 * Controls that carry their OWN wrapper (a search pill, a select chevron
 * wrapper), keyed by the control itself.
 *
 * {@link field} places the wrapper inside the `<label>` instead of the bare
 * control, so a labelled search/select still renders as the complete host
 * component while the `<label>` keeps naming the control it wraps.
 */
const controlWrappers = new WeakMap<Element, HTMLElement>()

function wrapperFor(control: HTMLElement): HTMLElement | null {
  return controlWrappers.get(control) ?? null
}

export interface FieldOptions {
  /** Helper text under the control (host `.formHint`). */
  hint?: string
  /** Validation message (host `.formError`), rendered in the danger tone. */
  error?: string
}

/**
 * A labelled form control.
 *
 * The label element wraps the control, so clicking the text focuses it and the
 * accessible name comes for free without an id/`for` pair — except for a search
 * input, which carries its OWN wrapper (icon + input + clear button). In that one
 * case the wrapper is placed inside the label instead, so the `<label>` still
 * wraps the input it names and the pill keeps its own structure.
 */
export function field(
  label: string,
  control: HTMLElement,
  hint?: string,
  opts?: FieldOptions,
): HTMLElement {
  const node = el('label', { class: classAttr('lt-field', opts?.error ? 'lt-field--error' : '') })
  node.appendChild(el('span', { class: 'lt-field__label' }, [label]))
  node.appendChild(wrapperFor(control) ?? control)
  if (hint !== undefined && hint !== '') node.appendChild(el('span', { class: 'lt-field__hint' }, [hint]))
  if (opts?.error !== undefined && opts.error !== '') {
    node.appendChild(el('span', { class: 'lt-field__error' }, [opts.error]))
  }
  return node
}

/**
 * A checkbox whose change handler receives the new checked state.
 *
 * The input is native and relies on `accent-color` for its colour (the host's
 * `Toggle.Checkbox` does the same — a repainted checkbox would lose the
 * platform's own focus and pressed states). The baked listener is registered
 * against the input, so `clear()` releases it.
 */
export function checkbox(
  checked: boolean,
  ariaLabel: string,
  onChange: (checked: boolean) => void,
): HTMLInputElement {
  const input = el('input', {
    class: 'lt-checkbox',
    type: 'checkbox',
    'aria-label': ariaLabel,
    ...(checked ? { checked: true } : {}),
  })
  input.checked = checked
  own(input, on(input, 'change', () => onChange(input.checked)))
  return input
}

/**
 * A checkbox with a visible label and optional hint (host `.checkbox` +
 * `.labelWrap` + `.hint`), for a control that is not inside a list row and
 * therefore needs its own text.
 */
export function checkboxField(
  checked: boolean,
  label: string,
  onChange: (checked: boolean) => void,
  hint?: string,
): HTMLElement {
  const input = checkbox(checked, label, onChange)
  const node = el('label', { class: 'lt-checkbox-label' }, [input])
  const textWrap = el('span', { class: 'lt-checkbox-label__text' }, [label])
  if (hint !== undefined && hint !== '') {
    textWrap.appendChild(el('span', { class: 'lt-checkbox-label__hint' }, [hint]))
  }
  node.appendChild(textWrap)
  return node
}

/**
 * A `<select>` driven by a literal value list.
 *
 * The returned element is the `<select>` itself, as always; its chevron lives on
 * a sibling wrapper (`.lt-selectfield`) which is registered against it, so
 * `field()` picks the wrapper up and a caller that appends the raw select still
 * gets a fully-formed control. An unknown value can only come from a stale DOM
 * and is ignored rather than fed to the store.
 */
export function select<T extends string>(
  options: readonly { value: T; label: string }[],
  value: T,
  onChange: (v: T) => void,
): HTMLSelectElement {
  const node = el('select', { class: 'lt-select' })
  for (const option of options) {
    const opt = el('option', { value: option.value }, [option.label])
    node.appendChild(opt)
  }
  node.value = value
  own(node, on(node, 'change', () => {
    const next = node.value as T
    // An unknown value can only come from a stale DOM; ignore it rather than
    // feeding the store a mode it does not know.
    if (options.some((o) => o.value === next)) onChange(next)
  }))

  const wrapper = el('span', { class: 'lt-selectfield' }, [node])
  const chevron = icon(CHEVRON_DOWN_ICON, 'lt-selectfield__chevron')
  if (chevron !== null) wrapper.appendChild(chevron)
  controlWrappers.set(node, wrapper)

  return node
}

/** The `.lt-selectfield` chevron wrapper for a `<select>` built by {@link select}. */
export function selectFieldOf(node: HTMLSelectElement): HTMLElement | null {
  return controlWrappers.get(node) ?? null
}

/**
 * A search box: the host's `SearchField` structure — a subtle-filled, hairline
 * pill with a 14px dimmed icon, a borderless 13px input and a clear control.
 *
 * The returned element is the `<input class="lt-search">` itself, exactly as
 * before (the test suite and both sections query it by that selector). Its
 * wrapper is registered, so `field('Search', input)` renders the complete pill;
 * a caller that wants the pill directly can take it from {@link searchFieldOf}.
 *
 * The clear control appears only while there is something to clear — the host
 * hides the UA affordance and draws its own — and its listener is registered
 * against the pill, so it cannot outlive the field.
 */
export function searchInput(
  placeholder: string,
  value: string,
  onInput: (v: string) => void,
): HTMLInputElement {
  const input = el('input', {
    class: 'lt-search lt-searchfield__input',
    type: 'search',
    placeholder,
    'aria-label': placeholder,
    autocomplete: 'off',
    autocapitalize: 'none',
    spellcheck: 'false',
    value,
  })
  input.value = value
  own(input, on(input, 'input', () => onInput(input.value)))

  const pill = el('span', { class: 'lt-searchfield' })
  const leading = icon(SEARCH_ICON, 'lt-searchfield__icon')
  if (leading !== null) pill.appendChild(leading)
  pill.appendChild(input)

  const clear = button('×', {
    variant: 'icon-sm',
    ariaLabel: `Clear ${placeholder}`,
    title: `Clear ${placeholder}`,
  })
  addClass(clear, 'lt-searchfield__clear')
  clear.hidden = value === ''
  own(input, on(clear, 'click', () => {
    input.value = ''
    clear.hidden = true
    onInput('')
    input.focus()
  }))
  own(input, on(input, 'input', () => {
    clear.hidden = input.value === ''
  }))
  pill.appendChild(clear)

  controlWrappers.set(input, pill)
  return input
}

/** The `.lt-searchfield` pill built by {@link searchInput} for `input`. */
export function searchFieldOf(input: HTMLInputElement): HTMLElement | null {
  return controlWrappers.get(input) ?? null
}

/* ------------------------------------------------------------------ */
/* States                                                             */
/* ------------------------------------------------------------------ */

/** A spinner with an optional visible label. Announced politely. */
export function spinner(label?: string): HTMLElement {
  const node = el('div', { class: 'lt-spinner', role: 'status', 'aria-live': 'polite' })
  node.appendChild(el('span', { class: 'lt-spinner__ring', 'aria-hidden': 'true' }))
  node.appendChild(
    el('span', { class: 'lt-spinner__label' }, [label ?? 'Loading…']),
  )
  return node
}

/** An empty state: a title, an optional detail line, an optional action. */
export function emptyState(title: string, detail?: string, action?: HTMLElement): HTMLElement {
  const node = el('div', { class: 'lt-state lt-state--empty' })
  node.appendChild(el('p', { class: 'lt-state__title' }, [title]))
  if (detail !== undefined && detail !== '') {
    node.appendChild(el('p', { class: 'lt-state__detail' }, [detail]))
  }
  if (action) node.appendChild(el('div', { class: 'lt-state__actions' }, [action]))
  return node
}

/**
 * An error state with an optional retry control.
 *
 * `detail` is expected to be a UI-safe message (see `classifyError`), never a
 * raw stack trace.
 */
export function errorState(title: string, detail: string, retry?: () => void): HTMLElement {
  const node = el('div', { class: 'lt-state lt-state--error', role: 'alert' })
  node.appendChild(el('p', { class: 'lt-state__title' }, [title]))
  node.appendChild(el('p', { class: 'lt-state__detail' }, [detail]))
  if (retry) {
    node.appendChild(
      el('div', { class: 'lt-state__actions' }, [
        button('Try again', { variant: 'primary', onClick: retry }),
      ]),
    )
  }
  return node
}

/* ------------------------------------------------------------------ */
/* Layout                                                             */
/* ------------------------------------------------------------------ */

/** A generic container with a caller-supplied `lt-` class. */
export function sectionEl(cls: string, children?: (Node | string | null | undefined)[]): HTMLElement {
  return el('div', { class: classAttr('lt-box', cls) }, children)
}

/** A horizontal layout row. */
export function row(...children: (Node | string | null | undefined)[]): HTMLElement {
  return el('div', { class: 'lt-row' }, children)
}

/**
 * Page controls for a paged list.
 *
 * Returns `null` when everything fits on one page — an inert pager is worse
 * than none, because it reads as a control that does nothing.
 *
 * The range line ("showing 1–300 of 5,000") is always present when a pager is,
 * so the reader can tell the difference between "that is all of them" and
 * "that is this page" without counting rows.
 *
 * The visible button labels ("First", "Previous", "Next", "Last"), the range
 * sentence and the `Page N of M` line are asserted verbatim by the test suite
 * and are part of this function's contract.
 */
export function pager(options: {
  page: number
  pageCount: number
  total: number
  pageSize: number
  onPage: (page: number) => void
  /** Noun for the `aria-label`s, e.g. 'characters'. */
  label: string
}): HTMLElement | null {
  const { page, pageCount, total, pageSize, onPage, label } = options
  if (pageCount <= 1) return null

  const safePage = clampIndex(page, pageCount)
  const first = safePage * pageSize + 1
  const last = Math.min((safePage + 1) * pageSize, total)

  const wrap = el('div', {
    class: 'lt-pager',
    role: 'group',
    'aria-label': `${label} pagination`,
  })

  wrap.appendChild(
    el('span', { class: 'lt-pager__status' }, [
      `Showing ${first}–${last} of ${total} ${label}`,
    ]),
  )

  const actions = el('div', { class: 'lt-pager__actions' })

  const firstBtn = button('First', {
    variant: 'ghost',
    title: `Go to the first page of ${label}`,
    ariaLabel: `First page of ${label}`,
    onClick: () => onPage(0),
  })
  setDisabled(firstBtn, safePage === 0)
  actions.appendChild(firstBtn)

  const prev = button('Previous', {
    variant: 'ghost',
    title: `Previous page of ${label}`,
    ariaLabel: `Previous page of ${label}`,
    onClick: () => onPage(safePage - 1),
  })
  setDisabled(prev, safePage === 0)
  actions.appendChild(prev)

  // `aria-live` so the page change is announced: the status text is the only
  // thing that tells a screen-reader user the list moved.
  actions.appendChild(
    el('span', { class: 'lt-pager__position', 'aria-live': 'polite' }, [
      `Page ${safePage + 1} of ${pageCount}`,
    ]),
  )

  const next = button('Next', {
    variant: 'ghost',
    title: `Next page of ${label}`,
    ariaLabel: `Next page of ${label}`,
    onClick: () => onPage(safePage + 1),
  })
  setDisabled(next, safePage >= pageCount - 1)
  actions.appendChild(next)

  const lastBtn = button('Last', {
    variant: 'ghost',
    title: `Go to the last page of ${label}`,
    ariaLabel: `Last page of ${label}`,
    onClick: () => onPage(pageCount - 1),
  })
  setDisabled(lastBtn, safePage >= pageCount - 1)
  actions.appendChild(lastBtn)

  wrap.appendChild(actions)
  return wrap
}

/** Clamp a page index into `[0, pageCount)`, treating junk as page 0. */
function clampIndex(page: number, pageCount: number): number {
  if (!Number.isFinite(page)) return 0
  const floored = Math.floor(page)
  if (floored < 0) return 0
  if (floored > pageCount - 1) return pageCount - 1
  return floored
}

/* ------------------------------------------------------------------ */
/* Static icons                                                       */
/* ------------------------------------------------------------------ */

/**
 * Build one of the STATIC icons below, or `null` where the environment cannot
 * make an SVG element.
 *
 * These are the only geometry-bearing nodes this module creates. They are built
 * with `createElementNS` — never by injecting markup — and they carry no user
 * data of any kind, so the "no `innerHTML`, ever" rule still holds in full.
 * Lucide's 24×24 path data at the host's default stroke width of 2, rendered at
 * the host's 14px control-icon size through CSS.
 */
function icon(paths: readonly string[], cls: string): HTMLElement | null {
  const doc = document
  if (typeof doc.createElementNS !== 'function') return null
  const svg = doc.createElementNS('http://www.w3.org/2000/svg', 'svg') as SVGElement
  svg.setAttribute('viewBox', '0 0 24 24')
  svg.setAttribute('fill', 'none')
  svg.setAttribute('stroke', 'currentColor')
  svg.setAttribute('stroke-width', '2')
  svg.setAttribute('stroke-linecap', 'round')
  svg.setAttribute('stroke-linejoin', 'round')
  svg.setAttribute('aria-hidden', 'true')
  svg.setAttribute('class', cls)
  for (const d of paths) {
    const path = doc.createElementNS('http://www.w3.org/2000/svg', 'path') as SVGElement
    path.setAttribute('d', d)
    svg.appendChild(path)
  }
  return svg as unknown as HTMLElement
}

/** Lucide `search` — the SearchField leading icon. */
const SEARCH_ICON = [
  'M11 3a8 8 0 1 0 0 16 8 8 0 0 0 0-16z',
  'm21 21-4.35-4.35',
] as const

/** Lucide `chevron-down` — the select trigger chevron. */
const CHEVRON_DOWN_ICON = ['m6 9 6 6 6-6'] as const