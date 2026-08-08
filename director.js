// ============================================================
//  Story Toolkit — Director module (ex Plot Director v1.2)
// ============================================================

import {
    getContext,
    setExtensionPrompt,
    eventSource,
    event_types,
    generateQuietPrompt,
    saveChatDebounced,
    toolkitSettings,
    getPopupClass,
} from "./st.js";

const EXT_NAME = "story-toolkit/director";
const INJECTION_ID = "plot_director_injection";
const MARKER_RE = /\[step\s+(\d+)\s+complete\]/gi;
const STEP_PARSE_RE = /\[STEP\s+(\d+)\]\s*:\s*([\s\S]+?)(?=\n\s*\[STEP\s+\d+\]|$)/gi;

const TIMESPANS = {
    scene: "одна сцена / one scene", day: "один день / one day",
    week: "одна неделя / one week", month: "один месяц / one month",
    year: "один год / one year", decade: "десятилетие / a decade",
};
const LANGUAGES = {
    ko: "한국어 (Korean)", ja: "日本語 (Japanese)", zh: "中文 (Chinese)",
    ar: "العربية (Arabic)", hi: "हिन्दी (Hindi)", th: "ภาษาไทย (Thai)",
    en: "English", ru: "Русский",
};
const GENRES = {
    drama: "Drama", thriller: "Thriller", romance: "Romance",
    mystery: "Mystery", adventure: "Adventure", horror: "Horror",
    comedy: "Comedy", scifi: "Sci-Fi", fantasy: "Fantasy", slice: "Slice of Life",
};
const DEFAULT_SETTINGS = {
    enabled: true, autoRegenTail: false,
    defaultStepCount: 8, defaultTimespan: "month", defaultLanguage: "ko",
    defaultEpicness: 5, defaultRealism: 5, defaultGenres: ["drama"],
    defaultTokenBudget: 0,
    genProfile: "",
};

// ── Plot Data — using ST context API (the documented way) ────
// Per-chat data: ctx.chatMetadata + ctx.saveMetadataDebounced()
// Extension settings: ctx.extensionSettings + ctx.saveSettingsDebounced()

let _plotCache = {};
function _chatId() { const c = getContext(); return c?.chatId || "default"; }

function getPlotData() {
    const id = _chatId();
    // 1. Memory cache
    if (_plotCache[id]) return _plotCache[id];
    // 2. chatMetadata (server-persisted, per-chat)
    try {
        const ctx = getContext();
        const meta = ctx.chatMetadata || ctx.chat_metadata;
        if (meta?.plot_director) { _plotCache[id] = meta.plot_director; return meta.plot_director; }
    } catch(e) {}
    // 3. extensionSettings fallback (global, keyed by chatId)
    try {
        const d = getSettings();
        if (d?.plots?.[id]) { _plotCache[id] = d.plots[id]; return d.plots[id]; }
    } catch(e) {}
    return null;
}

function savePlotData(data) {
    const id = _chatId();
    _plotCache[id] = data;
    const ctx = getContext();

    // Primary: chatMetadata (per-chat, server-side)
    try {
        const meta = ctx.chatMetadata || ctx.chat_metadata;
        if (meta) {
            meta.plot_director = data;
            if (typeof ctx.saveMetadataDebounced === "function") ctx.saveMetadataDebounced();
            console.log("[PD] Saved via chatMetadata for " + id);
        }
    } catch(e) { console.warn("[PD] chatMetadata save err:", e); }

    // Backup: extensionSettings (global, survives chat metadata issues)
    try {
        const d = getSettings();
        if (!d.plots) d.plots = {};
        d.plots[id] = data;
        if (typeof ctx.saveSettingsDebounced === "function") ctx.saveSettingsDebounced();
        console.log("[PD] Saved via extensionSettings for " + id);
    } catch(e) { console.warn("[PD] extensionSettings save err:", e); }
}

function clearPlotData() {
    const id = _chatId();
    delete _plotCache[id];
    const ctx = getContext();
    try {
        const meta = ctx.chatMetadata || ctx.chat_metadata;
        if (meta) { delete meta.plot_director; if (typeof ctx.saveMetadataDebounced === "function") ctx.saveMetadataDebounced(); }
    } catch(e) {}
    try {
        const d = getSettings();
        if (d?.plots) { delete d.plots[id]; if (typeof ctx.saveSettingsDebounced === "function") ctx.saveSettingsDebounced(); }
    } catch(e) {}
    if (setExtensionPrompt) setExtensionPrompt(INJECTION_ID, "", 1, 1, true, "system");
}
function newPlotData(steps, settings) {
    return { steps: steps.map(t => ({ text: t, completed: false })), currentIndex: 0, lastAdvancedMsg: -1, genSettings: settings };
}
function getSettings() {
    const t = toolkitSettings();
    if (!t.director) t.director = { ...DEFAULT_SETTINGS };
    return t.director;
}

