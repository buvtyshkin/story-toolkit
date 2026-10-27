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
 * "prompt": the order the entries take in the prompt. SillyTavern puts a higher
 * priority (order) closer to the end, so ascending order reads top to bottom.
 * "title": alphabetical.
 */
export function sortEntries(entries, mode = "prompt") {
    const list = [...entries];
    if (mode === "title") return list.sort((a, b) => byTitle(a, b) || a.uid - b.uid);
    return list.sort((a, b) => (a.order ?? 100) - (b.order ?? 100) || byTitle(a, b) || a.uid - b.uid);
}

/** First non-empty line of the text, shortened. */
export function preview(content, max = 110) {
    const line = String(content || "").split(/\r?\n/).find((l) => l.trim()) || "";
    const t = line.trim();
    return t.length > max ? t.slice(0, max - 1).trimEnd() + "…" : t;
}
