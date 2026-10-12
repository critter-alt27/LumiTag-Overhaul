/**
 * LumiTag "Characters" section renderer.
 *
 * Owns the toolbar (search, sort, tag filter, the active tag-filter picker and
 * the search-syntax help control), the query-error notice, the character list
 * with its inline removable tag chips, and the additive bulk-assignment
 * toolbar.
 *
 * ## Rules this renderer obeys
 *
 * 1. **No logic of its own.** Every mutation goes through `store.actions`;
 *    every confirmation and every review goes through `requestDialog`. This
 *    module never calls `planOperation`, `MutationExecutor` or the repository,
 *    and never performs a network read of its own.
 * 2. **No markup from strings.** Every visible value (character names, tag
 *    names, backend error text) is appended through `text()`/`el()`, so a
 *    character named `<img onerror=…>` is inert text.
 * 3. **Stable identity only.** Rows, selection state and chip mutations are
 *    keyed by `character.id` and by the case-insensitive tag key — never by
 *    display name, because two characters may share a name.
 * 4. **The store owns the data.** A chip is never hidden optimistically: it
 *    disappears only because the store re-read the character and confirmed the
 *    write. A failed removal therefore leaves the chip exactly where it was and
 *    reports the failure beside it.
 * 5. **Every listener is disposable.** Listeners are attached only through
 *    `on()` and their disposers are tracked, so `destroy()` releases all of
 *    them. The `dom.ts` builders that bake in listeners (`searchInput`,
 *    `select`, `checkbox`, `chip`) are therefore NOT used here; equivalents
 *    are built below from `el` + tracked `on`.
 * 6. **Re-rendering is the shell's job.** `renderShell` rebuilds the section
 *    on every store change, so this renderer does not subscribe to the store
 *    itself (a second subscription would leak a listener per shell render).
 *    The little state it does keep — search focus intent, caret, in-flight chip
 *    keys, typed picker text — lives at module scope precisely so it survives
 *    that full rebuild. In particular `destroy()` IS the re-render path (the
 *    shell mounts a section by releasing the outgoing one and rendering a new
 *    one), so it must NOT drop the focus intent; only a genuine abandonment of
 *    a search box does.
 * 7. **Paged rendering.** At most {@link CHARACTER_PAGE_SIZE} character rows
 *    and {@link TAG_OPTION_LIMIT} tag options are rendered per page, with pager
 *    controls beneath each. Selection is GLOBAL and survives a page change;
 *    counts always come from the store's totals rather than from the page.
 */

import type {
  CharacterListRow,
  CharacterSortMode,
  CharacterTagFilter,
  StoreView,
  TagManagerStore,
} from '../store'
import {
  CHARACTER_PAGE_SIZE,
  CHARACTER_SORT_LABELS,
  CHARACTER_SORT_MODES,
  CHARACTER_TAG_FILTER_LABELS,
  CHARACTER_TAG_FILTER_MODES,
  clampPage,
  pageCountFor,
} from '../store'
import { tagKey } from '../tag-index'
import { requestDialog } from './dialog-host'
import { avatar, button, clear, el, emptyState, field, on, pager, sectionEl, setBusy, setDisabled, spinner, text } from './dom'

/**
 * Options rendered per page in a tag picker.
 *
 * A PAGE size, not a cap: the picker is paged exactly like the two lists, so
 * every existing tag is reachable by paging rather than only by searching.
 */
const TAG_OPTION_LIMIT = 200

/**
 * How many inline tag chips a character row shows before its chips collapse.
 *
 * A character with fifty tags used to produce a fifty-chip wall that made the
 * whole list unscannable; a character with one or two tags was never the
 * problem, and hiding those behind a disclosure would just add a click to every
 * row for no density gain. Three is the point where the chip block starts
 * competing with the rest of the list rather than reading as part of its row:
 * at four or more, at least one wrapped line separates a row's chips from its
 * neighbour's, so the rows stop reading as rows.
 *
 * The chips are *never* hidden — they scroll, and the summary says how many
 * there are — so this only trades a click for legibility, never for access.
 */
const COLLAPSE_TAGS_ABOVE = 3

/** All six sort modes, in the store's canonical order. */
const SORT_OPTIONS: readonly { value: CharacterSortMode; label: string }[] = CHARACTER_SORT_MODES.map(
  (mode) => ({ value: mode, label: CHARACTER_SORT_LABELS[mode] }),
)

/**
 * All five tag filters. The labels come straight from the store, which spells
 * "Has ANY of these tags" and "Has ALL of these tags" as distinct strings
 * precisely so the two cannot be confused.
 */
const FILTER_OPTIONS: readonly { value: CharacterTagFilter; label: string }[] =
  CHARACTER_TAG_FILTER_MODES.map((mode) => ({ value: mode, label: CHARACTER_TAG_FILTER_LABELS[mode] }))

/** Filter modes that consult the active tag-filter selection. */
const TAG_AWARE_FILTERS: readonly CharacterTagFilter[] = ['any', 'all_of']

/**
 * Which search slot held focus before the last rebuild, and at what caret.
 *
 * A slot NAME rather than a boolean, because this panel has several search
 * boxes at once — the main character search plus one per tag picker — and focus
 * in ANY of them has to survive a rebuild; collapsing this to one flag would
 * restore focus into the wrong box.
 *
 * Module-level, not render-scoped: {@link restoreSearchIntents} runs after the
 * render body that recorded the intent has already returned, so a render-scoped
 * snapshot would be out of scope by the time it is read.
 *
 * Written by the search box's `focus`/`blur`/`keyup`/`select` listeners and
 * refreshed from the live DOM at the top of `render()`; `destroy()` must not
 * clear it, because destroying this panel is how the shell re-renders it.
 */
let prevSlot: string | null = null

/**
 * Caret offset in the slot named by {@link prevSlot}.
 *
 * Always gated by that slot, so a stale offset can never restore a caret the
 * reader is no longer typing at.
 */
let prevSlotCaret = 0

/** Identity of one removable chip: character id plus tag key. Never a name. */
function chipKey(characterId: string, tag: string): string {
  return `${characterId}\u0000${tagKey(tag)}`
}

