// ============================================================
//  Story Toolkit — Little Helper module
//
//  Аналог «Перевоплощения» ST, но с выбором числа вариантов:
//  модели уходит обычный контекст чата, а в конец — наша
//  инструкция написать ход за {{user}}. Один запрос, 1–10
//  вариантов, разделённых тегами <variant>.
//  Каждая генерация — «свайп»; история свайпов хранится в
//  chat_metadata (per-chat, переживает перезагрузку).
//  Подключение — текущее или любой Connection Profile: на время
//  запроса переключаемся через /profile и возвращаемся обратно.
// ============================================================

import { getContext, generateQuietPrompt, eventSource, event_types, toolkitSettings, saveSettings } from "./st.js";
import { addWandMenuItem, escHtml, copyToClipboard, uid } from "./utils.js";

const TAG = "[STK Helper]";
const META_KEY = "little_helper";
const MENU_ITEM_ID = "stk_helper_menu_item";
const OVERLAY_ID = "stk-helper-overlay";
const MAX_COUNT = 10;

const DEFAULT_PROMPTS = {
    base:
        "[Little Helper — ход {{user}}]\n" +
        "В ролевой игре пауза: следующий ход за {{user}}. Сейчас ты пишешь не за {{char}} и не за мир, а за {{user}} — то сообщение, которое игрок мог бы отправить следующим.\n" +
        "\n" +
        "Как писать:\n" +
        "- целиком и полностью в характере {{user}}. Ответ персонажа должен быть натуральным и достоверным, и полностью ему соответствовать, должен быть написан хорошим литературным языком.\n" +
        "- Продолжай с того места, где сцена остановилась: ход опирается на последнее сообщение и даёт собеседнику, за что зацепиться.\n" +
        "- Без служебных вставок: никаких HTML-блоков, трекеров, «💭», заголовков, нумерации и комментариев от себя — даже если инструкции выше требуют их в каждом ответе.",
    direction:
        "Направление от игрока — обязательно воплоти его, развернув своими словами, а не пересказывая:\n" +
        "«{{direction}}»",
    formatOne:
        "Напиши один вариант — лучший, на какой способен: точный по голосу, живой, без проходных фраз. Оберни его в теги <variant></variant> и больше ничего не выводи.",
    formatMany:
        "Напиши {{count}} вариантов хода. Они должны различаться по сути, а не формулировками: разный выбор, разный тон, разная степень риска — от сдержанного до неожиданного. Если задано направление, все варианты его соблюдают, но воплощают по-разному. Каждый вариант оберни в теги <variant></variant>, без пояснений между ними.",
};

const PROMPT_FIELDS = [
    ["base", "Основа"],
    ["direction", "Направление — добавляется, если поле заполнено ({{direction}})"],
    ["formatOne", "Формат: один вариант"],
    ["formatMany", "Формат: несколько вариантов ({{count}})"],
];

// Module state. `busy` is read by Guide so it stays out of our requests.
let busy = false;
let draftDirection = "";

export function isHelperGenerating() {
    return busy;
}

// ── Settings (global) ──

