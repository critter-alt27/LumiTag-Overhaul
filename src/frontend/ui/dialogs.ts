/**
 * LumiTag dialogs.
 *
 * Every destructive or multi-record change in LumiTag goes through one of the
 * dialogs below. The module is deliberately thin in one specific way: it never
 * plans, executes, or persists anything itself. It validates, explains, and then
 * calls a `store.actions.run*` action — the store owns planning, execution and
 * the resulting report. A dialog that wrote directly would create a second,
 * unaudited path to the backend and could apply a change the store never
 * recorded.
 *
 * ## Safety rules this module enforces
 *
 *  1. **No write happens merely because a dialog opened.** Every mutation is
 *     behind an explicit click on a confirm control.
 *  2. **No double submit.** The confirm control goes busy (disabled +
 *     `aria-busy`) for the whole duration of the action.
 *  3. **The preview is re-checked at confirm time.** If the affected-character
 *     count moved since the dialog opened, the stale preview is refreshed and
 *     the user must confirm a second time.
 *  4. **Escape always cancels.** Closing a dialog never performs its action.
 *  5. **No `innerHTML`.** Every user string (tag name, character name, backend
 *     message) is appended as a `Text` node by `dom.ts`.
 *
 * Accessibility: each overlay is a `role="dialog" aria-modal="true"` element
 * labelled by its own title, traps Tab, closes on Escape, and returns focus to
 * whatever opened it. At most {@link MAX_STACKED} overlays exist at once — the
 * oldest is closed when a third is requested, mirroring the host's own limit.
 *
 * ## Where a dialog is mounted
 *
 * On `document.body`, never inside the host's drawer tab panel. A transformed,
 * isolated or contained ancestor becomes the containing block for its
 * `position: fixed` descendants, so an in-drawer overlay sized itself against
 * the drawer instead of the viewport and every dialog rendered visibly
 * off-centre on a phone. See {@link portalParent}.
 */

import { classifyError } from '../mutations/executor'
import { validateNewTagName, validateRenameTarget } from '../mutations/planner'
import { summarizeReport, type OperationReport } from '../mutations/report'
import { type SearchHelpSection } from '../search/search-help'
import type { TagManagerStore, StoreView } from '../store'
import { tagKey, type TagEntry } from '../tag-index'
import { setDialogOpener } from './dialog-host'
import { button, clear, el, field, on, row, setBusy, setDisabled, text } from './dom'
import type { DialogRequest } from './shell'

// ---------------------------------------------------------------------------
// Host contract
// ---------------------------------------------------------------------------

export interface ConfirmOptions {
  title: string
  message: string
  variant?: 'info' | 'warning' | 'danger' | 'success'
  confirmLabel?: string
  cancelLabel?: string
}

export interface DialogHost {
  /** Container the dialogs render into. Owned by the composition root. */
  root: HTMLElement
  /** Host confirm API. Falls back to an in-panel confirm when absent. */
  confirm?: (options: ConfirmOptions) => Promise<{ confirmed: boolean }>
  store: TagManagerStore
}

// ---------------------------------------------------------------------------
// Overlay primitives
// ---------------------------------------------------------------------------

/** The host allows two stacked modals; in-panel overlays follow the same cap. */
const MAX_STACKED = 2

/** Focusable descendants, in DOM order, for the Tab trap. */
const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',')

interface OverlayHandle {
  /** The fixed, full-root backdrop. */
  element: HTMLElement
  /** The `.lt-dialog` panel inside it. */
  panel: HTMLElement
  /** Content region, replaceable via {@link replaceBody}. */
  body: HTMLElement
  /** Footer region for the dialog's controls. */
  actions: HTMLElement
  /** Show a validation/error message inside the panel. An empty string clears. */
  showMessage(kind: 'error' | 'warning' | 'info', message: string): void
  replaceBody(node: HTMLElement): void
  close(): void
}

/**
 * Per-root overlay stacks, so two tabs cannot fight over one global list.
 *
 * The key is still `host.root` even though overlays no longer live there: it is
 * the *logical* owner of the dialogs, and the stack is what keeps the
 * MAX_STACKED cap per tab rather than global. Keying it on the portal parent
 * instead would let one extension instance's third dialog close another
 * instance's dialog.
 */
const stacks = new WeakMap<HTMLElement, OverlayHandle[]>()

function stackFor(root: HTMLElement): OverlayHandle[] {
  let stack = stacks.get(root)
  if (!stack) {
    stack = []
    stacks.set(root, stack)
  }
  return stack
}

/**
 * Where an overlay is mounted: the document body, NOT `host.root`.
 *
 * ## Why this is not "the dialog container the host gave us"
 *
 * `.lt-dialog-overlay` is `position: fixed; inset: 0`, and its whole job is to
 * cover the viewport so the dialog lands in the middle of the SCREEN. That only
 * holds while the overlay's containing block is the viewport.
 *
 * Per CSS, an ancestor with `transform`, `will-change: transform`, `filter`,
 * `contain: layout|paint`, `backdrop-filter`, or `isolation: isolate` BECOMES
 * the containing block for its `position: fixed` descendants — `inset: 0`
 * then resolves against that ancestor's box, not the viewport. The host's
 * drawer panel is exactly such an ancestor (Lumiverse
 * `ViewportDrawer.module.css`: `transition: transform …` on the drawer root,
 * `transform: translateX(…)` on the panel, `isolation: isolate` on `.drawer`),
 * and `host.root` — the drawer tab panel we were handed — sits inside it.
 *
 * So `inset: 0` resolved against a 320px-wide drawer in a 360px viewport and
 * the overlay measured `left: 40 → right: 360`. The dialog was perfectly
 * centred INSIDE that overlay and still 20px right of centre on screen. That is
 * why a round of width/`box-sizing` fixes could never cure it: they were
 * correct, but the fault was the containing block, not the size.
 *
 * Appending to `document.body` puts the overlay outside every transformed,
 * isolated or contained host wrapper, so `inset: 0` really is the viewport.
 *
 * ## Why that also removed the remount machinery
 *
 * The shell owns `host.root` and empties it on every store change, which used
 * to wipe an open dialog on any unrelated re-render (typing in the search box
 * mid-dialog closed it). The old workaround re-appended the overlay into
 * `host.root` from a store subscription — which is precisely what dragged it
 * back into the drawer's containing block and produced the off-centre dialog.
 * Mounting on `document.body` fixes both problems at once: the shell does not
 * own `document.body`, so the overlay survives re-renders for free and no
 * subscription (and no observer fighting a reparent) is needed at all.
 *
 * DO NOT "simplify" this back to `host.root.appendChild(element)`, and do not
 * reintroduce a store-subscription remount: they undo the fix.
 */
