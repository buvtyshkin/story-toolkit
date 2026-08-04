// ============================================================
//  Story Toolkit — unified Fisher Universe extension
//
//  Modules:
//    🎬 Director — пошаговый сюжетный план (ex Plot Director)
//    🔥 Forge    — генерация вариантов вне чата (ex Story Forge)
//    📚 Archive  — глобальное хранилище фрагментов (ex Story Archive)
//    🧭 Guide    — направляемый ответ с жизненным циклом (новый)
//
//  Миграция: при первом запуске данные копируются из старых
//  расширений (plot-director, story-forge, story-archive).
//  Старые расширения после этого нужно удалить вручную!
// ============================================================

import { extension_settings, patchFromContext, toolkitSettings, saveSettings, EXT_NAME } from "./st.js";
import { initDirector } from "./director.js";
import { initForge } from "./forge.js";
import { initArchive } from "./archive.js";
import { initGuide } from "./guide.js";

const DEFAULT_MODULES = {
    director: true,
    forge: true,
    archive: true,
    guide: true,
};

// ── Settings & migration ─────────────────────────────────────

function loadToolkitSettings() {
    const t = toolkitSettings();
    if (!t.modules) t.modules = { ...DEFAULT_MODULES };
    for (const k of Object.keys(DEFAULT_MODULES)) {
        if (typeof t.modules[k] !== "boolean") t.modules[k] = DEFAULT_MODULES[k];
    }
    return t;
}

function migrateLegacy() {
    const t = toolkitSettings();
    if (t.migrated) return;

    const report = [];

    // ── Story Forge → forge ──
    try {
        const old = extension_settings["story-forge"];
        if (old && !t.forge) {
            t.forge = structuredClone(old);
            delete t.forge.generations;
            delete t.forge.currentGenIndex;
            report.push(`Forge: кнопки (${old.buttons?.length ?? 0}), архив (${old.archive?.length ?? 0})`);
        }
    } catch (e) {
        console.warn(`[${EXT_NAME}] Forge migration error:`, e);
    }

    // ── Story Archive (st-crud) → archive ──
    try {
        const old = extension_settings["story-archive"];
        if (old?.entries?.length && !t.archive) {
            t.archive = { entries: structuredClone(old.entries) };
            report.push(`Archive: записей (${old.entries.length})`);
        }
    } catch (e) {
        console.warn(`[${EXT_NAME}] Archive migration error:`, e);
    }

    // ── Plot Director → director ──
    // Per-chat планы живут в chat_metadata.plot_director — ключ сохранён,
    // мигрировать их не нужно. Копируем только глобальные настройки и
    // резервные копии планов из extension_settings.
    try {
        const old = extension_settings["plot-director"];
        if (old && !t.director) {
            t.director = structuredClone(old);
            const plotCount = old.plots ? Object.keys(old.plots).length : 0;
            report.push(`Director: настройки${plotCount ? `, резервных планов (${plotCount})` : ""}`);
        }
    } catch (e) {
        console.warn(`[${EXT_NAME}] Director migration error:`, e);
    }

    t.migrated = true;
    saveSettings();

    if (report.length) {
        console.log(`[${EXT_NAME}] Migrated legacy data:\n  ` + report.join("\n  "));
        toastr.success(
            "Данные перенесены:<br>" + report.join("<br>") +
            "<br><br>⚠️ Удалите старые расширения (Plot Director, Story Forge, Story Archive), чтобы избежать дублей!",
            "🧰 Story Toolkit",
            { timeOut: 15000, escapeHtml: false }
        );
    }
}

// ── Legacy duplicates warning ────────────────────────────────

function warnIfLegacyStillActive() {
    // Если старые расширения всё ещё установлены, их панели будут в DOM
    setTimeout(() => {
        const dupes = [];
        // Наши модули используют те же id/классы панелей, что и легаси-версии,
        // поэтому дубликат = элементов больше одного.
        if (document.querySelectorAll("#plot_director_panel").length > 1) dupes.push("Plot Director");
        if (document.querySelectorAll(".story-forge-settings").length > 1) dupes.push("Story Forge");
        if (document.querySelectorAll(".story-archive-settings").length > 1) dupes.push("Story Archive");
        if (dupes.length) {
            toastr.warning(
                "Обнаружены старые копии: " + dupes.join(", ") +
                ". Удалите их в Manage Extensions — иначе панели и инжекции будут дублироваться.",
                "🧰 Story Toolkit",
                { timeOut: 15000 }
            );
        }
    }, 2000);
}

// ── Master panel ─────────────────────────────────────────────

const MODULE_LABELS = {
    director: "🎬 Director — сюжетный план",
    forge: "🔥 Forge — генерация вариантов",
    archive: "📚 Archive — хранилище фрагментов",
    guide: "🧭 Guide — направляемый ответ",
};

function createMasterPanel() {
    const t = toolkitSettings();
    const rows = Object.entries(MODULE_LABELS)
        .map(
            ([key, label]) => `
        <label class="stk-module-row">
            <input type="checkbox" data-module="${key}" ${t.modules[key] ? "checked" : ""}>
            <span>${label}</span>
        </label>`
        )
        .join("");

    const html = `
    <div class="story-toolkit-settings">
        <div class="inline-drawer">
            <div class="inline-drawer-toggle inline-drawer-header">
                <b>🧰 Story Toolkit</b>
                <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
            </div>
            <div class="inline-drawer-content">
                <div class="stk-section">
                    ${rows}
                    <p class="stk-note">Включение/выключение модулей применяется после перезагрузки страницы (Ctrl+F5).</p>
                </div>
            </div>
        </div>
    </div>`;

    document.getElementById("extensions_settings2").insertAdjacentHTML("beforeend", html);

    document.querySelectorAll(".story-toolkit-settings input[data-module]").forEach((cb) => {
        cb.addEventListener("change", () => {
            toolkitSettings().modules[cb.dataset.module] = cb.checked;
            saveSettings();
            toastr.info("Перезагрузите страницу, чтобы применить (Ctrl+F5)");
        });
    });
}

// ── Init ─────────────────────────────────────────────────────

jQuery(async () => {
    if (!patchFromContext()) return;

    const t = loadToolkitSettings();
    migrateLegacy();
    createMasterPanel();

    const modules = [
        ["director", initDirector],
        ["forge", initForge],
        ["archive", initArchive],
        ["guide", initGuide],
    ];

    for (const [name, init] of modules) {
        if (!t.modules[name]) {
            console.log(`[${EXT_NAME}] Module "${name}" disabled — skipping.`);
            continue;
        }
        try {
            init();
        } catch (e) {
            console.error(`[${EXT_NAME}] Module "${name}" failed to init:`, e);
            toastr.error(`Story Toolkit: модуль ${name} не запустился (${e.message})`);
        }
    }

    warnIfLegacyStillActive();
    console.log(`[${EXT_NAME}] Story Toolkit loaded.`);
});
