// ============================================================
//  Story Toolkit — shared utilities
// ============================================================

export const uid = () =>
    Date.now().toString(36) + Math.random().toString(36).substr(2, 6);

export function escHtml(s) {
    const d = document.createElement("div");
    d.textContent = s;
    return d.innerHTML;
}

export async function copyToClipboard(text, toastMsg = "Скопировано") {
    try {
        await navigator.clipboard.writeText(text);
    } catch {
        const t = document.createElement("textarea");
        t.value = text;
        t.style.cssText = "position:fixed;opacity:0";
        document.body.appendChild(t);
        t.select();
        document.execCommand("copy");
        document.body.removeChild(t);
    }
    if (toastMsg) toastr.success(toastMsg);
}

/** Add an item to the extensions wand menu. Returns the jQuery element. */
export function addWandMenuItem(id, faIcon, label, onClick) {
    $(`#${id}`).remove();
    const $item = $(
        `<div id="${id}" class="list-group-item flex-container flexGap5">` +
        `<div class="fa-solid ${faIcon} extensionsMenuExtensionButton"></div>` +
        `<span>${label}</span></div>`
    );
    $item.on("click", onClick);
    $("#extensionsMenu").append($item);
    return $item;
}
