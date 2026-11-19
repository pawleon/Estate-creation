/**
 * Local Estate diagnostics. Never contacts an LLM or uses model credits.
 * The optional writer check creates an unbound, uniquely named temporary
 * lorebook, verifies its entry, and attempts to delete it in finally.
 * All dependencies are injected to make this independently testable.
 */
export async function verifyLorebookWrite({ writeEntries, loadWorldInfo, deleteWorldInfo, listLorebooks, context }) {
    const prefix = 'Estate-Diagnostic-';
    const book = `${prefix}${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    if (listLorebooks().includes(book)) {
        return { ok: false, written: false, cleanup: true, error: 'Temporary diagnostic name collided with a real lorebook.' };
    }

    let written = false;
    let cleanup = true;
    let error = '';
    try {
        const result = await writeEntries([{
            title: 'Test Room', room: 'whole',
            content: 'Temporary Estate diagnostic entry. No AI was called.',
            visual: '', keys: ['estate_diagnostic_check'],
        }], {
            name: book, create: true, bind: 'none',
            origin: { mode: 'home', target: 'character' },
            context, writeMode: 'variant',
        });
        if (result?.written !== 1) throw new Error(`Writer reported ${result?.written ?? 0} entries, expected 1.`);
        const data = await loadWorldInfo(book);
        const entries = Object.values(data?.entries || {});
        if (!entries.some(entry => String(entry?.content || '').includes('Temporary Estate diagnostic entry.'))) {
            throw new Error('Writer reported success, but the test entry could not be reloaded.');
        }
        written = true;
    } catch (cause) {
        error = String(cause?.message || cause);
    } finally {
        // Use the random exact name only. Never delete a user lorebook or
        // change any bindings. If cleanup fails, tell the user its name.
        try {
            if (listLorebooks().includes(book)) cleanup = !!(await deleteWorldInfo(book));
        } catch (cause) {
            cleanup = false;
            if (!error) error = 'Temporary lorebook cleanup failed: ' + String(cause?.message || cause);
        }
    }
    return { ok: written && cleanup, written, cleanup, error, temporaryBook: cleanup ? '' : book };
}
