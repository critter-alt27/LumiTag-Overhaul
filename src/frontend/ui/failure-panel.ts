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
import { button, clear, el, emptyState, setBusy, text } from './dom'

// ---------------------------------------------------------------------------
// Presentation helpers
// ---------------------------------------------------------------------------

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

/** The tags a report touched, capped so a 200-tag merge cannot break the row. */
function tagSummary(report: OperationReport): string {
  if (report.tags.length === 0) return '—'
  const shown = report.tags.slice(0, 12)
  const rest = report.tags.length - shown.length
  return rest > 0 ? `${shown.join(', ')} +${rest} more` : shown.join(', ')
}

// ---------------------------------------------------------------------------
// Table rendering
// ---------------------------------------------------------------------------

const CELL_STYLE = 'text-align:left;vertical-align:top;padding:2px 6px;'

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
  const nameCell = el('th', { scope: 'row', style: CELL_STYLE })
  nameCell.appendChild(el('span', {}, [name]))
  tr.appendChild(nameCell)

  tr.appendChild(el('td', { style: CELL_STYLE }, [failure.intendedChange]))

  const errorCell = el('td', { style: CELL_STYLE })
  errorCell.appendChild(el('span', {}, [errorMessage(failure)]))
  if (failure.uncertain) {
    errorCell.appendChild(
      el('span', { class: 'lt-badge lt-badge--muted' }, [
        'outcome unknown — this change may already have been saved',
      ]),
    )
  }
  if (failure.attempts > 1) {
    errorCell.appendChild(
      el('span', { class: 'lt-badge lt-badge--muted' }, [`${failure.attempts} attempts`]),
    )
  }
  tr.appendChild(errorCell)

  const actionCell = el('td', { style: CELL_STYLE })
  if (retrying) {
    actionCell.appendChild(
      button('Retrying…', {
        variant: 'ghost',
        disabled: true,
        ariaLabel: `Retry in progress for ${name}`,
      }),
    )
  } else if (failure.retryable) {
    actionCell.appendChild(
      button('Retry', {
        variant: 'default',
        ariaLabel: `Retry "${failure.intendedChange}" for ${name}`,
        disabled: callbacks.busy,
        onClick: () => callbacks.retryOne(failure.mutationId),
      }),
    )
  } else {
    // Non-retryable: say WHY, and do not offer a control that cannot work.
    const note = el('span', { class: 'lt-dialog__desc' })
    note.appendChild(text('Not retryable — '))
    note.appendChild(text(errorMessage(failure)))
    actionCell.appendChild(note)
  }
  tr.appendChild(actionCell)

  return tr
}

/**
 * One failure group as a real `<table>`.
 *
 * The heading is the SPECIFIC tag change, so a failed `Elf` removal and a failed
 * `Dark` removal are never conflated — even when they belong to the same
 * character.
 */
function renderGroupTable(
  group: FailureGroup,
  callbacks: RowCallbacks & { retryGroup: (groupKey: string) => void },
): HTMLElement {
  const wrap = el('div', { class: 'lt-failure-group' })
  const retryable = group.failures.filter((f) => f.retryable)

  const heading = el('div', { class: 'lt-row lt-row--wrap' })
  heading.appendChild(
    el('span', { class: 'lt-failure-group__label' }, [`${opLabel(group.op)}: ${group.label}`]),
  )
  heading.appendChild(
    el('span', { class: 'lt-badge lt-badge--accent' }, [plural(group.failures.length, 'failure')]),
  )
  heading.appendChild(el('span', { class: 'lt-failures__spacer' }))

  const retryGroupButton = button(
    retryable.length === 0
      ? 'Not retryable'
      : retryable.length === 1
        ? 'Retry this change'
        : `Retry ${retryable.length} failed`,
    {
      variant: 'default',
      ariaLabel: `Retry the remaining failures for ${group.label}`,
      disabled: retryable.length === 0 || callbacks.busy,
      onClick: () => {
        if (callbacks.busy) return
        callbacks.retryGroup(group.key)
      },
    },
  )
  if (retryable.length === 0) {
    retryGroupButton.title = 'None of these failures can be retried — see the reason on each row.'
  }
  heading.appendChild(retryGroupButton)
  wrap.appendChild(heading)

  const table = el('table', { style: 'width:100%;border-collapse:collapse;' })
  table.appendChild(
    el('caption', { class: 'lt-visually-hidden' }, [
      `Failed ${opLabel(group.op).toLowerCase()} of ${group.label}, one row per character`,
    ]),
  )

  const thead = el('thead')
  const headRow = el('tr')
  for (const [label, width] of [
    ['Character', '20%'],
    ['Intended change', '26%'],
    ['Error', '38%'],
    ['Action', '16%'],
  ] as const) {
    headRow.appendChild(el('th', { scope: 'col', style: `${CELL_STYLE}width:${width};` }, [label]))
  }
  thead.appendChild(headRow)
  table.appendChild(thead)

  const tbody = el('tbody')
  for (const failure of group.failures) {
    tbody.appendChild(
      renderFailureRow(failure, {
        busy: callbacks.busy || failure.state === 'retrying',
        retryOne: callbacks.retryOne,
      }),
    )
  }
  table.appendChild(tbody)
  wrap.appendChild(table)

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
   * writes, which is what makes retrying a timed-out write safe.
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

  const renderReport = (report: OperationReport): HTMLElement => {
    const totals = report.totals
    const busy = busyOps.has(report.opId)
    const retrying = hasRetryingResult(report)
    const locked = busy || retrying
    const groups = groupFailures(report)
    const isOpen = expanded.has(report.opId)

    const box = el('section', {
      class: `lt-box lt-failures lt-failures--${statusModifier(report)}`,
      'aria-label': `${report.label}: ${statusText(report)}`,
    })

    // ---- Header: operation name, tags, and the derived counts -------------
    const header = el('div', { class: 'lt-failures__header' })
    header.appendChild(el('p', { class: 'lt-failures__status' }, [statusText(report)]))
    header.appendChild(el('span', { class: 'lt-badge' }, [opLabel(report.op)]))
    header.appendChild(el('span', { class: 'lt-badge lt-badge--muted' }, [report.label]))
    header.appendChild(el('span', { class: 'lt-failures__spacer' }))
    header.appendChild(el('span', { class: 'lt-badge' }, [`attempted ${totals.total}`]))
    header.appendChild(
      el('span', {
        class: totals.succeeded > 0 ? 'lt-badge lt-badge--accent' : 'lt-badge lt-badge--muted',
      }, [`succeeded ${totals.succeeded}`]),
    )
    header.appendChild(
      el('span', {
        class: totals.failed > 0 ? 'lt-badge lt-badge--accent' : 'lt-badge lt-badge--muted',
      }, [`failed ${totals.failed}`]),
    )
    header.appendChild(
      el('span', {
        class: totals.remaining > 0 ? 'lt-badge lt-badge--accent' : 'lt-badge lt-badge--muted',
      }, [`remaining ${totals.remaining}`]),
    )
    header.appendChild(
      el('span', { class: 'lt-badge lt-badge--muted' }, [`tags: ${tagSummary(report)}`]),
    )
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
    const pre = el('pre', { style: 'white-space:pre-wrap;margin:4px 0 0;' })
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

  function render(): void {
    if (destroyed) return
    if (lastVersion !== null && lastVersion === store.version) return
    lastVersion = store.version
    clear(container)

    const reports = [...store.view.reports]
    if (reports.length === 0) {
      container.appendChild(
        emptyState(
          'No failures',
          'Every tag change so far was applied in full. Anything that fails appears here with a retry control.',
        ),
      )
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