function portalParent(host: DialogHost): HTMLElement {
  // `ownerDocument` rather than the bare `document`: the overlay must be
  // mounted in the document the host root actually lives in.
  return host.root.ownerDocument.body
}

let titleSeq = 0

/** A UI-safe message for anything thrown by a store action. Never a stack trace. */
function safeMessage(error: unknown, fallback: string): string {
  try {
    const message = classifyError(error).message.trim()
    return message === '' ? fallback : message
  } catch {
    return fallback
  }
}

/**
 * Open the in-panel overlay.
 *
 * Positions itself over the VIEWPORT and wires the accessible dialog contract.
 * It is mounted on `document.body`, not on `host.root` — {@link portalParent}
 * explains the transformed-ancestor containing-block trap that makes an
 * in-drawer mount render off-centre.
 * Both the overlay and the panel are laid out entirely by the stylesheet (see
 * the `.lt-dialog-overlay` / `.lt-dialog` rules in styles.ts). This used to
 * inline a duplicate of every layout declaration here, which was both redundant
 * and harmful: an inline declaration beats the stylesheet, so the stylesheet's
 * narrow-viewport rules (tighter overlay padding, `box-sizing: border-box`)
 * could never take effect and the panel kept its content-box width — 22px wider
 * than the padded overlay — and ran off the right edge of a phone screen.
 */
function openOverlay(host: DialogHost, title: string, description?: string): OverlayHandle {
  const stack = stackFor(host.root)

  // Hard cap: closing the oldest keeps the stack bounded even if a caller
  // ignores the "one dialog at a time" convention.
  while (stack.length >= MAX_STACKED) {
    const oldest = stack.shift()
    oldest?.close()
  }

  const restoreTo = document.activeElement instanceof HTMLElement ? document.activeElement : null
  const titleId = `lt-dialog-title-${++titleSeq}`
  const disposers: (() => void)[] = []
  let closed = false

  const messageHost = el('div', { class: 'lt-dialog__messages' })
  const body = el('div', { class: 'lt-dialog__body' })
  const actions = el('div', { class: 'lt-dialog__actions' })

  // Class only. `position`, `width: min(560px, 100%)`, `max-height`,
  // `overflow-y`, `box-sizing: border-box` and the `100vw` cap all come from
  // `.lt-dialog` in styles.ts. An earlier version inlined
  // `width: min(560px, 100%)` under the default content-box sizing: the 10px
  // padding plus 1px border were added on top of that width, so on a phone the
  // panel rendered 22px wider than the padded overlay and was clipped off the
  // right edge of the screen.
  const panel = el('div', {
    class: 'lt-dialog',
    role: 'dialog',
    'aria-modal': 'true',
    'aria-labelledby': titleId,
    tabindex: '-1',
  })
  panel.appendChild(el('h3', { class: 'lt-dialog__title', id: titleId }, [title]))
  if (description !== undefined && description !== '') {
    panel.appendChild(el('p', { class: 'lt-dialog__desc' }, [description]))
  }
  panel.appendChild(messageHost)
  panel.appendChild(body)
  panel.appendChild(actions)

  // Class only — no inline style. `.lt-dialog-overlay` in styles.ts owns the
  // fixed positioning, the flex centring and the 12px/8px responsive padding.
  // The hardcoded `rgba(0,0,0,0.45)` that used to live here was also
  // theme-blind; the stylesheet composes the scrim from `--lumiverse-text`
  // instead. Both of those inline declarations outranked the stylesheet, which
  // is exactly why the mobile padding override could not take effect.
  const element = el('div', { class: 'lt-dialog-overlay' })
  element.appendChild(panel)

  const handle: OverlayHandle = {
    element,
    panel,
    body,
    actions,
    showMessage: (kind, message) => {
      clear(messageHost)
      if (message === '') return
      // Warnings are `role="alert"` too: a stale-preview warning BLOCKS the
      // action, so it must be announced rather than sit quietly in the panel.
      const state = el('div', {
        class: kind === 'error' ? 'lt-state lt-state--error' : 'lt-toolbar__banner',
        role: 'alert',
      })
      state.appendChild(el('span', {}, [message]))
      messageHost.appendChild(state)
    },
    replaceBody: (node) => {
      clear(body)
      body.appendChild(node)
    },
    close,
  }

  function close(): void {
    if (closed) return
    closed = true
    for (const dispose of disposers) {
      try {
        dispose()
      } catch {
        // A failing disposer must not leave the overlay stuck open.
      }
    }
    disposers.length = 0
    element.remove()
    const live = stackFor(host.root)
    const at = live.indexOf(handle)
    if (at >= 0) live.splice(at, 1)
    // Focus returns to whatever opened the dialog, so keyboard and
    // screen-reader users are not dumped back at the top of the document.
    if (restoreTo !== null && restoreTo.isConnected) {
      try {
        restoreTo.focus()
      } catch {
        // A trigger that vanished is not an error worth surfacing.
      }
    }
  }

  disposers.push(
    on(element, 'keydown', (ev) => {
      const event = ev as KeyboardEvent
      if (event.key === 'Escape') {
        // Escape is always a cancel: never a confirm.
        event.preventDefault()
        event.stopPropagation()
        close()
        return
      }
      if (event.key !== 'Tab') return
      const focusable = [...panel.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)]
      if (focusable.length === 0) {
        event.preventDefault()
        return
      }
      const first = focusable[0] as HTMLElement
      const last = focusable[focusable.length - 1] as HTMLElement
      const active = document.activeElement
      if (event.shiftKey && (active === first || !panel.contains(active))) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && (active === last || !panel.contains(active))) {
        event.preventDefault()
        first.focus()
      }
    }),
    // A click on the backdrop cancels, mirroring a native modal's scrim.
    on(element, 'mousedown', (ev) => {
      if (ev.target === element) close()
    }),
  )

  // Mounted on document.body, NOT on host.root — see {@link portalParent} for
  // the transformed-ancestor containing-block trap that makes this mandatory.
  portalParent(host).appendChild(element)
  stack.push(handle)
  const focusTarget = panel.querySelector<HTMLElement>(FOCUSABLE_SELECTOR)
  if (focusTarget !== null) focusTarget.focus()
  else panel.focus()

  return handle
}

