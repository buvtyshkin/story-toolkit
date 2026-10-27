// Run: node --experimental-detect-module --test tests/   (the flag is not needed on Node 22+)
import { test } from "node:test";
import assert from "node:assert/strict";
import {
    STANDARD, isMemoryEntry, deviations, applyPatch, newEntryFields,
    splitEntries, sortEntries, preview,
    childFolders, folderOf, folderPath, flatFolders, deleteFolder, countBooks,
    GROUP_FIELD, groupEntries, moveGroup, reorderPlan,
    normTitle, buildIndex, copiesOf, versionsOf, compareBooks, diffText,
    placeCopy, parsePriority, backupFileName,
    searchWords, searchEntries, highlightParts, snippetOf,
} from "../lore-data.js";

const standard = (extra = {}) => ({ uid: 0, comment: "x", content: "y", order: 100, disable: false, ...STANDARD, ...extra });

test("a standard entry has no deviations", () => {
    assert.deepEqual(deviations(standard()), []);
    assert.deepEqual(deviations(newEntryFields("t", "c")), []);
});

test("deviations name what is off", () => {
    assert.equal(deviations(standard({ constant: false })).length, 1);
    assert.match(deviations(standard({ position: 1 }))[0], /после персонажа/);
    assert.match(deviations(standard({ position: 4, depth: 15 }))[0], /глубине 15/);
    assert.match(deviations(standard({ probability: 30 }))[0], /30%/);
    // probability is ignored when useProbability is off
    assert.deepEqual(deviations(standard({ probability: 30, useProbability: false })), []);
    assert.equal(deviations(standard({ vectorized: true })).length, 1);
});

test("applyPatch changes only the patched fields and keeps foreign ones", () => {
    const data = {
        entries: {
            5: standard({ uid: 5, stmemorybooks: true, STMB_start: 10, STMB_end: 20, key: ["a"], custom: { deep: 1 } }),
        },
    };
    const before = structuredClone(data.entries[5]);
    assert.equal(applyPatch(data, 5, { content: "new", order: 90 }), true);
    const after = data.entries[5];
    assert.equal(after.content, "new");
    assert.equal(after.order, 90);
    for (const k of Object.keys(before)) {
        if (k !== "content" && k !== "order") assert.deepEqual(after[k], before[k], k);
    }
});

test("applyPatch reports a vanished entry and mirrors each field", () => {
    assert.equal(applyPatch({ entries: {} }, 3, { content: "x" }), false);
    const calls = [];
    const data = { entries: { 2: standard({ uid: 2 }) } };
    applyPatch(data, "2", { comment: "a", disable: true }, (d, uid, f, v) => calls.push([uid, f, v]));
    assert.deepEqual(calls, [[2, "comment", "a"], [2, "disable", true]]);
});

test("splitEntries separates Memory Books memories", () => {
    const data = { entries: { 0: standard({ uid: 0 }), 1: standard({ uid: 1, stmemorybooks: true }) } };
    const { regular, memories } = splitEntries(data);
    assert.deepEqual(regular.map((e) => e.uid), [0]);
    assert.deepEqual(memories.map((e) => e.uid), [1]);
    assert.equal(isMemoryEntry(memories[0]), true);
});

test("sort: enabled first, then prompt order (priority up, equal priority: higher uid first)", () => {
    const list = [
        standard({ uid: 0, order: 101 }),
        standard({ uid: 1, order: 99 }),
        standard({ uid: 2, order: 100 }),
        standard({ uid: 3, order: 100 }),
        standard({ uid: 4, order: 80, disable: true }),
        standard({ uid: 5, order: 120, disable: true }),
    ];
    assert.deepEqual(sortEntries(list).map((e) => e.uid), [1, 3, 2, 0, 4, 5]);
});

// Apply a plan and re-sort, to check the entry really lands where it was dropped.
function applyPlan(list, plan) {
    const byUid = new Map(list.map((e) => [e.uid, { ...e }]));
    for (const c of plan) byUid.get(c.uid).order = c.to;
    return sortEntries([...byUid.values()]);
}

