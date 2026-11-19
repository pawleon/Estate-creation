/**
 * Estate for SillyTavern — entry point.
 *
 * Flow: pick tags → generate JSON → review and edit → write lorebook entries.
 */

import { is_send_press } from '/script.js';
import { user_avatar } from '../../../personas.js';
import { snapshotContext, sameChat, normalizeId, continuity, revisionInstruction } from './workflow.js';
import { paintIcons } from './icon.js';
import { t } from './i18n.js';
import { buildRequest, extractJson, normalizeEntries, planChunks } from './prompt.js';
import { openPreview } from './preview.js';
import { buildLorebookName, DEPTH, ORDER, readBoundLore, writeEntries } from './lorebook.js';
import { defaultNameTemplate, defaultSectionState, getBrief, getSettings, resolveProfileId, saveBrief, saveSettings } from './settings.js';
import { buildSuggestRequest, normalizeSuggestions } from './suggest.js';
import { mountUi, openDialog, unmountUi } from './ui.js';
import { loadDraft, saveDraft, clearDraft, noteRaw, countPending } from './recovery.js';
import { button, node, textarea } from './dom.js';

const EXT_PATH = new URL('.', import.meta.url).pathname.replace(/\/$/, '');
const TAG = 'Estate';
const SETTINGS_SELECTOR = '.estate-settings';

/** i18n keys naming each binding target, for the confirmation toast. */
const BIND_LABEL = Object.freeze({
    chat: 'bindCharacter', // Legacy binding requests use the auxiliary list.
    character: 'bindCharacter',
    persona: 'bindPersona',
    none: 'bindNone',
});

let inFlight = false;
let activeAbort = null;
let activeUsesProfile = false;

const warn = (scope, error) => console.warn(`[${TAG}] ${scope}`, error);

/**
 * State of the run in progress, published rather than handed to the dialog.
 *
 * Generation outlives the dialog: closing the window has to leave the request
 * running, and reopening it has to find the run still there. That only works
 * if the progress lives here and the dialog merely subscribes to it.
 *
 * `phase` separates the halves of a run. Waiting on the model is timed and can
 * be stopped; the review popup that follows is neither, but it still holds the
 * extension busy, so a second run cannot start behind it.
 */
const runState = {
    phase: 'idle',
    startedAt: 0,
    done: 0,
    total: 1,
    stage: '',
};

/** @type {Set<(state: object) => void>} */
const runListeners = new Set();

function publish(patch = {}) {
    Object.assign(runState, patch);
    const snapshot = { ...runState };
    for (const listener of [...runListeners]) {
        try {
            listener(snapshot);
        } catch (error) {
            warn('run listener', error);
        }
    }
}

/**
 * Watch the current run. The listener is called immediately with the state as
 * it stands, so a dialog opened mid-run shows the right thing at once.
 *
 * @param {(state: {phase: string, startedAt: number, done: number, total: number, stage: string}) => void} listener
 * @returns {() => void} unsubscribe
 */
function subscribeRun(listener) {
    runListeners.add(listener);
    listener({ ...runState });
    return () => runListeners.delete(listener);
}

/** Aborts and cancellations arrive under several names; treat them alike. */
function isCancellation(error) {
    for (let current = error, depth = 0; current && depth < 5; current = current.cause, depth++) {
        if (current.name === 'AbortError') return true;
        if (/cancel|abort|stop/i.test(String(current.message || current || ''))) return true;
    }
    return false;
}

function cancelGeneration() {
    if (!inFlight) return false;
    activeAbort?.abort(new DOMException('Cancelled by user', 'AbortError'));
    if (!activeUsesProfile) SillyTavern.getContext().stopGeneration?.();
    return true;
}

async function generateViaMainApi(ctx, request) {
    const reply = await ctx.generateRaw({
        prompt: request.prompt,
        responseLength: request.responseLength,
        trimNames: false,
        // With a schema, SillyTavern hands back the JSON string the provider
        // was constrained to produce, rather than whatever the model felt
        // like typing around it.
        jsonSchema: request.jsonSchema || undefined,
    });
    return typeof reply === 'string' ? reply : reply ?? '';
}

