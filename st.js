// ============================================================
//  Story Toolkit — shared SillyTavern API access point
//  All ST imports live here; modules import from this file only.
// ============================================================

import * as ExtModule from "../../../extensions.js";
import * as ScriptModule from "../../../../script.js";

export const extension_settings = ExtModule.extension_settings;
export const getContext = ExtModule.getContext;

// These may be undefined depending on ST version — patched below.
export let setExtensionPrompt = ExtModule.setExtensionPrompt;
export let eventSource = ScriptModule.eventSource;
export let event_types = ScriptModule.event_types;
export let generateQuietPrompt = ScriptModule.generateQuietPrompt;
export let saveChatDebounced = ScriptModule.saveChatDebounced;

export const EXT_NAME = "story-toolkit";

/**
 * Fill in anything the static imports didn't resolve, using getContext().
 * Returns false only if getContext itself is unavailable.
 */
export function patchFromContext() {
    if (!getContext) {
        console.error(`[${EXT_NAME}] No getContext — cannot initialize.`);
        return false;
    }
    const ctx = getContext();
    if (!setExtensionPrompt) setExtensionPrompt = ctx.setExtensionPrompt;
    if (!eventSource) eventSource = ctx.eventSource;
    if (!event_types) event_types = ctx.event_types;
    if (!generateQuietPrompt) generateQuietPrompt = ctx.generateQuietPrompt;
    if (!saveChatDebounced) saveChatDebounced = ctx.saveChatDebounced || ctx.saveChat;

    const missing = [];
    if (!setExtensionPrompt) missing.push("setExtensionPrompt");
    if (!eventSource) missing.push("eventSource");
    if (!event_types) missing.push("event_types");
    if (missing.length) console.warn(`[${EXT_NAME}] Missing:`, missing.join(", "));
    else console.log(`[${EXT_NAME}] All ST functions resolved.`);
    return true;
}

/** Toolkit settings root: extension_settings["story-toolkit"] */
export function toolkitSettings() {
    if (!extension_settings[EXT_NAME]) extension_settings[EXT_NAME] = {};
    return extension_settings[EXT_NAME];
}

export function saveSettings() {
    const ctx = getContext();
    if (typeof ctx.saveSettingsDebounced === "function") {
        ctx.saveSettingsDebounced();
    }
}

/** Native ST Popup class (for modules that use it) */
export function getPopupClass() {
    try {
        const ctx = getContext();
        if (ctx.Popup) return { Popup: ctx.Popup, POPUP_TYPE: ctx.POPUP_TYPE };
    } catch (e) {}
    try {
        if (typeof SillyTavern !== "undefined" && SillyTavern.getContext) {
            const c = SillyTavern.getContext();
            if (c.Popup) return { Popup: c.Popup, POPUP_TYPE: c.POPUP_TYPE };
        }
    } catch (e) {}
    return null;
}
