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

import { getContext, eventSource, event_types, toolkitSettings, saveSettings } from "./st.js";
import { addWandMenuItem, escHtml } from "./utils.js";

const TAG = "[STK Guide]";
const META_KEY = "story_guide";
const MENU_ITEM_ID = "stk_guide_menu_item";

// ── Settings (global defaults) ──

function S() {
    const t = toolkitSettings();
    if (!t.guide) t.guide = { defaultMode: "auto" };
    return t.guide;
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

function setGuide(text, mode) {
    const m = meta();
    if (!m) {
        toastr.error("Guide: chat_metadata недоступна");
        return false;
    }
    m[META_KEY] = { text, mode, createdAt: Date.now() };
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
        const g = getGuide();
        if (!g) return;
        const chat = data.chat;
        if (!Array.isArray(chat)) return;
        // Depth 1: right before the last message → below the cache breakpoint
        const insertAt = Math.max(0, chat.length - 1);
        chat.splice(insertAt, 0, { role: "system", content: g.text });
        console.log(`${TAG} ✓ Injected at depth 1 (${insertAt}/${chat.length})`);
    } catch (e) {
        console.error(`${TAG} onPromptReady error:`, e);
    }
}

// ── Lifecycle ──

function onMessageSent() {
    const g = getGuide();
    if (g && g.mode === "auto") {
        clearGuide(true);
        toastr.info("Guide: указание отработало и снято");
    }
}

function onChatChanged() {
    // Guide is per-chat: just refresh the indicator for the new chat
    updateIndicator();
}

// ── UI: wand menu indicator ──

function updateIndicator() {
    const $item = $(`#${MENU_ITEM_ID}`);
    if (!$item.length) return;
    const g = getGuide();
    $item.toggleClass("stk-guide-active", !!g);
    const label = g
        ? (g.mode === "manual" ? "Guide ● (ручной)" : "Guide ●")
        : "Guide";
    $item.find("span").text(label);
}

// ── UI: popup ──

function openGuidePopup() {
    document.getElementById("stk-guide-overlay")?.remove();

    const g = getGuide();
    const mode = g?.mode || S().defaultMode || "auto";

    const overlay = document.createElement("div");
    overlay.id = "stk-guide-overlay";
    overlay.className = "stk-modal-overlay";

    const modal = document.createElement("div");
    modal.className = "stk-modal";
    modal.innerHTML = `
        <h4>🧭 Guide — направить следующий ответ</h4>
        <textarea id="stk-guide-text" class="text_pole" rows="6"
            placeholder="Указание для модели. Вставляется на depth 1, как авторская заметка. Действует на генерацию, свайпы и регенерации.">${g ? escHtml(g.text) : ""}</textarea>
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
            <button id="stk-guide-apply" class="menu_button">💾 Применить</button>
            <button id="stk-guide-clear" class="menu_button" ${g ? "" : "disabled"}>🗑️ Снять</button>
            <button id="stk-guide-close" class="menu_button">✖ Закрыть</button>
        </div>`;

    overlay.appendChild(modal);
    document.body.appendChild(overlay);

    const ta = document.getElementById("stk-guide-text");
    ta.focus();
    ta.selectionStart = ta.selectionEnd = ta.value.length;

    document.getElementById("stk-guide-apply").addEventListener("click", () => {
        const text = ta.value.trim();
        if (!text) {
            toastr.warning("Guide: текст пуст — нечего применять");
            return;
        }
        const selMode =
            modal.querySelector('input[name="stk-guide-mode"]:checked')?.value || "auto";
        S().defaultMode = selMode;
        saveSettings();
        if (setOk(text, selMode)) {
            toastr.success(
                selMode === "auto"
                    ? "Guide: активен до вашего следующего сообщения"
                    : "Guide: активен, пока не снимете вручную"
            );
            overlay.remove();
        }
    });

    function setOk(text, m) {
        return setGuide(text, m);
    }

    document.getElementById("stk-guide-clear").addEventListener("click", () => {
        clearGuide();
        overlay.remove();
    });

    document.getElementById("stk-guide-close").addEventListener("click", () => overlay.remove());
    overlay.addEventListener("click", (e) => {
        if (e.target === overlay) overlay.remove();
    });
}

// ── Init ──

export function initGuide() {
    S();

    addWandMenuItem(MENU_ITEM_ID, "fa-compass", "Guide", openGuidePopup);
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