/** Replace a dialog's footer controls. */
function setActions(handle: OverlayHandle, ...controls: HTMLElement[]): void {
  clear(handle.actions)
  for (const control of controls) handle.actions.appendChild(control)
}

/** A scrollable list of lines, capped so a large selection stays responsive. */
function cappedList(items: readonly string[], cap = 200): HTMLElement {
  const list = el('div', { class: 'lt-dialog__list' })
  const shown = items.slice(0, cap)
  for (const item of shown) {
    list.appendChild(el('div', { class: 'lt-dialog__desc' }, [item]))
  }
  if (items.length > shown.length) {
    list.appendChild(
      el('div', { class: 'lt-dialog__desc' }, [`…and ${items.length - shown.length} more`]),
    )
  }
  if (items.length === 0) {
    list.appendChild(el('div', { class: 'lt-dialog__desc' }, ['(none)']))
  }
  return list
}

function characterCount(count: number, singular = 'character'): string {
  return `${count} ${count === 1 ? singular : `${singular}s`}`
}

/**
 * Ask for confirmation.
 *
 * Uses the host API when it exists; otherwise renders an in-panel confirm as a
 * second stacked overlay, which is the documented fallback.
 */
async function requestConfirm(
  host: DialogHost,
  title: string,
  message: string,
  options: { variant?: ConfirmOptions['variant']; confirmLabel?: string } = {},
): Promise<boolean> {
  if (typeof host.confirm === 'function') {
    try {
      const answer = await host.confirm({
        title,
        message,
        variant: options.variant ?? 'warning',
        ...(options.confirmLabel === undefined ? {} : { confirmLabel: options.confirmLabel }),
      })
      return answer?.confirmed === true
    } catch {
      // A throwing host confirm must never become an accidental approval.
      return false
    }
  }

  return new Promise<boolean>((resolve) => {
    const fallback = openOverlay(host, title)
    fallback.replaceBody(el('p', { class: 'lt-dialog__desc' }, [message]))
    let settled = false
    const settle = (value: boolean): void => {
      if (settled) return
      settled = true
      observer.disconnect()
      resolve(value)
    }
    const observer = new MutationObserver(() => {
      // Dismissed by Escape or the scrim: that is a cancel, never a confirm.
      if (!fallback.element.isConnected) settle(false)
    })
    // Watch the PORTAL, not `host.root`. The overlay is mounted on document.body
    // (see portalParent), so a childList change in the drawer tab root says
    // nothing about whether it is still open — and must NOT be read as a
    // dismissal, or every unrelated re-render would silently cancel the
    // confirm.
    observer.observe(portalParent(host), { childList: true })
    setActions(
      fallback,
      button('Cancel', {
        variant: 'ghost',
        onClick: () => {
          settle(false)
          fallback.close()
        },
      }),
      button(options.confirmLabel ?? 'Confirm', {
        variant: 'danger',
        onClick: () => {
          settle(true)
          fallback.close()
        },
      }),
    )
  })
}

// ---------------------------------------------------------------------------
// Result reporting
// ---------------------------------------------------------------------------

function statusLabel(report: OperationReport): string {
  switch (report.status) {
    case 'succeeded':
      return 'Completed'
    case 'partially_completed':
      return 'Partially completed'
    case 'failed':
      return 'Failed'
    case 'running':
      return 'In progress'
    default:
      return 'Pending'
  }
}

/** The most recent report the store produced, if any. */
function latestReport(store: TagManagerStore): OperationReport | null {
  const reports = store.view.reports
  if (reports.length === 0) return null
  return reports[reports.length - 1] ?? null
}

/**
 * Replace a dialog's body with the outcome of the action it just ran.
 *
 * The store records the report and the failure panel renders it in full; showing
 * the headline result here means the user is told what happened even if they
 * never scroll down to the panel.
 */
function showOutcome(handle: OverlayHandle, store: TagManagerStore, context: string): void {
  const report = latestReport(store)
  const wrap = el('div', { class: 'lt-dialog__summary' })
  wrap.appendChild(el('p', {}, [text(context)]))

  if (report === null) {
    wrap.appendChild(
      el('p', { class: 'lt-dialog__desc' }, [
        'No operation report was produced. Refresh to check the current tags.',
      ]),
    )
  } else {
    let headline: string
    if (report.status === 'succeeded') {
      headline = 'Every character in this operation was updated.'
    } else if (report.status === 'partially_completed') {
      headline =
        'Partially completed: some characters were updated and some were not. The report panel below lists each failure and a retry control.'
    } else if (report.status === 'failed') {
      headline = 'Nothing was applied. The reason is in the report below.'
    } else {
      headline = 'Still running.'
    }
    wrap.appendChild(el('p', {}, [el('strong', {}, [statusLabel(report)])]))
    wrap.appendChild(el('p', { class: 'lt-dialog__desc' }, [headline]))
    const pre = el('pre', {
      class: 'lt-dialog__desc',
      style: 'white-space:pre-wrap;margin:4px 0 0;',
    })
    pre.appendChild(text(summarizeReport(report)))
    wrap.appendChild(pre)
  }

  handle.replaceBody(wrap)
  setActions(
    handle,
    button('Done', { variant: 'primary', onClick: () => handle.close() }),
  )
}

/**
 * Run a store action behind a busy confirm control.
 *
 * The control is disabled for the whole call, so a second click cannot start a
 * second copy of the same destructive operation, and the outcome replaces the
 * form in place.
 */
