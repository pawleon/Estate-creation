# Estate 1.1.3-parser-recovery — repair build

This is a local repair of the supplied `ST-Estate-main.zip` rather than an upstream release.

## What was repaired

- **Immediate checkpoints.** After the provider returns a response, Estate stores the raw text *before* parsing it. Parsed room entries are checkpointed after each completed request. A later timeout or failed JSON parse does not erase them.
- **Recover saved draft.** The Estate dialog now displays a recovery panel with Review saved entries, Resume missing rooms, View returned text, and Discard draft. Reviewing and viewing returned text make no AI requests. Resume explicitly requests unfinished rooms only.
- **Write failures retain drafts.** A failed lorebook create/save does not clear the browser draft. Successful writes are recorded so a resumed review does not overwrite previously written entries with their original, unedited drafts.
- **Real error text.** The in-app toast shows the underlying exception message rather than a generic “Generation failed”.
- **JSON generation without forced structured output.** Estate still tells the model to return JSON and still parses JSON locally, but no longer sends a provider-side `jsonSchema` by default. This specifically avoids the failure mode in which SillyTavern returns literal `{}` after a structured-output attempt. It does not assume the model is incapable of producing JSON; Memory Books can likewise request JSON without enforcing a provider schema.
- **No surprise paid retries.** Generation no longer retries malformed JSON or increases `max_tokens` automatically on a token-limit failure. Provider-side schemas are disabled by default; normal requests have no schema-rejection retry.
- **Strict batch sizing.** “Entries per request = 1” now means *one*, including the whole-place overview. All selected rooms are scheduled, rather than silently clipping at 12. A short, locally re-labeled entry can be retained even if the model gets a room ID wrong. Basic missing trigger keys receive a fallback and can be edited in Review.
- **Output token cap.** Optional Output token limit dropdown: Auto / 2,048 / 4,096 / 8,192 / 16,384 / 32,768. Use the provider's *actual supported* maximum; an output cap is not the same thing as tokens used or context window size.
- **No upstream auto-update.** `manifest.json` sets `auto_update=false` so an update does not replace the repair with the old version.

## Installation / updating

1. **Back up your existing Estate extension folder** and any important World Info/lorebooks first.
2. Unzip this archive. Copy the **contents** of `ST-Estate-main/` into your already-installed Estate extension directory, replacing matching files and adding `recovery.js`. Do not accidentally create `.../ST-Estate/ST-Estate-main/` as a nested folder.
3. Reload SillyTavern (a full page refresh). Check the Estate dialog: the Recovery area will appear when an incomplete or uncommitted draft exists.
4. Make a new test with a non-billed/mock backend if available before relying on it for longer paid generations.

## Important limits

- Recovery is **per chat, in the current browser/device** using `localStorage`. Do not clear that browser's site data while a draft is pending. A different phone/browser will not see the same draft. A browser storage-full warning means checkpoints may not survive a reload.
- A response must actually reach Estate to be recovered. If a provider times out and never delivers the response, the extension cannot retrieve text from the provider or refund its tokens. It will still save any *earlier* completed batches.
- Raw reply history keeps the last **20 replies**, up to **100,000 characters per reply**, to limit browser storage use. Entries themselves are stored separately.
- **This cannot recover paid requests lost before installing the repair.**
- Static syntax checks and local mocked flow tests passed, including API interruption after a successful batch, resume without re-requesting that batch, successful lorebook write, and a lorebook write error followed by recovery. It has **not** been exercised against your live SillyTavern instance/API provider.

## 1.1.3 response parsing hardening

- Accept bare JSON arrays (including parsed arrays) without silently losing entries after the first one.
- Recover content from common model field names (`description`, `text`, `body`) and keywords from `keywords` or `triggers`.
- Accept a single nesting layer under `data`, `result` or `output`.
- Keep rejecting truly empty responses like `{}`; there is no generated prose to recover from them.
- No automatic re-requests were added. These cases were checked with offline response fixtures and the existing interrupted-run/write-retry simulations, not against a paid API.

## 1.1.4 — zero-token World Info diagnostic

- Added a separate **Test lorebook saving (0 AI tokens)** button to Estate. It creates one uniquely named *unbound* temporary World Info book, writes a small synthetic entry, reloads it to verify, and deletes the temporary book. It does not ask a model to generate anything or modify the current recovery draft.
- A successful test proves that SillyTavern's World Info write/reload works in the current installation; generation, parsing, and review remain separate hypotheses.
- If cleanup fails, the UI reports the temporary book's exact name for manual deletion. The test never chooses a name from existing books.
- No automatic LLM requests or paid retries were added.

## 1.1.5 — raw response recovery and explicit output cap

- **Recover returned entries (0 AI tokens)** uses the saved API responses in the current chat to reconstruct editable entries, including partial single-entry JSON where actual description prose arrived. It does not generate missing content, overwrite already-written entries, or make another model call.
- When the user chooses an explicit output token cap, Estate now passes it unchanged as `responseLength`. Previously it silently used the lower of that cap and its computed automatic budget, often ~5K despite selecting 32K.
- The cap is a maximum request, not a promise the model will produce that many tokens or the provider will allow them. Automatic retries are still disabled.
