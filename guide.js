// ============================================================
//  Story Toolkit — Guide module (guided response)
//
//  Аналог авторской заметки на depth 1, но с жизненным циклом:
//  - гайд переживает генерацию, свайпы и регенерации;
//  - в режиме "auto" очищается, когда игрок отправляет
//    СЛЕДУЮЩЕЕ сообщение (то есть "двинулся дальше");
//  - в режиме "manual" висит, пока не снят вручную.
//  Хранение — chat_metadata (per-chat, переживает перезагрузку).
// ============================================================

import { getContext, eventSource, event_types, toolkitSettings, saveSettings, getPopupClass } from "./st.js";
import { addWandMenuItem, escHtml } from "./utils.js";
import { isHelperGenerating } from "./helper.js";

const TAG = "[STK Guide]";
const META_KEY = "story_guide";
const MENU_ITEM_ID = "stk_guide_menu_item";
const INDICATOR_ID = "stk_guide_indicator";

// ── Settings (global defaults) ──

// Стартовый набор: пример того, как выглядит направляющий гайд. Редактируется
// и удаляется в окне Guide; набор хранится в настройках, а не в коде.
const STARTER_LIBRARY = [
    {
        name: "Слишком слащаво",
        text: "Без сахара. Никаких умилительных жестов, признаний в лоб и тёплых штампов. Чувства — через действия, паузы и недосказанность; персонажи остаются колючими, неловкими, живыми.",
    },
    {
        name: "Неубедительно",
        text: "Персонажи действуют из своих мотивов и характера, а не ради удобства сюжета. Реакции соразмерные и конкретные, с причиной и следствием; никаких смен настроения без повода.",
    },
    {
        name: "Мрачнее",
        text: "Сгусти краски: тяжесть, цена поступков, тени прошлого, то, что идёт не так. Без мелодрамы и без жестокости ради жестокости — мрачность через атмосферу, детали и последствия.",
    },
];

function S() {
    const t = toolkitSettings();
    if (!t.guide) t.guide = { defaultMode: "auto" };
    return t.guide;
}

// ── Набор гайдов: отдельный файл, не settings.json ──
//
// settings.json Таверна сохраняет целиком из каждой открытой вкладки, и вкладка
// со старой копией (телефон, второй компьютер) молча затирает чужие правки.
// Набор живёт в файле пользователя: пишет его только редактор набора, а читается
// он заново при каждом открытии окна — все устройства видят одно и то же.

const LIB_FILE = "story-toolkit-guides.json";
let library = [];        // кэш последнего прочитанного набора
let libraryLoaded = false;

/** Свежий набор с сервера. Стартовый набор засевается, только если файла точно нет (404). */
async function loadLibrary() {
    let r;
    try {
        r = await fetch(`/user/files/${LIB_FILE}`, { cache: "no-store" });
    } catch (e) {
        console.warn(`${TAG} набор не прочитан`, e);
        if (!libraryLoaded) toastr.error("Guide: не удалось прочитать набор гайдов");
        return library;
    }
    if (r.ok) {
        const d = await r.json().catch(() => null);
        if (Array.isArray(d?.library)) {
            library = d.library;
            libraryLoaded = true;
            return library;
        }
        toastr.error("Guide: файл набора повреждён — не трогаю его");
        return library;
    }
    if (r.status !== 404) {
        if (!libraryLoaded) toastr.error(`Guide: набор не прочитан (HTTP ${r.status})`);
        return library;
    }
    // Файла нет: перенести набор из прежнего места (settings.json) или засеять стартовый.
    const legacy = S().library;
    library = Array.isArray(legacy) && legacy.length
        ? legacy
        : STARTER_LIBRARY.map((g) => ({ id: newId(), ...g }));
    libraryLoaded = true;
    if (await saveLibrary() && legacy) {
        delete S().library;
        saveSettings();
    }
    return library;
}

async function saveLibrary() {
    const json = JSON.stringify({ version: 1, library }, null, 2);
    // base64 от UTF-8: btoa понимает только Latin-1
    const bytes = new TextEncoder().encode(json);
    let bin = "";
    for (const b of bytes) bin += String.fromCharCode(b);
    try {
        const r = await fetch("/api/files/upload", {
            method: "POST",
            headers: getContext().getRequestHeaders(),
            body: JSON.stringify({ name: LIB_FILE, data: btoa(bin) }),
        });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return true;
    } catch (e) {
        console.error(`${TAG} набор не сохранён`, e);
        toastr.error("Guide: не удалось сохранить набор гайдов");
        return false;
    }
}