async function runAction(
  handle: OverlayHandle,
  control: HTMLButtonElement,
  action: () => Promise<void>,
  context: string,
  store: TagManagerStore,
): Promise<void> {
  if (control.disabled) return
  setBusy(control, true, 'Applying…')
  handle.showMessage('info', '')
  try {
    await action()
  } catch (error) {
    handle.showMessage('error', safeMessage(error, 'The operation could not be started.'))
  } finally {
    setBusy(control, false)
  }
  showOutcome(handle, store, context)
}

// ---------------------------------------------------------------------------
// create_tag
// ---------------------------------------------------------------------------

/**
 * Create a tag and assign it to the chosen characters.
 *
 * Two steps: the form (name + searchable multi-select character picker), then a
 * review of exactly what will be written. A name colliding with an existing tag
 * — including a case-only variant — never creates a duplicate: the dialog offers
 * to assign the existing tag to the same characters instead.
 */
function openCreateTag(host: DialogHost): void {
  const { store } = host
  const handle = openOverlay(
    host,
    'Create tag',
    'A new tag is created and assigned to the characters you pick. This is saved for every character you select.',
  )

  const selected = new Set<string>()
  let searchTerm = ''
  let nameInput!: HTMLInputElement
  let pickerList!: HTMLElement
  let pickerCount!: HTMLElement
  const characters = (): StoreView['characters'] => store.view.characters

  const nameFor = (id: string): string => {
    const found = characters().find((c) => c.id === id)
    return found ? found.name || id : id
  }

  const matchesTerm = (name: string, id: string): boolean => {
    const term = searchTerm.trim().toLowerCase()
    return term === '' || name.toLowerCase().includes(term) || id.toLowerCase().includes(term)
  }

  const renderPicker = (): void => {
    clear(pickerList)
    const rows = characters()
    const matching = rows.filter((c) => matchesTerm(c.name, c.id))
    if (matching.length === 0) {
      pickerList.appendChild(
        el('p', { class: 'lt-dialog__desc' }, [
          rows.length === 0
            ? 'No characters are loaded yet. Refresh and try again.'
            : 'No character matches this search.',
        ]),
      )
    }
    for (const character of matching) {
      const line = el('div', { class: 'lt-row lt-row--wrap' })
      const box = el('input', { class: 'lt-checkbox', type: 'checkbox' })
      box.checked = selected.has(character.id)
      box.setAttribute('aria-label', `Assign ${character.name || character.id}`)
      on(box, 'change', () => {
        if (box.checked) selected.add(character.id)
        else selected.delete(character.id)
        renderCounts()
      })
      line.appendChild(box)
      line.appendChild(el('span', {}, [character.name || character.id]))
      if (character.tags.length > 0) {
        line.appendChild(
          el('span', { class: 'lt-badge lt-badge--muted' }, [
            `${character.tags.length} tag${character.tags.length === 1 ? '' : 's'}`,
          ]),
        )
      }
      pickerList.appendChild(line)
    }
  }

  const renderCounts = (): void => {
    clear(pickerCount)
    pickerCount.appendChild(text(`${selected.size} of ${characters().length} selected`))
  }

  /**
   * Validate the form WITHOUT writing anything.
   *
   * Both problems are reported together: a user who has not typed a name AND
   * not ticked a box should see both, not whichever happens to be checked
   * first. A collision carries the existing entry forward so the caller can
   * offer to assign that tag instead of creating a duplicate.
   */
  const validate = ():
    | { ok: true; name: string }
    | { ok: false; message: string; existing?: TagEntry } => {
    const nameResult = validateNewTagName(nameInput.value, store.view.tagIndex.tags)
    const problems: string[] = []
    if (!nameResult.ok) problems.push(nameResult.message)
    if (selected.size === 0) problems.push('Select at least one character to receive the tag.')

    if (problems.length === 0 && nameResult.ok) return { ok: true, name: nameResult.value }
    return {
      ok: false,
      message: problems.join(' '),
      ...(nameResult.ok || nameResult.existing === undefined ? {} : { existing: nameResult.existing }),
    }
  }

  /**
   * Step 2: the review, ending in either Create or Assign-existing.
   *
   * The Review control is deliberately NEVER disabled: a disabled button cannot
   * explain WHY the form is incomplete, and the blank/duplicate messages below
   * are only reachable by pressing it.
   */
  function showReview(): void {
    const validation = validate()
    if (!validation.ok) {
      handle.showMessage('error', validation.message)
      if (validation.existing === undefined) return
      // A duplicate is not a dead end: offer the non-duplicating path instead.
      const existing = validation.existing
      const assignButton = button(`Assign existing "${existing.name}" instead`, {
        variant: 'primary',
        onClick: () => {
          void confirmAssignExisting(existing, assignButton)
        },
      })
      setActions(
        handle,
        button('Cancel', { variant: 'ghost', onClick: () => handle.close() }),
        assignButton,
      )
      return
    }

    handle.showMessage('info', '')
    const name = validation.name
    const wrap = el('div', { class: 'lt-dialog__summary' })
    wrap.appendChild(el('p', {}, [el('strong', {}, [`New tag: ${name}`])]))
    wrap.appendChild(
      el('p', { class: 'lt-dialog__desc' }, [
        `It will be assigned to ${characterCount(selected.size)}. Tags those characters already have are kept.`,
      ]),
    )
    wrap.appendChild(cappedList([...selected].map(nameFor)))
    handle.replaceBody(wrap)

    const confirmButton = button('Create tag and assign', {
      variant: 'primary',
      onClick: () => {
        void confirmCreate(name, confirmButton)
      },
    })
    setActions(
      handle,
      button('Back', { variant: 'ghost', onClick: () => renderForm() }),
      confirmButton,
    )
  }

  async function confirmCreate(name: string, control: HTMLButtonElement): Promise<void> {
    const confirmed = await requestConfirm(
      host,
      'Create this tag?',
      `Create the tag "${name}" and assign it to ${characterCount(selected.size)}. Existing tags are preserved.`,
      { variant: 'info', confirmLabel: `Create "${name}"` },
    )
    if (!confirmed) return
    await runAction(
      handle,
      control,
      () => store.actions.runCreateTagAndAssign(name, [...selected]),
      `Created the tag "${name}" and assigned it to ${characterCount(selected.size)}.`,
      store,
    )
  }

  /** Assigns the EXISTING tag to the same characters — never mints a duplicate. */
  async function confirmAssignExisting(
    existing: TagEntry,
    control: HTMLButtonElement,
  ): Promise<void> {
    const confirmed = await requestConfirm(
      host,
      'Assign the existing tag?',
      `"${existing.name}" already exists and is on ${characterCount(existing.count)}. Assign it to the ${characterCount(selected.size)} you selected instead of creating a duplicate?`,
      { variant: 'info', confirmLabel: `Assign "${existing.name}"` },
    )
    if (!confirmed) return
    await runAction(
      handle,
      control,
      () => store.actions.runBulkAssign([existing.name], [...selected]),
      `Assigned the existing tag "${existing.name}" to ${characterCount(selected.size)}.`,
      store,
    )
  }

  /** Step 1: the name field and the searchable, multi-select character picker. */
  function renderForm(): void {
    handle.showMessage('info', '')

    nameInput = el('input', {
      class: 'lt-input',
      type: 'text',
      placeholder: 'Tag name',
      'aria-label': 'New tag name',
      autocomplete: 'off',
    })
    on(nameInput, 'input', () => handle.showMessage('info', ''))

    const pickerSearch = el('input', {
      class: 'lt-search',
      type: 'search',
      placeholder: 'Search characters to assign',
      'aria-label': 'Search characters to assign',
      autocomplete: 'off',
    })
    on(pickerSearch, 'input', () => {
      searchTerm = pickerSearch.value
      renderPicker()
    })

    pickerCount = el('p', { class: 'lt-dialog__desc' })
    pickerList = el('div', { class: 'lt-dialog__list', style: 'max-height:220px;overflow-y:auto;' })

    const picker = el('div')
    picker.appendChild(el('p', { class: 'lt-dialog__desc' }, ['Characters']))
    picker.appendChild(pickerSearch)
    picker.appendChild(pickerCount)
    picker.appendChild(pickerList)
    picker.appendChild(
      row(
        button('Select all shown', {
          variant: 'ghost',
          onClick: () => {
            for (const c of characters()) {
              if (matchesTerm(c.name, c.id)) selected.add(c.id)
            }
            renderPicker()
            renderCounts()
          },
        }),
        button('Clear selection', {
          variant: 'ghost',
          onClick: () => {
            selected.clear()
            renderPicker()
            renderCounts()
          },
        }),
      ),
    )

    const form = el('div')
    form.appendChild(
      field('Tag name', nameInput, 'Required. Must not already exist, ignoring case.'),
    )
    form.appendChild(picker)

    renderCounts()
    renderPicker()
    handle.replaceBody(form)

    setActions(
      handle,
      button('Cancel', { variant: 'ghost', onClick: () => handle.close() }),
      button('Review', { variant: 'primary', onClick: () => showReview() }),
    )
  }

  renderForm()
}

