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

/**
 * Does `b` come after `a` in the prompt? SillyTavern puts a higher priority
 * (order) closer to the end; on equal priority it sorts by uid ascending and
 * then unshifts every "before character" entry, so the higher uid ends up first.
 */
function promptAfter(a, b) {
    const oa = a.order ?? 100;
    const ob = b.order ?? 100;
    return ob > oa || (ob === oa && b.uid < a.uid);
}

/**
 * Enabled entries first, then disabled; inside each, the order the entries
 * take in the prompt: 80 above 100.
 */
export function sortEntries(entries) {
    return [...entries].sort((a, b) =>
        !!a.disable - !!b.disable || (a.order ?? 100) - (b.order ?? 100) || b.uid - a.uid);
}

/**
 * Priority changes that move list[from] to position `to` of a prompt-ordered
 * list (`to` counts in the list without the moved entry). The moved entry gets
 * its new upper neighbour's priority + 1 (or the lower neighbour's − 1 at the
 * top); entries below it that would no longer come after their upper neighbour
 * are pushed down by the smallest step. Returns [{ uid, from, to }]; the
 * entries in `list` are not modified.
 */
export function reorderPlan(list, from, to) {
    const rest = list.filter((_, i) => i !== from).map((e) => ({ uid: e.uid, order: e.order ?? 100, was: e.order ?? 100 }));
    const x = { uid: list[from].uid, order: list[from].order ?? 100, was: list[from].order ?? 100 };
    rest.splice(to, 0, x);
    const above = rest[to - 1];
    const below = rest[to + 1];
    const fits = (!above || promptAfter(above, x)) && (!below || promptAfter(x, below));
    if (!fits) x.order = above ? above.order + 1 : Math.max(0, below.order - 1);
    for (let j = to + 1; j < rest.length && !promptAfter(rest[j - 1], rest[j]); j++) {
        const prev = rest[j - 1];
        rest[j].order = rest[j].uid < prev.uid ? prev.order : prev.order + 1;
    }
    return rest.filter((e) => e.order !== e.was).map((e) => ({ uid: e.uid, from: e.was, to: e.order }));
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

// ── Duplicates across books ──
//
// "The same entry" = the same text, character for character. "Another
// version" = the same title (case, ё and extra spaces ignored), other text.

export function normTitle(title) {
    return String(title || "").trim().toLowerCase().replace(/ё/g, "е").replace(/\s+/g, " ");
}

/**
 * Who holds what. `books` iterates [bookName, entries[]] (a Map works).
 * byContent: text -> [{ book, uid }]; byTitle: title -> Map(text -> [{ book, uid }]).
 */
export function buildIndex(books) {
    const byContent = new Map();
    const byTitle = new Map();
    const add = (map, key, item) => {
        if (!map.has(key)) map.set(key, []);
        map.get(key).push(item);
    };
    for (const [book, entries] of books) {
        for (const e of entries) {
            const content = e.content || "";
            if (!content.trim()) continue; // empty entries are not duplicates of anything
            add(byContent, content, { book, uid: e.uid });
            const title = normTitle(e.comment);
            if (!title) continue;
            if (!byTitle.has(title)) byTitle.set(title, new Map());
            add(byTitle.get(title), content, { book, uid: e.uid });
        }
    }
    return { byContent, byTitle };
}

const byBookName = (a, b) => a.book.localeCompare(b.book, "ru", { sensitivity: "base" });

/** One holder per book, alphabetical, without `except`. */
function perBook(holders, except) {
    const seen = new Set([except]);
    return holders.filter((h) => !seen.has(h.book) && seen.add(h.book)).sort(byBookName);
}

/** Other books with exactly this text: [{ book, uid }]. */
export function copiesOf(index, book, content) {
    return perBook(index.byContent.get(content || "") || [], book);
}

/**
 * Other texts under the same title, the most widespread first:
 * [{ content, holders: [{ book, uid }] }]. Versions inside the same book count too.
 */
export function versionsOf(index, title, content) {
    const texts = index.byTitle.get(normTitle(title));
    if (!texts) return [];
    return [...texts]
        .filter(([text]) => text !== (content || ""))
        .map(([text, holders]) => ({ content: text, holders: perBook(holders, null) }))
        .sort((a, b) => b.holders.length - a.holders.length);
}

/**
 * Two books side by side. Entries pair up by identical text first, then the
 * rest by title. Returns { same: [{a, b}], changed: [{a, b}], onlyA, onlyB }.
 */
export function compareBooks(entriesA, entriesB) {
    const restB = [...entriesB];
    const take = (match) => {
        const i = restB.findIndex(match);
        return i < 0 ? null : restB.splice(i, 1)[0];
    };
    const same = [];
    const left = [];
    for (const a of entriesA) {
        const b = take((x) => (x.content || "") === (a.content || ""));
        if (b) same.push({ a, b });
        else left.push(a);
    }
    const changed = [];
    const onlyA = [];
    for (const a of left) {
        const t = normTitle(a.comment);
        const b = t ? take((x) => normTitle(x.comment) === t) : null;
        if (b) changed.push({ a, b });
        else onlyA.push(a);
    }
    return { same, changed, onlyA, onlyB: restB };
}

// ── Text diff ──

const DIFF_CELLS = 3_000_000; // bigger pieces are shown as "replaced" whole

/** Longest-common-subsequence diff of two token arrays: [[op, token]]. */
function diffTokens(a, b) {
    let start = 0;
    while (start < a.length && start < b.length && a[start] === b[start]) start++;
    let endA = a.length;
    let endB = b.length;
    while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) { endA--; endB--; }
    const out = a.slice(0, start).map((t) => ["=", t]);
    const A = a.slice(start, endA);
    const B = b.slice(start, endB);
    const n = A.length;
    const m = B.length;
    if (n * m > DIFF_CELLS) {
        out.push(...A.map((t) => ["-", t]), ...B.map((t) => ["+", t]));
    } else {
        const w = m + 1;
        const dp = new Uint32Array((n + 1) * w);
        for (let i = n - 1; i >= 0; i--) {
            for (let j = m - 1; j >= 0; j--) {
                dp[i * w + j] = A[i] === B[j] ? dp[(i + 1) * w + j + 1] + 1 : Math.max(dp[(i + 1) * w + j], dp[i * w + j + 1]);
            }
        }
        let i = 0;
        let j = 0;
        while (i < n && j < m) {
            if (A[i] === B[j]) { out.push(["=", A[i]]); i++; j++; }
            else if (dp[(i + 1) * w + j] >= dp[i * w + j + 1]) out.push(["-", A[i++]]);
            else out.push(["+", B[j++]]);
        }
        while (i < n) out.push(["-", A[i++]]);
        while (j < m) out.push(["+", B[j++]]);
    }
    out.push(...a.slice(endA).map((t) => ["=", t]));
    return out;
}