async function generateViaProfile(ctx, profileId, request, signal) {
    const service = ctx.ConnectionManagerRequestService;
    if (!service) throw new Error('Connection Manager is not available.');

    // `sendRequest` forwards anything in the override payload straight into
    // the completion body, which is the only way a schema reaches a profile.
    const overrides = request.jsonSchema ? { json_schema: request.jsonSchema } : {};
    const result = await service.sendRequest(profileId, request.prompt, request.responseLength, {
        stream: false,
        extractData: true,
        includePreset: true,
        signal,
    }, overrides);
    // Do not discard a reply that arrived just as Stop was pressed.
    // The outer generation function checkpoints the raw response first.

    // A schema-constrained reply comes back parsed; everything else is text.
    const content = result?.content;
    return content && typeof content === 'object' ? content : String(content || '');
}

async function runGeneration(ctx, settings, profileId, options) {
    const request = buildRequest(settings, { ...options, context: ctx });
    const reply = profileId
        ? await generateViaProfile(ctx, profileId, request, activeAbort.signal)
        : await generateViaMainApi(ctx, request);
    // Checkpoint the provider's reply before a late Stop/Abort can discard it.
    options.onReply?.(reply);
    activeAbort.signal.throwIfAborted();
    return { reply, request };
}

/**
 * Whether a failure is the provider refusing a structured-output request.
 *
 * Not every backend takes a schema, and the ones that do not say so in a
 * dozen different ways. Rather than keep a list of which providers support
 * what — a list that would be wrong within a month — the schema is tried and
 * the refusal is read.
 */
function isSchemaRejection(error) {
    const text = [error?.message, error?.error?.message, error?.cause?.message, error?.responseText]
        .map(value => String(value || ''))
        .join(' ')
        .toLowerCase();
    return /json_schema|json schema|response_format|structured output|schema is not supported|unsupported.*schema/.test(text);
}

/**
 * Who the entries belong to, for the badge in each title. Resolved once per
 * run so a switch mid-generation cannot mislabel half the batch.
 *
 * A home carries no name: the badge distinguishes the character's place from
 * the user's from the shared one, which is all a title needs to say. A
 * building carries its own name, because two of them can sit in one lorebook.
 */
function resolveOrigin(brief) {
    const mode = brief.mode === 'place' ? 'place' : 'home';
    if (mode === 'place') {
        return { mode, target: 'place', place: String(brief.placeName || '').trim() };
    }
    return { mode, target: brief.target, place: '' };
}

/**
 * Give each draft entry its ordering tier. Room entries sit just under the
 * whole-home entry so the general description reads first.
 */
function applyTiers(entries) {
    return entries.map(entry => {
        const whole = !entry.room || /^whole$|^home$|^all$/i.test(entry.room);
        return {
            ...entry,
            order: whole ? ORDER.home : ORDER.room,
            depth: whole ? DEPTH.home : DEPTH.room,
        };
    });
}

/**
 * The names a title must not carry. The badge already says whose place it is,
 * and repeating it down every row is what crowded the lorebook list.
 *
 * Homes only: a building can legitimately be called "Anna's Rest", and
 * stripping the name out of that leaves an entry titled "Rest".
 */
function ownerNames(ctx, job) {
    if (job.mode === 'place') return [];
    return [ctx.name2, ctx.name1].map(name => String(name || '').trim()).filter(Boolean);
}

/**
 * Single paid generation attempt. Estate asks for JSON in its prompt but by
 * default does NOT use provider-enforced structured output: SillyTavern can
 * silently turn failed schema generations into the literal "{}". The model's
 * ordinary response is still parsed and validated as JSON locally. A caller
 * can explicitly opt into a provider-side schema by setting noSchema=false.
 * Never auto-retry a returned response or double its token budget.
 */
async function attemptGeneration(ctx, job, profileId, options) {
    const noSchema = options.noSchema !== false;
    try {
        const result = await runGeneration(ctx, job, profileId, { ...options, noSchema });
        return { ...result, noSchema };
    } catch (error) {
        if (activeAbort?.signal?.aborted && isCancellation(error)) throw error;
        if (!noSchema && isSchemaRejection(error)) {
            warn('structured output refused, falling back to text once', error);
            activeAbort.signal.throwIfAborted();
            const result = await runGeneration(ctx, job, profileId, { ...options, noSchema: true });
            return { ...result, noSchema: true };
        }
        // In particular, a token-limit error must not cause a 16k/32k retry.
        throw error;
    }
}

/** Accept useful content with harmless room-label mistakes without paying for
 * another request. Align unmatched entries to unfilled requested slots. */
