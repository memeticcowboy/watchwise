# WatchWise

**Think before you watch.** A mobile-first web app that wraps YouTube with an AI conversation gate: when a kid finishes a video, a friendly AI buddy asks them to reflect on what they watched before they can move on to the next one. The agent learns from each conversation and becomes a better thinking partner over time.

Built as an installable PWA (works great added to an iPhone home screen), with PIN-protected parental controls.

---

## Why

Endless autoplay trains kids to consume without thinking. WatchWise puts a small, friendly speed bump between videos — a short, age-appropriate conversation about what they just watched — so watching becomes reflective instead of passive.

---

## How it works

1. **Watch** — Kid searches YouTube (or browses their own subscriptions/recommendations if signed in) and plays a video in an embedded player.
2. **Reflect** — When the video ends, the player is replaced by a chat gate. An AI buddy asks 1–4 age-appropriate questions about the video.
3. **Unlock** — After the kid engages, the gate opens and they can pick another video.
4. **Learn** — Every conversation updates a per-kid *learner profile* (interests, topics, how they think). The agent uses it to make real connections across videos ("this rocket video reminds me of that black-hole one you watched last week…").

---

## Features

- 📺 **Embedded YouTube** via the official IFrame Player API — no re-hosting, ToS-friendly
- 🤖 **AI conversation gate** that blocks the next video until the kid reflects
- 🧠 **Adaptive learner profile** — tracks interests, topic patterns, engagement, and the agent's own evolving notes about the kid
- 🛠️ **Tool-using agent** — can recall past conversations and fetch a video's real description/tags to ask specific, informed questions
- 🔑 **YouTube sign-in (optional)** — personalized subscriptions + recommendations via Google OAuth (read-only scope)
- 👪 **PIN-protected parent settings** — question count, child age, conversation style, daily video limit, model choice, and a learner-profile dashboard
- 📱 **Installable PWA** — add to iPhone/Android home screen; works offline for the shell
- 🛡️ **Kid-safe by default** — Gemini safety filters at the strictest setting; YouTube `safeSearch=strict`

---

## Tech stack

| Layer | Tech |
|-------|------|
| Frontend | Vanilla HTML/CSS/JS, mobile-first, PWA (manifest + service worker) |
| Player | YouTube IFrame Player API |
| Backend | Node.js + Express |
| AI | [Vercel AI SDK](https://ai-sdk.dev) (`ai` v6) with `@ai-sdk/google` (Gemini 2.5 Flash, default) and `@ai-sdk/anthropic` (Claude Haiku, fallback) |
| Data | YouTube Data API v3 (search, subscriptions, recommendations); Google OAuth 2.0 |
| Storage | JSON learner profiles on disk (`data/profiles/`); watch history in browser `localStorage` |

No database required — profiles are flat JSON files.

---

## Project layout

```
watchwise/
├── server/
│   ├── index.js            # Express server: OAuth, YouTube proxy, chat agent
│   └── learner-profile.js  # Per-kid memory: interests, patterns, agent notes
├── public/
│   ├── index.html          # App shell (player, chat gate, panels, modals)
│   ├── app.js              # Frontend logic (player, gate, history, settings)
│   ├── styles.css          # Mobile-first dark theme
│   ├── sw.js               # Service worker (PWA offline shell)
│   ├── manifest.json       # PWA manifest
│   └── icons/icon.svg      # App icon
├── .env.example            # Copy to .env and fill in
└── package.json
```

---

## Setup

### 1. Install

```bash
npm install
```

### 2. Configure

```bash
cp .env.example .env
```

Fill in `.env`:

| Variable | Required? | What it's for | Where to get it |
|----------|-----------|---------------|-----------------|
| `GEMINI_API_KEY` | **Yes** (default model) | The conversation agent | [Google AI Studio](https://aistudio.google.com/apikey) — free tier is plenty |
| `YOUTUBE_API_KEY` | **Yes** (search) | YouTube search & video data | [Google Cloud Console](https://console.cloud.google.com/) → enable *YouTube Data API v3* |
| `PARENT_PIN` | Recommended | Locks the settings panel | You choose (4 digits) |
| `SESSION_SECRET` | Recommended | Signs login sessions | Any random string |
| `ANTHROPIC_API_KEY` | Optional | Claude Haiku as a fallback/alternative model | [Anthropic Console](https://console.anthropic.com/) |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | Optional | YouTube sign-in for personalized feed | [Google Cloud Console → Credentials](https://console.cloud.google.com/apis/credentials) |
| `LEARNER_PROFILE_ID` | Optional | Profile name when not signed in (default `default`) | You choose |
| `PORT` | Optional | Server port (default `3000`) | — |

> The app runs in **search-only mode** without OAuth configured — sign-in is purely additive.

#### Google OAuth (optional, for the personalized feed)

When creating OAuth credentials, set the redirect URI to:

```
http://localhost:3000/auth/google/callback
```

The app only requests the **read-only** `youtube.readonly` scope — it can read subscriptions and watch activity, never post or modify anything.

### 3. Run

```bash
npm start
```

Open **http://localhost:3000**.

---

## Installing on an iPhone

1. Run the server somewhere the phone can reach (same Wi-Fi, or a host like Render/Railway/Fly).
2. Open the URL in **Safari** → Share → **Add to Home Screen**.
3. Launch it from the home screen — it runs full-screen like a native app.

**To make it the *only* way the kid reaches YouTube:** use iOS **Screen Time** to block the YouTube app and `youtube.com` in Safari, so the only path to videos goes through WatchWise (and therefore through the reflection gate).

---

## Parent settings

Tap the gear icon and enter your PIN to access:

- **Questions per video** (1–4)
- **Child's age** — tunes the agent's vocabulary and tone (5–6 up to 13+)
- **Conversation style** — Curious & fun · Socratic · Critical thinking
- **Daily video limit** (3 / 5 / 10 / unlimited)
- **AI model** — Gemini Flash (default, free, kid-safe filters) or Claude Haiku
- **YouTube account** — sign in / out
- **Learner profile dashboard** — the kid's top interests, the agent's notes, and recent conversation summaries

---

## How the agent learns

Each completed conversation updates `data/profiles/<id>.json`:

- **Interests** — topics auto-detected from video titles, ranked by frequency
- **Topic breakdown** — running counts per category
- **Engagement** — average response length (the agent adapts: short answers → more concrete questions)
- **Conversation insights** — a rolling log of the last 50 chats with what the kid said
- **Agent notes** — after each chat, the agent writes itself a private note about the kid that persists into future conversations

During a chat the agent can call two tools (silently — the kid never sees them):

- `recallPastConversations` — search the kid's history for a real connection
- `getVideoContext` — pull the video's full description and tags for specific questions

---

## Privacy

- Learner profiles and conversations are stored **locally** as JSON in `data/profiles/` (gitignored).
- Watch history lives in the browser's `localStorage`.
- YouTube OAuth tokens are kept in the server session only; the scope is read-only.
- No analytics, no third-party tracking. Video content is fed to the configured AI provider (Google or Anthropic) only as text titles/descriptions to power the conversation.

---

## License

MIT — do what you like.
