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
//  Books показаны отдельно и не редактируются.
// ============================================================

import { getContext, getPopupClass, toolkitSettings, saveSettings, eventSource, event_types, worldInfo } from "./st.js";
import { addWandMenuItem, escHtml } from "./utils.js";
import {
    STANDARD, deviations, applyPatch, newEntryFields, splitEntries, sortEntries, preview,
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
    stale: false,    // an outside save arrived while the user was typing
};

// uid -> { patch, timer } — text typed but not saved yet
const pending = new Map();
let saveChain = Promise.resolve();
let ownSave = false;

function settings() {
    const t = toolkitSettings();
    if (!t.lore) t.lore = { lastBook: null, sort: "prompt" };
    return t.lore;
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

// ── Actions ──

async function openBook(name) {
    await flushAll();
    const data = await getContext().loadWorldInfo(name);
    if (!data?.entries) {
        toastr.error(`Лорбук «${name}» не загрузился.`, "Лорбуки");
        return;
    }
    state.book = name;
    state.data = data; // loadWorldInfo hands out a clone already
    state.openUid = null;
    state.stale = false;
    settings().lastBook = name;
    saveSettings();
    render();
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
    const popup = getPopupClass();
    const yes = popup
        ? await popup.Popup.show.confirm("Удалить запись?", `«${escHtml(label)}» будет удалена из лорбука «${escHtml(state.book)}». Это необратимо.`)
        : window.confirm(`Удалить «${label}»? Это необратимо.`);
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

async function makeStandard(uid) {
    await savePatch(uid, { ...STANDARD });
    renderEntries();
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

function renderBooks() {
    const list = modal()?.querySelector(".stk-lore-books-list");
    if (!list) return;
    const f = state.filter.trim().toLowerCase();
    const names = bookNames().filter((n) => !f || n.toLowerCase().includes(f));
    list.innerHTML = names.length
        ? names.map((n) => `<button class="stk-lore-book${n === state.book ? " active" : ""}" data-book="${escAttr(n)}">${escHtml(n)}</button>`).join("")
        : `<p class="stk-note">Ничего не найдено</p>`;
}

function entryHtml(e) {
    const dev = deviations(e);
    const open = String(e.uid) === String(state.openUid);
    const title = e.comment || "";
    const head = `
        <div class="stk-lore-row" data-act="toggle-open">
            <input type="checkbox" class="stk-lore-on" title="Включена" ${e.disable ? "" : "checked"}>
            <div class="stk-lore-main">
                <div class="stk-lore-title">${title ? escHtml(title) : `<i>без названия</i>`}</div>
                ${open ? "" : `<div class="stk-lore-preview">${escHtml(preview(e.content))}</div>`}
            </div>
            ${dev.length ? `<span class="stk-lore-warn" title="${escAttr("Не по стандарту: " + dev.join("; "))}">⚠</span>` : ""}
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
                <label class="stk-lore-field stk-lore-field-prio"><span>Приоритет</span>
                    <input class="text_pole stk-lore-prio-input" type="number" inputmode="numeric" value="${e.order ?? 100}"></label>
            </div>
            <label class="stk-lore-field"><span>Текст</span>
                <textarea class="text_pole stk-lore-text" rows="4">${escHtml(e.content || "")}</textarea></label>
            ${dev.length ? `
            <div class="stk-lore-devs">⚠ Не по стандарту: ${escHtml(dev.join("; "))}.
                <button class="menu_button sf-card-btn" data-act="standard">Привести к стандарту</button></div>` : ""}
            <div class="stk-lore-edit-foot">
                <span class="stk-lore-chars">${(e.content || "").length} симв.</span>
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
    const sort = settings().sort;
    const off = regular.filter((e) => e.disable).length;
    const odd = regular.filter((e) => deviations(e).length).length;

    box.innerHTML = `
        <div class="stk-lore-bookhead">
            <button class="menu_button sf-card-btn stk-lore-back" data-act="back">← Лорбуки</button>
            <h4 class="stk-lore-bookname">${escHtml(state.book)}</h4>
        </div>
        <div class="stk-lore-toolbar">
            <button class="menu_button" data-act="add">＋ Новая запись</button>
            <select class="stk-lore-sort">
                <option value="prompt" ${sort === "prompt" ? "selected" : ""}>Порядок промпта</option>
                <option value="title" ${sort === "title" ? "selected" : ""}>По названию</option>
            </select>
            <span class="stk-lore-stats">${regular.length} записей${off ? ` · выкл. ${off}` : ""}${odd ? ` · ⚠ ${odd}` : ""}</span>
        </div>
        ${sort === "prompt" ? `<p class="stk-note">Сверху — то, что раньше в промпте: меньший приоритет идёт первым.</p>` : ""}
        <div class="stk-lore-list">${sortEntries(regular, sort).map(entryHtml).join("") || `<p class="stk-note">Записей нет.</p>`}</div>
        ${memories.length ? `
        <details class="stk-lore-memories">
            <summary>🧠 Воспоминания Memory Books (${memories.length}) — только просмотр</summary>
            ${sortEntries(memories, "title").map((m) => `
                <details class="stk-lore-memory">
                    <summary>${escHtml(m.comment || preview(m.content))}</summary>
                    <div class="sf-card-text">${escHtml(m.content || "")}</div>
                </details>`).join("")}
        </details>` : ""}`;

    box.querySelectorAll(".stk-lore-text").forEach(autosize);
}

function render() {
    const m = modal();
    if (!m) return;
    m.classList.toggle("has-book", !!state.book);
    renderBooks();
    renderEntries();
}

function autosize(ta) {
    ta.style.height = "auto";
    ta.style.height = ta.scrollHeight + 2 + "px";
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
        const book = e.target.closest(".stk-lore-book");
        if (book) return openBook(book.dataset.book);
        if (e.target.closest(".stk-lore-close")) return closeModal();
        if (e.target.classList.contains("stk-lore-on")) return; // handled by change

        const act = e.target.closest("[data-act]")?.dataset.act;
        const uid = entryUid(e.target);
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
            savePatch(uid, { disable });
        } else if (e.target.classList.contains("stk-lore-prio-input")) {
            const order = Number(e.target.value);
            if (!Number.isFinite(order)) return;
            const label = e.target.closest(".stk-lore-entry").querySelector(".stk-lore-prio");
            if (label) label.textContent = order;
            savePatch(uid, { order });
        } else if (e.target.classList.contains("stk-lore-sort")) {
            settings().sort = e.target.value;
            saveSettings();
            renderEntries();
        }
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
                <input class="text_pole stk-lore-filter" type="search" autocomplete="off" placeholder="Найти лорбук…" value="${escAttr(state.filter)}">
                <div class="stk-lore-books-list"></div>
            </div>
            <div class="stk-lore-entries"></div>
        </div>
    </div>`;
    document.body.appendChild(overlay);
    overlay.addEventListener("click", (e) => {
        if (e.target === overlay) closeModal();
    });
    bindModal(overlay.querySelector(".stk-lore-modal"));

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
    if (ownSave || name !== state.book || !modal() || !data?.entries) return;
    state.data = structuredClone(data);
    const typing = document.activeElement?.closest?.(`#${OVERLAY_ID} .stk-lore-edit`);
    if (typing || pending.size) state.stale = true;
    else renderEntries();
}

// ── Init ──

export function initLore() {
    addWandMenuItem(MENU_ITEM_ID, "fa-book-atlas", "Лорбуки", openLorePopup);
    eventSource.on(event_types.WORLDINFO_UPDATED, onWorldInfoUpdated);
    console.log(`${TAG} Lorebooks module loaded`);
}
