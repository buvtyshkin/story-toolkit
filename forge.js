// ============================================================
//  Story Toolkit — Forge module (ex Story Forge)
// ============================================================

import { getContext, toolkitSettings, saveSettings } from "./st.js";
import { uid as sharedUid, escHtml as sharedEsc, copyToClipboard } from "./utils.js";

const EXT = "story-toolkit/forge";

// ═══════════════════════════════════════════
//  Defaults
// ═══════════════════════════════════════════

const DEFAULT_BUTTONS = [
    {
        id: "btn_event",
        name: "Event",
        emoji: "🎲",
        prompt:
            "<OOS>Не продолжай нарратив. Предложи [COUNT] вариантов возможных событий, пронумерованных списком.\n" +
            "Каждый вариант — 1–2 предложения.\n" +
            "Учитывай текущих персонажей, локацию, время и незакрытые сюжетные линии.\n" +
            "Варьируй масштаб: от мелких бытовых до крупных сюжетных.</OOS>",
    },
    {
        id: "btn_react",
        name: "React",
        emoji: "💬",
        prompt:
            "<OOS>Не продолжай нарратив. Предложи [COUNT] вариантов возможных реакций или действий NPC в текущей ситуации, пронумерованных списком.\n" +
            "Каждый вариант — 1–2 предложения.\n" +
            "Учитывай характеры, мотивации и текущее эмоциональное состояние персонажей.</OOS>",
    },
];

const DEFAULT_SETTINGS = {
    buttons: DEFAULT_BUTTONS,
    archive: [],
    variantCount: 10,
    maxGenerations: 20,
};

// In-memory only — cleared on page reload / chat switch
let sessionGenerations = [];
let sessionGenIndex = -1;

// ═══════════════════════════════════════════
//  Helpers
// ═══════════════════════════════════════════

const uid = sharedUid;
const escHtml = sharedEsc;
const toClipboard = copyToClipboard;

// ═══════════════════════════════════════════
//  Settings
// ═══════════════════════════════════════════

function S() {
    const t = toolkitSettings();
    if (!t.forge) t.forge = structuredClone(DEFAULT_SETTINGS);
    return t.forge;
}

function loadSettings() {
    const s = S();
    if (!Array.isArray(s.buttons)) s.buttons = structuredClone(DEFAULT_BUTTONS);
    if (!Array.isArray(s.archive)) s.archive = [];
    if (!s.variantCount) s.variantCount = 10;
    if (!s.maxGenerations) s.maxGenerations = 20;
    // Clean up legacy generations from settings (moved to in-memory)
    delete s.generations;
    delete s.currentGenIndex;
}

const save = saveSettings;

// ═══════════════════════════════════════════
//  API — quiet generation
// ═══════════════════════════════════════════

async function generate(promptText) {
    const ctx = getContext();
    if (typeof ctx.generateQuietPrompt !== "function") {
        toastr.error("generateQuietPrompt недоступна в этой версии ST");
        return null;
    }
    try {
        // Mode 1 = USER — prompt injected as user message (like QR),
        // not as system message (mode 0, default).
        // This preserves the same quality/style as sending via chat.
        const QUIET_PROMPT_USER = 1;
        const response = await ctx.generateQuietPrompt(promptText, QUIET_PROMPT_USER);
        return response;
    } catch (err) {
        console.error(`[${EXT}] Generation error:`, err);
        toastr.error("Ошибка генерации: " + (err.message || err));
        return null;
    }
}

// ═══════════════════════════════════════════
//  Response parsing
// ═══════════════════════════════════════════

function cleanResponse(text) {
    return text
        .replace(/<\/?OOS>/gi, "")
        .replace(/<\/?OOC>/gi, "")
        .replace(/\(\(OOC:.*?\)\)/gi, "")
        .trim();
}

function parseVariants(rawText) {
    const text = cleanResponse(rawText);
    const lines = text.split("\n");
    const variants = [];
    let current = null;

    for (const line of lines) {
        const m = line.match(/^\s*(\d+)\.\s+(.*)/);
        if (m) {
            if (current) variants.push(current);
            current = { number: parseInt(m[1], 10), text: m[2].trim() };
        } else if (current) {
            const trimmed = line.trim();
            // Category headers (all-caps lines) — attach as prefix
            if (trimmed && !/^[A-ZА-ЯЁ\s:]+:?\s*$/.test(trimmed)) {
                current.text += " " + trimmed;
            }
        }
    }
    if (current) variants.push(current);

    // Fallback: whole text as one card
    if (variants.length === 0 && text) {
        variants.push({ number: 1, text });
    }
    return variants;
}