/**
 * Chip removals currently in flight.
 *
 * Module scope, not render scope: a store change mid-write rebuilds this panel,
 * and without a persistent guard the freshly rendered remove button would be
 * clickable a second time and submit the same removal twice.
 */
const chipsInFlight = new Set<string>()

/**
 * Per-chip removal failures, keyed the same way as {@link chipsInFlight}.
 *
 * The chip itself is left alone — the assignment still exists — and the message
 * is rendered beside it so the failure is visible rather than silent.
 */
const chipErrors = new Map<string, string>()

/**
 * Which characters' tag chips the reader has expanded, keyed by `character.id`.
 *
 * Module scope for the same reason as {@link chipsInFlight}: the shell rebuilds
 * this panel on every store change, so a `<details>` element's `open` attribute
 * would snap shut on every edit and typing a tag name would collapse the row the
 * reader was working in. `undefined` means "never touched" — the row then falls
 * back to the {@link COLLAPSE_TAGS_ABOVE} default.
 */
const tagRowsExpanded = new Map<string, boolean>()

/**
 * Which tag pickers the reader has opened or closed, keyed by `searchSlot`.
 *
 * Module scope for the same reason as {@link tagRowsExpanded}: the shell
 * rebuilds this panel on every store change, so a `<details>` element's `open`
 * attribute would snap shut (or snap open) on every selection. `undefined`
 * means "never touched", and the picker then falls back to
 * {@link pickerDefaultOpen}.
 */
const pickerOpenState = new Map<string, boolean>()

/**
 * Text typed into the tag pickers, keyed by `searchSlot`.
 *
 * Pure view state: it filters options and is never a mutation, so it is kept at
 * module scope — beside {@link pickerOpenState}, for the same reason — to survive
 * the shell's rebuild. Renderer scope would not: the shell mounts a section by
 * releasing the outgoing handle and calling `renderCharactersSection` afresh, so
 * a renderer-scoped map is empty again on the very commit the reader's debounced
 * keystroke produced, and the rebuilt box would come back empty while
 * {@link restoreSearchIntents} tried to restore a caret into it.
 */
const pickerQueries = new Map<string, string>()

/**
 * Current page of each tag picker's OPTION list, keyed by `searchSlot`.
 *
 * Module scope for the same reason as {@link pickerQueries}: the panel
 * re-renders itself on every selection change, so a renderer-scoped page would
 * reset to 1 the moment a tag was ticked.
 */
const pickerPages = new Map<string, number>()

/**
 * Delay before a typed search commits, in ms. Shared by the main search box and
 * every tag picker.
 *
 * Exported so the tests can advance the fake clock by the REAL value: this
 * constant was changed once (1000 → 1500) without the tests following, and the
 * picker-rebuild tests then silently stopped rebuilding anything while still
 * looking like ordinary focus assertions.
 */
export const SEARCH_DEBOUNCE_MS = 1500

let searchTimer: ReturnType<typeof setTimeout> | null = null
let pickerTimer: ReturnType<typeof setTimeout> | null = null

/**
 * Whether a tag picker with no remembered toggle starts open.
 *
 * Collapsed when nothing is selected, open once at least one tag is: a picker
 * with a live selection is in use, and hiding the chips the reader just picked
 * behind a closed disclosure is how a filter silently becomes invisible. An
 * untouched picker is the case the collapse exists for — it dumps up to
 * {@link TAG_OPTION_LIMIT} checkbox rows into a section whose real content is
 * the character list, so leaving it closed gives that list back the fold.
 *
 * A non-empty picker query also opens it: the reader typed into a box that was
 * open to be typing, and a re-render that collapsed the box mid-keystroke would
 * drop focus and read as a broken control.
 */
function pickerDefaultOpen(selectedCount: number, query: string): boolean {
  return selectedCount > 0 || query.trim() !== ''
}

/** Session-authenticated, read-only avatar endpoint for a character. */
function avatarUrl(id: string): string {
  return `/api/v1/characters/${encodeURIComponent(id)}/avatar`
}

/** A short, human-scannable form of a character id. */
function shortId(id: string): string {
  return id.length <= 10 ? id : `${id.slice(0, 8)}…`
}

/** `1 tag` / `3 tags`. */
function tagCountLabel(count: number): string {
  return `${count} ${count === 1 ? 'tag' : 'tags'}`
}

/** `1 character` / `3 characters`. */
function characterCountLabel(count: number): string {
  return `${count} ${count === 1 ? 'character' : 'characters'}`
}

/** `1 selected tag` / `4 selected tags`. */
function selectedTagCountLabel(count: number): string {
  return `${count} selected ${count === 1 ? 'tag' : 'tags'}`
}

/** Whether the tag filter mode reads the active tag-filter selection. */
function filterUsesActiveTags(filter: CharacterTagFilter): boolean {
  return TAG_AWARE_FILTERS.includes(filter)
}

/**
 * Render the Characters section into `options.container`.
 *
 * The returned `destroy()` releases every listener this renderer created and
 * empties the container. It is idempotent.
 */
