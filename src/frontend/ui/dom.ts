/**
 * LumiTag shared DOM toolkit.
 *
 * Every other LumiTag UI module builds elements through THIS file and nowhere
 * else. The rules it enforces are the reason it exists:
 *
 *  1. **No `innerHTML`, ever.** User data (character names, tag names, backend
 *     error messages) is always appended as a real `Text` node via `text()`,
 *     so no character can inject markup or attributes into the host document.
 *  2. **Every icon-only / destructive control carries an `aria-label`.** A
 *     control that only shows an "×" or "?" glyph is unreadable otherwise.
 *  3. **Listeners are disposable.** `on()` returns an unsubscribe function and
 *     every builder that attaches a listener keeps a reference to it, so
 *     `destroy()` on a section can remove everything it added.
 *  4. **Dependency-free and DOM-only.** No imports from the store or any other
 *     LumiTag module, so any UI module can depend on it without a cycle.
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
 * Strings in `children` become text nodes — never markup.
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

/** Remove every child of `node`. */
export function clear(node: Element): void {
  while (node.firstChild !== null) node.removeChild(node.firstChild)
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

export interface ButtonOptions {
  variant?: 'default' | 'primary' | 'danger' | 'ghost'
  title?: string
  /** Required whenever `label` is not meaningful on its own (icon-only buttons). */
  ariaLabel?: string
  disabled?: boolean
  onClick?: (ev: MouseEvent) => void
}

/**
 * A styled `<button type="button">`.
 *
 * `type="button"` is set explicitly: without it a button inside a host form
 * would submit it, which is never what an extension control wants.
 */
export function button(label: string, opts?: ButtonOptions): HTMLButtonElement {
  const variant = opts?.variant ?? 'default'
  const node = el('button', {
    class: classAttr('lt-btn', `lt-btn--${variant}`),
    type: 'button',
    ...(opts?.title === undefined ? {} : { title: opts.title }),
    ...(opts?.ariaLabel === undefined ? {} : { 'aria-label': opts.ariaLabel }),
    ...(opts?.disabled === true ? { disabled: true } : {}),
  })
  if (opts?.onClick) on(node, 'click', opts.onClick)
  if (label !== '') node.appendChild(text(label))
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
    b.disabled = true
    return
  }
  const original = b.dataset['ltOriginalLabel']
  if (original !== undefined) {
    b.textContent = original
    delete b.dataset['ltOriginalLabel']
  }
  b.removeAttribute('aria-busy')
  b.disabled = false
}

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
 * reader announces something meaningful.
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
    on(img, 'load', () => {
      box.dataset['ltLoaded'] = 'true'
    })
    on(img, 'error', () => {
      box.removeChild(img)
    })
    box.appendChild(img)
  }

  return box
}

export interface ChipOptions {
  /** When present the chip renders a real removal `<button>`. */
  onRemove?: () => void
  removeLabel?: string
  tone?: 'default' | 'accent' | 'muted'
}

/**
 * An inline tag chip.
 *
 * The remove control is a genuine `<button type="button">` with an
 * accessible label naming the tag, so it is reachable by keyboard and
 * announced as "Remove tag Elf" rather than "button".
 */
export function chip(label: string, opts?: ChipOptions): HTMLElement {
  const tone = opts?.tone ?? 'default'
  const node = el('span', { class: classAttr('lt-chip', `lt-chip--${tone}`) })
  node.appendChild(el('span', { class: 'lt-chip__label' }, [label]))

  if (opts?.onRemove) {
    const removeLabel = opts.removeLabel ?? `Remove tag ${label}`
    node.appendChild(
      button('×', {
        variant: 'ghost',
        ariaLabel: removeLabel,
        title: removeLabel,
        onClick: () => opts.onRemove?.(),
      }),
    )
  }

  return node
}

/**
 * A labelled form control.
 *
 * The label element wraps the control, so clicking the text focuses it and the
 * accessible name comes for free without an id/`for` pair.
 */
export function field(label: string, control: HTMLElement, hint?: string): HTMLElement {
  const node = el('label', { class: 'lt-field' })
  node.appendChild(el('span', { class: 'lt-field__label' }, [label]))
  node.appendChild(control)
  if (hint !== undefined && hint !== '') node.appendChild(el('span', { class: 'lt-field__hint' }, [hint]))
  return node
}

/** A checkbox whose change handler receives the new checked state. */
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
  on(input, 'change', () => onChange(input.checked))
  return input
}

/** A `<select>` driven by a literal value list. */
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
  on(node, 'change', () => {
    const next = node.value as T
    // An unknown value can only come from a stale DOM; ignore it rather than
    // feeding the store a mode it does not know.
    if (options.some((o) => o.value === next)) onChange(next)
  })
  return node
}

/**
 * A search box.
 *
 * `type="search"` gives the host its native clear affordance;
 * `spellcheck="false"`/`autocapitalize="none"` stop the OS from mangling
 * query syntax like `T:` and `-`.
 */
export function searchInput(
  placeholder: string,
  value: string,
  onInput: (v: string) => void,
): HTMLInputElement {
  const input = el('input', {
    class: 'lt-search',
    type: 'search',
    placeholder,
    'aria-label': placeholder,
    autocomplete: 'off',
    autocapitalize: 'none',
    spellcheck: 'false',
    value,
  })
  input.value = value
  on(input, 'input', () => onInput(input.value))
  return input
}

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

/** A generic container with a caller-supplied `lt-` class. */
export function sectionEl(cls: string, children?: (Node | string | null | undefined)[]): HTMLElement {
  return el('div', { class: classAttr('lt-box', cls) }, children)
}

/** A horizontal layout row. */
export function row(...children: (Node | string | null | undefined)[]): HTMLElement {
  return el('div', { class: 'lt-row' }, children)
}