// ═══════════════════════════════════════════
//  Generations storage
// ═══════════════════════════════════════════

function addGeneration(buttonName, extra, variants, raw) {
    const gen = {
        id: uid(),
        buttonName,
        extra: extra || "",
        variants,
        raw,
        timestamp: Date.now(),
    };
    sessionGenerations.push(gen);
    // Trim old generations
    const max = S().maxGenerations || 20;
    while (sessionGenerations.length > max) {
        sessionGenerations.shift();
    }
    sessionGenIndex = sessionGenerations.length - 1;
    return gen;
}

function currentGen() {
    if (sessionGenIndex >= 0 && sessionGenIndex < sessionGenerations.length) {
        return sessionGenerations[sessionGenIndex];
    }
    return null;
}

// ═══════════════════════════════════════════
//  Archive
// ═══════════════════════════════════════════

function archiveVariant(text, source) {
    S().archive.push({
        id: uid(),
        text,
        source: source || "",
        timestamp: Date.now(),
    });
    save();
}

function removeFromArchive(id) {
    const a = S().archive;
    const i = a.findIndex((x) => x.id === id);
    if (i !== -1) a.splice(i, 1);
    save();
}

function clearArchive() {
    S().archive = [];
    save();
}

// ═══════════════════════════════════════════
//  UI — main scaffold
// ═══════════════════════════════════════════

function createUI() {
    const html = `
    <div class="story-forge-settings">
        <div class="inline-drawer">
            <div class="inline-drawer-toggle inline-drawer-header">
                <b>🔥 Story Forge</b>
                <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
            </div>
            <div class="inline-drawer-content">

                <!-- Buttons -->
                <div class="sf-section">
                    <div id="sf-buttons-grid" class="sf-buttons-grid"></div>
                    <textarea id="sf-extra" class="text_pole sf-extra" rows="2"
                        placeholder="Уточнение (необязательно)..."></textarea>
                </div>

                <hr class="sf-hr">

                <!-- Results -->
                <div id="sf-results-section" class="sf-section" style="display:none">
                    <div class="sf-results-header">
                        <span id="sf-results-title" class="sf-results-title"></span>
                        <div class="sf-results-nav">
                            <button id="sf-prev" class="menu_button sf-nav-btn">◀</button>
                            <span id="sf-gen-counter" class="sf-gen-counter"></span>
                            <button id="sf-next" class="menu_button sf-nav-btn">▶</button>
                        </div>
                    </div>
                    <div id="sf-results-list" class="sf-results-list"></div>
                </div>

                <hr class="sf-hr">

                <!-- Archive -->
                <div class="sf-section">
                    <h4>📦 Архив <span id="sf-archive-count" class="sf-muted"></span></h4>
                    <div id="sf-archive-list" class="sf-archive-list"></div>
                    <button id="sf-clear-archive" class="menu_button sf-clear-btn"
                        style="display:none">🗑️ Очистить архив</button>
                </div>

                <hr class="sf-hr">

                <!-- Settings -->
                <div class="sf-section">
                    <h4>⚙️ Настройки</h4>
                    <label>Вариантов по умолчанию:</label>
                    <input type="number" id="sf-variant-count" class="text_pole"
                        min="1" max="50" value="10">
                    <button id="sf-manage-buttons" class="menu_button"
                        style="margin-top:8px;width:100%">🔧 Управление кнопками</button>
                </div>

            </div>
        </div>
    </div>`;

    document.getElementById("extensions_settings2")
        .insertAdjacentHTML("beforeend", html);
}

// ═══════════════════════════════════════════
//  Rendering — buttons
// ═══════════════════════════════════════════

function renderButtons() {
    const grid = document.getElementById("sf-buttons-grid");
    if (!grid) return;
    grid.innerHTML = "";

    for (const btn of S().buttons) {
        const el = document.createElement("button");
        el.className = "menu_button sf-action-btn";
        el.dataset.id = btn.id;
        el.textContent = `${btn.emoji} ${btn.name}`;
        el.addEventListener("click", () => onButtonClick(btn));
        grid.appendChild(el);
    }
}

// ═══════════════════════════════════════════
//  Rendering — results
// ═══════════════════════════════════════════

