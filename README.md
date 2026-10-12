# LumiTag — Lumiverse Tag Manager

A dedicated tag manager for your Lumiverse character library, in its own drawer
tab. LumiTag keeps your character tags organized instead of letting them sprawl.

## What it does

- **Derived tag catalog** — every tag across your whole library, with live counts,
  built from your actual characters.
- **Create, rename, merge, delete tags** — rename a tag everywhere it is used,
  merge two tags into one, and remove tags from characters.
- **Bulk operations** — select characters by filter or by hand, then add or remove
  tags across all of them at once. Selections survive paging, so you can tick
  characters on one page, move to another, and still act on the whole set.
- **Paged lists** — the character list, tag list and tag pickers are paged rather
  than truncated, so every item in a large library is reachable. Your library is
  loaded in full, so counts, filters and tag totals stay exact.
- **Advanced query language** — filter characters with a compact search syntax
  (see below).
- **Per-character partial-failure reporting** — a bulk operation never silently
  half-applies. Characters that succeeded and characters that failed are reported
  separately, each failure with its own reason, and you can retry just the
  failures. Retries re-read each character first, so a retry can never overwrite
  an edit made in the meantime.

## Required permission

LumiTag requests the **`characters`** permission.

This is a privileged permission: Lumiverse requires an **admin grant** before it
is active. Until it is granted, the tag catalog is empty and tag editing is
disabled. LumiTag needs it because reading and writing character tags is the
entire point of the extension — there is no unprivileged alternative.

LumiTag requests nothing else. It does not read or write chats, prompts, presets,
world books, or media, and it never sends your characters anywhere.

## Search syntax

The Tag Manager query bar accepts a compact filter language. Terms combine
naturally and are matched against your character library.

| Syntax | Meaning |
|---|---|
| `fantasy` | Bare term — matches the character **name** |
| `T:fantasy` | Character **tag** is `fantasy` |
| `C:Bob` | Character **name** is `Bob` |
| `space separated terms` | **AND** — all terms must match |
| `term1, term2` | **OR** — any of the terms may match |
| `-term` | **Negation** — the term must *not* match |

Search covers character names and tags only. There is no prose search: an
`A:` term searches names for that literal text, and any other prefix
(`Z:`, `author:`) is treated as plain name text rather than an error.

### Examples

```
T:fantasy                          every character tagged "fantasy"
T:fantasy -T:horror                fantasy, but not horror
fantasy, sci-fi                    name contains "fantasy" OR "sci-fi"
C:Bob T:villain                    named Bob and tagged "villain"
fantasy T:dark                     name contains "fantasy" AND tagged "dark"
```

`T:` and `C:` scope the term that follows them. Prefixing a term with `-`
excludes it. Spaces mean AND and commas mean OR; use both for groups.

## Documentation

`DEVELOPMENT_NOTES.md` documents the verified Lumiverse Spindle API surface, the
permission model, the backend/frontend split, known API limitations, and the
implementation plan.
