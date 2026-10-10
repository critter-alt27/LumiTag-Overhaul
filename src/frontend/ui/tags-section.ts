/**
 * LumiTag "Tags" section renderer.
 *
 * Owns the toolbar (search, sort, mode toggles, create), the query-error
 * notice, the `C:` character-search panel, the ordinary tag list with its
 * expandable character sub-list, and the bulk-delete / merge mode toolbars.
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
 *     them. The controls that `dom.ts` builds with its own listeners
 *     (`searchInput`, `select`, `checkbox`, `chip`) are therefore NOT used
 *     here; equivalent controls are built below from `el` + tracked `on` so
 *     that nothing outlives the render.
 *  5. **Re-rendering is the shell's job.** `renderShell` clears and rebuilds
 *     the section on every store change, so this renderer does not subscribe
 *     to the store itself (a second subscription would leak one listener per
 *     shell render). `destroy()` is still complete for a standalone caller.
 *  6. **Bounded rendering.** At most {@link ROW_LIMIT} rows are rendered
 *     eagerly; the rest are reported as a count so a huge catalog cannot
 *     freeze the drawer.
 */

import type { StoreView, TagListRow, TagManagerStore, TagMode } from '../store'
import { charactersForTag } from '../tag-index'
import { TAG_SORT_LABELS, TAG_SORT_MODES } from '../tag-sorting'
import type { TagSortMode } from '../tag-sorting'
import { requestDialog } from './dialog-host'
import { avatar, button, clear, el, emptyState, field, on, sectionEl, spinner, text } from './dom'

/** Hard cap on eagerly rendered tag rows. */
const ROW_LIMIT = 500

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
 * Whether the rebuilt search box should take focus back after a re-render.
 *
 * The shell rebuilds the panel from scratch on every store change, which would
 * otherwise drop focus (and the caret) on every keystroke. There is only ever
 * one Tags panel, so module-level intent is enough.
 */
