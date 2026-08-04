// ============================================================
//  Story Toolkit — Archive module (ex Story Archive / st-crud)
// ============================================================

import { getContext, toolkitSettings, saveSettings } from "./st.js";
import { uid, escHtml } from "./utils.js";

const generateId = uid;
const escapeHtml = escHtml;
const saveExtensionSettings = saveSettings;

// ── Data layer ──

function S() {
    const t = toolkitSettings();
    if (!t.archive) t.archive = {};
    return t.archive;
}

function loadSettings() {
    if (!Array.isArray(S().entries)) {
        S().entries = [];
    }
}

function getEntries() {
    return S().entries || [];
}

function addEntry(entry) {
    getEntries().push(entry);
    saveExtensionSettings();
}

function updateEntry(id, updates) {
    const entries = getEntries();
    const idx = entries.findIndex((e) => e.id === id);
    if (idx !== -1) {
        entries[idx] = { ...entries[idx], ...updates, modified: Date.now() };
        saveExtensionSettings();
    }
}

function deleteEntry(id) {
    const entries = getEntries();
    const idx = entries.findIndex((e) => e.id === id);
    if (idx !== -1) {
        entries.splice(idx, 1);
        saveExtensionSettings();
    }
}

function filterEntries(query) {
    const entries = getEntries();
    if (!query) return entries;
    const q = query.toLowerCase();
    return entries.filter(
        (e) =>
            e.title.toLowerCase().includes(q) ||
            e.text.toLowerCase().includes(q) ||
            (e.tags && e.tags.some((t) => t.toLowerCase().includes(q)))
    );
}

// ── Chat helpers ──

/** Parse "5" or "5-8" → { start, end } or null */
function parseMessageInput(raw) {
    const s = raw.trim();
    if (s.includes("-")) {
        const [a, b] = s.split("-").map((x) => parseInt(x.trim(), 10));
        if (!isNaN(a) && !isNaN(b) && a <= b) return { start: a, end: b };
    } else {
        const n = parseInt(s, 10);
        if (!isNaN(n)) return { start: n, end: n };
    }
    return null;
}

function formatMessagesForStorage(messages) {
    return messages
        .map((m) => {
            const name = m.name || (m.is_user ? "User" : "Assistant");
            return `${name}: ${m.mes}`;
        })
        .join("\n\n");
}

// ── Clipboard ──

async function copyToClipboard(text) {
    try {
        await navigator.clipboard.writeText(text);
    } catch {
        const ta = document.createElement("textarea");
        ta.value = text;
        ta.style.position = "fixed";
        ta.style.opacity = "0";
        document.body.appendChild(ta);
        ta.select();
        document.execCommand("copy");
        document.body.removeChild(ta);
    }
    toastr.success("Скопировано в буфер обмена");
}

// ── Rendering ──

function updateEntryCount(searchQuery) {
    const el = document.getElementById("sa-entry-count");
    if (!el) return;
    const total = getEntries().length;
    const filtered = filterEntries(searchQuery).length;
    el.textContent =
        searchQuery && filtered !== total
            ? `Найдено: ${filtered} из ${total}`
            : `Всего записей: ${total}`;
}