function reconcileCoverage(normalized, expected) {
    if (!normalized.ok) return normalized;
    const original = normalized.entries;
    const assigned = [];
    const used = new Set();
    const wanted = new Set(expected.map(normalizeId));
    for (const entry of original) {
        const id = normalizeId(entry.room);
        const slot = expected.find(name => normalizeId(name) === id && !used.has(id));
        if (slot) {
            used.add(id);
            assigned.push({ ...entry, room: slot });
        }
    }
    const leftover = original.filter(entry => !wanted.has(normalizeId(entry.room)));
    for (const slot of expected) {
        const id = normalizeId(slot);
        if (!used.has(id) && leftover.length) {
            const entry = leftover.shift();
            used.add(id);
            assigned.push({ ...entry, room: slot });
        }
    }
    normalized.entries = assigned;
    normalized.missing = expected.filter(room => !used.has(normalizeId(room)));
    if (!assigned.length) return { ok: false, error: 'The model returned no usable requested room entries' };
    // A room can still be saved when the model forgot its trigger keywords.
    for (const entry of assigned) {
        if (!entry.keys.length) {
            const key = entry.room === 'whole' ? 'home' : entry.room;
            entry.keys = [{ mode: /\s/.test(key) ? 'proper' : 'stem', value: key }];
        }
    }
    normalized.keyless = 0;
    return normalized;
}

/** If a provider returns free-form prose rather than JSON, keep it as an
 * editable draft for one requested room. Do not treat broken JSON as prose. */