function expectMove(list, from, to) {
    const sorted = sortEntries(list);
    const plan = reorderPlan(sorted, from, to);
    const want = sorted.filter((_, i) => i !== from);
    want.splice(to, 0, sorted[from]);
    assert.deepEqual(applyPlan(sorted, plan).map((e) => e.uid), want.map((e) => e.uid));
    return plan;
}

test("reorder: the user's example — 80 dropped below 100 becomes 101, nothing else moves", () => {
    const list = [standard({ uid: 1, order: 80 }), standard({ uid: 2, order: 100 }), standard({ uid: 3, order: 120 })];
    const plan = expectMove(list, 0, 1);
    assert.deepEqual(plan, [{ uid: 1, from: 80, to: 101 }]);
});

test("reorder: a gap is used, the top gets the neighbour − 1, a valid spot changes nothing", () => {
    const list = [standard({ uid: 1, order: 90 }), standard({ uid: 2, order: 100 }), standard({ uid: 3, order: 110 })];
    assert.deepEqual(expectMove(list, 2, 1), [{ uid: 3, from: 110, to: 91 }]);
    assert.deepEqual(expectMove(list, 2, 0), [{ uid: 3, from: 110, to: 89 }]);
    assert.deepEqual(reorderPlan(sortEntries(list), 1, 1), []);
});

test("reorder: dropping into a block of equal priorities pushes the rest down", () => {
    const list = [
        standard({ uid: 10, order: 80 }),
        standard({ uid: 9, order: 100 }), standard({ uid: 8, order: 100 }), standard({ uid: 7, order: 100 }),
        standard({ uid: 6, order: 101 }), standard({ uid: 5, order: 130 }),
    ];
    // sorted: 10(80) 9 8 7 (100) 6(101) 5(130); drop 10 between 9 and 8
    const plan = expectMove(list, 0, 1);
    const to = Object.fromEntries(plan.map((c) => [c.uid, c.to]));
    assert.equal(to[10], 101);
    assert.equal(to[5], undefined); // the 130 is far enough, untouched
    for (const c of plan) assert.ok(c.to >= c.from || c.uid === 10);
});

test("reorder: every move in a messy list lands exactly", () => {
    const list = [80, 100, 100, 100, 101, 101, 0, 0, 5, 100].map((order, uid) => standard({ uid, order }));
    for (let from = 0; from < list.length; from++) {
        for (let to = 0; to < list.length; to++) expectMove(list, from, to);
    }
});

test("folders: children, path, flat list, counts", () => {
    const folders = { a: { name: "Фишер", parent: null }, b: { name: "Джоли", parent: "a" }, c: { name: "Ева", parent: "a" }, d: { name: "Карнос", parent: null } };
    const bookFolder = { "J1": "b", "J2": "b", "E1": "c", "X": "gone" };
    assert.deepEqual(childFolders(folders, null).map((f) => f.id), ["d", "a"]); // Карнос, Фишер
    assert.deepEqual(childFolders(folders, "a").map((f) => f.name), ["Джоли", "Ева"]);
    assert.deepEqual(folderPath(folders, "b"), ["Фишер", "Джоли"]);
    assert.deepEqual(flatFolders(folders).map((f) => [f.id, f.depth]), [["d", 0], ["a", 0], ["b", 1], ["c", 1]]);
    assert.equal(folderOf(folders, bookFolder, "X"), null); // its folder no longer exists
    assert.equal(countBooks(folders, bookFolder, ["J1", "J2", "E1", "X"], "a"), 3);
    assert.equal(countBooks(folders, bookFolder, ["J1", "J2", "E1", "X"], "c"), 1);
});

