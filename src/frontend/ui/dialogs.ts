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
 * whatever opened it. At most `MAX_STACKED` overlays exist at once — the oldest
 * is closed when a third is requested, mirroring the host's own limit.
 *
 * ## Where a dialog is mounted, and what this module owns
 *
 * Mounting, the backdrop, the Escape/Tab contract, focus return, the scroll
 * lock and the close control all live in `dialog-host.ts`, which ports
 * `ModalShell.tsx`. Overlays mount on `document.body`, never inside the host's
 * drawer tab panel: a transformed, isolated or contained ancestor becomes the
 * containing block for its `position: fixed` descendants, so an in-drawer
 * overlay sized itself against the drawer instead of the viewport and every
 * dialog rendered visibly off-centre on a phone. See `portalParent` there for
 * the full reasoning — do not "simplify" it back.
 *
 * This module owns the CONTENT: what each dialog says, which fields it keeps,
 * and which control performs the store action.
 *
 * ## Visual contract
 *
 * Adapted from `ModalShell.module.css` / `ConfirmationModal.module.css` and
 * carried entirely by `styles.ts`:
 *
 *  - one `.lt-dialog` shell at 560px; a plain confirmation is narrowed to the
 *    host's 420px;
 *  - title 16px/600, description muted 12px, body 12px with a 14px rhythm;
 *  - footer actions right-aligned, `.lt-btn--primary` for the affirmative and
 *    `.lt-btn--danger` for the destructive one, `.lt-btn` (the host's default
 *    outline: subtle fill + hairline + inset highlight) for Cancel and Back;
 *  - ≤480px the actions stack `column-reverse`, which `styles.ts` already does.
 *
 * Review dialogs (merge, bulk assign/unassign, delete) deliberately keep their
 * own tables and lists instead of being flattened into a generic confirmation:
 * a review that cannot show WHAT will change is not a review.
 */

import { classifyError } from '../mutations/executor'
import { validateNewTagName, validateRenameTarget } from '../mutations/planner'
import { summarizeReport, type OperationReport } from '../mutations/report'
import { type SearchHelpSection } from '../search/search-help'
import type { TagManagerStore, StoreView } from '../store'
import { tagKey, type TagEntry } from '../tag-index'
import {
  clearDialogOpener,
  closeAllOverlays,
  openOverlay,
  portalParent,
  setActions,
  setDialogOpener,
  type OverlayHandle,
} from './dialog-host'
import {
  badge,
  button,
  checkbox,
  clear,
  el,
  field,
  on,
  row,
  searchFieldOf,
  searchInput,
  setBusy,
  setDisabled,
  text,
} from './dom'
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
// Review tables
// ---------------------------------------------------------------------------

/**
 * How many rows a review table renders before it says so.
 *
 * 200 matches `cappedList`'s cap, so a tabulated review can never become slower
 * to read than the line list it replaced. The overflow is always disclosed —
 * see {@link truncationNote} — and, as before, every tag past the cap is still
 * counted in the totals, named in the confirm message, and passed whole to the
 * store action. The cap hides rows, never reachability.
 */
const REVIEW_ROW_LIMIT = 200

/**
 * Column widths for a review table.
 *
 * `.lt-table` is `table-layout: fixed`, which is what stops the columns
 * re-flowing every time a message changes length. That also means the widths
 * have to be declared, and `styles.ts` (which owns the table's geometry) has no
 * per-column rules to borrow, so they are carried by a `<colgroup>`: the
 * standard, cell-free way to size columns. Nothing else about the table is
 * styled here — padding, hairlines, density and header weight are all the
 * stylesheet's.
 */
function columnWidths(table: HTMLElement, widths: readonly string[]): void {
  const group = el('colgroup')
  for (const width of widths) group.appendChild(el('col', { style: `width:${width};` }))
  table.appendChild(group)
}

/**
 * A real `<table class="lt-table">` for a dialog that has to REVIEW something.
 *
 * The merge, delete and bulk reviews are not confirmations with a sentence in
 * them: they exist so the reader can check WHICH records change and HOW MANY.
 * A list of identical lines cannot show that, and forcing them into the host's
 * 420px confirmation shape would delete the only reason they exist.
 *
 * `headings` is `[[label, width], …]`; `rows` is a list of cell contents, each
 * either a string or a pre-built element (a badge, a strong name). User strings
 * always arrive as `Text` via `text()`/`el()` — never as markup.
 */
