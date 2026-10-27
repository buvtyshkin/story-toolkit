# Lorebooks module — plan

A cleaner lorebook editor inside Story Toolkit. The user's lorebooks are all
"constant, before character, 100%"; only priority (`order`) varies. Many books
are near-duplicates of each other (e.g. "Семья" exists in 38 books).

## Decisions (agreed with the user)

- Lives in Story Toolkit as a new module.
- Folders/subfolders for **lorebooks** (stored in extension settings, keyed by
  book name). A book with no folder or an unknown name goes to "No folder".
- Groups for **entries** inside a book (character descriptions, chronology…):
  one level, a global list of group names shared by all books (the books are
  near-duplicates, so the same groups fit everywhere). The group is stored on
  the entry itself (`stk_group`), so it travels with copies. Visual only: the
  prompt order is still decided by priority.
- "Identical entry" = identical `content`, character for character. Title and
  priority may differ.
- Editing all identical copies at once: postponed (too risky).

## Safety rules

- Read/write only through ST's `loadWorldInfo` / `saveWorldInfo` (shared cache
  with Memory Books).
- Touch only the fields the user edits; keep every unknown field (`STMB_*`,
  other extensions) as is.
- Re-read the book right before saving and apply only the user's changes.
- Back up a book before any bulk action.
- Never rename books silently (breaks chat/character bindings and Memory Books).
- Memory Books entries (`stmemorybooks: true`) are shown in a separate collapsed
  section and not edited.
- ST's own World Info editor stays available.

## Steps

- [x] 0. Data layer: safe load/patch/save, backups, tests.
- [x] 1. Clean editor: on/off, title, priority, text. New entries use the
      standard (constant, before char, 100%). Non-standard entries get a ⚠ and
      an explicit "make standard" button. Memory Books section.
- [x] 2. Structure: folders for books; groups for entries.
- [x] 3. Duplicates: hover shows the books with an identical entry; a mark for
      "same title, different text" with a diff view; two-book comparison.
- [ ] 4. Copy/move to one or several books, bulk on/off, priority, delete,
      group; conflict prompt on same title.
- [ ] 5. Search across all books.
- [x] Extra (asked after step 2): "Порядок" mode — drag entries (or arrows) to set
      priorities in prompt order; entry <-> Memory Books memory (the stmemorybooks flag).
