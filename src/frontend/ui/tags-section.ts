/**
 * LumiTag "Tags" section renderer.
 *
 * Owns the compact context line, the toolbar (search, sort, create, mode
 * toggles), the query-error notice, the `C:` character-search panel, the
 * ordinary tag list with its expandable character sub-list, and the
 * bulk-delete / merge mode banners.
 *
 * ## Rules this renderer obeys
 *
 *  1. **No logic of its own.** Every mutation goes through `store.actions`;
 *     every confirmation goes through `requestDialog`. This module never calls
 *     `planOperation`, `MutationExecutor` or the repository.
 *  2. **No markup from strings.** Every visible value (tag names, character
 *     names, backend error text) is appended through `text()`, so a tag named
 *     `<img onerror=…>` is inert text.
 *  3. **Selection and expansion live in the store, keyed by the stable tag
 *     key** — never by display name and never in local state — so collapsing
 *     a row or renaming a tag cannot corrupt a selection.
 *  4. **Every listener is disposable.** Listeners are attached only through
 *     `on()` and their disposers are tracked, so `destroy()` releases all of
 *     them. `dom.select()` is the one `dom.ts` builder used here: its listener
 *     is registered against the node it owns, so `dom.clear()` — which both the
 *     re-render path and `destroy()` call — releases it with the node. The
 *     search box is built below from `el` + tracked `on` because it also owns
 *     the focus/caret listeners that must survive a rebuild.
 *  5. **Re-rendering is the shell's job.** `renderShell` clears and rebuilds
 *     the section on every store change, so this renderer does not subscribe
 *     to the store itself (a second subscription would leak one listener per
 *     shell render). `destroy()` is still complete for a standalone caller.
 *  6. **Paged rendering.** At most {@link TAG_PAGE_SIZE} rows are rendered per
 *     page so a huge catalog cannot freeze the drawer. Tag selection is GLOBAL
 *     and survives a page change; counts always come from the store.
 *
 * ## Visual contract (overhaul.txt §3B, §3E, §3F, §3G, §4)
 *
 * The section reads top-down as: a compact context line (how much is here, how
 * much the query left), the search field, the sort control, the actions, then
 * the rows, then the pager — the same ladder the Characters section uses, so
 * the two read as two views of one feature rather than as two utilities. Rows
 * are hairline-separated rather than carded (`.lt-tag-row`), the disclosure
 * control is a square icon button at the head of the row and the row-level
 * actions are quiet text buttons at its tail, and row-level Delete is
 * `danger-ghost` so ordinary browsing stays calm while a destructive action is
 * still recognisable.
 */

import {
  TAG_PAGE_SIZE,
  type StoreView,
  type TagListRow,
  type TagManagerStore,
  type TagMode,
} from '../store'
import { charactersForTag } from '../tag-index'
import { TAG_SORT_LABELS, TAG_SORT_MODES } from '../tag-sorting'
import type { TagSortMode } from '../tag-sorting'
import { SEARCH_DEBOUNCE_MS } from './characters-section'
import { requestDialog } from './dialog-host'
import {
  avatar,
  badge,
  button,
  clear,
  el,
  emptyState,
  field,
  on,
  pager,
  sectionEl,
  select,
  setDisabled,
  spinner,
  text,
} from './dom'

/** Hard cap on eagerly rendered characters in any one sub-list. */
const CHARACTER_LIMIT = 200

/**
 * Sort labels, with `only_zero` spelled out.
 *
 * The shared label ("Unused tags") does not say *why* the list is usually
 * empty, and an empty "unused tags" list reads as a bug, so the label names
 * the actual filter: only tags with zero character assignments.
 */
const SORT_OPTIONS: readonly { value: TagSortMode; label: string }[] = TAG_SORT_MODES.map((mode) => ({
  value: mode,
  label: mode === 'only_zero' ? 'Only 0 Characters (unused tags)' : TAG_SORT_LABELS[mode],
}))

/** Mode toggle buttons, in toolbar order. */
const MODE_BUTTONS: readonly { mode: TagMode; label: string; title: string }[] = [
  { mode: 'merge', label: 'Merge Mode', title: 'Merge several tags into one primary tag' },
  {
    mode: 'bulk_delete',
    label: 'Bulk Delete Mode',
    title: 'Select several tags and delete them in one confirmed operation',
  },
]

