// ============================================================
//  Story Toolkit — Notes module (заметки мастеру)
//
//  Постоянная инструкция в пресете со временем самоусиливается:
//  модель каждый ход читает правило и свои прошлые ответы на него.
//  Заметка живёт ограниченное число ходов: поправила курс — ушла.
//  Игрок пишет её как наблюдение, а не как правило.
//
//  Механика — как у Guide: перехват промпта, хранение в
//  chat_metadata. Срок считается в сообщениях игрока: заметка,
//  дошедшая до модели, теряет один ход на следующем MESSAGE_SENT.
//  Свайпы и регенерации срок не расходуют.
// ============================================================

import { getContext, eventSource, event_types, toolkitSettings, saveSettings } from "./st.js";
import { addWandMenuItem, escHtml } from "./utils.js";
import { isHelperGenerating } from "./helper.js";

const TAG = "[STK Notes]";
const META_KEY = "story_notes";
const MENU_ITEM_ID = "stk_notes_menu_item";
const INDICATOR_ID = "stk_notes_indicator";
const OVERLAY_ID = "stk-notes-overlay";

const DEFAULT_HEADER = "Заметки игрока к мастеру — наблюдения за последними ходами, не правила. Что с ними делать, решаешь сам.";

// ── Settings (global) ──

function S() {
    const t = toolkitSettings();
    if (!t.notes) t.notes = {};
    const s = t.notes;
    if (!["system", "user", "assistant"].includes(s.role)) s.role = "system";
    if (!["tail", "before_last_user"].includes(s.position)) s.position = "tail";
    if (typeof s.header !== "string") s.header = DEFAULT_HEADER;
    if (!(Number.isInteger(s.defaultTtl) && s.defaultTtl > 0)) s.defaultTtl = 10;
    return s;
}

/** {{char}}, {{user}} и прочие макросы Таверны. */
function substitute(text) {
    try {
        const fn = getContext().substituteParams;
        return typeof fn === "function" ? fn(text) : text;
    } catch {
        return text;
    }
}

// ── Per-chat storage (chat_metadata) ──

function meta() {
    try {
        const ctx = getContext();
        return ctx.chatMetadata || ctx.chat_metadata || null;
    } catch (e) {
        return null;
    }
}

function saveMeta() {
    const ctx = getContext();
    if (typeof ctx.saveMetadataDebounced === "function") ctx.saveMetadataDebounced();
    else if (typeof ctx.saveMetadata === "function") ctx.saveMetadata();
}

/** Заметки текущего чата (живой массив из chat_metadata) или пустой список. */
function getNotes() {
    const list = meta()?.[META_KEY];
    return Array.isArray(list) ? list : [];
}

function setNotes(list) {
    const m = meta();
    if (!m) return false;
    if (list.length) m[META_KEY] = list;
    else delete m[META_KEY];
    saveMeta();
    updateIndicator();
    return true;
}