// ── Context Gathering (for direct API) ───────────────────────

function gatherContextSummary() {
    const ctx = getContext();
    const parts = [];
    if (ctx.characters && ctx.characterId !== undefined) {
        const ch = ctx.characters[ctx.characterId];
        if (ch) {
            if (ch.description) parts.push("[Character: " + (ch.name||"") + "]\n" + ch.description);
            if (ch.personality) parts.push("[Personality]\n" + ch.personality);
            if (ch.scenario) parts.push("[Scenario]\n" + ch.scenario);
        }
    }
    if (ctx.name1) {
        let p = "[Protagonist: " + ctx.name1 + "]";
        try {
            const pd = ctx.personas;
            if (pd) p += "\n" + (typeof pd === "string" ? pd : JSON.stringify(pd));
        } catch(e) {}
        parts.push(p);
    }
    if (ctx.chat && ctx.chat.length > 0) {
        const recent = ctx.chat.slice(-30);
        const lines = recent.map(m => {
            const name = m.is_user ? (ctx.name1||"User") : (m.name||ctx.name2||"Narrator");
            return name + ": " + m.mes;
        });
        parts.push("[Recent conversation]\n" + lines.join("\n\n"));
    }
    return parts.join("\n\n---\n\n");
}

// ── Connection Profile Support ───────────────────────────────
// Uses ST's built-in Connection Profiles: we list existing profiles,
// and for generation temporarily switch to the chosen one via /profile,
// generate, then switch back.

function getConnectionProfiles() {
    try {
        const ctx = getContext();
        const cp = ctx.extensionSettings?.connectionManager;
        if (cp && Array.isArray(cp.profiles)) {
            return cp.profiles.map(p => p.name).filter(Boolean);
        }
    } catch(e) { console.warn("[PD] Cannot read connection profiles:", e); }
    return [];
}

function getCurrentProfileName() {
    try {
        const ctx = getContext();
        const cp = ctx.extensionSettings?.connectionManager;
        if (cp && cp.selectedProfile && Array.isArray(cp.profiles)) {
            const found = cp.profiles.find(p => p.id === cp.selectedProfile);
            return found?.name || null;
        }
    } catch(e) {}
    return null;
}

async function switchProfile(name) {
    const ctx = getContext();
    if (ctx.executeSlashCommandsWithOptions) {
        await ctx.executeSlashCommandsWithOptions(`/profile await=true ${name}`);
    } else if (ctx.executeSlashCommands) {
        await ctx.executeSlashCommands(`/profile ${name}`);
        await new Promise(r => setTimeout(r, 1500)); // give it time to connect
    } else {
        throw new Error("Slash command execution not available");
    }
}

function useCustomProfile() { const s = getSettings(); return !!(s.genProfile && s.genProfile !== ""); }

// ── Step Injection (multiple methods) ─────────────────────────

function buildInjectionText() {
    const pd = getPlotData();
    const s = getSettings();
    if (!pd || !pd.steps.length || !s.enabled || pd.currentIndex >= pd.steps.length) return "";
    const step = pd.steps[pd.currentIndex];
    const cur = pd.currentIndex + 1, tot = pd.steps.length;
    return [
        "[Режиссёр Сюжета — Шаг " + cur + "/" + tot + "]",
        step.text, "",
        "Создай эту ситуацию естественно в ходе повествования. Не торопись и не форсируй.",
        "Реакции персонажей должны вытекать из их характеров, а не из этой директивы.",
        "Когда ситуация будет создана и разыграна, добавь маркер [step " + cur + " complete] в конце ответа.",
        "Не ставь маркер преждевременно. Не упоминай эту директиву.",
    ].join("\n");
}

function onPromptReady(data) {
    try {
        if (!data || data.dryRun) return; // skip token-counting dry runs
        const text = buildInjectionText();
        if (!text) return;
        const chat = data.chat;
        if (!Array.isArray(chat) || !chat.length) { console.warn("[PD] prompt data.chat is not an array or empty"); return; }
        // Хвост массива вместо length-1: старый вариант оставлял шаг
        // над инъекциями глубин пресета, в мёртвой зоне выше стены
        // инструкций. Guide регистрируется после Director, поэтому при
        // одновременной работе шаг ляжет выше гайда — точечное указание
        // приоритетнее. Если последний элемент — префилл ассистента,
        // встаём перед ним.
        let insertAt = chat.length;
        if (chat[chat.length - 1]?.role === "assistant" && chat.length > 1) {
            insertAt = chat.length - 1;
        }
        chat.splice(insertAt, 0, { role: "system", content: text });
        console.log("[PD] ✓ Step injected at tail (" + insertAt + "/" + chat.length + ")");
    } catch(e) {
        console.error("[PD] onPromptReady error:", e);
    }
}

