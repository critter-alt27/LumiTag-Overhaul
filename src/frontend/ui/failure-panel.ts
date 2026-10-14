/**
 * LumiTag failure report panel.
 *
 * A mutation here is never atomic: the backend exposes per-character tag writes
 * and nothing else, so a bulk operation that touches fifty characters can land
 * thirty-one of them and fail nineteen. This panel exists to make that visible
 * and recoverable — it reports exactly which **tag change** failed on exactly
 * which **character**, and it offers the three retries that make sense: one
 * change, one tag-change group, or everything still outstanding.
 *
 * ## Design rules
 *
 *  1. **Group by the tag change, not by the character.** In a bulk delete one
 *     character can fail both its `Elf` and its `Dark` removal; a
 *     character-level group would hide which tag actually needs retrying.
 *  2. **A mixed outcome is never reported as plain success or plain failure.**
 *     It reads "Partially completed", with both counts shown.
 *  3. **No stack trace, ever.** Only `MutationErrorInfo.message`, which the
 *     executor guarantees is a human sentence.
 *  4. **No atomicity is implied.** The panel states plainly that rollback and
 *     transactions are not supported by the underlying API.
 *  5. **Overlapping retries are impossible.** Every retry control for an
 *     operation is disabled while one of that operation's retries is in flight.
 *  6. **Reports are in-memory.** There is no storage API anywhere in
 *     `src/frontend/`, so the panel says the report is lost on close or reload
 *     rather than implying that it is persisted.
 *  7. **A truncated list is never silent.** At most {@link FAILURE_ROW_LIMIT}
 *     rows per group are rendered, and every truncation — rows and tag names —
 *     is stated in the visible text, because a capped list that looks complete
 *     is how a user concludes that a character they expected to see was never
 *     attempted. Truncation removes rows, never reachability: the group retry,
 *     "Retry All Remaining Failures" and the full summary all still cover every
 *     failure in the report, rendered or not.
 *
 * ## The two registers this panel keeps
 *
 * The panel answers two different kinds of question, and they are NOT the same
 * thing:
 *
 *  - **Ordinary feedback** — one operation that landed cleanly, or a report with
 *    nothing left to do. That is a single status-tinted line, the way the host
 *    renders an inline notice; it must not look like a data-loss event.
 *  - **The detailed report** — anything with outstanding failures. Grouping,
 *    the outcome sentence, per-row and per-group retry, the retry-all control,
 *    the truncation disclosure, the untruncated summary and the two honest
 *    statements about rollback and persistence.
 *
 * The detailed report is never collapsed into "something went wrong, try again",
 * and a partially successful operation is never reported as a success.
 *
 * ## Density
 *
 * The failure table is the host's `lt-table` (11.5px, 4px 8px cells, hairline
 * dividers, fixed layout so columns do not re-flow under a changing message),
 * inside `lt-failures__details` so a long table scrolls inside the docked region
 * instead of forcing the drawer sideways. Rows are hairline-separated and
 * badge-toned — `--danger` only for failures, `--warning` for work still
 * outstanding, `--success` for what landed — so a scan of the panel tells the
 * reader what happened before they read a word.
 *
 * Listener discipline: the panel attaches NO listener that outlives a render.
 * Every control is rebuilt from scratch each time, so its handler dies with
 * its node and a search keystroke cannot leak anything. The one long-lived
 * subscription is the store subscription, and `destroy()` releases it.
 */

import {
  failureDisplayName,
  groupFailures,
  summarizeReport,
  type FailureGroup,
  type MutationResult,
  type OperationReport,
} from '../mutations/report'
import type { TagManagerStore } from '../store'
import { badge, button, clear, el, emptyState, setBusy, spinner, text } from './dom'

// ---------------------------------------------------------------------------
// Presentation helpers
// ---------------------------------------------------------------------------

/**
 * Hard cap on eagerly rendered failure rows, per group.
 *
 * The whole panel is rebuilt from scratch on every store commit, and a failure
 * row is heavier than a character row — four cells, a retry button and its
 * listener. A 300-character bulk delete where every write fails would otherwise
 * rebuild 300 such rows on every progress emission, which on the Termux WebView
 * is what turns a report into an unresponsive panel. 300 mirrors
 * `characters-section`'s `ROW_LIMIT`: past that, a reader is not scrolling a
 * list to find one character anyway, they are reading the summary and
 * retrying — which the buttons above the table still do for every failure.
 */