test("deleting a folder moves its books and subfolders up", () => {
    const folders = { a: { name: "A", parent: null }, b: { name: "B", parent: "a" }, c: { name: "C", parent: "b" } };
    const bookFolder = { x: "b", y: "a", z: "c" };
    deleteFolder(folders, bookFolder, "b");
    assert.deepEqual(Object.keys(folders).sort(), ["a", "c"]);
    assert.equal(folders.c.parent, "a");
    assert.deepEqual(bookFolder, { x: "a", y: "a", z: "c" });
    deleteFolder(folders, bookFolder, "a");
    assert.equal(folders.c.parent, null);
    assert.deepEqual(bookFolder, { z: "c" }); // top level = no entry
});

test("groupEntries follows the group order, ungrouped last, empty groups skipped", () => {
    const groups = [{ id: "g1", name: "Джоли" }, { id: "g2", name: "Ник" }, { id: "g3", name: "Хронология" }];
    const list = [
        standard({ uid: 0, stk_group: "g3", order: 100 }),
        standard({ uid: 1, order: 100 }),
        standard({ uid: 2, stk_group: "g1", order: 101 }),
        standard({ uid: 3, stk_group: "g1", order: 90 }),
        standard({ uid: 4, stk_group: "deleted" }),
    ];
    const out = groupEntries(list, groups);
    assert.deepEqual(out.map((s) => s.group?.id ?? null), ["g1", "g3", null]);
    assert.deepEqual(out[0].entries.map((e) => e.uid), [3, 2]);
    assert.deepEqual(out[2].entries.map((e) => e.uid), [4, 1]); // equal priority: higher uid first
    assert.equal(GROUP_FIELD, "stk_group");
});

test("moveGroup swaps neighbours and stops at the ends", () => {
    const g = [{ id: "a" }, { id: "b" }, { id: "c" }];
    assert.deepEqual(moveGroup(g, "c", -1).map((x) => x.id), ["a", "c", "b"]);
    assert.deepEqual(moveGroup(g, "a", -1).map((x) => x.id), ["a", "c", "b"]);
    assert.deepEqual(moveGroup(g, "b", 1).map((x) => x.id), ["a", "c", "b"]);
});

test("preview takes the first non-empty line", () => {
    assert.equal(preview("\n\n  Шрамы: много  \nещё"), "Шрамы: много");
    assert.equal(preview("a".repeat(200), 10).length, 10);
});

// ── Duplicates ──

const books = new Map([
    ["Фишер", [standard({ uid: 1, comment: "Семья", content: "мама" }), standard({ uid: 2, comment: "Шрамы", content: "много" }), standard({ uid: 3, comment: "Пусто", content: " " })]],
    ["Джоли", [standard({ uid: 7, comment: "семья ", content: "мама" }), standard({ uid: 8, comment: "Шрамы", content: "мало" })]],
    ["Ева", [standard({ uid: 4, comment: "Семья", content: "мама и папа" }), standard({ uid: 5, comment: "Другое", content: "много" }), standard({ uid: 6, comment: "Пусто", content: " " })]],
]);

test("copies: the same text in other books, one per book, empty texts ignored", () => {
    const idx = buildIndex(books);
    assert.deepEqual(copiesOf(idx, "Фишер", "мама"), [{ book: "Джоли", uid: 7 }]);
    assert.deepEqual(copiesOf(idx, "Фишер", "много"), [{ book: "Ева", uid: 5 }]); // title does not matter
    assert.deepEqual(copiesOf(idx, "Фишер", " "), []);
    assert.deepEqual(copiesOf(idx, "Фишер", "нет такого"), []);
});

test("versions: same title (case, ё, spaces ignored), other text", () => {
    assert.equal(normTitle("  Семья  Ёлкиных "), "семья елкиных");
    const idx = buildIndex(books);
    assert.deepEqual(versionsOf(idx, "Семья", "мама"), [{ content: "мама и папа", holders: [{ book: "Ева", uid: 4 }] }]);
    assert.deepEqual(versionsOf(idx, "Шрамы", "много").map((x) => x.content), ["мало"]);
    assert.deepEqual(versionsOf(idx, "Другое", "много"), []);
});

