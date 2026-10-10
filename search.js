// ============================================================
//  Story Toolkit — Story Search module
//
//  Поиск по ключевым словам во всех чатах всех персонажей и
//  групп. Сканирует сервер (плагин story-search: архив чатов —
//  сотни мегабайт, браузеру его не отдать), здесь — окно и
//  переходы: каждая находка — ссылка, открывающая нужный чат
//  на нужном сообщении.
//  Одно и то же сообщение живёт во многих ветках — сервер
//  склеивает такие повторы в одну находку со списком мест.
// ============================================================

import { getContext, openGroupById } from "./st.js";
import { addWandMenuItem, escHtml, copyToClipboard } from "./utils.js";

const TAG = "[STK Search]";
const MENU_ITEM_ID = "stk_search_menu_item";
const OVERLAY_ID = "stk-search-overlay";
const SEARCH_URL = "/api/plugins/story-search/search";
const LIMIT = 200;
const SNIPPET_RADIUS = 160;

// The last search survives closing the window, so jumping to a chat and
// coming back does not mean searching again.
let lastQuery = "";
let lastResult = null;
let busy = false;

// ── Server ──

async function runSearch(query) {
    const ctx = getContext();
    const response = await fetch(SEARCH_URL, {
        method: "POST",
        headers: ctx.getRequestHeaders(),
        body: JSON.stringify({ query, limit: LIMIT }),
    });
    if (response.status === 404) {
        throw new Error("серверный плагин story-search не установлен или Таверна не перезапущена");
    }
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
    return data;
}

// ── Text helpers ──

/** Same folding as the server: lowercase, ё → е. Length-preserving, so indices carry over. */
function norm(s) {
    return String(s).toLowerCase().replace(/ё/g, "е");
}

function escapeRegex(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function termsRegex(terms) {
    const parts = (terms || []).map((t) =>
        `(?<![\\p{L}\\p{N}])${escapeRegex(t.text)}${t.whole ? "(?![\\p{L}\\p{N}])" : ""}`);
    return parts.length ? new RegExp(parts.join("|"), "gu") : null;
}

/** Escaped HTML of `text` with every match wrapped in <mark>. */
function highlight(text, re) {
    if (!re) return escHtml(text);
    const n = norm(text);
    let out = "";
    let last = 0;
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(n)) !== null) {
        if (!m[0].length) { re.lastIndex++; continue; }
        out += escHtml(text.slice(last, m.index)) + "<mark>" + escHtml(text.slice(m.index, m.index + m[0].length)) + "</mark>";
        last = m.index + m[0].length;
    }
    return out + escHtml(text.slice(last));
}

/** A window of text around the first match, cut at word boundaries where possible. */
function snippet(text, re) {
    if (text.length <= SNIPPET_RADIUS * 2.5) return text;
    let at = 0;
    if (re) {
        re.lastIndex = 0;
        const m = re.exec(norm(text));
        if (m) at = m.index;
    }
    let from = Math.max(0, at - SNIPPET_RADIUS);
    let to = Math.min(text.length, at + SNIPPET_RADIUS * 1.5);
    if (from > 0) from = text.indexOf(" ", from) + 1 || from;
    if (to < text.length) to = text.lastIndexOf(" ", to) > at ? text.lastIndexOf(" ", to) : to;
    return (from > 0 ? "… " : "") + text.slice(from, to).trim() + (to < text.length ? " …" : "");
}

// ── Places ──

function characterFor(folder) {
    const chars = getContext().characters || [];
    const idx = chars.findIndex((c) => c.avatar === `${folder}.png`);
    return idx < 0 ? null : { idx, char: chars[idx] };
}

function placeTitle(p) {
    if (p.kind === "group") return `👥 ${p.groupName || "группа"}`;
    return characterFor(p.folder)?.char.name || `${p.folder} (карточка не найдена)`;
}

function chatName(p) {
    return p.file.replace(/\.jsonl$/, "");
}

async function waitFor(check, ms = 8000) {
    const until = Date.now() + ms;
    while (Date.now() < until) {
        if (check()) return true;
        await new Promise((r) => setTimeout(r, 100));
    }
    return false;
}

