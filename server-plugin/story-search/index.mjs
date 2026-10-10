/**
 * Story Search — server plugin for SillyTavern (part of Story Toolkit).
 *
 * Keyword search across every chat of every character and group. The chat
 * archive is hundreds of megabytes, far too much to ship to the browser, so
 * the scan runs here and returns only the matches.
 *
 * Branches copy the whole history up to the branch point, so one message
 * usually lives in many files. Matches are grouped by message text: one hit,
 * with every place it occurs.
 *
 * POST /api/plugins/story-search/search
 *   { query: 'поцел "под дождём"', limit: 100 }
 * ->{ hits: [{ text, name, isUser, date, places: [{ kind, folder|groupId, file, mesId }] }],
 *     total, truncated, files, ms }
 *
 * Query: a bare word matches at the start of a word ("поцел" finds "поцелуй");
 * anything in quotes matches as whole words ("кот" finds «кот», not
 * «который»); all parts must be present. Case is ignored and ё equals е.
 */
import fs from 'node:fs';
import path from 'node:path';

export const info = {
    id: 'story-search',
    name: 'Story Search',
    description: 'Keyword search across all chats (Story Toolkit).',
};

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;
const MAX_TERMS = 12;

/** Lowercase and fold ё into е, so both spellings match each other. */
function norm(s) {
    return String(s).toLowerCase().replace(/ё/g, 'е');
}

function escapeRegex(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 'поцел "под дождём"' -> [{ text: 'поцел', whole: false }, { text: 'под дождем', whole: true }] */
function parseQuery(query) {
    const terms = new Map();
    const re = /"([^"]+)"|(\S+)/g;
    let m;
    while ((m = re.exec(norm(query))) !== null) {
        const text = (m[1] ?? m[2]).replace(/\s+/g, ' ').trim();
        if (text) terms.set(text + (m[1] != null ? '\0' : ''), { text, whole: m[1] != null });
    }
    return [...terms.values()].slice(0, MAX_TERMS);
}

/**
 * Every term starts at a word boundary; a quoted one also ends at one, so
 * "кот" does not find «который». JavaScript's \b is ASCII-only and useless for
 * Cyrillic, hence the explicit letter/digit lookarounds.
 */
function termRegex({ text, whole }) {
    return new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegex(text)}${whole ? '(?![\\p{L}\\p{N}])' : ''}`, 'u');
}

/**
 * Cheap pre-filter on the raw JSON line, before parsing it: case-insensitive,
 * е/ё-tolerant, no word boundary. Most lines fail here and are never parsed.
 */
function rawRegex(term) {
    const body = escapeRegex(term).replace(/е/g, '[её]');
    return new RegExp(body, 'iu');
}

/**
 * send_date is ISO in current SillyTavern, but older chats carry the humanized
 * form 'November 27, 2025 1:01pm', which Date.parse rejects for the missing
 * space before am/pm. Unknown dates sort last.
 */
function parseDate(value) {
    if (typeof value === 'number') return value;
    const s = String(value || '');
    let t = Date.parse(s);
    if (Number.isNaN(t)) t = Date.parse(s.replace(/(\d)\s*(am|pm)$/i, '$1 $2'));
    return Number.isNaN(t) ? 0 : t;
}

function listChatFiles(dirs) {
    const files = [];
    if (fs.existsSync(dirs.chats)) {
        for (const folder of fs.readdirSync(dirs.chats, { withFileTypes: true })) {
            if (!folder.isDirectory()) continue;
            const dir = path.join(dirs.chats, folder.name);
            for (const f of fs.readdirSync(dir)) {
                if (f.endsWith('.jsonl')) files.push({ kind: 'char', folder: folder.name, file: f, full: path.join(dir, f) });
            }
        }
    }
    // Group chats are flat files named by chat id; the group owning each id is in groups/*.json.
    const owner = new Map();
    if (fs.existsSync(dirs.groups)) {
        for (const g of fs.readdirSync(dirs.groups)) {
            if (!g.endsWith('.json')) continue;
            try {
                const data = JSON.parse(fs.readFileSync(path.join(dirs.groups, g), 'utf8'));
                for (const chatId of data.chats || []) owner.set(String(chatId), { groupId: data.id, groupName: data.name });
            } catch { /* a broken group file is not our problem */ }
        }
    }
    if (fs.existsSync(dirs.groupChats)) {
        for (const f of fs.readdirSync(dirs.groupChats)) {
            if (!f.endsWith('.jsonl')) continue;
            const g = owner.get(f.slice(0, -'.jsonl'.length));
            if (g) files.push({ kind: 'group', ...g, file: f, full: path.join(dirs.groupChats, f) });
        }
    }
    return files;
}

function search(dirs, query, limit) {
    const started = Date.now();
    const terms = parseQuery(query);
    if (!terms.length) return { hits: [], total: 0, truncated: false, files: 0, ms: 0 };

    const exact = terms.map(termRegex);
    // Pre-filter on the longest term: the rarest one, most likely to reject a line.
    const longest = terms.reduce((a, b) => (b.text.length > a.text.length ? b : a));
    const raw = rawRegex(longest.text);

    const files = listChatFiles(dirs);
    /** normalized text -> hit */
    const byText = new Map();

    for (const f of files) {
        let content;
        try {
            content = fs.readFileSync(f.full, 'utf8');
        } catch {
            continue;
        }
        let mesId = -1;
        for (const line of content.split('\n')) {
            if (!line) continue;
            // The first line of a chat file is its metadata header, not a message.
            if (mesId === -1 && line.startsWith('{"chat_metadata"')) continue;
            if (line.startsWith('{"user_name"') && mesId === -1) continue;
            mesId++;
            if (!raw.test(line)) continue;

            let msg;
            try {
                msg = JSON.parse(line);
            } catch {
                continue;
            }
            const text = String(msg.mes ?? '');
            const n = norm(text);
            if (!exact.every((re) => re.test(n))) continue;

            const place = f.kind === 'char'
                ? { kind: 'char', folder: f.folder, file: f.file, mesId }
                : { kind: 'group', groupId: f.groupId, groupName: f.groupName, file: f.file, mesId };
            const date = parseDate(msg.send_date);
            let hit = byText.get(n);
            if (!hit) {
                hit = { text, name: msg.name || '', isUser: !!msg.is_user, date, places: [] };
                byText.set(n, hit);
            }
            hit.places.push(place);
            if (date > hit.date) hit.date = date;
        }
    }

    // Newest first; within a hit, the place in the most recently written file first.
    const hits = [...byText.values()].sort((a, b) => b.date - a.date);
    for (const h of hits) {
        h.places.sort((a, b) => b.file.localeCompare(a.file));
    }
    return {
        hits: hits.slice(0, limit),
        total: hits.length,
        truncated: hits.length > limit,
        files: files.length,
        terms,
        ms: Date.now() - started,
    };
}

export async function init(router) {
    router.post('/search', async (request, response) => {
        try {
            const query = String(request.body?.query || '').trim();
            if (!query) return response.status(400).json({ error: 'query is required' });
            const limit = Math.min(MAX_LIMIT, Math.max(1, Number(request.body?.limit) || DEFAULT_LIMIT));
            return response.json(search(request.user.directories, query, limit));
        } catch (error) {
            console.error('[story-search]', error);
            return response.status(500).json({ error: String(error?.message || error) });
        }
    });
    console.log('[story-search] plugin loaded');
}

export async function exit() {}