export function renderCharactersSection(options: {
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
  // Tracked control builders (see rule 5 at the top of the file)
  // ---------------------------------------------------------------------

  const buildCheckbox = (
    checked: boolean,
    ariaLabel: string,
    onChange: (checked: boolean) => void,
  ): HTMLInputElement => {
    const input = el('input', { class: 'lt-checkbox', type: 'checkbox', 'aria-label': ariaLabel })
    input.checked = checked
    track(on(input, 'change', () => onChange(input.checked)))
    return input
  }

  const buildSelect = <T extends string>(
    value: T,
    options: readonly { value: T; label: string }[],
    ariaLabel: string,
    onChange: (v: T) => void,
  ): HTMLSelectElement => {
    const node = el('select', { class: 'lt-select', 'aria-label': ariaLabel })
    for (const option of options) {
      node.appendChild(el('option', { value: option.value }, [option.label]))
    }
    node.value = value
    track(
      on(node, 'change', () => {
        const next = node.value as T
        // An unknown value can only come from a stale DOM; ignore it rather
        // than feeding the store a mode it does not know.
        if (options.some((o) => o.value === next)) onChange(next)
      }),
    )
    return node
  }

  /**
   * A search box that survives the shell's full rebuild.
   *
   * Focus and caret are recorded in module state ({@link prevSlot},
   * {@link prevSlotCaret}) and restored by {@link restoreSearchIntents} after
   * the rebuild, so typing does not lose the caret mid-word. `slot` is the
   * stable identity used to find this box again after the rebuild.
   */
  const buildSearch = (
    slot: string,
    placeholder: string,
    value: string,
    onInput: (v: string) => void,
  ): HTMLInputElement => {
    const input = el('input', {
      class: 'lt-search',
      type: 'search',
      'aria-label': placeholder,
      placeholder,
      autocomplete: 'off',
      autocapitalize: 'none',
      spellcheck: 'false',
      'data-lt-search': slot,
    })
    input.value = value
    track(on(input, 'input', () => onInput(input.value)))
    track(
      on(input, 'focus', () => {
        prevSlot = slot
      }),
    )
    track(
      on(input, 'blur', () => {
        // A detached node also blurs, and the shell detaches this input on
        // every rebuild, so a blur from a node that has left the document is
        // the panel being replaced — not the reader moving on — and the intent
        // must outlive it.
        if (input.isConnected) prevSlot = null
      }),
    )
    // `keyup` alone misses a caret moved by clicking in the box or by
    // select-all, so `select` keeps the offset exact on every re-render.
    const recordCaret = (): void => {
      prevSlotCaret = input.selectionStart ?? input.value.length
    }
    track(on(input, 'keyup', recordCaret))
    track(on(input, 'select', recordCaret))
    return input
  }

  /**
   * Give the rebuilt search box for {@link prevSlot} its focus and caret back.
   *
   * Reads only module state and the freshly built input's own value; it
   * deliberately has no access to the render body that recorded the intent,
   * which has already returned. A slot that this frame did not build (the
   * loading frames render only the main search) is left alone rather than
   * cleared, so the intent is honoured by the frame that does build it.
   */
  const restoreSearchIntents = (root: HTMLElement): void => {
    if (!prevSlot) return
    const input = root.querySelector(`input[data-lt-search="${prevSlot}"]`)
    if (!(input instanceof HTMLInputElement)) return
    // Nothing typed and nothing to put the caret after: an empty box at
    // offset 0 is a freshly-clicked search field, and re-focusing it would
    // steal focus back from whatever the reader has moved on to. A caret of 0
    // in a NON-empty query still restores, because the empty-value half of the
    // conjunction is what makes the skip safe.
    if (prevSlotCaret === 0 && input.value === '') return
    input.focus()
    try {
      const caret = Math.min(prevSlotCaret, input.value.length)
      input.setSelectionRange(caret, caret)
    } catch {
      // Some engines reject selection APIs on `type="search"`; focus alone
      // keeps typing working.
    }
  }

  // ---------------------------------------------------------------------
  // Toolbar
  // ---------------------------------------------------------------------

  const renderToolbar = (view: StoreView): HTMLElement => {
    const bar = el('div', { class: 'lt-toolbar', role: 'toolbar', 'aria-label': 'Character actions' })

    const search = buildSearch('characters', 'Search characters and their tags', view.characterQuery, (value) => {
      if (searchTimer) clearTimeout(searchTimer)
      searchTimer = setTimeout(() => store.actions.setCharacterQuery(value), SEARCH_DEBOUNCE_MS)
    })
    bar.appendChild(el('div', { class: 'lt-toolbar__grow' }, [field('Search', search)]))

    bar.appendChild(
      field(
        'Sort by',
        buildSelect(view.characterSort, SORT_OPTIONS, 'Sort characters by', (value) =>
          store.actions.setCharacterSort(value),
        ),
      ),
    )

    bar.appendChild(
      field(
        'Filter by tags',
        buildSelect(view.characterTagFilter, FILTER_OPTIONS, 'Filter characters by their tags', (value) =>
          store.actions.setCharacterTagFilter(value),
        ),
        '“Has ANY of these tags” matches a character carrying at least one of the picked tags; ' +
          '“Has ALL of these tags” requires every one of them',
      ),
    )

    return bar
  }

  // ---------------------------------------------------------------------
  // Query errors
  // ---------------------------------------------------------------------

  const renderQueryErrors = (view: StoreView): HTMLElement | null => {
    const errors = view.characterQueryErrors
    if (errors.length === 0) return null

    const box = el('div', {
      class: 'lt-query-errors',
      role: 'alert',
      'aria-label': 'Character search syntax errors',
    })
    box.appendChild(
      el('strong', {}, [
        `Search syntax problem${errors.length === 1 ? '' : 's'} — fix the query:`,
      ]),
    )
    const list = el('ul', { class: 'lt-list' })
    for (const error of errors) {
      const suffix = error.token ? ` (near “${error.token}”)` : ''
      list.appendChild(el('li', {}, [`${error.message}${suffix}`]))
    }
    box.appendChild(list)
    box.appendChild(
      text(
        ' Nothing has been changed; the list below is the last valid search. Narrow the query or ' +
          'open “Search Syntax Help” at the top for the accepted syntax.',
      ),
    )
    return box
  }

  // ---------------------------------------------------------------------
  // Tag pickers (active filter + bulk assignment)
  // ---------------------------------------------------------------------

    /** A chip shown with a remove control, for a selected key set. */
  const buildSelectableChip = (label: string, removeLabel: string, onRemove: () => void): HTMLElement => {
    const node = el('span', { class: 'lt-chip lt-chip--accent' })
    node.appendChild(el('span', { class: 'lt-chip__label' }, [label]))
    const remove = button('×', { variant: 'ghost', ariaLabel: removeLabel, title: removeLabel })
    track(on(remove, 'click', onRemove))
    node.appendChild(remove)
    return node
  }

  /**
   * A searchable multi-select over the EXISTING tags.
   *
   * Only tags that already exist are offered: this picker assigns tags, it does
   * not mint them (creating a tag is the Tags section's job). Selection is
   * held by the store, so the rebuilt option list is always a reflection of
   * the truth rather than of local state.
   *
   * Everything between the selected chips and the "Showing X of Y" footer sits
   * inside a native `<details>` (`.lt-tag-picker`). Rendering up to
   * {@link TAG_OPTION_LIMIT} checkbox rows eagerly made this block taller than
   * the character list it exists to filter, on every render, whether or not the
   * reader intended to use it; the disclosure gives the list the fold back. The
   * summary always states the selection count, so a collapsed picker still
   * reports what was picked. Nothing here changes selection, filtering or the
   * store contract — it is presentation only.
   */
  const renderTagPicker = (config: {
    title: string
    description: string
    searchSlot: string
    searchLabel: string
    searchValue: string
    selectedKeys: readonly string[]
    groupLabel: string
    emptyMessage: string
    onSelectionChange: (keys: string[]) => void
  }): HTMLElement => {
    const box = sectionEl('lt-box')
    box.appendChild(el('p', { class: 'lt-state__title' }, [config.title]))
    box.appendChild(el('p', { class: 'lt-state__detail' }, [config.description]))

    const selected = new Set(config.selectedKeys)
    const query = pickerQueries.get(config.searchSlot) ?? config.searchValue
    const selectedCount = config.selectedKeys.length

    // The disclosure body: chips, search, options and the truncation footer.
    // It is built into a fragment and attached either inside the <details>
    // (when there are tags to show or to search for) or straight onto the box
    // (when no tag exists at all), so the "no tags exist yet" message is never
    // hidden behind a click.
    const body = el('div', { class: 'lt-tag-picker__body' })

    const chips = el('div', { class: 'lt-subtag-list' })
    chips.setAttribute('aria-label', `${config.title}: current selection`)
    if (selectedCount === 0) {
      chips.appendChild(el('span', { class: 'lt-badge lt-badge--muted' }, ['nothing selected yet']))
    }
    for (const key of config.selectedKeys) {
      const entry = store.view.tagIndex.byKey.get(key)
      const label = entry?.name ?? key
      chips.appendChild(
        buildSelectableChip(
          label,
          `Remove ${label} from this selection`,
          () =>
            config.onSelectionChange(config.selectedKeys.filter((k) => k !== key)),
        ),
      )
    }
    body.appendChild(chips)

    const search = buildSearch(
      config.searchSlot,
      config.searchLabel,
      config.searchValue,
      (value) => {
        if (pickerTimer) clearTimeout(pickerTimer)
        pickerTimer = setTimeout(() => {
          pickerQueries.set(config.searchSlot, value)
          pickerOpenState.set(config.searchSlot, true)
          // A new query reorders the options, so the old page number points at
          // a different slice.
          pickerPages.set(config.searchSlot, 0)
          render()
        }, SEARCH_DEBOUNCE_MS)
      },
    )
    body.appendChild(field('Find a tag', search))

    const needle = query.trim().toLowerCase()
    const matches = store.view.tagIndex.tags.filter(
      (entry) => needle === '' || entry.name.toLowerCase().includes(needle),
    )

    if (store.view.tagIndex.tags.length === 0) {
      // No tags exist: there is no list to disclose, and the search box could
      // only ever return the empty state below it. Rendering the disclosure
      // would put a "show / hide" control in front of a message that must be
      // read, so the body is attached directly instead.
      body.appendChild(emptyState('No tags exist yet', config.emptyMessage))
      box.appendChild(body)
      return box
    }

    if (matches.length === 0) {
      body.appendChild(
        emptyState(
          `No existing tag matches “${pickerQueries.get(config.searchSlot) ?? ''}”`,
          'This picker can only assign tags that already exist. Create a new tag from the Tags ' +
            'section, then come back.',
        ),
      )
    }

    const options = sectionEl('lt-list')
    options.setAttribute('role', 'group')
    options.setAttribute('aria-label', config.groupLabel)

    // The picker pages its OPTIONS for the same reason the lists do. Its page is
    // module state for the same reason `pickerQueries` is: the panel rebuilds
    // itself on every keystroke and on every selection change, so a
    // renderer-scoped page would snap back to 1 under the reader.
    const pageCount = pageCountFor(matches.length, TAG_OPTION_LIMIT)
    const page = clampPage(pickerPages.get(config.searchSlot) ?? 0, pageCount)

    for (const entry of matches.slice(page * TAG_OPTION_LIMIT, (page + 1) * TAG_OPTION_LIMIT)) {
      const isOn = selected.has(entry.key)
      const line = el('div', { class: 'lt-row lt-row--wrap' })
      line.appendChild(
        buildCheckbox(
          isOn,
          `${isOn ? 'Deselect' : 'Select'} tag ${entry.name}`,
          (checked) => {
            const next = checked
              ? [...config.selectedKeys, entry.key]
              : config.selectedKeys.filter((k) => k !== entry.key)
            config.onSelectionChange([...new Set(next)])
          },
        ),
      )
      line.appendChild(el('span', { class: 'lt-tag-row__name' }, [entry.name]))
      line.appendChild(
        el('span', { class: 'lt-badge' }, [
          characterCountLabel(entry.count),
        ]),
      )
      options.appendChild(line)
    }
    if (matches.length > 0) body.appendChild(options)

    const optionPager = pager({
      page,
      pageCount,
      total: matches.length,
      pageSize: TAG_OPTION_LIMIT,
      label: 'tags',
      onPage: (next) => {
        pickerPages.set(config.searchSlot, next)
        render()
      },
    })
    if (optionPager) body.appendChild(optionPager)

    if (matches.length > page * TAG_OPTION_LIMIT && matches.length > TAG_OPTION_LIMIT) {
      // The search box is built above and is never inside this block, so a
      // reader typing here keeps the rebuilt box (and their caret) however far
      // past the first page the result set runs.
      body.appendChild(
        el('p', { class: 'lt-state__detail' }, [
          `${tagCountLabel(store.view.tagIndex.tags.length)} exist in total. ` +
            'Selected tags stay ticked whichever page they are on.',
        ]),
      )
    }

    // A picker with nothing to match is forced open, exactly as the character
    // row's failed-removal state is: the message inside has to be readable.
    const open = matches.length === 0 ? true : (pickerOpenState.get(config.searchSlot) ?? pickerDefaultOpen(selectedCount, query))

    const details = el('details', {
      class: 'lt-tag-picker',
      open,
      'aria-label': `${config.title}: tag picker`,
    })

    // The summary's text IS its accessible name, so it names both the control's
    // purpose and the state a collapsed picker would otherwise hide.
    const summary = el('summary', {
      class: 'lt-tag-picker__summary',
      'aria-label':
        `${config.title}. ${selectedTagCountLabel(selectedCount)}. ` +
        `${matches.length === 0 ? 'Nothing matches this search.' : ''} show / hide the tag list`,
    })
    summary.appendChild(
      el('span', { class: selectedCount > 0 ? 'lt-badge lt-badge--accent' : 'lt-badge lt-badge--muted' }, [
        selectedTagCountLabel(selectedCount),
      ]),
    )
    summary.appendChild(el('span', { class: 'lt-tag-picker__sub' }, ['find a tag']))
    details.appendChild(summary)

    // Remembering the toggle is what keeps the reader's choice across the
    // shell's full rebuilds — without it, picking a tag would collapse the very
    // list the tag was picked from. `track` keeps it disposable like every other
    // listener here.
    track(
      on(details, 'toggle', () => {
        pickerOpenState.set(config.searchSlot, details.open)
      }),
    )

    details.appendChild(body)
    box.appendChild(details)

    return box
  }

  /** The picker that decides which tags the `any` / `all_of` filters use. */
  const renderActiveFilterPicker = (view: StoreView): HTMLElement => {
    const used = filterUsesActiveTags(view.characterTagFilter)
    const node = renderTagPicker({
      title: used ? 'Tags this filter applies to' : 'Tags for the ANY / ALL filters',
      description: used
        ? `The current filter “${CHARACTER_TAG_FILTER_LABELS[view.characterTagFilter]}” is applied to the ` +
          `${view.activeFilterTagKeys.length} ${view.activeFilterTagKeys.length === 1 ? 'tag' : 'tags'} picked below. ` +
          'With none picked, every character matches this filter.'
        : `The current filter “${CHARACTER_TAG_FILTER_LABELS[view.characterTagFilter]}” ignores this selection. ` +
          'It starts to apply as soon as you choose “Has ANY of these tags” or “Has ALL of these tags”.',
      searchSlot: 'active-filter-tags',
      searchLabel: 'Search existing tags to add to the filter',
      searchValue: pickerQueries.get('active-filter-tags') ?? '',
      selectedKeys: view.activeFilterTagKeys,
      groupLabel: 'Existing tags available to the tag filter',
      emptyMessage:
        'A tag only exists while at least one character carries it. Assign a tag from the Tags ' +
        'section and it becomes selectable here.',
      onSelectionChange: (keys) => store.actions.setActiveFilterTags(keys),
    })
    return node
  }

  // ---------------------------------------------------------------------
  // Character rows
  // ---------------------------------------------------------------------

  /**
   * Remove one tag from one character.
   *
   * The chip is NOT hidden here: `runRemoveChip` re-reads the character and
   * commits only what the server confirmed, so a failed write leaves the chip
   * in place on its own. This function only guards against double submits and
   * turns a failed write into a visible message beside the chip.
   */
  /** Drop recorded failures whose tag is no longer assigned to its character. */
  const pruneChipErrors = (view: StoreView): void => {
    if (chipErrors.size === 0) return
    const live = new Set<string>()
    // The WHOLE library, not the filtered rows: a recorded failure stays valid
    // while the tag exists, even if the character is currently filtered out.
    for (const character of view.characters) {
      const id = character?.id ?? ''
      for (const tag of Array.isArray(character?.tags) ? character.tags : []) {
        live.add(chipKey(id, tag))
      }
    }
    for (const key of [...chipErrors.keys()]) {
      if (!live.has(key)) chipErrors.delete(key)
    }
  }

  const removeChip = async (
    characterId: string,
    characterName: string,
    tag: string,
    control: HTMLButtonElement,
  ): Promise<void> => {
    const key = chipKey(characterId, tag)
    if (chipsInFlight.has(key)) return
    chipsInFlight.add(key)
    chipErrors.delete(key)
    setBusy(control, true, '…')

    try {
      await store.actions.runRemoveChip(characterId, tag)
    } catch {
      // Surfaced below by the post-write check as well, but a throw must never
      // escape the click handler.
    }

    chipsInFlight.delete(key)

    // The store owns the data, so the outcome is read back from it rather than
    // assumed: a tag that is still assigned means the write did not land.
    const stillAssigned = store.view.characters.some(
      (character) =>
        character.id === characterId &&
        Array.isArray(character.tags) &&
        character.tags.some((assigned) => tagKey(assigned) === tagKey(tag)),
    )
    if (stillAssigned) {
      chipErrors.set(
        key,
        `Could not remove “${tag}” from ${characterName || 'this character'} — the tag is still ` +
          'assigned, so nothing was changed. Check the connection and try again.',
      )
    }

    if (!destroyed) render()
  }

  /** One inline tag chip with a removable, busy-aware remove control. */
  const renderCharacterChip = (characterId: string, characterName: string, tag: string): HTMLElement => {
    const key = chipKey(characterId, tag)
    const node = el('span', { class: 'lt-chip' })
    node.appendChild(el('span', { class: 'lt-chip__label' }, [tag]))

    const removeLabel = `Remove tag ${tag} from ${characterName || 'this character'}`
    const remove = button('×', {
      variant: 'ghost',
      ariaLabel: removeLabel,
      title: removeLabel,
    })
    track(
      on(remove, 'click', () => {
        void removeChip(characterId, characterName, tag, remove)
      }),
    )

    // A rebuild mid-write re-creates this button, so the busy state is derived
    // from the module-level in-flight set rather than from a local flag.
    if (chipsInFlight.has(key)) {
      remove.setAttribute('aria-busy', 'true')
      remove.setAttribute('aria-disabled', 'true')
      setDisabled(remove, true)
      remove.textContent = '…'
      remove.title = `Removing ${tag}…`
    }

    node.appendChild(remove)
    return node
  }

  /**
   * One character's tag chips, behind a native `<details>` that scrolls.
   *
   * Why a real `<details>`/`<summary>` and not a click handler on a div: the
   * native element brings the keyboard (Enter/Space), the expanded/collapsed
   * semantics screen readers announce, and the `open` attribute for free, and
   * the summary's own text is the accessible name. Re-implementing that with a
   * `tabindex`, an `aria-expanded` and a boolean would be strictly worse.
   *
   * The chips themselves are bounded by `max-height` + `overflow-y: auto` so
   * that expanding a 50-tag character scrolls instead of re-creating the very
   * wall of chips this collapse exists to remove. Scrolling rather than
   * truncating is the point: no chip is ever unreachable, so no chip can be
   * silently lost.
   *
   * Sizing and the disclosure's appearance are stylesheet rules
   * (`.lt-character-row__tags`, `__tags-summary`, `__chips--scroll` in
   * `styles.ts`) rather than inline styles. The summary stays a UA-default
   * `list-item` rather than a flex row on purpose: a flex <summary> loses its
   * native disclosure triangle in Chromium, which is what tells a closed row
   * from an open one at a glance.
   */
  const renderCharacterTags = (
    id: string,
    displayName: string,
    tags: readonly string[],
    hasChipError: boolean,
  ): HTMLElement => {
    // The reader's explicit choice wins; a recorded failure wins over that,
    // because a collapsed row must never be the reason a failed write looks
    // like it succeeded. An untouched row falls back to the count threshold.
    const remembered = tagRowsExpanded.get(id)
    const open = hasChipError || (remembered ?? tags.length <= COLLAPSE_TAGS_ABOVE)

    const details = el('details', {
      class: 'lt-character-row__tags',
      open: open === true,
      'aria-label': `Tags for ${displayName}`,
    })

    const summary = el('summary', {
      class: 'lt-character-row__tags-summary',
      // A <summary> is natively focusable and operable from the keyboard; an
      // explicit tabindex would only duplicate it, so the default is kept.
      'aria-label': `${tagCountLabel(tags.length)} for ${displayName}${hasChipError ? ', with a removal that failed' : ''}`,
    })
    // Reuse the same count wording as the row badge rather than keeping a
    // second source of truth: collapsed, this line IS the row's tag count.
    summary.appendChild(el('span', { class: 'lt-badge' }, [tagCountLabel(tags.length)]))
    if (hasChipError) {
      // `lt-badge--accent` is the strongest existing badge emphasis; a
      // dedicated `--error` badge is listed in the CSS report for whoever owns
      // `styles.ts`, so this renders correctly either way.
      summary.appendChild(el('span', { class: 'lt-badge lt-badge--accent' }, ['removal failed']))
    }
    // State-neutral wording: the native marker already says which way the
    // disclosure points, and "show tags" would be a lie while it is open.
    summary.appendChild(el('span', { class: 'lt-character-row__sub' }, ['show / hide tags']))
    details.appendChild(summary)

    // Remembering the toggle keeps the row's state across the shell's full
    // rebuilds — without this, adding a tag elsewhere would collapse the row
    // the reader just expanded. `track` keeps it disposable like every other
    // listener in this file.
    track(
      on(details, 'toggle', () => {
        tagRowsExpanded.set(id, details.open)
      }),
    )

    const chips = el('div', {
      class: 'lt-character-row__chips lt-character-row__chips--scroll',
      // The height cap and `overflow-y: auto` live in `.lt-character-row__chips--scroll`
      // in styles.ts: `overflow-y: auto` is what makes a 50-tag character a row
      // again rather than a page, and the height is only a cap, so a 2-tag
      // character is unaffected. A class rather than an inline style so it is
      // overridable and assertable.
    })
    for (const tag of tags) chips.appendChild(renderCharacterChip(id, displayName, tag))
    details.appendChild(chips)

    return details
  }

  const renderCharacterRow = (view: StoreView, row: CharacterListRow): HTMLElement => {
    const id = row.character?.id ?? ''
    const name = row.character?.name ?? ''
    const tags = Array.isArray(row.tags) ? row.tags : []
    const displayName = name === '' ? '(unnamed character)' : name

    const activeKeys = new Set(view.activeFilterTagKeys)
    const carriesActiveFilterTag = tags.some((tag) => activeKeys.has(tagKey(tag)))

    const classes = ['lt-character-row']
    if (row.selected) classes.push('lt-character-row--selected')
    if (carriesActiveFilterTag) classes.push('lt-character-row--active-filter')

    const node = el('div', { class: classes.join(' ') })
    node.setAttribute('role', 'listitem')
    // The stable id is what the selection checkbox and the chip mutations use.
    node.dataset['characterId'] = id
    if (carriesActiveFilterTag) {
      node.setAttribute(
        'aria-label',
        `${displayName}, matches one of the tags the current filter applies to`,
      )
    }

    node.appendChild(
      buildCheckbox(row.selected, `Select character ${displayName} for bulk tag assignment`, (checked) =>
        store.actions.toggleCharacterSelected(id, checked),
      ),
    )
    node.appendChild(avatar(avatarUrl(id), name, 28))

    const main = el('div', { class: 'lt-character-row__main' })
    const title = el('div', { class: 'lt-character-row__title' })
    title.appendChild(el('span', { class: 'lt-character-row__name' }, [displayName]))
    title.appendChild(
      el('span', { class: 'lt-badge' }, [tags.length === 0 ? 'No tags' : tagCountLabel(tags.length)]),
    )
    title.appendChild(el('span', { class: 'lt-badge lt-badge--muted' }, [shortId(id)]))
    main.appendChild(title)

    // Errors are read BEFORE the chips are built because they decide whether
    // the row starts expanded: a failed removal must never be something the
    // reader has to go looking for behind a collapsed disclosure.
    const errors = tags
      .map((tag) => chipErrors.get(chipKey(id, tag)))
      .filter((message): message is string => typeof message === 'string' && message !== '')
    const hasChipError = errors.length > 0

    if (tags.length === 0) {
      main.appendChild(
        el('p', { class: 'lt-character-row__sub' }, [
          'No tags assigned. Select this character and pick tags below to add some.',
        ]),
      )
    } else {
      main.appendChild(renderCharacterTags(id, displayName, tags, hasChipError))
    }

    // Deliberately OUTSIDE the <details>, and an `alert`, so a failed removal
    // is announced and readable whether or not the chips are expanded. The chip
    // it belongs to is still on screen (or one click away inside the scroller);
    // nothing was hidden optimistically and nothing is hidden by this.
    for (const message of errors) {
      main.appendChild(el('p', { class: 'lt-state__detail', role: 'alert' }, [message]))
    }

    node.appendChild(main)
    return node
  }

  // ---------------------------------------------------------------------
  // Character list + its states
  // ---------------------------------------------------------------------

  const renderCharacterList = (view: StoreView): HTMLElement => {
    if (view.characterCount === 0) {
      return emptyState(
        'No characters in your library',
        'LumiTag tags characters that already exist. Create a character in Lumiverse first, then ' +
          'refresh — tags cannot exist before something carries them.',
      )
    }

    const rows = view.characterRows
    if (rows.length === 0) {
      const q = view.characterQuery.trim()
      if (q !== '' || view.activeFilterTagKeys.length > 0 || view.characterTagFilter !== 'all') {
        return emptyState(
          'No characters match your search and filters',
          `${characterCountLabel(view.characterCount)} exist in your library, but none of them match ` +
            `the current query and the “${CHARACTER_TAG_FILTER_LABELS[view.characterTagFilter]}” filter. ` +
            'Widen the search, or switch the filter back to “All characters”.',
        )
      }
      return emptyState(
        'No characters to show',
        `Your library reports ${characterCountLabel(view.characterCount)}, but none are listed here. ` +
          'Try refreshing.',
      )
    }

    const list = sectionEl('lt-list')
    list.setAttribute('role', 'list')
    list.setAttribute('aria-label', 'Characters')

    // Only the current page is rendered; `characterRows` (all matches) stays in
    // the view because Select All and the library-wide operations need it.
    for (const row of view.characterPageRows) list.appendChild(renderCharacterRow(view, row))

    const controls = pager({
      page: view.characterPage,
      pageCount: view.characterPageCount,
      total: rows.length,
      pageSize: CHARACTER_PAGE_SIZE,
      label: 'characters',
      onPage: (page) => store.actions.setCharacterPage(page),
    })
    if (controls) list.appendChild(controls)

    // Below the pager, the filtered-vs-library distinction still has to be
    // stated: a page count says nothing about characters the search excluded.
    if (view.characterCount > rows.length) {
      list.appendChild(
        el('p', { class: 'lt-state__detail' }, [
          `Showing ${rows.length} of ${view.characterCount} characters matching — refine your search ` +
            'to see the rest.',
        ]),
      )
    }

    return list
  }

  // ---------------------------------------------------------------------
  // Bulk tag assignment
  // ---------------------------------------------------------------------

  const renderBulkToolbar = (view: StoreView): HTMLElement => {
    const characterCount = view.selectedCharacterIds.length
    const tagCount = view.selectedAssignTagKeys.length
    const hasCharacters = characterCount > 0
    const hasTags = tagCount > 0

    const banner = el('div', {
      class: 'lt-toolbar__banner',
      role: 'group',
      'aria-label': 'Bulk tag assignment and unassignment controls',
    })
    banner.appendChild(
      el('strong', {}, [
        hasCharacters
          ? `Bulk Tag Assignment — ${characterCountLabel(characterCount)} selected`
          : 'Bulk Tag Assignment',
      ]),
    )
    banner.appendChild(
      el('span', {}, [
        hasCharacters
          ? 'Tick the tags to add or remove. Assignment is ADDITIVE: every selected character keeps ' +
            'the tags it already has, and only the tags it is missing are added. Unassignment is ' +
            'SCOPED: only the selected characters lose the ticked tags, and their other tags are ' +
            'kept. Neither is one undoable step. Your selection spans every page, so what you ticked earlier still counts.'
          : 'No characters are selected yet. Tick a character above, or use “Select All (matching ' +
            'characters)” below, then pick the tags to add or remove. Assignment adds tags; ' +
            'unassignment removes them from the selected characters only. Selection carries across pages.',
      ]),
    )

    const counts = el('div', { class: 'lt-row lt-row--wrap' })
    counts.appendChild(el('span', { class: 'lt-tag-row__meta' }, ['Selected characters:']))
    counts.appendChild(
      el('span', { class: hasCharacters ? 'lt-badge lt-badge--accent' : 'lt-badge lt-badge--muted' }, [
        characterCountLabel(characterCount),
      ]),
    )
    // Selection is global but the list is paged, so say so whenever a selection
    // spans more than the rows on screen — otherwise the count reads as "only
    // what is ticked right here".
    const onThisPage = view.characterPageRows.filter((row) => row.selected).length
    if (characterCount > onThisPage) {
      counts.appendChild(
        el('span', { class: 'lt-tag-row__meta' }, [
          `(${onThisPage} of them ticked on this page)`,
        ]),
      )
    }
    counts.appendChild(el('span', { class: 'lt-tag-row__meta' }, ['Selected tags:']))
    counts.appendChild(
      el('span', { class: hasTags ? 'lt-badge lt-badge--accent' : 'lt-badge lt-badge--muted' }, [
        selectedTagCountLabel(tagCount),
      ]),
    )
    banner.appendChild(counts)

    const actions = el('div', { class: 'lt-toolbar__actions' })

    const selectAll = button('Select All (matching characters)', {
      title:
        'Select every character matching your current search, sort and filters, across ALL pages — ' +
        'not every character in your library. Tags ticked on an earlier page stay ticked.',
      ariaLabel:
        'Select all characters matching the current search across every page, not the whole library',
      onClick: () => store.actions.selectAllVisibleCharacters(),
    })
    setDisabled(selectAll, view.characterRows.length === 0)
    actions.appendChild(selectAll)

    actions.appendChild(
      button('Clear Selection', {
        variant: 'ghost',
        title: 'Unselect every character and every chosen tag',
        onClick: () => {
          store.actions.clearCharacterSelection()
          store.actions.setAssignTagSelection([])
        },
      }),
    )

    const assign = button('Assign Tags', {
      variant: 'primary',
      title: hasCharacters && hasTags
        ? 'Review the additive assignment before anything is written'
        : 'Select at least one character and at least one tag first',
      ariaLabel: 'Review and assign the selected tags to the selected characters',
      onClick: () => requestDialog({ kind: 'bulk_assign_review' }),
    })
    // The dialog owns the review and the confirmation; this control only gates
    // on there being something to assign.
    setDisabled(assign, !(hasCharacters && hasTags))
    actions.appendChild(assign)

    // The mirror of Assign: same selection, same tags, subtracted instead of
    // added. It sits immediately after Assign so the pair reads as add/remove on
    // one shared selection, and it is `secondary`/not-`primary` so the two
    // buttons never look equally weighted.
    const unassign = button('Unassign Tags', {
      variant: 'default',
      title: hasCharacters && hasTags
        ? 'Review the removal before anything is written — only the selected characters lose these tags'
        : 'Select at least one character and at least one tag first',
      ariaLabel:
        'Review and remove the selected tags from the selected characters only, leaving other tags intact',
      onClick: () => requestDialog({ kind: 'bulk_unassign_review' }),
    })
    setDisabled(unassign, !(hasCharacters && hasTags))
    actions.appendChild(unassign)

    banner.appendChild(actions)

    const picker = renderTagPicker({
      title: 'Tags to assign or unassign',
      description:
        'Only tags that already exist can be picked. Characters that already carry a chosen tag ' +
        'are left untouched by an assignment, and characters that do not carry one are left ' +
        'untouched by an unassignment, so re-running either changes nothing.',
      searchSlot: 'assign-tags',
      searchLabel: 'Search existing tags to assign',
      searchValue: pickerQueries.get('assign-tags') ?? '',
      selectedKeys: view.selectedAssignTagKeys,
      groupLabel: 'Existing tags available for assignment',
      emptyMessage:
        'There is nothing to assign yet. A tag only exists while a character carries it — assign one ' +
        'from the Tags section first.',
      onSelectionChange: (keys) => store.actions.setAssignTagSelection(keys),
    })
    banner.appendChild(picker)

    return banner
  }

  // ---------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------

  const render = (): void => {
    if (destroyed) return
    const view = store.view

    // Refresh the intent from the live DOM only when a search box really is
    // focused right now. It must NOT be *cleared* otherwise: the shell mounts
    // a section by destroying the old one and rendering a new one, so by the
    // time this runs the outgoing input is already detached and
    // `document.activeElement` is `<body>` even though the reader never left
    // the search box. The `focus`/`blur` listeners own losing focus.
    const active = document.activeElement as HTMLInputElement | null
    if (active && active.dataset.ltSearch) {
      prevSlot = active.dataset.ltSearch
      prevSlotCaret = active.selectionStart ?? active.value.length
    }

    teardown()
    clear(container)

    // A recorded failure only has meaning while its tag is still assigned; once
    // the chip is gone the entry is dead weight in a module-scope map.
    pruneChipErrors(view)

    const root = sectionEl('lt-box')
    root.appendChild(renderToolbar(view))

    const errors = renderQueryErrors(view)
    if (errors) root.appendChild(errors)

    if (view.loadState === 'loading' && view.characterCount === 0) {
      root.appendChild(spinner('Loading characters…'))
      container.appendChild(root)
      restoreSearchIntents(root)
      return
    }

    root.appendChild(renderActiveFilterPicker(view))

    // Bulk tag assignment block at the top, collapsible
    const bulkHost = el('div', { class: 'lt-bulk-host' })
    const bulkHeader = el('button', { class: 'lt-bulk-host__toggle', type: 'button', 'aria-expanded': 'true', 'aria-label': 'Toggle bulk tag assignment block' })
    bulkHeader.appendChild(
      el('span', { class: 'lt-bulk-host__label' }, ['Bulk Tag Assignment / Unassignment']),
    )
    bulkHeader.appendChild(el('span', { class: 'lt-bulk-host__indicator' }, ['▾']))
    const bulkContent = el('div', { class: 'lt-bulk-host__content' })
    bulkContent.appendChild(renderBulkToolbar(view))
    bulkHost.appendChild(bulkHeader)
    bulkHost.appendChild(bulkContent)
    track(on(bulkHeader, 'click', () => {
      const open = bulkContent.style.display !== 'none'
      bulkContent.style.display = open ? 'none' : ''
      bulkHeader.setAttribute('aria-expanded', open ? 'false' : 'true')
      bulkHeader.querySelector('.lt-bulk-host__indicator')!.textContent = open ? '▸' : '▾'
    }))
    root.appendChild(bulkHost)

    if (view.loadState === 'loading') {
      root.appendChild(spinner('Loading characters…'))
      container.appendChild(root)
      restoreSearchIntents(root)
      return
    }

    root.appendChild(renderCharacterList(view))

    container.appendChild(root)

    restoreSearchIntents(root)
  }

  render()

  return {
    destroy: (): void => {
      if (destroyed) return
      destroyed = true
      teardown()
      // Focus intent, caret and the pickers' typed text are deliberately KEPT:
      // `destroy()` IS the shell's re-render path (it mounts a section by
      // releasing the old one and rendering a new one), so this panel's search
      // box is normally torn down while the reader is still typing in it.
      // Clearing here would make the module header's invariant unachievable —
      // focus would drop on every store commit, i.e. about a second after
      // typing stops, when the search debounce fires. Genuine focus loss is
      // recorded by the `blur` listener in `buildSearch`.
      clear(container)
    },
  }
}