// ---------------------------------------------------------------------------
// rename_tag
// ---------------------------------------------------------------------------

/**
 * Rename a tag across the whole library.
 *
 * The rename is global by design — the store plans it over every accessible
 * character — so the dialog shows the real affected-character count and requires
 * a second confirmation if that count moves between the preview and the click.
 */
function openRenameTag(host: DialogHost, tag: string): void {
  const { store } = host
  const handle = openOverlay(
    host,
    `Rename "${tag}"`,
    'Renaming changes this tag on every character that has it, not only the ones visible in the current filter.',
  )

  const affectedCount = (): number => store.view.tagIndex.byKey.get(tagKey(tag))?.count ?? 0
  let previewCount = affectedCount()
  let staleAcknowledged = false

  const input = el('input', {
    class: 'lt-input',
    type: 'text',
    value: tag,
    'aria-label': 'New tag name',
    autocomplete: 'off',
  })
  on(input, 'input', () => handle.showMessage('info', ''))

  const validate = (): { ok: true; name: string } | { ok: false; message: string } => {
    const result = validateRenameTarget(input.value, tag, store.view.tagIndex.tags)
    if (!result.ok) return { ok: false, message: result.message }
    return { ok: true, name: result.value }
  }

  /** Step 2: the review of exactly what will be written. */
  function showReview(): void {
    const validation = validate()
    if (!validation.ok) {
      handle.showMessage('error', validation.message)
      return
    }
    handle.showMessage('info', '')
    previewCount = affectedCount()
    staleAcknowledged = false

    const wrap = el('div', { class: 'lt-dialog__summary' })
    wrap.appendChild(el('p', {}, [el('strong', {}, [`${tag} → ${validation.name}`])]))
    wrap.appendChild(
      el('p', { class: 'lt-dialog__desc' }, [
        `${characterCount(previewCount)} will be updated, across the whole library. No characters are added or deleted, and no other tag changes.`,
      ]),
    )
    handle.replaceBody(wrap)

    const confirmButton = button('Rename tag', {
      variant: 'danger',
      onClick: () => {
        void confirmRename(validation.name, confirmButton)
      },
    })
    setActions(
      handle,
      button('Back', { variant: 'ghost', onClick: () => renderForm() }),
      confirmButton,
    )
  }

  async function confirmRename(to: string, control: HTMLButtonElement): Promise<void> {
    const current = affectedCount()
    if (current !== previewCount && !staleAcknowledged) {
      // The preview went stale between being shown and being confirmed.
      staleAcknowledged = true
      previewCount = current
      const wrap = el('div', { class: 'lt-dialog__summary' })
      wrap.appendChild(el('p', {}, [el('strong', {}, [`${tag} → ${to}`])]))
      wrap.appendChild(
        el('p', { class: 'lt-dialog__desc' }, [
          `Updated count: ${characterCount(current)}.`,
        ]),
      )
      handle.replaceBody(wrap)
      handle.showMessage(
        'warning',
        `The number of affected characters changed since this preview was shown (now ${current}). Review the updated count and confirm again.`,
      )
      return
    }
    const confirmed = await requestConfirm(
      host,
      `Rename "${tag}" to "${to}"?`,
      `This updates ${characterCount(current)} across the whole library.`,
      { variant: 'warning', confirmLabel: 'Rename tag' },
    )
    if (!confirmed) return
    await runAction(
      handle,
      control,
      () => store.actions.runRenameTag(tag, to),
      `Renamed "${tag}" to "${to}".`,
      store,
    )
  }

  /** Step 1: current name, replacement field, and the affected-character count. */
  function renderForm(): void {
    handle.showMessage('info', '')
    const summary = el('div', { class: 'lt-dialog__summary' })
    summary.appendChild(el('p', {}, [el('strong', {}, [`Current name: ${tag}`])]))
    summary.appendChild(
      el('p', { class: 'lt-dialog__desc' }, [
        `Affects ${characterCount(affectedCount())} — the whole library, including characters hidden by the current filter.`,
      ]),
    )
    const form = el('div')
    form.appendChild(summary)
    form.appendChild(
      field(
        'New tag name',
        input,
        'Required. Must not match another existing tag, ignoring case.',
      ),
    )
    handle.replaceBody(form)
    setActions(
      handle,
      button('Cancel', { variant: 'ghost', onClick: () => handle.close() }),
      button('Review', { variant: 'primary', onClick: () => showReview() }),
    )
  }

  renderForm()
}