function reviewTable(
  headings: readonly (readonly [string, string])[],
  rows: readonly (readonly (string | Node)[])[],
): HTMLElement {
  const table = el('table', { class: 'lt-table' })
  columnWidths(
    table,
    headings.map(([, width]) => width),
  )

  const thead = el('thead')
  const headRow = el('tr')
  for (const [label] of headings) {
    headRow.appendChild(el('th', { scope: 'col' }, [label]))
  }
  thead.appendChild(headRow)
  table.appendChild(thead)

  const tbody = el('tbody')
  for (const cells of rows) {
    const tr = el('tr')
    for (const [index, cell] of cells.entries()) {
      // The first column names the row, so it is a row header — the same
      // `th[scope="row"]` convention the failure table uses.
      const cell_ = index === 0
        ? el('th', { scope: 'row' }, [cell as string | Node])
        : el('td', {}, [cell as string | Node])
      tr.appendChild(cell_)
    }
    tbody.appendChild(tr)
  }
  table.appendChild(tbody)

  // `.lt-dialog__list` is the dialog's scroll container (240px, contained
  // overscroll); the table rides inside it so a long review scrolls instead of
  // pushing the footer off screen.
  const scroll = el('div', { class: 'lt-dialog__list' })
  scroll.appendChild(table)
  return scroll
}

/**
 * A cap disclosure for a review list that is longer than what is rendered.
 *
 * A capped list that looks complete is how a reader concludes a tag was never
 * considered, so the overflow is always stated in visible text — the same rule
 * the failure report follows.
 */
function truncationNote(shown: number, total: number, noun: string): HTMLElement {
  return el('p', { class: 'lt-dialog__desc' }, [
    `Showing ${shown} of ${total} ${noun}. The remaining ${total - shown} are not listed here, but they are all included in the action that follows.`,
  ])
}

