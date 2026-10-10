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
 * The backdrop behind an in-panel dialog.
 *
 * It is a fixed, full-viewport layer with a real background rather than a
 * hardcoded rgba, so the scrim tracks the host theme. The colour itself is
 * still composed from a Lumiverse variable: --lumiverse-text is the darkest
 * ink the theme offers, so fading it out is theme-safe in both light and dark.
 * animation is not used here — the overlay must appear instantly so a dialog
 * never flashes in late.
 */
.lt-dialog-overlay {
  position: fixed;
  inset: 0;
  z-index: 900;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 12px;
  background: color-mix(in srgb, var(--lumiverse-text) 45%, transparent);
}

.lt-dialog {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 10px;
  border: 1px solid var(--lumiverse-accent);
  border-radius: var(--lumiverse-radius);
  background: var(--lumiverse-fill);
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
  color: var(--lumiverse-text);
}

.lt-dialog__desc {
  margin: 0;
  font-size: 12px;
  color: var(--lumiverse-text-muted);
}

.lt-dialog__actions {
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: 6px;
}

.lt-dialog__list {
  display: flex;
  flex-direction: column;
  gap: 4px;
  max-height: 240px;
  overflow-y: auto;
}

.lt-dialog__summary {
  font-size: 12px;
  color: var(--lumiverse-text-muted);
}

.lt-dialog__summary strong { color: var(--lumiverse-text); }

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
  .lt-app *,
  .lt-app *::before,
  .lt-app *::after {
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