/**
 * Focus and caret intent for the rebuilt tag search box.
 *
 * The shell rebuilds the panel from scratch on every store change, which would
 * otherwise drop focus (and the caret) on every keystroke. There is only ever
 * one Tags panel and one search box in it, so module-level intent is enough —
 * and it MUST be module-level: {@link restoreSearchFocus} runs after the render
 * body that recorded this intent has already returned, so a render-scoped
 * snapshot would be out of scope by the time it is read.
 *
 * Written by the search box's `focus`/`blur`/`keyup`/`select` listeners and
 * refreshed from the live DOM at the top of `render()`; {@link destroy} must not
 * clear it, because destroying this panel is how the shell performs a re-render.
 */
let searchFocusIntent = false

/**
 * Caret offset of the focused search box, or `0` when nothing is focused.
 *
 * Always gated by {@link searchFocusIntent}, so a stale offset can never
 * restore a caret the reader is no longer typing at.
 */
let searchCaret = 0

/**
 * Pending debounce for the search commit.
 *
 * Deliberately NOT cleared on teardown: the commit has to outlive the rebuild
 * that the debounce itself causes, or typing would never commit at all.
 */
let searchTimer: ReturnType<typeof setTimeout> | null = null

/** Session-authenticated, read-only avatar endpoint for a character. */
function avatarUrl(id: string): string {
  return `/api/v1/characters/${encodeURIComponent(id)}/avatar`
}

/** A short, human-scannable form of a character id. */
function shortId(id: string): string {
  return id.length <= 10 ? id : `${id.slice(0, 8)}…`
}

/** `1 character` / `3 characters`. */
function characterCountLabel(count: number): string {
  return `${count} ${count === 1 ? 'character' : 'characters'}`
}

/** `1 tag` / `3 tags`. */
function tagCountLabel(count: number): string {
  return `${count} ${count === 1 ? 'tag' : 'tags'}`
}

/** A tag shown for inspection only: no remove affordance, no listener. */
function staticChip(label: string): HTMLElement {
  return el('span', { class: 'lt-chip' }, [el('span', { class: 'lt-chip__label' }, [label])])
}

/**
 * Render the Tags section into `options.container`.
 *
 * The returned `destroy()` releases every listener this renderer created and
 * empties the container. It is idempotent.
 */