/** A UI-safe message for anything thrown by a store action. Never a stack trace. */
function safeMessage(error: unknown, fallback: string): string {
  try {
    const message = classifyError(error).message.trim()
    return message === '' ? fallback : message
  } catch {
    return fallback
  }
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
    // `narrow` is the host's own split: `ConfirmationModal` renders inside
    // `ModalShell maxWidth={420}`, so a two-line message with two buttons gets
    // the 420px confirmation shell, not the 560px form/review shell.
    const fallback = openOverlay(host.root, title, undefined, { narrow: true })
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
    // Watch the PORTAL, not the drawer tab root. The overlay is mounted on
    // document.body (see `portalParent`), so a childList change in the tab root
    // says nothing about whether it is still open — and must NOT be read as a
    // dismissal, or every unrelated re-render would silently cancel the
    // confirm.
    observer.observe(portalParent(host.root), { childList: true })
    setActions(
      fallback,
      button('Cancel', {
        // The host's cancel is its DEFAULT button: subtle fill, one hairline,
        // inset highlight — not a borderless ghost, which reads as "nothing
        // happens here" next to a filled confirm.
        variant: 'default',
        onClick: () => {
          settle(false)
          fallback.close()
        },
      }),
      button(options.confirmLabel ?? 'Confirm', {
        // Only a destructive confirmation gets the danger treatment; an
        // additive one (create, assign) must not be painted as a deletion.
        variant: options.variant === 'danger' ? 'danger' : 'primary',
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
    // `.lt-dialog pre` already supplies the mono face, the fill and the radius;
    // only the wrapping is added here, because the summary is a multi-line block
    // and `pre` would otherwise scroll it sideways.
    const pre = el('pre', { style: 'white-space:pre-wrap;' })
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
 * EVERY footer control is disabled for the whole call, not just the confirm
 * one: the host's `ConfirmationModal` does the same (`cancelBtn` and
 * `confirmBtn` both take `disabled={loading}`), because a live Back/Cancel
 * beside a running write is a conflicting action and the reader must not be
 * able to navigate away from an operation that is mid-flight. The confirm
 * control additionally goes busy — `aria-busy`, `.lt-btn--loading` and a
 * "Applying…" label — so the state is announced rather than merely greyed.
 *
 * Escape and the backdrop are deliberately left working, unlike the host's
 * `closeOnEscape={!loading}`: LumiTag's writes are idempotent per mutation, the
 * panel below reports whatever lands whether or not the dialog is still open,
 * and an overlay that cannot be dismissed is a worse failure than an in-flight
 * write the reader walks away from. Closing never performs an action.
 */
async function runAction(
  handle: OverlayHandle,
  control: HTMLButtonElement,
  action: () => Promise<void>,
  context: string,
  store: TagManagerStore,
): Promise<void> {
  if (control.disabled) return
  // Snapshot the footer's prior enabled state so a control that was already
  // disabled (an unready merge, an empty selection) stays disabled afterwards.
  const footer = [...handle.actions.children].filter(
    (node): node is HTMLButtonElement => node instanceof HTMLButtonElement,
  )
  const prior = footer.map((node) => [node, node.disabled] as const)
  for (const node of footer) setDisabled(node, true)

  setBusy(control, true, 'Applying…')
  handle.showMessage('info', '')
  try {
    await action()
  } catch (error) {
    handle.showMessage('error', safeMessage(error, 'The operation could not be started.'))
  } finally {
    setBusy(control, false)
    for (const [node, wasDisabled] of prior) {
      if (!wasDisabled) setDisabled(node, false)
    }
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
    host.root,
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

  /** The characters the picker's current search term actually leaves visible. */
  const matching = (): StoreView['characters'] =>
    characters().filter((c) => matchesTerm(c.name, c.id))

  const renderPicker = (): void => {
    clear(pickerList)
    const rows = characters()
    const matches = matching()
    if (matches.length === 0) {
      pickerList.appendChild(
        el('p', { class: 'lt-dialog__desc' }, [
          rows.length === 0
            ? 'No characters are loaded yet. Refresh and try again.'
            : 'No character matches this search.',
        ]),
      )
    }
    for (const character of matches) {
      const line = el('div', { class: 'lt-row lt-row--wrap' })
      // `dom.checkbox` is the native input with `accent-color`, and its listener
      // is registered against the node — so `clear(pickerList)` above releases
      // it. Hand-rolling the input here is what used to leak one `change`
      // handler per re-render of the picker.
      const box = checkbox(selected.has(character.id), `Assign ${character.name || character.id}`, (checked) => {
        if (checked) selected.add(character.id)
        else selected.delete(character.id)
        renderCounts()
      })
      line.appendChild(box)
      line.appendChild(el('span', { class: 'lt-row--grow' }, [character.name || character.id]))
      if (character.tags.length > 0) {
        line.appendChild(
          badge(`${character.tags.length} tag${character.tags.length === 1 ? '' : 's'}`, {
            // A count of existing associations is metadata, never a state, so
            // it stays neutral.
            tone: 'muted',
          }),
        )
      }
      pickerList.appendChild(line)
    }
  }

  const renderCounts = (): void => {
    clear(pickerCount)
    pickerCount.appendChild(
      row(
        el('span', { class: 'lt-dialog__desc' }, [
          text(`${selected.size} of ${characters().length} selected`),
        ]),
        el('span', { class: 'lt-dialog__desc' }, [
          text(matching().length === characters().length
            ? 'Showing every loaded character.'
            : `Filtered to ${matching().length} of ${characters().length}.`),
        ]),
      ),
    )
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
        button('Cancel', { variant: 'default', onClick: () => handle.close() }),
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
      button('Back', { variant: 'default', onClick: () => renderForm() }),
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

    // `dom.searchInput` builds the host's SearchField: a subtle-filled, hairline
    // pill with the dimmed 14px leading icon, a borderless 13px input and a clear
    // control that appears only when there is something to clear. The bare
    // `.lt-search` this replaces had none of that — inside a dialog it fell back
    // to the standalone slab rule, with no icon and no clear affordance.
    const pickerSearch = searchInput('Search characters to assign', '', (value) => {
      searchTerm = value
      renderPicker()
      renderCounts()
    })
    // `field()` places the registered wrapper — the whole pill, leading icon and
    // clear control included — inside the `<label>`, so the control keeps its
    // accessible name AND renders as the native `SearchField` instead of a bare
    // `.lt-search` slab.
    const searchPill = searchFieldOf(pickerSearch)
    const pickerSearchField = field('Characters', pickerSearch, undefined)
    if (searchPill !== null && !pickerSearchField.contains(searchPill)) {
      // `field()` nests a registered wrapper itself; this only fires if the
      // accessor and the field registry ever disagree, and puts the pill back
      // rather than rendering an unadorned input.
      pickerSearchField.appendChild(searchPill)
    }

    pickerCount = el('div', { class: 'lt-dialog__desc' })
    // Class only: `.lt-dialog__list` already carries the dialog's scroll
    // container (max-height, `overflow-y`, contained overscroll), so the picker
    // does not restate its height inline and outrank the stylesheet.
    pickerList = el('div', { class: 'lt-dialog__list' })

    const picker = el('div')
    picker.appendChild(pickerSearchField)
    picker.appendChild(pickerCount)
    picker.appendChild(pickerList)
    picker.appendChild(
      row(
        button('Select all shown', {
          variant: 'default',
          title: 'Tick every character the current search leaves visible',
          onClick: () => {
            for (const c of matching()) selected.add(c.id)
            renderPicker()
            renderCounts()
          },
        }),
        button('Clear selection', {
          variant: 'default',
          title: 'Untick every character',
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
      button('Cancel', { variant: 'default', onClick: () => handle.close() }),
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
    host.root,
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
      button('Back', { variant: 'default', onClick: () => renderForm() }),
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
      button('Cancel', { variant: 'default', onClick: () => handle.close() }),
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
    host.root,
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

  const wrap = el('div')
  const headline = el('div', { class: 'lt-dialog__summary' })
  headline.appendChild(
    el('p', {}, [el('strong', {}, [`Primary tag: ${primaryName === '' ? '(none selected)' : primaryName}`])]),
  )
  headline.appendChild(
    el('p', { class: 'lt-dialog__desc' }, [
      `${characterCount(affected())} will be updated: each gains "${primaryName}" where it is missing, and the tags merged in are removed from them.`,
    ]),
  )
  wrap.appendChild(headline)

  // A merge is a list of NAMED records with a real per-record weight, so it is
  // a table and not a stack of identical lines: the reader's question is "which
  // tag disappears and how many characters does that touch", and two columns
  // answer it where a sentence cannot.
  const rows = targetKeys.slice(0, REVIEW_ROW_LIMIT).map((key): (string | Node)[] => {
    const name = displayName(view().tagIndex, key)
    const count = view().tagIndex.byKey.get(key)?.count ?? 0
    return [name, badge(count === 0 ? 'no assignments' : characterCount(count), { tone: count === 0 ? 'muted' : 'default' })]
  })
  wrap.appendChild(
    reviewTable(
      [
        [`Tags merged in (${targetNames.length})`, '64%'],
        ['Characters', '36%'],
      ],
      rows,
    ),
  )
  if (targetKeys.length > REVIEW_ROW_LIMIT) {
    wrap.appendChild(truncationNote(REVIEW_ROW_LIMIT, targetKeys.length, 'tags merged in'))
  }

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
    button('Cancel', { variant: 'default', onClick: () => handle.close() }),
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
    host.root,
    tags.length === 1 ? `Delete "${tags[0] ?? ''}"` : `Delete ${tags.length} tags`,
    'Tag associations are removed from the characters below. No characters are deleted.',
  )

  const countFor = (name: string): number => store.view.tagIndex.byKey.get(tagKey(name))?.count ?? 0
  const totalFor = (names: readonly string[]): number =>
    names.reduce((sum, name) => sum + countFor(name), 0)

  /**
   * The tags being removed, each with its REAL assignment count.
   *
   * This is the whole point of the dialog: "delete 3 tags" says nothing about
   * whether that touches 3 characters or 30,000. The count is read from the
   * index on every render, so a stale-preview refresh shows the current numbers
   * rather than the ones the dialog opened with.
   */
  const renderList = (names: readonly string[]): HTMLElement => {
    const shown = names.slice(0, REVIEW_ROW_LIMIT)
    const rows = shown.map((name): (string | Node)[] => {
      const count = countFor(name)
      return [
        name,
        badge(count === 0 ? 'no assignments' : characterCount(count), {
          // "No assignments" is a fact about the tag, not an error; it stays
          // muted so a real count never has to compete with it.
          tone: count === 0 ? 'muted' : 'default',
        }),
      ]
    })
    if (names.length === 0) {
      return el('p', { class: 'lt-dialog__desc' }, ['(no tags selected)'])
    }
    const block = el('div')
    block.appendChild(
      reviewTable(
        [
          [tags.length === 1 ? 'Tag' : 'Tags', '62%'],
          ['Assignments', '38%'],
        ],
        rows,
      ),
    )
    if (names.length > shown.length) {
      block.appendChild(truncationNote(shown.length, names.length, 'tags'))
    }
    return block
  }

  const listHost = el('div')
  const wrap = el('div')
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
    button('Cancel', { variant: 'default', onClick: () => handle.close() }),
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
    host.root,
    'Review assignment',
    'Assignment only ever adds tags. It never removes a tag a character already has.',
  )

  const tagNames = store.view.selectedAssignTagKeys.map((key) =>
    displayName(store.view.tagIndex, key),
  )
  const characterIds = [...store.view.selectedCharacterIds]
  const nameFor = (id: string): string =>
    store.view.characters.find((c) => c.id === id)?.name || id

  const wrap = el('div')
  // The tags get a real table: each one carries the number of characters it is
  // on, and "3 tags" without that weight is exactly the ambiguity this review
  // exists to remove. The characters stay a list — they have no per-row
  // attribute worth a column, and a list of names reads faster than a one-cell
  // table.
  const tagRows = tagNames.slice(0, REVIEW_ROW_LIMIT).map((name): (string | Node)[] => {
    const count = store.view.tagIndex.byKey.get(tagKey(name))?.count ?? 0
    return [name, badge(characterCount(count), { tone: 'default' })]
  })
  const tagBlock = el('div')
  tagBlock.appendChild(
    reviewTable(
      [
        [`Tags (${tagNames.length})`, '64%'],
        ['Characters already tagged', '36%'],
      ],
      tagRows,
    ),
  )
  if (tagNames.length > REVIEW_ROW_LIMIT) {
    tagBlock.appendChild(truncationNote(REVIEW_ROW_LIMIT, tagNames.length, 'tags'))
  }
  wrap.appendChild(tagBlock)

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
    button('Cancel', { variant: 'default', onClick: () => handle.close() }),
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
    host.root,
    'Review unassignment',
    'Unassignment only ever removes the tags below, and only from the selected characters.',
  )

  const tagNames = store.view.selectedAssignTagKeys.map((key) =>
    displayName(store.view.tagIndex, key),
  )
  const characterIds = [...store.view.selectedCharacterIds]
  const nameFor = (id: string): string =>
    store.view.characters.find((c) => c.id === id)?.name || id

  const wrap = el('div')
  const tagRows = tagNames.slice(0, REVIEW_ROW_LIMIT).map((name): (string | Node)[] => [
    name,
    badge(characterCount(store.view.tagIndex.byKey.get(tagKey(name))?.count ?? 0), {
      tone: 'default',
    }),
  ])
  const tagBlock = el('div')
  tagBlock.appendChild(
    reviewTable(
      [
        [`Tags to remove (${tagNames.length})`, '64%'],
        ['Characters carrying it', '36%'],
      ],
      tagRows,
    ),
  )
  if (tagNames.length > REVIEW_ROW_LIMIT) {
    tagBlock.appendChild(truncationNote(REVIEW_ROW_LIMIT, tagNames.length, 'tags'))
  }
  wrap.appendChild(tagBlock)
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
    button('Cancel', { variant: 'default', onClick: () => handle.close() }),
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

/**
 * One help section: a small-caps heading and a syntax → meaning list.
 *
 * The syntax token is a real `<code>` (`.lt-dialog code` gives it the mono face,
 * the subtle fill and the `overflow-wrap` that keeps `T:Elf` from widening the
 * dialog), and the meaning sits in its own column rather than after an em dash,
 * so a long description wraps beside its own text instead of trailing the token.
 */
function renderHelpSection(section: SearchHelpSection): HTMLElement {
  const wrap = el('div', { class: 'lt-box' })
  wrap.appendChild(el('h4', { class: 'lt-dialog__title' }, [section.title]))
  const list = el('div', { class: 'lt-list' })
  for (const entry of section.entries) {
    const line = el('div', { class: 'lt-row lt-row--wrap' })
    line.appendChild(el('code', {}, [entry.syntax]))
    line.appendChild(el('span', { class: 'lt-dialog__desc lt-row--grow' }, [entry.description]))
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
 *
 * This is the one dialog that is a REFERENCE rather than a form, so it keeps the
 * full syntax listing rather than being narrowed to the confirmation shell:
 * `.lt-dialog__body` is the scroll container, the sections stack inside it with
 * the box rhythm, and the footer keeps a single Close control.
 */
function openSearchHelp(host: DialogHost, context: 'tags' | 'characters'): void {
  const handle = openOverlay(
    host.root,
    context === 'tags' ? 'Search help — Tags' : 'Search help — Characters',
    'The search syntax is the same everywhere in LumiTag.',
  )

  const wrap = el('div', { class: 'lt-box' })
  for (const section of host.store.actions.searchHelp(context)) {
    wrap.appendChild(renderHelpSection(section))
  }

  if (context === 'tags') {
    const note = el('div', { class: 'lt-box' })
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
    // The overlays are mounted on document.body (see `portalParent`), not under
    // host.root, so this disposer is the ONLY thing that takes them off the
    // page — it must not be skipped. Closing also releases the body scroll lock
    // and returns focus to whatever opened each dialog.
    closeAllOverlays(host.root)
    // `requestDialog` then no-ops again, rather than routing a late click at a
    // store that is being torn down.
    clearDialogOpener()
  }
}