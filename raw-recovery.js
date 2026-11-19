/**
 * Recover usable room descriptions from responses Estate already checkpointed.
 * Pure parsing only: no API calls and no World Info changes.
 */
function readField(text, key) {
    const source = String(text || '');
    const needle = new RegExp('"' + key + '"\\s*:\\s*"', 'i');
    const match = needle.exec(source);
    if (!match) return '';
    let raw = '';
    let escaped = false;
    for (let i = match.index + match[0].length; i < source.length; i++) {
        const ch = source[i];
        if (ch === '"' && !escaped) break;
        raw += ch;
        if (ch === '\\' && !escaped) escaped = true;
        else escaped = false;
    }
    if (!raw) return '';
    if (raw.endsWith('\\')) raw = raw.slice(0, -1);
    try { return JSON.parse('"' + raw + '"').trim(); }
    catch {
        // A response cut inside a quoted value can still contain prose.
        return raw.replace(/\\"/g, '"').replace(/\\n/g, '\n')
            .replace(/\\t/g, ' ').replace(/\\\\/g, '\\').trim();
    }
}
export function recoverRawReply(text, expected, tools) {
    const parsed = tools.extractJson(text);
    const normalized = parsed.ok
        ? tools.normalizeEntries(parsed.value, {
            englishOnly: tools.englishOnly, names: tools.names || [],
        })
        : { ok: false, error: parsed.error };
    if (normalized.ok) return tools.reconcileCoverage(normalized, expected);
    // A single room's truncated JSON can retain enough content for review.
    if (expected.length === 1 && typeof text === 'string') {
        const content = readField(text, 'content');
        if (content.length >= 20) {
            const room = expected[0];
            const entry = {
                title: (readField(text, 'title') || (room === 'whole' ? 'Home' : room)).slice(0, 120),
                room, content: content.slice(0, 30000),
                visual: readField(text, 'visual').slice(0, 1200),
                keys: [],
            };
            return tools.reconcileCoverage({ ok: true, entries: [entry], keyless: 1 }, expected);
        }
        // Never mistake broken JSON, especially a fenced JSON response, for
        // normal room prose just because its final brackets are missing.
        const stripped = text.trim().replace(/^\x60{3}(?:json|javascript)?\s*/i, '').trim();
        if (!/^[\[{]/.test(stripped) && !/"entries"\s*:/.test(text)) {
            const prose = tools.plainTextEntry(text, expected);
            if (prose) return { ok: true, entries: [prose], missing: [], keyless: 0 };
        }
    }
    return { ok: false, error: normalized.error || 'No usable entry in saved response' };
}