test("compareBooks pairs by text, then by title", () => {
    const r = compareBooks(books.get("Фишер"), books.get("Ева"));
    assert.deepEqual(r.same.map((p) => [p.a.uid, p.b.uid]), [[2, 5], [3, 6]]);
    assert.deepEqual(r.changed.map((p) => [p.a.uid, p.b.uid]), [[1, 4]]);
    assert.deepEqual([r.onlyA, r.onlyB], [[], []]);
    const r2 = compareBooks(books.get("Фишер"), books.get("Джоли"));
    assert.deepEqual(r2.same.map((p) => [p.a.uid, p.b.uid]), [[1, 7]]);
    assert.deepEqual(r2.changed.map((p) => [p.a.uid, p.b.uid]), [[2, 8]]);
    assert.deepEqual(r2.onlyA.map((e) => e.uid), [3]);
});

const side = (ops, op) => ops.filter((o) => o.op === "=" || o.op === op).map((o) => o.text).join("");

test("diffText: a word replaced reads as one change", () => {
    assert.deepEqual(diffText("У Ника три шрама на спине.", "У Ника два шрама на спине."), [
        { op: "=", text: "У Ника " }, { op: "-", text: "три" }, { op: "+", text: "два" }, { op: "=", text: " шрама на спине." },
    ]);
    assert.deepEqual(diffText("same", "same"), [{ op: "=", text: "same" }]);
    assert.deepEqual(diffText("", "new"), [{ op: "+", text: "new" }]);
});

test("diffText: neighbouring changed words fold into one replacement", () => {
    assert.deepEqual(diffText("он был высокий", "она была высокая"),
        [{ op: "-", text: "он был высокий" }, { op: "+", text: "она была высокая" }]);
});

test("diffText: added paragraph, whitespace change", () => {
    assert.deepEqual(diffText("Первый.\nТретий.", "Первый.\nВторой.\nТретий."),
        [{ op: "=", text: "Первый.\n" }, { op: "+", text: "Второй.\n" }, { op: "=", text: "Третий." }]);
    const ws = diffText("a b", "a  b");
    assert.equal(side(ws, "-"), "a b");
    assert.equal(side(ws, "+"), "a  b");
});

test("diffText always rebuilds both texts", () => {
    let seed = 7;
    const rnd = (n) => (seed = (seed * 48271) % 2147483647) % n;
    const vocab = ["Ник", "Джоли", " ", " ", "\n", ",", ".", "шрам", "дом", "война"];
    const text = () => Array.from({ length: rnd(40) }, () => vocab[rnd(vocab.length)]).join("");
    for (let k = 0; k < 300; k++) {
        const a = text();
        const b = rnd(2) ? text() : a.replace(/шрам/, "дом").replace(/\n/, "");
        const ops = diffText(a, b);
        assert.equal(side(ops, "-"), a);
        assert.equal(side(ops, "+"), b);
    }
});

// ── Copying and bulk edits ──

test("placeCopy: same text anywhere, else a title twin, else new", () => {
    const target = [standard({ uid: 3, comment: "Другое имя", content: "мама" }), standard({ uid: 4, comment: "ШРАМЫ", content: "мало" }), standard({ uid: 5, comment: "Пусто", content: "" })];
    assert.deepEqual(placeCopy(standard({ comment: "Семья", content: "мама" }), target), { kind: "same", uid: 3 });
    assert.deepEqual(placeCopy(standard({ comment: "Шрамы", content: "много" }), target), { kind: "conflict", uid: 4 });
    assert.deepEqual(placeCopy(standard({ comment: "Новое", content: "текст" }), target), { kind: "new" });
    // an empty text is not "the same entry"
    assert.deepEqual(placeCopy(standard({ comment: "Ещё", content: "" }), target), { kind: "new" });
});

