/**
 * LumiTag stylesheet.
 *
 * Registered once, by `setupApp`, through `ctx.dom.addStyle(LUMITAG_CSS)`.
 *
 * House rules for this file:
 *  - **Colour, spacing, radius and transition come from Lumiverse CSS
 *    variables only.** No hex literals, no bare `rgb()`. That is what keeps
 *    the panel legible in every host theme, including user-authored ones.
 *  - **Everything is namespaced** under the `.lt-` prefix so a host stylesheet
 *    can never accidentally restyle us and we can never restyle the host.
 *  - `:focus-visible` outlines everywhere an element is focusable, and
 *    `prefers-reduced-motion` disables every transition.
 */

export const LUMITAG_CSS = `
/* ------------------------------------------------------------------ */
/* Screen-reader-only text                                             */
/* ------------------------------------------------------------------ */
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

/* ------------------------------------------------------------------ */
/* App shell                                                           */
/* ------------------------------------------------------------------ */
.lt-app {
  display: flex;
  flex-direction: column;
  gap: 8px;
  height: 100%;
  min-height: 0;
  padding: 8px;
  color: var(--lumiverse-text);
  font-size: 13px;
}

.lt-app__header {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}

.lt-app__title {
  margin: 0;
  font-size: 15px;
  font-weight: 600;
  color: var(--lumiverse-text);
}

.lt-app__spacer { flex: 1 1 auto; }

.lt-app__meta {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 4px 12px;
  font-size: 12px;
  color: var(--lumiverse-text-muted);
}

.lt-app__meta strong {
  color: var(--lumiverse-text);
  font-weight: 600;
}

.lt-app__body {
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

/* ------------------------------------------------------------------ */
/* Tab strip (Tags / Characters)                                       */
/* ------------------------------------------------------------------ */
.lt-tabs {
  display: flex;
  align-items: stretch;
  gap: 4px;
  border-bottom: 1px solid var(--lumiverse-border);
  padding-bottom: 4px;
}

.lt-tab {
  appearance: none;
  border: 1px solid transparent;
  border-radius: var(--lumiverse-radius);
  background: transparent;
  color: var(--lumiverse-text-muted);
  font: inherit;
  font-weight: 500;
  padding: 5px 12px;
  cursor: pointer;
  transition: background-color var(--lumiverse-transition-fast),
    color var(--lumiverse-transition-fast);
}

.lt-tab:hover {
  background: var(--lumiverse-fill-subtle);
  color: var(--lumiverse-text);
}

.lt-tab[aria-selected="true"] {
  background: var(--lumiverse-accent);
  color: var(--lumiverse-accent-fg);
  border-color: var(--lumiverse-accent);
}

.lt-tab:focus-visible {
  outline: 2px solid var(--lumiverse-accent);
  outline-offset: 2px;
}

.lt-tabs__count {
  margin-left: 6px;
  opacity: 0.75;
  font-variant-numeric: tabular-nums;
}

/* ------------------------------------------------------------------ */
/* Toolbar                                                             */
/* ------------------------------------------------------------------ */
.lt-toolbar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px 8px;
}

.lt-toolbar__grow {
  flex: 1 1 200px;
  min-width: 160px;
}

.lt-toolbar__actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px 6px;
}

.lt-toolbar--busy {
  opacity: 0.85;
}

.lt-toolbar__banner {
  flex: 1 0 100%;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px 10px;
  padding: 6px 8px;
  border: 1px solid var(--lumiverse-border);
  border-radius: var(--lumiverse-radius);
  background: var(--lumiverse-fill-subtle);
  font-size: 12px;
  color: var(--lumiverse-text-muted);
}

.lt-toolbar__banner strong { color: var(--lumiverse-text); }

/* ------------------------------------------------------------------ */
/* Form controls                                                       */
/* ------------------------------------------------------------------ */
.lt-btn {
  appearance: none;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  border: 1px solid var(--lumiverse-border);
  border-radius: var(--lumiverse-radius);
  background: var(--lumiverse-fill);
  color: var(--lumiverse-text);
  font: inherit;
  line-height: 1.2;
  padding: 4px 10px;
  cursor: pointer;
  transition: background-color var(--lumiverse-transition-fast),
    border-color var(--lumiverse-transition-fast),
    color var(--lumiverse-transition-fast);
}

.lt-btn:hover:not(:disabled) {
  border-color: var(--lumiverse-border-hover);
  background: var(--lumiverse-fill-subtle);
}

.lt-btn:focus-visible {
  outline: 2px solid var(--lumiverse-accent);
  outline-offset: 2px;
}

.lt-btn:disabled {
  opacity: 0.55;
  cursor: not-allowed;
}

.lt-btn--primary {
  background: var(--lumiverse-accent);
  border-color: var(--lumiverse-accent);
  color: var(--lumiverse-accent-fg);
}

.lt-btn--danger {
  border-color: var(--lumiverse-border);
  color: var(--lumiverse-text);
  background: var(--lumiverse-fill);
  text-decoration: underline;
}

.lt-btn--ghost {
  background: transparent;
  border-color: transparent;
  color: var(--lumiverse-text-muted);
  padding: 2px 6px;
}

.lt-btn--ghost:hover:not(:disabled) {
  color: var(--lumiverse-text);
  background: var(--lumiverse-fill-subtle);
}

.lt-btn--sm {
  padding: 2px 8px;
  font-size: 12px;
}

.lt-search,
.lt-select,
.lt-input {
  width: 100%;
  box-sizing: border-box;
  border: 1px solid var(--lumiverse-border);
  border-radius: var(--lumiverse-radius);
  background: var(--lumiverse-fill);
  color: var(--lumiverse-text);
  font: inherit;
  padding: 4px 8px;
  transition: border-color var(--lumiverse-transition-fast);
}

.lt-select { width: auto; }

.lt-search:focus-visible,
.lt-select:focus-visible,
.lt-input:focus-visible {
  outline: 2px solid var(--lumiverse-accent);
  outline-offset: 1px;
  border-color: var(--lumiverse-accent);
}

.lt-field {
  display: inline-flex;
  flex-direction: column;
  gap: 2px;
  font-size: 12px;
  color: var(--lumiverse-text-muted);
}

.lt-field__label { font-weight: 500; }

.lt-field__hint {
  font-size: 11px;
  color: var(--lumiverse-text-dim);
}

.lt-checkbox {
  accent-color: var(--lumiverse-accent);
  width: 14px;
  height: 14px;
  cursor: pointer;
}

.lt-checkbox:focus-visible {
  outline: 2px solid var(--lumiverse-accent);
  outline-offset: 2px;
}

/* ------------------------------------------------------------------ */
/* Layout primitives                                                   */
/* ------------------------------------------------------------------ */
.lt-box { min-width: 0; }

.lt-row {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}

.lt-row--wrap { flex-wrap: wrap; }
.lt-row--grow { flex: 1 1 auto; }

.lt-list {
  display: flex;
  flex-direction: column;
  gap: 4px;
  list-style: none;
  margin: 0;
  padding: 0;
}

/* ------------------------------------------------------------------ */
/* Avatar                                                              */
/* ------------------------------------------------------------------ */
.lt-avatar {
  position: relative;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: 0 0 auto;
  overflow: hidden;
  border-radius: var(--lumiverse-radius);
  background: var(--lumiverse-fill-subtle);
  color: var(--lumiverse-text-muted);
  font-size: 11px;
  font-weight: 600;
  user-select: none;
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
  transition: opacity var(--lumiverse-transition-fast);
}

.lt-avatar[data-lt-loaded="true"] .lt-avatar__img { opacity: 1; }

/* ------------------------------------------------------------------ */
/* Chips                                                               */
/* ------------------------------------------------------------------ */
.lt-chip {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  max-width: 100%;
  padding: 1px 4px 1px 8px;
  border: 1px solid var(--lumiverse-border);
  border-radius: var(--lumiverse-radius);
  background: var(--lumiverse-fill-subtle);
  color: var(--lumiverse-text);
  font-size: 11px;
  line-height: 1.5;
}

.lt-chip--accent {
  border-color: var(--lumiverse-accent);
  color: var(--lumiverse-accent-fg);
  background: var(--lumiverse-accent);
}

.lt-chip--muted {
  border-color: transparent;
  background: transparent;
  color: var(--lumiverse-text-muted);
}

.lt-chip__label {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.lt-chip .lt-btn--ghost {
  font-size: 13px;
  line-height: 1;
  padding: 0 4px;
}

/* ------------------------------------------------------------------ */
/* Tag list rows                                                       */
/* ------------------------------------------------------------------ */
.lt-tag-row {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 5px 8px;
  border: 1px solid var(--lumiverse-border);
  border-radius: var(--lumiverse-radius);
  background: var(--lumiverse-fill);
  transition: background-color var(--lumiverse-transition-fast),
    border-color var(--lumiverse-transition-fast);
}

.lt-tag-row:hover {
  border-color: var(--lumiverse-border-hover);
  background: var(--lumiverse-fill-subtle);
}

/*
 * Selection indication. Deliberately loud: a left accent bar AND a tinted
 * surface AND a bold name, so selection is not conveyed by colour alone and
 * cannot be missed in bulk / merge mode.
 */
.lt-tag-row--selected {
  border-color: var(--lumiverse-accent);
  border-left-width: 4px;
  background: var(--lumiverse-fill-subtle);
}

.lt-tag-row--selected .lt-tag-row__name { font-weight: 700; }

.lt-tag-row--primary {
  border-color: var(--lumiverse-accent);
  border-left-width: 4px;
  background: var(--lumiverse-accent);
  color: var(--lumiverse-accent-fg);
}

.lt-tag-row--primary .lt-tag-row__name,
.lt-tag-row--primary .lt-tag-row__meta { color: var(--lumiverse-accent-fg); }

.lt-tag-row--primary .lt-tag-row__meta { opacity: 0.85; }

.lt-tag-row--disabled { opacity: 0.6; }

.lt-tag-row__name {
  font-weight: 500;
  color: var(--lumiverse-text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.lt-tag-row__meta {
  font-size: 11px;
  color: var(--lumiverse-text-muted);
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}

.lt-tag-row__actions {
  display: flex;
  align-items: center;
  gap: 2px;
  margin-left: auto;
}

/* Expandable character sub-list under a tag row. */
.lt-tag-expanded {
  margin: 2px 0 6px 18px;
  padding: 4px 0 4px 10px;
  border-left: 2px solid var(--lumiverse-border);
  display: flex;
  flex-direction: column;
  gap: 3px;
}

.lt-subtag-list {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  margin-top: 3px;
}

/* ------------------------------------------------------------------ */
/* Character rows                                                      */
/* ------------------------------------------------------------------ */
.lt-character-row {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 6px 8px;
  border: 1px solid var(--lumiverse-border);
  border-radius: var(--lumiverse-radius);
  background: var(--lumiverse-fill);
  transition: background-color var(--lumiverse-transition-fast),
    border-color var(--lumiverse-transition-fast);
}

.lt-character-row:hover {
  border-color: var(--lumiverse-border-hover);
  background: var(--lumiverse-fill-subtle);
}

.lt-character-row--selected {
  border-color: var(--lumiverse-accent);
  border-left-width: 4px;
  background: var(--lumiverse-fill-subtle);
}

.lt-character-row--active-filter {
  border-left: 4px solid var(--lumiverse-accent);
}

.lt-character-row__main {
  display: flex;
  flex: 1 1 auto;
  min-width: 0;
  flex-direction: column;
  gap: 4px;
}

.lt-character-row__title {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}

.lt-character-row__name {
  font-weight: 600;
  color: var(--lumiverse-text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.lt-character-row__sub {
  font-size: 11px;
  color: var(--lumiverse-text-dim);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.lt-character-row__chips {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  min-width: 0;
}

/* A row's tags behind their native <details> disclosure. The min-width: 0 is
   load-bearing: the row's __main is a flex child, and without it a long
   unbroken tag name could stretch the disclosure past the row instead of
   wrapping or ellipsising inside it. */
.lt-character-row__tags {
  min-width: 0;
  margin-top: 4px;
}

/* Deliberately NOT display: flex.
   In Chromium a flex <summary> drops its native disclosure triangle, and that
   triangle is the one thing telling a closed row from an open one at a glance:
   it rotates for free, needs no extra element, and is what the browser's own
   accessibility tree already associates with the disclosure. Measured at
   360x640: a flex summary renders open and closed byte-identically, so the row
   reads as static text; the list-item default below rotates as expected.
   So the summary keeps its UA list-item display for the marker, and children
   are spaced with a sibling margin rather than a flex gap -- the badges are
   inline-flex already, so they lay out correctly in a list-item. */
.lt-character-row__tags-summary {
  cursor: pointer;
  color: var(--lumiverse-text-dim, var(--lumiverse-text-muted, CanvasText));
  font-size: 11px;
}

/* Tints the native marker to match the summary text instead of letting it
   render as an unthemed black triangle against the dark panel surface. */
.lt-character-row__tags-summary::marker {
  color: var(--lumiverse-text-dim, var(--lumiverse-text-muted, CanvasText));
}

.lt-character-row__tags-summary > * + * {
  margin-left: 6px;
}

.lt-character-row__tags-summary:hover {
  color: var(--lumiverse-text-muted);
}

/* The .lt-app-wide :focus-visible rule already draws an outline, but it names
   --lumiverse-accent, which the host does not define (it ships
   --lumiverse-primary), so the global outline resolves to nothing usable.
   Spelling the accent out with fallbacks here is what actually gives keyboard
   users a visible focus ring on the disclosure. */
.lt-character-row__tags-summary:focus-visible {
  outline: 2px solid var(--lumiverse-accent, var(--lumiverse-primary, CanvasText));
  outline-offset: 2px;
  border-radius: var(--lumiverse-radius, 8px);
}

/* The chips cap: a 50-tag character scrolls inside its own row instead of
   becoming a page-long chip wall again. This was inline styling before; as a
   class it is overridable and testable. 7.5em resolves against the container's
   own font-size (~13px => ~97px), so it tracks the user's font scale rather
   than being a fixed pixel count. The overscroll-behavior stops a flick that
   reaches the end of the chip list from then scrolling the panel behind it. */
.lt-character-row__chips--scroll {
  max-height: 7.5em;
  overflow-y: auto;
  overscroll-behavior: contain;
}

/* ------------------------------------------------------------------ */
/* Badges                                                              */
/* ------------------------------------------------------------------ */
.lt-badge {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  padding: 0 6px;
  border: 1px solid var(--lumiverse-border);
  border-radius: var(--lumiverse-radius);
  background: var(--lumiverse-fill-subtle);
  color: var(--lumiverse-text-muted);
  font-size: 11px;
  font-weight: 500;
  white-space: nowrap;
}

.lt-badge--accent {
  border-color: var(--lumiverse-accent);
  color: var(--lumiverse-accent-fg);
  background: var(--lumiverse-accent);
}

.lt-badge--muted {
  border-color: transparent;
  background: transparent;
  color: var(--lumiverse-text-dim);
}

/* ------------------------------------------------------------------ */
/* Dialogs rendered in-tab                                             */
/* ------------------------------------------------------------------ */

/*
 * The backdrop behind a dialog.
 *
 * It is a fixed, full-viewport layer with a real background rather than a
 * hardcoded rgba, so the scrim tracks the host theme. The colour itself is
 * still composed from a Lumiverse variable: --lumiverse-text is the darkest
 * ink the theme offers, so fading it out is theme-safe in both light and dark.
 * animation is not used here — the overlay must appear instantly so a dialog
 * never flashes in late.
 *
 * This element is mounted on document.body (see portalParent in dialogs.ts),
 * NOT inside the app panel, and that is a load-bearing decision rather than
 * cosmetic:
 *
 *  - A "position: fixed" element is sized against its CONTAINING BLOCK, which
 *    per CSS becomes the nearest ancestor with a transform, will-change,
 *    filter, backdrop-filter, "contain: layout|paint", or "isolation: isolate".
 *    The host's drawer panel has all of those, so an overlay appended into it
 *    resolved "inset: 0" against the 320px drawer instead of the 360px
 *    viewport: the dialog was centred in the overlay and 20px right of centre
 *    on screen. On document.body there is no such ancestor and "inset: 0" is
 *    genuinely the viewport. Never re-parent this back into .lt-app.
 *
 * (This file is a template literal, hence the quoted CSS instead of backticks.)
 *
 * Because it is no longer inside .lt-app, the two inherited things it used to
 * get from there are restated below (typography and the generic focus ring).
 *
 * z-index: the overlay now competes at the top level of the document rather
 * than inside the drawer's stacking context. It has to out-rank the drawer
 * itself (z-index 9992 in Lumiverse ViewportDrawer.module.css) or the dialog
 * would be painted underneath the panel it was opened from. 10000 sits above
 * that and above the drawer's tab handle (9991), while still staying below the
 * host's own modal layer (10002+) and its toasts (10010), so a native Lumiverse
 * dialog opened on top of ours still wins — which is what a user expects.
 */
.lt-dialog-overlay {
  position: fixed;
  inset: 0;
  z-index: 10000;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 12px;
  /* --lumiverse-text is only inherited by overlays inside a themed ancestor.
     The CanvasText fallback keeps the scrim legible if a host scopes its theme
     variables to a subtree instead of :root. */
  background: color-mix(in srgb, var(--lumiverse-text, CanvasText) 45%, transparent);
  /* The overlay is the sizing context every dialog is measured against: with
     box-sizing: border-box its 12px padding is guaranteed to be inside the
     box, so width: 100% on the panel means "the padded content box" and the
     panel can never spill past the scrim. Without this the padding would be
     added to the viewport and the panel's 100% would already overflow. */
  box-sizing: border-box;
  /* A dialog is the tallest thing on screen; a long list must scroll inside it
     rather than letting the overlay itself grow a scrollbar on mobile. */
  min-width: 0;
  overflow: hidden;
  /* Restated from .lt-app, which the overlay is no longer a descendant of, so
     dialog typography does not silently change with the host's body font. */
  color: var(--lumiverse-text, CanvasText);
  font-size: 13px;
}

/*
 * The focus ring for anything inside a dialog.
 *
 * ".lt-app :focus-visible" covers everything in the panel; the overlay sits
 * outside .lt-app now, so the same rule is restated here rather than letting
 * a dialog's focusable element lose its only outline. (Per-component rules
 * such as ".lt-btn:focus-visible" already cover most controls; this is the
 * catch-all for anything that is not one of them.)
 */
.lt-dialog-overlay :focus-visible {
  outline: 2px solid var(--lumiverse-accent, var(--lumiverse-primary, CanvasText));
  outline-offset: 2px;
}

/*
 * The dialog panel.
 *
 * Sizing lives here rather than in an inline style so it can be media-queried
 * and reasoned about in one place. The rules that matter on a phone:
 *
 *  - box-sizing: border-box makes width the *outer* width. The panel has
 *    10px padding and a 1px border on every side; under the default
 *    content-box sizing those were added on top of the declared width, so a
 *    width: 100% panel rendered 22px wider than its parent and ran off the
 *    right edge of the screen.
 *  - width: min(560px, 100%) therefore now genuinely fits the padded overlay
 *    at every viewport, and max-width: 100vw - 24px is a belt-and-braces cap
 *    for the case where the overlay is ever narrower than the viewport (an
 *    embedded host panel), where percentage widths would be misleading.
 *  - min-width: 0 lets the panel shrink below its content's intrinsic
 *    minimum inside the flex overlay; without it a wide child (a long search
 *    help <code> token) refuses to shrink and re-creates the overflow.
 */
.lt-dialog {
  position: relative;
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  gap: 10px;
  width: min(560px, 100%);
  max-width: calc(100vw - 24px);
  max-height: calc(100% - 24px);
  min-width: 0;
  overflow-y: auto;
  padding: 10px;
  /* --lumiverse-accent is NOT defined by the host theme (the host ships
     --lumiverse-primary; every use of "accent" in its own CSS carries an
     explicit fallback), so an unfallbacked reference would leave the border
     with an invalid colour. Chain to --lumiverse-primary, then to a system
     colour that is always defined. */
  border: 1px solid var(--lumiverse-accent, var(--lumiverse-primary, CanvasText));
  border-radius: var(--lumiverse-radius, 8px);
  /* THE OPACITY FIX. --lumiverse-fill is defined, but it is
     rgba(0, 0, 0, 0.15) — a 15%-alpha *tint*, not a surface. Using it as
     the panel background is what made every dialog look transparent: the page
     behind showed straight through the dialog. A dialog has to be a real
     surface, so this uses the host's opaque panel colours and only falls back
     to a system colour when the host theme defines none of them.
     Canvas is the browser's opaque document background — never transparent,
     never partially alpha, and it follows the OS light/dark preference. */
  background: var(
    --lumiverse-bg-deep,
    var(--lumiverse-bg-opaque, var(--lumiverse-card-bg-solid, Canvas))
  );
  /* Long unbreakable runs (search-help syntax tokens such as A:John, T:Elf
     T:Magic, tag names, backend messages) must wrap or scroll instead of
     widening the panel. anywhere rather than break-word because it also
     affects the intrinsic min-content size, which is what actually pushed the
     flex panel wider than its box. */
  overflow-wrap: anywhere;
}

/*
 * On a phone the overlay padding is the only gutter between the dialog and the
 * screen edge, so it is trimmed to keep the usable panel width as large as
 * possible. Desktop keeps the 12px breathing room from the base rule.
 */
@media (max-width: 640px) {
  .lt-dialog-overlay { padding: 8px; }

  .lt-dialog {
    width: 100%;
    /* Matches the trimmed overlay padding above; without it the 24px cap would
       leave 8px of the dialog clipped on each side. */
    max-width: calc(100vw - 16px);
    max-height: calc(100% - 16px);
  }
}

/*
 * The dialog's content flow and its message strip.
 *
 * .lt-dialog__body holds whatever the specific dialog put in it (fields, tag
 * lists, summaries) and scrolls independently of the panel, so a long dialog
 * keeps its title and its actions reachable. .lt-dialog__messages is the
 * validation/error strip: it is a flex column so several stacked banners keep a
 * consistent gap, and it is empty (and therefore zero-height) most of the time.
 */
.lt-dialog__body {
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-height: 0;
  /* min-width: 0 for the same reason as on the panel: a flex item defaults to
     min-width:auto, i.e. its content's intrinsic min-content width, so one long
     unbreakable line would widen the body past the panel and force a horizontal
     scrollbar on mobile. */
  min-width: 0;
  overflow-y: auto;
}

.lt-dialog__messages {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.lt-dialog__messages:empty { display: none; }

.lt-dialog__title {
  margin: 0;
  font-size: 14px;
  font-weight: 600;
  color: var(--lumiverse-text, CanvasText);
  overflow-wrap: anywhere;
}

/*
 * Prose inside a dialog.
 *
 * These are the long help sentences and the descriptions in the search-help
 * lists. On a narrow phone a single word can be wider than the dialog, so they
 * wrap mid-word (anywhere also shrinks the min-content size, which is what
 * actually stops the container growing) rather than clipping or scrolling
 * sideways. The colour fallbacks mirror the panel's: --lumiverse-text-muted is
 * defined by the host, but a user-authored theme that omits it should still get
 * legible ink instead of inheriting nothing.
 */
.lt-dialog__desc {
  margin: 0;
  font-size: 12px;
  color: var(--lumiverse-text-muted, var(--lumiverse-text, CanvasText));
  overflow-wrap: anywhere;
  min-width: 0;
}

.lt-dialog__actions {
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: 6px;
  min-width: 0;
}

/*
 * A dialog's scrollable list of lines.
 *
 * min-width: 0 + overflow-wrap on the container AND its children: the children
 * are flex items, so each one also needs its own min-width: 0 or the widest
 * line re-inflates the whole list.
 */
.lt-dialog__list {
  display: flex;
  flex-direction: column;
  gap: 4px;
  max-height: 240px;
  min-width: 0;
  overflow-y: auto;
  overflow-wrap: anywhere;
}

.lt-dialog__list > * { min-width: 0; }

/*
 * Search-help syntax tokens (A:John, T:Elf T:Magic) and the A:<field> rows.
 *
 * These are inline <code> runs with no spaces, so they are the single most
 * likely thing to blow out a dialog on a phone. overflow-wrap: anywhere lets
 * them break mid-token instead; max-width: 100% keeps a long token from
 * establishing an overflow contribution larger than the panel.
 */
.lt-dialog code,
.lt-dialog__list code {
  overflow-wrap: anywhere;
  word-break: break-word;
  max-width: 100%;
}

.lt-dialog__summary {
  font-size: 12px;
  color: var(--lumiverse-text-muted, var(--lumiverse-text, CanvasText));
  overflow-wrap: anywhere;
}

.lt-dialog__summary strong { color: var(--lumiverse-text, CanvasText); }

/* ------------------------------------------------------------------ */
/* Sticky failure report panel                                         */
/* ------------------------------------------------------------------ */
.lt-failures {
  position: sticky;
  bottom: 0;
  z-index: 2;
  margin-top: auto;
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 8px;
  border: 1px solid var(--lumiverse-border);
  border-radius: var(--lumiverse-radius);
  background: var(--lumiverse-fill);
}

.lt-failures--succeeded { border-color: var(--lumiverse-border-hover); }

.lt-failures--warning,
.lt-failures--partially_completed { border-color: var(--lumiverse-accent); }

.lt-failures__header {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px 8px;
}

.lt-failures__status {
  margin: 0;
  font-size: 13px;
  font-weight: 600;
  color: var(--lumiverse-text);
}

.lt-failures__spacer { flex: 1 1 auto; }

.lt-failures__groups {
  display: flex;
  flex-direction: column;
  gap: 4px;
  max-height: 220px;
  overflow-y: auto;
}

.lt-failure-group {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px 8px;
  padding: 4px 6px;
  border: 1px solid var(--lumiverse-border);
  border-radius: var(--lumiverse-radius);
  font-size: 12px;
}

.lt-failure-group__label {
  font-weight: 600;
  color: var(--lumiverse-text);
}

.lt-failure-group__detail {
  font-size: 11px;
  color: var(--lumiverse-text-muted);
  flex: 1 1 160px;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
}

/*
 * The container around a failure group's <table>.
 *
 * It scrolls HORIZONTALLY rather than letting the table stretch the sticky
 * failure panel: the panel is pinned to the bottom of a narrow drawer, and a
 * four-column table would otherwise force the whole app into a horizontal
 * scrollbar. Scrolling here keeps the breakage local to the table.
 */
.lt-failures__details {
  flex: 1 1 100%;
  min-width: 0;
  overflow-x: auto;
  overflow-y: visible;
}

/*
 * The failure table itself.
 *
 * Column alignment is explicit because table-layout: auto re-flows the
 * columns every time the error text changes length, which makes rows jump while
 * the user is reading them. Fixed layout plus per-column widths (set inline by
 * the panel) keeps every row aligned. overflow-wrap: anywhere is what stops a
 * long unbroken error message from widening the table past the scroller.
 */
.lt-table {
  width: 100%;
  table-layout: fixed;
  border-collapse: collapse;
  font-size: 12px;
  color: var(--lumiverse-text-muted);
}

.lt-table th,
.lt-table td {
  text-align: left;
  vertical-align: top;
  padding: 2px 6px;
  border-bottom: 1px solid var(--lumiverse-border);
  overflow-wrap: anywhere;
}

.lt-table thead th {
  font-weight: 600;
  color: var(--lumiverse-text-dim);
  border-bottom-color: var(--lumiverse-border-hover);
  white-space: nowrap;
}

.lt-table tbody tr:last-child th,
.lt-table tbody tr:last-child td { border-bottom: 0; }

/* ------------------------------------------------------------------ */
/* States                                                              */
/* ------------------------------------------------------------------ */
.lt-state {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 4px;
  padding: 14px 10px;
  border: 1px solid var(--lumiverse-border);
  border-radius: var(--lumiverse-radius);
  background: var(--lumiverse-fill-subtle);
}

.lt-state__title {
  margin: 0;
  font-size: 13px;
  font-weight: 600;
  color: var(--lumiverse-text);
}

.lt-state__detail {
  margin: 0;
  font-size: 12px;
  color: var(--lumiverse-text-muted);
  overflow-wrap: anywhere;
}

.lt-state--error {
  border-color: var(--lumiverse-accent);
}

.lt-state--error .lt-state__title { color: var(--lumiverse-text); }

.lt-state__actions {
  display: flex;
  gap: 6px;
  margin-top: 4px;
}

.lt-spinner {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px;
  color: var(--lumiverse-text-muted);
  font-size: 12px;
}

.lt-spinner__ring {
  width: 14px;
  height: 14px;
  border-radius: 50%;
  border: 2px solid var(--lumiverse-border);
  border-top-color: var(--lumiverse-accent);
  animation: lt-spin 0.8s linear infinite;
}

@keyframes lt-spin {
  to { transform: rotate(360deg); }
}

/* Query syntax error text shown under a search box. */
.lt-query-errors {
  margin: 0;
  padding: 4px 8px;
  border: 1px solid var(--lumiverse-border);
  border-radius: var(--lumiverse-radius);
  background: var(--lumiverse-fill-subtle);
  color: var(--lumiverse-text-muted);
  font-size: 11px;
}

/* ------------------------------------------------------------------ */
/* Character-search (C:) mode                                         */
/* ------------------------------------------------------------------ */

/*
 * The panel shown when the search query is in C: mode.
 *
 * It MUST NOT look like the tag list. In C: mode the query is matched against
 * CHARACTER NAMES, and a plain search box sitting above it invites the user to
 * read the results as a tag-name search — which is the single most expensive
 * misunderstanding this UI can produce (the user edits tags they never matched).
 * So the mode change is signalled by FOUR independent, non-colour cues, any one
 * of which is enough:
 *
 *   1. a dashed (not solid) left accent bar — a different border vocabulary,
 *   2. a C:-prefixed heading rendered in a monospace face, like the literal
 *      syntax it describes,
 *   3. a tinted surface, so the whole region reads as a different plane,
 *   4. a legend line naming what is being searched.
 *
 * Dashes and typography survive greyscale, forced-colours and colour-blindness,
 * so the distinction does not depend on the tint at all.
 */
.lt-tags-section__character-mode {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin: 0;
  padding: 8px 10px;
  border: 1px dashed var(--lumiverse-accent);
  border-left-width: 4px;
  border-radius: var(--lumiverse-radius);
  background: var(--lumiverse-fill-subtle);
  color: var(--lumiverse-text);
}

/* The C: marker itself, drawn as literal syntax rather than as prose. */
.lt-tags-section__character-mode .lt-state__title {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  color: var(--lumiverse-accent);
}

/* The legend: states plainly what the query matches. */
.lt-tags-section__character-mode .lt-state__detail {
  color: var(--lumiverse-text-muted);
}

/* The character results inside the panel keep the panel's dashed vocabulary. */
.lt-tags-section__character-mode .lt-character-row {
  border-style: dashed;
  transition: background-color var(--lumiverse-transition-fast),
    border-color var(--lumiverse-transition-fast);
}

/* ------------------------------------------------------------------ */
/* Responsive: collapse the toolbar to one column at narrow widths     */
/* ------------------------------------------------------------------ */
.lt-app {
  container-type: inline-size;
  container-name: lumiapp;
}

@container lumiapp (max-width: 520px) {
  .lt-toolbar {
    flex-direction: column;
    align-items: stretch;
  }

  .lt-toolbar__grow { flex: 1 1 auto; min-width: 0; }
  .lt-toolbar__actions { justify-content: flex-start; }
  .lt-app__header { align-items: stretch; }
  .lt-tag-expanded { margin-left: 8px; }
}

@media (max-width: 520px) {
  .lt-toolbar { flex-direction: column; align-items: stretch; }
  .lt-toolbar__actions { justify-content: flex-start; }
}

/* ------------------------------------------------------------------ */
/* Accessibility                                                       */
/* ------------------------------------------------------------------ */
.lt-app :focus-visible {
  outline: 2px solid var(--lumiverse-accent);
  outline-offset: 2px;
}

@media (prefers-reduced-motion: reduce) {
  /* .lt-dialog-overlay is mounted on document.body rather than inside
     .lt-app (see the containing-block note above), so it needs its own copy of
     this rule — otherwise dialog controls keep animating for a user who asked
     the OS for less motion. */
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
}

@media (prefers-contrast: more) {
  .lt-tag-row--selected,
  .lt-character-row--selected {
    border-color: var(--lumiverse-accent);
    border-left-width: 5px;
  }
}
`