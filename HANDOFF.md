# WatchWise — Engineering Hand-off

You are taking over **WatchWise**, a mobile-first PWA that wraps YouTube with an
AI "reflection gate": when a kid finishes a video, an AI buddy asks them to think
about it before they can watch another. It learns from each conversation.

You have direct filesystem access to the working copy. Read this whole doc before
editing — there are several non-obvious gotchas (service worker caching, a repo
divergence, Google avatar referrer policy, Family Link account limits).

---

## 1. Where everything lives

| Thing | Location |
|-------|----------|
| Local working copy | `C:\Users\dayze\watchwise` (Windows / PowerShell) |
| GitHub repo (source of truth) | `github.com/memeticcowboy/watchwise`, branch `main` |
| Local secrets | `watchwise\.env` (gitignored — never commit it) |
| Learner profiles (runtime data) | `watchwise\data\profiles\*.json` (gitignored) |

### ⚠️ Repo divergence — read this
There is an **older copy** of this code at
`github.com/memeticcowboy/memeticcowboy.github.io`, branch
`claude/youtube-parental-engagement-app-S0E9v`, in subfolder `youtube-engagement-app/`.
That was the original build location. **It is BEHIND** — it does NOT contain the
four hot-fixes listed in Section 6. **Treat `memeticcowboy/watchwise` as the only
source of truth.** Do not pull from the old branch.

---

## 2. What it is / how it works

1. Kid searches YouTube (or browses their own subs/recs if signed in) and plays a video.
2. When the video **ends** (YouTube IFrame API `onStateChange` → ended), the player
   is replaced by a chat gate.
3. An AI agent asks 1–4 age-appropriate questions about the video. The kid must
   engage before the gate unlocks.