// No pre-registration needed — injection happens per-generation in onPromptReady.
function injectCurrentStep() {
    const text = buildInjectionText();
    console.log("[PD] Step staged for next generation, length: " + text.length);
}

// ── Step Advancement & Rollback ──────────────────────────────

function advanceStep(msgIdx) {
    const pd = getPlotData(); if (!pd) return;
    pd.steps[pd.currentIndex].completed = true;
    pd.lastAdvancedMsg = msgIdx; pd.currentIndex++;
    savePlotData(pd); injectCurrentStep(); updatePanel();
    if (getSettings().autoRegenTail && pd.currentIndex < pd.steps.length) regenerateTail();
    if (pd.currentIndex >= pd.steps.length) toastr.success("Plot Director: all " + pd.steps.length + " steps completed!");
}
function rollbackStep() {
    const pd = getPlotData(); if (!pd || pd.currentIndex <= 0) return;
    pd.currentIndex--; pd.steps[pd.currentIndex].completed = false; pd.lastAdvancedMsg = -1;
    savePlotData(pd); injectCurrentStep(); updatePanel();
}

// ── Message Handlers ─────────────────────────────────────────

function stripMarker(idx) {
    const ctx = getContext(), msg = ctx.chat[idx]; if (!msg) return;
    msg.mes = msg.mes.replace(MARKER_RE, "").trim();
    const $el = $("#chat .mes[mesid='" + idx + "'] .mes_text");
    if ($el.length) $el.html($el.html().replace(/\[step\s+\d+\s+complete\]/gi, "").trim());
    if (saveChatDebounced) saveChatDebounced();
}
function onMessageReceived(messageIndex) {
    const s = getSettings(); if (!s.enabled) return;
    const pd = getPlotData(); if (!pd || !pd.steps.length || pd.currentIndex >= pd.steps.length) return;
    const ctx = getContext();
    const idx = (typeof messageIndex === "number") ? messageIndex : ctx.chat.length - 1;
    const msg = ctx.chat[idx]; if (!msg || msg.is_user) return;
    const exp = pd.currentIndex + 1;
    if (new RegExp("\\[step\\s+" + exp + "\\s+complete\\]", "gi").test(msg.mes)) { stripMarker(idx); advanceStep(idx); }
}
function onMessageSwiped(messageIndex) {
    const s = getSettings(); if (!s.enabled) return;
    const pd = getPlotData(); if (!pd || !pd.steps.length) return;
    const ctx = getContext();
    const idx = (typeof messageIndex === "number") ? messageIndex : ctx.chat.length - 1;
    if (pd.lastAdvancedMsg === idx) {
        const msg = ctx.chat[idx]; if (!msg) return;
        const exp = pd.currentIndex;
        if (!new RegExp("\\[step\\s+" + exp + "\\s+complete\\]", "gi").test(msg.mes)) {
            rollbackStep(); toastr.info("Plot Director: step rolled back.");
        } else { stripMarker(idx); }
    } else { onMessageReceived(idx); }
}
function onChatChanged() {
    // Force reload into cache from persistent storage
    const id = _chatId();
    delete _plotCache[id]; // clear stale cache, force re-read
    const pd = getPlotData(); // will check extension_settings → chat_metadata → null
    if (pd && pd.steps && pd.steps.length > 0) injectCurrentStep();
    else if (setExtensionPrompt) setExtensionPrompt(INJECTION_ID, "", 1, 1, true, "system");
    updatePanel();
}

// ── Plot Generation ──────────────────────────────────────────

