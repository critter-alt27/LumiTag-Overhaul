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
    if (max === 0) return // don't force jump to 0 on shorter content
    body.scrollTop = Math.min(top, max)
  }

  const render = (): void => {
    if (destroyed) return
    const view = store.view

    // Skip a no-op re-render. `commit()` only bumps the version on a real
    // change, so this is exact rather than a heuristic.
    if (store.version === lastVersion) return
    lastVersion = store.version

    // Read the offset off the PREVIOUS render's body, before `clear()` throws
    // that element away: the replacement starts life at 0 and there is no
    // browser-level memory of where the user was.
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

    // Switching tabs replaces the content wholesale with something unrelated,
    // so the offset from the previous tab is meaningless there and the new tab
    // should start at its own top. Every OTHER re-render — filtering, sorting,
    // expanding, selecting in bulk/merge mode — keeps the offset.
    const switchedSection = lastSection !== null && lastSection !== view.section
    lastSection = view.section

    teardownListeners()
    clear(root)

    // root (tab.root) already carries .lt-app from app.ts; don't nest.
    root.appendChild(renderHeader(view))
    root.appendChild(renderTabs(view))
    root.appendChild(renderMeta(view))

    sectionHost = el('div', { class: 'lt-app__body' })
    root.appendChild(sectionHost)
    renderSection(view, sectionHost)

    failureHost = el('div', { class: 'lt-app__failure-region' })
    root.appendChild(failureHost)
    options.renderFailurePanel(failureHost)

    // The body is populated and attached now, so `scrollHeight` is meaningful
    // and the clamp can be computed rather than guessed.
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
      if (foundAnchor && previousAnchorOffset > 0) {
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
  }

  const renderHeader = (view: StoreView): HTMLElement => {
    const header = el('div', { class: 'lt-app__header' })

    header.appendChild(el('h2', { class: 'lt-app__title' }, ['LumiTag']))

    header.appendChild(
      button('Search Syntax Help', {
        variant: 'ghost',
        ariaLabel: 'Show search syntax help',
        title: 'Show the search syntax accepted in this section',
        onClick: () => options.onShowSearchHelp(view.section),
      }),
    )

    header.appendChild(el('span', { class: 'lt-app__spacer' }))

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
    header.appendChild(refresh)
    refreshButton = refresh
    void refreshButton

    return header
  }

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

  const renderMeta = (view: StoreView): HTMLElement => {
    const meta = el('div', { class: 'lt-app__meta' })
    const total = view.characterCount
    meta.appendChild(
      el('span', {}, [
        text(countLabel(total, 'character')),
        text(' · '),
        el('strong', {}, [`${view.tagIndex.tags.length} tags`]),
      ]),
    )
    meta.appendChild(el('span', {}, [text(`${countLabel(view.untaggedCount, 'untagged character')}`)]))
    meta.appendChild(
      el('span', {}, [text(`Last refreshed: ${formatTime(view.lastRefreshedAt)}`)]),
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