function words(s) {
    return s.match(/[\p{L}\p{N}_]+|\s+|[^\p{L}\p{N}_\s]/gu) || [];
}

/**
 * What changed from text `a` to text `b`: [{ op: "=" | "-" | "+", text }].
 * Lines first, then words inside the changed lines. Inside a change, removed
 * text comes before added text, and tiny unchanged bits (a space between two
 * changed words) are folded into the change so it reads as one replacement.
 */
export function diffText(a, b) {
    const lines = (s) => (s ? s.split(/(?<=\n)/) : []);
    const flat = [];
    let del = "";
    let ins = "";
    const flushRun = () => {
        if (del && ins) flat.push(...diffTokens(words(del), words(ins)));
        else if (del) flat.push(["-", del]);
        else if (ins) flat.push(["+", ins]);
        del = ins = "";
    };
    for (const [op, line] of diffTokens(lines(a || ""), lines(b || ""))) {
        if (op === "-") del += line;
        else if (op === "+") ins += line;
        else { flushRun(); flat.push(["=", line]); }
    }
    flushRun();

    // Merge into runs: [{ op, text }] with changes as { del, ins }.
    const runs = [];
    for (const [op, text] of flat) {
        const last = runs[runs.length - 1];
        if (op === "=") {
            if (last?.op === "=") last.text += text;
            else runs.push({ op, text });
        } else {
            const run = last && last.op !== "=" ? last : (runs.push({ op: "~", del: "", ins: "" }), runs[runs.length - 1]);
            run[op === "-" ? "del" : "ins"] += text;
        }
    }
    // Fold short unchanged bits between two changes into them.
    for (let i = 1; i < runs.length - 1; i++) {
        const r = runs[i];
        if (r.op === "=" && r.text.length <= 3 && !r.text.includes("\n") && runs[i - 1].op === "~" && runs[i + 1].op === "~") {
            const prev = runs[i - 1];
            const next = runs[i + 1];
            prev.del += r.text + next.del;
            prev.ins += r.text + next.ins;
            runs.splice(i, 2);
            i--;
        }
    }
    const out = [];
    for (const r of runs) {
        if (r.op === "=") out.push({ op: "=", text: r.text });
        else {
            if (r.del) out.push({ op: "-", text: r.del });
            if (r.ins) out.push({ op: "+", text: r.ins });
        }
    }
    return out;
}

/** First non-empty line of the text, shortened. */
export function preview(content, max = 110) {
    const line = String(content || "").split(/\r?\n/).find((l) => l.trim()) || "";
    const t = line.trim();
    return t.length > max ? t.slice(0, max - 1).trimEnd() + "…" : t;
}