function newId() {
    return "g" + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

// Плейсхолдеры вида [имя] — как в квик-реплаях: значение спрашивается при применении.
const PLACEHOLDER_RE = /\[([^\[\]\n]{1,24})\]/g;

function placeholdersOf(text) {
    return [...new Set([...String(text).matchAll(PLACEHOLDER_RE)].map((m) => m[0]))];
}

/** Итоговый текст гайда: выбранные заготовки по порядку набора, потом своё указание. */
function composeGuide(picks, free, fills) {
    const parts = library
        .filter((g) => picks.includes(g.id))
        .map((g) => g.text.replace(PLACEHOLDER_RE, (m) => (fills[m] ?? "").trim() || m).trim())
        .filter(Boolean);
    if (free.trim()) parts.push(free.trim());
    return parts.join("\n\n");
}

/** {{char}}, {{user}} и прочие макросы Таверны — гайд вклеивается уже после их подстановки. */
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

function getGuide() {
    const m = meta();
    const g = m?.[META_KEY];
    return g && g.text ? g : null;
}

/**
 * @param {string} text итоговый текст, он и вклеивается
 * @param {string} mode "auto" | "manual"
 * @param {object} [state] выбор в окне ({picks, free, fills}) — чтобы при повторном открытии он восстановился
 */
function setGuide(text, mode, state = {}) {
    const m = meta();
    if (!m) {
        toastr.error("Guide: chat_metadata недоступна");
        return false;
    }
    m[META_KEY] = { text, mode, createdAt: Date.now(), ...state };
    saveMeta();
    updateIndicator();
    return true;
}

function clearGuide(silent = false) {
    const m = meta();
    if (m && m[META_KEY]) {
        delete m[META_KEY];
        saveMeta();
    }
    updateIndicator();
    if (!silent) toastr.info("Guide: указание снято");
}

// ── Injection (same mechanism as Director: prompt interception) ──

function onPromptReady(data) {
    try {
        if (!data || data.dryRun) return; // skip token-counting dry runs
        // Little Helper writes the player's turn; a guide aimed at the
        // character's reply would steer it wrongly and be marked consumed.
        if (isHelperGenerating()) return;
        const g = getGuide();
        if (!g) return;
        const chat = data.chat;
        if (!Array.isArray(chat) || !chat.length) return;
        // В самый конец массива на момент события — вплотную к последнему
        // сообщению игрока. Всё, что ядро вплетает позже (инъекции глубин
        // пресета), ложится по своим правилам, но гайд гарантированно
        // не окажется над стеной инструкций (старый вариант length-1
        // оставлял его на фактической глубине 4-5). Если последний
        // элемент — префилл ассистента, встаём перед ним.
        let insertAt = chat.length;
        if (chat[chat.length - 1]?.role === "assistant" && chat.length > 1) {
            insertAt = chat.length - 1;
        }
        chat.splice(insertAt, 0, { role: "system", content: substitute(g.text) });
        // Помечаем auto-гайд отработавшим только в момент фактической
        // инъекции в боевую генерацию. Удаление произойдёт на СЛЕДУЮЩЕМ
        // MESSAGE_SENT — до этого гайд переживает свайпы и регенерации
        // того ответа, на который был нацелен.
        if (g.mode === "auto" && !g.consumed) {
            g.consumed = true;
            saveMeta();
        }
        console.log(`${TAG} ✓ Injected at tail (${insertAt}/${chat.length})`);
    } catch (e) {
        console.error(`${TAG} onPromptReady error:`, e);
    }
}

// ── Lifecycle ──

function onMessageSent() {
    const g = getGuide();
    // MESSAGE_SENT стреляет ДО сборки промпта, поэтому чистить гайд
    // по первому же событию нельзя — он ещё не дошёл до модели.
    // Удаляем только уже отработавший (consumed) гайд: это сообщение —
    // то самое "следующее", игрок двинулся дальше.
    if (g && g.mode === "auto" && g.consumed) {
        clearGuide(true);
        toastr.info("Guide: указание отработало и снято");
    }
}

function onChatChanged() {
    // Guide is per-chat: just refresh the indicator for the new chat
    updateIndicator();
}

// ── UI: wand menu indicator + G next to the chat input ──

function addInputIndicator() {
    $(`#${INDICATOR_ID}`).remove();
    const $g = $(`<div id="${INDICATOR_ID}" class="interactable" tabindex="0">G</div>`);
    $g.on("click", openGuidePopup);
    $("#leftSendForm").append($g);
}

function updateIndicator() {
    const g = getGuide();
    $(`#${INDICATOR_ID}`)
        .toggleClass("stk-guide-on", !!g)
        .attr("title", g
            ? (g.mode === "manual" ? "Guide включён (пока не сниму)" : "Guide включён (до следующего сообщения)")
            : "Guide выключен");
    // На узком экране G спрятана (CSS) — о взведённом гайде говорит точка на волшебной палочке.
    $("#extensionsMenuButton").toggleClass("stk-guide-armed", !!g);
    const $item = $(`#${MENU_ITEM_ID}`);
    if (!$item.length) return;
    $item.toggleClass("stk-guide-active", !!g);
    const label = g
        ? (g.mode === "manual" ? "Guide ● (ручной)" : "Guide ●")
        : "Guide";
    $item.find("span").text(label);
}

// ── UI: popup ──

async function openGuidePopup() {
    document.getElementById("stk-guide-overlay")?.remove();
    await loadLibrary();   // свежий набор: его могли поменять на другом устройстве

    const st = S();
    const g = getGuide();
    const mode = g?.mode || st.defaultMode || "auto";
    // Состояние окна. Гайд, взведённый до появления набора, целиком становится «своим указанием».
    const picks = new Set(Array.isArray(g?.picks) ? g.picks : []);
    let free = g ? (typeof g.free === "string" ? g.free : (Array.isArray(g.picks) ? "" : g.text)) : "";
    const fills = { ...(g?.fills || {}) };

    const overlay = document.createElement("div");
    overlay.id = "stk-guide-overlay";
    overlay.className = "stk-modal-overlay";

    const modal = document.createElement("div");
    modal.className = "stk-modal";
    modal.innerHTML = `
        <h4>🧭 Guide — направить ответ</h4>
        <div class="stk-guide-chips" id="stk-guide-chips"></div>
        <div id="stk-guide-fills"></div>
        <textarea id="stk-guide-text" class="text_pole" rows="3"
            placeholder="Своё указание — само по себе или вдобавок к выбранным. В историю чата не попадает: вклеивается в промпт только на время генерации."></textarea>
        <div class="stk-guide-modes">
            <label class="stk-guide-mode">
                <input type="radio" name="stk-guide-mode" value="auto" ${mode === "auto" ? "checked" : ""}>
                <span><b>До следующего сообщения</b><br>
                <small>Снимется автоматически, когда вы отправите новое сообщение. Свайпы и регенерации не в счёт.</small></span>
            </label>
            <label class="stk-guide-mode">
                <input type="radio" name="stk-guide-mode" value="manual" ${mode === "manual" ? "checked" : ""}>
                <span><b>Пока не сниму</b><br>
                <small>Висит на всех ответах, пока не нажмёте «Снять». Иконка в меню подсвечена.</small></span>
            </label>
        </div>
        <div class="stk-modal-actions">
            <button id="stk-guide-apply" class="menu_button" title="Применить к следующему ответу">💾 Применить</button>
            <button id="stk-guide-rewrite" class="menu_button" title="Применить и сразу сгенерировать новый свайп последнего ответа">↻ Переписать</button>
            <button id="stk-guide-clear" class="menu_button" ${g ? "" : "disabled"}>🗑️ Снять</button>
            <button id="stk-guide-close" class="menu_button">✖</button>
        </div>
        <details class="stk-guide-lib" id="stk-guide-lib">
            <summary>✎ Набор гайдов</summary>
            <div id="stk-guide-lib-list"></div>
            <div class="stk-guide-lib-actions">
                <button id="stk-guide-lib-add" class="menu_button">＋ Новый гайд</button>
                <button id="stk-guide-lib-import" class="menu_button">⇣ Из квик-реплаев</button>
            </div>
            <div id="stk-guide-import"></div>
        </details>`;

    overlay.appendChild(modal);
    document.body.appendChild(overlay);

    const ta = document.getElementById("stk-guide-text");
    ta.value = free;
    ta.addEventListener("input", () => { free = ta.value; });

    // ── плашки и плейсхолдеры ──

    function renderChips() {
        const $box = $("#stk-guide-chips");
        const lib = library;
        // выкинуть выбор удалённых из набора
        for (const id of [...picks]) if (!lib.some((x) => x.id === id)) picks.delete(id);
        if (!lib.length) {
            $box.html('<span class="stk-guide-empty">Набор пуст — добавьте гайд ниже или импортируйте из квик-реплаев.</span>');
        } else {
            $box.html(lib.map((x) => `<span class="stk-guide-chip${picks.has(x.id) ? " stk-chip-on" : ""}" data-id="${x.id}" title="${escAttr(x.text)}">${escHtml(x.name || "без названия")}</span>`).join(""));
        }
        $box.find(".stk-guide-chip").on("click", function () {
            const id = this.dataset.id;
            if (picks.has(id)) picks.delete(id); else picks.add(id);
            $(this).toggleClass("stk-chip-on", picks.has(id));
            renderFills();
        });
        renderFills();
    }

    function neededPlaceholders() {
        const out = [];
        for (const x of library) {
            if (!picks.has(x.id)) continue;
            for (const p of placeholdersOf(x.text)) if (!out.includes(p)) out.push(p);
        }
        return out;
    }

    function renderFills() {
        const need = neededPlaceholders();
        const $f = $("#stk-guide-fills");
        $f.html(need.map((p) => `<label class="stk-guide-fill"><span>${escHtml(p)}</span>`
            + `<input type="text" class="text_pole" data-ph="${escAttr(p)}" value="${escAttr(fills[p] || "")}" placeholder="кого подставить"></label>`).join(""));
        $f.find("input").on("input", function () { fills[this.dataset.ph] = this.value; });
    }

    // ── применение ──

    function collect() {
        const need = neededPlaceholders();
        const empty = need.filter((p) => !(fills[p] || "").trim());
        if (empty.length) {
            toastr.warning(`Guide: впишите, кого подставить вместо ${empty.join(", ")}`);
            return null;
        }
        const text = composeGuide([...picks], ta.value, fills);
        if (!text) {
            toastr.warning("Guide: выберите гайд или впишите своё указание");
            return null;
        }
        const selMode = modal.querySelector('input[name="stk-guide-mode"]:checked')?.value || "auto";
        S().defaultMode = selMode;
        saveSettings();
        const usedFills = Object.fromEntries(need.map((p) => [p, fills[p]]));
        return { text, mode: selMode, state: { picks: [...picks], free: ta.value, fills: usedFills } };
    }

    document.getElementById("stk-guide-apply").addEventListener("click", () => {
        const r = collect();
        if (!r || !setGuide(r.text, r.mode, r.state)) return;
        toastr.success(r.mode === "auto"
            ? "Guide: активен до вашего следующего сообщения"
            : "Guide: активен, пока не снимете вручную");
        overlay.remove();
    });

    document.getElementById("stk-guide-rewrite").addEventListener("click", async () => {
        const r = collect();
        if (!r) return;
        const ctx = getContext();
        const last = ctx.chat?.[ctx.chat.length - 1];
        if (!last || last.is_user || last.is_system) {
            toastr.warning("Guide: последнее сообщение — не ответ персонажа, переписывать нечего");
            return;
        }
        if (!setGuide(r.text, r.mode, r.state)) return;
        overlay.remove();
        await rewriteLast();
    });

    document.getElementById("stk-guide-clear").addEventListener("click", () => {
        clearGuide();
        overlay.remove();
    });

    document.getElementById("stk-guide-close").addEventListener("click", () => overlay.remove());
    overlay.addEventListener("click", (e) => {
        if (e.target === overlay) overlay.remove();
    });

    // ── редактор набора ──

    const saveLib = debounce(() => saveLibrary(), 600);

    function renderLibrary() {
        const lib = library;
        const $list = $("#stk-guide-lib-list");
        $list.html(lib.map((x) => `
            <div class="stk-guide-lib-item" data-id="${x.id}">
                <div class="stk-guide-lib-head">
                    <input type="text" class="text_pole stk-lib-name" value="${escAttr(x.name)}" placeholder="название плашки">
                    <button class="menu_button stk-lib-del" title="Удалить гайд">🗑️</button>
                </div>
                <textarea class="text_pole stk-lib-text" rows="3" placeholder="текст гайда; [имя] спросится при применении">${escHtml(x.text)}</textarea>
            </div>`).join(""));
        $list.find(".stk-lib-name").on("input", function () {
            const item = byId(this.closest(".stk-guide-lib-item").dataset.id);
            if (!item) return;
            item.name = this.value;
            saveLib();
            renderChips();
        });
        $list.find(".stk-lib-text").on("input", function () {
            const item = byId(this.closest(".stk-guide-lib-item").dataset.id);
            if (!item) return;
            item.text = this.value;
            saveLib();
            renderChips();
        });
        $list.find(".stk-lib-del").on("click", async function () {
            const id = this.closest(".stk-guide-lib-item").dataset.id;
            const item = byId(id);
            if (!item || !(await confirmDelete(item))) return;
            library = library.filter((x) => x.id !== id);
            await saveLibrary();
            renderLibrary();
            renderChips();
        });
    }

    function byId(id) {
        return library.find((x) => x.id === id);
    }

    async function confirmDelete(item) {
        const P = getPopupClass();
        const q = `Удалить гайд «${escHtml(item.name || "без названия")}»?`;
        if (!P) return window.confirm(q);
        const popup = new P.Popup(q, P.POPUP_TYPE.CONFIRM, "", { okButton: "Удалить", cancelButton: "Отмена" });
        return !!(await popup.show());
    }

    document.getElementById("stk-guide-lib-add").addEventListener("click", () => {
        library.push({ id: newId(), name: "Новый гайд", text: "" });
        saveLibrary();
        renderLibrary();
        renderChips();
        $("#stk-guide-lib-list .stk-lib-name").last().trigger("focus").trigger("select");
    });

    document.getElementById("stk-guide-lib-import").addEventListener("click", () => renderImport());

    function renderImport() {
        const $box = $("#stk-guide-import");
        const qrs = listQuickReplies();
        if (!qrs.length) {
            $box.html('<div class="stk-guide-empty">Активных наборов квик-реплаев не нашлось.</div>');
            return;
        }
        const names = new Set(library.map((x) => x.name));
        $box.html(`<div class="stk-guide-empty">Только направляющие: ответ на гайд остаётся обычным ходом истории. Инструменты вроде «не продолжай нарратив» сюда не подходят — их ответ всё равно ляжет в чат.</div>`
            + qrs.map((q, i) => `<label class="stk-guide-import-row">
                <input type="checkbox" data-i="${i}" ${names.has(q.label) ? "disabled" : ""}>
                <span><b>${escHtml(q.label)}</b>${names.has(q.label) ? " <small>— уже в наборе</small>" : ""}<br><small>${escHtml(q.text.slice(0, 110))}${q.text.length > 110 ? "…" : ""}</small></span>
            </label>`).join("")
            + `<button id="stk-guide-import-go" class="menu_button">Импортировать выбранные</button>`);
        $("#stk-guide-import-go").on("click", () => {
            const chosen = $box.find("input:checked").map((_, el) => qrs[Number(el.dataset.i)]).get();
            if (!chosen.length) { toastr.info("Guide: ничего не выбрано"); return; }
            for (const q of chosen) library.push({ id: newId(), name: q.label, text: q.text });
            saveLibrary();
            toastr.success(`Guide: в набор добавлено ${chosen.length}`);
            $box.empty();
            renderLibrary();
            renderChips();
        });
    }

    renderChips();
    renderLibrary();
}

/** Квик-реплаи из активных наборов: глобальных и наборов текущего чата. Теги <OOS> снимаются. */
function listQuickReplies() {
    const api = globalThis.quickReplyApi;
    const cfgs = [api?.settings?.config, api?.settings?.chatConfig];
    const seen = new Set();
    const out = [];
    for (const cfg of cfgs) {
        for (const link of cfg?.setList || []) {
            const set = link?.set;
            if (!set || seen.has(set.name)) continue;
            seen.add(set.name);
            for (const qr of set.qrList || []) {
                const raw = String(qr.message || "");
                if (!raw.trim() || raw.trim().startsWith("/")) continue;   // слэш-команды — не текст
                const text = raw.replace(/<\/?OOS>/gi, "").trim();
                if (text) out.push({ label: qr.label || set.name, text });
            }
        }
    }
    return out;
}

/** Новый свайп последнего ответа. Таверна генерирует, только когда открыт последний свайп, — сначала туда. */
async function rewriteLast() {
    const ctx = getContext();
    const last = ctx.chat?.[ctx.chat.length - 1];
    if (!last) return;
    const lastSwipe = Math.max(0, (last.swipes?.length || 1) - 1);
    try {
        if ((last.swipe_id ?? 0) !== lastSwipe) {
            await ctx.swipe.to(null, "right", { forceSwipeId: lastSwipe });
        }
        await ctx.swipe.right();
    } catch (e) {
        console.error(`${TAG} rewrite failed`, e);
        toastr.error("Guide: не удалось запустить свайп — гайд взведён, свайпните вручную");
    }
}

/** escHtml не трогает кавычки (textContent → innerHTML), а значения стоят в атрибутах. */
function escAttr(s) {
    return escHtml(s).replace(/"/g, "&quot;");
}

function debounce(fn, ms) {
    let t = null;
    return (...args) => {
        clearTimeout(t);
        t = setTimeout(() => fn(...args), ms);
    };
}

// ── Init ──

export function initGuide() {
    S();

    addWandMenuItem(MENU_ITEM_ID, "fa-compass", "Guide", openGuidePopup);
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

    console.log(`${TAG} Guide module loaded`);
}