/** Open the chat a hit lives in and scroll to the message. */
async function openPlace(p) {
    const ctx = getContext();
    const target = chatName(p);
    try {
        if (p.kind === "char") {
            const found = characterFor(p.folder);
            if (!found) {
                toastr.warning("Карточка этого чата не найдена — возможно, удалена или переименована.", "Story Search");
                return;
            }
            if (ctx.groupId || String(ctx.characterId) !== String(found.idx)) {
                await ctx.selectCharacterById(found.idx);
                await waitFor(() => String(getContext().characterId) === String(found.idx));
            }
            if (getContext().getCurrentChatId() !== target) await getContext().openCharacterChat(target);
        } else {
            if (getContext().groupId !== p.groupId) {
                if (typeof openGroupById !== "function") throw new Error("openGroupById недоступна в этой версии ST");
                await openGroupById(p.groupId);
            }
            if (getContext().getCurrentChatId() !== target) await getContext().openGroupChat(p.groupId, target);
        }

        const loaded = await waitFor(() =>
            getContext().getCurrentChatId() === target && (getContext().chat?.length || 0) > p.mesId);
        if (!loaded) {
            toastr.warning("Чат не открылся — возможно, Таверна сейчас генерирует ответ. Попробуйте ещё раз.", "Story Search");
            return;
        }
        document.getElementById(OVERLAY_ID)?.remove();
        await getContext().executeSlashCommandsWithOptions(`/chat-jump ${p.mesId}`);
    } catch (e) {
        console.error(`${TAG} open failed:`, e);
        toastr.error("Не удалось открыть чат: " + (e?.message || e), "Story Search");
    }
}

// ── UI ──

function placeLink(p, label) {
    const a = document.createElement("a");
    a.className = "stk-search-link";
    a.href = "#";
    a.textContent = label;
    a.title = `${placeTitle(p)} · ${chatName(p)} · сообщение #${p.mesId}`;
    a.addEventListener("click", (e) => {
        e.preventDefault();
        openPlace(p);
    });
    return a;
}

