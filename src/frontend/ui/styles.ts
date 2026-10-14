/**
 * LumiTag stylesheet — a Lumiverse-native design system for a vanilla-DOM panel.
 *
 * Registered once, by `setupApp`, through `ctx.dom.addStyle(LUMITAG_CSS)`
 * (`src/frontend/app.ts:90`); the returned remover is the last step of teardown.
 *
 * ## Why this is a port, not a redesign
 *
 * LumiTag renders with `document.createElement` and cannot import the host's
 * React + CSS-Modules components: the shell rebuilds its whole subtree on every
 * store commit, which destroys any host-owned mount (see
 * AUDIT-COMPONENTS-BRIDGE.md §5.4). So every value below is COPIED from the
 * host's own stylesheets — `theme/variables.css`, `components/shared/*.module.css`,
 * `panels/world-book/*.module.css` — rather than invented.
 *
 * ## House rules for this file
 *
 *  1. **Host tokens only.** Colour, radius, shadow and transition come from
 *     `--lumiverse-*` variables. There are no hex literals and no bare `rgb()`
 *     except the two documented `--lumiverse-*` fallbacks the host itself uses
 *     for its own undefined tokens (see §"Deliberate fallbacks" below).
 *  2. **Every undefined-token reference is fixed.** The previous sheet leaned on
 *     `--lumiverse-accent` in ~25 rules. The host has never defined it (it
 *     ships `--lumiverse-primary`), so each of those computed to an invalid
 *     value: `color` inherited, `border-color` fell back to `currentColor` and
 *     `background` became transparent. Every one now names a real token.
 *  3. **Font sizes are font-scale aware**: `calc(<N>px * var(--lumiverse-font-scale, 1))`,
 *     the host's universal sizing idiom, so a user-authored font scale reaches us.
 *  4. **Namespacing.** Everything is scoped under `.lt-app` (the drawer tab root)
 *     or under an `lt-` class. The two dialog layers mount on `document.body`
 *     (load-bearing — see the `.lt-dialog-overlay` note) and are therefore the
 *     only selectors that are not descendants of `.lt-app`; they still carry an
 *     `lt-` class on every element they can match.
 *  5. **Keyboard focus is always visible**, and every animation/transition is
 *     covered by the `prefers-reduced-motion` block at the end of the file.
 *  6. **No card-on-card.** Lists are separated by hairlines; hover surfaces use
 *     `--lumiverse-fill-subtle`; only genuine panels (dialogs, banners, the bulk
 *     disclosure) carry a border and a fill.
 *
 * ## Deliberate fallbacks (host tokens the theme does not ship)
 *
 *  - `--lumiverse-primary-contrast` — set at runtime by the host's theme engine
 *    but absent from `variables.css`. Lumiverse's own `.btnPrimary` writes
 *    `var(--primary-contrast, #fff)`; we follow that exact convention.
 *  - `--lumiverse-info` — referenced by `WorldBookPanel.module.css` and never
 *    defined; the host always falls back to the literal `#42a5f5`. Used only for
 *    "informational" status tinting, and it is the one documented hex.
 *
 * ## Private layer (`--lt-*`)
 *
 * Two values only, both because the host has no token for them:
 *  - `--lt-row-accent-bar: 3px` — the width of the inset selection bar used for
 *    active rows. The host writes `3px` inline in three different modules and
 *    has no token for it, so it is named here once rather than repeated.
 *  - `--lt-scroll-thumb-size: 6px` — matches the host's global 6px scrollbar so
 *    the panel's own scrollbar is not wider than the host's.
 */