function renderResults() {
    const section = document.getElementById("sf-results-section");
    const list = document.getElementById("sf-results-list");
    const title = document.getElementById("sf-results-title");
    const counter = document.getElementById("sf-gen-counter");

    const gen = currentGen();
    if (!gen) {
        section.style.display = "none";
        return;
    }

    section.style.display = "block";

    const time = new Date(gen.timestamp).toLocaleTimeString("ru-RU", {
        hour: "2-digit",
        minute: "2-digit",
    });
    title.textContent = `${gen.buttonName} · ${time}`;

    const total = sessionGenerations.length;
    const idx = sessionGenIndex + 1;
    counter.textContent = `${idx}/${total}`;

    list.innerHTML = "";

    for (const v of gen.variants) {
        const card = document.createElement("div");
        card.className = "sf-card";

        const body = document.createElement("div");
        body.className = "sf-card-text";
        body.textContent = v.text;

        const actions = document.createElement("div");
        actions.className = "sf-card-actions";

        const copyBtn = document.createElement("button");
        copyBtn.className = "menu_button sf-card-btn";
        copyBtn.textContent = "📋";
        copyBtn.title = "Копировать";
        copyBtn.addEventListener("click", () => toClipboard(v.text));

        const saveBtn = document.createElement("button");
        saveBtn.className = "menu_button sf-card-btn";
        saveBtn.textContent = "💾";
        saveBtn.title = "В архив";
        saveBtn.addEventListener("click", () => {
            archiveVariant(v.text, gen.buttonName);
            renderArchive();
            toastr.success("Сохранено в архив");
        });

        const insertBtn = document.createElement("button");
        insertBtn.className = "menu_button sf-card-btn";
        insertBtn.textContent = "📝";
        insertBtn.title = "В поле ввода";
        insertBtn.addEventListener("click", () => {
            const input = document.getElementById("send_textarea");
            if (input) {
                input.value = v.text;
                input.dispatchEvent(new Event("input", { bubbles: true }));
                toastr.success("Вставлено в поле ввода");
            }
        });

        actions.appendChild(copyBtn);
        actions.appendChild(saveBtn);
        actions.appendChild(insertBtn);

        card.appendChild(body);
        card.appendChild(actions);
        list.appendChild(card);
    }
}

// ═══════════════════════════════════════════
//  Rendering — archive
// ═══════════════════════════════════════════

function renderArchive() {
    const list = document.getElementById("sf-archive-list");
    const clearBtn = document.getElementById("sf-clear-archive");
    const countEl = document.getElementById("sf-archive-count");
    const archive = S().archive;

    countEl.textContent = archive.length > 0 ? `(${archive.length})` : "";
    clearBtn.style.display = archive.length > 0 ? "block" : "none";

    if (archive.length === 0) {
        list.innerHTML = '<div class="sf-empty">Пусто</div>';
        return;
    }

    list.innerHTML = "";

    // Newest first
    const sorted = [...archive].reverse();

    for (const item of sorted) {
        const el = document.createElement("div");
        el.className = "sf-archive-item";

        const text = document.createElement("div");
        text.className = "sf-archive-text";
        text.textContent = item.text;

        const meta = document.createElement("div");
        meta.className = "sf-archive-meta";
        const date = new Date(item.timestamp).toLocaleDateString("ru-RU");
        meta.textContent = [item.source, date].filter(Boolean).join(" · ");

        const actions = document.createElement("div");
        actions.className = "sf-card-actions";

        const copyBtn = document.createElement("button");
        copyBtn.className = "menu_button sf-card-btn";
        copyBtn.textContent = "📋";
        copyBtn.title = "Копировать";
        copyBtn.addEventListener("click", () => toClipboard(item.text));

        const delBtn = document.createElement("button");
        delBtn.className = "menu_button sf-card-btn";
        delBtn.textContent = "🗑️";
        delBtn.title = "Удалить";
        delBtn.addEventListener("click", () => {
            removeFromArchive(item.id);
            renderArchive();
            toastr.info("Удалено из архива");
        });

        actions.appendChild(copyBtn);
        actions.appendChild(delBtn);

        el.appendChild(text);
        el.appendChild(meta);
        el.appendChild(actions);
        list.appendChild(el);
    }
}

// ═══════════════════════════════════════════
//  Button click → generate
// ═══════════════════════════════════════════