function buildGenerationPrompt(opts) {
    const langName = LANGUAGES[opts.language] || opts.language;
    const tsLabel = TIMESPANS[opts.timespan] || opts.timespan;
    const genreList = (opts.genres || ["drama"]).map(g => GENRES[g] || g).join(", ");
    const last = opts.stepCount;
    const tokenLine = opts.tokenBudget > 0 ? ("\n• Бюджет токенов на весь план: ~" + opts.tokenBudget + " токенов") : "";

    let p = [
        "[OOC: ЗАПРОС НА ГЕНЕРАЦИЮ СЮЖЕТА — мета-запрос вне ролевой игры.",
        "Не отвечай от лица персонажа. Выступи в роли сюжетного архитектора.",
        "",
        "На основе полного контекста — истории, профилей персонажей, лора и текущей ситуации — создай сюжетный план.",
        "",
        "Параметры:",
        "• Количество шагов: " + opts.stepCount,
        "• Временной охват: " + tsLabel,
        "• Жанры: " + genreList,
        "• Эпичность: " + opts.epicness + "/10 (1 = камерно, 10 = потрясение основ)",
        "• Реализм: " + opts.realism + "/10 (1 = фантастика, 10 = приземлённость)" + tokenLine,
    ];
    if (opts.customDirection && opts.customDirection.trim()) p.push("", "Направление от автора:", opts.customDirection.trim());
    p.push(
        "",
        "СТРУКТУРА ПЛАНА:",
        "",
        "Последний шаг (шаг " + last + ") — СЮЖЕТНЫЙ ПОВОРОТ (plot twist): неожиданное ключевое событие, которого не предвидят ни игрок, ни персонажи. Масштаб определяется временным охватом — поворот одного дня и поворот года это разные вещи, но в обоих случаях это должно быть по-настоящему неожиданно.",
        "",
        "Шаги 1–" + (last-1) + " — события, обстоятельства, случайные происшествия, которые наполняют жизнь персонажей в этот период. Они НЕ ОБЯЗАНЫ быть последовательной цепочкой. Как минимум 10% шагов — по-настоящему неожиданные события, НЕ вытекающие из предыдущей логики: случайности, совпадения, внешние вмешательства, появление новых лиц, неожиданные новости. Жизнь не алгоритм. Цель — разнообразие и насыщенность.",
        "",
        "АГЕНТНОСТЬ — ГЛАВНОЕ ПРАВИЛО:",
        "",
        "Шаги описывают ЧТО ПРОИСХОДИТ ВОКРУГ, а не КАК ПЕРСОНАЖИ РЕАГИРУЮТ.",
        "• Не предсказывай действия, слова, мысли или решения {{user}}.",
        "• Не предопределяй реакции, реплики или эмоции ключевых персонажей. Создавай обстоятельства, которые потребуют их реакции.",
        "• Можно описывать действия второстепенных персонажей, внешние события, поступающую информацию, изменения обстановки.",
        "",
        "КРИТИЧЕСКИ ВАЖНО: Все описания — ТОЛЬКО на " + langName + ".",
        "",
        "Формат — РОВНО " + opts.stepCount + " шагов:",
        "[STEP 1]: (описание ситуации на " + langName + ")",
        "...",
        "[STEP " + last + "]: (СЮЖЕТНЫЙ ПОВОРОТ на " + langName + ")",
        "",
        "Только шаги. Без преамбулы, комментариев, markdown.]",
    );
    return p.join("\n");
}

function parseSteps(text) {
    const steps = []; let m;
    const re = new RegExp(STEP_PARSE_RE.source, STEP_PARSE_RE.flags);
    while ((m = re.exec(text)) !== null) steps.push(m[2].trim());
    return steps;
}

// Shared generation with optional profile switch: switch → generate → switch back
async function generateWithProfile(prompt) {
    if (!generateQuietPrompt) throw new Error("generateQuietPrompt not available");
    const s = getSettings();

    if (!useCustomProfile()) {
        return await generateQuietPrompt(prompt, false);
    }

    const originalProfile = getCurrentProfileName();
    const targetProfile = s.genProfile;

    if (!originalProfile) {
        console.warn("[PD] No current profile detected — generating with target profile without switching back.");
    }

    try {
        console.log("[PD] Switching profile: " + originalProfile + " → " + targetProfile);
        await switchProfile(targetProfile);
        const result = await generateQuietPrompt(prompt, false);
        return result;
    } finally {
        if (originalProfile && originalProfile !== targetProfile) {
            try {
                console.log("[PD] Switching profile back to: " + originalProfile);
                await switchProfile(originalProfile);
            } catch(e) {
                console.error("[PD] Failed to switch back:", e);
                toastr.warning("Plot Director: failed to switch back to " + originalProfile + " — check your connection profile!");
            }
        }
    }
}

async function generatePlot(opts) {
    const prompt = buildGenerationPrompt(opts);
    try {
        const result = await generateWithProfile(prompt);
        if (!result) throw new Error("Empty response");
        const steps = parseSteps(result);
        if (steps.length === 0) {
            result.split(/\n/).filter(l => l.trim()).forEach(l => {
                const c = l.replace(/^\[?STEP\s*\d+\]?\s*:?\s*/i, "").trim();
                if (c) steps.push(c);
            });
        }
        if (steps.length === 0) throw new Error("Could not parse steps");
        savePlotData(newPlotData(steps, opts)); injectCurrentStep(); updatePanel();
        toastr.success("Plot Director: generated " + steps.length + " steps.");
        return steps;
    } catch (err) { toastr.error("Plot Director: " + err.message); console.error("[PD]", err); return null; }
}

