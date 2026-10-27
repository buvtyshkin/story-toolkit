// ============================================================
//  Story Toolkit — Lorebooks module
//
//  Свой редактор лорбуков вместо перегруженного штатного: у записи
//  только вкл/выкл, название, приоритет и текст. Всё остальное
//  (ключи, глубины, проценты) — стандарт пользователя: постоянная,
//  перед персонажем, 100%. Записи не по стандарту помечены ⚠.
//
//  Безопасность (Memory Books и другие расширения пишут в те же
//  файлы): каждое сохранение перечитывает лорбук и вносит только
//  изменённые поля, чужие поля не трогаются. Воспоминания Memory
//  Books показаны отдельным разделом.
//
//  Порядок: лорбуки разложены по папкам (хранятся в настройках
//  расширения), записи — по группам (общий список групп; id группы
//  лежит в самой записи, поле stk_group).
// ============================================================

import { getContext, getPopupClass, toolkitSettings, saveSettings, eventSource, event_types, worldInfo } from "./st.js";
import { addWandMenuItem, escHtml, uid as newId } from "./utils.js";
import {
    STANDARD, isMemoryEntry, deviations, applyPatch, newEntryFields, splitEntries, sortEntries, preview,
    childFolders, folderOf, folderPath, flatFolders, deleteFolder, countBooks,
    GROUP_FIELD, groupEntries, moveGroup, reorderPlan,
    buildIndex, copiesOf, versionsOf, compareBooks, diffText,
} from "./lore-data.js";

const TAG = "[STK Lore]";
const MENU_ITEM_ID = "stk_lore_menu_item";
const OVERLAY_ID = "stk-lore-overlay";
const TYPING_DELAY = 800;

const state = {
    book: null,      // open lorebook name
    data: null,      // our own copy of its data (never the cached object)
    openUid: null,   // entry expanded for editing
    filter: "",
    stale: false,    // an outside save arrived while the user was typing or dragging
    sortMode: false, // "Порядок": drag entries to set priorities
    dragging: false,
    compare: null,   // the other book of a two-book comparison
};

// uid -> { patch, timer } — text typed but not saved yet
const pending = new Map();
let saveChain = Promise.resolve();
let ownSave = false;

const LORE_DEFAULTS = {
    lastBook: null,
    memoriesOpen: true,
    folders: {},          // id -> { name, parent }
    bookFolder: {},       // book name -> folder id
    foldersCollapsed: {}, // folder id ("" = no folder) -> true
    groups: [],           // [{ id, name }], in display order
    groupsCollapsed: {},  // group id ("" = no group) -> true
};

function settings() {
    const t = toolkitSettings();
    if (!t.lore) t.lore = {};
    for (const [k, v] of Object.entries(LORE_DEFAULTS)) {
        if (t.lore[k] === undefined) t.lore[k] = structuredClone(v);
    }
    return t.lore;
}

/** Ask for a name with SillyTavern's popup; null if cancelled or empty. */
async function askName(title, value = "") {
    const popup = getPopupClass();
    const answer = popup ? await popup.Popup.show.input(title, "", value) : window.prompt(title, value);
    const name = typeof answer === "string" ? answer.trim() : "";
    return name || null;
}

async function askConfirm(title, html) {
    const popup = getPopupClass();
    return popup ? !!(await popup.Popup.show.confirm(title, html)) : window.confirm(title);
}