async function onButtonClick(btn) {
    const extra = document.getElementById("sf-extra")?.value?.trim() || "";
    const count = btn.count || S().variantCount || 10;

    // Build prompt
    let prompt = btn.prompt.replace(/\[COUNT\]/gi, String(count));
    if (extra) {
        prompt += "\n\nУточнение от игрока: " + extra;
    }

    // Show loading
    const section = document.getElementById("sf-results-section");
    const list = document.getElementById("sf-results-list");
    const title = document.getElementById("sf-results-title");
    section.style.display = "block";
    title.textContent = `${btn.emoji} ${btn.name} — генерация...`;
    list.innerHTML = '<div class="sf-loading">⏳ Ожидание ответа модели...</div>';

    // Disable buttons during generation
    document.querySelectorAll(".sf-action-btn").forEach((b) => (b.disabled = true));

    const raw = await generate(prompt);

    document.querySelectorAll(".sf-action-btn").forEach((b) => (b.disabled = false));

    if (!raw) {
        list.innerHTML = '<div class="sf-empty">Не удалось получить ответ</div>';
        return;
    }

    const variants = parseVariants(raw);
    addGeneration(btn.name, extra, variants, raw);
    renderResults();

    // Clear extra field
    document.getElementById("sf-extra").value = "";
}

// ═══════════════════════════════════════════
//  Button manager modal
// ═══════════════════════════════════════════

function openButtonManager() {
    document.getElementById("sf-btn-modal")?.remove();

    const overlay = document.createElement("div");
    overlay.id = "sf-btn-modal";
    overlay.className = "sf-modal-overlay";

    const modal = document.createElement("div");
    modal.className = "sf-modal";

    function renderList() {
        const buttons = S().buttons;
        let listHtml = buttons
            .map(
                (b, i) => `
            <div class="sf-btn-row" data-idx="${i}">
                <span class="sf-btn-row-label">${escHtml(b.emoji)} ${escHtml(b.name)}</span>
                <div class="sf-btn-row-actions">
                    <button class="menu_button sf-card-btn sf-bm-edit" data-idx="${i}">✏️</button>
                    <button class="menu_button sf-card-btn sf-bm-del" data-idx="${i}">🗑️</button>
                </div>
            </div>`
            )
            .join("");

        modal.innerHTML = `
            <h4>🔧 Управление кнопками</h4>
            <div class="sf-btn-list">${listHtml || '<div class="sf-empty">Нет кнопок</div>'}</div>
            <button id="sf-bm-add" class="menu_button" style="width:100%;margin-top:8px">➕ Добавить</button>
            <button id="sf-bm-close" class="menu_button" style="width:100%;margin-top:4px">✖ Закрыть</button>
        `;

        // Bind
        modal.querySelectorAll(".sf-bm-edit").forEach((el) =>
            el.addEventListener("click", () => openButtonEditor(parseInt(el.dataset.idx)))
        );
        modal.querySelectorAll(".sf-bm-del").forEach((el) =>
            el.addEventListener("click", () => {
                const idx = parseInt(el.dataset.idx);
                const b = S().buttons[idx];
                if (b && confirm(`Удалить «${b.name}»?`)) {
                    S().buttons.splice(idx, 1);
                    save();
                    renderList();
                    renderButtons();
                }
            })
        );
        document.getElementById("sf-bm-add")?.addEventListener("click", () => openButtonEditor(-1));
        document.getElementById("sf-bm-close")?.addEventListener("click", () => overlay.remove());
    }

    function openButtonEditor(idx) {
        const isNew = idx < 0;
        const btn = isNew
            ? { id: uid(), name: "", emoji: "⚡", prompt: "", count: 0 }
            : { ...S().buttons[idx] };

        const globalCount = S().variantCount || 10;

        modal.innerHTML = `
            <h4>${isNew ? "➕ Новая кнопка" : "✏️ Редактирование"}</h4>
            <label>Эмоджи:</label>
            <input type="text" id="sf-be-emoji" class="text_pole" value="${escHtml(btn.emoji)}" maxlength="4">
            <label>Название:</label>
            <input type="text" id="sf-be-name" class="text_pole" value="${escHtml(btn.name)}">
            <label>Кол-во вариантов (0 = глобальное: ${globalCount}):</label>
            <input type="number" id="sf-be-count" class="text_pole" min="0" max="50" value="${btn.count || 0}">
            <label>Промпт ([COUNT] заменяется на число вариантов):</label>
            <textarea id="sf-be-prompt" class="text_pole" rows="8">${escHtml(btn.prompt)}</textarea>
            <div style="display:flex;gap:6px;margin-top:10px">
                <button id="sf-be-save" class="menu_button" style="flex:1">💾 Сохранить</button>
                <button id="sf-be-back" class="menu_button" style="flex:1">↩ Назад</button>
            </div>
        `;

        document.getElementById("sf-be-save").addEventListener("click", () => {
            const name = document.getElementById("sf-be-name").value.trim();
            const emoji = document.getElementById("sf-be-emoji").value.trim() || "⚡";
            const prompt = document.getElementById("sf-be-prompt").value.trim();
            const count = parseInt(document.getElementById("sf-be-count").value, 10) || 0;

            if (!name || !prompt) {
                toastr.warning("Название и промпт обязательны");
                return;
            }

            if (isNew) {
                S().buttons.push({ id: uid(), name, emoji, prompt, count });
            } else {
                S().buttons[idx] = { ...S().buttons[idx], name, emoji, prompt, count };
            }
            save();
            renderButtons();
            renderList();
            toastr.success(isNew ? "Кнопка добавлена" : "Кнопка обновлена");
        });

        document.getElementById("sf-be-back").addEventListener("click", renderList);
    }

    overlay.appendChild(modal);
    document.body.appendChild(overlay);
    overlay.addEventListener("click", (e) => {
        if (e.target === overlay) overlay.remove();
    });

    renderList();
}

