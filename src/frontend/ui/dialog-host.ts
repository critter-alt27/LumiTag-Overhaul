/**
 * LumiTag dialog host — the app-wide modal infrastructure.
 *
 * This module owns everything about an overlay that is the same for every
 * dialog: WHERE it mounts, how it is dismissed, where focus goes, and how the
 * page behind it behaves. `dialogs.ts` owns WHAT each dialog says and does; it
 * imports {@link openOverlay} and never touches mounting, the focus trap or the
 * opener registry itself.
 *
 * ## The host contract this reproduces
 *
 * Adapted from `Lumiverse/frontend/src/components/shared/ModalShell.tsx`,
 * `ConfirmationModal.module.css` and AUDIT-LUMIVERSE §8:
 *
 *  - **Portalled to `document.body`** — see {@link portalParent} for the
 *    transformed-drawer containing-block trap that makes this mandatory.
 *  - **Backdrop** from `--lumiverse-modal-backdrop`, laid out entirely by
 *    `.lt-dialog-overlay` in `styles.ts` (no inline geometry here).
 *  - **pointerdown → click backdrop guard** — a drag that starts inside the
 *    dialog and releases over the backdrop must NOT dismiss it.
 *  - **Body scroll lock** while at least one overlay is open, matching the
 *    host's `document.body.style.overflow = 'hidden'`.
 *  - **Escape cancels** (never confirms) and **Tab is trapped** inside the
 *    panel; focus returns to whatever opened the dialog.
 *  - **`role="dialog" aria-modal="true"`** wired to the panel's own title, and
 *    to its description paragraph when there is one.
 *  - **A 32×32 close control** at the panel's top-right, the same affordance
 *    `ConfirmationModal` renders.
 *
 * Deliberately NOT reproduced from the host: `ModalShell` has no focus trap and
 * no `role="dialog"` (AUDIT-LUMIVERSE §8.1). LumiTag's dialogs wrap
 * destructive, partially-applied mutations, so the trap and the explicit modal
 * semantics are kept even though the host itself relies on React focus
 * management instead.
 *
 * ## Opener registry
 *
 * {@link requestDialog} is the single entry point the sections use, and
 * {@link setDialogOpener} / {@link clearDialogOpener} are installed once by the
 * composition root (`installDialogHost` in `dialogs.ts`). Before wiring, every
 * request no-ops rather than throwing.
 *
 * Nothing here knows about the store: an overlay is identified only by the
 * drawer tab root it belongs to, so this module stays free of any dependency on
 * `store.ts` and of any import cycle with `dialogs.ts`.
 */

import { button, clear, el, on } from './dom'
import type { DialogRequest } from './shell'

// ---------------------------------------------------------------------------
// Opener registry
// ---------------------------------------------------------------------------

let opener: ((request: DialogRequest) => void) | null = null

/** Installed once by the composition root. */
export function setDialogOpener(fn: (request: DialogRequest) => void): void {
  opener = fn
}

/** Remove the registered opener. Safe to call when none is installed. */
export function clearDialogOpener(): void {
  opener = null
}

/** Opens a dialog. No-ops safely before the app has wired an opener. */
export function requestDialog(request: DialogRequest): void {
  opener?.(request)
}

// ---------------------------------------------------------------------------
// Overlay primitives
// ---------------------------------------------------------------------------

/** The host allows two stacked modals; in-panel overlays follow the same cap. */
export const MAX_STACKED = 2

/** Focusable descendants, in DOM order, for the Tab trap. */
const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',')

/**
 * Geometry the stylesheet does not own.
 *
 * `styles.ts` gives `.lt-btn--icon` the host's 32×32 box, 8px radius and
 * `--fill-subtle` hover, but nothing positions the close control. The host puts
 * it absolutely at 12px/12px with a `--border` hairline
 * (`ConfirmationModal.module.css:17-36`), so those two declarations are applied
 * inline here. Nothing else about the control — size, radius, colour, hover,
 * focus ring — is restated.
 */
const CLOSE_STYLE = 'position:absolute;top:12px;right:12px;'

/**
 * The title's right inset, so a long title wraps BEFORE it can slide under the
 * absolutely positioned close control instead of colliding with it. The host
 * gets this for free from a padded header; our panel has a single padding box.
 */
const TITLE_STYLE = 'padding-right:36px;'

/** `ConfirmationModal` caps a plain confirmation at 420px; the shell default is 560px. */
const NARROW_MAX_WIDTH = '420px'