function renderEntryList(searchQuery = "") {
    const container = document.getElementById("sa-entry-list");
    if (!container) return;

    const entries = filterEntries(searchQuery);

    if (entries.length === 0) {
        container.innerHTML = '<div class="sa-empty">Нет записей</div>';
        return;
    }

    container.innerHTML = "";

    // Newest first
    const sorted = [...entries].sort((a, b) => b.created - a.created);

    for (const entry of sorted) {
        const el = document.createElement("div");
        el.className = "sa-entry";

        // Header
        const header = document.createElement("div");
        header.className = "sa-entry-header";
        header.innerHTML = `
            <span class="sa-entry-title">${escapeHtml(entry.title)}</span>
            <span class="sa-entry-toggle">▶</span>
        `;

        // Tags
        let tagsEl = null;
        if (entry.tags && entry.tags.length > 0) {
            tagsEl = document.createElement("div");
            tagsEl.className = "sa-entry-tags";
            tagsEl.innerHTML = entry.tags
                .map((t) => `<span class="sa-tag">${escapeHtml(t)}</span>`)
                .join("");
        }

        // Source info
        let sourceEl = null;
        if (entry.source) {
            sourceEl = document.createElement("div");
            sourceEl.className = "sa-entry-source";
            sourceEl.textContent = [entry.source.character, entry.source.date]
                .filter(Boolean)
                .join(" · ");
        }

        // Body (hidden)
        const body = document.createElement("div");
        body.className = "sa-entry-body";
        body.style.display = "none";

        const textDiv = document.createElement("div");
        textDiv.className = "sa-entry-text";
        textDiv.textContent = entry.text;

        const actions = document.createElement("div");
        actions.className = "sa-entry-actions";
        actions.innerHTML = `
            <button class="sa-btn sa-btn-copy menu_button" data-id="${entry.id}">📋 Копировать</button>
            <button class="sa-btn sa-btn-edit menu_button" data-id="${entry.id}">✏️ Редактировать</button>
            <button class="sa-btn sa-btn-delete menu_button" data-id="${entry.id}">🗑️ Удалить</button>
        `;

        body.appendChild(textDiv);
        body.appendChild(actions);

        // Toggle
        header.addEventListener("click", () => {
            const open = body.style.display !== "none";
            body.style.display = open ? "none" : "block";
            header.querySelector(".sa-entry-toggle").textContent = open
                ? "▶"
                : "▼";
        });

        el.appendChild(header);
        if (tagsEl) el.appendChild(tagsEl);
        if (sourceEl) el.appendChild(sourceEl);
        el.appendChild(body);
        container.appendChild(el);
    }

    updateEntryCount(searchQuery);
}

// ── Edit modal ──

function openEditModal(id) {
    const entry = getEntries().find((e) => e.id === id);
    if (!entry) return;

    document.getElementById("sa-edit-modal")?.remove();

    const overlay = document.createElement("div");
    overlay.id = "sa-edit-modal";
    overlay.className = "sa-modal-overlay";

    const modal = document.createElement("div");
    modal.className = "sa-modal";
    modal.innerHTML = `
        <h4>✏️ Редактирование</h4>
        <label>Заголовок:</label>
        <input type="text" id="sa-edit-title" class="text_pole">
        <label>Теги (через запятую):</label>
        <input type="text" id="sa-edit-tags" class="text_pole">
        <label>Текст:</label>
        <textarea id="sa-edit-text" class="text_pole" rows="12"></textarea>
        <div class="sa-modal-actions">
            <button id="sa-edit-save" class="menu_button">💾 Сохранить</button>
            <button id="sa-edit-cancel" class="menu_button">❌ Отмена</button>
        </div>
    `;

    overlay.appendChild(modal);
    document.body.appendChild(overlay);

    // Populate via .value (safe)
    document.getElementById("sa-edit-title").value = entry.title;
    document.getElementById("sa-edit-tags").value = (entry.tags || []).join(", ");
    document.getElementById("sa-edit-text").value = entry.text;

    // Save
    document.getElementById("sa-edit-save").addEventListener("click", () => {
        const title = document.getElementById("sa-edit-title").value.trim();
        const text = document.getElementById("sa-edit-text").value.trim();
        const tagsRaw = document.getElementById("sa-edit-tags").value.trim();
        if (!title || !text) {
            toastr.warning("Заголовок и текст обязательны");
            return;
        }
        const tags = tagsRaw
            ? tagsRaw.split(",").map((t) => t.trim()).filter(Boolean)
            : [];
        updateEntry(id, { title, tags, text });
        overlay.remove();
        renderEntryList(document.getElementById("sa-search")?.value || "");
        toastr.success("Запись обновлена");
    });

    // Cancel
    document.getElementById("sa-edit-cancel").addEventListener("click", () => {
        overlay.remove();
    });

    // Click on overlay background → close
    overlay.addEventListener("click", (e) => {
        if (e.target === overlay) overlay.remove();
    });
}

// ── Export / Import ──