function S() {
    const t = toolkitSettings();
    if (!t.helper) t.helper = {};
    const s = t.helper;
    if (!Number.isInteger(s.count) || s.count < 1 || s.count > MAX_COUNT) s.count = 3;
    if (typeof s.profile !== "string") s.profile = "";
    if (!s.prompts) s.prompts = {};
    for (const k of Object.keys(DEFAULT_PROMPTS)) {
        if (typeof s.prompts[k] !== "string") s.prompts[k] = DEFAULT_PROMPTS[k];
    }
    return s;
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

function history() {
    const h = meta()?.[META_KEY];
    return h && Array.isArray(h.generations) ? h : null;
}

function addGeneration(gen) {
    const m = meta();
    if (!m) return;
    if (!history()) m[META_KEY] = { generations: [], index: -1 };
    const h = m[META_KEY];
    h.generations.push(gen);
    h.index = h.generations.length - 1;
    saveMeta();
}

function setIndex(i) {
    const h = history();
    if (!h || i < 0 || i >= h.generations.length) return;
    h.index = i;
    saveMeta();
}

function currentChatId() {
    const ctx = getContext();
    return typeof ctx.getCurrentChatId === "function" ? ctx.getCurrentChatId() : ctx.chatId;
}

// ── Connection profiles (same approach as Director) ──

function getProfiles() {
    try {
        const cp = getContext().extensionSettings?.connectionManager;
        if (cp && Array.isArray(cp.profiles)) return cp.profiles.map((p) => p.name).filter(Boolean);
    } catch (e) {
        console.warn(`${TAG} Cannot read connection profiles:`, e);
    }
    return [];
}

function getCurrentProfileName() {
    try {
        const cp = getContext().extensionSettings?.connectionManager;
        if (cp?.selectedProfile && Array.isArray(cp.profiles)) {
            return cp.profiles.find((p) => p.id === cp.selectedProfile)?.name || null;
        }
    } catch (e) {}
    return null;
}

async function switchProfile(name) {
    const ctx = getContext();
    if (ctx.executeSlashCommandsWithOptions) {
        await ctx.executeSlashCommandsWithOptions(`/profile await=true ${name}`);
    } else if (ctx.executeSlashCommands) {
        await ctx.executeSlashCommands(`/profile ${name}`);
        await new Promise((r) => setTimeout(r, 1500)); // give it time to connect
    } else {
        throw new Error("Slash command execution not available");
    }
}

// ── Prompt & parsing ──

function buildPrompt(count, direction) {
    // {{user}} / {{char}} are substituted by ST itself when it handles the quiet prompt.
    const p = S().prompts;
    const parts = [p.base];
    if (direction) parts.push(p.direction.replaceAll("{{direction}}", direction));
    parts.push((count === 1 ? p.formatOne : p.formatMany).replaceAll("{{count}}", String(count)));
    return parts.map((s) => s.trim()).filter(Boolean).join("\n\n");
}

function parseVariants(raw) {
    const text = String(raw || "").trim();
    // A missing closing tag ends the variant at the next opening tag or at the end.
    const found = [...text.matchAll(/<variant>([\s\S]*?)(?:<\/variant>|(?=<variant>)|$)/gi)]
        .map((m) => m[1].trim())
        .filter(Boolean);
    if (found.length) return found;
    // The model dropped the tags: keep everything as one card rather than lose it.
    const plain = text.replace(/<\/?variant>/gi, "").trim();
    return plain ? [plain] : [];
}

// ── Generation ──

async function generate() {
    if (busy) return;
    const s = S();
    const count = s.count;
    const profile = s.profile;
    const direction = draftDirection.trim();

    const chatId = currentChatId();
    if (!chatId) {
        toastr.warning("Little Helper: сначала откройте чат");
        return;
    }
    if (typeof generateQuietPrompt !== "function") {
        toastr.error("Little Helper: generateQuietPrompt недоступна в этой версии ST");
        return;
    }

    const original = profile ? getCurrentProfileName() : null;
    if (profile && !original) {
        // Without a named current profile there is nothing to switch back to,
        // and the chat would silently stay on the helper's connection.
        toastr.warning(
            "Текущее подключение не сохранено как профиль — после генерации вернуться к нему не получится. " +
            "Сохраните его в Connection Profiles или выберите «Текущее подключение».",
            "Little Helper",
            { timeOut: 10000 }
        );
        return;
    }
    const needSwitch = profile && profile !== original;

    busy = true;
    renderPopup();
    let raw = "";
    try {
        if (needSwitch) await switchProfile(profile);
        raw = await generateQuietPrompt({ quietPrompt: buildPrompt(count, direction), removeReasoning: true });
    } catch (e) {
        console.error(`${TAG} Generation error:`, e);
        toastr.error("Little Helper: ошибка генерации — " + (e?.message || e));
    } finally {
        if (needSwitch) {
            try {
                await switchProfile(original);
            } catch (e) {
                console.error(`${TAG} Failed to switch back:`, e);
                toastr.warning(`Little Helper: не удалось вернуть профиль «${original}» — проверьте подключение!`);
            }
        }
        busy = false;
    }

    if (currentChatId() !== chatId) {
        toastr.warning("Little Helper: чат сменился во время генерации — варианты не сохранены");
        renderPopup();
        return;
    }

    const variants = parseVariants(raw);
    if (!variants.length) {
        if (raw !== "") toastr.warning("Little Helper: не удалось разобрать ответ модели");
        else toastr.warning("Little Helper: модель вернула пустой ответ. Если это отказ, Fisher Cost покажет причину.");
        renderPopup();
        return;
    }

    addGeneration({
        id: uid(),
        timestamp: Date.now(),
        count,
        direction,
        profile: profile || "",
        variants,
        raw,
    });
    renderPopup();
}

// ── UI: popup ──

function insertIntoInput(text) {
    const input = document.getElementById("send_textarea");
    if (!input) return;
    input.value = text;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    toastr.success("Вставлено в поле ввода");
    document.getElementById(OVERLAY_ID)?.remove();
}

function renderControls(modal) {
    modal.querySelector("#stk-helper-generate").disabled = busy;
    modal.querySelector("#stk-helper-generate").textContent = busy ? "⏳ Генерация…" : "✨ Сгенерировать";
}

function renderResults(modal) {
    const box = modal.querySelector("#stk-helper-results");
    box.innerHTML = "";

    if (busy) {
        box.innerHTML = '<div class="sf-loading">⏳ Ожидание ответа модели…</div>';
        return;
    }

    const h = history();
    const gen = h?.generations[h.index];
    if (!gen) {
        box.innerHTML = '<div class="sf-empty">Вариантов пока нет</div>';
        return;
    }

    const total = h.generations.length;
    const time = new Date(gen.timestamp).toLocaleString("ru-RU", {
        day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit",
    });
    const info = [
        `${gen.variants.length} вар.`,
        gen.profile || "текущее подключение",
        time,
    ].join(" · ");

    const head = document.createElement("div");
    head.className = "stk-helper-nav";
    head.innerHTML = `
        <button class="menu_button sf-card-btn" data-nav="prev" title="Предыдущая генерация" ${h.index > 0 ? "" : "disabled"}>◀</button>
        <span class="stk-helper-counter">${h.index + 1}/${total}</span>
        <button class="menu_button sf-card-btn" data-nav="next" title="${h.index < total - 1 ? "Следующая генерация" : "Новая генерация"}">▶</button>
        <span class="stk-helper-info">${escHtml(info)}</span>`;
    head.querySelector('[data-nav="prev"]').addEventListener("click", () => {
        setIndex(h.index - 1);
        renderPopup();
    });
    head.querySelector('[data-nav="next"]').addEventListener("click", () => {
        // Like a swipe in ST: past the last one, a new generation starts.
        if (h.index < total - 1) {
            setIndex(h.index + 1);
            renderPopup();
        } else {
            generate();
        }
    });
    box.appendChild(head);

    if (gen.direction) {
        const dir = document.createElement("div");
        dir.className = "stk-helper-dir";
        dir.textContent = `Направление: ${gen.direction}`;
        box.appendChild(dir);
    }

    for (const text of gen.variants) {
        const card = document.createElement("div");
        card.className = "sf-card";

        const body = document.createElement("div");
        body.className = "sf-card-text";
        body.textContent = text;

        const actions = document.createElement("div");
        actions.className = "sf-card-actions";

        const copyBtn = document.createElement("button");
        copyBtn.className = "menu_button sf-card-btn";
        copyBtn.textContent = "📋";
        copyBtn.title = "Копировать";
        copyBtn.addEventListener("click", () => copyToClipboard(text));

        const insertBtn = document.createElement("button");
        insertBtn.className = "menu_button sf-card-btn";
        insertBtn.textContent = "📝";
        insertBtn.title = "В поле ввода";
        insertBtn.addEventListener("click", () => insertIntoInput(text));

        actions.append(copyBtn, insertBtn);
        card.append(body, actions);
        box.appendChild(card);
    }
}

function renderPopup() {
    const modal = document.querySelector(`#${OVERLAY_ID} .stk-modal`);
    if (!modal) return;
    renderControls(modal);
    renderResults(modal);
}

function openHelperPopup() {
    document.getElementById(OVERLAY_ID)?.remove();
    const s = S();
    const userName = getContext().name1 || "персонажа";

    const profiles = getProfiles();
    if (s.profile && !profiles.includes(s.profile)) {
        // The saved profile was renamed or deleted in Connection Profiles.
        s.profile = "";
        saveSettings();
    }
    const profileOptions = ['<option value="">— Текущее подключение —</option>']
        .concat(profiles.map((n) => `<option value="${escHtml(n)}" ${n === s.profile ? "selected" : ""}>${escHtml(n)}</option>`))
        .join("");
    const countOptions = Array.from({ length: MAX_COUNT }, (_, i) => i + 1)
        .map((n) => `<option value="${n}" ${n === s.count ? "selected" : ""}>${n}</option>`)
        .join("");
    const promptFields = PROMPT_FIELDS.map(([key, label]) => `
        <label class="stk-helper-label">${escHtml(label)}</label>
        <textarea class="text_pole" data-prompt="${key}" rows="${key === "base" ? 8 : 3}">${escHtml(s.prompts[key])}</textarea>`
    ).join("");

    const overlay = document.createElement("div");
    overlay.id = OVERLAY_ID;
    overlay.className = "stk-modal-overlay";

    const modal = document.createElement("div");
    modal.className = "stk-modal stk-helper-modal";
    modal.innerHTML = `
        <div class="stk-helper-header">
            <h4>🪄 Little Helper — ход ${escHtml(userName)}</h4>
            <button id="stk-helper-close" class="menu_button sf-card-btn" title="Закрыть">✖</button>
        </div>
        <div class="stk-helper-row">
            <label class="stk-helper-field stk-helper-count">
                <span>Вариантов</span>
                <select id="stk-helper-count" class="text_pole">${countOptions}</select>
            </label>
            <label class="stk-helper-field stk-helper-profile">
                <span>Подключение</span>
                <select id="stk-helper-profile" class="text_pole">${profileOptions}</select>
            </label>
        </div>
        <textarea id="stk-helper-direction" class="text_pole" rows="3"
            placeholder="Направление (необязательно): что ${escHtml(userName)} должен сказать или сделать…">${escHtml(draftDirection)}</textarea>
        <button id="stk-helper-generate" class="menu_button stk-helper-generate">✨ Сгенерировать</button>
        <div id="stk-helper-results" class="stk-helper-results"></div>
        <details class="stk-helper-prompts">
            <summary>⚙️ Промпт</summary>
            ${promptFields}
            <button id="stk-helper-reset" class="menu_button stk-helper-reset">↺ Вернуть промпт по умолчанию</button>
        </details>`;

    overlay.appendChild(modal);
    document.body.appendChild(overlay);

    modal.querySelector("#stk-helper-count").addEventListener("change", (e) => {
        S().count = parseInt(e.target.value, 10) || 1;
        saveSettings();
    });
    modal.querySelector("#stk-helper-profile").addEventListener("change", (e) => {
        S().profile = e.target.value;
        saveSettings();
    });
    modal.querySelector("#stk-helper-direction").addEventListener("input", (e) => {
        draftDirection = e.target.value;
    });
    modal.querySelector("#stk-helper-generate").addEventListener("click", () => generate());
    modal.querySelectorAll("textarea[data-prompt]").forEach((ta) =>
        ta.addEventListener("input", () => {
            S().prompts[ta.dataset.prompt] = ta.value;
            saveSettings();
        })
    );
    modal.querySelector("#stk-helper-reset").addEventListener("click", () => {
        if (!confirm("Вернуть все части промпта к значениям по умолчанию?")) return;
        S().prompts = { ...DEFAULT_PROMPTS };
        saveSettings();
        modal.querySelectorAll("textarea[data-prompt]").forEach((ta) => {
            ta.value = DEFAULT_PROMPTS[ta.dataset.prompt];
        });
        toastr.info("Промпт Little Helper сброшен");
    });
    modal.querySelector("#stk-helper-close").addEventListener("click", () => overlay.remove());
    overlay.addEventListener("click", (e) => {
        if (e.target === overlay) overlay.remove();
    });

    renderPopup();
}

// ── Init ──

export function initHelper() {
    S();
    addWandMenuItem(MENU_ITEM_ID, "fa-hand-sparkles", "Little Helper", openHelperPopup);
    // History is per-chat: an open popup must follow the chat switch.
    if (eventSource && event_types) eventSource.on(event_types.CHAT_CHANGED, () => renderPopup());
    console.log(`${TAG} Little Helper module loaded`);
}