function renderHit(hit, re) {
    const card = document.createElement("div");
    card.className = "sf-card stk-search-hit";
    const main = hit.places[0];

    const head = document.createElement("div");
    head.className = "stk-search-head";
    const date = hit.date
        ? new Date(hit.date).toLocaleString("ru-RU", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" })
        : "";
    const found = main.kind === "char" ? characterFor(main.folder) : null;
    head.innerHTML =
        (found ? `<img class="stk-search-ava" src="/thumbnail?type=avatar&file=${encodeURIComponent(found.char.avatar)}" alt="">` : "") +
        `<b>${escHtml(placeTitle(main))}</b>` +
        `<span class="stk-search-meta">${escHtml(hit.isUser ? `✍ ${hit.name || "вы"}` : hit.name)}${date ? " · " + escHtml(date) : " · дата неизвестна"}</span>`;
    const copyBtn = document.createElement("button");
    copyBtn.className = "menu_button sf-card-btn stk-search-copy";
    copyBtn.textContent = "📋 Копировать";
    copyBtn.title = "Скопировать сообщение целиком";
    copyBtn.addEventListener("click", () => copyToClipboard(hit.text, "Сообщение скопировано"));
    head.appendChild(copyBtn);
    card.appendChild(head);

    const body = document.createElement("div");
    body.className = "sf-card-text stk-search-text";
    const short = snippet(hit.text, re);
    body.innerHTML = highlight(short, re);
    card.appendChild(body);

    const actions = document.createElement("div");
    actions.className = "stk-search-places";
    actions.appendChild(placeLink(main, `↗ ${chatName(main)} · #${main.mesId}`));

    if (short !== hit.text) {
        const more = document.createElement("a");
        more.href = "#";
        more.className = "stk-search-toggle";
        more.textContent = "весь текст";
        let full = false;
        more.addEventListener("click", (e) => {
            e.preventDefault();
            full = !full;
            body.innerHTML = highlight(full ? hit.text : short, re);
            more.textContent = full ? "свернуть" : "весь текст";
        });
        actions.appendChild(more);
    }

    if (hit.places.length > 1) {
        const others = document.createElement("details");
        others.className = "stk-search-others";
        others.innerHTML = `<summary>ещё в ${hit.places.length - 1} ${plural(hit.places.length - 1, "ветке", "ветках", "ветках")}</summary>`;
        for (const p of hit.places.slice(1)) {
            const row = document.createElement("div");
            row.appendChild(placeLink(p, `↗ ${p.kind === "group" ? placeTitle(p) + " · " : ""}${chatName(p)} · #${p.mesId}`));
            others.appendChild(row);
        }
        actions.appendChild(others);
    }
    card.appendChild(actions);
    return card;
}

function plural(n, one, few, many) {
    const m10 = n % 10, m100 = n % 100;
    if (m10 === 1 && m100 !== 11) return one;
    if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
    return many;
}

function renderResults(modal) {
    const status = modal.querySelector("#stk-search-status");
    const list = modal.querySelector("#stk-search-results");
    const btn = modal.querySelector("#stk-search-go");
    btn.disabled = busy;
    list.innerHTML = "";

    if (busy) {
        status.textContent = "⏳ Ищу по всем чатам…";
        return;
    }
    if (!lastResult) {
        status.textContent = "";
        return;
    }
    const r = lastResult;
    const secs = (r.ms / 1000).toFixed(1).replace(".", ",");
    status.textContent = r.total
        ? `Найдено сообщений: ${r.total}${r.truncated ? ` (показаны ${r.hits.length} самых свежих)` : ""} · чатов просмотрено: ${r.files} · ${secs} с`
        : `Ничего не найдено · чатов просмотрено: ${r.files} · ${secs} с`;

    const re = termsRegex(r.terms);
    for (const hit of r.hits) list.appendChild(renderHit(hit, re));
}

async function doSearch(modal) {
    const input = modal.querySelector("#stk-search-input");
    const query = input.value.trim();
    if (!query || busy) return;
    lastQuery = query;
    busy = true;
    renderResults(modal);
    try {
        lastResult = await runSearch(query);
    } catch (e) {
        console.error(`${TAG} search failed:`, e);
        toastr.error("Поиск не удался: " + (e?.message || e), "Story Search");
        lastResult = null;
    } finally {
        busy = false;
    }
    const current = document.querySelector(`#${OVERLAY_ID} .stk-modal`);
    if (current) renderResults(current);
}

function openSearchPopup() {
    document.getElementById(OVERLAY_ID)?.remove();

    const overlay = document.createElement("div");
    overlay.id = OVERLAY_ID;
    overlay.className = "stk-modal-overlay";

    const modal = document.createElement("div");
    modal.className = "stk-modal stk-search-modal";
    modal.innerHTML = `
        <div class="stk-helper-header">
            <h4>🔎 Story Search</h4>
            <button id="stk-search-close" class="menu_button sf-card-btn" title="Закрыть">✖</button>
        </div>
        <div class="stk-search-bar">
            <input id="stk-search-input" class="text_pole" type="search" autocomplete="off"
                placeholder="Слова для поиска…" value="${escHtml(lastQuery)}">
            <button id="stk-search-go" class="menu_button">Найти</button>
        </div>
        <p class="stk-note">Ищет во всех чатах всех персонажей. Слово находит и продолжения: «поцел» → «поцелуй».
            В кавычках — только целиком: "кот". Все слова должны быть в одном сообщении.</p>
        <div id="stk-search-status" class="stk-search-status"></div>
        <div id="stk-search-results" class="stk-search-results"></div>`;

    overlay.appendChild(modal);
    document.body.appendChild(overlay);

    const input = modal.querySelector("#stk-search-input");
    modal.querySelector("#stk-search-go").addEventListener("click", () => doSearch(modal));
    input.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
            e.preventDefault();
            doSearch(modal);
        }
    });
    modal.querySelector("#stk-search-close").addEventListener("click", () => overlay.remove());
    overlay.addEventListener("click", (e) => {
        if (e.target === overlay) overlay.remove();
    });
    // Phones: no autofocus, it throws the keyboard up over the results.
    if (!window.matchMedia("(max-width: 768px)").matches) input.focus();

    renderResults(modal);
}

// ── Init ──

export function initSearch() {
    addWandMenuItem(MENU_ITEM_ID, "fa-magnifying-glass", "Story Search", openSearchPopup);
    console.log(`${TAG} Story Search module loaded`);
}
