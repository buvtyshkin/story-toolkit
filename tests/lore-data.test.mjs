// Run: node --experimental-detect-module --test tests/   (the flag is not needed on Node 22+)
import { test } from "node:test";
import assert from "node:assert/strict";
import {
    STANDARD, isMemoryEntry, deviations, applyPatch, newEntryFields,
    splitEntries, sortEntries, preview,
    childFolders, folderOf, folderPath, flatFolders, deleteFolder, countBooks,
    GROUP_FIELD, groupEntries, moveGroup,
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

test("sort: enabled first, then lower priority first, ties by title", () => {
    const list = [
        standard({ uid: 0, order: 101, comment: "в" }),
        standard({ uid: 1, order: 99, comment: "б" }),
        standard({ uid: 2, order: 100, comment: "Б" }),
        standard({ uid: 3, order: 100, comment: "а" }),
        standard({ uid: 4, order: 80, comment: "г", disable: true }),
        standard({ uid: 5, order: 120, comment: "д", disable: true }),
    ];
    assert.deepEqual(sortEntries(list).map((e) => e.uid), [1, 3, 2, 0, 4, 5]);
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
    assert.deepEqual(out[2].entries.map((e) => e.uid), [1, 4]);
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
