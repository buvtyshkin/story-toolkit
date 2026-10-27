// ============================================================
//  Story Toolkit — Lorebooks: pure data helpers
//
//  No DOM, no SillyTavern imports: node can test this file.
//  Rule of the module: change only the fields the user edits,
//  never rebuild an entry. Everything else in it (Memory Books
//  STMB_* fields, other extensions' fields) must survive as is.
// ============================================================

// The user's standard entry: always in the prompt, before the character card.
export const STANDARD = Object.freeze({
    constant: true,
    position: 0,
    probability: 100,
    useProbability: true,
    vectorized: false,
});

const POSITION_LABELS = {
    0: "перед персонажем",
    1: "после персонажа",
    2: "в начале заметки автора",
    3: "в конце заметки автора",
    4: "на глубине",
    5: "в начале примеров диалога",
    6: "в конце примеров диалога",
    7: "outlet",
};

export function isMemoryEntry(entry) {
    return !!entry?.stmemorybooks;
}

/** Human-readable list of the ways an entry differs from STANDARD; empty if it does not. */
export function deviations(entry) {
    const out = [];
    if (!entry.constant) out.push("срабатывает по ключевым словам, а не постоянно");
    if (entry.vectorized) out.push("векторная");
    const position = entry.position ?? 0;
    if (position !== 0) {
        out.push(`позиция: ${POSITION_LABELS[position] ?? position}` + (position === 4 ? ` ${entry.depth}` : ""));
    }
    const probability = entry.useProbability === false ? 100 : (entry.probability ?? 100);
    if (probability !== 100) out.push(`вероятность ${probability}%`);
    return out;
}

/**
 * Write `patch` into one entry of `data`, field by field.
 * `mirror(data, uid, field, value)` keeps a card-embedded copy (originalData) in step.
 * Returns false if the entry is gone (deleted elsewhere since the user opened it).
 */
export function applyPatch(data, uid, patch, mirror = () => {}) {
    const entry = data?.entries?.[uid];
    if (!entry) return false;
    for (const [field, value] of Object.entries(patch)) {
        entry[field] = value;
        mirror(data, entry.uid ?? Number(uid), field, value);
    }
    return true;
}

/** Fields for a new entry: the standard, enabled, titled. */
export function newEntryFields(title = "", content = "") {
    return { ...STANDARD, comment: title, content, order: 100, disable: false, addMemo: true };
}

/** Regular entries and Memory Books memories, each as an array. */
export function splitEntries(data) {
    const regular = [];
    const memories = [];
    for (const entry of Object.values(data?.entries || {})) {
        (isMemoryEntry(entry) ? memories : regular).push(entry);
    }
    return { regular, memories };
}

const byTitle = (a, b) => (a.comment || "").localeCompare(b.comment || "", "ru", { sensitivity: "base" });

/**
 * Enabled entries first, then disabled; inside each, the order the entries take
 * in the prompt. SillyTavern puts a higher priority (order) closer to the end,
 * so ascending order reads top to bottom: 80 above 100.
 */
export function sortEntries(entries) {
    return [...entries].sort((a, b) =>
        !!a.disable - !!b.disable || (a.order ?? 100) - (b.order ?? 100) || byTitle(a, b) || a.uid - b.uid);
}

// ── Folders (for lorebooks) ──
//
// folders: { [id]: { name, parent } } (parent: id or null), bookFolder: { [book]: id }.
// Both live in extension settings; the lorebook files are not touched.

/** Child folders of `parent` (null = top level), alphabetical. */
export function childFolders(folders, parent) {
    return Object.entries(folders || {})
        .filter(([, f]) => (f.parent ?? null) === parent)
        .map(([id, f]) => ({ id, name: f.name }))
        .sort((a, b) => a.name.localeCompare(b.name, "ru", { sensitivity: "base" }));
}

/** The folder a book sits in, or null if none (or its folder is gone). */
export function folderOf(folders, bookFolder, book) {
    const id = bookFolder?.[book];
    return id && folders?.[id] ? id : null;
}

/** Folder names from the top down to `id`. */
export function folderPath(folders, id) {
    const path = [];
    const seen = new Set();
    while (id && folders?.[id] && !seen.has(id)) {
        seen.add(id);
        path.unshift(folders[id].name);
        id = folders[id].parent;
    }
    return path;
}

/** Every folder as [{ id, name, depth }], in tree order: for "move to folder" lists. */
export function flatFolders(folders, parent = null, depth = 0) {
    return childFolders(folders, parent).flatMap((f) => [{ ...f, depth }, ...flatFolders(folders, f.id, depth + 1)]);
}

/**
 * Remove a folder: its subfolders and books move up to its parent.
 * Mutates `folders` and `bookFolder`.
 */
export function deleteFolder(folders, bookFolder, id) {
    const parent = folders[id]?.parent ?? null;
    for (const f of Object.values(folders)) if (f.parent === id) f.parent = parent;
    for (const [book, fid] of Object.entries(bookFolder)) {
        if (fid !== id) continue;
        if (parent) bookFolder[book] = parent;
        else delete bookFolder[book];
    }
    delete folders[id];
}

/** Number of books in a folder and all its subfolders. */
export function countBooks(folders, bookFolder, books, id) {
    let n = 0;
    for (const b of books) {
        let f = folderOf(folders, bookFolder, b);
        const seen = new Set();
        while (f && !seen.has(f)) {
            if (f === id) { n++; break; }
            seen.add(f);
            f = folders[f].parent;
        }
    }
    return n;
}

// ── Groups (for entries) ──
//
// One ordered list for all books: groups = [{ id, name }]. An entry keeps the
// id in its own field, so the group travels with copies of the entry.

export const GROUP_FIELD = "stk_group";

/**
 * Entries split by group, in the order of `groups`, then the ungrouped ones
 * (also those whose group was deleted). Empty groups are left out.
 * Returns [{ group: {id, name} | null, entries: sorted }].
 */
export function groupEntries(entries, groups) {
    const known = new Set((groups || []).map((g) => g.id));
    const by = new Map();
    for (const e of entries) {
        const id = known.has(e[GROUP_FIELD]) ? e[GROUP_FIELD] : null;
        if (!by.has(id)) by.set(id, []);
        by.get(id).push(e);
    }
    const out = [];
    for (const g of groups || []) if (by.has(g.id)) out.push({ group: g, entries: sortEntries(by.get(g.id)) });
    if (by.has(null)) out.push({ group: null, entries: sortEntries(by.get(null)) });
    return out;
}

/** Move a group one place up (dir -1) or down (+1). Mutates and returns `groups`. */
export function moveGroup(groups, id, dir) {
    const i = groups.findIndex((g) => g.id === id);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= groups.length) return groups;
    [groups[i], groups[j]] = [groups[j], groups[i]];
    return groups;
}

/** First non-empty line of the text, shortened. */
export function preview(content, max = 110) {
    const line = String(content || "").split(/\r?\n/).find((l) => l.trim()) || "";
    const t = line.trim();
    return t.length > max ? t.slice(0, max - 1).trimEnd() + "…" : t;
}