// ═══════════════════════════════════════════
//  Event binding
// ═══════════════════════════════════════════

function bindEvents() {
    // Navigation ◀ ▶
    document.getElementById("sf-prev")?.addEventListener("click", () => {
        if (sessionGenIndex > 0) {
            sessionGenIndex--;
            renderResults();
        }
    });

    document.getElementById("sf-next")?.addEventListener("click", () => {
        if (sessionGenIndex < sessionGenerations.length - 1) {
            sessionGenIndex++;
            renderResults();
        }
    });

    // Settings — variant count
    document.getElementById("sf-variant-count")?.addEventListener("change", (e) => {
        const val = parseInt(e.target.value, 10);
        if (val > 0 && val <= 50) {
            S().variantCount = val;
            save();
        }
    });

    // Button manager
    document.getElementById("sf-manage-buttons")?.addEventListener("click", openButtonManager);

    // Clear archive
    document.getElementById("sf-clear-archive")?.addEventListener("click", () => {
        if (confirm("Очистить весь архив?")) {
            clearArchive();
            renderArchive();
            toastr.info("Архив очищен");
        }
    });
}

// ═══════════════════════════════════════════
//  Init
// ═══════════════════════════════════════════

export function initForge() {
    loadSettings();
    createUI();
    addExtensionsMenuItem();

    // Restore saved variant count in input
    const vcInput = document.getElementById("sf-variant-count");
    if (vcInput) vcInput.value = S().variantCount;

    renderButtons();
    renderResults();
    renderArchive();
    bindEvents();

    console.log(`[${EXT}] Forge module loaded`);
}

// ═══════════════════════════════════════════
//  Extensions menu (wand icon) shortcut
// ═══════════════════════════════════════════

function addExtensionsMenuItem() {
    const $item = $(
        `<div id="sf_menu_item" class="list-group-item flex-container flexGap5">` +
        `<div class="fa-solid fa-fire extensionsMenuExtensionButton"></div>` +
        `Story Forge</div>`
    );

    $item.on("click", () => openForgePopup());
    $("#extensionsMenu").append($item);
}

// ═══════════════════════════════════════════
//  Popup (opened from extensions menu)
// ═══════════════════════════════════════════

