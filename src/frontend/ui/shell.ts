/**
 * LumiTag app shell.
 *
 * Owns everything that is NOT a section: the header, the Tags/Characters tab
 * strip, the shared search-help control, and the persistent failure-report
 * region. The sections themselves and the failure panel are injected by
 * `ShellOptions`, so this module never imports them and the sections can be
 * developed against the store contract independently.
 *
 * ## Listener discipline
 *
 * The shell renders on every store change, so a naive `addEventListener` per
 * render would leak one listener per keystroke. Instead the shell keeps a
 * single set of disposers, rebuilds them on each render, and tears the previous
 * set down first. `destroy()` clears them and empties the root.
 *
 * ## Scroll preservation
 *
 * The shell REBUILDS the whole subtree on every commit, and the scrolling
 * container (`.lt-app__body`) is part of that subtree — so the browser starts
 * each render from `scrollTop === 0`. That is the "it jumps back to the top of
 * the tab when I open a tag" report: `toggleTagExpanded` commits, the list is
 * replaced, and the offset is gone. See `restoreScroll` in `render()` for how
 * the offset is carried across.
 */

import type { TagManagerStore, StoreView } from '../store'
import {
  button,
  clear,
  el,
  emptyState,
  errorState,
  on,
  setBusy,
  spinner,
  text,
} from './dom'

/**
 * A request to open one of the extension's dialogs.
 *
 * This discriminated union is the ENTIRE contract between the shell and the
 * dialogs module: the shell decides *when* something must be confirmed, the
 * dialogs module decides *how* it looks and performs the store action.
 */
export type DialogRequest =
  | { kind: 'create_tag' }
  | { kind: 'rename_tag'; tag: string }
  | { kind: 'merge_review' }
  | { kind: 'delete_tags'; tags: string[] }
  | { kind: 'bulk_assign_review' }
  | { kind: 'bulk_unassign_review' }
  | { kind: 'search_help'; context: 'tags' | 'characters' }

export interface ShellOptions {
  root: HTMLElement
  store: TagManagerStore
  /** Render the Tags section into the given container. */
  renderTagsSection: (container: HTMLElement) => void
  /** Render the Characters section into the given container. */
  renderCharactersSection: (container: HTMLElement) => void
  /** Render the persistent failure report panel. */
  renderFailurePanel: (container: HTMLElement) => void
  /** Open a dialog by kind. Implemented by the dialogs module. */
  openDialog: (request: DialogRequest) => void
  /** Search help popover content. */
  onShowSearchHelp: (context: 'tags' | 'characters') => void
}

const SECTIONS = [
  { id: 'tags', label: 'Tags' },
  { id: 'characters', label: 'Characters' },
] as const

/** `HH:MM:SS` in the user's locale, or a dash before the first load. */
function formatTime(at: number | null): string {
  if (at === null) return 'never'
  try {
    return new Date(at).toLocaleTimeString()
  } catch {
    return new Date(at).toISOString().slice(11, 19)
  }
}