async function regenerateTail() {
    const pd = getPlotData(); if (!pd || pd.currentIndex >= pd.steps.length) return;
    const done = pd.steps.slice(0, pd.currentIndex).map((s,i) => "[STEP "+(i+1)+"]: "+s.text).join("\n");
    const rem = pd.steps.length - pd.currentIndex;
    const opts = pd.genSettings || {};
    const lang = LANGUAGES[opts.language||"ko"]||"Korean";
    const prompt = [
        "[OOC: ПЕРЕГЕНЕРАЦИЯ СЮЖЕТА — мета-запрос вне ролевой игры.",
        "Ты — сюжетный архитектор. Завершённые шаги:", "", done, "",
        "На основе того, как история РЕАЛЬНО развилась, сгенерируй " + rem + " НОВЫХ шагов.",
        "Последний шаг — сюжетный поворот. Минимум 10% шагов — неожиданные события.",
        "Не предсказывай реакции {{user}} и ключевых персонажей — описывай ситуации.",
        "Все описания — ТОЛЬКО на " + lang + ".",
        "", "Формат:",
        ...Array.from({length:rem},(_,i)=>"[STEP "+(pd.currentIndex+i+1)+"]: (на "+lang+")"),
        "", "Только шаги.]",
    ].join("\n");
    try {
        const result = await generateWithProfile(prompt);
        if (!result) throw new Error("Empty");
        const ns = parseSteps(result); if (ns.length===0) throw new Error("Parse failed");
        pd.steps = [...pd.steps.slice(0,pd.currentIndex), ...ns.map(t=>({text:t,completed:false}))];
        savePlotData(pd); injectCurrentStep(); updatePanel();
        toastr.success("Plot Director: regenerated " + ns.length + " steps.");
    } catch(err) { toastr.error("PD regen: "+err.message); console.error("[PD]",err); }
}

// ── UI: Panel ────────────────────────────────────────────────

function buildPanelHTML() {
    return `
    <div id="plot_director_panel">
        <div class="inline-drawer">
            <div class="inline-drawer-toggle inline-drawer-header">
                <b>🎬 Plot Director</b>
                <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
            </div>
            <div class="inline-drawer-content">
                <div class="pd-status" id="pd_status">
                    <span class="pd-status-dot inactive" id="pd_status_dot"></span>
                    <span id="pd_status_text">No active plot</span>
                </div>
                <div class="pd-btn-row">
                    <div class="menu_button" id="pd_btn_generate"><i class="fa-solid fa-wand-magic-sparkles"></i> New</div>
                    <div class="menu_button" id="pd_btn_steps"><i class="fa-solid fa-list-ol"></i> Steps</div>
                    <div class="menu_button" id="pd_btn_regen"><i class="fa-solid fa-rotate"></i> Regen</div>
                </div>
                <div class="pd-btn-row">
                    <div class="menu_button" id="pd_btn_prev"><i class="fa-solid fa-backward-step"></i></div>
                    <div class="menu_button" id="pd_btn_next"><i class="fa-solid fa-forward-step"></i></div>
                    <div class="menu_button" id="pd_btn_clear"><i class="fa-solid fa-trash-can"></i> Clear</div>
                </div>
                <hr class="pd-divider">
                <div class="pd-toggle-row">
                    <input type="checkbox" id="pd_toggle_enabled"><label for="pd_toggle_enabled">Injection active</label>
                </div>
                <div class="pd-toggle-row">
                    <input type="checkbox" id="pd_toggle_autoregen"><label for="pd_toggle_autoregen">Auto-regenerate tail</label>
                </div>
                <hr class="pd-divider">
                <div style="font-size:0.8em;opacity:0.6;margin-bottom:4px;">Generation profile</div>
                <select id="pd_gen_profile" class="pd-profile-select">
                    <option value="">— Current connection —</option>
                </select>
                <p class="pd-note">Plot generation will temporarily switch to this profile, then switch back.</p>
            </div>
        </div>
    </div>`;
}

function updatePanel() {
    const pd = getPlotData(), s = getSettings();
    $("#pd_toggle_enabled").prop("checked", s.enabled);
    $("#pd_toggle_autoregen").prop("checked", s.autoRegenTail);
    const $d=$("#pd_status_dot"), $t=$("#pd_status_text");
    if (!pd||!pd.steps||!pd.steps.length) { $d.removeClass("active complete").addClass("inactive"); $t.text("No active plot"); }
    else if (pd.currentIndex>=pd.steps.length) { $d.removeClass("active inactive").addClass("complete"); $t.text("✓ All "+pd.steps.length+" steps complete"); }
    else { $d.removeClass("inactive complete").addClass("active"); $t.text("Step "+(pd.currentIndex+1)+" / "+pd.steps.length); }
}

// ── UI: Generate Modal ───────────────────────────────────────

function optTags(map,sel) { return Object.entries(map).map(([k,v])=>'<option value="'+k+'"'+(k===sel?' selected':'')+'>'+v+'</option>').join(""); }