/** escHtml leaves quotes alone, which breaks attribute values. */
function escAttr(s) {
    return escHtml(s).replace(/"/g, "&quot;");
}

function isPhone() {
    return window.matchMedia("(max-width: 768px)").matches;
}

function modal() {
    return document.querySelector(`#${OVERLAY_ID} .stk-lore-modal`);
}

// ── Data layer ──

/** Mirror a field into the card-embedded copy, the way SillyTavern's own editor does. */
function mirror(data, uid, field, value) {
    if (!data.originalData) return;
    if (field === "disable") worldInfo.setWIOriginalDataValue(data, uid, "enabled", !value);
    else if (worldInfo.originalWIDataKeyMap[field]) {
        worldInfo.setWIOriginalDataValue(data, uid, worldInfo.originalWIDataKeyMap[field], value);
    }
}

/**
 * Save straight away, like Memory Books does. SillyTavern's saveWorldInfo(…, true)
 * cancels the single shared debounce timer, which could drop a pending save of
 * some other lorebook.
 */
async function writeBook(name, data) {
    const ctx = getContext();
    const response = await fetch("/api/worldinfo/edit", {
        method: "POST",
        headers: ctx.getRequestHeaders(),
        body: JSON.stringify({ name, data }),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    worldInfo.worldInfoCache.set(name, data);
    ownSave = true;
    try {
        await eventSource.emit(event_types.WORLDINFO_UPDATED, name, data);
    } finally {
        ownSave = false;
    }
    worldInfo.reloadEditor(name);
}

/**
 * Run `change(data)` on a fresh copy of the book and save it. Saves are queued,
 * so two quick edits never read the same old copy.
 */
function mutateBook(name, change) {
    const run = saveChain.then(async () => {
        setStatus("Сохраняю…");
        const data = await getContext().loadWorldInfo(name);
        if (!data?.entries) throw new Error("лорбук не найден");
        const result = change(data);
        if (result === false) {
            // Nothing to save; still take the fresh copy, it shows what happened.
            if (state.book === name) state.data = data;
            setStatus("");
            return false;
        }
        await writeBook(name, data);
        // The cache now holds `data` uncloned; keep our own copy.
        if (state.book === name) state.data = structuredClone(data);
        setStatus("Сохранено ✓");
        return result;
    });
    saveChain = run.catch(() => {});
    return run.catch((e) => {
        console.error(`${TAG} save failed:`, e);
        setStatus("Ошибка сохранения");
        toastr.error("Не удалось сохранить лорбук: " + (e?.message || e), "Лорбуки");
        return false;
    });
}

async function savePatch(uid, patch) {
    const name = state.book;
    const ok = await mutateBook(name, (data) => applyPatch(data, uid, patch, mirror));
    if (ok === false && state.book === name && !state.data?.entries?.[uid]) {
        toastr.warning("Эта запись удалена в другом месте — изменения не сохранены.", "Лорбуки");
        renderEntries();
    }
}

function queueTyping(uid, field, value) {
    const p = pending.get(uid) || { patch: {}, timer: null };
    p.patch[field] = value;
    clearTimeout(p.timer);
    p.timer = setTimeout(() => flushEntry(uid), TYPING_DELAY);
    pending.set(uid, p);
    setStatus("…");
}

function flushEntry(uid) {
    const p = pending.get(uid);
    if (!p) return Promise.resolve();
    clearTimeout(p.timer);
    pending.delete(uid);
    return savePatch(uid, p.patch);
}

async function flushAll() {
    await Promise.all([...pending.keys()].map(flushEntry));
    await saveChain;
}

// ── All books, for duplicates ──
//
// A light copy of every lorebook's entries, read when the window opens and
// kept current by WORLDINFO_UPDATED. Only read from, never saved.

const library = {
    books: new Map(), // name -> [{ uid, comment, content, order, disable, stmemorybooks }]
    index: null,      // buildIndex(books), rebuilt lazily
    ready: false,
    loading: null,    // the running loadLibrary() promise
};

function libraryPut(name, data) {
    library.books.set(name, Object.values(data?.entries || {}).map((e) => ({
        uid: e.uid, comment: e.comment, content: e.content, order: e.order, disable: e.disable, stmemorybooks: e.stmemorybooks,
    })));
    library.index = null;
}

function libIndex() {
    if (!library.index) library.index = buildIndex(library.books);
    return library.index;
}

function loadLibrary() {
    if (library.loading) return library.loading;
    library.loading = (async () => {
        const names = bookNames();
        for (const n of [...library.books.keys()]) if (!names.includes(n)) library.books.delete(n);
        library.index = null;
        let done = 0;
        const queue = [...names];
        const worker = async () => {
            while (queue.length) {
                const name = queue.shift();
                try {
                    const data = await getContext().loadWorldInfo(name); // from cache when it can
                    if (data?.entries) libraryPut(name, data);
                } catch (e) {
                    console.warn(`${TAG} could not read "${name}" for duplicates:`, e);
                }
                if (!library.ready) setStatus(`Ищу дубли: ${++done}/${names.length}`);
            }
        };
        await Promise.all([worker(), worker(), worker(), worker()]);
        const first = !library.ready;
        library.ready = true;
        if (first) setStatus("");
        refreshEntries();
    })().finally(() => { library.loading = null; });
    return library.loading;
}

/** Re-render the entries now, or once the user stops typing or dragging. */
function refreshEntries() {
    if (!modal()) return;
    const typing = document.activeElement?.closest?.(`#${OVERLAY_ID} .stk-lore-edit`);
    if (typing || pending.size || state.dragging) state.stale = true;
    else renderEntries();
}

// ── Actions ──

/** Open a book; `uid` expands that entry (coming from a duplicate in another book). */
async function openBook(name, uid = null) {
    await flushAll();
    const data = await getContext().loadWorldInfo(name);
    if (!data?.entries) {
        toastr.error(`Лорбук «${name}» не загрузился.`, "Лорбуки");
        return;
    }
    state.book = name;
    state.data = data; // loadWorldInfo hands out a clone already
    state.openUid = uid !== null && data.entries[uid] ? String(uid) : null;
    state.stale = false;
    state.sortMode = false;
    state.compare = null;
    const s = settings();
    s.lastBook = name;
    const target = state.openUid !== null ? data.entries[state.openUid] : null;
    if (target && isMemoryEntry(target)) s.memoriesOpen = true;
    else if (target) delete s.groupsCollapsed[s.groups.some((g) => g.id === target[GROUP_FIELD]) ? target[GROUP_FIELD] : ""];
    saveSettings();
    render();
    if (state.openUid !== null) {
        modal()?.querySelector(`.stk-lore-entry[data-uid="${state.openUid}"]`)?.scrollIntoView({ block: "start" });
    }
}

async function addEntry() {
    const uid = await mutateBook(state.book, (data) => {
        const entry = worldInfo.createWorldInfoEntry(state.book, data);
        if (!entry) throw new Error("не удалось создать запись");
        Object.assign(entry, newEntryFields("Новая запись", ""));
        return entry.uid;
    });
    if (uid === false) return;
    state.openUid = uid;
    renderEntries();
    const title = modal()?.querySelector(`.stk-lore-entry[data-uid="${uid}"] .stk-lore-title-input`);
    title?.focus();
    title?.select();
}

async function deleteEntry(uid) {
    const entry = state.data.entries[uid];
    const label = entry?.comment || preview(entry?.content) || `#${uid}`;
    const memory = isMemoryEntry(entry)
        ? " Это воспоминание Memory Books."
        : "";
    const yes = await askConfirm("Удалить запись?",
        `«${escHtml(label)}» будет удалена из лорбука «${escHtml(state.book)}». Это необратимо.${memory}`);
    if (!yes) return;
    clearTimeout(pending.get(uid)?.timer);
    pending.delete(uid);
    const ok = await mutateBook(state.book, (data) => {
        if (!data.entries[uid]) return false;
        delete data.entries[uid];
        worldInfo.deleteWIOriginalDataValue?.(data, uid);
        return true;
    });
    if (ok !== false) {
        state.openUid = null;
        renderEntries();
    }
}

/** Re-render the entries, keep the open one in view (it may have moved to another group). */
async function rerenderKeepOpen() {
    await flushAll();
    renderEntries();
    if (state.openUid !== null) {
        modal()?.querySelector(`.stk-lore-entry[data-uid="${state.openUid}"]`)?.scrollIntoView({ block: "nearest" });
    }
}

async function setEntryGroup(uid, select) {
    let id = select.value;
    if (id === "__new") {
        const name = await askName("Новая группа");
        if (!name) {
            const e = state.data.entries[uid];
            select.value = settings().groups.some((g) => g.id === e?.[GROUP_FIELD]) ? e[GROUP_FIELD] : "";
            return;
        }
        id = newId();
        settings().groups.push({ id, name });
        saveSettings();
    }
    // No group = no field at all (undefined is dropped when the book is saved).
    await savePatch(uid, { [GROUP_FIELD]: id || undefined });
    await rerenderKeepOpen();
}

function groupsPanel() {
    closeMenu();
    const s = settings();
    const panel = document.createElement("div");
    panel.className = "stk-lore-menu stk-lore-groups-panel";
    const draw = () => {
        panel.innerHTML = `
            <div class="stk-lore-menu-header">Группы записей — общие для всех лорбуков</div>
            ${s.groups.length ? s.groups.map((g, i) => `
                <div class="stk-lore-grow" data-gid="${escAttr(g.id)}">
                    <span class="stk-lore-grow-name">${escHtml(g.name)}</span>
                    <button class="menu_button sf-card-btn" data-gact="up" title="Выше" ${i ? "" : "disabled"}>↑</button>
                    <button class="menu_button sf-card-btn" data-gact="down" title="Ниже" ${i < s.groups.length - 1 ? "" : "disabled"}>↓</button>
                    <button class="menu_button sf-card-btn" data-gact="rename" title="Переименовать">✎</button>
                    <button class="menu_button sf-card-btn" data-gact="delete" title="Удалить">🗑</button>
                </div>`).join("") : `<p class="stk-note">Групп пока нет.</p>`}
            <div class="stk-lore-gfoot">
                <button class="menu_button" data-gact="add">＋ Группа</button>
                <button class="menu_button" data-gact="done">Готово</button>
            </div>`;
    };
    draw();
    panel.addEventListener("click", async (e) => {
        e.stopPropagation();
        const act = e.target.closest("[data-gact]")?.dataset.gact;
        if (!act) return;
        const g = s.groups.find((x) => x.id === e.target.closest("[data-gid]")?.dataset.gid);
        if (act === "done") return panel.remove();
        if (act === "add") {
            const name = await askName("Новая группа");
            if (name) s.groups.push({ id: newId(), name });
        } else if ((act === "up" || act === "down") && g) {
            moveGroup(s.groups, g.id, act === "up" ? -1 : 1);
        } else if (act === "rename" && g) {
            const name = await askName("Переименовать группу", g.name);
            if (name) g.name = name;
        } else if (act === "delete" && g) {
            const ok = await askConfirm("Удалить группу?",
                `Группа «${escHtml(g.name)}» исчезнет из списка. Записи не удаляются — они окажутся в «Без группы».`);
            if (ok) s.groups.splice(s.groups.indexOf(g), 1);
        }
        saveSettings();
        draw();
        await rerenderKeepOpen();
    });
    modal().appendChild(panel);
}

/** Turn a regular entry into a Memory Books memory or back; only the flag changes. */
async function setMemory(uid, memory) {
    if (memory) settings().memoriesOpen = true;
    // Memory Books recognises a memory by `stmemorybooks === true` alone.
    await savePatch(uid, { stmemorybooks: memory ? true : undefined });
    await rerenderKeepOpen();
    toastr.success(memory ? "Запись перенесена в воспоминания Memory Books." : "Воспоминание стало обычной записью.", "Лорбуки");
}

// ── "Порядок": priorities by dragging ──

/** What the sort mode shows: every enabled entry, memories too, in prompt order. */
function sortList() {
    return sortEntries(Object.values(state.data?.entries || {}).filter((e) => !e.disable));
}

function plural(n, one, few, many) {
    const m10 = n % 10, m100 = n % 100;
    if (m10 === 1 && m100 !== 11) return one;
    if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
    return many;
}

async function reorder(from, to) {
    const list = sortList();
    const moved = list[from];
    const plan = reorderPlan(list, from, to);
    if (!moved || !plan.length) return renderEntries();
    const ok = await mutateBook(state.book, (data) => {
        for (const c of plan) applyPatch(data, c.uid, { order: c.to }, mirror);
        return true;
    });
    renderEntries();
    if (ok === false) return;
    const own = plan.find((c) => c.uid === moved.uid);
    const others = plan.length - (own ? 1 : 0);
    toastr.info(
        (own ? `«${moved.comment || "без названия"}»: ${own.from} → ${own.to}` : "Порядок обновлён") +
        (others ? `. Ещё ${others} ${plural(others, "запись сдвинута", "записи сдвинуты", "записей сдвинуто")} ниже.` : ""),
        "Лорбуки", { timeOut: 4000 });
}

/** Drag a row by its ☰ handle (mouse and touch alike). */
function startDrag(handle, e) {
    const row = handle.closest(".stk-lore-sortrow");
    const listEl = row?.parentElement;
    if (!listEl) return;
    const rows = [...listEl.querySelectorAll(".stk-lore-sortrow")];
    const from = rows.indexOf(row);
    const others = rows.filter((r) => r !== row);
    const scroller = isPhone() ? document.getElementById(OVERLAY_ID) : modal().querySelector(".stk-lore-entries");
    const startY = e.clientY;
    const startScroll = scroller.scrollTop;
    let lastY = e.clientY;
    let to = from;
    let raf = 0;

    state.dragging = true;
    try {
        handle.setPointerCapture(e.pointerId); // keep getting moves outside the handle
    } catch { /* an unknown pointer: moves over the handle still work */ }
    row.classList.add("dragging");
    modal().classList.add("stk-lore-sorting");

    const update = () => {
        row.style.transform = `translateY(${lastY - startY + scroller.scrollTop - startScroll}px)`;
        to = others.filter((r) => {
            const b = r.getBoundingClientRect();
            return b.top + b.height / 2 < lastY;
        }).length;
        others.forEach((r, i) => r.classList.toggle("drop-before", i === to && to !== from));
        listEl.classList.toggle("drop-end", to === others.length && to !== from);
    };
    // Near the top or bottom edge the list scrolls by itself.
    const autoScroll = () => {
        const box = scroller.getBoundingClientRect();
        const top = Math.max(box.top, 0) + (isPhone() ? 90 : 40);
        const bottom = Math.min(box.bottom, window.innerHeight) - 40;
        if (lastY < top) scroller.scrollTop -= 14;
        else if (lastY > bottom) scroller.scrollTop += 14;
        update();
        raf = requestAnimationFrame(autoScroll);
    };
    const move = (ev) => {
        lastY = ev.clientY;
        update();
    };
    const end = (ev) => {
        cancelAnimationFrame(raf);
        handle.removeEventListener("pointermove", move);
        handle.removeEventListener("pointerup", end);
        handle.removeEventListener("pointercancel", end);
        state.dragging = false;
        modal()?.classList.remove("stk-lore-sorting");
        if (ev.type === "pointerup" && to !== from) reorder(from, to);
        else renderEntries();
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", end);
    handle.addEventListener("pointercancel", end);
    raf = requestAnimationFrame(autoScroll);
}

function sortModeHtml() {
    const groups = new Map(settings().groups.map((g) => [g.id, g.name]));
    const list = sortList();
    return `
        <p class="stk-note">Перетащите запись за ☰ (или стрелками) — приоритет пересчитается сам. Порядок — как в промпте, воспоминания тоже здесь.
            Выключенные записи в промпт не идут и здесь не показаны.</p>
        <div class="stk-lore-list stk-lore-sortlist">${list.map((e, i) => {
            const memory = isMemoryEntry(e);
            const sub = memory ? "воспоминание" : (groups.get(e[GROUP_FIELD]) || "");
            return `
            <div class="stk-lore-entry stk-lore-sortrow" data-uid="${e.uid}" data-idx="${i}">
                <span class="stk-lore-handle" title="Перетащить">☰</span>
                <div class="stk-lore-main">
                    <div class="stk-lore-title">${memory ? "🧠 " : ""}${escHtml(e.comment || "без названия")}</div>
                    ${sub ? `<div class="stk-lore-preview">${escHtml(sub)}</div>` : ""}
                </div>
                <span class="stk-lore-prio" title="Приоритет">${e.order ?? 100}</span>
                <button class="menu_button sf-card-btn" data-act="move-up" title="Выше" ${i ? "" : "disabled"}>↑</button>
                <button class="menu_button sf-card-btn" data-act="move-down" title="Ниже" ${i < list.length - 1 ? "" : "disabled"}>↓</button>
            </div>`;
        }).join("") || `<p class="stk-note">Включённых записей нет.</p>`}</div>`;
}

async function makeStandard(uid) {
    await savePatch(uid, { ...STANDARD });
    renderEntries();
}

// ── Duplicates: the same entry in other books, other versions, two-book comparison ──

/** Other books with the same text; other texts under the same title. Empty until all books are read. */
function dupInfo(e) {
    if (!library.ready || !state.book || !e) return { copies: [], versions: [] };
    const idx = libIndex();
    return { copies: copiesOf(idx, state.book, e.content), versions: versionsOf(idx, e.comment, e.content) };
}

const inBooks = (n) => `${n} ${plural(n, "лорбуке", "лорбуках", "лорбуках")}`;
const booksCount = (n) => `${n} ${plural(n, "лорбук", "лорбука", "лорбуков")}`;
const TIP_LINES = 14;

function copiesMenu(anchor, uid) {
    const { copies } = dupInfo(state.data.entries[uid]);
    if (!copies.length) return;
    openMenu(anchor, [
        { header: `Точно такая же запись есть ещё в ${inBooks(copies.length)} — открыть:` },
        ...copies.map((c) => ({ label: c.book, run: () => openBook(c.book, c.uid) })),
    ]);
}

/** Hover hint over a ⧉ / ≠ mark (desktop; a tap opens the menu or the panel instead). */
function showTip(mark) {
    hideTip();
    const e = state.data?.entries?.[entryUid(mark)];
    const { copies, versions } = dupInfo(e);
    const lines = mark.dataset.tip === "copies"
        ? copies.map((c) => c.book)
        : versions.map((v, i) => `Версия ${i + 1}: ${v.holders.map((h) => h.book).join(", ")}`);
    if (!lines.length) return;
    const more = lines.length - TIP_LINES;
    const tip = document.createElement("div");
    tip.className = "stk-lore-tip";
    tip.innerHTML = `
        <b>${mark.dataset.tip === "copies" ? `Точно такая же запись есть ещё в ${inBooks(copies.length)}:` : "То же название, другой текст:"}</b>
        ${lines.slice(0, TIP_LINES).map((l) => `<div>• ${escHtml(l)}</div>`).join("")}
        ${more > 0 ? `<div>…и ещё ${more}</div>` : ""}
        <small>${mark.dataset.tip === "copies" ? "Нажмите, чтобы открыть" : "Нажмите, чтобы сравнить"}</small>`;
    const m = modal();
    m.appendChild(tip);
    const a = mark.getBoundingClientRect();
    const box = m.getBoundingClientRect();
    const left = Math.min(a.left - box.left, box.width - tip.offsetWidth - 8);
    const below = a.bottom - box.top + 4;
    const top = below + tip.offsetHeight > box.height - 8 ? a.top - box.top - tip.offsetHeight - 4 : below;
    tip.style.left = `${Math.max(8, left)}px`;
    tip.style.top = `${Math.max(8, top)}px`;
}

function hideTip() {
    modal()?.querySelectorAll(".stk-lore-tip").forEach((t) => t.remove());
}

const DIFF_KEEP = 160; // unchanged text kept around a change; the rest folds away

/** A diff of two texts with a legend; long unchanged stretches fold, "весь текст" shows them. */
function diffHtml(a, b, hereLabel, thereLabel) {
    const ops = diffText(a || "", b || "");
    const changes = ops.filter((o) => o.op !== "=");
    const spacesOnly = changes.length && changes.every((o) => !o.text.trim());
    let folded = false;
    const body = ops.map((o, i) => {
        if (o.op !== "=") {
            // A change of spaces or line breaks alone would be invisible: show them.
            const t = o.text.trim() ? o.text : o.text.replace(/ /g, "·").replace(/\t/g, "→").replace(/\n/g, "↵\n");
            return o.op === "-" ? `<del>${escHtml(t)}</del>` : `<ins>${escHtml(t)}</ins>`;
        }
        const head = i === 0 ? 0 : DIFF_KEEP;
        const tail = i === ops.length - 1 ? 0 : DIFF_KEEP;
        if (o.text.length <= head + tail + 80) return escHtml(o.text);
        folded = true;
        const mid = o.text.slice(head, o.text.length - tail);
        return `${escHtml(o.text.slice(0, head))}<span class="stk-lore-cut">${escHtml(mid)}</span>` +
            `<span class="stk-lore-gap">⋯ ${mid.length} симв. без изменений ⋯</span>${escHtml(o.text.slice(o.text.length - tail))}`;
    }).join("");
    return `
        <div class="stk-lore-diffbox">
            <div class="stk-lore-legend">
                <del>красным</del> — только ${escHtml(hereLabel)}, <ins>зелёным</ins> — только ${escHtml(thereLabel)}.
                ${spacesOnly ? "<b>Отличаются только пробелами и переносами строк.</b>" : ""}
                ${folded ? `<button class="stk-lore-linkbtn" data-diff-full>показать весь текст</button>` : ""}
            </div>
            <div class="stk-lore-diff">${body}</div>
        </div>`;
}

function toggleDiffFull(btn) {
    const box = btn.closest(".stk-lore-diffbox");
    box.classList.toggle("full");
    btn.textContent = box.classList.contains("full") ? "свернуть неизменённое" : "показать весь текст";
}

/** Other versions of an entry's text, compared to this one. */
function versionsPanel(uid) {
    closeMenu();
    hideTip();
    const e = state.data.entries[uid];
    const { versions } = dupInfo(e);
    if (!versions.length) return;
    let pick = 0;
    const panel = document.createElement("div");
    panel.className = "stk-lore-menu stk-lore-panel";
    const draw = () => {
        const v = versions[pick];
        panel.innerHTML = `
            <div class="stk-lore-panel-head">
                <b>«${escHtml(e.comment)}» — другие версии текста</b>
                <button class="menu_button sf-card-btn" data-pact="close" title="Закрыть">✖</button>
            </div>
            ${versions.length > 1 ? `<div class="stk-lore-chips">${versions.map((x, i) => `
                <button class="stk-lore-chip${i === pick ? " active" : ""}" data-pact="pick" data-i="${i}">Версия ${i + 1} · ${booksCount(x.holders.length)}</button>`).join("")}</div>` : ""}
            <div class="stk-lore-where">Эта версия лежит в: ${v.holders.map((h) =>
                `<button class="stk-lore-linkbtn" data-open-book="${escAttr(h.book)}" data-uid="${h.uid}">${escHtml(h.book)}</button>`).join(", ")}</div>
            ${diffHtml(e.content, v.content, "в этом лорбуке", "в этой версии")}`;
    };
    draw();
    panel.addEventListener("click", (ev) => {
        ev.stopPropagation();
        const full = ev.target.closest("[data-diff-full]");
        if (full) return toggleDiffFull(full);
        const jump = ev.target.closest("[data-open-book]");
        if (jump) {
            panel.remove();
            return openBook(jump.dataset.openBook, jump.dataset.uid);
        }
        const act = ev.target.closest("[data-pact]");
        if (act?.dataset.pact === "close") return panel.remove();
        if (act?.dataset.pact === "pick") {
            pick = Number(act.dataset.i);
            draw();
        }
    });
    modal().appendChild(panel);
}

async function compareMenu(anchor) {
    if (!library.ready) {
        setStatus("Читаю лорбуки…");
        await loadLibrary();
    }
    // Books sharing the most identical entries with this one go first
    // (counted the way the comparison pairs them).
    const mine = Object.values(state.data.entries);
    const names = bookNames().filter((n) => n !== state.book);
    const shared = new Map(names.map((n) => [n, compareBooks(mine, library.books.get(n) || []).same.length]));
    names.sort((a, b) => (shared.get(b) || 0) - (shared.get(a) || 0) || a.localeCompare(b, "ru", { sensitivity: "base" }));
    openMenu(anchor, [
        { header: "Сравнить с… (сверху — самые похожие)" },
        ...names.map((n) => ({ label: n + (shared.get(n) ? ` — общих: ${shared.get(n)}` : ""), run: () => startCompare(n) })),
    ]);
}

async function startCompare(other) {
    await flushAll();
    state.compare = other;
    state.sortMode = false;
    state.openUid = null;
    renderEntries();
    modal()?.querySelector(".stk-lore-entries")?.scrollTo(0, 0);
}

let cmp = null; // the comparison on screen, for filling rows when they open

function compareHtml() {
    const other = state.compare;
    cmp = compareBooks(Object.values(state.data.entries), library.books.get(other) || []);
    const { same, changed, onlyA, onlyB } = cmp;
    const tuned = (p) => (p.a.order ?? 100) !== (p.b.order ?? 100) || !!p.a.disable !== !!p.b.disable;
    const nTuned = same.filter(tuned).length;
    const name = (e) => `${isMemoryEntry(e) ? "🧠 " : ""}${e.comment ? escHtml(e.comment) : "<i>без названия</i>"}`;
    const one = (e) => `<span class="stk-lore-prio" title="Приоритет">${e.order ?? 100}</span>${e.disable ? `<span class="stk-lore-offtag">выкл.</span>` : ""}`;
    const pair = (p) => {
        const oa = p.a.order ?? 100;
        const ob = p.b.order ?? 100;
        const prio = oa === ob
            ? `<span class="stk-lore-prio" title="Приоритет">${oa}</span>`
            : `<span class="stk-lore-prio differs" title="Приоритет: здесь / в «${escAttr(other)}»">${oa} / ${ob}</span>`;
        const off = !!p.a.disable === !!p.b.disable
            ? (p.a.disable ? `<span class="stk-lore-offtag">выкл.</span>` : "")
            : `<span class="stk-lore-offtag differs">${p.a.disable ? "выкл. здесь" : "выкл. там"}</span>`;
        return prio + off;
    };
    const row = (key, e, meta) => `
        <details class="stk-lore-cmprow" data-cmp="${key}">
            <summary><span class="stk-lore-main"><span class="stk-lore-title">${name(e)}</span>
                <span class="stk-lore-preview">${escHtml(preview(e.content))}</span></span>${meta}</summary>
            <div class="stk-lore-cmpbody"></div>
        </details>`;
    const section = (title, items, open) => items.length ? `
        <details class="stk-lore-cmpsec" ${open ? "open" : ""}>
            <summary>${title} · ${items.length}</summary>
            <div class="stk-lore-list">${items.join("")}</div>
        </details>` : "";
    const B = `«${escHtml(other)}»`;
    return `
        <div class="stk-lore-cmphead">
            <b>⇄ Сравнение с ${B}</b>
            <button class="menu_button sf-card-btn" data-act="compare-close">✖ Закрыть сравнение</button>
        </div>
        <p class="stk-lore-stats">Одинаковый текст: ${same.length}${nTuned ? ` (у ${nTuned} другой приоритет или вкл./выкл.)` : ""}
            · Разный текст: ${changed.length} · Только здесь: ${onlyA.length} · Только в ${B}: ${onlyB.length}</p>
        ${!changed.length && !onlyA.length && !onlyB.length && !nTuned ? `<p class="stk-note">Лорбуки совпадают полностью.</p>` : ""}
        ${section("Одно название — разный текст", changed.map((p, i) => row(`c${i}`, p.a, pair(p))), true)}
        ${section("Только здесь", onlyA.map((e, i) => row(`a${i}`, e, one(e))), true)}
        ${section(`Только в ${B}`, onlyB.map((e, i) => row(`b${i}`, e, one(e))), true)}
        ${section("Одинаковый текст", sortEntries(same.map((p) => p.a)).map((a) => {
            const i = same.findIndex((p) => p.a === a);
            return row(`s${i}`, a, pair(same[i]));
        }), false)}`;
}

/** A comparison row opened: show its text, or the diff for "разный текст". */
function fillCmpRow(row) {
    const body = row.querySelector(".stk-lore-cmpbody");
    if (!cmp || body.dataset.filled) return;
    body.dataset.filled = "1";
    const kind = row.dataset.cmp[0];
    const i = Number(row.dataset.cmp.slice(1));
    const open = (book, e) => `<button class="stk-lore-linkbtn" data-open-book="${escAttr(book)}" data-uid="${e.uid}">открыть в «${escHtml(book)}»</button>`;
    const text = (e) => `<div class="stk-lore-cmptext">${escHtml(e.content || "")}</div>`;
    if (kind === "c") {
        const { a, b } = cmp.changed[i];
        const sameTitle = (a.comment || "") === (b.comment || "");
        body.innerHTML = (sameTitle ? "" : `<div class="stk-lore-where">Там называется «${escHtml(b.comment)}».</div>`) +
            diffHtml(a.content, b.content, "здесь", `в «${state.compare}»`) +
            `<div class="stk-lore-where">${open(state.book, a)} · ${open(state.compare, b)}</div>`;
    } else if (kind === "a") {
        body.innerHTML = text(cmp.onlyA[i]) + `<div class="stk-lore-where">${open(state.book, cmp.onlyA[i])}</div>`;
    } else if (kind === "b") {
        body.innerHTML = text(cmp.onlyB[i]) + `<div class="stk-lore-where">${open(state.compare, cmp.onlyB[i])}</div>`;
    } else {
        const { a, b } = cmp.same[i];
        body.innerHTML = text(a) + `<div class="stk-lore-where">${open(state.book, a)} · ${open(state.compare, b)}</div>`;
    }
}

// ── UI ──

function setStatus(text) {
    const el = modal()?.querySelector(".stk-lore-status");
    if (el) el.textContent = text;
}

function bookNames() {
    const names = getContext().getWorldInfoNames?.() || worldInfo.world_names || [];
    return [...names].sort((a, b) => a.localeCompare(b, "ru", { sensitivity: "base" }));
}

function bookRowHtml(name, showPath = false) {
    const s = settings();
    const path = showPath ? folderPath(s.folders, folderOf(s.folders, s.bookFolder, name)) : [];
    return `
        <div class="stk-lore-bookrow" draggable="true" data-drag-book="${escAttr(name)}">
            <button class="stk-lore-book${name === state.book ? " active" : ""}" data-book="${escAttr(name)}">${escHtml(name)}${
                path.length ? `<small class="stk-lore-path">${escHtml(path.join(" › "))}</small>` : ""}</button>
            <button class="stk-lore-more" data-menu="book" data-id="${escAttr(name)}" title="В папку…">⋯</button>
        </div>`;
}

/** A folder with its subfolders and books; id "" is the "no folder" bucket. */
function folderHtml(id, name, books, inner) {
    const s = settings();
    const collapsed = !!s.foldersCollapsed[id];
    return `
        <div class="stk-lore-folder">
            <div class="stk-lore-folder-head" data-drop-folder="${escAttr(id)}">
                <button class="stk-lore-folder-toggle" data-act="toggle-folder" data-id="${escAttr(id)}">
                    <span class="stk-lore-caret">${collapsed ? "▸" : "▾"}</span>
                    <span class="stk-lore-folder-name">${id ? "📁" : "📄"} ${escHtml(name)}</span>
                    <span class="stk-lore-count">${books}</span>
                </button>
                ${id ? `<button class="stk-lore-more" data-menu="folder" data-id="${escAttr(id)}" title="Папка">⋯</button>` : ""}
            </div>
            ${collapsed ? "" : `<div class="stk-lore-folder-body">${inner}</div>`}
        </div>`;
}

function renderBooks() {
    const list = modal()?.querySelector(".stk-lore-books-list");
    if (!list) return;
    const s = settings();
    const names = bookNames();
    const f = state.filter.trim().toLowerCase();

    // Searching: a flat list of matches, each with the folder it lives in.
    if (f) {
        const hits = names.filter((n) => n.toLowerCase().includes(f));
        list.innerHTML = hits.length ? hits.map((n) => bookRowHtml(n, true)).join("") : `<p class="stk-note">Ничего не найдено</p>`;
        return;
    }
    // No folders yet: the plain list.
    if (!Object.keys(s.folders).length) {
        list.innerHTML = names.map((n) => bookRowHtml(n)).join("");
        return;
    }
    const booksIn = (id) => names.filter((n) => folderOf(s.folders, s.bookFolder, n) === id);
    const tree = (parent) => childFolders(s.folders, parent).map((fd) =>
        folderHtml(fd.id, fd.name, countBooks(s.folders, s.bookFolder, names, fd.id),
            tree(fd.id) + booksIn(fd.id).map((n) => bookRowHtml(n)).join(""))).join("");
    const loose = booksIn(null);
    list.innerHTML = tree(null) +
        (loose.length ? folderHtml("", "Без папки", loose.length, loose.map((n) => bookRowHtml(n)).join("")) : "");
}

// ── Menus (folder / book actions) ──

function closeMenu() {
    modal()?.querySelector(".stk-lore-menu")?.remove();
}

/**
 * A small menu next to `anchor` (a bottom sheet on phones).
 * items: [{ label, run, current, depth, header }]
 */
function openMenu(anchor, items, extraClass = "") {
    closeMenu();
    const m = modal();
    const menu = document.createElement("div");
    menu.className = `stk-lore-menu ${extraClass}`;
    items.forEach((it, i) => {
        if (it.header) {
            menu.insertAdjacentHTML("beforeend", `<div class="stk-lore-menu-header">${escHtml(it.header)}</div>`);
            return;
        }
        const b = document.createElement("button");
        b.className = "stk-lore-menu-item" + (it.current ? " current" : "") + (it.danger ? " danger" : "");
        b.style.paddingLeft = `${12 + (it.depth || 0) * 16}px`;
        b.textContent = (it.current ? "✓ " : "") + it.label;
        b.dataset.menuItem = i;
        menu.appendChild(b);
    });
    menu.addEventListener("click", async (e) => {
        e.stopPropagation();
        const item = items[e.target.closest("[data-menu-item]")?.dataset.menuItem];
        if (!item?.run) return;
        closeMenu();
        await item.run();
    });
    m.appendChild(menu);
    if (!isPhone() && anchor) {
        const a = anchor.getBoundingClientRect();
        const box = m.getBoundingClientRect();
        const left = Math.min(a.left - box.left, box.width - menu.offsetWidth - 8);
        const top = Math.min(a.bottom - box.top + 2, box.height - menu.offsetHeight - 8);
        menu.style.left = `${Math.max(8, left)}px`;
        menu.style.top = `${Math.max(8, top)}px`;
    }
}

function saveAndRenderBooks() {
    saveSettings();
    renderBooks();
}

async function newFolder(parent = null) {
    const name = await askName(parent ? "Новая подпапка" : "Новая папка");
    if (!name) return;
    settings().folders[newId()] = { name, parent };
    if (parent) delete settings().foldersCollapsed[parent];
    saveAndRenderBooks();
}

function folderMenu(anchor, id) {
    const s = settings();
    const folder = s.folders[id];
    if (!folder) return;
    openMenu(anchor, [
        { header: folder.name },
        { label: "＋ Подпапка", run: () => newFolder(id) },
        { label: "✎ Переименовать", run: async () => {
            const name = await askName("Переименовать папку", folder.name);
            if (name) { folder.name = name; saveAndRenderBooks(); }
        } },
        { label: "🗑 Удалить папку", danger: true, run: async () => {
            const ok = await askConfirm("Удалить папку?",
                `Папка «${escHtml(folder.name)}» исчезнет. Лорбуки и подпапки из неё переедут на уровень выше — сами лорбуки не удаляются.`);
            if (ok) { deleteFolder(s.folders, s.bookFolder, id); saveAndRenderBooks(); }
        } },
    ]);
}

function moveBook(book, folderId) {
    const s = settings();
    if (folderId) s.bookFolder[book] = folderId;
    else delete s.bookFolder[book];
    saveAndRenderBooks();
}

function bookMenu(anchor, book) {
    const s = settings();
    const folders = flatFolders(s.folders);
    if (!folders.length) {
        toastr.info("Сначала создайте папку кнопкой «＋ Папка».", "Лорбуки");
        return;
    }
    const current = folderOf(s.folders, s.bookFolder, book);
    openMenu(anchor, [
        { header: `«${book}» — в папку:` },
        ...folders.map((f) => ({ label: f.name, depth: f.depth, current: f.id === current, run: () => moveBook(book, f.id) })),
        { label: "Без папки", current: !current, run: () => moveBook(book, null) },
    ]);
}

function groupSelectHtml(e) {
    const groups = settings().groups;
    const current = groups.some((g) => g.id === e[GROUP_FIELD]) ? e[GROUP_FIELD] : "";
    return `
        <label class="stk-lore-field stk-lore-field-group"><span>Группа</span>
            <select class="text_pole stk-lore-group-select">
                <option value="" ${current ? "" : "selected"}>— без группы —</option>
                ${groups.map((g) => `<option value="${escAttr(g.id)}" ${g.id === current ? "selected" : ""}>${escHtml(g.name)}</option>`).join("")}
                <option value="__new">＋ новая группа…</option>
            </select></label>`;
}

/** Memories are edited like any entry; their settings belong to Memory Books, so no ⚠ for them. */
function entryHtml(e, memory = false) {
    const dev = memory ? [] : deviations(e);
    const { copies, versions } = dupInfo(e);
    const open = String(e.uid) === String(state.openUid);
    const title = e.comment || "";
    const head = `
        <div class="stk-lore-row" data-act="toggle-open">
            <input type="checkbox" class="stk-lore-on" title="${e.disable ? "Выключена — включить" : "Включена — выключить"}" ${e.disable ? "" : "checked"}>
            <div class="stk-lore-main">
                <div class="stk-lore-title">${title ? escHtml(title) : `<i>без названия</i>`}</div>
                ${open ? "" : `<div class="stk-lore-preview">${escHtml(preview(e.content))}</div>`}
            </div>
            ${dev.length ? `<span class="stk-lore-warn" title="${escAttr("Не по стандарту: " + dev.join("; "))}">⚠</span>` : ""}
            ${copies.length ? `<button class="stk-lore-dup" data-act="copies" data-tip="copies" aria-label="Такая же запись есть ещё в ${inBooks(copies.length)}">⧉ ${copies.length}</button>` : ""}
            ${versions.length ? `<button class="stk-lore-dup stk-lore-ver" data-act="versions" data-tip="versions" aria-label="Другие версии текста: ${versions.length}">≠ ${versions.length}</button>` : ""}
            <span class="stk-lore-prio" title="Приоритет">${e.order ?? 100}</span>
        </div>`;
    if (!open) return `<div class="stk-lore-entry${e.disable ? " off" : ""}" data-uid="${e.uid}">${head}</div>`;
    return `
    <div class="stk-lore-entry open${e.disable ? " off" : ""}" data-uid="${e.uid}">
        ${head}
        <div class="stk-lore-edit">
            <div class="stk-lore-fields">
                <label class="stk-lore-field stk-lore-field-title"><span>Название</span>
                    <input class="text_pole stk-lore-title-input" value="${escAttr(title)}"></label>
                ${memory ? "" : groupSelectHtml(e)}
                <label class="stk-lore-field stk-lore-field-prio"><span>Приоритет</span>
                    <input class="text_pole stk-lore-prio-input" type="number" inputmode="numeric" value="${e.order ?? 100}"></label>
            </div>
            <label class="stk-lore-field"><span>Текст</span>
                <textarea class="text_pole stk-lore-text" rows="4">${escHtml(e.content || "")}</textarea></label>
            ${dev.length ? `
            <div class="stk-lore-devs">⚠ Не по стандарту: ${escHtml(dev.join("; "))}.
                <button class="menu_button sf-card-btn" data-act="standard">Привести к стандарту</button></div>` : ""}
            ${copies.length || versions.length ? `
            <div class="stk-lore-dupinfo">
                ${copies.length ? `<button class="stk-lore-linkbtn" data-act="copies">⧉ Точно такая же запись — ещё в ${inBooks(copies.length)}</button>` : ""}
                ${versions.length ? `<button class="stk-lore-linkbtn" data-act="versions">≠ Другие версии текста с этим названием: ${versions.length} — сравнить</button>` : ""}
            </div>` : ""}
            <div class="stk-lore-edit-foot">
                <span class="stk-lore-chars">${(e.content || "").length} симв.</span>
                ${memory
                    ? `<button class="menu_button sf-card-btn" data-act="to-regular" title="Убрать из воспоминаний Memory Books">↩ В обычные записи</button>`
                    : `<button class="menu_button sf-card-btn" data-act="to-memory" title="Сделать воспоминанием Memory Books">🧠 В воспоминания</button>`}
                <button class="menu_button sf-card-btn" data-act="delete">🗑 Удалить</button>
                <button class="menu_button sf-card-btn" data-act="toggle-open">Свернуть</button>
            </div>
        </div>
    </div>`;
}

function renderEntries() {
    const box = modal()?.querySelector(".stk-lore-entries");
    if (!box) return;
    state.stale = false;
    if (!state.book || !state.data) {
        box.innerHTML = `<p class="stk-note">Выберите лорбук.</p>`;
        return;
    }
    const { regular, memories } = splitEntries(state.data);
    const off = regular.filter((e) => e.disable).length;
    const odd = regular.filter((e) => deviations(e).length).length;
    const memOff = memories.filter((e) => e.disable).length;

    box.innerHTML = `
        <div class="stk-lore-bookhead">
            <button class="menu_button sf-card-btn stk-lore-back" data-act="back">← Лорбуки</button>
            <h4 class="stk-lore-bookname">${escHtml(state.book)}</h4>
        </div>
        ${state.compare ? compareHtml() : `<div class="stk-lore-toolbar">
            ${state.sortMode ? "" : `
            <button class="menu_button" data-act="add">＋ Новая запись</button>
            <button class="menu_button" data-act="groups">🗂 Группы</button>
            <button class="menu_button" data-act="compare">⇄ Сравнить</button>`}
            <button class="menu_button stk-lore-sortbtn${state.sortMode ? " active" : ""}" data-act="sort-mode">${state.sortMode ? "✓ Готово" : "↕ Порядок"}</button>
            <span class="stk-lore-stats">${regular.length} записей${off ? ` · выкл. ${off}` : ""}${odd ? ` · ⚠ ${odd}` : ""}</span>
        </div>
        ${state.sortMode ? sortModeHtml() : `
        <p class="stk-note">Сверху включённые, ниже выключенные; внутри — по приоритету: меньшее число выше, как в промпте.</p>
        ${(settings().groups.length ? groupedHtml(regular) : listHtml(regular, false)) || `<p class="stk-note">Записей нет.</p>`}
        ${memories.length ? `
        <details class="stk-lore-memories" ${settings().memoriesOpen === false ? "" : "open"}>
            <summary>🧠 Воспоминания Memory Books (${memories.length}${memOff ? ` · выкл. ${memOff}` : ""})</summary>
            ${listHtml(memories, true)}
        </details>` : ""}`}`}`;

    box.querySelector(".stk-lore-memories")?.addEventListener("toggle", (e) => {
        settings().memoriesOpen = e.target.open;
        saveSettings();
    });
    box.querySelectorAll(".stk-lore-text").forEach(autosize);
}

/** Entries under collapsible group headers; inside a group the styling tells on from off. */
function groupedHtml(entries) {
    const collapsed = settings().groupsCollapsed;
    return groupEntries(entries, settings().groups).map(({ group, entries: list }) => {
        const id = group?.id ?? "";
        const off = list.filter((e) => e.disable).length;
        return `
        <div class="stk-lore-group">
            <button class="stk-lore-group-head" data-act="toggle-group" data-id="${escAttr(id)}">
                <span class="stk-lore-caret">${collapsed[id] ? "▸" : "▾"}</span>
                <span class="stk-lore-group-name">${escHtml(group?.name ?? "Без группы")}</span>
                <span class="stk-lore-count">${list.length}${off ? ` · выкл. ${off}` : ""}</span>
            </button>
            ${collapsed[id] ? "" : `<div class="stk-lore-list">${list.map((e) => entryHtml(e)).join("")}</div>`}
        </div>`;
    }).join("");
}

/** Sorted entries, with a divider before the disabled ones. */
function listHtml(entries, memory) {
    const sorted = sortEntries(entries);
    const firstOff = sorted.findIndex((e) => e.disable);
    const html = sorted.map((e, i) =>
        (i === firstOff ? `<div class="stk-lore-divider">Выключены · ${sorted.length - firstOff}</div>` : "") + entryHtml(e, memory));
    return html.length ? `<div class="stk-lore-list">${html.join("")}</div>` : "";
}

function render() {
    const m = modal();
    if (!m) return;
    m.classList.toggle("has-book", !!state.book);
    renderBooks();
    renderEntries();
}

function autosize(ta) {
    // Collapsing the textarea for a moment shortens the page, and the browser
    // clamps the scroll position: keep it, or typing in a long text jumps up.
    const scrollers = [ta.closest(".stk-lore-entries"), document.getElementById(OVERLAY_ID)].filter(Boolean);
    const tops = scrollers.map((s) => s.scrollTop);
    ta.style.height = "auto";
    ta.style.height = ta.scrollHeight + 2 + "px";
    scrollers.forEach((s, i) => { s.scrollTop = tops[i]; });
}

function entryUid(el) {
    return el.closest(".stk-lore-entry")?.dataset.uid;
}

async function toggleOpen(uid) {
    if (state.openUid !== null) await flushEntry(String(state.openUid));
    state.openUid = String(state.openUid) === String(uid) ? null : uid;
    renderEntries();
    if (state.openUid !== null) {
        modal()?.querySelector(`.stk-lore-entry[data-uid="${uid}"]`)?.scrollIntoView({ block: "nearest" });
    }
}

function bindModal(m) {
    m.addEventListener("click", async (e) => {
        // An open menu swallows the first click outside it.
        if (m.querySelector(".stk-lore-menu")) {
            closeMenu();
            return;
        }
        const more = e.target.closest("[data-menu]");
        if (more) return more.dataset.menu === "folder" ? folderMenu(more, more.dataset.id) : bookMenu(more, more.dataset.id);
        const jump = e.target.closest("[data-open-book]");
        if (jump) return openBook(jump.dataset.openBook, jump.dataset.uid);
        const full = e.target.closest("[data-diff-full]");
        if (full) return toggleDiffFull(full);
        const book = e.target.closest(".stk-lore-book");
        if (book) return openBook(book.dataset.book);
        if (e.target.closest(".stk-lore-close")) return closeModal();
        if (e.target.classList.contains("stk-lore-on")) return; // handled by change

        const actEl = e.target.closest("[data-act]");
        const act = actEl?.dataset.act;
        const uid = entryUid(e.target);
        if (act === "toggle-folder") {
            const c = settings().foldersCollapsed;
            if (c[actEl.dataset.id]) delete c[actEl.dataset.id];
            else c[actEl.dataset.id] = true;
            return saveAndRenderBooks();
        }
        if (act === "toggle-group") {
            const c = settings().groupsCollapsed;
            if (c[actEl.dataset.id]) delete c[actEl.dataset.id];
            else c[actEl.dataset.id] = true;
            saveSettings();
            await flushAll();
            return renderEntries();
        }
        if (act === "new-folder") return newFolder();
        if (act === "groups") return groupsPanel();
        if (act === "copies") { hideTip(); return copiesMenu(actEl, uid); }
        if (act === "versions") return versionsPanel(uid);
        if (act === "compare") return compareMenu(actEl);
        if (act === "compare-close") {
            state.compare = null;
            return renderEntries();
        }
        if (act === "sort-mode") {
            await flushAll();
            state.sortMode = !state.sortMode;
            state.openUid = null;
            return renderEntries();
        }
        if (act === "move-up" || act === "move-down") {
            const i = Number(actEl.closest(".stk-lore-sortrow").dataset.idx);
            return reorder(i, act === "move-up" ? i - 1 : i + 1);
        }
        if (act === "to-memory" || act === "to-regular") return setMemory(uid, act === "to-memory");
        if (act === "back") {
            await flushAll();
            state.book = null;
            state.data = null;
            return render();
        }
        if (act === "add") return addEntry();
        if (act === "delete") return deleteEntry(uid);
        if (act === "standard") return makeStandard(uid);
        // The row toggles, but not when the click lands in the editing area's controls.
        if (act === "toggle-open" && uid !== undefined) return toggleOpen(uid);
    });

    m.addEventListener("change", (e) => {
        const uid = entryUid(e.target);
        if (e.target.classList.contains("stk-lore-on")) {
            const disable = !e.target.checked;
            e.target.closest(".stk-lore-entry").classList.toggle("off", disable);
            // Re-sort: the entry moves between the enabled and the disabled part.
            savePatch(uid, { disable }).then(flushAll).then(renderEntries);
        } else if (e.target.classList.contains("stk-lore-prio-input")) {
            const order = Number(e.target.value);
            if (!Number.isFinite(order)) return;
            const label = e.target.closest(".stk-lore-entry").querySelector(".stk-lore-prio");
            if (label) label.textContent = order;
            savePatch(uid, { order }); // re-sorted when the entry is collapsed
        } else if (e.target.classList.contains("stk-lore-group-select")) {
            setEntryGroup(uid, e.target);
        }
    });

    m.addEventListener("mouseover", (e) => {
        const mark = e.target.closest?.("[data-tip]");
        if (mark && !mark.contains(e.relatedTarget)) showTip(mark);
    });
    m.addEventListener("mouseout", (e) => {
        const mark = e.target.closest?.("[data-tip]");
        if (mark && !mark.contains(e.relatedTarget)) hideTip();
    });
    // "toggle" does not bubble: listen in the capture phase.
    m.addEventListener("toggle", (e) => {
        if (e.target.matches?.(".stk-lore-cmprow") && e.target.open) fillCmpRow(e.target);
    }, true);

    m.addEventListener("pointerdown", (e) => {
        const handle = e.target.closest(".stk-lore-handle");
        if (!handle || (e.pointerType === "mouse" && e.button !== 0)) return;
        e.preventDefault(); // no text selection, no page scroll while dragging
        startDrag(handle, e);
    });

    // Desktop: drag a lorebook onto a folder. (Touch screens use the ⋯ menu.)
    let dragBook = null;
    const dropHead = (e) => (dragBook === null ? null : e.target.closest?.("[data-drop-folder]"));
    m.addEventListener("dragstart", (e) => {
        const row = e.target.closest?.("[data-drag-book]");
        if (!row) return;
        dragBook = row.dataset.dragBook;
        e.dataTransfer.setData("text/plain", dragBook);
        e.dataTransfer.effectAllowed = "move";
    });
    m.addEventListener("dragover", (e) => {
        const head = dropHead(e);
        if (!head) return;
        e.preventDefault();
        head.classList.add("drop");
    });
    m.addEventListener("dragleave", (e) => {
        const head = dropHead(e);
        if (head && !head.contains(e.relatedTarget)) head.classList.remove("drop");
    });
    m.addEventListener("drop", (e) => {
        const head = dropHead(e);
        if (!head) return;
        e.preventDefault();
        moveBook(dragBook, head.dataset.dropFolder || null);
        dragBook = null;
    });
    m.addEventListener("dragend", () => {
        dragBook = null;
        m.querySelectorAll(".drop").forEach((el) => el.classList.remove("drop"));
    });

    m.addEventListener("input", (e) => {
        const uid = entryUid(e.target);
        if (e.target.classList.contains("stk-lore-text")) {
            autosize(e.target);
            const chars = e.target.closest(".stk-lore-entry").querySelector(".stk-lore-chars");
            if (chars) chars.textContent = `${e.target.value.length} симв.`;
            queueTyping(uid, "content", e.target.value);
        } else if (e.target.classList.contains("stk-lore-title-input")) {
            const label = e.target.closest(".stk-lore-entry").querySelector(".stk-lore-title");
            if (label) label.textContent = e.target.value || "без названия";
            queueTyping(uid, "comment", e.target.value);
        } else if (e.target.classList.contains("stk-lore-filter")) {
            state.filter = e.target.value;
            renderBooks();
        }
    });

    // Typing pauses are saved by the timer; leaving the field saves at once.
    m.addEventListener("focusout", (e) => {
        if (e.target.matches(".stk-lore-text, .stk-lore-title-input")) {
            const uid = entryUid(e.target);
            flushEntry(uid).then(() => {
                // A deferred outside update: show it once the user is no longer in a field.
                if (state.stale && !document.activeElement?.closest?.(".stk-lore-edit")) renderEntries();
            });
        }
    });
}

async function closeModal() {
    await flushAll();
    document.getElementById(OVERLAY_ID)?.remove();
}

function openLorePopup() {
    document.getElementById(OVERLAY_ID)?.remove();

    const overlay = document.createElement("div");
    overlay.id = OVERLAY_ID;
    overlay.className = "stk-modal-overlay";
    overlay.innerHTML = `
    <div class="stk-modal stk-lore-modal">
        <div class="stk-helper-header stk-lore-header">
            <h4>📖 Лорбуки</h4>
            <span class="stk-lore-status"></span>
            <button class="menu_button sf-card-btn stk-lore-close" title="Закрыть">✖</button>
        </div>
        <div class="stk-lore-panes">
            <div class="stk-lore-books">
                <div class="stk-lore-books-bar">
                    <input class="text_pole stk-lore-filter" type="search" autocomplete="off" placeholder="Найти лорбук…" value="${escAttr(state.filter)}">
                    <button class="menu_button sf-card-btn" data-act="new-folder" title="Новая папка">＋ Папка</button>
                </div>
                <div class="stk-lore-books-list"></div>
            </div>
            <div class="stk-lore-entries"></div>
        </div>
    </div>`;
    document.body.appendChild(overlay);
    overlay.addEventListener("click", (e) => {
        if (e.target !== overlay) return;
        if (overlay.querySelector(".stk-lore-menu")) closeMenu();
        else closeModal();
    });
    bindModal(overlay.querySelector(".stk-lore-modal"));
    loadLibrary();

    // Reopen the last book; on a phone start from the list of books.
    const last = settings().lastBook;
    if (state.book && bookNames().includes(state.book)) openBook(state.book);
    else if (!isPhone() && last && bookNames().includes(last)) openBook(last);
    else {
        state.book = null;
        state.data = null;
        render();
    }
}

/** Someone else (Memory Books, SillyTavern's editor) saved the open book. */
function onWorldInfoUpdated(name, data) {
    if (!data?.entries) return;
    if (library.ready || library.loading) libraryPut(name, data);
    if (ownSave || !modal()) return;
    if (name === state.book) state.data = structuredClone(data);
    // Another book changed: only the duplicate marks or the comparison may differ.
    // (A comparison on screen only cares about its two books: re-rendering closes its open rows.)
    if (name === state.book || name === state.compare || (library.ready && !state.compare)) refreshEntries();
}

// ── Init ──

export function initLore() {
    addWandMenuItem(MENU_ITEM_ID, "fa-book-atlas", "Лорбуки", openLorePopup);
    eventSource.on(event_types.WORLDINFO_UPDATED, onWorldInfoUpdated);
    console.log(`${TAG} Lorebooks module loaded`);
}