function countLabel(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`
}

/**
 * Mount the shell into `options.root`.
 *
 * Returns a `destroy()` that removes every listener this shell created and
 * empties the root. It is idempotent, so calling it twice is safe.
 */
export function renderShell(options: ShellOptions): { destroy(): void } {
  const { root, store } = options

  /** Disposers for the CURRENT render. Replaced wholesale on every render. */
  let disposers: (() => void)[] = []
  let destroyed = false
  let lastVersion = -1
  /** Section shown by the PREVIOUS render, so a tab switch can reset the scroll. */
  let lastSection: StoreView['section'] | null = null

  /** Container refs, recreated each render so listeners die with the DOM. */
  let sectionHost: HTMLElement | null = null
  let failureHost: HTMLElement | null = null
  let refreshButton: HTMLButtonElement | null = null
  let tabButtons: HTMLButtonElement[] = []

  const track = (dispose: () => void): void => {
    disposers.push(dispose)
  }

  const teardownListeners = (): void => {
    for (const dispose of disposers) {
      try {
        dispose()
      } catch {
        // A failing disposer must not prevent the rest from being released.
      }
    }
    disposers = []
  }

  /**
   * Put `body` back at `top`, clamped to what it can actually hold.
   *
   * Assigning a `scrollTop` past the end of the content is silently coerced to
   * the maximum by the engine, so the raw value looks "restored" in a debug
   * read while the user is silently parked somewhere they never asked for. The
   * case is real here — a narrower filter, a collapsed row, or a panel-level
   * error state can all leave the new content shorter than the old — so the
   * clamp is explicit rather than left to the browser.
   */
  const restoreScroll = (top: number, body: HTMLElement): void => {
    if (top <= 0) return
    const max = Math.max(0, body.scrollHeight - body.clientHeight)
    // Don't jump downward: only restore if computed offset doesn't exceed previous top.
    const clamped = max > 0 ? Math.min(top, max) : 0
    body.scrollTop = Math.max(0, clamped)
  }

  /**
   * Rebuild the whole panel.
   *
   * ------------------------------------------------------------------
   * LOAD-BEARING: four protections below keep typing and scrolling stable
   * across a rebuild that throws the entire DOM away. They are heavily tested
   * behaviour, not incidental code, and a visual restyle must not reorder,
   * merge or "simplify" them:
   *
   *   1. FOCUS CAPTURE (step 1) + FOCUS RESTORE (step 9) — the reader must not
   *      lose focus or their caret when a search commit rebuilds the panel.
   *   2. SCROLL CAPTURE (step 3) + SCROLL RESTORE (step 7), including the
   *      "never jump downward" guard and the clamping helper.
   *   3. THE TAB-SWITCH SKIP (step 4) — a section switch deliberately discards
   *      the previous offset and does not restore focus.
   *   4. THE NO-OP SKIP (step 2) — `store.version` gates every rebuild.
   * ------------------------------------------------------------------
   */
  const render = (): void => {
    if (destroyed) return
    const view = store.view

    // (1) Remember focus on the two primary search fields before the shell
    // replaces the DOM. Section-level restoration handles many cases, but the
    // shell owns the actual detach/rebuild and can reliably restore focus after
    // the new section is attached.
    const active = root.ownerDocument.activeElement
    const activeSearch = active instanceof HTMLInputElement && (
      (view.section === 'tags' && active.matches('input.lt-search')) ||
      (view.section === 'characters' && active.matches('input[data-lt-search="characters"]'))
    ) ? {
      selector: view.section === 'tags' ? 'input.lt-search' : 'input[data-lt-search="characters"]',
      start: active.selectionStart ?? active.value.length,
      end: active.selectionEnd ?? active.value.length,
      direction: active.selectionDirection ?? 'none',
    } : null

    // (4) Skip a no-op re-render. `commit()` only bumps the version on a real
    // change, so this is exact rather than a heuristic.
    if (store.version === lastVersion) return
    lastVersion = store.version

    // (2) Read the offset off the PREVIOUS render's body, before `clear()` throws
    // that element away: the replacement starts life at 0 and there is no
    // browser-level memory of where the user was. The anchor is the first
    // row-ish element of the OLD body; its distance from the viewport top is
    // what lets the new body put that same element back under the same pixels.
    const previousTop = sectionHost !== null ? sectionHost.scrollTop : 0
    let previousAnchorOffset = 0
    if (sectionHost !== null) {
      const anchorSelectors = ['.lt-tag-row', '.lt-state', '.lt-box', '.lt-character-row']
      for (const sel of anchorSelectors) {
        const el = sectionHost.querySelector(sel) as HTMLElement | null
        if (el) {
          previousAnchorOffset = el.offsetTop - sectionHost.scrollTop
          break
        }
      }
    }

    // (3) Switching tabs replaces the content wholesale with something unrelated,
    // so the offset from the previous tab is meaningless there and the new tab
    // should start at its own top. Every OTHER re-render — filtering, sorting,
    // expanding, selecting in bulk/merge mode — keeps the offset.
    const switchedSection = lastSection !== null && lastSection !== view.section
    lastSection = view.section

    teardownListeners()
    clear(root)

    // root (tab.root) already carries .lt-app from app.ts; don't nest.
    //
    // Hierarchy (overhaul.txt §4): a compact panel heading carrying the status it
    // genuinely has, then the Tags/Characters navigation, then the section —
    // which owns search, sorting, actions, results and pagination — and finally
    // the docked failure region. Search deliberately stays inside the sections:
    // each one owns its own focus/caret intent and debounce timer, and hoisting
    // the input up here would strand both.
    root.appendChild(renderHeader(view))
    root.appendChild(renderNav(view))

    sectionHost = el('div', { class: 'lt-app__body' })
    root.appendChild(sectionHost)
    renderSection(view, sectionHost)

    failureHost = el('div', { class: 'lt-app__failure-region' })
    root.appendChild(failureHost)
    options.renderFailurePanel(failureHost)

    // (2) The body is populated and attached now, so `scrollHeight` is meaningful
    // and the clamp can be computed rather than guessed. The `computed <=
    // previousTop` guard is what makes restoration one-directional: content that
    // grew ABOVE the fold (a row opening, a filter clearing) must never yank the
    // reader further down the list.
    if (!switchedSection && sectionHost !== null) {
      const newAnchorSelectors = ['.lt-tag-row', '.lt-state', '.lt-box', '.lt-character-row']
      let newAnchorTop = 0
      let foundAnchor = false
      for (const sel of newAnchorSelectors) {
        const el = sectionHost.querySelector(sel) as HTMLElement | null
        if (el) {
          newAnchorTop = el.offsetTop
          foundAnchor = true
          break
        }
      }
      if (foundAnchor) {
        const computed = previousTop - previousAnchorOffset + newAnchorTop
        if (computed <= previousTop) {
          restoreScroll(computed, sectionHost)
        } else {
          restoreScroll(previousTop, sectionHost)
        }
      } else {
        restoreScroll(previousTop, sectionHost)
      }
    }

    // (1) Restore only if the same section is still active. This prevents a search
    // commit from stealing focus back after the user switches tabs.
    if (activeSearch && !switchedSection) {
      const input = root.querySelector(activeSearch.selector)
      if (input instanceof HTMLInputElement) {
        input.focus()
        try {
          input.setSelectionRange(
            Math.min(activeSearch.start, input.value.length),
            Math.min(activeSearch.end, input.value.length),
            activeSearch.direction,
          )
        } catch {
          // Selection APIs are not supported by every input implementation.
        }
      }
    }
  }

  /**
   * The panel header: a compact heading, the operational status it genuinely
   * carries, and the two controls that belong to the panel rather than to a
   * section.
   *
   * Nothing was removed to make it smaller — the counts and the last-refresh
   * time are still here — they are just demoted to one muted line under the
   * heading (overhaul.txt §3A).
   */
  const renderHeader = (view: StoreView): HTMLElement => {
    const header = el('div', { class: 'lt-app__header' })

    const heading = el('div', { class: 'lt-app__heading' })
    heading.appendChild(el('h2', { class: 'lt-app__title' }, ['LumiTag']))
    header.appendChild(heading)

    header.appendChild(el('span', { class: 'lt-app__spacer' }))
    header.appendChild(renderMeta(view))

    const actions = el('div', { class: 'lt-app__actions' })
    // Search help stays a first-class header control rather than being buried in
    // a section toolbar, so it is reachable from either view (and it opens the
    // section the reader is actually in).
    actions.appendChild(
      button('Search Syntax Help', {
        variant: 'ghost',
        title: 'Show the search syntax accepted in this section',
        onClick: () => options.onShowSearchHelp(view.section),
      }),
    )

    const refresh = button('Refresh', {
      variant: 'default',
      title: 'Reload all characters from the server',
      onClick: () => {
        void store.actions.refresh()
      },
    })
    // Disabled while a load is in flight so a double click cannot start two
    // full-library walks.
    setBusy(refresh, view.loadState === 'loading' || view.isRefreshing, 'Refreshing…')
    actions.appendChild(refresh)
    header.appendChild(actions)

    refreshButton = refresh
    void refreshButton

    return header
  }

  /** The navigation row that holds the Tags/Characters segmented control. */
  const renderNav = (view: StoreView): HTMLElement => {
    const nav = el('div', { class: 'lt-app__nav' })
    nav.appendChild(renderTabs(view))
    return nav
  }

  /**
   * The Tags/Characters switcher, styled as the host's segmented control
   * (SettingsModal.module.css:696-731) — a rounded, subtle-filled, hairline
   * row with 1px dividers and a `--primary-020` active cell, rather than the
   * large saturated rectangle the previous stylesheet produced.
   *
   * Each cell carries its own count in a `.lt-tabs__count` badge, which is the
   * host's own way of showing scope in a tab rail.
   */
  const renderTabs = (view: StoreView): HTMLElement => {
    const strip = el('div', { class: 'lt-tabs', role: 'tablist' })
    strip.setAttribute('aria-label', 'LumiTag sections')
    tabButtons = []

    for (const section of SECTIONS) {
      const isActive = view.section === section.id
      const tab = button(section.label, {
        variant: 'ghost',
        ariaLabel: `${section.label} section`,
        onClick: () => store.actions.setSection(section.id),
      })
      tab.id = `lt-tab-${section.id}`
      tab.setAttribute('role', 'tab')
      tab.setAttribute('aria-selected', isActive ? 'true' : 'false')
      tab.tabIndex = isActive ? 0 : -1

      const count = section.id === 'tags'
        ? view.tagIndex.tags.length
        : view.characterCount
      // The badge is decorative: the tab's accessible name already says which
      // section it is, and the counts are repeated in the header status line.
      tab.appendChild(el('span', { class: 'lt-tabs__count', 'aria-hidden': 'true' }, [
        String(count),
      ]))

      strip.appendChild(tab)
      tabButtons.push(tab)
    }

    // One delegated keydown for the whole strip: Arrow keys move between tabs,
    // Home/End jump to the ends, and the newly focused tab is activated, which
    // is the standard tabs pattern and keeps focus on the active tab.
    track(
      on(strip, 'keydown', (ev) => {
        const event = ev as KeyboardEvent
        const index = tabButtons.findIndex((b) => b === (event.target as HTMLElement))
        if (index < 0) return
        let next = index
        switch (event.key) {
          case 'ArrowRight':
            next = (index + 1) % SECTIONS.length
            break
          case 'ArrowLeft':
            next = (index - 1 + SECTIONS.length) % SECTIONS.length
            break
          case 'Home':
            next = 0
            break
          case 'End':
            next = SECTIONS.length - 1
            break
          default:
            return
        }
        event.preventDefault()
        const target = tabButtons[next]
        if (!target) return
        target.focus()
        store.actions.setSection(SECTIONS[next]!.id)
      }),
    )

    return strip
  }

  /** One muted line: how much is loaded, how much is untagged, and how fresh. */
  const renderMeta = (view: StoreView): HTMLElement => {
    const meta = el('div', { class: 'lt-app__meta' })
    meta.appendChild(
      el('span', {}, [
        text(countLabel(view.tagIndex.tags.length, 'tag')),
        text(' · '),
        text(countLabel(view.characterCount, 'character')),
      ]),
    )
    meta.appendChild(
      el('span', {}, [text(`${countLabel(view.untaggedCount, 'untagged character')}`)]),
    )
    meta.appendChild(
      el('span', { class: 'lt-app__meta-time' }, [
        text(`Last refreshed ${formatTime(view.lastRefreshedAt)}`),
      ]),
    )

    return meta
  }

  /**
   * Render the active section, or the panel-level state that replaces it.
   *
   * Loading, error and "no characters at all" are panel-level concerns because
   * neither section can say anything useful without data.
   */
  const renderSection = (view: StoreView, host: HTMLElement): void => {
    if (view.loadState === 'error') {
      host.appendChild(
        errorState(
          'Could not load your characters',
          view.loadError ?? 'Unknown error.',
          () => {
            void store.actions.refresh()
          },
        ),
      )
      return
    }

    if (view.loadState === 'loading' && view.characterCount === 0) {
      host.appendChild(spinner('Loading all characters…'))
      return
    }

    if (view.loadState !== 'ready') {
      host.appendChild(emptyState('Not loaded yet', 'Refresh to load your characters.'))
      return
    }

    if (view.characterCount === 0) {
      host.appendChild(
        emptyState(
          'No characters found',
          'LumiTag tags every character you can see. Create a character first, then come back.',
        ),
      )
      return
    }

    if (view.section === 'tags') options.renderTagsSection(host)
    else options.renderCharactersSection(host)
  }

  const destroy = (): void => {
    if (destroyed) return
    destroyed = true
    teardownListeners()
    tabButtons = []
    sectionHost = null
    failureHost = null
    refreshButton = null
    lastSection = null
    clear(root)
  }

  const unsubscribe = store.subscribe(render)
  const originalDestroy = destroy
  let stopped = false

  render()

  return {
    destroy: () => {
      if (stopped) return
      stopped = true
      unsubscribe()
      originalDestroy()
    },
  }
}