4. Each completed conversation updates a per-kid **learner profile** (interests,
   topics, engagement, and the agent's own notes), which the agent uses to make
   cross-video connections over time.

Core (search + gate) needs only `GEMINI_API_KEY` + `YOUTUBE_API_KEY`. Everything
else (sign-in, personalized feed) is additive.

---

## 3. Tech stack

- **Backend:** Node.js + Express (`server/index.js`)
- **AI:** Vercel AI SDK — `ai` v6, `@ai-sdk/google` v3 (Gemini 2.5 Flash, **default**),
  `@ai-sdk/anthropic` v3 (Claude Haiku, opt-in), `@openrouter/ai-sdk-provider` v2
  (`google/gemma-4-26b-a4b-it:free` — automatic fallback when the primary errors), `zod`
- **Frontend:** vanilla HTML/CSS/JS, mobile-first, PWA (`manifest.json` + `sw.js`)
- **Player:** YouTube IFrame Player API
- **YouTube data:** YouTube Data API v3 (search, subscriptions, activities)
- **Auth:** Google OAuth 2.0, scope `youtube.readonly` + `userinfo.profile`
- **Storage:** learner profiles = flat JSON on disk; watch history = browser `localStorage`.
  No database.

Model IDs (do not "correct" these): `gemini-2.5-flash`, `claude-haiku-4-5`.

---

## 4. File map

```
watchwise/
├── server/
│   ├── index.js            # Express: OAuth, YouTube proxy, /api/chat agent, model resolver
│   └── learner-profile.js  # Per-kid memory: interests, topic counts, agent notes
├── public/
│   ├── index.html          # App shell (player, chat gate, history/settings panels, PIN + limit modals)
│   ├── app.js              # All frontend logic (IIFE). Player, gate, auth UI, history, settings, PIN
│   ├── styles.css          # Mobile-first dark theme
│   ├── sw.js               # Service worker (PWA offline shell) — SEE GOTCHA in §7
│   ├── manifest.json       # PWA manifest
│   └── icons/icon.svg
├── .env.example            # Template; copy to .env
├── package.json
├── README.md
└── LICENSE
```

Note: there is intentionally **no** `openclaw-client.js` — an earlier OpenClaw
integration was removed in favor of the Vercel AI SDK. Don't reintroduce it.

### Key backend pieces (`server/index.js`)
- `resolveModelChain(preferredModel)` — returns an ordered list of model candidates:
  the parent's preferred model (Gemini default; Claude if picked and `ANTHROPIC_API_KEY` is set),
  then the OpenRouter free Gemma model (`GEMMA_API_KEY`) as an automatic fallback. `/api/chat`
  iterates the chain so the gate survives a primary-provider outage (e.g. Gemini 503s); if every
  model fails, it returns a static safe question so the gate never breaks.
- `GEMINI_SAFETY_SETTINGS` — all four harm categories at `BLOCK_LOW_AND_ABOVE`,
  passed via `providerOptions.google.safetySettings`.
- `buildSystemPrompt(...)` — age/style/learner-context-aware prompt. On the final
  turn it instructs the model to append `---AGENT_NOTES---` + a private note about
  the kid; the server splits that off, hides it from the kid, and saves it to the profile.
- `buildTools(videoId, profile)` — two agent tools:
  - `recallPastConversations({ query })` — searches the profile's `conversationInsights`.
  - `getVideoContext({ reason })` — fetches the video's full description/tags via
    YouTube Data API (`reason` param exists only because Gemini rejects empty tool schemas).
- `POST /api/chat` — `generateText({ model, system, messages, tools,
  stopWhen: stepCountIs(4), maxOutputTokens: 400, temperature: 0.8, providerOptions })`.

### API endpoints
- `GET /auth/google`, `GET /auth/google/callback`, `POST /auth/logout`
- `GET /api/auth-status`
- `GET /api/search?q=` (public videos, `safeSearch=strict`)
- `GET /api/channel-videos?channelId=` (latest videos from a channel — **already exists**, reuse for Approved Channels)
- `GET /api/subscriptions`, `GET /api/recommendations` (require sign-in)
- `POST /api/chat`
- `GET /api/learner-profile`
- `POST /api/verify-pin`

---

## 5. Environment / secrets (`.env`)

Copy `.env.example` → `.env`. The user already has a working `.env` locally (do not
overwrite it). Variables:

| Var | Required | Notes |
|-----|----------|-------|
| `GEMINI_API_KEY` | Yes (default model) | aistudio.google.com/apikey |
| `YOUTUBE_API_KEY` | Yes (search/channels) | Cloud Console → enable **YouTube Data API v3** → API key. NOTE: must be created on a **non-supervised** Google account; child/Family Link accounts can't use Cloud Console. |
| `PARENT_PIN` | Recommended | Gates the settings panel. **Defaults to `1234`** if unset. |
| `SESSION_SECRET` | Recommended | Signs sessions |
| `ANTHROPIC_API_KEY` | Optional | Enables Claude Haiku as a selectable model |
| `GEMMA_API_KEY` | Optional | OpenRouter key (`sk-or-v1-…`) for the free Gemma fallback model — used automatically when the primary model errors. Note: the `:free` model is rate-limited upstream; add a Google AI Studio key at openrouter.ai/settings/integrations for higher limits. |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | Optional | OAuth sign-in. Redirect URI must be **exactly** `http://localhost:3000/auth/google/callback`. OAuth app is in "Testing" mode → only accounts added as **Test users** can sign in. |
| `LEARNER_PROFILE_ID` | Optional | Profile name when not signed in (default `default`) |
| `PORT` | Optional | Default `3000`. If changed, the OAuth redirect URI must change to match. |

**Any `.env` change requires a server restart** (`Ctrl+C`, then `npm start`) — vars load at boot.

---

## 6. Pending hot-fixes — VERIFY AND APPLY THESE FIRST

> **Verification status (2026-06-16, on handoff takeover):** Fixes 1, 2, and 3 were
> confirmed **already applied** in `memeticcowboy/watchwise`. Only **Fix 4** was
> missing; it has now been applied (account avatar in `index.html`, channel icons in
> `app.js`) and committed. The per-fix notes below are retained for reference.

These were delivered to the user as manual edits over chat. Some are confirmed
applied, some are uncertain. **Open each file, check whether the fix is present,
apply if missing, then commit + push.** Exact target state below.

### Fix 1 — PIN callback bug (CONFIRMED applied) — `public/app.js`
Bug: `hidePinModal()` nulled `pinCallback` *before* it was invoked, so entering a
correct PIN closed the modal without opening Settings. Target state — in `verifyPin`,
capture the callback before hiding:
```js
      if (data.valid) {
        const cb = pinCallback;
        hidePinModal();
        if (cb) cb();
      } else {
```
(The user may instead have deleted the `pinCallback = null;` line from `hidePinModal()` — that also
works. **Current state: the latter — `hidePinModal()` only hides the modal and no longer nulls the
callback, so `verifyPin` works correctly.**) Default PIN is `1234` unless `PARENT_PIN` is set.

### Fix 2 — avatar sign-out (CONFIRMED applied) — `public/app.js`
In `bindEvents`, the account button should offer logout when signed in:
```js
    els.accountBtn.addEventListener('click', () => {
      if (!state.loggedIn) {
        signIn();
      } else if (confirm('Sign out of YouTube?')) {
        signOut();
      }
    });
```

### Fix 3 — service worker over-caching (CONFIRMED applied) — `public/sw.js`
The SW intercepted every request, which (a) spammed `chrome-extension://` cache errors and (b) broke
the `/auth/google` OAuth redirect once the SW became active. Target state:
* Bump cache name: `const CACHE_NAME = 'watchwise-v2';`
* Guard the `fetch` handler:
```js
  // Only cache same-origin static assets. Skip API/auth routes, cross-origin,
  // and non-http schemes (chrome-extension://) — caching those throws or
  // breaks the OAuth redirect.
  if (
    event.request.method !== 'GET' ||
    url.origin !== self.location.origin ||
    url.pathname.startsWith('/api/') ||
    url.pathname.startsWith('/auth/')
  ) {
    return;
  }
```

### Fix 4 — Google avatars 403 (APPLIED on 2026-06-16) — `public/index.html` + `public/app.js`
Google-hosted avatars (`googleusercontent.com`, `ggpht.com`) 403 when sent a referrer from localhost,
so profile pic + channel icons render broken. Add `referrerpolicy="no-referrer"` to both avatar
`<img>` tags:
* `public/index.html` (the `#account-avatar` img): `<img id="account-avatar" class="avatar hidden" alt="" referrerpolicy="no-referrer">`
* `public/app.js` (the `.sub-avatar` img in `renderSubscriptions`): `<img class="sub-avatar" src="${escapeAttr(sub.thumbnail)}" alt="" loading="lazy" referrerpolicy="no-referrer">`

After applying: `git add -A && git commit -m "..." && git push`.

---

## 7. Gotchas that will waste your time if you don't know them

* **Service worker caching is the #1 trap.** After editing any file in `public/`, a normal refresh
  serves the cached old version. To see changes: hard reload (Ctrl+Shift+R) and/or DevTools →
  Application → Service Workers → Unregister, then reload. When in doubt, bump `CACHE_NAME` in `sw.js`.
* **Supervised / Family Link accounts cannot sign in via Google OAuth** to a third-party app, even
  with a sensitive scope approved. This is Google policy, not a bug. The kid's account WILL fail
  sign-in; only regular accounts work. Do not spend time trying to "fix" this — see the Approved
  Channels feature (§8) as the intended kid-facing alternative.
* **Platform is Windows PowerShell.** Don't hand the user bash-isms: no `\` line-continuations
  (PowerShell uses backtick), use `$HOME`, etc. Keep multi-part commands on one line.
* **`.env` edits need a server restart.** Frontend edits do not (just hard-reload).
* **Default model is Gemini. Don't switch it.** Claude Haiku is opt-in via the parent's "AI Model"
  setting + `ANTHROPIC_API_KEY`.

---

## 8. Outstanding feature to build: "Approved Channels"

Why: the personalized feed requires sign-in, but the kid's supervised account can't sign in. Approved
Channels gives a curated home screen with no kid sign-in, and is more aligned with the app's
"intentional watching" goal than an algorithmic feed.

Spec:
1. **Parent UI** (PIN-protected settings): a new "Approved Channels" section where the parent can
   search for and add/remove trusted channels. Persist the list in `localStorage` (e.g. key
   `watchwise_approved_channels`) as `[{ channelId, title, thumbnail }]`.
2. **New backend endpoint:** `GET /api/search-channels?q=` — YouTube Data API `search` with
   `type=channel`, returns `{ channelId, title, thumbnail }[]`. (The existing `/api/search` is
   videos-only, so a channel search is needed for the "add channel" flow.)
3. **Kid home screen:** when signed out (and optionally always), show a "Channels for you" section.
   For each approved channel, call the existing `GET /api/channel-videos?channelId=` and render the
   videos using the existing `.video-card` markup + click handler (which already routes through
   `playVideo` → conversation gate → daily-limit checks). Reuse `renderSearchResults`-style rendering.
4. **Must work fully without OAuth.** Keep `referrerpolicy="no-referrer"` on any new channel/avatar imgs.

---

## 9. Run & smoke-test locally

```powershell
cd C:\Users\dayze\watchwise
npm install
npm start            # → "WatchWise running at http://localhost:3000" + "AI model: Gemini 2.5 Flash"
```

Open http://localhost:3000. Test checklist:
1. Search a video → plays.
2. Let it end (or seek near the end) → conversation gate appears, Gemini asks a question.
3. Answer the questions → gate unlocks.
4. Gear icon → enter PIN (`1234` or `PARENT_PIN`) → Settings opens (verifies Fix 1).
5. Settings → Learner Profile shows interests/notes after ≥1 completed conversation.
6. Sign in (regular Google account that is a Test user) → profile pic + "Your Channels" render
   (verifies Fix 4) → avatar tap offers Sign out (Fix 2).

---

## 10. Suggested priority order

1. Apply/verify the four §6 fixes and push (gets the app to a clean known-good state). ✅ done 2026-06-16
2. Build Approved Channels (§8) — the feature that makes it usable for the actual kid.
3. Optional polish: a deploy guide (Render/Railway/Fly) so it's reachable from the kid's iPhone as an
   installed PWA rather than localhost.

The app's purpose is reflective, low-friction watching — bias toward simplicity over features, and
keep the AI replies short and kid-appropriate.