// ---------------------------------------------------------------------------
// merge_review
// ---------------------------------------------------------------------------

/** The spelling the index knows for a key, falling back to the key itself. */
function displayName(index: StoreView['tagIndex'], key: string): string {
  return index.byKey.get(key)?.name ?? key
}

/** Review and run a merge of the selected targets into the primary tag. */
function openMergeReview(host: DialogHost): void {
  const { store } = host
  const handle = openOverlay(
    host,
    'Review merge',
    'Every selected tag is folded into the primary tag on every character that carries it.',
  )

  const view = (): StoreView => store.view
  const primaryKey = view().mergePrimaryKey
  const targetKeys = view().mergeTargetKeys
  const primaryName = primaryKey === null ? '' : displayName(view().tagIndex, primaryKey)
  const targetNames = targetKeys.map((key) => displayName(view().tagIndex, key))

  /** Characters reached by the primary OR any target, each counted once. */
  const affected = (): number => {
    const ids = new Set<string>()
    for (const key of [primaryKey, ...targetKeys]) {
      if (key === null) continue
      for (const id of view().tagIndex.byKey.get(key)?.characterIds ?? []) ids.add(id)
    }
    return ids.size
  }

  const primaryAmongTargets =
    primaryKey !== null &&
    targetKeys.some((key) => tagKey(displayName(view().tagIndex, key)) === tagKey(primaryName))
  const blocked =
    primaryKey === null || targetKeys.length === 0 || !view().mergeValid || primaryAmongTargets

  const wrap = el('div', { class: 'lt-dialog__summary' })
  wrap.appendChild(
    el('p', {}, [el('strong', {}, [`Primary tag: ${primaryName === '' ? '(none selected)' : primaryName}`])]),
  )
  wrap.appendChild(el('p', { class: 'lt-dialog__desc' }, [`Tags merged in (${targetNames.length}):`]))
  wrap.appendChild(cappedList(targetNames))
  wrap.appendChild(
    el('p', { class: 'lt-dialog__desc' }, [
      `${characterCount(affected())} will be updated: each gains "${primaryName}" where it is missing, and the tags merged in are removed from them.`,
    ]),
  )
  wrap.appendChild(
    el('p', { class: 'lt-dialog__desc' }, [
      'Assignments are consolidated into the primary tag. No characters are added or deleted, and this is not a single undoable step — rename or delete the leftovers afterwards if you need to.',
    ]),
  )
  handle.replaceBody(wrap)

  if (primaryKey === null || targetKeys.length === 0) {
    handle.showMessage('warning', 'This merge is not ready: pick a primary tag and at least one tag to merge into it.')
  } else if (!view().mergeValid) {
    handle.showMessage('warning', 'This merge is not valid yet, so it cannot be confirmed.')
  }
  if (primaryAmongTargets) {
    handle.showMessage('warning', 'The primary tag cannot also be one of the merged-in tags. Deselect it as a target first.')
  }

  const confirmButton = button('Merge tags', {
    variant: 'danger',
    onClick: () => {
      void confirmMerge(confirmButton)
    },
  })
  setDisabled(confirmButton, blocked)
  setActions(
    handle,
    button('Cancel', { variant: 'ghost', onClick: () => handle.close() }),
    confirmButton,
  )

  async function confirmMerge(control: HTMLButtonElement): Promise<void> {
    if (control.disabled) return
    const confirmed = await requestConfirm(
      host,
      'Merge these tags?',
      `Merge ${targetNames.length} tag(s) into "${primaryName}", updating ${characterCount(affected())}.`,
      { variant: 'warning', confirmLabel: 'Merge tags' },
    )
    if (!confirmed) return
    await runAction(
      handle,
      control,
      () => store.actions.runMergeTags(primaryName, targetNames),
      `Merged ${targetNames.length} tag(s) into "${primaryName}".`,
      store,
    )
  }
}

// ---------------------------------------------------------------------------
// delete_tags
// ---------------------------------------------------------------------------