async function showGenerateModal() {
    const s = getSettings();
    const sg = s.defaultGenres || ["drama"];
    const gcb = Object.entries(GENRES).map(([k,v])=>'<label><input type="checkbox" value="'+k+'"'+(sg.includes(k)?' checked':'')+'> '+v+'</label>').join("");

    const html = `
    <div class="pd-popup-content">
        <h3 style="margin-top:0;">🎬 Generate New Plot</h3>
        <div class="pd-field"><label>Number of steps</label><div class="pd-range-row"><input type="range" id="pd_gen_count" min="2" max="20" value="${s.defaultStepCount}"><span class="pd-range-val" id="pd_gen_count_val">${s.defaultStepCount}</span></div></div>
        <div class="pd-field"><label>Time span</label><select id="pd_gen_timespan">${optTags(TIMESPANS,s.defaultTimespan)}</select></div>
        <div class="pd-field"><label>Anti-spoiler language</label><select id="pd_gen_lang">${optTags(LANGUAGES,s.defaultLanguage)}</select></div>
        <div class="pd-field"><label>Genres</label><div class="pd-genre-grid" id="pd_gen_genres">${gcb}</div></div>
        <div class="pd-field"><label>Epicness</label><div class="pd-range-row"><input type="range" id="pd_gen_epic" min="1" max="10" value="${s.defaultEpicness}"><span class="pd-range-val" id="pd_gen_epic_val">${s.defaultEpicness}</span></div></div>
        <div class="pd-field"><label>Realism</label><div class="pd-range-row"><input type="range" id="pd_gen_real" min="1" max="10" value="${s.defaultRealism}"><span class="pd-range-val" id="pd_gen_real_val">${s.defaultRealism}</span></div></div>
        <div class="pd-field"><label>Token budget (0 = no limit)</label><input type="number" id="pd_gen_tokens" min="0" max="30000" step="500" value="${s.defaultTokenBudget}" class="pd-token-input"></div>
        <div class="pd-field"><label>Custom direction (optional)</label><textarea id="pd_gen_custom" placeholder="Направление сюжета, фокус на персонажах, конкретные события..."></textarea></div>
        <p class="pd-note">${useCustomProfile() ? "⚡ Generation profile: "+s.genProfile : "Uses current ST connection + full context."}</p>
    </div>`;

    const P = getPopupClass();
    if (!P) { toastr.error("Popup class not available."); return; }

    const popup = new P.Popup(html, P.POPUP_TYPE.CONFIRM, "", {
        okButton: "Generate",
        cancelButton: "Cancel",
        wide: false,
        allowVerticalScrolling: true,
        onOpen: () => {
            $("#pd_gen_count").on("input", function(){$("#pd_gen_count_val").text(this.value)});
            $("#pd_gen_epic").on("input", function(){$("#pd_gen_epic_val").text(this.value)});
            $("#pd_gen_real").on("input", function(){$("#pd_gen_real_val").text(this.value)});
        },
    });

    const result = await popup.show();
    if (!result) return; // cancelled

    // Collect values BEFORE popup DOM is removed — read from popup content
    const $c = $(popup.content || popup.dlg || document);
    const genres = [];
    $c.find("#pd_gen_genres input:checked").each(function(){genres.push($(this).val())});
    if (!genres.length) genres.push("drama");

    const opts = {
        stepCount: parseInt($c.find("#pd_gen_count").val()) || s.defaultStepCount,
        timespan: $c.find("#pd_gen_timespan").val() || s.defaultTimespan,
        language: $c.find("#pd_gen_lang").val() || s.defaultLanguage,
        genres,
        epicness: parseInt($c.find("#pd_gen_epic").val()) || s.defaultEpicness,
        realism: parseInt($c.find("#pd_gen_real").val()) || s.defaultRealism,
        tokenBudget: parseInt($c.find("#pd_gen_tokens").val()) || 0,
        customDirection: $c.find("#pd_gen_custom").val() || "",
    };

    s.defaultStepCount=opts.stepCount; s.defaultTimespan=opts.timespan;
    s.defaultLanguage=opts.language; s.defaultGenres=opts.genres;
    s.defaultEpicness=opts.epicness; s.defaultRealism=opts.realism;
    s.defaultTokenBudget=opts.tokenBudget;

    toastr.info("Plot Director: generating plot…");
    await generatePlot(opts);
}

// ── UI: Steps Modal (two views, native Popup) ────────────────