test("parsePriority: a number sets, a sign shifts", () => {
    assert.equal(parsePriority("80", 100), 80);
    assert.equal(parsePriority(" +5 ", 100), 105);
    assert.equal(parsePriority("-5", 100), 95);
    assert.equal(parsePriority("−200", 100), 0); // typographic minus, floor at 0
    assert.equal(parsePriority("abc", 100), null);
    assert.equal(parsePriority("", 100), null);
});

test("backupFileName passes SillyTavern's file name rule", () => {
    const at = new Date(2026, 9, 27, 3, 4, 5);
    assert.equal(backupFileName("Фишер Джоли 3", at), "lorebook-backup_Fisher_Dzholi_3_20261027-030405.json");
    assert.equal(backupFileName("!Fisher Jolie non-card MAIN (2)", at), "lorebook-backup_Fisher_Jolie_non-card_MAIN_2_20261027-030405.json");
    assert.equal(backupFileName("???", at), "lorebook-backup_book_20261027-030405.json");
    for (const n of ["Карнос (Самый последний)", "Мир Цербера", "a/b\c"]) assert.match(backupFileName(n), /^[a-zA-Z0-9_\-.]+$/);
});

// ── Search ──

const lib = new Map([
    ["Фишер", [standard({ uid: 1, comment: "Шрамы", content: "Шрам на спине от осколка." }), standard({ uid: 2, comment: "Семья", content: "Отец ушёл рано." })]],
    ["Джоли", [standard({ uid: 5, comment: "Шрамы и татуировки", content: "Шрам на спине от осколка.", disable: true }), standard({ uid: 6, comment: "Ёлка", content: "" })]],
]);

test("search: all words in any order, case and ё ignored, identical texts merged", () => {
    assert.deepEqual(searchWords("  Спине  ШРАМ "), ["спине", "шрам"]);
    const hits = searchEntries(lib, "спине шрам");
    assert.equal(hits.length, 1);
    assert.deepEqual(hits[0].holders.map((h) => [h.book, h.uid, h.disable]), [["Джоли", 5, true], ["Фишер", 1, false]]);
    assert.deepEqual(searchEntries(lib, "ушел").map((h) => h.title), ["Семья"]); // ё in the text, е in the query
    assert.deepEqual(searchEntries(lib, "елка").map((h) => h.title), ["Ёлка"]);  // title only, empty text
    assert.deepEqual(searchEntries(lib, "шрам отец"), []);                        // words from two entries do not combine
    assert.deepEqual(searchEntries(lib, "   "), []);
});

test("search: title matches come first", () => {
    const hits = searchEntries(new Map([["A", [
        standard({ uid: 1, comment: "Быт", content: "про семью" }),
        standard({ uid: 2, comment: "Семья", content: "мама" }),
    ]]]), "семь");
    assert.deepEqual(hits.map((h) => h.title), ["Семья", "Быт"]);
});

test("highlightParts marks every word, ё and е alike, and keeps the text whole", () => {
    const parts = highlightParts("Ёлка и елка. Шрам (1)", searchWords("ёлка шрам (1)"));
    assert.deepEqual(parts.filter((p) => p.hit).map((p) => p.text), ["Ёлка", "елка", "Шрам", "(1)"]);
    assert.equal(parts.map((p) => p.text).join(""), "Ёлка и елка. Шрам (1)");
    assert.deepEqual(highlightParts("abc", []), [{ text: "abc", hit: false }]);
});

test("snippetOf shows the text around the first hit", () => {
    const text = "Начало. " + "слово ".repeat(60) + "ШРАМ на спине. " + "хвост ".repeat(60);
    const s = snippetOf(text, ["шрам"], 30);
    assert.match(s, /^…/);
    assert.match(s, /ШРАМ на спине/);
    assert.match(s, /…$/);
    assert.ok(s.length < 140);
    assert.equal(snippetOf("Коротко.", ["нет"]), "Коротко.");
});
