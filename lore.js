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
    GROUP_FIELD, groupEntries, moveGroup,
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
    const off = regular.filter((e) => e.disable).length;
    const odd = regular.filter((e) => deviations(e).length).length;
    const memOff = memories.filter((e) => e.disable).length;

    box.innerHTML = `
        <div class="stk-lore-bookhead">
            <button class="menu_button sf-card-btn stk-lore-back" data-act="back">← Лорбуки</button>
            <h4 class="stk-lore-bookname">${escHtml(state.book)}</h4>
        </div>
        <div class="stk-lore-toolbar">
            <button class="menu_button" data-act="add">＋ Новая запись</button>
            <button class="menu_button" data-act="groups">🗂 Группы</button>
            <span class="stk-lore-stats">${regular.length} записей${off ? ` · выкл. ${off}` : ""}${odd ? ` · ⚠ ${odd}` : ""}</span>
        </div>
        <p class="stk-note">Сверху включённые, ниже выключенные; внутри — по приоритету: меньшее число выше, как в промпте.</p>
        ${(settings().groups.length ? groupedHtml(regular) : listHtml(regular, false)) || `<p class="stk-note">Записей нет.</p>`}
        ${memories.length ? `
        <details class="stk-lore-memories" ${settings().memoriesOpen === false ? "" : "open"}>
            <summary>🧠 Воспоминания Memory Books (${memories.length}${memOff ? ` · выкл. ${memOff}` : ""})</summary>
            ${listHtml(memories, true)}
        </details>` : ""}`;

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