function plainTextEntry(reply, expected) {
    if (expected.length !== 1 || typeof reply !== 'string') return null;
    const content = reply
        .replace(/<(think|thinking|reasoning|thought)>[\s\S]*?<\/\1>/gi, '')
        .trim().replace(/^```(?:text|markdown)?\s*/i, '').replace(/```\s*$/i, '').trim();
    if (!content || /^[{\[]/.test(content) || content.length > 30000) return null;
    const room = expected[0];
    return { title: room === 'whole' ? 'Home' : room, room, content, visual: '',
        keys: [{ mode: /\s/.test(room) ? 'proper' : 'stem', value: room === 'whole' ? 'home' : room }] };
}

/** One paid request. Checkpoint raw text before attempting to parse it. */
async function generatePass(ctx, job, profileId, options) {
    const expected = options.revision ? [] : options.chunk?.rooms?.length
        ? [...options.chunk.rooms, ...(options.chunk.whole ? ['whole'] : [])] : ['whole'];
    const attempt = await attemptGeneration(ctx, job, profileId, options);
    const parsed = extractJson(attempt.reply);
    // In SillyTavern, a failed structured request may arrive as the literal
    // "{}" without throwing. Treat that as an empty generation rather than
    // claiming a valid JSON reply was produced.
    if (parsed.ok && parsed.value && typeof parsed.value === 'object'
        && !Array.isArray(parsed.value) && !Object.keys(parsed.value).length) {
        return { ok: false, error: 'The model/API returned only {} (an empty JSON object). No room entry was produced.' };
    }
    const normalized = parsed.ok
        ? normalizeEntries(parsed.value, { englishOnly: job.keyLanguage === 'en', names: ownerNames(ctx, job) })
        : { ok: false, error: parsed.error };
    if (options.revision) return normalized;
    if (!normalized.ok) {
        const entry = plainTextEntry(attempt.reply, expected);
        if (entry) return { ok: true, entries: [entry], missing: [], keyless: 0 };
        return normalized;
    }
    return reconcileCoverage(normalized, expected);
}

/** Track task identity and only request missing rooms on resume. */
function taskId(jobIndex, chunkIndex) { return `${jobIndex}:${chunkIndex}`; }
function hasRoom(draft, jobIndex, room) {
    return draft.entries.some(entry => entry.jobIndex === jobIndex && normalizeId(entry.room) === normalizeId(room));
}

async function generatePlace(ctx, job, jobIndex, profileId, options, onProgress, onBatch) {
    let failed = 0;
    let error = '';
    for (const chunk of planChunks(job)) {
        activeAbort.signal.throwIfAborted();
        const rooms = chunk.rooms.filter(room => !hasRoom(options.draft, jobIndex, room));
        const whole = chunk.whole && !hasRoom(options.draft, jobIndex, 'whole');
        if (!whole && !rooms.length) continue;
        const pending = { ...chunk, rooms, whole };
        onProgress?.(pending);
        const id = taskId(jobIndex, chunk.index);
        const result = await generatePass(ctx, job, profileId, {
            ...options, chunk: pending, continuity: continuity(options.draft.entries),
            onReply: reply => onBatch({ id, chunk: pending, reply }),
        });
        onBatch({ id, chunk: pending, result });
        if (!result.ok) {
            failed++;
            error = result.error;
            warn(`batch ${chunk.index + 1}/${chunk.total} unusable`, result.error);
            // Do not spend more paid requests after a rejected reply. The
            // user can inspect raw text and explicitly resume when desired.
            break;
        }
        if (result.missing?.length) {
            failed++;
            error = `Missing rooms: ${result.missing.join(', ')}`;
            break;
        }
    }
    return { failed, error };
}

/**
 * The list of places one run will write, in the order they are generated.
 *
 * An ordinary run is a list of one: whatever the board says. A scouted run is
 * one job per building the user ticked, each carrying the tags the scout chose
 * for it laid over the board's own picks.
 *
 * @param {object} settings
 * @param {object} brief
 * @param {object[]} [places] proposals from the scout
 * @returns {object[]} jobs, each a flat settings-and-brief object
 */
function planJobs(settings, brief, places) {
    // The stores are merged here rather than in prompt.js, so the split stays
    // a storage concern and nothing downstream has to know there are two.
    const base = { ...settings, ...brief };
    if (!places?.length) return [base];

    return places.map(place => ({
        ...base,
        mode: 'place',
        placeName: place.name,
        // The scout's picks win where it had an opinion; a section it left
        // alone keeps whatever the board was already carrying.
        picks: { ...base.picks, ...place.picks },
    }));
}

/** Human-readable error surfaced inside Estate, not hidden in DevTools. */
function errorDescription(error) {
    const message = [error?.message, error?.error?.message, error?.cause?.message]
        .filter(Boolean).map(String).join(' — ').trim();
    return message.slice(0, 350) || String(error || 'Unknown error').slice(0, 350);
}

function warnStorage(ctx, draft) {
    if (!saveDraft(ctx, draft) && !draft.storageWarningShown) {
        draft.storageWarningShown = true;
        toastr.warning('Browser storage is unavailable/full. Current results are kept only until this page reloads.', t('title'));
    }
}

/** Decorate an entry before checkpointing, so a reload preserves the owner,
 * chat scope, and existing book targeting rather than just the prose. */
function decorateDraftEntry(ctx, job, jobIndex, entry) {
    const origin = resolveOrigin(job);
    const owner = job.mode === 'place' ? job.placeName
        : job.target === 'persona' ? ctx.name1
        : job.target === 'shared' ? `${ctx.name2} & ${ctx.name1}` : ctx.name2;
    const ownerId = JSON.stringify([ctx.characters?.[ctx.characterId]?.avatar || ctx.getCurrentChatId?.(), job.mode, job.target, normalizeId(owner)]);
    const scopeKeys = (job.mode === 'place' ? [job.placeName] : job.target === 'shared' ? [ctx.name1, ctx.name2] : [owner]).filter(Boolean);
    return { ...applyTiers([entry])[0], origin, ownerId, scopeKeys, job, jobIndex };
}

function createSession(ctx, settings, brief, places, jobs) {
    const isNew = brief.createNew || !brief.lorebookName;
    return {
        version: 1, createdAt: Date.now(), updatedAt: Date.now(),
        settings, brief, places: places || null, jobs,
        tasks: jobs.flatMap((job, jobIndex) => planChunks(job).map(chunk => ({
            id: taskId(jobIndex, chunk.index), jobIndex,
            rooms: [...chunk.rooms, ...(chunk.whole ? ['whole'] : [])],
        }))),
        completed: [], writtenRooms: [], entries: [], raws: [], lastError: '', 
        book: isNew ? buildLorebookName(settings.nameTemplate, ctx) : brief.lorebookName,
        isNew, mode: jobs.length > 1 ? 'place' : resolveOrigin(jobs[0]).mode,
    };
}

/** Distinguish previously written rooms from the new ones on resume.
 * Re-reviewing a stale draft must not overwrite edits made in the lorebook. */
function entryDraftId(entry) { return `${entry.jobIndex}:${normalizeId(entry.room)}`; }
function unwrittenEntries(draft) {
    const written = new Set(draft.writtenRooms || []);
    return draft.entries.filter(entry => !written.has(entryDraftId(entry)));
}

/** The same review/save path is used for a new, stopped, or resumed draft. */
async function reviewDraft(ctx, draft, profileId, lore = '') {
    const reviewEntries = unwrittenEntries(draft);
    if (!reviewEntries.length) return false;
    publish({ phase: 'review', stage: '' });
    const isNew = draft.isNew;
    const book = draft.book;
    const firstJob = draft.jobs[0];
    const regenerate = async (entry, note, siblings) => {
        if (is_send_press) throw new Error(t('toastBusy'));
        activeAbort = new AbortController();
        const result = await generatePass(ctx, { ...entry.job, granularity: 'single' }, profileId, {
            lore, revision: revisionInstruction(entry, note, siblings),
        });
        if (!result.ok || result.entries.length !== 1 || result.keyless) throw new Error(t('toastBadJson'));
        return { ...entry, ...result.entries[0], room: entry.room };
    };
    return openPreview(reviewEntries, {
        book, isNew, mode: draft.mode, source: lore, regenerate,
    }, async (selected, writeMode) => {
        try {
            const writeOptions = {
                name: book, create: draft.isNew, attachAfterSave: !!draft.attachAfterSave,
                bind: draft.settings.bind, origin: resolveOrigin(firstJob), context: ctx, writeMode,
            };
            try {
                var result = await writeEntries(selected, writeOptions);
            } catch (error) {
                // A new book may have been created before the entry save failed.
                // Remember that fact, so recovery never tries to create it twice.
                if (draft.isNew && !writeOptions.create) {
                    draft.isNew = false;
                    draft.attachAfterSave = true;
                }
                throw error;
            }
            if (!result.written) throw new Error('No entries were written. Draft retained.');
            draft.attachAfterSave = false;
            draft.writtenRooms = [...new Set([...(draft.writtenRooms || []), ...selected.map(entryDraftId)])];
            toastr.success(t('toastWritten', { n: result.written, book: result.name }), t('title'));
            if (result.bound) toastr.info(t('toastBound', { book: result.name, target: t(BIND_LABEL[draft.settings.bind]) }), t('title'));
            if (result.bindFailed) toastr.warning(t('toastBindFailed'), t('title'));
            draft.isNew = false;
            draft.book = result.name;
            if (sameChat(ctx)) {
                const currentBrief = getBrief();
                currentBrief.createNew = false;
                currentBrief.lorebookName = result.name;
                saveBrief();
            }
            if (countPending(draft) || unwrittenEntries(draft).length) warnStorage(ctx, draft);
            else clearDraft(ctx);
            return true;
        } catch (error) {
            console.error(`[${TAG}] write failed`, error);
            draft.lastError = `Lorebook write: ${errorDescription(error)}`;
            warnStorage(ctx, draft);
            toastr.error(draft.lastError, t('title'));
            return false;
        }
    });
}

/** Generate one place at a time, retaining each returned response before
 * interpreting it. A late API failure never discards earlier rooms. */
async function generateEstate(settings, brief, places, resume = false) {
    if (inFlight || is_send_press) {
        toastr.warning(t('toastBusy'), t('title'));
        return false;
    }
    const ctx = snapshotContext(SillyTavern.getContext(), user_avatar);
    const previous = loadDraft(ctx);
    if (!resume && previous) {
        toastr.warning('A recoverable Estate draft already exists. Review, resume or discard it before starting another paid run.', t('title'));
        return false;
    }
    if (resume && !previous) {
        toastr.info('No saved Estate draft for this chat.', t('title'));
        return false;
    }
    const draft = resume ? previous : createSession(ctx, structuredClone(settings), structuredClone(brief), structuredClone(places || null), planJobs(settings, brief, places));
    const profileId = resolveProfileId(draft.settings);
    if (!profileId && ctx.mainApi !== 'openai') {
        toastr.warning(t('toastNoApi'), t('title'));
        return false;
    }
    inFlight = true;
    activeAbort = new AbortController();
    activeUsesProfile = !!profileId;
    warnStorage(ctx, draft);
    publish({ phase: 'generating', startedAt: Date.now(), done: 0, total: draft.jobs.length, stage: '' });

    let lore = '';
    let interruption = null;
    let partial = 0;
    try {
        if (draft.settings.useLore) {
            try {
                lore = await readBoundLore(ctx, JSON.stringify({ names: [ctx.name1, ctx.name2], jobs: draft.jobs }), draft.brief.lorebookName);
            } catch (error) { warn('lorebook context', error); }
        }
        for (let index = 0; index < draft.jobs.length; index++) {
            const job = draft.jobs[index];
            try {
                activeAbort.signal.throwIfAborted();
                publish({ done: index, stage: '' });
                const result = await generatePlace(ctx, job, index, profileId, { lore, draft }, chunk => {
                    const stage = draft.jobs.length > 1 ? t('generatingPlace', { name: job.placeName })
                        : chunk.total > 1 ? t('generatingBatch', { n: chunk.index + 1, total: chunk.total }) : '';
                    publish({ stage });
                }, ({ id, chunk, reply, result }) => {
                    // First callback: raw text has arrived. Save it immediately,
                    // BEFORE JSON parsing/validation or any subsequent request.
                    if (reply !== undefined) noteRaw(draft, id, reply);
                    if (result?.ok) {
                        for (const entry of result.entries) {
                            const decorated = decorateDraftEntry(ctx, job, index, entry);
                            const existing = draft.entries.findIndex(item => item.jobIndex === index && normalizeId(item.room) === normalizeId(entry.room));
                            if (existing >= 0) draft.entries[existing] = decorated;
                            else draft.entries.push(decorated);
                        }
                        if (!result.missing?.length && !draft.completed.includes(id)) draft.completed.push(id);
                        draft.lastError = result.missing?.length ? `Missing rooms: ${result.missing.join(', ')}` : '';
                    } else if (result) {
                        draft.lastError = result.error || 'Reply could not be parsed';
                    }
                    warnStorage(ctx, draft);
                });
                if (result.failed) {
                    partial += result.failed;
                    interruption = new Error(result.error || 'Some room descriptions were unusable');
                    break; // no more unapproved paid requests
                }
            } catch (error) {
                interruption = error;
                draft.lastError = errorDescription(error);
                warnStorage(ctx, draft);
                break;
            }
        }
        if (interruption) {
            const message = activeAbort?.signal?.aborted ? 'Generation stopped' : `Generation stopped: ${errorDescription(interruption)}`;
            toastr.warning(`${message}. Saved entries: ${draft.entries.length}. Use Recover draft to resume or review.`, t('title'));
            warnStorage(ctx, draft);
        }
        if (!draft.entries.length) {
            toastr.error(`No usable entries yet. ${draft.lastError || 'The model returned no content.'} Use Recover draft to inspect any returned text.`, t('title'));
            return false;
        }
        if (partial) toastr.warning(`Some rooms are unfinished (${countPending(draft)} requests remaining). Completed rooms are saved.`, t('title'));
        return await reviewDraft(ctx, draft, profileId, lore);
    } catch (error) {
        draft.lastError = errorDescription(error);
        warnStorage(ctx, draft);
        warn('generate', error);
        toastr.error(`Generation interrupted: ${draft.lastError}. Draft preserved; open Recover draft.`, t('title'));
        return false;
    } finally {
        inFlight = false;
        activeAbort = null;
        activeUsesProfile = false;
        publish({ phase: 'idle', stage: '', done: 0, total: 1 });
    }
}

/** Inspect the raw response even when every JSON parser failed. */
async function showRawDraft(draft) {
    const ctx = SillyTavern.getContext();
    const root = node('div', 'est-preview');
    root.appendChild(node('h3', '', 'Recovered API responses'));
    root.appendChild(node('p', 'est-hint', 'These are the responses that actually reached Estate. Copy them without another API request. Text may be truncated if very large.'));
    if (draft.lastError) root.appendChild(node('p', 'est-warn', `Last error: ${draft.lastError}`));
    const combined = (draft.raws || []).map(item => `===== ${item.id} =====\n${item.text}`).join('\n\n');
    const field = textarea(12, combined || 'No response text reached the extension before it stopped.');
    field.readOnly = true;
    field.style.width = '100%';
    root.appendChild(field);
    const copy = button('Copy returned text', 'fa-solid fa-copy');
    copy.disabled = !combined;
    copy.addEventListener('click', async () => {
        try { await navigator.clipboard.writeText(combined); toastr.success('Returned text copied.', t('title')); }
        catch { field.focus(); field.select(); toastr.info('Select and copy the displayed text.', t('title')); }
    });
    root.appendChild(copy);
    await new ctx.Popup(root, ctx.POPUP_TYPE.TEXT, '', { wide: true, large: true, allowVerticalScrolling: true, okButton: 'Close', cancelButton: false }).show();
}

function recoveryInfo() {
    const draft = loadDraft(SillyTavern.getContext());
    return draft ? { entries: draft.entries.length, unsaved: unwrittenEntries(draft).length, pending: countPending(draft), raws: draft.raws?.length || 0, error: draft.lastError } : null;
}

async function recoverDraft(action) {
    if (inFlight) { toastr.info(t('toastBusy'), t('title')); return false; }
    const ctx = snapshotContext(SillyTavern.getContext(), user_avatar);
    const draft = loadDraft(ctx);
    if (!draft) { toastr.info('No saved Estate draft in this chat.', t('title')); return false; }
    if (action === 'discard') {
        if (!window.confirm('Delete the saved Estate draft and raw replies for this chat? This cannot be undone.')) return false;
        clearDraft(ctx);
        publish();
        return false;
    }
    if (action === 'raw') { await showRawDraft(draft); return false; }
    if (action === 'resume') {
        if (!countPending(draft)) { toastr.info('All requested rooms have returned. Open Review to save them.', t('title')); return false; }
        return generateEstate(draft.settings, draft.brief, draft.places, true);
    }
    if (action === 'review') {
        if (!unwrittenEntries(draft).length) {
            if (!draft.entries.length) await showRawDraft(draft);
            else toastr.info('All recovered entries have already been written. Resume missing rooms to generate new ones.', t('title'));
            return false;
        }
        inFlight = true;
        activeAbort = new AbortController();
        publish({ phase: 'review', startedAt: 0, done: 0, total: 1, stage: '' });
        try { return await reviewDraft(ctx, draft, resolveProfileId(draft.settings)); }
        catch (error) { toastr.error(`Review failed: ${errorDescription(error)}`, t('title')); return false; }
        finally {
            inFlight = false; activeAbort = null;
            publish({ phase: 'idle', stage: '', done: 0, total: 1 });
        }
    }
    return false;
}

/**
 * Ask the model which buildings this story needs. One short request, no
 * lorebook writing: what comes back is a list the user ticks, and the ticked
 * ones then go through `generateEstate` as ordinary runs.
 *
 * @param {object} settings
 * @param {object} brief
 * @returns {Promise<object[]|null>} proposals, or null when nothing came back
 */
async function suggestPlaces(settings, brief) {
    if (inFlight || is_send_press) {
        toastr.warning(t('toastBusy'), t('title'));
        return null;
    }

    const ctx = snapshotContext(SillyTavern.getContext(), user_avatar);
    settings = structuredClone(settings);
    brief = structuredClone(brief);
    const profileId = resolveProfileId(settings);
    if (!profileId && ctx.mainApi !== 'openai') {
        toastr.warning(t('toastNoApi'), t('title'));
        return null;
    }

    inFlight = true;
    activeAbort = new AbortController();
    activeUsesProfile = !!profileId;

    // An ordinary generating phase: one request, its own caption. Scouting is
    // not a third kind of run, and giving it a phase of its own only made
    // every place that reads one ask about two.
    publish({ phase: 'generating', startedAt: Date.now(), done: 0, total: 1, stage: t('scouting') });

    try {
        let lore = '';
        if (settings.useLore) {
            try {
                lore = await readBoundLore(ctx, JSON.stringify(brief), brief.lorebookName);
            } catch (error) {
                warn('lorebook context', error);
            }
        }

        const job = { ...settings, ...brief };
        // The prompt still requires JSON. Do not force provider-side structured
        // output: a failed schema can silently be returned by ST as "{}".
        const request = { ...buildSuggestRequest(job, { lore, count: settings.suggestCount, context: ctx }), jsonSchema: null };

        const send = async attempt => (profileId
            ? await generateViaProfile(ctx, profileId, attempt, activeAbort.signal)
            : await generateViaMainApi(ctx, attempt));

        let reply;
        try {
            reply = await send(request);
        } catch (error) {
            if (isCancellation(error)) throw error;
            // Only retry when the backend explicitly rejected the schema.
            // A token-limit error should be surfaced, not automatically paid
            // for again at double the requested output ceiling.
            if (!isSchemaRejection(error)) throw error;
            warn('scouting schema unsupported, falling back to text', error);
            activeAbort.signal.throwIfAborted();
            reply = await send({ ...request, jsonSchema: null });
        }

        activeAbort.signal.throwIfAborted();
        const parsed = extractJson(reply);
        const normalized = parsed.ok ? normalizeSuggestions(parsed.value) : { ok: false, error: parsed.error };

        if (!normalized.ok) {
            warn('scouting reply unusable', normalized.error);
            console.debug(`[${TAG}] raw reply:`, reply);
            toastr.error(t('toastNoPlacesFound'), t('title'));
            return null;
        }

        if (!sameChat(ctx)) {
            toastr.info(t('toastChatChanged'), t('title'));
            return null;
        }
        return normalized.places;
    } catch (error) {
        if (isCancellation(error)) {
            toastr.info(t('toastStopped'), t('title'));
            return null;
        }
        warn('suggest', error);
        toastr.error(`Suggest places failed: ${errorDescription(error)}`, t('title'));
        return null;
    } finally {
        inFlight = false;
        activeAbort = null;
        activeUsesProfile = false;
        publish({ phase: 'idle', stage: '', done: 0, total: 1 });
    }
}

// ---------------------------------------------------------------------------
// Settings card
// ---------------------------------------------------------------------------

function bindSettingsUi(open) {
    const settings = getSettings();
    const root = document.querySelector(SETTINGS_SELECTOR);
    if (!root) return;

    for (const element of root.querySelectorAll('[data-estate-i18n]')) {
        element.textContent = t(element.dataset.estateI18n);
    }
    paintIcons(root);

    const nameTemplate = /** @type {HTMLInputElement} */ (root.querySelector('#estate_name_template'));
    const instruction = /** @type {HTMLTextAreaElement} */ (root.querySelector('#estate_instruction'));
    const sectionState = /** @type {HTMLSelectElement} */ (root.querySelector('#estate_section_state'));
    const reset = root.querySelector('#estate_reset');
    const saved = root.querySelector('#estate_saved');
    if (!nameTemplate || !instruction || !sectionState || !reset) return;

    root.querySelector('#estate_open')?.addEventListener('click', () => open());

    // The save itself is instant; this only reassures, so it never blocks.
    let hideTimer = null;
    const flashSaved = () => {
        if (!saved) return;
        saved.classList.add('estate-settings__saved--on');
        clearTimeout(hideTimer);
        hideTimer = setTimeout(() => saved.classList.remove('estate-settings__saved--on'), 1600);
    };

    nameTemplate.value = settings.nameTemplate;
    nameTemplate.addEventListener('change', () => {
        settings.nameTemplate = nameTemplate.value.trim() || defaultNameTemplate();
        nameTemplate.value = settings.nameTemplate;
        saveSettings();
        flashSaved();
    });

    sectionState.value = settings.sectionState;
    sectionState.addEventListener('change', () => {
        settings.sectionState = sectionState.value;
        saveSettings();
        flashSaved();
    });

    instruction.value = settings.instruction;
    instruction.addEventListener('change', () => {
        settings.instruction = instruction.value.trim();
        saveSettings();
        flashSaved();
    });

    reset.addEventListener('click', () => {
        settings.nameTemplate = defaultNameTemplate();
        settings.sectionState = defaultSectionState();
        settings.instruction = '';
        nameTemplate.value = settings.nameTemplate;
        sectionState.value = settings.sectionState;
        instruction.value = '';
        saveSettings();
        flashSaved();
    });
}

async function mountSettings(open) {
    if (document.querySelector(SETTINGS_SELECTOR)) return;

    const response = await fetch(`${EXT_PATH}/settings.html`);
    if (!response.ok) throw new Error(`Settings template returned ${response.status}`);

    const host = document.getElementById('extensions_settings2') || document.getElementById('extensions_settings');
    if (!host) throw new Error('Extensions settings container is unavailable.');

    const template = document.createElement('template');
    template.innerHTML = (await response.text()).trim();
    const block = template.content.firstElementChild;
    if (!block) throw new Error('Settings template is empty.');

    // Every extension appends its card whenever its own fetch happens to
    // return, so the column order is a race and comes out differently on each
    // reload. Estate belongs above Facets, which is a sibling extension by the
    // same hand, so it is placed rather than appended.
    const facets = host.querySelector('.facets-settings');
    if (facets) host.insertBefore(block, facets);
    else host.appendChild(block);

    bindSettingsUi(open);
}

// ---------------------------------------------------------------------------
// Slash command
// ---------------------------------------------------------------------------

function registerSlashCommand(open) {
    try {
        const ctx = SillyTavern.getContext();
        const { SlashCommandParser, SlashCommand } = ctx;
        if (!SlashCommandParser || !SlashCommand) return;

        SlashCommandParser.addCommandObject(SlashCommand.fromProps({
            name: 'estate',
            helpString: 'Open the Estate dialog: design a home or a building and write it to a lorebook.',
            callback: async () => {
                open();
                return '';
            },
        }));
    } catch (error) {
        warn('slash command', error);
    }
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

jQuery(async () => {
    const open = () => openDialog({
        generate: generateEstate,
        suggest: suggestPlaces,
        cancel: cancelGeneration,
        subscribe: subscribeRun,
        recoveryInfo,
        recover: recoverDraft,
    });

    mountUi(open);
    registerSlashCommand(open);

    try {
        await mountSettings(open);
    } catch (error) {
        warn('settings', error);
    }

    window.addEventListener('pagehide', unmountUi, { once: true });
    console.log(`[${TAG}] initialized.`);
});