function exportEntries() {
    const entries = getEntries();
    const blob = new Blob([JSON.stringify(entries, null, 2)], {
        type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `story-archive-${new Date().toISOString().split("T")[0]}.json`;
    a.click();
    URL.revokeObjectURL(url);
    toastr.success(`Экспортировано ${entries.length} записей`);
}

function importEntries(file) {
    const reader = new FileReader();
    reader.onload = (event) => {
        try {
            const imported = JSON.parse(event.target.result);
            if (!Array.isArray(imported)) {
                toastr.error("Неверный формат файла");
                return;
            }
            const entries = getEntries();
            let added = 0;
            for (const item of imported) {
                if (item.id && item.title && item.text) {
                    if (!entries.find((e) => e.id === item.id)) {
                        entries.push(item);
                        added++;
                    }
                }
            }
            saveExtensionSettings();
            renderEntryList();
            updateEntryCount();
            toastr.success(`Импортировано ${added} новых записей`);
        } catch (err) {
            toastr.error("Ошибка чтения файла");
            console.error("[Story Archive] Import error:", err);
        }
    };
    reader.readAsText(file);
}

// ── UI scaffold ──

function createUI() {
    const panel = `
    <div class="story-archive-settings">
        <div class="inline-drawer">
            <div class="inline-drawer-toggle inline-drawer-header">
                <b>📚 Story Archive</b>
                <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
            </div>
            <div class="inline-drawer-content">
                <div id="sa-panel" class="sa-panel">

                    <!-- Add from chat -->
                    <div class="sa-section">
                        <h4>📎 Добавить из чата</h4>
                        <label>Номер сообщения (или диапазон, напр. 5-8):</label>
                        <input type="text" id="sa-msg-input" class="text_pole" placeholder="47 или 15-18">
                        <label>Заголовок:</label>
                        <input type="text" id="sa-title-input" class="text_pole" placeholder="Рассказ Ника про синагогу">
                        <label>Теги через запятую:</label>
                        <input type="text" id="sa-tags-input" class="text_pole" placeholder="Nick, backstory, humor">
                        <button id="sa-add-from-chat" class="menu_button">💾 Сохранить из чата</button>
                    </div>

                    <hr class="sa-hr">

                    <!-- Add manually -->
                    <div class="sa-section">
                        <h4>✍️ Добавить вручную</h4>
                        <label>Заголовок:</label>
                        <input type="text" id="sa-manual-title" class="text_pole" placeholder="Заголовок">
                        <label>Теги через запятую:</label>
                        <input type="text" id="sa-manual-tags" class="text_pole" placeholder="Теги">
                        <label>Текст:</label>
                        <textarea id="sa-manual-text" class="text_pole" rows="6" placeholder="Текст записи..."></textarea>
                        <button id="sa-add-manual" class="menu_button">💾 Сохранить</button>
                    </div>

                    <hr class="sa-hr">

                    <!-- Archive list -->
                    <div class="sa-section">
                        <h4>🔍 Хранилище</h4>
                        <input type="text" id="sa-search" class="text_pole" placeholder="Поиск по заголовку, тегам, тексту...">
                        <div id="sa-entry-count" class="sa-entry-count"></div>
                        <div id="sa-entry-list" class="sa-entry-list"></div>
                    </div>

                    <hr class="sa-hr">

                    <!-- Export / Import -->
                    <div class="sa-section sa-export-import">
                        <button id="sa-export" class="menu_button">📤 Экспорт</button>
                        <button id="sa-import" class="menu_button">📥 Импорт</button>
                        <input type="file" id="sa-import-file" accept=".json" style="display:none">
                    </div>

                </div>
            </div>
        </div>
    </div>`;

    document.getElementById("extensions_settings2")
        .insertAdjacentHTML("beforeend", panel);
}

// ── Event binding ──

function bindEvents() {
    // ── Add from chat ──
    document.getElementById("sa-add-from-chat")?.addEventListener("click", () => {
        const msgRaw = document.getElementById("sa-msg-input").value;
        const title = document.getElementById("sa-title-input").value.trim();
        const tagsRaw = document.getElementById("sa-tags-input").value.trim();

        if (!msgRaw || !title) {
            toastr.warning("Укажите номер сообщения и заголовок");
            return;
        }

        const range = parseMessageInput(msgRaw);
        if (!range) {
            toastr.error("Неверный формат (ожидается число или диапазон вроде 5-8)");
            return;
        }

        const context = getContext();
        const chat = context.chat;

        if (!chat || chat.length === 0) {
            toastr.error("Чат пуст");
            return;
        }

        if (range.start < 0 || range.end >= chat.length) {
            toastr.error(`Допустимый диапазон: 0 – ${chat.length - 1}`);
            return;
        }

        const messages = chat.slice(range.start, range.end + 1);
        const text = formatMessagesForStorage(messages);
        const tags = tagsRaw
            ? tagsRaw.split(",").map((t) => t.trim()).filter(Boolean)
            : [];

        addEntry({
            id: generateId(),
            title,
            tags,
            text,
            source: {
                chat: context.chatId || "",
                character: context.name2 || "",
                messageIndex:
                    range.start === range.end
                        ? range.start
                        : `${range.start}-${range.end}`,
                date: new Date().toISOString().split("T")[0],
            },
            created: Date.now(),
            modified: Date.now(),
        });

        // Clear form
        document.getElementById("sa-msg-input").value = "";
        document.getElementById("sa-title-input").value = "";
        document.getElementById("sa-tags-input").value = "";

        renderEntryList(document.getElementById("sa-search")?.value || "");
        toastr.success(`Сохранено: «${title}»`);
    });

    // ── Add manually ──
    document.getElementById("sa-add-manual")?.addEventListener("click", () => {
        const title = document.getElementById("sa-manual-title").value.trim();
        const tagsRaw = document.getElementById("sa-manual-tags").value.trim();
        const text = document.getElementById("sa-manual-text").value.trim();

        if (!title || !text) {
            toastr.warning("Укажите заголовок и текст");
            return;
        }

        const tags = tagsRaw
            ? tagsRaw.split(",").map((t) => t.trim()).filter(Boolean)
            : [];

        addEntry({
            id: generateId(),
            title,
            tags,
            text,
            source: null,
            created: Date.now(),
            modified: Date.now(),
        });

        document.getElementById("sa-manual-title").value = "";
        document.getElementById("sa-manual-tags").value = "";
        document.getElementById("sa-manual-text").value = "";

        renderEntryList(document.getElementById("sa-search")?.value || "");
        toastr.success(`Сохранено: «${title}»`);
    });

    // ── Search ──
    document.getElementById("sa-search")?.addEventListener("input", (e) => {
        renderEntryList(e.target.value);
    });

    // ── Entry list (delegated) ──
    document.getElementById("sa-entry-list")?.addEventListener("click", (e) => {
        const btn = e.target.closest("button");
        if (!btn) return;

        const id = btn.dataset.id;
        if (!id) return;

        if (btn.classList.contains("sa-btn-copy")) {
            const entry = getEntries().find((x) => x.id === id);
            if (entry) copyToClipboard(entry.text);
        } else if (btn.classList.contains("sa-btn-edit")) {
            openEditModal(id);
        } else if (btn.classList.contains("sa-btn-delete")) {
            const entry = getEntries().find((x) => x.id === id);
            if (entry && confirm(`Удалить «${entry.title}»?`)) {
                deleteEntry(id);
                renderEntryList(document.getElementById("sa-search")?.value || "");
                toastr.info("Запись удалена");
            }
        }
    });

    // ── Export ──
    document.getElementById("sa-export")?.addEventListener("click", exportEntries);

    // ── Import ──
    document.getElementById("sa-import")?.addEventListener("click", () => {
        document.getElementById("sa-import-file")?.click();
    });

    document.getElementById("sa-import-file")?.addEventListener("change", (e) => {
        const file = e.target.files?.[0];
        if (file) importEntries(file);
        e.target.value = "";
    });
}

// ── Init ──

export function initArchive() {
    loadSettings();
    createUI();
    bindEvents();
    renderEntryList();
    updateEntryCount();
    console.log("[Story Toolkit] Archive module loaded");
}
