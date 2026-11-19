/**
 * Estate recovery checkpoints (device-local, per character/chat).
 *
 * They are deliberately independent of World Info: a failed World Info save
 * must not also destroy the generated draft. No network requests are made.
 * Raw returned text is checkpointed BEFORE parsing so malformed JSON remains
 * available to the person who paid for the generation.
 */

const PREFIX = 'ST-Estate:recovery:v1:';
const MAX_RAW = 20;
const MAX_RAW_CHARS = 100000;
let memoryKey = '';
let memoryDraft = null;

export function draftKey(ctx) {
    const avatar = ctx.characters?.[ctx.characterId]?.avatar || '';
    const chatId = ctx.getCurrentChatId?.() ?? ctx.chatId ?? '';
    return PREFIX + encodeURIComponent(JSON.stringify([String(ctx.characterId ?? ''), String(avatar), String(chatId)]));
}

export function loadDraft(ctx) {
    const key = draftKey(ctx);
    if (memoryKey === key && memoryDraft) return structuredClone(memoryDraft);
    try {
        const saved = JSON.parse(localStorage.getItem(key) || 'null');
        if (saved?.version === 1 && Array.isArray(saved.entries) && Array.isArray(saved.jobs)) {
            memoryKey = key;
            memoryDraft = saved;
            return structuredClone(saved);
        }
    } catch (error) {
        console.warn('[Estate] recovery read failed', error);
    }
    return null;
}

export function saveDraft(ctx, draft) {
    const key = draftKey(ctx);
    const copy = structuredClone({ ...draft, updatedAt: Date.now() });
    copy.version = 1;
    copy.raws = (copy.raws || []).slice(-MAX_RAW).map(item => ({
        ...item,
        text: String(item.text || '').slice(0, MAX_RAW_CHARS),
    }));
    memoryKey = key;
    memoryDraft = copy;
    try {
        localStorage.setItem(key, JSON.stringify(copy));
        return true;
    } catch (error) {
        // Retain the in-memory copy for this session, but never claim a
        // reload-safe checkpoint if browser storage is unavailable or full.
        console.error('[Estate] recovery storage unavailable', error);
        return false;
    }
}

export function clearDraft(ctx) {
    const key = draftKey(ctx);
    if (memoryKey === key) { memoryKey = ''; memoryDraft = null; }
    try { localStorage.removeItem(key); } catch (error) { console.warn('[Estate] recovery cleanup', error); }
}

export function noteRaw(draft, id, reply) {
    let text = '';
    try { text = typeof reply === 'string' ? reply : JSON.stringify(reply, null, 2); }
    catch { text = String(reply); }
    if (!text.trim()) return;
    draft.raws ||= [];
    draft.raws = [...draft.raws.filter(item => item.id !== id), {
        id, text: text.slice(0, MAX_RAW_CHARS), time: Date.now(),
    }].slice(-MAX_RAW);
}

export function countPending(draft) {
    if (!draft?.jobs) return 0;
    // `tasks` is the immutable list of requested chunks. `completed` contains
    // only fully covered tasks, so even partially returned batches are resumable.
    return (draft.tasks || []).filter(task => !(draft.completed || []).includes(task.id)).length;
}