function openForgePopup() {
    document.getElementById("sf-popup-overlay")?.remove();

    const overlay = document.createElement("div");
    overlay.id = "sf-popup-overlay";
    overlay.className = "sf-modal-overlay";

    const popup = document.createElement("div");
    popup.className = "sf-modal sf-popup";

    // ── Header ──
    const header = document.createElement("div");
    header.className = "sf-popup-header";
    header.innerHTML = `<h4>🔥 Story Forge</h4>
        <button id="sf-popup-close" class="menu_button sf-card-btn">✖</button>`;

    // ── Buttons grid ──
    const grid = document.createElement("div");
    grid.className = "sf-buttons-grid";
    for (const btn of S().buttons) {
        const el = document.createElement("button");
        el.className = "menu_button sf-action-btn";
        el.textContent = `${btn.emoji} ${btn.name}`;
        el.addEventListener("click", async () => {
            await onPopupButtonClick(btn, popup);
        });
        grid.appendChild(el);
    }

    // ── Extra field ──
    const extra = document.createElement("textarea");
    extra.id = "sf-popup-extra";
    extra.className = "text_pole sf-extra";
    extra.rows = 2;
    extra.placeholder = "Уточнение (необязательно)...";

    // ── Results area ──
    const resultsArea = document.createElement("div");
    resultsArea.id = "sf-popup-results";
    resultsArea.className = "sf-results-list";

    // Show last session results if any
    const gen = currentGen();
    if (gen) {
        renderPopupResults(resultsArea, gen);
    }

    // ── Assemble ──
    popup.appendChild(header);
    popup.appendChild(grid);
    popup.appendChild(extra);
    popup.appendChild(resultsArea);
    overlay.appendChild(popup);
    document.body.appendChild(overlay);

    // ── Events ──
    document.getElementById("sf-popup-close").addEventListener("click", () => overlay.remove());
    overlay.addEventListener("click", (e) => {
        if (e.target === overlay) overlay.remove();
    });
}

async function onPopupButtonClick(btn, popup) {
    const extraEl = document.getElementById("sf-popup-extra");
    const extra = extraEl?.value?.trim() || "";
    const count = btn.count || S().variantCount || 10;

    let prompt = btn.prompt.replace(/\[COUNT\]/gi, String(count));
    if (extra) {
        prompt += "\n\nУточнение от игрока: " + extra;
    }

    // Loading state
    const resultsArea = document.getElementById("sf-popup-results");
    resultsArea.innerHTML = '<div class="sf-loading">⏳ Ожидание ответа модели...</div>';
    popup.querySelectorAll(".sf-action-btn").forEach((b) => (b.disabled = true));

    const raw = await generate(prompt);

    popup.querySelectorAll(".sf-action-btn").forEach((b) => (b.disabled = false));

    if (!raw) {
        resultsArea.innerHTML = '<div class="sf-empty">Не удалось получить ответ</div>';
        return;
    }

    const variants = parseVariants(raw);
    const gen = addGeneration(btn.name, extra, variants, raw);
    renderPopupResults(resultsArea, gen);

    // Also update sidebar results
    renderResults();

    if (extraEl) extraEl.value = "";
}

function renderPopupResults(container, gen) {
    container.innerHTML = "";

    const title = document.createElement("div");
    title.className = "sf-results-title";
    const time = new Date(gen.timestamp).toLocaleTimeString("ru-RU", {
        hour: "2-digit", minute: "2-digit",
    });
    title.textContent = `${gen.buttonName} · ${time}`;
    title.style.marginBottom = "6px";
    container.appendChild(title);

    for (const v of gen.variants) {
        const card = document.createElement("div");
        card.className = "sf-card";

        const body = document.createElement("div");
        body.className = "sf-card-text";
        body.textContent = v.text;

        const actions = document.createElement("div");
        actions.className = "sf-card-actions";

        const copyBtn = document.createElement("button");
        copyBtn.className = "menu_button sf-card-btn";
        copyBtn.textContent = "📋";
        copyBtn.title = "Копировать";
        copyBtn.addEventListener("click", () => toClipboard(v.text));

        const saveBtn = document.createElement("button");
        saveBtn.className = "menu_button sf-card-btn";
        saveBtn.textContent = "💾";
        saveBtn.title = "В архив";
        saveBtn.addEventListener("click", () => {
            archiveVariant(v.text, gen.buttonName);
            renderArchive();
            toastr.success("Сохранено в архив");
        });

        const insertBtn = document.createElement("button");
        insertBtn.className = "menu_button sf-card-btn";
        insertBtn.textContent = "📝";
        insertBtn.title = "В поле ввода";
        insertBtn.addEventListener("click", () => {
            const input = document.getElementById("send_textarea");
            if (input) {
                input.value = v.text;
                input.dispatchEvent(new Event("input", { bubbles: true }));
                toastr.success("Вставлено в поле ввода");
            }
        });

        actions.appendChild(copyBtn);
        actions.appendChild(saveBtn);
        actions.appendChild(insertBtn);

        card.appendChild(body);
        card.appendChild(actions);
        container.appendChild(card);
    }
}
