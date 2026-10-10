/**
 * LumiTag composition root.
 *
 * Wires the transport → repository → executor → store → shell chain, injects
 * the stylesheet, registers the drawer tab, and returns a complete, idempotent
 * teardown.
 *
 * Everything that can fail during wiring is guarded, so a host that lacks an
 * optional API degrades to "the panel shows an error state" instead of the tab
 * never appearing at all.
 */

import type { SpindleFrontendContext } from 'lumiverse-spindle-types'

import { MutationExecutor } from './mutations/executor'
import { CharacterRepository } from './repository'
import { SpindleRpc } from './rpc'
import { TagManagerStore } from './store'
import { renderCharactersSection } from './ui/characters-section'
import { requestDialog } from './ui/dialog-host'
import type { DialogHost } from './ui/dialogs'
import { installDialogHost, openDialog as openDialogInHost } from './ui/dialogs'
import { renderFailurePanel } from './ui/failure-panel'
import { renderShell } from './ui/shell'
import { LUMITAG_CSS } from './ui/styles'
import { renderTagsSection } from './ui/tags-section'

/** What every section renderer returns: a disposer for its own listeners. */
type SectionHandle = { destroy(): void }
type SectionRenderer = (options: { container: HTMLElement; store: TagManagerStore }) => SectionHandle

/**
 * Adapter that owns the lifecycle of the sections' DOM and listeners.
 *
 * The shell calls its renderers as bare `(container) => void` on EVERY store
 * change — a keystroke in a search box is a store change — and never calls the
 * `destroy()` the renderers return. Left alone, every re-render would strand a
 * full set of tracked `addEventListener` handles plus the previous subtree.
 *
 * So the composition root does it instead. There are exactly two slots:
 *
 *  - `section` — whichever of {tags, characters} is currently on screen. A
 *    release happens on EVERY section render, not only when the same renderer
 *    runs, so switching tabs releases the outgoing section too.
 *  - `failure` — the sticky report panel, rebuilt on every shell render.
 *
 * Slots are separate on purpose: a renderer's `destroy()` empties its own
 * container, so releasing everything on every mount would erase the section the
 * shell had just rendered.
 */
function createSectionMounter(store: TagManagerStore): {
  mountSection(render: SectionRenderer, container: HTMLElement): void
  mountFailurePanel(render: SectionRenderer, container: HTMLElement): void
  releaseAll(): void
} {
  const slots = new Map<'section' | 'failure', SectionHandle>()

  const release = (slot: 'section' | 'failure'): void => {
    const handle = slots.get(slot)
    if (!handle) return
    slots.delete(slot)
    try {
      handle.destroy()
    } catch {
      // A failing disposer must not strand the other handle or stop the
      // re-render; the shell already emptied the root before calling us.
    }
  }

  const mount = (slot: 'section' | 'failure', render: SectionRenderer, container: HTMLElement): void => {
    release(slot)
    slots.set(slot, render({ container, store }))
  }

  return {
    mountSection: (render, container) => mount('section', render, container),
    mountFailurePanel: (render, container) => mount('failure', render, container),
    releaseAll: () => {
      release('section')
      release('failure')
    },
  }
}

/** Inline 20x20 tag glyph. `iconSvg` and `iconUrl` are mutually exclusive. */
const ICON_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M2.5 10.2 10.2 2.5H17v6.8l-7.7 7.7z"/><circle cx="13.4" cy="6.6" r="1.4"/></svg>'

export function setupApp(ctx: SpindleFrontendContext): () => void {
  const removeStyle = ctx.dom.addStyle(LUMITAG_CSS)

  const tab = ctx.ui.registerDrawerTab({
    id: 'lumitag-tags',
    title: 'LumiTag',
    shortName: 'Tags',
    headerTitle: 'LumiTag',
    description: 'Browse, search, and edit tags across all Lumiverse characters.',
    keywords: ['tags', 'tag manager', 'characters', 'organize', 'bulk', 'merge', 'rename'],
    iconSvg: ICON_SVG,
  })

  const rpc = new SpindleRpc(ctx)
  const repo = new CharacterRepository(rpc)
  const executor = new MutationExecutor(repo)
  const store = new TagManagerStore(repo, executor)

  tab.root.classList.add('lt-app')

  // Every dialog the extension shows — from the shell, from a section, or from a
  // dialog calling into the shell — is routed through the one host built here.
  // `installDialogHost` also makes `requestDialog` (used by the sections) work,
  // and returns a disposer that closes every open overlay on teardown.
  const dialogHost: DialogHost = {
    root: tab.root,
    store,
    confirm: (options) => ctx.ui.showConfirm(options),
  }
  const disposeDialogHost = installDialogHost(dialogHost)

  const sections = createSectionMounter(store)

  const shell = renderShell({
    root: tab.root,
    store,
    renderTagsSection: (container) => sections.mountSection(renderTagsSection, container),
    renderCharactersSection: (container) => sections.mountSection(renderCharactersSection, container),
    renderFailurePanel: (container) => sections.mountFailurePanel(renderFailurePanel, container),
    openDialog: (request) => openDialogInHost(dialogHost, request),
    onShowSearchHelp: (context) => {
      // The dialogs module owns the presentation; the shell only decides when.
      requestDialog({ kind: 'search_help', context })
    },
  })

  ctx.ready?.()
  void store.load()

  let torndown = false
  return () => {
    if (torndown) return
    torndown = true
    // Order matters. Dialogs first: their overlay remounter is subscribed to the
    // store and would otherwise re-append a backdrop into a root the shell is
    // about to empty. Then the sections, while their DOM is still attached.
    // Then the shell itself, which empties the root and unsubscribes.
    disposeDialogHost()
    sections.releaseAll()
    shell.destroy()
    store.dispose()
    tab.destroy()
    removeStyle()
    rpc.dispose()
  }
}