/** Confirm a single or bulk tag deletion, listing the real assignment counts. */
function openDeleteTags(host: DialogHost, tags: readonly string[]): void {
  const { store } = host
  const handle = openOverlay(
    host,
    tags.length === 1 ? `Delete "${tags[0] ?? ''}"` : `Delete ${tags.length} tags`,
    'Tag associations are removed from the characters below. No characters are deleted.',
  )

  const countFor = (name: string): number => store.view.tagIndex.byKey.get(tagKey(name))?.count ?? 0
  const totalFor = (names: readonly string[]): number =>
    names.reduce((sum, name) => sum + countFor(name), 0)

  const renderList = (names: readonly string[]): HTMLElement => {
    const list = el('div', { class: 'lt-dialog__list' })
    const shown = names.slice(0, 200)
    for (const name of shown) {
      const count = countFor(name)
      const line = el('div', { class: 'lt-row lt-row--wrap' })
      line.appendChild(el('strong', {}, [name]))
      line.appendChild(
        el('span', { class: 'lt-badge' }, [
          count === 0 ? 'no assignments' : characterCount(count),
        ]),
      )
      list.appendChild(line)
    }
    if (names.length > shown.length) {
      list.appendChild(
        el('div', { class: 'lt-dialog__desc' }, [
          `…and ${names.length - shown.length} more tags`,
        ]),
      )
    }
    if (names.length === 0) {
      list.appendChild(el('div', { class: 'lt-dialog__desc' }, ['(no tags selected)']))
    }
    return list
  }

  const listHost = el('div')
  const wrap = el('div', { class: 'lt-dialog__summary' })
  wrap.appendChild(
    el('p', { class: 'lt-dialog__desc' }, [
      'These tags will be removed from every character that has them, across the whole library — not only the ones currently visible.',
    ]),
  )
  listHost.appendChild(renderList(tags))
  wrap.appendChild(listHost)

  const summaryLine = el('p', { class: 'lt-dialog__desc' })
  const renderTotals = (): void => {
    clear(summaryLine)
    summaryLine.appendChild(
      text(
        `In total ${characterCount(totalFor(tags))} will be updated. The characters themselves are not deleted, and their other tags are untouched.`,
      ),
    )
  }
  renderTotals()
  wrap.appendChild(summaryLine)
  handle.replaceBody(wrap)

  let previewCount = totalFor(tags)
  let staleAcknowledged = false

  const confirmButton = button('Delete tags', {
    variant: 'danger',
    onClick: () => {
      void confirmDelete(confirmButton)
    },
  })
  setActions(
    handle,
    button('Cancel', { variant: 'ghost', onClick: () => handle.close() }),
    confirmButton,
  )

  async function confirmDelete(control: HTMLButtonElement): Promise<void> {
    const current = totalFor(tags)
    if (current !== previewCount && !staleAcknowledged) {
      staleAcknowledged = true
      previewCount = current
      clear(listHost)
      listHost.appendChild(renderList(tags))
      renderTotals()
      handle.showMessage(
        'warning',
        `The assignment counts changed since this list was shown (now ${current} in total). Review the updated list and confirm again.`,
      )
      return
    }
    const confirmed = await requestConfirm(
      host,
      tags.length === 1 ? `Delete "${tags[0] ?? ''}"?` : `Delete ${tags.length} tags?`,
      `This removes the tag association from ${characterCount(current)}. No characters are deleted.`,
      { variant: 'danger', confirmLabel: 'Delete tags' },
    )
    if (!confirmed) return
    await runAction(
      handle,
      control,
      () => store.actions.runDeleteTags([...tags]),
      `Deleted ${tags.length} tag(s).`,
      store,
    )
  }
}

// ---------------------------------------------------------------------------
// bulk_assign_review
// ---------------------------------------------------------------------------

/** Review an additive bulk assignment before it is written. */
function openBulkAssignReview(host: DialogHost): void {
  const { store } = host
  const handle = openOverlay(
    host,
    'Review assignment',
    'Assignment only ever adds tags. It never removes a tag a character already has.',
  )

  const tagNames = store.view.selectedAssignTagKeys.map((key) =>
    displayName(store.view.tagIndex, key),
  )
  const characterIds = [...store.view.selectedCharacterIds]
  const nameFor = (id: string): string =>
    store.view.characters.find((c) => c.id === id)?.name || id

  const wrap = el('div', { class: 'lt-dialog__summary' })
  wrap.appendChild(el('p', {}, [el('strong', {}, [`Tags (${tagNames.length})`])]))
  wrap.appendChild(cappedList(tagNames))
  wrap.appendChild(el('p', { class: 'lt-dialog__desc' }, [`Characters (${characterIds.length})`]))
  wrap.appendChild(cappedList(characterIds.map(nameFor)))
  wrap.appendChild(
    el('p', { class: 'lt-dialog__desc' }, [
      `Each of the ${characterCount(characterIds.length)} keeps every tag it already has; the tags above are added on top. Nothing is overwritten or removed, and the result is not one undoable step.`,
    ]),
  )
  handle.replaceBody(wrap)

  if (tagNames.length === 0) {
    handle.showMessage('warning', 'No tags are selected, so there is nothing to assign.')
  } else if (characterIds.length === 0) {
    handle.showMessage('warning', 'No characters are selected, so there is nothing to assign.')
  }

  const ready = tagNames.length > 0 && characterIds.length > 0
  const confirmButton = button('Assign tags', {
    variant: 'primary',
    onClick: () => {
      void confirmAssign(confirmButton)
    },
  })
  setDisabled(confirmButton, !ready)
  setActions(
    handle,
    button('Cancel', { variant: 'ghost', onClick: () => handle.close() }),
    confirmButton,
  )

  async function confirmAssign(control: HTMLButtonElement): Promise<void> {
    if (control.disabled) return
    const confirmed = await requestConfirm(
      host,
      'Apply these tags?',
      `Add ${tagNames.length} tag(s) to ${characterCount(characterIds.length)}. Existing tags are preserved.`,
      { variant: 'info', confirmLabel: 'Assign tags' },
    )
    if (!confirmed) return
    await runAction(
      handle,
      control,
      () => store.actions.runBulkAssign(tagNames, characterIds),
      `Assigned ${tagNames.length} tag(s) to ${characterCount(characterIds.length)}.`,
      store,
    )
  }
}

// ---------------------------------------------------------------------------
// bulk_unassign_review
// ---------------------------------------------------------------------------

/**
 * Review a selection-scoped unassignment before it is written.
 *
 * Deliberately destructive-shaped UI (warning confirm, "Unassign" wording) even
 * though the planner is non-destructive: the user asked to take tags OFF, and a
 * review that read like an assignment would understate what they are about to do.
 *
 * The scope is stated twice — here and in the confirm — because "remove this tag"
 * without "from these N characters" is exactly how a selection-scoped edit gets
 * read as a library-wide one.
 */