function newId() {
    return "n" + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

function addNote(text, ttl) {
    if (!meta()) {
        toastr.error("Notes: chat_metadata недоступна — откройте чат");
        return false;
    }
    return setNotes([...getNotes(), { id: newId(), text, ttl, left: ttl, consumed: false, createdAt: Date.now() }]);
}

function removeNote(id) {
    setNotes(getNotes().filter((n) => n.id !== id));
}

function shortText(text, max = 60) {
    const t = String(text).replace(/\s+/g, " ").trim();
    return t.length > max ? t.slice(0, max - 1).trimEnd() + "…" : t;
}

// ── Injection ──

/** Шапка и заметки с «— » — без номеров, счётчиков и любых цифр от модуля. */
function buildBlock(notes) {
    const header = S().header.trim();
    const lines = notes.map((n) => "— " + String(n.text).trim());
    return substitute((header ? header + "\n" : "") + lines.join("\n"));
}

function onPromptReady(data) {
    try {
        if (!data || data.dryRun) return; // token counting, not a real generation
        // Little Helper writes the player's turn: notes for the master would
        // steer it wrongly and spend a turn of their life.
        if (isHelperGenerating()) return;
        const notes = getNotes();
        if (!notes.length) return;
        const chat = data.chat;
        if (!Array.isArray(chat) || !chat.length) return;

        const s = S();
        let insertAt = -1;
        if (s.position === "before_last_user") {
            insertAt = chat.findLastIndex((m) => m?.role === "user");
        }
        if (insertAt < 0) {
            // Как Guide: в хвост, а если последний элемент — префилл ассистента, перед ним.
            insertAt = chat.length;
            if (chat[chat.length - 1]?.role === "assistant" && chat.length > 1) insertAt = chat.length - 1;
        }
        chat.splice(insertAt, 0, { role: s.role, content: buildBlock(notes) });

        // Срок спишется на следующем сообщении игрока (MESSAGE_SENT), а не сейчас:
        // до него заметки переживают свайпы и регенерации этого ответа.
        let changed = false;
        for (const n of notes) {
            if (!n.consumed) {
                n.consumed = true;
                changed = true;
            }
        }
        if (changed) saveMeta();
        console.log(`${TAG} ✓ Injected ${notes.length} note(s) as ${s.role} at ${insertAt}/${chat.length} (${s.position})`);
    } catch (e) {
        console.error(`${TAG} onPromptReady error:`, e);
    }
}

// ── Lifecycle ──

function onMessageSent() {
    const notes = getNotes();
    if (!notes.some((n) => n.consumed)) return;
    // MESSAGE_SENT приходит ДО сборки промпта нового ответа: здесь списывается
    // ход, прожитый заметками в прошлом ответе.
    const done = [];
    const keep = [];
    for (const n of notes) {
        if (n.consumed) {
            n.consumed = false;
            if (n.ttl > 0) n.left -= 1;
        }
        if (n.ttl > 0 && n.left <= 0) done.push(n);
        else keep.push(n);
    }
    setNotes(keep);
    for (const n of done) toastr.info(`Notes: заметка отработала и снята: «${shortText(n.text)}»`);
    refreshPopup();
}

function onChatChanged() {
    updateIndicator();
    // Окно показывает заметки прежнего чата — закрыть.
    document.getElementById(OVERLAY_ID)?.remove();
}

// ── UI: wand menu item + N next to the chat input ──

function addInputIndicator() {
    $(`#${INDICATOR_ID}`).remove();
    const $n = $(`<div id="${INDICATOR_ID}" class="interactable" tabindex="0">N</div>`);
    $n.on("click", openNotesPopup);
    $("#leftSendForm").append($n);
}

function plural(n, one, few, many) {
    const m10 = n % 10;
    const m100 = n % 100;
    if (m10 === 1 && m100 !== 11) return one;
    if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
    return many;
}

function updateIndicator() {
    const count = getNotes().length;
    const on = count > 0;
    $(`#${INDICATOR_ID}`)
        .toggleClass("stk-notes-on", on)
        .attr("title", on ? `Notes: ${count} ${plural(count, "заметка", "заметки", "заметок")}` : "Notes: заметок нет");
    // На узком экране N спрятана (CSS) — об активных заметках говорит точка на волшебной палочке.
    $("#extensionsMenuButton").toggleClass("stk-notes-armed", on);
    const $item = $(`#${MENU_ITEM_ID}`);
    if (!$item.length) return;
    $item.toggleClass("stk-notes-active", on);
    $item.find("span").text(on ? "Notes ●" : "Notes");
}

// ── UI: popup ──

function escAttr(s) {
    return escHtml(s).replace(/"/g, "&quot;");
}

function leftLabel(n) {
    return n.ttl > 0 ? `осталось ${n.left} из ${n.ttl}` : "пока не сниму";
}

function listHtml() {
    const notes = getNotes();
    if (!notes.length) return `<div class="stk-notes-empty">Заметок нет.</div>`;
    return notes.map((n) => `
        <div class="stk-notes-item" data-id="${escAttr(n.id)}">
            <div class="stk-notes-text">${escHtml(n.text)}</div>
            <span class="stk-notes-left">${leftLabel(n)}</span>
            <button class="menu_button stk-notes-del" title="Снять заметку">🗑️</button>
        </div>`).join("");
}

/** Список в открытом окне — после списания срока или снятия. */
function refreshPopup() {
    const box = document.getElementById("stk-notes-list");
    if (!box) return;
    box.innerHTML = listHtml();
    const clear = document.getElementById("stk-notes-clear");
    if (clear) clear.disabled = !getNotes().length;
}

function openNotesPopup() {
    document.getElementById(OVERLAY_ID)?.remove();
    const s = S();

    const overlay = document.createElement("div");
    overlay.id = OVERLAY_ID;
    overlay.className = "stk-modal-overlay";

    const modal = document.createElement("div");
    modal.className = "stk-modal";
    modal.innerHTML = `
        <h4>📝 Notes — заметки мастеру</h4>
        <div class="stk-notes-list" id="stk-notes-list">${listHtml()}</div>
        <textarea id="stk-notes-text" class="text_pole" rows="3"
            placeholder="Наблюдение своими словами, без целевых цифр: „это много“ лучше, чем „не чаще двух раз“. В историю чата не попадает."></textarea>
        <div class="stk-notes-ttl">
            <label>Срок, сообщений
                <input id="stk-notes-ttl" class="text_pole" type="number" min="1" step="1" inputmode="numeric" value="${s.defaultTtl}"></label>
            <label class="stk-notes-forever"><input id="stk-notes-forever" type="checkbox"> пока не сниму</label>
        </div>
        <div class="stk-modal-actions">
            <button id="stk-notes-add" class="menu_button">＋ Добавить</button>
            <button id="stk-notes-clear" class="menu_button" ${getNotes().length ? "" : "disabled"}>🗑️ Снять все</button>
            <button id="stk-notes-close" class="menu_button">✖</button>
        </div>
        <details class="stk-notes-settings">
            <summary>⚙ Настройки</summary>
            <div class="stk-notes-group">
                <span>Роль блока</span>
                ${["system", "user", "assistant"].map((r) => `
                <label><input type="radio" name="stk-notes-role" value="${r}" ${s.role === r ? "checked" : ""}> ${r}</label>`).join("")}
            </div>
            <div class="stk-notes-group">
                <span>Позиция</span>
                <label><input type="radio" name="stk-notes-pos" value="tail" ${s.position === "tail" ? "checked" : ""}>
                    <span>в конце промпта <small>(как Guide; перед префиллом, если он есть)</small></span></label>
                <label><input type="radio" name="stk-notes-pos" value="before_last_user" ${s.position === "before_last_user" ? "checked" : ""}>
                    <span>перед последним сообщением игрока</span></label>
            </div>
            <label class="stk-notes-field">Шапка блока
                <textarea id="stk-notes-header" class="text_pole" rows="3">${escHtml(s.header)}</textarea></label>
            <label class="stk-notes-field">Срок по умолчанию, сообщений
                <input id="stk-notes-default" class="text_pole" type="number" min="1" step="1" inputmode="numeric" value="${s.defaultTtl}"></label>
        </details>`;

    overlay.appendChild(modal);
    document.body.appendChild(overlay);

    const ttlInput = document.getElementById("stk-notes-ttl");
    const forever = document.getElementById("stk-notes-forever");
    forever.addEventListener("change", () => { ttlInput.disabled = forever.checked; });

    document.getElementById("stk-notes-add").addEventListener("click", () => {
        const ta = document.getElementById("stk-notes-text");
        const text = ta.value.trim();
        if (!text) {
            toastr.warning("Notes: впишите наблюдение");
            return;
        }
        let ttl = 0;
        if (!forever.checked) {
            ttl = Number(ttlInput.value);
            if (!(Number.isInteger(ttl) && ttl > 0)) {
                toastr.warning("Notes: срок — целое число сообщений, от 1");
                return;
            }
        }
        if (!addNote(text, ttl)) return;
        ta.value = "";
        refreshPopup();
        toastr.success(ttl ? `Notes: заметка добавлена на ${ttl} ${plural(ttl, "сообщение", "сообщения", "сообщений")}` : "Notes: заметка добавлена, пока не снимете");
    });

    document.getElementById("stk-notes-list").addEventListener("click", (e) => {
        const del = e.target.closest(".stk-notes-del");
        if (!del) return;
        removeNote(del.closest(".stk-notes-item").dataset.id);
        refreshPopup();
    });

    document.getElementById("stk-notes-clear").addEventListener("click", () => {
        setNotes([]);
        refreshPopup();
        toastr.info("Notes: все заметки сняты");
    });

    // Настройки сохраняются сразу и действуют со следующей генерации.
    modal.querySelectorAll('input[name="stk-notes-role"], input[name="stk-notes-pos"]').forEach((r) => {
        r.addEventListener("change", () => {
            if (r.name === "stk-notes-role") S().role = r.value;
            else S().position = r.value;
            saveSettings();
        });
    });
    document.getElementById("stk-notes-header").addEventListener("input", (e) => {
        S().header = e.target.value;
        saveSettings();
    });
    document.getElementById("stk-notes-default").addEventListener("change", (e) => {
        const v = Number(e.target.value);
        if (Number.isInteger(v) && v > 0) {
            S().defaultTtl = v;
            saveSettings();
        } else {
            e.target.value = S().defaultTtl;
        }
    });

    document.getElementById("stk-notes-close").addEventListener("click", () => overlay.remove());
    overlay.addEventListener("click", (e) => {
        if (e.target === overlay) overlay.remove();
    });
}

// ── Init ──

export function initNotes() {
    S();

    addWandMenuItem(MENU_ITEM_ID, "fa-note-sticky", "Notes", openNotesPopup);
    addInputIndicator();
    updateIndicator();

    if (eventSource && event_types) {
        if (event_types.CHAT_COMPLETION_PROMPT_READY) {
            eventSource.on(event_types.CHAT_COMPLETION_PROMPT_READY, (data) => onPromptReady(data));
        } else {
            console.error(`${TAG} CHAT_COMPLETION_PROMPT_READY not available!`);
        }
        if (event_types.MESSAGE_SENT) {
            eventSource.on(event_types.MESSAGE_SENT, () => onMessageSent());
        }
        eventSource.on(event_types.CHAT_CHANGED, () => onChatChanged());
    }

    console.log(`${TAG} Notes module loaded`);
}