export function renderTagsSection(options: {
  container: HTMLElement
  store: TagManagerStore
}): { destroy(): void } {
  const { container, store } = options

  let disposers: (() => void)[] = []
  let destroyed = false

  const track = (dispose: () => void): void => {
    disposers.push(dispose)
  }

  const teardown = (): void => {
    for (const dispose of disposers) {
      try {
        dispose()
      } catch {
        // A failing disposer must not prevent the rest from being released.
      }
    }
    disposers = []
  }

  // ---------------------------------------------------------------------
  // Tracked control builders (see rule 4 at the top of the file)
  // ---------------------------------------------------------------------

  /**
   * The primary search box: the host `SearchField` structure
   * (SearchField.module.css:1-27) — a subtle-filled hairline pill with a
   * borderless 13px input and its own clear control.
   *
   * The pill is assembled here rather than through `dom.searchInput()` because
   * the pill's extra listeners (clear-click, clear-visibility) have to sit in
   * this renderer's disposer set alongside the focus/caret listeners, which is
   * what lets the test suite prove that `destroy()` releases all of them. The
   * resulting class names — `.lt-searchfield`, `.lt-searchfield__input`,
   * `.lt-searchfield__clear` — are the contract with `styles.ts` §6.
   */
  const buildSearch = (value: string, onInput: (v: string) => void): HTMLElement => {
    const ariaLabel = 'Search tags with T:, or character names with C:.'
    const input = el('input', {
      class: 'lt-search lt-searchfield__input',
      type: 'search',
      'aria-label': ariaLabel,
      placeholder: 'Search tags (T:tag, C:char)',
      autocomplete: 'off',
      autocapitalize: 'none',
      spellcheck: 'false',
    })
    input.value = value
    track(on(input, 'input', () => onInput(input.value)))
    track(
      on(input, 'focus', () => {
        searchFocusIntent = true
      }),
    )
    track(
      on(input, 'blur', () => {
        // A detached node also blurs, and the shell detaches this input on
        // every rebuild, so a blur from a node that has left the document is
        // the panel being replaced — not the reader moving on — and the intent
        // must outlive it.
        if (input.isConnected) searchFocusIntent = false
      }),
    )
    // `keyup` alone misses a caret moved by clicking in the box or by
    // select-all, so `select` keeps the offset exact on every re-render.
    const recordCaret = (): void => {
      searchCaret = input.selectionStart ?? input.value.length
    }
    track(on(input, 'keyup', recordCaret))
    track(on(input, 'select', recordCaret))

    // The host draws its own clear control and hides the UA one
    // (SearchField.module.css:22), so it is visible only while there is
    // something to clear. Icon-only ⇒ it carries both a name and a tooltip.
    const clearLabel = 'Clear the tag search'
    const clearBtn = button('×', { variant: 'icon-sm', ariaLabel: clearLabel, title: clearLabel })
    clearBtn.setAttribute('class', 'lt-btn lt-btn--icon-sm lt-searchfield__clear')
    clearBtn.hidden = value === ''
    track(
      on(clearBtn, 'click', () => {
        input.value = ''
        clearBtn.hidden = true
        onInput('')
        // Clearing must leave the reader typing in the same box, not send them
        // back to the top of the panel.
        input.focus()
      }),
    )
    track(
      on(input, 'input', () => {
        clearBtn.hidden = input.value === ''
      }),
    )

    // The wrapper IS the pill: `.lt-searchfield` supplies the host's row layout
    // (row direction, 8px gap, 8px 12px padding, 10px radius, `--fill-subtle`,
    // hairline, `:focus-within` border) and its `> .lt-search` rule makes the
    // input borderless inside it. A `.lt-field` wrapper would be the wrong
    // choice here — `styles.ts` §6 would paint a SECOND pill around this one.
    // `lt-toolbar__search` is applied so the field is the flexing item directly
    // inside the toolbar (the 240px basis and the narrow-drawer full row).
    const wrapper = el('label', { class: 'lt-searchfield lt-toolbar__search' })
    wrapper.appendChild(input)
    wrapper.appendChild(clearBtn)
    return wrapper
  }

  // ---------------------------------------------------------------------
  // Context line — the section's "useful status" (overhaul.txt §4)
  // ---------------------------------------------------------------------

  /**
   * One compact line above the toolbar: what this list is, how much of it the
   * current query and sort left, and — in a selection mode — how much is
   * selected.
   *
   * Deliberately NOT a `.lt-state`: that class is the empty/loading treatment
   * (centred, italic, padded) and it is also one of the shell's scroll-anchor
   * selectors, so a status line must not borrow it.
   */
  const renderContext = (view: StoreView): HTMLElement => {
    const bar = el('div', { class: 'lt-row lt-row--wrap' })
    bar.appendChild(el('span', { class: 'lt-tag-row__name' }, ['Tags']))

    const total = view.tagIndex.tags.length
    const matching = view.tagRows.length

    if (view.tagQueryIsCharacterMode) {
      // In `C:` mode the tag list is deliberately not rendered, so a "0 of N
      // tags" count would be true and actively misleading. Say what is on
      // screen instead.
      const shown = Math.min(view.tagQueryCharacters.length, CHARACTER_LIMIT)
      bar.appendChild(
        badge(
          shown === 1 ? '1 matching character' : `${shown} matching characters`,
          { title: 'Characters matched by the C: part of the query' },
        ),
      )
    } else {
      bar.appendChild(
        badge(
          matching === total
            ? tagCountLabel(total)
            : `${tagCountLabel(matching)} of ${tagCountLabel(total)}`,
          { title: 'How many tags the current search, sort and filters leave' },
        ),
      )
      if (matching === total && total > 0) {
        bar.appendChild(
          el('span', { class: 'lt-tag-row__meta' }, [characterCountLabel(view.characterCount) + ' to tag']),
        )
      }
    }
    if (view.tagMode !== 'normal' && view.selectedTagCount > 0) {
      bar.appendChild(
        badge(tagCountLabel(view.selectedTagCount), {
          tone: 'accent',
          title: 'Tags selected for the current mode',
        }),
      )
    }
    return bar
  }

  // ---------------------------------------------------------------------
  // Toolbar
  // ---------------------------------------------------------------------

  const renderToolbar = (view: StoreView, search: HTMLElement): HTMLElement => {
    const bar = el('div', { class: 'lt-toolbar', role: 'toolbar', 'aria-label': 'Tag actions' })

    bar.appendChild(search)

    bar.appendChild(
      field(
        'Sort by',
        select(SORT_OPTIONS, view.tagSort, (value) => store.actions.setTagSort(value)),
        '“Only 0 Characters” lists tags nothing is assigned to',
      ),
    )

    const actions = el('div', { class: 'lt-toolbar__actions' })

    // The one primary action of this view. Everything else stays quiet.
    actions.appendChild(
      button('Create Tag', {
        variant: 'primary',
        title: 'Create a new tag and assign it to characters',
        onClick: () => requestDialog({ kind: 'create_tag' }),
      }),
    )

    for (const entry of MODE_BUTTONS) {
      const active = view.tagMode === entry.mode
      const toggle = button(active ? `${entry.label}: On` : `${entry.label}: Off`, {
        // Active reads as a pressed secondary, never as a second primary: two
        // filled buttons in one toolbar is exactly the hierarchy §3C warns
        // against.
        variant: active ? 'default' : 'ghost',
        title: entry.title,
        ariaLabel: `${entry.label} toggle`,
        onClick: () => store.actions.setTagMode(active ? 'normal' : entry.mode),
      })
      // Real buttons, so Enter/Space already work; `aria-pressed` announces the
      // on/off state to a screen reader.
      toggle.setAttribute('aria-pressed', active ? 'true' : 'false')
      actions.appendChild(toggle)
    }

    if (view.tagMode !== 'normal') {
      actions.appendChild(
        button('Exit mode', {
          variant: 'ghost',
          title: 'Leave the current tag mode and return to browsing',
          onClick: () => store.actions.exitTagMode(),
        }),
      )
    }

    bar.appendChild(actions)
    return bar
  }

  /**
   * Give the rebuilt search box its focus and caret back after a re-render.
   *
   * Reads only module state ({@link searchFocusIntent}, {@link searchCaret}) and
   * the freshly built input's own value; it deliberately has no access to the
   * render body that recorded the intent, which has already returned.
   */
  const restoreSearchFocus = (root: HTMLElement): void => {
    if (!searchFocusIntent) return
    const input = root.querySelector('input.lt-search')
    if (!(input instanceof HTMLInputElement)) return
    // Nothing typed and nothing to put the caret after: an empty box at
    // offset 0 is a freshly-clicked search field, and re-focusing it would
    // steal focus back from whatever the reader has moved on to. A caret of 0
    // in a NON-empty query still restores, because the empty-value half of the
    // conjunction is what makes the skip safe.
    if (searchCaret === 0 && input.value === '') return
    input.focus()
    try {
      const caret = Math.min(searchCaret, input.value.length)
      input.setSelectionRange(caret, caret)
    } catch {
      // Some engines reject selection APIs on `type="search"`; focus alone
      // keeps typing working.
    }
  }

  // ---------------------------------------------------------------------
  // Query errors
  // ---------------------------------------------------------------------

  const renderQueryErrors = (view: StoreView): HTMLElement | null => {
    const errors = view.tagQueryErrors
    if (errors.length === 0) return null

    const box = el('div', {
      class: 'lt-query-errors',
      role: 'alert',
      'aria-label': 'Search syntax errors',
    })
    box.appendChild(
      el('strong', {}, [`Search syntax problem${errors.length === 1 ? '' : 's'} — fix the query:`]),
    )
    const list = el('ul', { class: 'lt-list' })
    for (const error of errors) {
      const suffix = error.token ? ` (near “${error.token}”)` : ''
      list.appendChild(el('li', {}, [`${error.message}${suffix}`]))
    }
    box.appendChild(list)
    box.appendChild(text(' Nothing has been changed; the list below is the last valid search.'))
    return box
  }

  // ---------------------------------------------------------------------
  // `C:` character-search mode
  // ---------------------------------------------------------------------

  /**
   * The panel shown when the query is in `C:` mode.
   *
   * It carries `lt-tags-section__character-mode`, whose four non-colour cues
   * (dashed accent rail, monospace `C:` heading, tinted surface, legend line)
   * are what stop a character-name result set from being read as a tag list.
   * The tag list is deliberately NOT rendered alongside it — see `render()`.
   */
  const renderCharacterMode = (view: StoreView): HTMLElement => {
    const panel = el('div', { class: 'lt-box lt-tags-section__character-mode' })
    panel.appendChild(el('p', { class: 'lt-state__title' }, ['C: character search']))
    panel.appendChild(
      el('p', { class: 'lt-state__detail' }, [
        'C: matches characters by NAME, not by tag. The characters below are the ones your ' +
          'character query matched, with the tags they currently carry. Drop the C: prefix to ' +
          'search tag names instead; an unknown prefix like A: is treated as plain name text.',
      ]),
    )

    const matches = view.tagQueryCharacters
    if (matches.length === 0) {
      panel.appendChild(
        emptyState(
          'No characters matched',
          'No character name contains this query. C: and bare text both match character names; ' +
            'T: is the prefix that searches tag names.',
        ),
      )
      return panel
    }

    const total = matches.length
    const shown = Math.min(total, CHARACTER_LIMIT)
    const untagged: string[] = []

    const list = sectionEl('lt-list')
    list.setAttribute('role', 'list')
    list.setAttribute('aria-label', 'Characters matching the C: search')

    for (const entry of matches.slice(0, shown)) {
      const id = entry.character?.id ?? ''
      const name = entry.character?.name ?? ''
      const display = name === '' ? '(unnamed character)' : name
      const tags = Array.isArray(entry.tags) ? entry.tags : []
      if (tags.length === 0) untagged.push(display)

      const item = el('div', { class: 'lt-box lt-character-row' })
      item.setAttribute('role', 'listitem')
      item.appendChild(
        el('div', { class: 'lt-row lt-row--wrap' }, [
          avatar(avatarUrl(id), name, 28),
          el('span', { class: 'lt-character-row__name' }, [display]),
          badge(shortId(id), { tone: 'muted' }),
          badge(tagCountLabel(tags.length)),
        ]),
      )

      if (tags.length === 0) {
        item.appendChild(
          el('p', { class: 'lt-state__detail' }, ['This character has no tags assigned.']),
        )
      } else {
        const chips = el('div', { class: 'lt-subtag-list' })
        for (const tag of tags) chips.appendChild(staticChip(tag))
        item.appendChild(chips)
      }
      list.appendChild(item)
    }

    panel.appendChild(list)

    if (untagged.length > 0) {
      panel.appendChild(
        el('p', { class: 'lt-state__detail' }, [
          `${untagged.length} of the ${shown} shown ${
            untagged.length === 1 ? 'character has' : 'characters have'
          } no tags at all.`,
        ]),
      )
    }

    if (total > shown) {
      panel.appendChild(
        el('p', { class: 'lt-state__detail' }, [
          `Showing ${shown} of ${total} matching characters — refine your search to see the rest.`,
        ]),
      )
    }

    return panel
  }

  // ---------------------------------------------------------------------
  // Ordinary tag list
  // ---------------------------------------------------------------------

  const renderTagList = (view: StoreView): HTMLElement => {
    if (view.tagIndex.tags.length === 0) {
      return emptyState(
        'No tags yet',
        'A tag only exists while at least one character carries it. Assign a tag to a character ' +
          'and it appears here; when the last character loses it, the tag disappears again.',
        button('Create Tag', {
          variant: 'primary',
          title: 'Create a new tag and assign it to characters',
          onClick: () => requestDialog({ kind: 'create_tag' }),
        }),
      )
    }

    const rows = view.tagRows
    if (rows.length === 0) {
      if (view.tagSort === 'only_zero') {
        return emptyState(
          'No tags with 0 characters',
          'Nothing is unused: every tag in your library is assigned to at least one character. ' +
            'This list is empty by design — tags are derived from live assignments, so an ' +
            'unassigned tag does not exist and is never invented here.',
        )
      }
      const q = view.tagQuery.trim()
      if (q !== '') {
        return emptyState(
          'No tags match your search',
          `No tag name contains “${q}”. Clear the search, or prefix it with C: to search ` +
            'character names instead.',
        )
      }
      return emptyState('No tags to show', 'The current search, sort and filters match no tags.')
    }

    const list = sectionEl('lt-list')
    list.setAttribute('role', 'list')
    list.setAttribute('aria-label', 'Tags')

    // Only the current page is rendered; `tagRows` (every match) stays in the
    // view because Select All and the library-wide tag operations need it.
    for (const row of view.tagPageRows) {
      list.appendChild(renderTagRow(view, row))
      if (row.expanded) {
        const expanded = renderExpanded(view, row)
        if (expanded) list.appendChild(expanded)
      }
    }

    const controls = pager({
      page: view.tagPage,
      pageCount: view.tagPageCount,
      total: rows.length,
      pageSize: TAG_PAGE_SIZE,
      label: 'tags',
      onPage: (page) => store.actions.setTagPage(page),
    })
    if (controls) list.appendChild(controls)

    return list
  }

  const renderTagRow = (view: StoreView, row: TagListRow): HTMLElement => {
    const { entry } = row
    const mode = view.tagMode
    const isPrimary = mode === 'merge' && view.mergePrimaryKey === entry.key
    const isTarget = mode === 'merge' && view.mergeTargetKeys.includes(entry.key)
    const isSelfTarget = mode === 'merge' && isPrimary

    const classes = ['lt-tag-row']
    // Selection is indicated by a class AND `aria-selected`, in every mode but
    // `normal`, so a bulk/merge selection is never conveyed by colour alone.
    // In `normal` mode nothing can be selected at all, so ordinary browsing and
    // bulk/merge selection stay two visually distinct states.
    if (mode !== 'normal' && (row.selected || isPrimary || isTarget)) {
      classes.push('lt-tag-row--selected')
    }
    if (isPrimary) classes.push('lt-tag-row--primary')
    if (isSelfTarget) classes.push('lt-tag-row--disabled')

    const node = el('div', { class: classes.join(' ') })
    node.setAttribute('role', 'listitem')
    node.dataset['tagKey'] = entry.key
    if (mode !== 'normal') node.setAttribute('aria-selected', row.selected ? 'true' : 'false')

    // --- selection control -------------------------------------------------
    if (mode === 'merge') {
      const primary = el('input', {
        class: 'lt-checkbox',
        type: 'radio',
        name: 'lt-merge-primary',
        'aria-label': `Use ${entry.name} as the merge primary tag`,
      })
      primary.checked = isPrimary
      track(
        on(primary, 'change', () => {
          if (primary.checked) store.actions.setMergePrimary(entry.key)
        }),
      )
      node.appendChild(primary)

      // The store owns the toggle semantics, so the checkbox state is only a
      // reflection of it — a re-render is the source of truth.
      const targetBox = el('input', {
        class: 'lt-checkbox',
        type: 'checkbox',
        'aria-label': `Merge ${entry.name} into the primary tag`,
      })
      targetBox.checked = isTarget
      track(
        on(targetBox, 'change', () => {
          store.actions.toggleMergeTarget(entry.key)
        }),
      )
      if (isSelfTarget) {
        targetBox.disabled = true
        targetBox.setAttribute('aria-disabled', 'true')
        targetBox.title = 'The primary tag cannot be merged into itself'
      }
      node.appendChild(targetBox)
    } else if (mode === 'bulk_delete') {
      const box = el('input', {
        class: 'lt-checkbox',
        type: 'checkbox',
        'aria-label': `Select tag ${entry.name} for deletion`,
      })
      box.checked = row.selected
      track(
        on(box, 'change', () => {
          store.actions.toggleTagSelected(entry.key, box.checked)
        }),
      )
      node.appendChild(box)
    }

    // --- expand / collapse -------------------------------------------------
    // A square icon-only disclosure at the HEAD of the row: shape, position and
    // size all differ from the text buttons at its tail, so "show me this
    // tag's characters" never gets confused with "act on this tag".
    node.appendChild(
      button(row.expanded ? '▾' : '▸', {
        variant: 'icon-sm',
        ariaLabel: `${row.expanded ? 'Collapse' : 'Expand'} tag ${entry.name}`,
        title: row.expanded
          ? 'Hide the characters carrying this tag'
          : 'Show the characters carrying this tag',
        onClick: () => store.actions.toggleTagExpanded(entry.key),
      }),
    )

    // --- name, assignment count, badges ------------------------------------
    const main = el('div', { class: 'lt-row lt-row--grow lt-row--wrap' })
    main.appendChild(el('span', { class: 'lt-tag-row__name' }, [entry.name]))
    main.appendChild(
      el('span', { class: 'lt-tag-row__meta' }, [characterCountLabel(entry.count)]),
    )
    if (isPrimary) main.appendChild(badge('Primary', { tone: 'accent' }))
    if (isTarget) main.appendChild(badge('Merge target'))
    if (isSelfTarget) {
      main.appendChild(
        el('span', { class: 'lt-tag-row__meta' }, ['primary — cannot be its own merge target']),
      )
    }
    node.appendChild(main)

    // --- per-tag actions ---------------------------------------------------
    const actions = el('div', { class: 'lt-tag-row__actions' })
    actions.appendChild(
      button('Rename', {
        variant: 'ghost',
        title: `Rename ${entry.name} on every character that carries it`,
        ariaLabel: `Rename tag ${entry.name}`,
        onClick: () => requestDialog({ kind: 'rename_tag', tag: entry.name }),
      }),
    )
    // `danger-ghost`, not a filled red button: deletion has to be
    // recognisable without a wall of red in a list the reader is merely
    // browsing through.
    actions.appendChild(
      button('Delete', {
        variant: 'danger-ghost',
        title: `Delete ${entry.name} from every character that carries it`,
        ariaLabel: `Delete tag ${entry.name}`,
        onClick: () => requestDialog({ kind: 'delete_tags', tags: [entry.name] }),
      }),
    )
    node.appendChild(actions)

    return node
  }

  /**
   * The characters assigned to an expanded tag, resolved by id, never by name.
   *
   * Subordinate by construction: no row borders of its own, an indent behind a
   * hairline rail and muted metadata (`.lt-tag-expanded` in `styles.ts` §10), so
   * the sub-list never reads as a second list of the same importance.
   */
  const renderExpanded = (view: StoreView, row: TagListRow): HTMLElement | null => {
    const ids = charactersForTag(view.tagIndex, row.entry.name)
    if (ids.length === 0) return null

    const names = new Map<string, string>()
    for (const character of view.characters) {
      if (character?.id) names.set(character.id, character.name)
    }

    const box = sectionEl('lt-tag-expanded')
    box.setAttribute('aria-label', `Characters tagged ${row.entry.name}`)

    const shown = Math.min(ids.length, CHARACTER_LIMIT)
    for (const id of ids.slice(0, shown)) {
      const name = names.get(id) ?? ''
      const tags = view.tagIndex.byCharacterId.get(id) ?? []
      const item = el('div', { class: 'lt-row lt-row--wrap' }, [
        avatar(avatarUrl(id), name, 24),
        el('span', { class: 'lt-character-row__name' }, [
          name === '' ? '(unnamed character)' : name,
        ]),
        el('span', { class: 'lt-tag-row__meta' }, [shortId(id)]),
      ])
      if (tags.length > 0) {
        const chips = el('span', { class: 'lt-subtag-list' })
        for (const tag of tags) chips.appendChild(staticChip(tag))
        item.appendChild(chips)
      }
      box.appendChild(item)
    }

    if (ids.length > shown) {
      box.appendChild(
        el('p', { class: 'lt-state__detail' }, [
          `Showing ${shown} of ${ids.length} characters carrying this tag.`,
        ]),
      )
    }

    return box
  }

  // ---------------------------------------------------------------------
  // Bulk delete mode
  // ---------------------------------------------------------------------

  /**
   * The bulk-delete banner: it has to answer, without the reader counting rows,
   * which mode is active, how many tags are selected, what will happen, what
   * the available actions are and how to leave.
   */
  const renderBulkToolbar = (view: StoreView): HTMLElement => {
    const banner = el('div', {
      class: 'lt-toolbar__banner',
      role: 'group',
      'aria-label': 'Bulk delete controls',
    })
    banner.appendChild(badge('Bulk Delete Mode', { tone: 'accent' }))
    banner.appendChild(
      el('strong', {}, [
        `${view.selectedTagCount} ${
          view.selectedTagCount === 1 ? 'tag' : 'tags'
        } selected`,
      ]),
    )
    banner.appendChild(
      el('span', {}, [
        'Tick the tags to remove below. Deleting a tag detaches it from every character that ' +
          'carries it, everywhere in your library — not only the ones on screen.',
      ]),
    )

    const actions = el('div', { class: 'lt-toolbar__actions' })
    actions.appendChild(
      button('Select All (currently displayed list only)', {
        title:
          'Select only the tags shown by your current search, sort and filters — this does NOT ' +
          'select every tag in your library',
        ariaLabel: 'Select all tags in the currently displayed list, not the whole library',
        onClick: () => store.actions.selectAllVisibleTags(),
      }),
    )
    actions.appendChild(
      button('Clear Selection', {
        variant: 'ghost',
        title: 'Unselect every tag',
        onClick: () => store.actions.clearTagSelection(),
      }),
    )

    const selectedNames = view.selectedTagKeys
      .map((key) => view.tagIndex.byKey.get(key)?.name)
      .filter((name): name is string => typeof name === 'string' && name !== '')

    const del = button('Delete Selected', {
      variant: 'danger',
      title: 'Review the deletion before anything is written',
      ariaLabel: 'Review and delete the selected tags',
      onClick: () => requestDialog({ kind: 'delete_tags', tags: selectedNames }),
    })
    setDisabled(del, selectedNames.length === 0)
    actions.appendChild(del)

    actions.appendChild(
      button('Cancel / Exit Bulk Delete Mode', {
        variant: 'ghost',
        title: 'Leave bulk delete mode without deleting anything',
        onClick: () => store.actions.exitTagMode(),
      }),
    )

    banner.appendChild(actions)
    return banner
  }

  // ---------------------------------------------------------------------
  // Merge mode
  // ---------------------------------------------------------------------

  /** The merge banner, including the live primary/target review line. */
  const renderMergeToolbar = (view: StoreView): HTMLElement => {
    const banner = el('div', {
      class: 'lt-toolbar__banner',
      role: 'group',
      'aria-label': 'Merge controls',
    })
    banner.appendChild(badge('Merge Mode', { tone: 'accent' }))
    banner.appendChild(
      el('strong', {}, [
        `${view.selectedTagCount} ${
          view.selectedTagCount === 1 ? 'tag' : 'tags'
        } selected`,
      ]),
    )
    banner.appendChild(
      el('span', {}, [
        'Choose exactly one PRIMARY tag (the radio control) and one or more distinct TARGET ' +
          'tags. Every character carrying a target tag is given the primary tag, and the target ' +
          'tags are then removed.',
      ]),
    )

    const primaryName =
      view.mergePrimaryKey === null ? null : (view.tagIndex.byKey.get(view.mergePrimaryKey)?.name ?? null)
    const targetNames = view.mergeTargetKeys
      .filter((key) => key !== view.mergePrimaryKey)
      .map((key) => view.tagIndex.byKey.get(key)?.name)
      .filter((name): name is string => typeof name === 'string' && name !== '')

    const summary = el('div', { class: 'lt-row lt-row--wrap' })
    summary.appendChild(el('span', { class: 'lt-tag-row__meta' }, ['Review:']))
    summary.appendChild(
      primaryName === null
        ? badge('no primary tag chosen', { tone: 'muted' })
        : badge(`primary: ${primaryName}`, { tone: 'accent' }),
    )
    if (targetNames.length === 0) {
      summary.appendChild(badge('no targets chosen', { tone: 'muted' }))
    } else {
      for (const name of targetNames) summary.appendChild(badge(`target: ${name}`))
    }
    summary.appendChild(
      el('span', { class: 'lt-tag-row__meta' }, [
        `${targetNames.length} ${targetNames.length === 1 ? 'target' : 'targets'} into ${
          primaryName ?? 'nothing yet'
        }`,
      ]),
    )
    banner.appendChild(summary)

    const actions = el('div', { class: 'lt-toolbar__actions' })
    const merge = button('Merge', {
      variant: 'primary',
      title: view.mergeValid
        ? 'Review the merge before anything is written'
        : 'Pick one primary tag and at least one different target tag first',
      ariaLabel: 'Review and merge the selected tags',
      onClick: () => requestDialog({ kind: 'merge_review' }),
    })
    setDisabled(merge, !view.mergeValid)
    actions.appendChild(merge)
    actions.appendChild(
      button('Cancel / Exit Merge Mode', {
        variant: 'ghost',
        title: 'Leave merge mode without merging anything',
        onClick: () => store.actions.exitTagMode(),
      }),
    )
    banner.appendChild(actions)

    return banner
  }

  // ---------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------

  const render = (): void => {
    if (destroyed) return
    const view = store.view

    // Refresh the intent from the live DOM only when the search box really is
    // focused right now. It must NOT be *cleared* otherwise: the shell mounts
    // a section by destroying the old one and rendering a new one, so by the
    // time this runs the outgoing input is already detached and
    // `document.activeElement` is `<body>` even though the reader never left
    // the search box. The `focus`/`blur` listeners own losing focus. Narrowing
    // is done on `active` itself rather than through a `wasFocused` boolean,
    // because a boolean alias does not carry the null-exclusion to its uses.
    const active = document.activeElement
    if (active instanceof HTMLInputElement && active.classList.contains('lt-search')) {
      searchFocusIntent = true
      searchCaret = active.selectionStart ?? active.value.length
    }

    teardown()
    clear(container)

    const root = el('div', { class: 'lt-box' })
    root.appendChild(renderContext(view))

    const search = buildSearch(view.tagQuery, (value) => {
      if (searchTimer) clearTimeout(searchTimer)
      // The SHARED debounce constant, so the Tags and Characters searches can
      // never drift apart and so the tests can advance by the real value.
      searchTimer = setTimeout(() => store.actions.setTagQuery(value), SEARCH_DEBOUNCE_MS)
    })
    root.appendChild(renderToolbar(view, search))

    const errors = renderQueryErrors(view)
    if (errors) root.appendChild(errors)

    if (view.loadState === 'loading') {
      root.appendChild(spinner('Loading tags…'))
      container.appendChild(root)
      // The loading frame still rebuilds the search box, so it owes it the
      // same focus/caret restoration as the full frame — otherwise a refresh
      // landing mid-word drops focus on every store change.
      restoreSearchFocus(root)
      return
    }

    if (view.tagMode === 'bulk_delete') root.appendChild(renderBulkToolbar(view))
    else if (view.tagMode === 'merge') root.appendChild(renderMergeToolbar(view))

    // In `C:` mode the tag list is deliberately NOT rendered, and there is no
    // fallback to a tag-name search: the panel above explains why.
    if (view.tagQueryIsCharacterMode) root.appendChild(renderCharacterMode(view))
    else root.appendChild(renderTagList(view))

    container.appendChild(root)

    restoreSearchFocus(root)
  }

  render()

  return {
    destroy: (): void => {
      if (destroyed) return
      destroyed = true
      teardown()
      clear(container)
      // Focus intent and caret are deliberately KEPT: `destroy()` IS the
      // shell's re-render path (it mounts a section by releasing the old one
      // and rendering a new one), so this panel's search box is normally torn
      // down while the reader is still typing in it. Clearing here would make
      // the module header's invariant unachievable. Genuine focus loss is
      // recorded by the `blur` listener above.
    },
  }
}
