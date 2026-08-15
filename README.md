# Resume Builder

A single-page resume builder that produces an A4 PDF, a Word `.docx` and a plain-text
version from one set of content. No build step, no framework, no tracking. Everything
runs in the browser and the resume never leaves the visitor's device unless they
explicitly ask for an AI rewrite.

---

## Deploy it

The site is static. Drop the folder on any host:

| Host | Steps |
|---|---|
| **GitHub Pages** | Push the folder, then Settings → Pages → deploy from branch. |
| **Netlify** | Drag the folder onto the Netlify dashboard, or connect the repo. No build command; publish directory is the folder root. |
| **Cloudflare Pages** | Connect the repo. Build command: *(none)*. Output directory: `/`. |
| **Vercel** | `vercel deploy`. It is detected as a static site; `api/rewrite.js` becomes a serverless function automatically. |
| **Anything else** | It is plain HTML — any static file server works, including `python3 -m http.server`. |

Serve it over **https** (or `localhost`). The service worker and the install prompt
are disabled on plain `http` and on `file://`, though the app itself still works.

### Files

```
index.html                 the whole app
manifest.webmanifest       PWA metadata
sw.js                      offline app-shell cache
icons/                     app icons
api/rewrite.js             optional backend — Vercel / Netlify Node runtime
functions/api/rewrite.js   optional backend — Cloudflare Pages Functions
```

Deploy **one** backend file, not both. Delete the one that does not match your host.

---

## Optional: one-click AI rewrites

The app has three routes to AI help, and it picks whichever is available. **None of
them is tied to a single vendor.**

1. **Offline coach — always on, no setup.** Scores the resume and flags weak verbs,
   missing numbers, passive voice, clichés and repeated openers. Pure rules, runs locally.
2. **Copy into any chat — no key, no cost to you.** The visitor picks their assistant
   (Claude, ChatGPT, Gemini, Copilot, Grok, DeepSeek, Mistral, Perplexity, OpenRouter),
   copies a prepared prompt, and pastes the reply back.
3. **Own API key — one click, they pay.** The visitor connects a key for any of
   Anthropic, OpenAI, Google Gemini, xAI, DeepSeek, Mistral, Groq, OpenRouter,
   Perplexity, or *any OpenAI-compatible endpoint* via a base URL (Together, Ollama,
   LM Studio…). Models are listed from their key; the cheapest is picked by default.
4. **Shared backend — one click, you pay.** If `/api/rewrite` responds, every visitor
   gets rewrites with no key of their own.

To enable route 4, deploy the backend file and set:

```
AI_PROVIDER=anthropic          # anthropic | openai | gemini | compatible
AI_API_KEY=...                 # the key for that provider
```

Optional:

```
AI_MODEL=claude-haiku-4-5      # sensible default per provider
AI_BASE_URL=https://...        # required for "compatible" (Groq, Mistral, DeepSeek,
                               # xAI, OpenRouter, Together, Ollama, LM Studio…)
ALLOWED_ORIGIN=https://your.domain
DAILY_REQUEST_BUDGET=2000      # crude global cap per instance
```

If you never set `AI_API_KEY`, the endpoint returns 503, the app notices and silently
keeps routes 1–3. Nothing breaks.

### A note on browser-to-vendor calls

Route 3 talks to the vendor straight from the browser. Anthropic, OpenAI and Google
allow this; some others block it with CORS. When that happens the app says so plainly
and points the visitor at routes 2 and 4 instead — it does not fail silently.

### What it costs you

On a small model a bullet rewrite is roughly 290 input and 130 output tokens, about
**$0.001**. A visitor polishing a whole resume costs **1–3 cents**. A thousand
visitors doing that is roughly **$15–30**.

### Cost safety — read this before going public

The rate limits in the backend are **best effort only**. Serverless instances are
ephemeral and do not share memory, so the per-IP and daily counters reset unpredictably
and will not stop a determined abuser. Before you put a funded key behind a public URL:

- Set a **monthly spend limit on the provider key itself** in its console. This is the
  only hard cap.
- Set `ALLOWED_ORIGIN` to your domain.
- For real limits, move the counters into Redis / Cloudflare KV, or put the endpoint
  behind Cloudflare Turnstile.

Visitors can always use their own key instead: the *API key* box in the Writing tab
talks to their chosen provider directly and never touches your backend.

---

## What visitors get

- **Live A4 preview** with true page-break positions, zoom, and the real margins of
  every page shown at the sheet joins.
- **Exports**: PDF (browser print), Word `.docx` (built in-browser, no library), plain text.
- **ATS-safe mode**: one plain column, system font, no decoration, comma-separated
  skills — applied to the preview, PDF, Word and text at once.
- **ATS check**: parseable contact details, recognisable headings, dated roles, page count.
- **Seven templates**: Timeline, Classic, Modern, Compact, Elegant, Technical and ATS
  plain — different typography and section furniture, all single column so ATS text
  extraction stays in reading order.
- **Several resumes**, autosaved to the browser, plus JSON import/export.
- **Installable and offline** once served over https.
- Keyboard navigable, screen-reader labelled, works down to a 390px phone.

## Privacy

**No real resume ships with this repo.** The sample shown on a first visit is a
fictional person, Alex Rivera, using an `@example.com` address and a `555-01xx`
phone number — both reserved ranges that cannot reach anyone. It exists only to
demonstrate the layout, and is replaced the moment a visitor edits anything.

Resume content lives in the visitor's browser and in its `localStorage`, on their
device. It is never uploaded, and it is not in this repository. Nothing leaves the
browser unless the visitor presses an AI button.

If you deploy the optional backend, the text of the line being rewritten — and, for a
full review, the resume as plain text — is sent to Anthropic through your server.
Say so in your privacy policy.

### Publishing your own resume by accident

Editing the app in a browser stores your data in `localStorage`, not in these files,
so normal use cannot leak it. But if you ever paste real content into `sampleData()`
in `index.html` and commit it, it becomes public — and stays in the git history even
after you delete it. Keep your own resume in the app's **Save as JSON** file, kept
outside the repo (`.gitignore` already excludes `*-resume.json`).

## Editing the app

`index.html` is self-contained: styles, the embedded Inria Serif webfont, and all
JavaScript in one file. There is no bundler and nothing to install. Open it in a
browser and edit. If you change `sw.js` or the shell files, bump `CACHE` in `sw.js`
so returning visitors get the new version.