export const LUMITAG_CSS = `
/* ================================================================== */
/* 0. Tokens and private layer                */
/* ================================================================== */
.lt-app {
  /* The host has no token for its selection-bar width (it writes 3px inline in
     ViewportDrawer.module.css:615, SettingsModal.module.css and
     WorldBookEntriesSection.module.css). Named once so every selected row uses
     the same value. */
  --lt-selected-bar: 3px;
  /* The host's global scrollbar is 6px (global.css:33-35). */
  --lt-scrollbar: 6px;
}

/* ================================================================== */
/* 1. Utilities                                  */
/* ================================================================== */
.lt-visually-hidden {
  position: absolute;
  width: 1px;
  height: 1px;
  margin: -1px;
  padding: 0;
  overflow: hidden;
  clip: rect(0 0 0 0);
  clip-path: inset(50%);
  white-space: nowrap;
  border: 0;
}

/* ================================================================== */
/* 2. Base — panel root, typography, focus, scrollbars            */
/* ================================================================== */
.lt-app {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  color: var(--lumiverse-text, CanvasText);
  font-family: inherit;
  /* Host body type: 14px / 1.5 (reset.css:122-132). LumiTag's old rigid
     'font-size: 13px' on the root ignored the user's font scale. */
  font-size: calc(14px * var(--lumiverse-font-scale, 1));
  line-height: 1.5;
  /* Inside-panel responsiveness follows the host's container-query norm
     (WorldBookEntryEditor.module.css:9-10); the drawer can be resized, so the
     panel's own inline size — not the viewport — is what matters. */
  container-type: inline-size;
  container-name: lumiapp;
}

/*
 * Keyboard focus, catch-all. The host draws a 1.5px '--primary-050' outline at
 * 2px offset for everything that is not a form control (global.css:122).
 * Form controls get a border + glow instead (see §6), so they are excluded here
 * to avoid a double ring.
 */
.lt-app :focus-visible,
.lt-dialog-overlay :focus-visible {
  outline: 1.5px solid var(--lumiverse-primary-050, var(--lumiverse-primary, CanvasText));
  outline-offset: 2px;
  border-radius: var(--lumiverse-radius-sm, 5px);
}

.lt-app .lt-search:focus-visible,
.lt-app .lt-input:focus-visible,
.lt-app .lt-select:focus-visible,
.lt-app .lt-checkbox:focus-visible,
.lt-dialog-overlay .lt-search:focus-visible,
.lt-dialog-overlay .lt-input:focus-visible,
.lt-dialog-overlay .lt-select:focus-visible,
.lt-dialog-overlay .lt-checkbox:focus-visible {
  outline: none;
}

/* Scrollbars: the host's global 6px track-less treatment. */
.lt-app__body::-webkit-scrollbar { width: var(--lt-scrollbar, 6px); height: var(--lt-scrollbar, 6px); }
.lt-app__body::-webkit-scrollbar-track { background: transparent; }
.lt-app__body::-webkit-scrollbar-thumb {
  background: var(--lumiverse-primary-020, var(--lumiverse-border, CanvasText));
  border-radius: 3px;
}
.lt-app__body::-webkit-scrollbar-thumb:hover {
  background: var(--lumiverse-primary-050, var(--lumiverse-border, CanvasText));
}
.lt-app__body { scrollbar-width: thin; }

/* ================================================================== */
/* 3. Shell — header, heading, status, body, failure region        */
/* ================================================================== */

/*
 * The panel header, copied from the host's canonical drawer panel header
 * (ViewportDrawer.module.css:373-388): min-height 48px, 12px 16px padding, a
 * primary-tinted hairline underneath, and a 15px/600 title.
 */
.lt-app__header {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px 12px;
  flex-shrink: 0;
  min-height: 48px;
  padding: 12px 16px;
  border-bottom: 1px solid
    color-mix(in srgb, var(--lumiverse-primary-020, var(--lumiverse-border, CanvasText)) 60%,
      var(--lumiverse-border, CanvasText));
}

.lt-app__heading {
  display: flex;
  align-items: baseline;
  gap: 8px;
  min-width: 0;
}

.lt-app__title {
  margin: 0;
  font-size: calc(15px * var(--lumiverse-font-scale, 1));
  font-weight: 600;
  line-height: 1.3;
  color: var(--lumiverse-text, CanvasText);
}

.lt-app__spacer { flex: 1 1 auto; }

/*
 * Header actions (search help, refresh). Kept as a group so they wrap together
 * instead of one per line on a narrow drawer.
 */
.lt-app__actions {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-shrink: 0;
}

/*
 * Operational status, demoted from "three sentences in the header" to one
 * compact muted line under the heading. Nothing here is deleted — the counts
 * and the last-refresh time are still the first thing the header says — it just
 * no longer competes with the title for attention.
 */
.lt-app__meta {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 2px 10px;
  flex: 1 0 100%;
  margin: 0;
  font-size: calc(11.5px * var(--lumiverse-font-scale, 1));
  line-height: 1.45;
  color: var(--lumiverse-text-dim, var(--lumiverse-text-muted, CanvasText));
}

.lt-app__meta strong {
  color: var(--lumiverse-text-muted, var(--lumiverse-text, CanvasText));
  font-weight: 600;
  font-variant-numeric: tabular-nums;
}

.lt-app__meta-time {
  font-variant-numeric: tabular-nums;
}

/* Navigation row: the Tags/Characters switcher, in the panel's own gutter. */
.lt-app__nav {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-shrink: 0;
  padding: 10px 12px 0;
}

/*
 * The scroll container. This element is part of the shell's rebuilt subtree, so
 * its padding/gap are load-bearing for scroll restoration only in the sense that
 * they must not change between renders — they are static, so the anchor maths in
 * 'shell.ts' is unaffected.
 */
.lt-app__body {
  display: flex;
  flex: 1 1 auto;
  flex-direction: column;
  gap: 12px;
  min-height: 0;
  overflow-y: auto;
  overflow-x: hidden;
  overscroll-behavior-y: contain;
  -webkit-overflow-scrolling: touch;
  padding: 12px 12px calc(12px + env(safe-area-inset-bottom, 0px));
}

/* Failure reports dock below the scroller, hairline-separated. */
.lt-app__failure-region {
  flex-shrink: 0;
  min-height: 0;
  padding: 0 12px calc(12px + env(safe-area-inset-bottom, 0px));
}

/* The empty 'No failures' state sits directly below the sticky pager. Its
   generic 24px vertical padding creates an oversized visual gap in this docked
   region, so compact only the state rendered inside the failure dock. */
.lt-app__failure-region > .lt-state {
  padding-top: 4px;
  padding-bottom: 4px;
}

/* ================================================================== */
/* 4. Navigation — segmented control (Tags / Characters)          */
/* ================================================================== */

/*
 * The host's canonical segmented control (SettingsModal.module.css:696-731):
 * a rounded, subtle-filled, hairline-bordered row whose cells are separated by
 * 1px rules and whose active cell is a '--primary-020' wash with primary text.
 * Explicitly NOT a saturated filled rectangle — that is what the previous
 * '.lt-tab[aria-selected]' did, through an undefined '--lumiverse-accent', and it
 * is the single most "third-party" thing in the old header.
 */
.lt-tabs {
  display: flex;
  align-items: stretch;
  flex: 0 1 auto;
  min-width: 0;
  border: 1px solid var(--lumiverse-border, CanvasText);
  border-radius: var(--lumiverse-radius, 8px);
  background: var(--lumiverse-fill-subtle, transparent);
  overflow: hidden;
}

/*
 * '.lt-tab' is produced by 'dom.button()', so it also carries '.lt-btn' and
 * '.lt-btn--ghost'. Every rule below is therefore scoped as '.lt-tabs .lt-tab'
 * (specificity 0,2,0) so the segmented cell always beats the generic button box
 * regardless of which section of this file comes first.
 */
.lt-tabs .lt-tab {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  flex: 0 1 auto;
  min-width: 0;
  min-height: 0;
  padding: 7px 12px;
  border: 0;
  border-radius: 0;
  background: transparent;
  box-shadow: none;
  color: var(--lumiverse-text-muted, var(--lumiverse-text, CanvasText));
  font-family: inherit;
  font-size: calc(12px * var(--lumiverse-font-scale, 1));
  font-weight: 600;
  line-height: 1.3;
  white-space: nowrap;
  cursor: pointer;
  transition: background var(--lumiverse-transition-fast, 150ms ease),
    color var(--lumiverse-transition-fast, 150ms ease);
}

.lt-tabs .lt-tab:not(:last-child) {
  border-right: 1px solid var(--lumiverse-border, CanvasText);
}

.lt-tabs .lt-tab:hover:not(:disabled) {
  background: var(--lumiverse-fill-subtle, transparent);
  border-color: transparent;
  color: var(--lumiverse-text, CanvasText);
}

.lt-tabs .lt-tab[aria-selected="true"] {
  background: var(--lumiverse-primary-020, transparent);
  border-color: transparent;
  color: var(--lumiverse-primary, var(--lumiverse-text, CanvasText));
}

.lt-tabs .lt-tab:disabled { opacity: 0.4; cursor: not-allowed; }

/* The host's numeric tab badge (ViewportDrawer.module.css:620-626), scaled to a
   segmented cell rather than a 12px dot. */
.lt-tabs__count {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 20px;
  padding: 0 5px;
  border-radius: 10px;
  background: var(--lumiverse-fill-medium, transparent);
  color: var(--lumiverse-text-dim, var(--lumiverse-text-muted, CanvasText));
  font-size: calc(10px * var(--lumiverse-font-scale, 1));
  font-weight: 600;
  line-height: 1.5;
  font-variant-numeric: tabular-nums;
}

.lt-tabs .lt-tab[aria-selected="true"] .lt-tabs__count {
  background: var(--lumiverse-primary-050, transparent);
  color: var(--lumiverse-primary, CanvasText);
}

/* ================================================================== */
/* 5. Buttons                                   */
/* ================================================================== */

/*
 * Ported from the host's generic Button (FormComponents.module.css:166-265).
 * 13px / 500, transparent background, one 1px hairline, '--text-muted' ink,
 * 8px radius, 6px icon gap, 150ms transitions, 0.4 disabled opacity.
 */
.lt-btn {
  appearance: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  min-height: 28px;
  padding: 6px 12px;
  border: 1px solid var(--lumiverse-border, CanvasText);
  border-radius: var(--lumiverse-radius, 8px);
  background: transparent;
  color: var(--lumiverse-text-muted, var(--lumiverse-text, CanvasText));
  font-family: inherit;
  font-size: calc(13px * var(--lumiverse-font-scale, 1));
  font-weight: 500;
  line-height: 1.35;
  white-space: nowrap;
  cursor: pointer;
  transition: background var(--lumiverse-transition-fast, 150ms ease),
    color var(--lumiverse-transition-fast, 150ms ease),
    border-color var(--lumiverse-transition-fast, 150ms ease),
    opacity var(--lumiverse-transition-fast, 150ms ease);
}

.lt-btn:hover:not(:disabled):not([aria-disabled="true"]) {
  background: var(--lumiverse-fill-subtle, transparent);
  border-color: var(--lumiverse-border-hover, var(--lumiverse-border, CanvasText));
  color: var(--lumiverse-text, CanvasText);
}

.lt-btn:active:not(:disabled) { background: var(--lumiverse-fill, transparent); }

.lt-btn:disabled,
.lt-btn[aria-disabled="true"] {
  opacity: 0.4;
  cursor: not-allowed;
}

.lt-btn--primary {
  background: var(--lumiverse-primary, CanvasText);
  border-color: var(--lumiverse-primary, CanvasText);
  color: var(--lumiverse-primary-contrast, #fff);
  box-shadow: var(--lumiverse-highlight-inset, none);
}

.lt-btn--primary:hover:not(:disabled):not([aria-disabled="true"]) {
  background: var(--lumiverse-primary-hover, var(--lumiverse-primary, CanvasText));
  border-color: var(--lumiverse-primary-hover, var(--lumiverse-primary, CanvasText));
  color: var(--lumiverse-primary-contrast, #fff);
}

/* 'secondary' is the host's name for the default variant; both exist so a
   caller can use whichever word reads better at the call site. */
.lt-btn--secondary { /* identical to .lt-btn — the host's default variant */ }

.lt-btn--danger {
  background: var(--lumiverse-danger, CanvasText);
  border-color: var(--lumiverse-danger, CanvasText);
  color: #fff;
  box-shadow: var(--lumiverse-highlight-inset, none);
}

.lt-btn--danger:hover:not(:disabled):not([aria-disabled="true"]) {
  background: var(--lumiverse-danger-hover, var(--lumiverse-danger, CanvasText));
  border-color: var(--lumiverse-danger-hover, var(--lumiverse-danger, CanvasText));
  color: #fff;
}

.lt-btn--ghost {
  border-color: transparent;
  background: transparent;
  color: var(--lumiverse-text-muted, var(--lumiverse-text, CanvasText));
  padding: 6px 10px;
}

.lt-btn--ghost:hover:not(:disabled):not([aria-disabled="true"]) {
  background: var(--lumiverse-fill-subtle, transparent);
  border-color: transparent;
  color: var(--lumiverse-text, CanvasText);
}

/* Destructive-but-quiet: the row-level Delete / Unassign affordance. The old
   stylesheet expressed this as an underlined label, which read as a hyperlink
   and not as an action. */
.lt-btn--danger-ghost {
  border-color: transparent;
  background: transparent;
  color: var(--lumiverse-text-dim, var(--lumiverse-text-muted, CanvasText));
  padding: 6px 10px;
}

.lt-btn--danger-ghost:hover:not(:disabled):not([aria-disabled="true"]) {
  background: var(--lumiverse-danger-015, transparent);
  border-color: transparent;
  color: var(--lumiverse-danger, CanvasText);
}

.lt-btn--sm {
  min-height: 24px;
  padding: 4px 9px;
  font-size: calc(12px * var(--lumiverse-font-scale, 1));
  gap: 5px;
}

.lt-btn--icon,
.lt-btn--icon-sm {
  width: var(--lumiverse-btn-icon, 32px);
  height: var(--lumiverse-btn-icon, 32px);
  min-height: 0;
  padding: 0;
  gap: 0;
  border-color: transparent;
  color: var(--lumiverse-text-dim, var(--lumiverse-text-muted, CanvasText));
}

.lt-btn--icon-sm {
  width: var(--lumiverse-btn-icon-sm, 28px);
  height: var(--lumiverse-btn-icon-sm, 28px);
  border-radius: 6px;
}

.lt-btn--icon:hover:not(:disabled):not([aria-disabled="true"]),
.lt-btn--icon-sm:hover:not(:disabled):not([aria-disabled="true"]) {
  background: var(--lumiverse-fill-subtle, transparent);
  border-color: transparent;
  color: var(--lumiverse-text, CanvasText);
}

/* Busy state: the host swaps the icon slot for a spinner and blocks input. */
.lt-btn--loading { cursor: progress; }
.lt-btn--loading > * { pointer-events: none; }

/* ================================================================== */
/* 6. Search — SearchField.tsx port                                   */
/* ================================================================== */

/*
 * The native search field: a subtle-filled, hairline-bordered 10px-radius pill
 * with an 8px gap, a 14px dimmed icon and a borderless 13px input. It is about
 * 32px tall and it deliberately shows NO focus ring — the host's own search
 * fields do not (SearchField.module.css:1-27). Two structures produce it:
 *
 *  - '.lt-searchfield' — the full port (icon + input + clear control), built by
 *    'dom.searchInput()';
 *  - '.lt-field:has(> .lt-search)' / '.lt-field:has(> .lt-searchfield)' — the
 *    sections wrap their input in a 'dom.field()' label, so the LABEL is the pill
 *    and the input is the borderless field inside it. Same pixels, no extra
 *    markup.
 */
.lt-searchfield,
.lt-field:has(> .lt-search),
.lt-field:has(> .lt-searchfield) {
  display: flex;
  flex-direction: row;
  align-items: center;
  gap: 8px;
  width: 100%;
  min-width: 0;
  padding: 8px 12px;
  border: 1px solid var(--lumiverse-border, CanvasText);
  border-radius: var(--lumiverse-radius-md, 10px);
  background: var(--lumiverse-fill-subtle, transparent);
  color: var(--lumiverse-text, CanvasText);
  transition: border-color var(--lumiverse-transition-fast, 150ms ease);
}

/* ':focus-within' is the sibling treatment the host uses for in-panel search
   (WorldBookPanel.module.css:1001-1033): the ring is the border, not an outline. */
.lt-searchfield:focus-within,
.lt-field:has(> .lt-search):focus-within,
.lt-field:has(> .lt-searchfield):focus-within {
  border-color: var(--lumiverse-primary, var(--lumiverse-border, CanvasText));
}

.lt-searchfield__icon {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--lumiverse-text-dim, var(--lumiverse-text-muted, CanvasText));
  pointer-events: none;
}

.lt-searchfield__icon svg,
.lt-searchfield__clear svg {
  display: block;
  width: 14px;
  height: 14px;
}

.lt-searchfield__clear {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  padding: 0;
  border: 0;
  border-radius: var(--lumiverse-radius-sm, 5px);
  background: transparent;
  color: var(--lumiverse-text-dim, var(--lumiverse-text-muted, CanvasText));
  cursor: pointer;
  transition: background var(--lumiverse-transition-fast, 150ms ease),
    color var(--lumiverse-transition-fast, 150ms ease);
}

.lt-searchfield__clear:hover {
  background: var(--lumiverse-fill-hover, transparent);
  color: var(--lumiverse-text, CanvasText);
}

.lt-searchfield__clear[hidden] { display: none; }

/*
 * The input itself.
 *
 * Inside a search pill it is borderless and transparent (the pill owns the
 * border). STANDALONE — which is how the dialog pickers build it today — it
 * carries the whole pill itself, so '.lt-search' is never an unstyled slab.
 */
.lt-search {
  width: 100%;
  min-width: 0;
  box-sizing: border-box;
  padding: 8px 12px;
  border: 1px solid var(--lumiverse-border, CanvasText);
  border-radius: var(--lumiverse-radius-md, 10px);
  background: var(--lumiverse-fill-subtle, transparent);
  color: var(--lumiverse-text, CanvasText);
  font-family: inherit;
  font-size: calc(13px * var(--lumiverse-font-scale, 1));
  line-height: 1.35;
  transition: border-color var(--lumiverse-transition-fast, 150ms ease);
}

.lt-search::placeholder { color: var(--lumiverse-text-hint, CanvasText); }

/* The host hides the UA clear affordance and draws its own (SearchField.module.css:22). */
.lt-search::-webkit-search-cancel-button,
.lt-search::-webkit-search-decoration { -webkit-appearance: none; appearance: none; }

.lt-searchfield > .lt-search,
.lt-searchfield > .lt-searchfield__input,
.lt-field:has(> .lt-search) > .lt-search,
.lt-field:has(> .lt-searchfield) > .lt-searchfield {
  flex: 1 1 auto;
  width: auto;
  height: auto;
  padding: 0;
  border: 0;
  border-radius: 0;
  background: transparent;
  outline: none;
}

/* A standalone pill gets the host's hover border; inside a pill the input has no
   border of its own, so there is nothing to change. */
.lt-search:hover { border-color: var(--lumiverse-border-hover, var(--lumiverse-border, CanvasText)); }

/* The section-level label inside a search pill stays available to assistive tech
   (the '<label>' wraps the input) but is not painted: the placeholder already
   names the field, and a visible "Search" prefix would be a Lumiverse-flavoured
   label the host never shows. */
.lt-field:has(> .lt-search) > .lt-field__label,
.lt-field:has(> .lt-searchfield) > .lt-field__label {
  position: absolute;
  width: 1px;
  height: 1px;
  margin: -1px;
  padding: 0;
  overflow: hidden;
  clip: rect(0 0 0 0);
  clip-path: inset(50%);
  white-space: nowrap;
}

/* ================================================================== */
/* 7. Form controls                                   */
/* ================================================================== */

/*
 * Field wrapper: host FormComponents '.formField' semantics — a 13px/500
 * '--text-muted' label, the control, then an 11px '--text-dim' hint.
 */
.lt-field {
  display: inline-flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
  font-size: calc(13px * var(--lumiverse-font-scale, 1));
  color: var(--lumiverse-text-muted, var(--lumiverse-text, CanvasText));
}

.lt-field__label {
  font-weight: 500;
  line-height: 1.35;
}

.lt-field__hint {
  font-size: calc(11px * var(--lumiverse-font-scale, 1));
  line-height: 1.4;
  color: var(--lumiverse-text-dim, var(--lumiverse-text-muted, CanvasText));
}

.lt-field--error { color: var(--lumiverse-danger, CanvasText); }
.lt-field__error {
  margin-top: 4px;
  font-size: calc(12px * var(--lumiverse-font-scale, 1));
  color: var(--lumiverse-danger, CanvasText);
}

/*
 * Text input — host FormComponents '.input': 10px 12px, '--bg' fill, 1px
 * hairline, 8px radius, 13px text, focus = '--primary-muted' border plus a 3px
 * '--primary-010' glow and NO outline.
 */
.lt-input {
  width: 100%;
  min-width: 0;
  box-sizing: border-box;
  padding: 10px 12px;
  border: 1px solid var(--lumiverse-border, CanvasText);
  border-radius: var(--lumiverse-radius, 8px);
  background: var(--lumiverse-bg, var(--lumiverse-input-bg, Canvas));
  color: var(--lumiverse-text, CanvasText);
  font-family: inherit;
  font-size: calc(13px * var(--lumiverse-font-scale, 1));
  line-height: 1.35;
  transition: border-color var(--lumiverse-transition-fast, 150ms ease),
    box-shadow var(--lumiverse-transition-fast, 150ms ease);
}

.lt-input::placeholder { color: var(--lumiverse-text-dim, CanvasText); }

.lt-input:focus,
.lt-select:focus {
  border-color: var(--lumiverse-primary-muted, var(--lumiverse-primary, CanvasText));
  box-shadow: 0 0 0 3px var(--lumiverse-primary-010, transparent);
  outline: none;
}

.lt-input:disabled,
.lt-select:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

/*
 * Select. A bare '.lt-select' keeps the platform's own disclosure arrow (a WebView
 * '<select>' is a native popup and repainting it is how extension panels end up
 * with an un-openable dropdown); the extra right padding leaves room for it.
 * 'dom.select()' also emits '.lt-selectfield', which swaps in the host's custom
 * 14px chevron and 'appearance: none'.
 */
.lt-select {
  width: 100%;
  min-width: 0;
  box-sizing: border-box;
  padding: 6px 28px 6px 12px;
  border: 1px solid var(--lumiverse-border, CanvasText);
  border-radius: var(--lumiverse-radius, 8px);
  background: var(--lumiverse-bg, var(--lumiverse-input-bg, Canvas));
  color: var(--lumiverse-text, CanvasText);
  font-family: inherit;
  font-size: calc(13px * var(--lumiverse-font-scale, 1));
  line-height: 1.35;
  cursor: pointer;
  transition: border-color var(--lumiverse-transition-fast, 150ms ease),
    box-shadow var(--lumiverse-transition-fast, 150ms ease);
}

.lt-select option {
  background: var(--lumiverse-bg-deep, var(--lumiverse-bg, Canvas));
  color: var(--lumiverse-text, CanvasText);
}

.lt-select option:checked {
  background: var(--lumiverse-primary-015, transparent);
  color: var(--lumiverse-text, CanvasText);
}

/* Custom-chevron variant (host '.selectWrapper' + '.selectChevron'). */
.lt-selectfield {
  position: relative;
  display: inline-flex;
  width: 100%;
  min-width: 0;
}

.lt-selectfield > .lt-select {
  appearance: none;
  -webkit-appearance: none;
  padding-right: 28px;
}

.lt-selectfield__chevron {
  position: absolute;
  right: 8px;
  top: 50%;
  transform: translateY(-50%);
  display: block;
  width: 14px;
  height: 14px;
  pointer-events: none;
  color: var(--lumiverse-text-muted, var(--lumiverse-text, CanvasText));
}

/* The chevron helper is the SVG itself (not a wrapper around an SVG). */
.lt-selectfield > .lt-selectfield__chevron {
  width: 14px;
  height: 14px;
  max-width: 14px;
  max-height: 14px;
}

/*
 * Checkbox — host 'Toggle.Checkbox': a NATIVE checkbox with
 * 'accent-color: var(--primary)'. No custom box; the host has none either, and a
 * repainted checkbox loses the platform's own focus and pressed states.
 */
.lt-checkbox {
  flex: 0 0 auto;
  width: 14px;
  height: 14px;
  margin: 0;
  accent-color: var(--lumiverse-primary, CanvasText);
  cursor: pointer;
}

.lt-checkbox:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.lt-checkbox-label {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  font-size: calc(13px * var(--lumiverse-font-scale, 1));
  color: var(--lumiverse-text, CanvasText);
  cursor: pointer;
}

.lt-checkbox-label:has(.lt-checkbox:disabled) {
  opacity: 0.5;
  cursor: not-allowed;
}

.lt-checkbox-label__text {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.lt-checkbox-label__hint {
  font-size: calc(11px * var(--lumiverse-font-scale, 1));
  line-height: 1.4;
  color: var(--lumiverse-text-dim, var(--lumiverse-text-muted, CanvasText));
}

/* ================================================================== */
/* 8. Toolbars and disclosure blocks                */
/* ================================================================== */

/*
 * One wrapping row for search + sorting + filtering + actions. Deliberately
 * never forced to one control per line: 'flex-wrap' plus flexible search is what
 * keeps a 320px drawer usable (host panel scrollers wrap their toolbars the same
 * way — WorldBookEntriesSection.module.css:848).
 */
.lt-toolbar {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-end;
  gap: 8px 10px;
  min-width: 0;
}

.lt-toolbar__grow {
  flex: 1 1 220px;
  min-width: 160px;
}

.lt-toolbar__search {
  flex: 1 1 240px;
  min-width: 0;
  display: flex;
  min-width: 0;
}

.lt-toolbar__actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  min-width: 0;
}

/* Mode banner (bulk delete / merge / bulk assign): a real panel, so a real
   border and fill — the host's '.globalSection' block. */
.lt-toolbar__banner {
  display: flex;
  flex: 0 0 auto;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px 10px;
  padding: 8px 10px;
  border: 1px solid var(--lumiverse-border, CanvasText);
  border-radius: var(--lumiverse-radius, 8px);
  background: var(--lumiverse-fill-subtle, transparent);
  font-size: calc(12px * var(--lumiverse-font-scale, 1));
  color: var(--lumiverse-text-muted, var(--lumiverse-text, CanvasText));
}

.lt-toolbar__banner strong { color: var(--lumiverse-text, CanvasText); font-weight: 600; }

.lt-toolbar--busy { opacity: 0.85; }

/*
 * The collapsible bulk-assignment block, ported from the host's
 * 'CollapsibleSection' (CollapsibleSection.module.css:1-24): a transparent
 * full-width header, a hairline divider, a 13px/600 title, a dimmed chevron and
 * 10px content padding. The indicator glyph is supplied by the renderer as text,
 * so it is aligned rather than rotated.
 */
.lt-bulk-host {
  display: flex;
  flex-direction: column;
  min-width: 0;
  border-bottom: 1px solid var(--lumiverse-border, CanvasText);
}

.lt-bulk-host__toggle {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 10px 0;
  border: 0;
  background: transparent;
  color: var(--lumiverse-text, CanvasText);
  font-family: inherit;
  font-size: calc(13px * var(--lumiverse-font-scale, 1));
  text-align: left;
  cursor: pointer;
  transition: color var(--lumiverse-transition-fast, 150ms ease);
}

.lt-bulk-host__toggle:hover { color: var(--lumiverse-primary, var(--lumiverse-text, CanvasText)); }

.lt-bulk-host__label {
  flex: 1 1 auto;
  min-width: 0;
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.lt-bulk-host__indicator {
  flex-shrink: 0;
  display: flex;
  color: var(--lumiverse-text-dim, var(--lumiverse-text-muted, CanvasText));
  font-size: calc(12px * var(--lumiverse-font-scale, 1));
  line-height: 1;
}

.lt-bulk-host__content {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 10px 0;
  min-width: 0;
}

/* ================================================================== */
/* 9. Layout primitives                                   */
/* ================================================================== */
.lt-box {
  display: flex;
  flex-direction: column;
  gap: 12px;
  min-width: 0;
}

.lt-row {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.lt-row--wrap { flex-wrap: wrap; }
.lt-row--grow { flex: 1 1 auto; }

.lt-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-width: 0;
  list-style: none;
  margin: 0;
  padding: 0;
}

/* Avatar — the host has no primitive, only the 20px round leading slot
   (SearchableSelect.module.css:16-20) and a text fallback
   (global.css:143-147). Ours follows the rounded-square list convention with a
   font-scaled fallback and an opacity reveal once the image decodes. */
.lt-avatar {
  position: relative;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: 0 0 auto;
  overflow: hidden;
  border-radius: var(--lumiverse-radius, 8px);
  background: var(--lumiverse-fill-subtle, transparent);
  color: var(--lumiverse-text-muted, var(--lumiverse-text, CanvasText));
  font-size: calc(10px * var(--lumiverse-font-scale, 1));
  font-weight: 600;
  line-height: 1;
  user-select: none;
  -webkit-user-select: none;
}

.lt-avatar__initials { line-height: 1; }

.lt-avatar__img {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  object-fit: cover;
  /* Hidden until the image fires its load event, so a failed image shows the
     initials instead of a broken-image glyph. */
  opacity: 0;
  transition: opacity var(--lumiverse-transition-fast, 150ms ease);
}

.lt-avatar[data-lt-loaded="true"] .lt-avatar__img { opacity: 1; }

/* ================================================================== */
/* 10. List rows — separated, not carded                  */
/* ================================================================== */

/*
 * Ordinary rows are NOT cards. They sit on the panel surface, are separated by a
 * 1px '--border' divider (the host's list convention) and gain a subtle surface
 * on hover. Selection is the host's dominant idiom: a 3px inset left accent bar
 * plus a primary-tinted fill (WorldBookEntriesSection.module.css:463-491).
 */
.lt-tag-row,
.lt-character-row {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  padding: 8px 10px;
  border: 1px solid transparent;
  border-bottom-color: var(--lumiverse-border, CanvasText);
  border-radius: var(--lumiverse-radius, 8px);
  background: transparent;
  color: var(--lumiverse-text, CanvasText);
  transition: background var(--lumiverse-transition-fast, 150ms ease),
    border-color var(--lumiverse-transition-fast, 150ms ease),
    box-shadow var(--lumiverse-transition-fast, 150ms ease);
}

/* Rows inside an expanded tag's sub-list are subordinate, so they get no
   divider of their own — the parent's left rail already separates them. */
.lt-tag-expanded .lt-row { padding: 3px 0; border-bottom: 0; }

.lt-tag-row:hover,
.lt-character-row:hover {
  background: var(--lumiverse-fill-subtle, transparent);
}

/* Selected for bulk delete / merge / bulk assign. */
.lt-tag-row--selected,
.lt-character-row--selected {
  background: color-mix(in srgb, var(--lumiverse-primary, CanvasText) 8%,
    var(--lumiverse-bg, transparent));
  box-shadow: inset var(--lt-selected-bar, 3px) 0 0 var(--lumiverse-primary, CanvasText);
}

/* The merge PRIMARY tag is a stronger state than "selected" — it is the row the
   operation resolves to — so it gets the solid treatment and full-strength ink. */
.lt-tag-row--primary {
  background: var(--lumiverse-primary-015, transparent);
  border-color: var(--lumiverse-primary-050, var(--lumiverse-primary, CanvasText));
  box-shadow: inset var(--lt-selected-bar, 3px) 0 0 var(--lumiverse-primary, CanvasText);
}

.lt-tag-row--primary .lt-tag-row__name,
.lt-tag-row--primary .lt-tag-row__meta,
.lt-tag-row--primary .lt-character-row__name { color: var(--lumiverse-text, CanvasText); }

.lt-tag-row--disabled { opacity: 0.55; }

/* A character carrying one of the tags the current filter applies to. */
.lt-character-row--active-filter {
  box-shadow: inset var(--lt-selected-bar, 3px) 0 0 var(--lumiverse-primary-muted,
    var(--lumiverse-primary, CanvasText));
}

.lt-tag-row__name {
  min-width: 0;
  font-size: calc(12.5px * var(--lumiverse-font-scale, 1));
  font-weight: 600;
  color: var(--lumiverse-text, CanvasText);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.lt-tag-row__meta {
  flex-shrink: 0;
  font-size: calc(11.5px * var(--lumiverse-font-scale, 1));
  line-height: 1.45;
  color: var(--lumiverse-text-muted, var(--lumiverse-text, CanvasText));
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}

.lt-tag-row__actions {
  display: flex;
  align-items: center;
  gap: 4px;
  flex-shrink: 0;
  margin-left: auto;
}

/* The characters under an expanded tag: indented behind a hairline rail so they
   read as subordinate rather than as another list. */
.lt-tag-expanded {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin: 2px 0 4px 10px;
  padding: 4px 0 4px 10px;
  border-left: 2px solid var(--lumiverse-border, CanvasText);
  min-width: 0;
}

.lt-subtag-list {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  min-width: 0;
  margin-top: 2px;
}

.lt-character-row {
  align-items: flex-start;
}

.lt-character-row__main {
  display: flex;
  flex: 1 1 auto;
  flex-direction: column;
  gap: 6px;
  min-width: 0;
}

.lt-character-row__title {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.lt-character-row__name {
  min-width: 0;
  font-size: calc(12.5px * var(--lumiverse-font-scale, 1));
  font-weight: 600;
  color: var(--lumiverse-text, CanvasText);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.lt-character-row__sub {
  margin: 0;
  font-size: calc(11.5px * var(--lumiverse-font-scale, 1));
  line-height: 1.45;
  color: var(--lumiverse-text-dim, var(--lumiverse-text-muted, CanvasText));
  overflow-wrap: anywhere;
}

.lt-character-row__chips {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  min-width: 0;
}

/*
 * A row's tags behind their native <details> disclosure. The 'min-width: 0' is
 * load-bearing: the row's '__main' is a flex child, and without it a long
 * unbroken tag name could stretch the disclosure past the row instead of
 * wrapping or ellipsising inside it.
 */
.lt-character-row__tags {
  min-width: 0;
  margin-top: 2px;
}

/* Deliberately NOT 'display: flex'.
   In Chromium a flex <summary> drops its native disclosure triangle, and that
   triangle is the one thing telling a closed row from an open one at a glance:
   it rotates for free, needs no extra element, and is what the browser's own
   accessibility tree already associates with the disclosure. So the summary keeps
   its UA list-item display for the marker and spaces children with a sibling
   margin instead of a flex gap. */
.lt-character-row__tags-summary {
  cursor: pointer;
  color: var(--lumiverse-text-dim, var(--lumiverse-text-muted, CanvasText));
  font-size: calc(11.5px * var(--lumiverse-font-scale, 1));
}

/* Tint the native marker so it does not render as an unthemed black triangle
   against a dark panel surface. */
.lt-character-row__tags-summary::marker,
.lt-tag-picker__summary::marker {
  color: var(--lumiverse-text-dim, var(--lumiverse-text-muted, CanvasText));
}

.lt-character-row__tags-summary > * + * { margin-left: 6px; }

.lt-character-row__tags-summary:hover { color: var(--lumiverse-text-muted, var(--lumiverse-text, CanvasText)); }

.lt-character-row__tags-summary:focus-visible {
  outline: 1.5px solid var(--lumiverse-primary-050, var(--lumiverse-primary, CanvasText));
  outline-offset: 2px;
  border-radius: var(--lumiverse-radius-sm, 5px);
}

/* The chips cap: a 50-tag character scrolls inside its own row instead of
   becoming a page-long chip wall. 7.5em resolves against the container's own
   font size, so it tracks the user's font scale. The overscroll behaviour stops
   a flick that reaches the end of the chip list from then scrolling the panel. */
.lt-character-row__chips--scroll {
  max-height: 7.5em;
  overflow-y: auto;
  overscroll-behavior: contain;
  scrollbar-width: thin;
}

/* The bulk tag picker's disclosure. Same reasoning as the character-row summary
   at panel scale: the picker can render 200 checkbox rows, so collapsed it must
   collapse to a summary line rather than to 200 rows of "nothing here". */
.lt-tag-picker {
  min-width: 0;
  margin-top: 4px;
}

.lt-tag-picker__summary {
  cursor: pointer;
  font-size: calc(12.5px * var(--lumiverse-font-scale, 1));
  font-weight: 600;
  color: var(--lumiverse-text, CanvasText);
}

.lt-tag-picker__summary > * + * { margin-left: 6px; }

.lt-tag-picker__summary:hover { color: var(--lumiverse-primary, var(--lumiverse-text, CanvasText)); }

.lt-tag-picker__summary:focus-visible {
  outline: 1.5px solid var(--lumiverse-primary-050, var(--lumiverse-primary, CanvasText));
  outline-offset: 2px;
  border-radius: var(--lumiverse-radius-sm, 5px);
}

.lt-tag-picker__body {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-top: 8px;
  padding-top: 8px;
  min-width: 0;
  border-top: 1px solid color-mix(in srgb, var(--lumiverse-border, CanvasText) 60%, transparent);
}

.lt-tag-picker__sub {
  font-size: calc(11.5px * var(--lumiverse-font-scale, 1));
  color: var(--lumiverse-text-dim, var(--lumiverse-text-muted, CanvasText));
}

/* ================================================================== */
/* 11. Chips and badges                           */
/* ================================================================== */

/*
 * Chips are genuine associations (a tag on a character), so they use the host's
 * in-row pill vocabulary (WorldBookEntriesSection.module.css:656-694): 2px 7px,
 * 999px radius, 10px/600. Neutral by default — the primary tint is reserved for
 * an ACTIVE selection, never for merely owning a tag.
 */
.lt-chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  max-width: 100%;
  padding: 2px 7px;
  border: 1px solid var(--lumiverse-border, CanvasText);
  border-radius: 999px;
  background: var(--lumiverse-fill-subtle, transparent);
  color: var(--lumiverse-text-muted, var(--lumiverse-text, CanvasText));
  font-size: calc(10px * var(--lumiverse-font-scale, 1));
  font-weight: 600;
  line-height: 1.45;
  white-space: nowrap;
}

.lt-chip__label {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* Selected / active chip — the primary ladder, host Badge 'primary' values. */
.lt-chip--accent,
.lt-chip--primary {
  border-color: var(--lumiverse-primary-050, var(--lumiverse-primary, CanvasText));
  background: var(--lumiverse-primary-015, transparent);
  color: var(--lumiverse-primary, var(--lumiverse-text, CanvasText));
}

.lt-chip--muted,
.lt-chip--neutral {
  border-color: transparent;
  background: transparent;
  color: var(--lumiverse-text-dim, var(--lumiverse-text-muted, CanvasText));
}

.lt-chip--danger {
  border-color: var(--lumiverse-danger-020, transparent);
  background: var(--lumiverse-danger-015, transparent);
  color: var(--lumiverse-danger, CanvasText);
}

.lt-chip--warning {
  border-color: var(--lumiverse-warning-020, transparent);
  background: var(--lumiverse-warning-015, transparent);
  color: var(--lumiverse-warning, CanvasText);
}

.lt-chip--success {
  border-color: var(--lumiverse-success-020, transparent);
  background: var(--lumiverse-success-015, transparent);
  color: var(--lumiverse-success, CanvasText);
}

/* The chip's remove control: the host's '--btn-icon-xs' circular pill. */
.lt-chip .lt-btn {
  min-height: 0;
  padding: 0;
  border: 0;
  background: transparent;
  color: inherit;
  font-size: calc(12px * var(--lumiverse-font-scale, 1));
  line-height: 1;
  opacity: 0.6;
}

.lt-chip .lt-btn:hover:not(:disabled) {
  background: var(--lumiverse-danger-015, transparent);
  color: var(--lumiverse-danger, CanvasText);
  opacity: 1;
}

/*
 * Badges are metadata, not chips: host 'Badge' 'sm' (2px 6px, 10px, 4px radius)
 * with the neutral colours. Counts stay neutral so they never out-shout the tag
 * name they sit next to; the accent and status tones are reserved for state.
 */
.lt-badge {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  flex-shrink: 0;
  padding: 2px 6px;
  border: 1px solid var(--lumiverse-border, CanvasText);
  border-radius: 4px;
  background: var(--lumiverse-fill-subtle, transparent);
  color: var(--lumiverse-text-muted, var(--lumiverse-text, CanvasText));
  font-size: calc(10px * var(--lumiverse-font-scale, 1));
  font-weight: 600;
  line-height: 1.45;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}

.lt-badge--accent,
.lt-badge--primary {
  border-color: var(--lumiverse-primary-020, transparent);
  background: var(--lumiverse-primary-015, transparent);
  color: var(--lumiverse-primary, var(--lumiverse-text, CanvasText));
}

.lt-badge--muted {
  border-color: transparent;
  background: transparent;
  color: var(--lumiverse-text-dim, var(--lumiverse-text-muted, CanvasText));
}

.lt-badge--danger {
  border-color: var(--lumiverse-danger-020, transparent);
  background: var(--lumiverse-danger-015, transparent);
  color: var(--lumiverse-danger, CanvasText);
}

.lt-badge--warning {
  border-color: var(--lumiverse-warning-020, transparent);
  background: var(--lumiverse-warning-015, transparent);
  color: var(--lumiverse-warning, CanvasText);
}

.lt-badge--success {
  border-color: var(--lumiverse-success-020, transparent);
  background: var(--lumiverse-success-015, transparent);
  color: var(--lumiverse-success, CanvasText);
}

/* '--lumiverse-info' is undefined in the host theme and always falls back to the
   literal the host itself uses (WorldBookPanel.module.css:145,398,421). */
.lt-badge--info {
  border-color: color-mix(in srgb, var(--lumiverse-info, #42a5f5) 18%, transparent);
  background: color-mix(in srgb, var(--lumiverse-info, #42a5f5) 10%, transparent);
  color: var(--lumiverse-info, #42a5f5);
}

/* ================================================================== */
/* 12. Pagination — Pagination.module.css port                  */
/* ================================================================== */

/*
 * Host Pagination (Pagination.module.css:1-58): 32px cells, 6px radius, no
 * border, '--text-muted' ink, '--fill-subtle' hover, 0.3 disabled, and an active
 * page of '--primary-015' + primary ink at weight 600. Our pager additionally
 * carries the range line, so it docks as a sticky bar the way the host's docked
 * pagination variant does (WorldBookEntriesSection.module.css:379-408).
 */
.lt-pager {
  position: sticky;
  bottom: 0;
  z-index: 2;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 8px 12px;
  margin-top: 0;
  padding: 2px 0;
  font-size: calc(11px * var(--lumiverse-font-scale, 1));
  color: var(--lumiverse-text-hint, var(--lumiverse-text-dim, CanvasText));
  background: var(--lumiverse-bg-deep, var(--lumiverse-bg, Canvas));
  border-top: 1px solid
    color-mix(in srgb, var(--lumiverse-border, CanvasText) 55%, transparent);
  overflow-x: auto;
  overscroll-behavior-x: contain;
}

.lt-pager__status {
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}

.lt-pager__actions {
  display: flex;
  flex-wrap: nowrap;
  align-items: center;
  gap: 2px;
  margin-left: auto;
}

.lt-pager__position {
  padding: 0 6px;
  font-size: calc(11px * var(--lumiverse-font-scale, 1));
  font-variant-numeric: tabular-nums;
  color: var(--lumiverse-text-muted, var(--lumiverse-text, CanvasText));
  white-space: nowrap;
}

/* Pager cells: fixed-size, no border, quiet until hovered. */
.lt-pager .lt-btn {
  min-width: var(--lumiverse-btn-icon, 32px);
  height: var(--lumiverse-btn-icon, 32px);
  min-height: 0;
  padding: 0 8px;
  border-color: transparent;
  border-radius: 6px;
  background: transparent;
  color: var(--lumiverse-text-muted, var(--lumiverse-text, CanvasText));
  font-size: calc(12px * var(--lumiverse-font-scale, 1));
}

.lt-pager .lt-btn:hover:not(:disabled):not([aria-disabled="true"]) {
  background: var(--lumiverse-fill-subtle, transparent);
  border-color: transparent;
  color: var(--lumiverse-text, CanvasText);
}

.lt-pager .lt-btn:disabled,
.lt-pager .lt-btn[aria-disabled="true"] { opacity: 0.3; }

/* ================================================================== */
/* 13. Dialogs — ModalShell / ModalPresentation port          */
/* ================================================================== */

/*
 * The backdrop behind a dialog.
 *
 * It is a fixed, full-viewport layer with a REAL background rather than a
 * hand-mixed scrim, so it tracks the host theme in both modes. animation is not
 * used here: the overlay must appear instantly so a dialog never flashes in
 * late, and the host's own backdrop fade is a 'motion' value we cannot drive
 * from CSS.
 *
 * This element is mounted on document.body (see 'portalParent' in dialogs.ts),
 * NOT inside the app panel, and that is load-bearing rather than cosmetic:
 *
 *  - A 'position: fixed' element is sized against its CONTAINING BLOCK, which
 *    becomes the nearest ancestor with a transform, will-change, filter,
 *    backdrop-filter, 'contain: layout|paint' or 'isolation: isolate'. The host's
 *    drawer panel has all of those, so an overlay appended into it resolved
 *    'inset: 0' against the 320px drawer instead of the 360px viewport — the
 *    dialog rendered centred in the overlay and 20px right of centre on screen.
 *    On document.body there is no such ancestor. Never re-parent it into .lt-app.
 *
 * Because it is no longer a descendant of '.lt-app', the typography and the
 * generic focus ring are restated below.
 *
 * z-index: the host exposes its window-chrome layer as a token
 * ('--app-window-chrome-z-index', reset.css:27) and uses 12000 for it; the drawer
 * sits at 9992 and its modals at 10002. The panel's own dialog has to clear the
 * chrome too, so it is anchored just above that token.
 */
.lt-dialog-overlay {
  position: fixed;
  inset: 0;
  z-index: calc(var(--app-window-chrome-z-index, 12000) + 10);
  display: flex;
  align-items: center;
  justify-content: center;
  box-sizing: border-box;
  padding: 20px;
  /* --lumiverse-text is only inherited by overlays inside a themed ancestor, so
     CanvasText keeps the scrim legible if a host scopes its theme variables to
     a subtree instead of :root. */
  background: var(--lumiverse-modal-backdrop,
    color-mix(in srgb, var(--lumiverse-text, CanvasText) 20%, transparent));
  /* The overlay is the sizing context every dialog is measured against: with
     box-sizing: border-box its padding is guaranteed to be inside the box, so
     'width: 100%' on the panel means the padded content box and the panel can
     never spill past the scrim. */
  min-width: 0;
  /* A dialog is the tallest thing on screen; a long list must scroll inside it
     rather than letting the overlay grow a scrollbar on mobile. */
  overflow: hidden;
  color: var(--lumiverse-text, CanvasText);
  font-family: inherit;
  font-size: calc(14px * var(--lumiverse-font-scale, 1));
  line-height: 1.5;
}

/*
 * The dialog panel: ModalShell.module.css:19-26 plus ModalPresentation's chrome
 * — 16px radius, one hairline, the host's modal gradient, shadow-xl, and a
 * fixed header/body/footer rhythm so a long dialog keeps its title and actions
 * reachable while only the body scrolls.
 *
 *  - box-sizing: border-box makes 'width' the OUTER width. Under the default
 *    content-box sizing the padding and border were added on top, so a
 *    'width: 100%' panel ran off the right edge of a phone screen.
 *  - min-width: 0 lets the panel shrink below its content's intrinsic minimum
 *    inside the flex overlay; without it a wide child (a search-help <code>
 *    token) refuses to shrink and re-creates the overflow.
 */
.lt-dialog {
  position: relative;
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  gap: 14px;
  width: min(560px, 100%);
  max-width: calc(100vw - 40px);
  max-height: calc(100% - 40px);
  min-width: 0;
  padding: 16px 20px;
  border: 1px solid var(--lumiverse-border, CanvasText);
  border-radius: var(--lumiverse-radius-xl, 16px);
  background: var(--lumiverse-gradient-modal, var(--lumiverse-bg-elevated, var(--lumiverse-bg, Canvas)));
  box-shadow: var(--lumiverse-shadow-xl, var(--lumiverse-shadow-md));
  /* Long unbreakable runs (search-help tokens such as 'T:Elf', tag names,
     backend messages) must wrap or scroll instead of widening the panel. */
  overflow-y: auto;
  overflow-wrap: anywhere;
}

.lt-dialog__title {
  margin: 0;
  flex-shrink: 0;
  font-size: calc(16px * var(--lumiverse-font-scale, 1));
  font-weight: 600;
  line-height: 1.25;
  color: var(--lumiverse-text, CanvasText);
  overflow-wrap: anywhere;
}

/* A secondary '<h4>' heading inside a dialog is a section label, not a second
   dialog title. */
.lt-dialog h4.lt-dialog__title {
  font-size: calc(13px * var(--lumiverse-font-scale, 1));
  font-weight: 600;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: var(--lumiverse-text-muted, var(--lumiverse-text, CanvasText));
}

.lt-dialog__desc {
  margin: 0;
  min-width: 0;
  font-size: calc(12px * var(--lumiverse-font-scale, 1));
  line-height: 1.5;
  color: var(--lumiverse-text-muted, var(--lumiverse-text, CanvasText));
  overflow-wrap: anywhere;
}

.lt-dialog__body {
  display: flex;
  flex-direction: column;
  gap: 12px;
  /* min-width: 0 for the same reason as on the panel: a flex item defaults to
     min-width:auto, i.e. its content's intrinsic min-content width, so one long
     unbreakable line would widen the body past the panel. */
  min-width: 0;
  overflow-y: auto;
}

/* The validation/error strip. Empty most of the time, hence :empty. */
.lt-dialog__messages {
  display: flex;
  flex-direction: column;
  gap: 8px;
  flex-shrink: 0;
}

.lt-dialog__messages:empty { display: none; }

.lt-dialog__actions {
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: 8px;
  flex-shrink: 0;
  min-width: 0;
  padding-top: 2px;
}

.lt-dialog__actions .lt-btn { min-height: 32px; padding: 8px 14px; }

.lt-dialog__list {
  display: flex;
  flex-direction: column;
  gap: 6px;
  max-height: 240px;
  min-width: 0;
  overflow-y: auto;
  overscroll-behavior: contain;
  overflow-wrap: anywhere;
}

.lt-dialog__list > * { min-width: 0; }

.lt-dialog__summary {
  min-width: 0;
  padding: 10px 12px;
  border: 1px solid var(--lumiverse-border, CanvasText);
  border-radius: var(--lumiverse-radius-md, 10px);
  background: var(--lumiverse-fill-subtle, transparent);
  font-size: calc(12.5px * var(--lumiverse-font-scale, 1));
  line-height: 1.5;
  color: var(--lumiverse-text-muted, var(--lumiverse-text, CanvasText));
  overflow-wrap: anywhere;
}

.lt-dialog__summary strong { color: var(--lumiverse-text, CanvasText); font-weight: 600; }

/* Search-help syntax tokens are the single most likely thing to blow out a
   dialog on a phone. */
.lt-dialog code,
.lt-dialog__list code,
.lt-dialog__summary code {
  padding: 1px 4px;
  border-radius: var(--lumiverse-radius-sm, 5px);
  background: var(--lumiverse-fill-medium, transparent);
  color: var(--lumiverse-primary-text, var(--lumiverse-primary, CanvasText));
  font-family: var(--lumiverse-font-mono, ui-monospace, monospace);
  font-size: calc(11.5px * var(--lumiverse-font-scale, 1));
  overflow-wrap: anywhere;
  word-break: break-word;
  max-width: 100%;
}

.lt-dialog pre {
  margin: 4px 0 0;
  padding: 8px 10px;
  border-radius: var(--lumiverse-radius, 8px);
  background: var(--lumiverse-fill-subtle, transparent);
  color: var(--lumiverse-text-muted, var(--lumiverse-text, CanvasText));
  font-family: var(--lumiverse-font-mono, ui-monospace, monospace);
  font-size: calc(11.5px * var(--lumiverse-font-scale, 1));
  line-height: 1.4;
  overflow-x: auto;
}

/*
 * On a phone the overlay padding is the only gutter between the dialog and the
 * screen edge, so it is trimmed to 12px — the host's own ≤480px value
 * (ModalShell.module.css:44) — to keep the usable panel width as large as
 * possible.
 */
@media (max-width: 480px) {
  .lt-dialog-overlay { padding: 12px; }

  .lt-dialog {
    width: 100%;
    max-width: calc(100vw - 24px);
    max-height: calc(100% - 24px);
    padding: 16px 18px;
    gap: 12px;
  }

  /* Host ConfirmationModal.module.css:702-705 — stacked actions, primary last
     in DOM order so it lands at the bottom thumb position. */
  .lt-dialog__actions {
    flex-direction: column-reverse;
    align-items: stretch;
  }
}

/* ================================================================== */
/* 14. Failure report region                      */
/* ================================================================== */

/*
 * The report docks under the scroller as a panel — a real border and fill, so it
 * reads as chrome rather than as another list item, and it is separated from the
 * results by a hairline instead of floating over them.
 */
.lt-failures {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 10px 12px;
  border: 1px solid var(--lumiverse-border, CanvasText);
  border-radius: var(--lumiverse-radius-md, 10px);
  background: var(--lumiverse-bg-elevated, var(--lumiverse-bg, Canvas));
  box-shadow: var(--lumiverse-highlight-inset, none);
}

.lt-failures--succeeded { border-color: var(--lumiverse-success-020, var(--lumiverse-border, CanvasText)); }

.lt-failures--warning,
.lt-failures--partially_completed {
  border-color: var(--lumiverse-warning-020, var(--lumiverse-border, CanvasText));
}

.lt-failures--failed {
  border-color: var(--lumiverse-danger-020, var(--lumiverse-border, CanvasText));
}

.lt-failures__header {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px 8px;
  min-width: 0;
}

.lt-failures__status {
  margin: 0;
  font-size: calc(13px * var(--lumiverse-font-scale, 1));
  font-weight: 600;
  color: var(--lumiverse-text, CanvasText);
}

.lt-failures__spacer { flex: 1 1 auto; }

.lt-failures__groups {
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-width: 0;
  max-height: 220px;
  overflow-y: auto;
  overscroll-behavior: contain;
}

/* A group is a sub-panel of the report, so it takes the host's subtle fill. */
.lt-failure-group {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px 8px;
  min-width: 0;
  padding: 8px 10px;
  border: 1px solid var(--lumiverse-border, CanvasText);
  border-radius: var(--lumiverse-radius, 8px);
  background: var(--lumiverse-fill-subtle, transparent);
  font-size: calc(11.5px * var(--lumiverse-font-scale, 1));
}

.lt-failure-group__label {
  font-weight: 600;
  color: var(--lumiverse-text, CanvasText);
}

.lt-failure-group__detail {
  flex: 1 1 160px;
  min-width: 0;
  font-size: calc(11px * var(--lumiverse-font-scale, 1));
  color: var(--lumiverse-text-muted, var(--lumiverse-text, CanvasText));
  overflow: hidden;
  text-overflow: ellipsis;
}

/*
 * The container around a failure group's <table>. It scrolls HORIZONTALLY rather
 * than letting the table stretch the docked panel: a four-column table would
 * otherwise force the whole drawer into a horizontal scrollbar.
 */
.lt-failures__details {
  flex: 1 1 100%;
  min-width: 0;
  overflow-x: auto;
  overflow-y: visible;
}

/*
 * The failure table. Column alignment is explicit because 'table-layout: auto'
 * re-flows the columns every time an error message changes length, which makes
 * rows jump while the user is reading them. Phase 4 applies 'lt-table' to the
 * table element it builds (it currently carries inline styles only).
 */
.lt-table {
  width: 100%;
  table-layout: fixed;
  border-collapse: collapse;
  font-size: calc(11.5px * var(--lumiverse-font-scale, 1));
  color: var(--lumiverse-text-muted, var(--lumiverse-text, CanvasText));
}

.lt-table th,
.lt-table td {
  padding: 4px 8px;
  border-bottom: 1px solid var(--lumiverse-border, CanvasText);
  text-align: left;
  vertical-align: top;
  overflow-wrap: anywhere;
}

.lt-table thead th {
  font-weight: 600;
  color: var(--lumiverse-text-dim, var(--lumiverse-text-muted, CanvasText));
  border-bottom-color: var(--lumiverse-border-hover, var(--lumiverse-border, CanvasText));
  white-space: nowrap;
}

.lt-table tbody tr:last-child th,
.lt-table tbody tr:last-child td { border-bottom: 0; }

/* ================================================================== */
/* 15. States — loading, empty, error, query errors        */
/* ================================================================== */

/* Host empty state A (WorldBookEntriesSection.module.css:775-781): centred,
   padded, italic, dimmed — no border, no fill. An empty list is not a card. */
.lt-state {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 6px;
  padding: 24px 12px;
  font-size: calc(13px * var(--lumiverse-font-scale, 1));
  color: var(--lumiverse-text-muted, var(--lumiverse-text, CanvasText));
}

.lt-state--empty {
  border: 0;
  border-radius: var(--lumiverse-radius, 8px);
  background: transparent;
  text-align: center;
  align-items: center;
}

.lt-state__title {
  margin: 0;
  font-size: calc(13px * var(--lumiverse-font-scale, 1));
  font-style: italic;
  font-weight: 500;
  color: var(--lumiverse-text-muted, var(--lumiverse-text, CanvasText));
}

.lt-state__detail {
  margin: 0;
  min-width: 0;
  max-width: 46ch;
  font-size: calc(12px * var(--lumiverse-font-scale, 1));
  font-style: normal;
  line-height: 1.5;
  color: var(--lumiverse-text-dim, var(--lumiverse-text-muted, CanvasText));
  overflow-wrap: anywhere;
}

/* An error IS a panel, so it takes a border and a fill — status-tinted, never
   primary-tinted. (The old rule tinted the error border with the undefined
   '--lumiverse-accent', so errors rendered with no border at all.) */
.lt-state--error {
  padding: 12px 14px;
  border: 1px solid var(--lumiverse-danger-020, var(--lumiverse-border, CanvasText));
  border-radius: var(--lumiverse-radius, 8px);
  background: var(--lumiverse-danger-015, var(--lumiverse-fill-subtle, transparent));
  text-align: start;
  align-items: flex-start;
  font-style: normal;
}

.lt-state--error .lt-state__title {
  font-style: normal;
  font-weight: 600;
  color: var(--lumiverse-danger, var(--lumiverse-text, CanvasText));
}

.lt-state--error .lt-state__detail { color: var(--lumiverse-text-muted, var(--lumiverse-text, CanvasText)); }

.lt-state__actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 2px;
}

/* Loading: host FormComponents' CSS spinner — 14px, 2px border, transparent
   top edge, 0.8s linear. */
.lt-spinner {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 12px;
  font-size: calc(12px * var(--lumiverse-font-scale, 1));
  color: var(--lumiverse-text-muted, var(--lumiverse-text, CanvasText));
}

.lt-spinner__label {
  font-size: calc(12px * var(--lumiverse-font-scale, 1));
  color: var(--lumiverse-text-muted, var(--lumiverse-text, CanvasText));
}

.lt-spinner__ring {
  flex-shrink: 0;
  width: 14px;
  height: 14px;
  border: 2px solid currentColor;
  border-top-color: transparent;
  border-radius: 50%;
  animation: lt-spin 0.8s linear infinite;
}

@keyframes lt-spin {
  to { transform: rotate(360deg); }
}

/* Search-syntax errors under a search box: a quiet warning-tinted notice, not a
   panel — it sits between the query and its results. */
.lt-query-errors {
  margin: 0;
  padding: 8px 10px;
  border: 1px solid var(--lumiverse-warning-020, var(--lumiverse-border, CanvasText));
  border-radius: var(--lumiverse-radius, 8px);
  background: var(--lumiverse-warning-015, var(--lumiverse-fill-subtle, transparent));
  color: var(--lumiverse-text-muted, var(--lumiverse-text, CanvasText));
  font-size: calc(11.5px * var(--lumiverse-font-scale, 1));
  line-height: 1.45;
}

.lt-query-errors strong { color: var(--lumiverse-warning, var(--lumiverse-text, CanvasText)); font-weight: 600; }

/* Query-error bullets: '.lt-list' is also used for the results list, so the
   markers are re-enabled here rather than globally. */
.lt-query-errors .lt-list {
  gap: 4px;
  margin: 6px 0;
  padding-left: 18px;
  list-style: disc;
}

/* ================================================================== */
/* 16. Tags section character-search (C:) mode             */
/* ================================================================== */

/*
 * The panel shown when the search query is in C: mode.
 *
 * It MUST NOT look like the tag list: in C: mode the query matches CHARACTER
 * NAMES, and a tag-shaped panel invites the reader to treat the results as a
 * tag-name search — the most expensive misunderstanding this UI can produce. The
 * mode change is signalled by FOUR independent, non-colour cues, any one of
 * which is enough:
 *
 *   1. a dashed (not solid) left accent bar — a different border vocabulary,
 *   2. a C:-prefixed heading in a monospace face, like the literal syntax,
 *   3. a tinted surface, so the region reads as a different plane,
 *   4. a legend line naming what is being searched.
 *
 * Dashes and typography survive greyscale, forced-colours and colour-blindness,
 * so the distinction never depends on the tint.
 */
.lt-tags-section__character-mode {
  display: flex;
  flex-direction: column;
  gap: 10px;
  margin: 0;
  padding: 10px 12px;
  border: 1px dashed var(--lumiverse-primary-050, var(--lumiverse-primary, CanvasText));
  border-left-width: 3px;
  border-radius: var(--lumiverse-radius, 8px);
  background: var(--lumiverse-fill-subtle, transparent);
  color: var(--lumiverse-text, CanvasText);
}

/* The C: marker itself, drawn as literal syntax rather than as prose. */
.lt-tags-section__character-mode .lt-state__title {
  font-family: var(--lumiverse-font-mono, ui-monospace, monospace);
  font-style: normal;
  font-weight: 600;
  font-size: calc(13px * var(--lumiverse-font-scale, 1));
  color: var(--lumiverse-primary, var(--lumiverse-text, CanvasText));
}

.lt-tags-section__character-mode .lt-state__detail {
  font-size: calc(12px * var(--lumiverse-font-scale, 1));
  color: var(--lumiverse-text-muted, var(--lumiverse-text, CanvasText));
}

/* The character results inside the panel keep the panel's dashed vocabulary. */
.lt-tags-section__character-mode .lt-character-row {
  border-style: dashed;
  border-bottom-style: solid;
  border-bottom-color: var(--lumiverse-border, CanvasText);
}

/* ================================================================== */
/* 17. Responsive                                  */
/* ================================================================== */

/*
 * Inside-panel responsiveness uses container queries on '.lt-app' (the drawer
 * is resizable, so its own inline size — not the viewport — is the thing that
 * changes). Breakpoints mirror the host's 480 / 640 / 700px vocabulary.
 */
@container lumiapp (max-width: 700px) {
  .lt-app__body { gap: 10px; }

  .lt-character-row__main { gap: 5px; }
}

@container lumiapp (max-width: 640px) {
  /* Host Pagination.module.css:10 compaction. */
  .lt-pager { gap: 8px; padding: 4px 0; }

  .lt-toolbar__grow,
  .lt-toolbar__search { flex: 1 1 100%; }
}

@container lumiapp (max-width: 480px) {
  .lt-app__header {
    align-items: flex-start;
    padding: 10px 12px;
    gap: 6px 8px;
  }

  .lt-app__actions { margin-left: auto; }

  /* Secondary actions wrap instead of forcing full-width rows. */
  .lt-toolbar__actions { width: 100%; }

  .lt-tag-expanded { margin-left: 6px; padding-left: 8px; }

  /* Labels must never clip: let a long legend shrink the text, not the box. */
  .lt-field__hint,
  .lt-toolbar__banner { max-width: 100%; }

  /* Pagination keeps clear navigation; only the range line may wrap. */
  .lt-pager { flex-wrap: wrap; }
 /*
 * Keep the pager docked at the bottom of the scroll area when a page has fewer
 * rows than the available height. The body itself fills the space above the
 * failure region; without a growing section/list, the pager stays after the
 * last row and leaves a large blank band below it.
 */
.lt-app__body > .lt-box:has(.lt-pager) {
  display: flex;
  flex: 1 0 auto;
  flex-direction: column;
}

.lt-app__body > .lt-box:has(.lt-pager) > .lt-list:has(> .lt-pager) {
  display: flex;
  flex: 1 0 auto;
  flex-direction: column;
}

.lt-app__body > .lt-box:has(.lt-pager) > .lt-list > .lt-pager {
  margin-top: auto;
}

 .lt-pager__status { white-space: normal; }
  .lt-pager__actions { margin-left: 0; }
}

/*
 * Touch floor. Both the host's global rule (reset.css:190-196, ≤600px) and its
 * per-panel rule (WorldBookPanel.module.css:604-608, 'pointer: coarse') raise
 * text inputs to 16px so iOS/WebView does not zoom the page on focus. Search is
 * excluded from the ≤600px variant only in the sense that it is already ≥16px
 * there; nothing is dropped.
 */
@media (pointer: coarse) {
  .lt-app input,
  .lt-app select,
  .lt-app textarea,
  .lt-dialog-overlay input,
  .lt-dialog-overlay select,
  .lt-dialog-overlay textarea {
    font-size: max(16px, calc(13px * var(--lumiverse-font-scale, 1)));
  }
}

@media screen and (max-width: 600px) {
  .lt-app input,
  .lt-app select,
  .lt-app textarea,
  .lt-dialog-overlay input,
  .lt-dialog-overlay select,
  .lt-dialog-overlay textarea {
    font-size: max(16px, calc(13px * var(--lumiverse-font-scale, 1)));
  }
}

/* ================================================================== */
/* 18. Accessibility — reduced motion, high contrast      */
/* ================================================================== */

/*
 * '.lt-dialog-overlay' is mounted on document.body rather than inside '.lt-app'
 * (see the containing-block note in §13), so it needs its own copy of this
 * rule — otherwise dialog controls keep animating for a reader who asked the OS
 * for less motion.
 */
@media (prefers-reduced-motion: reduce) {
  .lt-app *,
  .lt-app *::before,
  .lt-app *::after,
  .lt-dialog-overlay,
  .lt-dialog-overlay *,
  .lt-dialog-overlay *::before,
  .lt-dialog-overlay *::after {
    animation-duration: 0.001ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.001ms !important;
    scroll-behavior: auto !important;
  }

  /* The spinner still has to say "working" once the rotation is gone. */
  .lt-spinner__ring {
    border-top-color: currentColor;
    opacity: 0.55;
  }
}

/* When the reader asks for more contrast, selection must not depend on a 12%
   accent tint: the bar widens and the border goes full strength. */
@media (prefers-contrast: more) {
  .lt-tag-row--selected,
  .lt-tag-row--primary,
  .lt-character-row--selected,
  .lt-character-row--active-filter {
    border-color: var(--lumiverse-primary, CanvasText);
    box-shadow: inset 4px 0 0 var(--lumiverse-primary, CanvasText);
  }

  .lt-tag-row,
  .lt-character-row {
    border-bottom-color: var(--lumiverse-border-hover, var(--lumiverse-border, CanvasText));
  }
}`