const FAILURE_ROW_LIMIT = 300

/** How many tag names the header badge names before it counts the rest. */
const TAG_SUMMARY_LIMIT = 12

/** Human op names, used to build the group headings (`Merge: Mage → Magic`). */
const OP_LABELS: Record<string, string> = {
  assign: 'Assign',
  remove: 'Remove',
  rename: 'Rename',
  merge: 'Merge',
  delete: 'Delete',
}

function opLabel(op: string): string {
  return OP_LABELS[op] ?? op
}

function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : pluralForm}`
}

function characterCount(count: number): string {
  return plural(count, 'character')
}

/** The headline status. A mixed outcome reads "Partially completed". */
function statusText(report: OperationReport): string {
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

/** A `lt-failures--*` modifier. `pending`/`running` read as a warning. */
function statusModifier(report: OperationReport): string {
  if (report.status === 'pending' || report.status === 'running') return 'warning'
  return report.status
}

/**
 * One accurate sentence about what the operation actually did.
 *
 * This is the difference between "the panel knows" and "the panel shows a
 * number". Every branch is derived from the DERIVED totals, never from a
 * guess: a mixed outcome states both halves, and a run that attempted nothing
 * says so rather than reading like a silent success.
 */
function outcomeSentence(report: OperationReport): string {
  const totals = report.totals
  if (totals.total === 0) {
    return 'Nothing was attempted — the reason is in the operation name above.'
  }
  switch (report.status) {
    case 'succeeded':
      return `All ${characterCount(totals.total)} were updated.`
    case 'partially_completed':
      return `Partially completed: ${characterCount(totals.succeeded)} were updated and ${characterCount(totals.failed)} were not. Each failure is listed below with a retry control.`
    case 'failed':
      return `Nothing was applied. ${characterCount(totals.failed)} failed; the reason for each is listed below.`
    case 'running':
      return `Still running — ${characterCount(totals.succeeded)} of ${totals.total} updated so far.`
    default:
      return `Queued: ${characterCount(totals.total)} to update.`
  }
}

/**
 * A UI-safe error message.
 *
 * `MutationErrorInfo.message` is by contract a human sentence and never a stack
 * trace, so it is shown verbatim; the fallback only covers a result whose error
 * was somehow dropped.
 */
function errorMessage(result: MutationResult): string {
  const message = result.error?.message
  if (typeof message === 'string' && message.trim() !== '') return message
  return 'The change could not be saved. No reason was reported.'
}

/** True while any mutation of this operation is mid-retry. */
function hasRetryingResult(report: OperationReport): boolean {
  return report.results.some((r) => r.state === 'retrying')
}

/**
 * The tags a report touched, capped so a 200-tag merge cannot break the row.
 *
 * The `+N more` suffix is what keeps the cap honest: the badge never presents a
 * truncated tag list as the whole one.
 */
function tagSummary(report: OperationReport): string {
  if (report.tags.length === 0) return '—'
  const shown = report.tags.slice(0, TAG_SUMMARY_LIMIT)
  const rest = report.tags.length - shown.length
  return rest > 0 ? `${shown.join(', ')} +${rest} more` : shown.join(', ')
}

// ---------------------------------------------------------------------------
// Table rendering
// ---------------------------------------------------------------------------

/**
 * Column widths for the failure table.
 *
 * `lt-table` is `table-layout: fixed` — that is what stops the columns
 * re-flowing every time a backend message changes length and yanking rows out
 * from under the reader. Fixed layout also means the widths must be declared
 * somewhere, and `styles.ts` (which owns the table's geometry) has no
 * per-column rules to borrow, so they are carried by a `<colgroup>`: the
 * standard, cell-free way to size columns. The cells themselves carry no inline
 * style at all — padding, alignment, hairlines and density are the stylesheet's.
 */
const COLUMN_WIDTHS = ['20%', '26%', '38%', '16%'] as const

interface RowCallbacks {
  /** Busy = a retry for this operation is already in flight. */
  busy: boolean
  retryOne: (mutationId: string) => void
}

function renderFailureRow(failure: MutationResult, callbacks: RowCallbacks): HTMLElement {
  const tr = el('tr')
  const retrying = failure.state === 'retrying'

  // `failureDisplayName` keeps same-named characters distinguishable.
  const name = failureDisplayName(failure)
  const nameCell = el('th', { scope: 'row' })
  nameCell.appendChild(el('span', {}, [name]))
  tr.appendChild(nameCell)

  tr.appendChild(el('td', {}, [failure.intendedChange]))

  const errorCell = el('td', {})
  errorCell.appendChild(el('span', {}, [errorMessage(failure)]))
  if (failure.uncertain) {
    errorCell.appendChild(
      badge('outcome unknown — this change may already have been saved', {
        // An unknown outcome is a WARNING, not a failure: the write may have
        // landed. Retrying blindly is exactly what the caution is there to stop.
        tone: 'warning',
      }),
    )
  }
  if (failure.attempts > 1) {
    errorCell.appendChild(badge(`${failure.attempts} attempts`, { tone: 'muted' }))
  }
  tr.appendChild(errorCell)

  const actionCell = el('td', {})
  if (retrying) {
    actionCell.appendChild(
      button('Retrying…', {
        variant: 'default',
        disabled: true,
        busy: true,
        ariaLabel: `Retry in progress for ${name}`,
      }),
    )
  } else if (failure.retryable) {
    actionCell.appendChild(
      button('Retry', {
        variant: 'default',
        ariaLabel: `Retry "${failure.intendedChange}" for ${name}`,
        title: `Re-read ${name} from the server, then apply "${failure.intendedChange}" again`,
        disabled: callbacks.busy,
        onClick: () => callbacks.retryOne(failure.mutationId),
      }),
    )
  } else {
    // Non-retryable: say WHY, and do not offer a control that cannot work.
    const note = el('p', { class: 'lt-state__detail' })
    note.appendChild(text('Not retryable — '))
    note.appendChild(text(errorMessage(failure)))
    actionCell.appendChild(note)
  }
  tr.appendChild(actionCell)

  return tr
}

/**
 * One failure group as a real `<table class="lt-table">`.
 *
 * The heading is the SPECIFIC tag change, so two different removals are never
 * conflated. A collapsed multi-tag record names every source it removed, so the
 * group still says `Dark, Elf` rather than collapsing to one tag.
 *
 * The table rides inside `.lt-failures__details`, the horizontal scroll
 * wrapper: a four-column table would otherwise stretch the docked region and
 * push the whole drawer into a sideways scroll.
 */
function renderGroupTable(
  group: FailureGroup,
  callbacks: RowCallbacks & { retryGroup: (groupKey: string) => void },
): HTMLElement {
  const wrap = el('div', { class: 'lt-failure-group' })
  const retryable = group.failures.filter((f) => f.retryable)
  const uncertain = group.failures.filter((f) => f.uncertain).length

  const heading = el('div', { class: 'lt-row lt-row--wrap' })
  heading.appendChild(
    el('span', { class: 'lt-failure-group__label' }, [`${opLabel(group.op)}: ${group.label}`]),
  )
  // `--danger`, because this badge IS the state: a group exists only because
  // something failed. A neutral count here would make the panel read as routine.
  heading.appendChild(
    badge(plural(group.failures.length, 'failure'), { tone: 'danger' }),
  )
  // The secondary weight of the group, kept to one ellipsised line so a long
  // group heading cannot push its retry control off the row.
  const detailParts = [`${retryable.length} of ${group.failures.length} retryable`]
  if (uncertain > 0) detailParts.push(`${uncertain} outcome unknown`)
  heading.appendChild(
    el('span', { class: 'lt-failure-group__detail' }, [detailParts.join(' · ')]),
  )
  heading.appendChild(el('span', { class: 'lt-failures__spacer' }))

  const retryGroupLabel =
    retryable.length === 0
      ? 'Not retryable'
      : retryable.length === 1
        ? 'Retry this change'
        : `Retry ${retryable.length} failed`
  const retryGroupButton = button(retryGroupLabel, {
    variant: 'default',
    ariaLabel: `Retry the remaining failures for ${group.label}`,
    disabled: retryable.length === 0 || callbacks.busy,
    onClick: () => {
      if (callbacks.busy) return
      callbacks.retryGroup(group.key)
    },
  })
  if (retryable.length === 0) {
    retryGroupButton.title = 'None of these failures can be retried — see the reason on each row.'
  }
  heading.appendChild(retryGroupButton)
  wrap.appendChild(heading)

  const shown = Math.min(group.failures.length, FAILURE_ROW_LIMIT)
  const scroll = el('div', { class: 'lt-failures__details' })
  const table = el('table', { class: 'lt-table' })
  const group_ = el('colgroup')
  for (const width of COLUMN_WIDTHS) group_.appendChild(el('col', { style: `width:${width};` }))
  table.appendChild(group_)
  table.appendChild(
    el('caption', { class: 'lt-visually-hidden' }, [
      shown === group.failures.length
        ? `Failed ${opLabel(group.op).toLowerCase()} of ${group.label}, one row per character`
        : `Failed ${opLabel(group.op).toLowerCase()} of ${group.label}, the first ${shown} of ` +
          `${group.failures.length} failed characters. The rest are listed in the full summary and are ` +
          'still covered by the retry button above.',
    ]),
  )

  const thead = el('thead')
  const headRow = el('tr')
  for (const label of ['Character', 'Intended change', 'Error', 'Action']) {
    headRow.appendChild(el('th', { scope: 'col' }, [label]))
  }
  thead.appendChild(headRow)
  table.appendChild(thead)

  const tbody = el('tbody')
  for (const failure of group.failures.slice(0, shown)) {
    tbody.appendChild(
      renderFailureRow(failure, {
        busy: callbacks.busy || failure.state === 'retrying',
        retryOne: callbacks.retryOne,
      }),
    )
  }
  table.appendChild(tbody)
  scroll.appendChild(table)
  wrap.appendChild(scroll)

  if (shown < group.failures.length) {
    // The hidden rows are counted in `retryable`, so the group button above
    // still retries every one of them — the cap hides rows, never failures.
    wrap.appendChild(
      el('p', { class: 'lt-state__detail' }, [
        `Showing ${shown} of ${group.failures.length} failed characters. The ${group.failures.length - shown} not ` +
          `listed are still retried by “${retryGroupLabel}” and by “Retry All Remaining Failures”, and every one of ` +
          'them is named in the full summary below.',
      ]),
    )
  }

  return wrap
}

// ---------------------------------------------------------------------------
// Panel
// ---------------------------------------------------------------------------

export interface FailurePanelOptions {
  container: HTMLElement
  store: TagManagerStore
}

/**
 * Render the persistent result panel into `options.container`.
 *
 * Returns a `destroy()` that unsubscribes from the store, empties the
 * container and clears the in-flight bookkeeping. It is idempotent.
 */
export function renderFailurePanel(options: FailurePanelOptions): { destroy(): void } {
  const { container, store } = options

  let destroyed = false
  /** `null` forces the next render even when the store version is unchanged. */
  let lastVersion: number | null = null
  /** Operations with a retry in flight; blocks every other retry for it. */
  const busyOps = new Set<string>()
  /** A retry that threw, shown next to its operation. Never a stack trace. */
  const retryErrors = new Map<string, string>()
  /** opIds the user expanded, so a re-render never collapses their report. */
  const expanded = new Set<string>()

  /**
   * Run one retry behind a busy state.
   *
   * The operation is marked busy BEFORE awaiting and unmarked after, so a second
   * click on any other control for the same operation cannot start an
   * overlapping retry. A retry re-reads the character from the server before it
   * writes, which is what makes retrying a timed-out write safe — it goes
   * through the store action, never a replay of a snapshot taken at report time.
   */
  const runRetry = (opId: string, work: () => Promise<void>): void => {
    if (busyOps.has(opId)) return
    busyOps.add(opId)
    lastVersion = null
    render()
    void (async () => {
      try {
        await work()
      } catch (error) {
        retryErrors.set(
          opId,
          error instanceof Error && error.message !== ''
            ? error.message
            : 'The retry could not be started.',
        )
      } finally {
        busyOps.delete(opId)
        // The store may have produced an identical version (an empty retry), so
        // force the re-render rather than relying on the version bump.
        lastVersion = null
        render()
      }
    })()
  }

  const retryOne = (opId: string) => (mutationId: string): void => {
    retryErrors.delete(opId)
    runRetry(opId, () => store.actions.retryOne(opId, mutationId))
  }

  const retryGroup = (opId: string) => (groupKey: string): void => {
    retryErrors.delete(opId)
    runRetry(opId, () => store.actions.retryGroup(opId, groupKey))
  }

  const retryAll = (opId: string) => (): void => {
    retryErrors.delete(opId)
    runRetry(opId, () => store.actions.retryAll(opId))
  }

  /** The compact, status-tinted counts that sit at the top of every report. */
  const renderHeaderBadges = (report: OperationReport): HTMLElement => {
    const totals = report.totals
    const badges = el('div', { class: 'lt-failures__header' })
    badges.appendChild(el('p', { class: 'lt-failures__status' }, [statusText(report)]))
    badges.appendChild(badge(opLabel(report.op), { tone: 'default' }))
    badges.appendChild(badge(report.label, { tone: 'muted' }))
    badges.appendChild(el('span', { class: 'lt-failures__spacer' }))
    // `attempted` is an ordinary count: neutral. The status tones below are
    // reserved for the three things a reader must not have to hunt for.
    badges.appendChild(badge(`attempted ${totals.total}`, { tone: 'default' }))
    badges.appendChild(
      badge(`succeeded ${totals.succeeded}`, { tone: totals.succeeded > 0 ? 'success' : 'muted' }),
    )
    badges.appendChild(
      badge(`failed ${totals.failed}`, { tone: totals.failed > 0 ? 'danger' : 'muted' }),
    )
    badges.appendChild(
      badge(`remaining ${totals.remaining}`, {
        tone: totals.remaining > 0 ? 'warning' : 'muted',
      }),
    )
    badges.appendChild(badge(`tags: ${tagSummary(report)}`, { tone: 'muted' }))
    return badges
  }

  const renderReport = (report: OperationReport): HTMLElement => {
    const totals = report.totals
    const busy = busyOps.has(report.opId)
    const retrying = hasRetryingResult(report)
    const locked = busy || retrying
    const groups = groupFailures(report)
    const isOpen = expanded.has(report.opId)
    const inFlight = report.status === 'running' || report.status === 'pending'

    const box = el('section', {
      class: `lt-box lt-failures lt-failures--${statusModifier(report)}`,
      'aria-label': `${report.label}: ${statusText(report)}`,
    })
    // A live operation announces its own progress; a settled one is static
    // content the reader opted into, and re-announcing it on every store commit
    // would talk over them.
    if (inFlight) box.setAttribute('role', 'status')
    if (busy || retrying) box.setAttribute('aria-busy', 'true')

    // ---- Header: operation name, tags, and the derived counts -------------
    const header = renderHeaderBadges(report)
    header.appendChild(
      button(isOpen ? 'Hide details' : 'Show details', {
        variant: 'ghost',
        ariaLabel: `${isOpen ? 'Hide' : 'Show'} details for ${report.label}`,
        onClick: () => {
          if (isOpen) {
            expanded.delete(report.opId)
            store.actions.showReport(null)
          } else {
            expanded.add(report.opId)
            store.actions.showReport(report.opId)
          }
          lastVersion = null
          render()
        },
      }),
    )
    box.appendChild(header)

    // ---- The one-line outcome ---------------------------------------------
    // Always visible, whether or not the report is expanded: it is the accurate
    // summary of what the operation did, and hiding it behind a disclosure is how
    // "12 of 12 failed" ends up reading as "12 of 12 done".
    box.appendChild(
      el('p', { class: 'lt-dialog__desc', role: inFlight ? 'status' : null }, [
        outcomeSentence(report),
      ]),
    )

    if (!isOpen) return box

    const retryFailure = retryErrors.get(report.opId)
    if (retryFailure !== undefined) {
      box.appendChild(
        el('div', { class: 'lt-state lt-state--error', role: 'alert' }, [
          el('p', { class: 'lt-state__title' }, ['The retry did not run']),
          el('p', { class: 'lt-state__detail' }, [retryFailure]),
        ]),
      )
    }

    // ---- Work still in flight ---------------------------------------------
    if (inFlight) {
      box.appendChild(
        spinner(
          locked ? 'Retrying the failures below…' : 'Applying changes…',
        ),
      )
    }

    // ---- Retry everything still outstanding -------------------------------
    if (totals.remaining > 0) {
      const retryAllButton = button('Retry All Remaining Failures', {
        variant: 'primary',
        ariaLabel: `Retry all remaining failures of ${report.label}`,
        disabled: locked,
        onClick: retryAll(report.opId),
      })
      if (locked) setBusy(retryAllButton, true, 'Retrying…')

      const bar = el('div', { class: 'lt-failures__header' })
      bar.appendChild(retryAllButton)
      bar.appendChild(
        el('span', { class: 'lt-dialog__desc' }, [
          `${characterCount(totals.remaining)} still outstanding. Every character is re-read from the server before it is written again.`,
        ]),
      )
      box.appendChild(bar)
    }

    // ---- Failure groups, one per specific tag change ----------------------
    if (groups.length === 0) {
      box.appendChild(
        el('p', { class: 'lt-dialog__desc' }, [
          totals.total === 0
            ? 'Nothing was attempted — the reason is in the operation name above.'
            : 'No outstanding failures for this operation.',
        ]),
      )
    } else {
      const groupHost = el('div', { class: 'lt-failures__groups' })
      for (const group of groups) {
        groupHost.appendChild(
          renderGroupTable(group, {
            busy: locked,
            retryOne: retryOne(report.opId),
            retryGroup: retryGroup(report.opId),
          }),
        )
      }
      box.appendChild(groupHost)
    }

    // ---- The shared, verbatim summary -------------------------------------
    const details = el('details', { class: 'lt-dialog__desc' })
    details.appendChild(el('summary', {}, ['Full summary']))
    const pre = el('pre', { style: 'white-space:pre-wrap;' })
    pre.appendChild(text(summarizeReport(report)))
    details.appendChild(pre)
    box.appendChild(details)

    // ---- Honest statements about what the API does NOT support ------------
    box.appendChild(
      el('p', { class: 'lt-dialog__desc' }, [
        'Rollback and transactions are not supported by the underlying API: changes that already succeeded stay applied, so one operation is never all-or-nothing.',
      ]),
    )
    box.appendChild(
      el('p', { class: 'lt-dialog__desc' }, [
        'This report is kept in memory only — LumiTag stores nothing on disk, so it is lost when the extension is closed or reloaded. Copy anything you need from the full summary first.',
      ]),
    )

    const footer = el('div', { class: 'lt-failures__header' })
    footer.appendChild(
      button('Dismiss report', {
        variant: 'ghost',
        ariaLabel: `Dismiss the report for ${report.label}`,
        onClick: () => {
          busyOps.delete(report.opId)
          retryErrors.delete(report.opId)
          expanded.delete(report.opId)
          store.actions.dismissReport(report.opId)
        },
      }),
    )
    box.appendChild(footer)

    return box
  }

  /**
   * The ordinary case: nothing failed, so nothing is reported.
   *
   * An empty state, not an error box and not a table — there is no failure to
   * detail and no retry to offer, and inventing one would make the region look
   * permanently alarmed.
   */
  const renderNothingFailed = (): void => {
    container.appendChild(
      emptyState(
        'No failures',
        'Every tag change so far was applied in full. Anything that fails appears here with a retry control.',
      ),
    )
  }

  function render(): void {
    if (destroyed) return
    if (lastVersion !== null && lastVersion === store.version) return
    lastVersion = store.version
    clear(container)

    const reports = [...store.view.reports]
    if (reports.length === 0) {
      renderNothingFailed()
      return
    }

    // The active report first, then the most recent of the rest.
    const activeId = store.view.activeReportOpId
    const ordered = [
      ...reports.filter((r) => r.opId === activeId),
      ...reports.filter((r) => r.opId !== activeId).reverse(),
    ]
    for (const report of ordered) {
      if (report.opId === activeId) expanded.add(report.opId)
    }

    const host = el('div', { class: 'lt-failures__groups' })
    for (const report of ordered) host.appendChild(renderReport(report))
    container.appendChild(host)
  }

  const unsubscribe = store.subscribe(() => {
    render()
  })

  render()

  return {
    destroy: () => {
      if (destroyed) return
      destroyed = true
      unsubscribe()
      busyOps.clear()
      retryErrors.clear()
      expanded.clear()
      clear(container)
    },
  }
}