async function showStepsModal() {
    const pd = getPlotData();
    if (!pd || !pd.steps.length) { toastr.warning("No active plot."); return; }
    const lang = pd.genSettings?.language || "ko";
    const blur = ["en","ru"].includes(lang) ? "spoiler-blur" : "";

    const stepsHTML = pd.steps.map((step,i) => {
        const st = step.completed ? "completed" : i===pd.currentIndex ? "active" : "pending";
        return '<li class="pd-step-item '+st+'" data-step-index="'+i+'"><div class="pd-step-badge '+st+'">'+(i+1)+'</div><div class="pd-step-content"><div class="pd-step-text '+blur+'" data-step-index="'+i+'">'+esc(step.text)+'</div></div><div class="pd-step-actions"><button class="pd-step-edit-btn" data-step-index="'+i+'" title="Edit">✎</button><button class="pd-step-goto-btn" data-step-index="'+i+'" title="Go to">→</button></div></li>';
    }).join("");

    const rawText = pd.steps.map((s,i) => "[STEP "+(i+1)+"]: " + s.text).join("\n\n");

    const html = `
    <div class="pd-popup-content">
        <h3 style="margin-top:0;">📋 Plot Steps (${pd.currentIndex+1}/${pd.steps.length})</h3>
        <div class="pd-tabs">
            <span class="pd-tab active" data-tab="steps">Steps</span>
            <span class="pd-tab" data-tab="raw">Raw Text</span>
            <span class="pd-tab-spacer"></span>
            <span class="pd-tab" id="pd_steps_reveal_all" title="Toggle all spoilers"><i class="fa-solid fa-eye"></i></span>
        </div>
        <div class="pd-tab-content" id="pd_tab_steps">
            ${blur ? '<p class="pd-note">Click blurred text to reveal.</p>' : ""}
            <ul class="pd-step-list">${stepsHTML}</ul>
        </div>
        <div class="pd-tab-content" id="pd_tab_raw" style="display:none;">
            <textarea class="pd-raw-textarea" id="pd_raw_text">${esc(rawText)}</textarea>
            <div style="display:flex;gap:6px;margin-top:6px;">
                <div class="menu_button" id="pd_raw_copy" style="font-size:0.85em;"><i class="fa-solid fa-copy"></i> Copy</div>
                <div class="menu_button" id="pd_raw_save" style="font-size:0.85em;"><i class="fa-solid fa-floppy-disk"></i> Save edits</div>
            </div>
        </div>
    </div>`;

    const P = getPopupClass();
    if (!P) { toastr.error("Popup class not available."); return; }

    const popup = new P.Popup(html, P.POPUP_TYPE.TEXT, "", {
        okButton: "Close",
        wide: true,
        allowVerticalScrolling: true,
        onOpen: () => {
            const $root = $(popup.content || popup.dlg);

            // Tabs
            $root.find(".pd-tab[data-tab]").on("click", function() {
                $root.find(".pd-tab").removeClass("active"); $(this).addClass("active");
                $root.find(".pd-tab-content").hide();
                $root.find("#pd_tab_"+$(this).data("tab")).show();
            });

            // Spoiler toggle
            $root.find(".pd-step-text.spoiler-blur").on("click", function(){$(this).toggleClass("revealed")});
            $root.find("#pd_steps_reveal_all").on("click", function(){
                const $b=$root.find(".pd-step-text.spoiler-blur"), h=$b.not(".revealed").length>0;
                $b.toggleClass("revealed",h);
            });

            // Copy raw
            $root.find("#pd_raw_copy").on("click", function(){
                const t = $root.find("#pd_raw_text").val();
                navigator.clipboard.writeText(t).then(()=>toastr.info("Copied!")).catch(()=>{
                    $root.find("#pd_raw_text")[0].select(); document.execCommand("copy"); toastr.info("Copied!");
                });
            });

            // Save raw edits
            $root.find("#pd_raw_save").on("click", function(){
                const txt = $root.find("#pd_raw_text").val();
                const parsed = parseSteps(txt);
                if (parsed.length === 0) { toastr.error("Could not parse steps."); return; }
                const pd2 = getPlotData(); if (!pd2) return;
                pd2.steps = parsed.map((t,i) => ({ text: t, completed: pd2.steps[i] ? pd2.steps[i].completed : false }));
                if (pd2.currentIndex >= pd2.steps.length) pd2.currentIndex = pd2.steps.length - 1;
                savePlotData(pd2); injectCurrentStep(); updatePanel();
                popup.complete(1); showStepsModal();
                toastr.success("Steps updated (" + parsed.length + " steps).");
            });

            // Edit step
            $root.find(".pd-step-edit-btn").on("click", function(){
                const idx=parseInt($(this).data("step-index"));
                const $c=$(this).closest(".pd-step-item").find(".pd-step-content"), $t=$c.find(".pd-step-text");
                if ($c.find(".pd-step-edit-area").length) return;
                $t.hide();
                $c.append('<textarea class="pd-step-edit-area">'+esc(pd.steps[idx].text)+'</textarea><div style="display:flex;gap:4px;margin-top:4px;"><button class="pd-step-save-btn menu_button" style="font-size:0.8em;padding:2px 8px;">Save</button><button class="pd-step-cancel-btn" style="font-size:0.8em;padding:2px 8px;background:none;border:1px solid rgba(255,255,255,0.15);color:inherit;border-radius:3px;cursor:pointer;">Cancel</button></div>');
                $c.find(".pd-step-save-btn").on("click",function(){
                    const v=$c.find(".pd-step-edit-area").val().trim();
                    if(v){pd.steps[idx].text=v;savePlotData(pd);if(idx===pd.currentIndex)injectCurrentStep();}
                    popup.complete(1); showStepsModal();
                });
                $c.find(".pd-step-cancel-btn").on("click",function(){$c.find(".pd-step-edit-area,div:last-child").remove();$t.show();});
            });

            // Go-to step
            $root.find(".pd-step-goto-btn").on("click", function(){
                const idx=parseInt($(this).data("step-index")), p=getPlotData(); if(!p)return;
                p.steps.forEach((s,i)=>{s.completed=i<idx}); p.currentIndex=idx; p.lastAdvancedMsg=-1;
                savePlotData(p);injectCurrentStep();updatePanel();
                popup.complete(1); showStepsModal();
                toastr.info("Jumped to step "+(idx+1)+".");
            });
        },
    });

    await popup.show();
}