function openBulkUnassignReview(host: DialogHost): void {
  const { store } = host
  const handle = openOverlay(
    host,
    'Review unassignment',
    'Unassignment only ever removes the tags below, and only from the selected characters.',
  )

  const tagNames = store.view.selectedAssignTagKeys.map((key) =>
    displayName(store.view.tagIndex, key),
  )
  const characterIds = [...store.view.selectedCharacterIds]
  const nameFor = (id: string): string =>
    store.view.characters.find((c) => c.id === id)?.name || id

  const wrap = el('div', { class: 'lt-dialog__summary' })
  wrap.appendChild(el('p', {}, [el('strong', {}, [`Tags to remove (${tagNames.length})`])]))
  wrap.appendChild(cappedList(tagNames))
  wrap.appendChild(
    el('p', { class: 'lt-dialog__desc' }, [
      `Selected characters (${characterIds.length}) — no other character is touched`,
    ]),
  )
  wrap.appendChild(cappedList(characterIds.map(nameFor)))
  wrap.appendChild(
    el('p', { class: 'lt-dialog__desc' }, [
      `Only the tags above are removed from the ${characterCount(characterIds.length)}. Every other tag is ` +
        'kept, a character that does not carry one of these tags is left untouched, and the result is not one ' +
        'undoable step.',
    ]),
  )
  handle.replaceBody(wrap)

  if (tagNames.length === 0) {
    handle.showMessage('warning', 'No tags are selected, so there is nothing to unassign.')
  } else if (characterIds.length === 0) {
    handle.showMessage('warning', 'No characters are selected, so there is nothing to unassign.')
  }

  const ready = tagNames.length > 0 && characterIds.length > 0
  const confirmButton = button('Unassign tags', {
    variant: 'danger',
    onClick: () => {
      void confirmUnassign(confirmButton)
    },
  })
  setDisabled(confirmButton, !ready)
  setActions(
    handle,
    button('Cancel', { variant: 'ghost', onClick: () => handle.close() }),
    confirmButton,
  )

  async function confirmUnassign(control: HTMLButtonElement): Promise<void> {
    if (control.disabled) return
    const confirmed = await requestConfirm(
      host,
      'Remove these tags?',
      `Remove ${tagNames.length} tag(s) from ${characterCount(characterIds.length)}. Other tags are ` +
        'preserved and no other character is changed.',
      { variant: 'warning', confirmLabel: 'Unassign tags' },
    )
    if (!confirmed) return
    await runAction(
      handle,
      control,
      () => store.actions.runBulkUnassign(tagNames, characterIds),
      `Unassigned ${tagNames.length} tag(s) from ${characterCount(characterIds.length)}.`,
      store,
    )
  }
}

// ---------------------------------------------------------------------------
// search_help
// ---------------------------------------------------------------------------

function renderHelpSection(section: SearchHelpSection): HTMLElement {
  const wrap = el('div')
  wrap.appendChild(el('h4', { class: 'lt-dialog__title' }, [section.title]))
  const list = el('div', { class: 'lt-dialog__list' })
  for (const entry of section.entries) {
    const line = el('div', {})
    line.appendChild(el('code', {}, [entry.syntax]))
    line.appendChild(el('span', { class: 'lt-dialog__desc' }, [` — ${entry.description}`]))
    list.appendChild(line)
  }
  wrap.appendChild(list)
  return wrap
}

/**
 * Render the shared search-syntax help.
 *
 * The `A:` field list is spelled out field by field, because "searches these
 * fields" inside a sentence is exactly the kind of thing users misread as
 * "searches everything".
 */
function openSearchHelp(host: DialogHost, context: 'tags' | 'characters'): void {
  const handle = openOverlay(
    host,
    context === 'tags' ? 'Search help — Tags' : 'Search help — Characters',
    'The search syntax is the same everywhere in LumiTag.',
  )

  const wrap = el('div')
  for (const section of host.store.actions.searchHelp(context)) {
    wrap.appendChild(renderHelpSection(section))
  }

  if (context === 'tags') {
    const note = el('div')
    note.appendChild(el('h4', { class: 'lt-dialog__title' }, ['In the Tags list']))
    note.appendChild(
      el('p', { class: 'lt-dialog__desc' }, [
        'C: searches CHARACTER NAMES, not tag names. Use T:Elf to find the tag Elf, and combine it with C:Aria to see the tags of characters named Aria.',
      ]),
    )
    wrap.appendChild(note)
  }

  handle.replaceBody(wrap)
  setActions(handle, button('Close', { variant: 'primary', onClick: () => handle.close() }))
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Open the dialog for a shell request.
 *
 * This is the single entry point the shell talks to. An unusable request is
 * ignored rather than thrown, so a mismatch can never break the tab.
 */
export function openDialog(host: DialogHost, request: DialogRequest): void {
  if (!host || !host.root || !host.store) return
  switch (request.kind) {
    case 'create_tag':
      openCreateTag(host)
      return
    case 'rename_tag':
      openRenameTag(host, request.tag)
      return
    case 'merge_review':
      openMergeReview(host)
      return
    case 'delete_tags':
      if (request.tags.length > 0) openDeleteTags(host, request.tags)
      return
    case 'bulk_assign_review':
      openBulkAssignReview(host)
      return
    case 'bulk_unassign_review':
      openBulkUnassignReview(host)
      return
    case 'search_help':
      openSearchHelp(host, request.context)
      return
    default:
      return
  }
}

/**
 * Register {@link openDialog} as the app-wide dialog opener.
 *
 * Returns a disposer that clears the registration; calling it twice is safe.
 */
export function installDialogHost(host: DialogHost): () => void {
  setDialogOpener((request) => openDialog(host, request))
  let disposed = false
  return () => {
    if (disposed) return
    disposed = true
    // Closing every overlay first means no listener or node outlives the host.
    // The overlays are mounted on document.body (see portalParent), not under
    // host.root, so this disposer is the ONLY thing that takes them off the
    // page — it must not be skipped.
    for (const overlay of [...stackFor(host.root)]) overlay.close()
    // Clearing with a no-op is safe: `requestDialog` no-ops without an opener.
    setDialogOpener(() => {})
  }
}