/**
 * Per-root overlay stacks, so two tabs cannot fight over one global list.
 *
 * The key is still the drawer tab root even though overlays no longer live
 * there: it is the *logical* owner of the dialogs, and the stack is what keeps
 * the MAX_STACKED cap per tab rather than global. Keying it on the portal parent
 * instead would let one extension instance's third dialog close another
 * instance's dialog.
 */
const stacks = new WeakMap<HTMLElement, OverlayHandle[]>()
const scrollLocks = new WeakMap<HTMLElement, number>()

function stackFor(root: HTMLElement): OverlayHandle[] {
  let stack = stacks.get(root)
  if (!stack) {
    stack = []
    stacks.set(root, stack)
  }
  return stack
}

/**
 * Where an overlay is mounted: the document body, NOT the drawer tab root.
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
 * and the drawer tab root we were handed sits inside it.
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
 * The shell owns its tab root and empties it on every store change, which used
 * to wipe an open dialog on any unrelated re-render (typing in the search box
 * mid-dialog closed it). The old workaround re-appended the overlay into that
 * root from a store subscription — which is precisely what dragged it back into
 * the drawer's containing block and produced the off-centre dialog. Mounting on
 * `document.body` fixes both problems at once: the shell does not own
 * `document.body`, so the overlay survives re-renders for free and no
 * subscription (and no observer fighting a reparent) is needed at all.
 *
 * DO NOT "simplify" this back to `root.appendChild(element)`, and do not
 * reintroduce a store-subscription remount: they undo the fix.
 */
export function portalParent(root: HTMLElement): HTMLElement {
  // `ownerDocument` rather than the bare `document`: the overlay must be
  // mounted in the document the host root actually lives in.
  return root.ownerDocument.body
}

/**
 * Stop the page behind the overlay from scrolling, as `ModalShell` does.
 *
 * Counted rather than a bare set/clear pair, because the host allows two
 * stacked modals and a plain "restore on close" would unlock the page while a
 * second overlay was still up. Returns an idempotent release function; a body
 * that cannot carry the declaration (a minimal DOM stub) is a no-op rather than
 * a throw during mount.
 */
function lockBodyScroll(body: HTMLElement): () => void {
  const style = body.style as { overflow?: string } | undefined
  if (style === undefined) return () => {}
  const held = scrollLocks.get(body) ?? 0
  scrollLocks.set(body, held + 1)
  if (held === 0) style.overflow = 'hidden'
  let released = false
  return () => {
    if (released) return
    released = true
    const remaining = (scrollLocks.get(body) ?? 1) - 1
    if (remaining <= 0) {
      scrollLocks.delete(body)
      style.overflow = ''
    } else {
      scrollLocks.set(body, remaining)
    }
  }
}

let titleSeq = 0

export interface OverlayHandle {
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
 * Open an overlay over the VIEWPORT and wire the accessible dialog contract.
 *
 * Mounted on `document.body`, never on the drawer tab root — {@link portalParent}
 * explains the transformed-ancestor containing-block trap that makes an in-drawer
 * mount render off-centre.
 *
 * Both the overlay and the panel are laid out entirely by the stylesheet (see
 * the `.lt-dialog-overlay` / `.lt-dialog` rules in styles.ts). An earlier
 * version inlined a duplicate of every layout declaration, which was both
 * redundant and harmful: an inline declaration beats the stylesheet, so the
 * stylesheet's narrow-viewport rules (tighter overlay padding,
 * `box-sizing: border-box`) could never take effect and the panel kept its
 * content-box width — 22px wider than the padded overlay — and ran off the
 * right edge of a phone screen.
 */