// ── Utility ──────────────────────────────────────────────────

function esc(s) { const d=document.createElement("div"); d.textContent=s; return d.innerHTML; }

// ── Init ─────────────────────────────────────────────────────

export function initDirector() {
    getSettings();

    // Panel
    $("#extensions_settings2").append(buildPanelHTML());

    // Populate profile dropdown
    function refreshProfileDropdown() {
        const $sel = $("#pd_gen_profile");
        const cur = getSettings().genProfile || "";
        const profiles = getConnectionProfiles();
        $sel.empty().append('<option value="">— Current connection —</option>');
        profiles.forEach(name => {
            $sel.append('<option value="' + name.replace(/"/g, "&quot;") + '"' + (name === cur ? " selected" : "") + '>' + name + '</option>');
        });
    }
    refreshProfileDropdown();

    $("#pd_gen_profile")
        .on("focus", refreshProfileDropdown) // re-read list on open
        .on("change", function(){ getSettings().genProfile = $(this).val(); });

    // Add to extensions dropdown menu (the right wand icon)
    const $menuItem = $('<div id="pd_menu_item" class="list-group-item flex-container flexGap5"><div class="fa-solid fa-clapperboard extensionsMenuExtensionButton"></div>Plot Director</div>');
    $menuItem.on("click", () => {
        const pd = getPlotData();
        if (pd && pd.steps.length) showStepsModal(); else showGenerateModal();
    });
    $("#extensionsMenu").append($menuItem);

    // Panel buttons
    $("#pd_btn_generate").on("click",()=>{ const p=getPlotData(); if(p&&p.steps.length&&!confirm("Replace existing plot?"))return; showGenerateModal(); });
    $("#pd_btn_steps").on("click", showStepsModal);
    $("#pd_btn_regen").on("click", async()=>{ const p=getPlotData(); if(!p||!p.steps.length){toastr.warning("No plot.");return;} if(p.currentIndex>=p.steps.length){toastr.warning("All done.");return;} toastr.info("Regenerating…"); await regenerateTail(); });
    $("#pd_btn_prev").on("click",()=>{ const p=getPlotData(); if(!p||p.currentIndex<=0){toastr.warning("At step 1.");return;} rollbackStep(); toastr.info("Rolled back to step "+(getPlotData().currentIndex+1)+"."); });
    $("#pd_btn_next").on("click",()=>{ const p=getPlotData(); if(!p||!p.steps.length){toastr.warning("No plot.");return;} if(p.currentIndex>=p.steps.length){toastr.warning("All done.");return;} advanceStep(-1); });
    $("#pd_btn_clear").on("click",()=>{ if(!confirm("Clear plot?"))return; clearPlotData(); updatePanel(); toastr.info("Plot cleared."); });
    $("#pd_toggle_enabled").on("change",function(){getSettings().enabled=this.checked;injectCurrentStep()});
    $("#pd_toggle_autoregen").on("change",function(){getSettings().autoRegenTail=this.checked});

    // Events
    if (eventSource && event_types) {
        eventSource.on(event_types.MESSAGE_RECEIVED, idx=>onMessageReceived(idx));
        eventSource.on(event_types.MESSAGE_SWIPED, idx=>onMessageSwiped(idx));
        eventSource.on(event_types.CHAT_CHANGED, ()=>onChatChanged());
        // Prompt interception — the core injection mechanism
        if (event_types.CHAT_COMPLETION_PROMPT_READY) {
            eventSource.on(event_types.CHAT_COMPLETION_PROMPT_READY, data=>onPromptReady(data));
            console.log("[PD] Prompt interception registered (CHAT_COMPLETION_PROMPT_READY).");
        } else {
            console.error("[PD] CHAT_COMPLETION_PROMPT_READY not found in event_types! Available:", Object.keys(event_types).filter(k=>k.includes("PROMPT")));
        }
    }
    onChatChanged();
    console.log("[PD] Director module loaded.");
}