let searchFocusIntent = false
let searchCaret = 0

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

  const buildSelect = (value: TagSortMode, onChange: (v: TagSortMode) => void): HTMLSelectElement => {
    const node = el('select', { class: 'lt-select', 'aria-label': 'Sort tags by' })
    for (const option of SORT_OPTIONS) {
      node.appendChild(el('option', { value: option.value }, [option.label]))
    }
    node.value = value
    track(
      on(node, 'change', () => {
        const next = node.value as TagSortMode
        // An unknown value can only come from a stale DOM; ignore it.
        if (SORT_OPTIONS.some((o) => o.value === next)) onChange(next)
      }),
    )
    return node
  }

  const buildSearch = (value: string, onInput: (v: string) => void): HTMLInputElement => {
    const input = el('input', {
      class: 'lt-search',
      type: 'search',
      'aria-label': 'Search tags. Prefix with C: to search character names instead.',
      placeholder: 'Search tags (C:name searches characters)',
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
        searchFocusIntent = false
      }),
    )
    track(
      on(input, 'keyup', () => {
        searchCaret = input.selectionStart ?? input.value.length
      }),
    )
    return input
  }

  // ---------------------------------------------------------------------
  // Toolbar
  // ---------------------------------------------------------------------

  const renderToolbar = (view: StoreView): HTMLElement => {
    const bar = el('div', { class: 'lt-toolbar', role: 'toolbar', 'aria-label': 'Tag actions' })

    const search = buildSearch(view.tagQuery, (value) => store.actions.setTagQuery(value))
    bar.appendChild(el('div', { class: 'lt-toolbar__grow' }, [field('Search', search)]))

    const sort = buildSelect(view.tagSort, (value) => store.actions.setTagSort(value))
    bar.appendChild(
      field('Sort by', sort, '“Only 0 Characters” lists tags nothing is assigned to'),
    )

    bar.appendChild(
      button('Create Tag', {
        variant: 'primary',
        title: 'Create a new tag and assign it to characters',
        onClick: () => requestDialog({ kind: 'create_tag' }),
      }),
    )

    const actions = el('div', { class: 'lt-toolbar__actions' })
    for (const entry of MODE_BUTTONS) {
      const active = view.tagMode === entry.mode
      const toggle = button(active ? `${entry.label}: On` : `${entry.label}: Off`, {
        variant: active ? 'primary' : 'ghost',
        title: entry.title,
        ariaLabel: `${entry.label} toggle`,
        onClick: () => store.actions.setTagMode(active ? 'normal' : entry.mode),
      })
      // Real buttons, so Enter/Space already work; `aria-pressed` announces the
      // on/off state to a screen reader.
      toggle.setAttribute('aria-pressed', active ? 'true' : 'false')
      actions.appendChild(toggle)
    }

    actions.appendChild(
      button('? Search syntax', {
        variant: 'ghost',
        title: 'Show the search syntax accepted in this section',
        ariaLabel: 'Show search syntax help for the tags section',
        onClick: () => requestDialog({ kind: 'search_help', context: 'tags' }),
      }),
    )
    bar.appendChild(actions)

    if (view.tagMode !== 'normal') {
      bar.appendChild(
        button('Exit mode', {
          variant: 'ghost',
          title: 'Leave the current tag mode and return to browsing',
          onClick: () => store.actions.exitTagMode(),
        }),
      )
    }

    return bar
  }

  /** Give the rebuilt search box its focus and caret back after a re-render. */
  const restoreSearchFocus = (root: HTMLElement): void => {
    if (!searchFocusIntent) return
    const input = root.querySelector('input.lt-search')
    if (!(input instanceof HTMLInputElement)) return
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

  const renderCharacterMode = (view: StoreView): HTMLElement => {
    const panel = sectionEl('lt-box lt-query-errors')
    panel.appendChild(el('p', { class: 'lt-state__title' }, ['Character search mode (C:)']))
    panel.appendChild(
      el('p', { class: 'lt-state__detail' }, [
        'C: searches CHARACTER NAMES, not tag names. The characters below matched by name, with ' +
          'the tags they currently carry. Remove the C: prefix to search tag names again.',
      ]),
    )

    const matches = view.tagQueryCharacters
    if (matches.length === 0) {
      panel.appendChild(
        emptyState(
          'No characters matched',
          'No character name matches this C: search. Tag names are not searched in C: mode, so ' +
            'drop the C: prefix to search tags by name.',
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
      const tags = Array.isArray(entry.tags) ? entry.tags : []
      if (tags.length === 0) untagged.push(name === '' ? '(unnamed character)' : name)

      const item = sectionEl('lt-box lt-character-row')
      item.setAttribute('role', 'listitem')
      item.appendChild(
        el('div', { class: 'lt-row lt-row--wrap' }, [
          avatar(avatarUrl(id), name, 28),
          el('span', { class: 'lt-character-row__name' }, [name === '' ? '(unnamed character)' : name]),
          el('span', { class: 'lt-badge lt-badge--muted' }, [shortId(id)]),
          el('span', { class: 'lt-badge' }, [tagCountLabel(tags.length)]),
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

    const shown = Math.min(rows.length, ROW_LIMIT)
    for (const row of rows.slice(0, shown)) {
      list.appendChild(renderTagRow(view, row))
      if (row.expanded) {
        const expanded = renderExpanded(view, row)
        if (expanded) list.appendChild(expanded)
      }
    }

    if (rows.length > shown) {
      list.appendChild(
        el('p', { class: 'lt-state__detail' }, [
          `Showing ${shown} of ${rows.length} — refine your search to see the rest.`,
        ]),
      )
    }

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
      const targetBox = buildCheckbox(isTarget, `Merge ${entry.name} into the primary tag`, () =>
        store.actions.toggleMergeTarget(entry.key),
      )
      if (isSelfTarget) {
        targetBox.disabled = true
        targetBox.setAttribute('aria-disabled', 'true')
        targetBox.title = 'The primary tag cannot be merged into itself'
      }
      node.appendChild(targetBox)
    } else if (mode === 'bulk_delete') {
      node.appendChild(
        buildCheckbox(row.selected, `Select tag ${entry.name} for deletion`, (checked) =>
          store.actions.toggleTagSelected(entry.key, checked),
        ),
      )
    }

    // --- expand / collapse -------------------------------------------------
    node.appendChild(
      button(row.expanded ? '▾' : '▸', {
        variant: 'ghost',
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
    if (isPrimary) main.appendChild(el('span', { class: 'lt-badge lt-badge--accent' }, ['Primary']))
    if (isTarget) main.appendChild(el('span', { class: 'lt-badge' }, ['Merge target']))
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
    actions.appendChild(
      button('Delete', {
        variant: 'danger',
        title: `Delete ${entry.name} from every character that carries it`,
        ariaLabel: `Delete tag ${entry.name}`,
        onClick: () => requestDialog({ kind: 'delete_tags', tags: [entry.name] }),
      }),
    )
    node.appendChild(actions)

    return node
  }

  /** The characters assigned to an expanded tag, resolved by id, never by name. */
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
        el('span', { class: 'lt-badge lt-badge--muted' }, [shortId(id)]),
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

  const renderBulkToolbar = (view: StoreView): HTMLElement => {
    const banner = el('div', {
      class: 'lt-toolbar__banner',
      role: 'group',
      'aria-label': 'Bulk delete controls',
    })
    banner.appendChild(
      el('strong', {}, [
        `Bulk Delete Mode — ${view.selectedTagCount} ${
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
    actions.appendChild(
      button('Cancel / Exit Bulk Delete Mode', {
        variant: 'ghost',
        title: 'Leave bulk delete mode without deleting anything',
        onClick: () => store.actions.exitTagMode(),
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
    del.disabled = selectedNames.length === 0
    del.setAttribute('aria-disabled', selectedNames.length === 0 ? 'true' : 'false')
    actions.appendChild(del)

    banner.appendChild(actions)
    return banner
  }

  // ---------------------------------------------------------------------
  // Merge mode
  // ---------------------------------------------------------------------

  const renderMergeToolbar = (view: StoreView): HTMLElement => {
    const banner = el('div', {
      class: 'lt-toolbar__banner',
      role: 'group',
      'aria-label': 'Merge controls',
    })
    banner.appendChild(el('strong', {}, ['Merge Mode']))
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
        ? el('span', { class: 'lt-badge lt-badge--muted' }, ['no primary tag chosen'])
        : el('span', { class: 'lt-badge lt-badge--accent' }, [`primary: ${primaryName}`]),
    )
    if (targetNames.length === 0) {
      summary.appendChild(el('span', { class: 'lt-badge lt-badge--muted' }, ['no targets chosen']))
    } else {
      for (const name of targetNames) {
        summary.appendChild(el('span', { class: 'lt-badge' }, [`target: ${name}`]))
      }
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
    merge.disabled = !view.mergeValid
    merge.setAttribute('aria-disabled', view.mergeValid ? 'false' : 'true')
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

    teardown()
    clear(container)

    const root = sectionEl('lt-box')
    root.appendChild(renderToolbar(view))

    const errors = renderQueryErrors(view)
    if (errors) root.appendChild(errors)

    if (view.loadState === 'loading') {
      root.appendChild(spinner('Loading tags…'))
      container.appendChild(root)
      return
    }

    if (view.tagMode === 'bulk_delete') root.appendChild(renderBulkToolbar(view))
    else if (view.tagMode === 'merge') root.appendChild(renderMergeToolbar(view))

    // In `C:` mode the tag list is deliberately NOT rendered, and there is no
    // fallback to a tag-name search: the panel below explains why.
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
      searchFocusIntent = false
      teardown()
      clear(container)
    },
  }
}