export function openOverlay(
  root: HTMLElement,
  title: string,
  description?: string,
  options: { narrow?: boolean } = {},
): OverlayHandle {
  const stack = stackFor(root)

  // Hard cap: closing the oldest keeps the stack bounded even if a caller
  // ignores the "one dialog at a time" convention.
  while (stack.length >= MAX_STACKED) {
    const oldest = stack.shift()
    oldest?.close()
  }

  const doc = root.ownerDocument
  const restoreTo = doc.activeElement instanceof HTMLElement ? doc.activeElement : null
  const titleId = `lt-dialog-title-${++titleSeq}`
  const descId = `${titleId}-desc`
  const disposers: (() => void)[] = []
  let closed = false
  /** Whether the current press went down on the backdrop (see the click guard). */
  let backdropDown = false

  const messageHost = el('div', { class: 'lt-dialog__messages' })
  const body = el('div', { class: 'lt-dialog__body' })
  const actions = el('div', { class: 'lt-dialog__actions' })

  const panel = el('div', {
    class: 'lt-dialog',
    role: 'dialog',
    'aria-modal': 'true',
    'aria-labelledby': titleId,
    tabindex: '-1',
  })
  const heading = el('h3', { class: 'lt-dialog__title', id: titleId, style: TITLE_STYLE }, [title])
  panel.appendChild(heading)
  if (description !== undefined && description !== '') {
    // The description states the SCOPE of a destructive change, so it is part
    // of the dialog's meaning and is wired as its accessible description
    // rather than left as unannounced body text.
    panel.setAttribute('aria-describedby', descId)
    panel.appendChild(el('p', { class: 'lt-dialog__desc', id: descId }, [description]))
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
      if (kind === 'info') {
        // An informational strip carries no state of its own; muted text, and
        // NOT announced, so it cannot interrupt a screen reader mid-form.
        messageHost.appendChild(el('p', { class: 'lt-dialog__desc' }, [message]))
        return
      }
      // Errors AND warnings are `role="alert"`: a stale-preview warning BLOCKS
      // the action, so it must be announced rather than sit quietly in the panel.
      const state = el('div', {
        class: kind === 'error' ? 'lt-state lt-state--error' : 'lt-toolbar__banner',
        role: 'alert',
      })
      if (kind === 'warning') {
        // A neutral panel carrying a warning-toned lead chip: `styles.ts` has no
        // warning-tinted notice block, and the badge ladder is the sanctioned
        // way to say "this is a warning" without inventing a colour here.
        state.appendChild(el('span', { class: 'lt-badge lt-badge--warning' }, ['Warning']))
      }
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
    releaseScroll()
    element.remove()
    const live = stackFor(root)
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

  // The host's close control. It leads in DOM order so the Tab trap visits it
  // in the same order the eye does, but it is excluded from the INITIAL focus
  // target below: a dialog opens on its first field or action, never on the
  // control that dismisses it.
  const closeButton = button('×', {
    variant: 'icon',
    title: `Close ${title}`,
    ariaLabel: `Close ${title}`,
    onClick: () => close(),
  })
  closeButton.setAttribute('style', CLOSE_STYLE)
  panel.insertBefore(closeButton, heading)

  const focusables = (): HTMLElement[] => [
    ...panel.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR),
  ]

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
      const focusable = focusables()
      if (focusable.length === 0) {
        event.preventDefault()
        return
      }
      const first = focusable[0] as HTMLElement
      const last = focusable[focusable.length - 1] as HTMLElement
      const active = doc.activeElement
      if (event.shiftKey && (active === first || !panel.contains(active))) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && (active === last || !panel.contains(active))) {
        event.preventDefault()
        first.focus()
      }
    }),
    // Backdrop dismissal, with the host's pointerdown → click guard
    // (`ModalShell.tsx:58-73`): the pointer must go down on the backdrop AND
    // come up on it. A drag that starts inside the dialog and slides out over
    // the scrim is a text selection, not a dismissal.
    on(element, 'pointerdown', (ev) => {
      backdropDown = ev.target === element
    }),
    on(element, 'click', (ev) => {
      const dismiss = backdropDown && ev.target === element
      backdropDown = false
      if (dismiss) close()
    }),
  )

  const releaseScroll = lockBodyScroll(portalParent(root))

  // A plain confirmation is a 420px modal in the host (`ModalShell` is called
  // with `maxWidth={420}` by `ConfirmationModal`); everything else keeps the
  // stylesheet's 560px shell default. Applied inline because `styles.ts` owns
  // the width and this file must not add CSS to it — it composes with the
  // stylesheet's `width: min(560px, 100%)` and `max-width: calc(100vw - 40px)`,
  // so the panel still shrinks to the viewport on a phone.
  if (options.narrow === true) panel.style.maxWidth = NARROW_MAX_WIDTH

  // Mounted on document.body, NOT on the drawer tab root — see
  // {@link portalParent} for the containing-block trap that makes this mandatory.
  portalParent(root).appendChild(element)
  stack.push(handle)

  const initial = focusables().find((node) => node !== closeButton) ?? panel
  initial.focus()

  return handle
}

/** Replace a dialog's footer controls. */
export function setActions(handle: OverlayHandle, ...controls: HTMLElement[]): void {
  clear(handle.actions)
  for (const control of controls) handle.actions.appendChild(control)
}

/**
 * Close every overlay belonging to `root`.
 *
 * The overlays are mounted on `document.body` (see {@link portalParent}), not
 * under the tab root, so the host disposer is the ONLY thing that takes them off
 * the page — it must not be skipped, or a teardown leaves dialogs and their
 * listeners behind on the document.
 */
export function closeAllOverlays(root: HTMLElement): void {
  for (const overlay of [...stackFor(root)]) overlay.close()
}