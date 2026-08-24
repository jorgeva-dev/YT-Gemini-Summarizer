# YouTube → Gemini

A Chrome/Brave extension that pulls the transcript out of the YouTube video you are watching and hands it to Gemini in a new tab — no API key, no quota, no billing. It uses the Gemini session you are already logged into.

What you do with the transcript is configurable. Ship-with defaults cover short summaries, structured summaries, key figures and references, or just copying the raw transcript to your clipboard. You can add your own actions, including ones that open your own **Gems**.

> The extension UI is in Spanish. Everything below applies regardless; the code and this document are in English.

---

## Why this exists

Most "summarize this video" extensions ask for a Gemini or OpenAI API key and bill you per request. That is a poor trade when you already pay for — or have free access to — the Gemini web app.

This one skips the API entirely:

1. Extract the transcript from the active YouTube tab.
2. Build a prompt from a template you control.
3. Open `gemini.google.com` in a new tab beside the video, paste, and send.

The interesting part turned out to be step 1. See [How transcript extraction works](#how-transcript-extraction-works).

---

## Install

Not on the Chrome Web Store. Load it unpacked:

1. Clone the repo.
2. Open `chrome://extensions` (or `brave://extensions`).
3. Enable **Developer mode**.
4. **Load unpacked** → select the repo folder.
5. Pin the extension and click it on a YouTube video page to open the side panel.

Works in Chrome and Brave. Manifest V3, no build step, no dependencies.

---

## Actions

An action is just data:

| Field | Meaning |
|---|---|
| Name / icon | What the button says |
| Destination | Gemini app, a custom Gem URL, or clipboard only |
| Prompt template | The text sent to Gemini |

Templates support four placeholders:

- `{{titulo}}` — video title
- `{{transcripcion}}` — full transcript
- `{{transcripcion_con_tiempos}}` — transcript with `[mm:ss]` markers
- `{{url}}` — video URL

Actions are managed from the options page: create, edit, reorder, import and export as JSON. Defaults are seeded on first install and never overwritten afterwards.

### Using your own Gems

Set the destination to **Gem** and paste the Gem's URL (open it at `gemini.google.com` and copy the address bar — it looks like `https://gemini.google.com/gem/<id>`).

One gotcha worth knowing: **do not leave the prompt template as just `{{transcripcion}}`.** Many Gems have a conversational opening in their system prompt. Given a first message with no instruction, they introduce themselves and ask what you want analyzed — ignoring the transcript entirely. Include a minimal instruction:

```
Analyze the YouTube transcript below using your usual method. Do not
introduce yourself or ask what to analyze: this text is the material.

Title: {{titulo}}
URL: {{url}}

TRANSCRIPT:
{{transcripcion}}
```

Keep it minimal on purpose. Do not specify *how* to analyze or what format to use — that is the Gem's job, and overriding it defeats the point of using a Gem.

---

## How transcript extraction works

This is the part that took the real work, and the part most likely to be useful to someone else. YouTube has tightened caption access twice, and the naive approaches no longer work.

### Symptom

`https://www.youtube.com/api/timedtext?...` returns **HTTP 200 with a zero-byte body**. Not a 403, not an error — an empty success. Easy to misdiagnose as "this video has no captions" when the captions are right there in the player.

### Cause 1 — the request must come from the page

The `baseUrl` in `ytInitialPlayerResponse.captions` carries session-bound parameters. Fetching it from an extension context (`chrome-extension://` origin, no cookies, no `Referer`) yields an empty body. So all fetching happens inside the tab, injected into the `MAIN` world via `chrome.scripting`.

### Cause 2 — the `pot` token

Moving into the page is necessary but not sufficient. Since 2025 the endpoint also requires a **Proof of Origin token**, and it is *not present in the `baseUrl` the player response gives you*:

```js
new URL(track.baseUrl).searchParams.has('pot')  // false
```

The player generates the token at request time and appends it, along with `potc`, `c=WEB`, `cver`, and `xorb`/`xobt`/`xovt`. Without them, empty body.

### Getting a valid token

You cannot mint one. You can observe one the player already made.

**Hooking `window.fetch` and `XMLHttpRequest.prototype.open` does not work.** The YouTube player captures its own reference early in page load, so it never goes through your override. Measured on a real page: zero hook captures, one visible entry in `performance`.

What does work is reading the Resource Timing API:

```js
performance.getEntriesByType('resource')
  .map(e => e.name)
  .filter(n => n.includes('/api/timedtext') && n.includes('pot='))
```

### Forcing the player to make that request

If the player never fetched captions, there is nothing to observe. Cycling through caption tracks with `setOption('captions', 'track', …)` forces a fetch — but only on videos with several tracks. With a single track, the player serves it from cache and no request hits the network.

Discarding the module first defeats the cache:

```js
player.unloadModule('captions');
await sleep(400);
player.loadModule('captions');
await sleep(800);
player.setOption('captions', 'track', candidate);
// then poll performance for a fresh /api/timedtext URL containing pot=
```

Note also that `getOption('captions', 'tracklist')` can return an empty array indefinitely even when the video has captions — it is not a usable precondition. Take candidate tracks from the player response instead.

### Reusing the captured URL

The token is not bound to the language, so one captured URL serves any track. Copy the track-identifying parameters over the session ones:

```js
const merged = new URL(capturedUrlWithPot);
for (const key of ['lang', 'kind', 'name', 'tlang', 'variant']) {
  const value = new URL(track.baseUrl).searchParams.get(key);
  value === null ? merged.searchParams.delete(key)
                 : merged.searchParams.set(key, value);
}
merged.searchParams.set('fmt', 'json3');
```

### Fallback layers

In order, stopping at the first that returns text:

1. Plain `baseUrl` fetch from the page — still works on some videos, no side effects.
2. Player session with `pot`, as above. **This is the one that carries most videos today.**
3. `/youtubei/v1/get_transcript`, the endpoint the transcript panel uses.
4. Scraping the "Show transcript" DOM panel. Filter for *visible* buttons — several hidden elements match the same label and clicking one does nothing.

The extension restores the user's caption state afterwards, since layer 2 turns subtitles on to trigger the request.

---

## Limitations

- **This will break.** It depends on YouTube internals that have changed twice in two years. Layer 2 is the current answer, not a permanent one.
- Automating the Gemini web UI is outside its intended use. Fine for personal use; it is why this is not on the Chrome Web Store.
- Videos with no captions at all cannot be summarized — there is nothing to extract.
- Not affiliated with, endorsed by, or connected to Google or YouTube.

---

## Project layout

```
manifest.json
src/
  background/service-worker.js   Routes pending prompts to the right tab
  content/yt-transcript.js       Isolated-world fallback extractor
  content/gemini-paste.js        Pastes and sends in the Gemini tab
  services/youtube-service.js    Extraction layers (injected MAIN world)
  sidepanel/                     Action buttons and state UI
  options/                       Action editor
```

## License

MIT — see [LICENSE](LICENSE).
