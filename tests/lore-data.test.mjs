// Run: node --experimental-detect-module --test tests/   (the flag is not needed on Node 22+)
import { test } from "node:test";
import assert from "node:assert/strict";
import {
    STANDARD, isMemoryEntry, deviations, applyPatch, newEntryFields,
    splitEntries, sortEntries, preview,
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

test("prompt order: lower priority first, ties by title", () => {
    const list = [
        standard({ uid: 0, order: 101, comment: "в" }),
        standard({ uid: 1, order: 99, comment: "б" }),
        standard({ uid: 2, order: 100, comment: "Б" }),
        standard({ uid: 3, order: 100, comment: "а" }),
    ];
    assert.deepEqual(sortEntries(list).map((e) => e.uid), [1, 3, 2, 0]);
    assert.deepEqual(sortEntries(list, "title").map((e) => e.uid), [3, 1, 2, 0]);
});

test("preview takes the first non-empty line", () => {
    assert.equal(preview("\n\n  Шрамы: много  \nещё"), "Шрамы: много");
    assert.equal(preview("a".repeat(200), 10).length, 10);
});
