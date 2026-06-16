require('dotenv').config();

const express = require('express');
const session = require('express-session');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { generateText, tool, stepCountIs } = require('ai');
const { createGoogleGenerativeAI } = require('@ai-sdk/google');
const { createAnthropic } = require('@ai-sdk/anthropic');
const { createOpenRouter } = require('@openrouter/ai-sdk-provider');
const { z } = require('zod');
const learnerProfile = require('./learner-profile');

const app = express();
const PORT = process.env.PORT || 3000;

// --- Middleware ---
app.use(express.json());
app.use(session({
  secret: process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex'),
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: false, // set to true behind HTTPS in production
    httpOnly: true,
    maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days
  },
}));
app.use(express.static(path.join(__dirname, '..', 'public')));

// --- AI providers (via Vercel AI SDK) ---
// Gemini Flash is the default (cheap, kid-safe filters); Claude Haiku is the fallback.
const googleProvider = process.env.GEMINI_API_KEY
  ? createGoogleGenerativeAI({ apiKey: process.env.GEMINI_API_KEY })
  : null;

const anthropicProvider = process.env.ANTHROPIC_API_KEY
  ? createAnthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
  : null;

// OpenRouter — used for the free Gemma fallback model when the primary provider errors.
const openrouterProvider = process.env.GEMMA_API_KEY
  ? createOpenRouter({ apiKey: process.env.GEMMA_API_KEY })
  : null;

// Free fallback model on OpenRouter — keeps the reflection gate working when the
// primary model is unavailable (e.g. Gemini 503s under load).
const OPENROUTER_FALLBACK_MODEL = 'google/gemma-4-26b-a4b-it:free';

// Gemini safety settings — cranked to the strictest setting for kid-safe conversations.
const GEMINI_SAFETY_SETTINGS = [
  { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_LOW_AND_ABOVE' },
  { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_LOW_AND_ABOVE' },
  { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_LOW_AND_ABOVE' },
  { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_LOW_AND_ABOVE' },
];

// Build the ordered list of model candidates to try for a request, based on the
// parent's preference and available keys. The OpenRouter free model is appended
// as a fallback so the reflection gate keeps working when the primary errors.
// Returns an array of { model, providerOptions, label } (empty if none configured).
function resolveModelChain(preferredModel) {
  const chain = [];
  const wantsClaude = preferredModel === 'claude';

  if (wantsClaude && anthropicProvider) {
    chain.push({ model: anthropicProvider('claude-haiku-4-5'), providerOptions: {}, label: 'claude' });
  } else if (googleProvider) {
    chain.push({
      model: googleProvider('gemini-2.5-flash'),
      providerOptions: { google: { safetySettings: GEMINI_SAFETY_SETTINGS } },
      label: 'gemini',
    });
  } else if (anthropicProvider) {
    chain.push({ model: anthropicProvider('claude-haiku-4-5'), providerOptions: {}, label: 'claude' });
  }

  // Append the OpenRouter free model as a last-resort fallback.
  if (openrouterProvider) {
    chain.push({ model: openrouterProvider(OPENROUTER_FALLBACK_MODEL), providerOptions: {}, label: 'openrouter-gemma' });
  }

  return chain;
}

// Default learner profile ID (single-kid mode for now)
const DEFAULT_PROFILE_ID = process.env.LEARNER_PROFILE_ID || 'default';

// --- Google OAuth 2.0 ---
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const GOOGLE_REDIRECT_URI = process.env.GOOGLE_REDIRECT_URI || `http://localhost:${PORT}/auth/google/callback`;

const GOOGLE_SCOPES = [
  'https://www.googleapis.com/auth/youtube.readonly',
  'https://www.googleapis.com/auth/userinfo.profile',
].join(' ');

// Start OAuth flow
app.get('/auth/google', (req, res) => {
  if (!GOOGLE_CLIENT_ID) {
    return res.status(500).json({ error: 'Google OAuth not configured.' });
  }

  const state = crypto.randomBytes(16).toString('hex');
  req.session.oauthState = state;

  const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  url.searchParams.set('client_id', GOOGLE_CLIENT_ID);
  url.searchParams.set('redirect_uri', GOOGLE_REDIRECT_URI);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', GOOGLE_SCOPES);
  url.searchParams.set('access_type', 'offline');
  url.searchParams.set('prompt', 'consent');
  url.searchParams.set('state', state);

  res.redirect(url.toString());
});

// OAuth callback
app.get('/auth/google/callback', async (req, res) => {
  const { code, state } = req.query;

  if (!code || state !== req.session.oauthState) {
    return res.redirect('/?auth=error');
  }

  delete req.session.oauthState;

  try {
    // Exchange code for tokens
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: GOOGLE_CLIENT_ID,
        client_secret: GOOGLE_CLIENT_SECRET,
        redirect_uri: GOOGLE_REDIRECT_URI,
        grant_type: 'authorization_code',
      }),
    });

    const tokens = await tokenRes.json();

    if (tokens.error) {
      console.error('Token exchange error:', tokens);
      return res.redirect('/?auth=error');
    }

    // Store tokens in session
    req.session.youtube = {
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      expiresAt: Date.now() + (tokens.expires_in * 1000),
    };

    // Get user profile
    const profileRes = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
      headers: { Authorization: `Bearer ${tokens.access_token}` },
    });
    const profile = await profileRes.json();

    req.session.user = {
      name: profile.given_name || profile.name || 'Friend',
      picture: profile.picture || null,
    };

    res.redirect('/?auth=success');
  } catch (err) {
    console.error('OAuth callback error:', err);
    res.redirect('/?auth=error');
  }
});

// Refresh access token if expired
async function ensureFreshToken(session) {
  if (!session.youtube) return null;

  if (Date.now() < session.youtube.expiresAt - 60000) {
    return session.youtube.accessToken;
  }

  if (!session.youtube.refreshToken) return null;

  try {
    const res = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: GOOGLE_CLIENT_ID,
        client_secret: GOOGLE_CLIENT_SECRET,
        refresh_token: session.youtube.refreshToken,
        grant_type: 'refresh_token',
      }),
    });

    const data = await res.json();
    if (data.access_token) {
      session.youtube.accessToken = data.access_token;
      session.youtube.expiresAt = Date.now() + (data.expires_in * 1000);
      return data.access_token;
    }
  } catch (err) {
    console.error('Token refresh error:', err);
  }

  return null;
}

// Sign out
app.post('/auth/logout', (req, res) => {
  delete req.session.youtube;
  delete req.session.user;
  res.json({ ok: true });
});

// Get auth status
app.get('/api/auth-status', (req, res) => {
  if (req.session.youtube && req.session.user) {
    res.json({
      loggedIn: true,
      user: req.session.user,
    });
  } else {
    res.json({ loggedIn: false });
  }
});

// --- YouTube Recommendations (authenticated) ---
app.get('/api/recommendations', async (req, res) => {
  const accessToken = await ensureFreshToken(req.session);
  if (!accessToken) {
    return res.json({ error: 'Not signed in.', items: [] });
  }

  try {
    // Get the user's home feed (activities/related)
    // YouTube Data API v3: get popular videos from subscribed channels
    const url = new URL('https://www.googleapis.com/youtube/v3/activities');
    url.searchParams.set('part', 'snippet,contentDetails');
    url.searchParams.set('mine', 'true');
    url.searchParams.set('maxResults', '20');

    const response = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    const data = await response.json();

    if (data.error) {
      console.error('Activities API error:', data.error);
      return res.json({ error: data.error.message, items: [] });
    }

    // Filter to only uploads/recommendations that have a video ID
    const items = (data.items || [])
      .filter((item) => {
        const details = item.contentDetails;
        return details && (details.upload || details.recommendation);
      })
      .map((item) => {
        const details = item.contentDetails;
        const videoId = details.upload
          ? details.upload.videoId
          : details.recommendation
            ? details.recommendation.resourceId.videoId
            : null;

        return {
          videoId,
          title: item.snippet.title,
          channel: item.snippet.channelTitle,
          thumbnail: item.snippet.thumbnails.medium
            ? item.snippet.thumbnails.medium.url
            : item.snippet.thumbnails.default.url,
          description: item.snippet.description,
        };
      })
      .filter((item) => item.videoId);

    res.json({ items });
  } catch (err) {
    console.error('Recommendations error:', err);
    res.json({ error: 'Failed to load recommendations.', items: [] });
  }
});

// --- YouTube Subscriptions (authenticated) ---
app.get('/api/subscriptions', async (req, res) => {
  const accessToken = await ensureFreshToken(req.session);
  if (!accessToken) {
    return res.json({ error: 'Not signed in.', items: [] });
  }

  try {
    const url = new URL('https://www.googleapis.com/youtube/v3/subscriptions');
    url.searchParams.set('part', 'snippet');
    url.searchParams.set('mine', 'true');
    url.searchParams.set('maxResults', '20');
    url.searchParams.set('order', 'relevance');

    const response = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    const data = await response.json();

    if (data.error) {
      return res.json({ error: data.error.message, items: [] });
    }

    const items = (data.items || []).map((item) => ({
      channelId: item.snippet.resourceId.channelId,
      title: item.snippet.title,
      thumbnail: item.snippet.thumbnails.medium
        ? item.snippet.thumbnails.medium.url
        : item.snippet.thumbnails.default.url,
    }));

    res.json({ items });
  } catch (err) {
    console.error('Subscriptions error:', err);
    res.json({ error: 'Failed to load subscriptions.', items: [] });
  }
});

// --- Latest videos from a specific channel ---
app.get('/api/channel-videos', async (req, res) => {
  const channelId = req.query.channelId;
  if (!channelId) {
    return res.json({ error: 'Missing channelId.', items: [] });
  }

  const apiKey = process.env.YOUTUBE_API_KEY;
  if (!apiKey) {
    return res.json({ error: 'YouTube API key not configured.', items: [] });
  }

  try {
    const url = new URL('https://www.googleapis.com/youtube/v3/search');
    url.searchParams.set('part', 'snippet');
    url.searchParams.set('channelId', channelId);
    url.searchParams.set('type', 'video');
    url.searchParams.set('order', 'date');
    url.searchParams.set('maxResults', '6');
    url.searchParams.set('safeSearch', 'strict');
    url.searchParams.set('key', apiKey);

    const response = await fetch(url.toString());
    const data = await response.json();

    const items = (data.items || []).map((item) => ({
      videoId: item.id.videoId,
      title: item.snippet.title,
      channel: item.snippet.channelTitle,
      thumbnail: item.snippet.thumbnails.medium.url,
      description: item.snippet.description,
    }));

    res.json({ items });
  } catch (err) {
    console.error('Channel videos error:', err);
    res.json({ error: 'Failed to load channel videos.', items: [] });
  }
});

// --- YouTube Search ---
app.get('/api/search', async (req, res) => {
  const query = req.query.q;
  if (!query) {
    return res.json({ error: 'Please enter a search query.' });
  }

  const apiKey = process.env.YOUTUBE_API_KEY;
  if (!apiKey) {
    return res.json({ error: 'YouTube API key not configured. Add YOUTUBE_API_KEY to your .env file.' });
  }

  try {
    const url = new URL('https://www.googleapis.com/youtube/v3/search');
    url.searchParams.set('part', 'snippet');
    url.searchParams.set('q', query);
    url.searchParams.set('type', 'video');
    url.searchParams.set('maxResults', '12');
    url.searchParams.set('safeSearch', 'strict');
    url.searchParams.set('key', apiKey);

    const response = await fetch(url.toString());
    const data = await response.json();

    if (data.error) {
      return res.json({ error: data.error.message || 'YouTube API error.' });
    }

    const items = (data.items || []).map((item) => ({
      videoId: item.id.videoId,
      title: item.snippet.title,
      channel: item.snippet.channelTitle,
      thumbnail: item.snippet.thumbnails.medium.url,
      description: item.snippet.description,
    }));

    res.json({ items });
  } catch (err) {
    console.error('YouTube search error:', err);
    res.json({ error: 'Failed to search YouTube. Please try again.' });
  }
});

// --- Build the system prompt with learner context ---
function buildSystemPrompt(videoTitle, videoChannel, settings, isFinal, userName, profile) {
  const ageDescriptions = {
    5: 'a 5-6 year old child (use very simple words, be warm and encouraging)',
    7: 'a 7-8 year old child (use simple language, be enthusiastic)',
    9: 'a 9-10 year old child (conversational, can handle some complexity)',
    11: 'an 11-12 year old kid (treat them more maturely, challenge them a bit)',
    13: 'a teenager (be casual and relatable, don\'t be patronizing)',
  };

  const styleDescriptions = {
    curious: 'Ask fun, curiosity-driven questions that make them wonder about the topic. Use "I wonder..." and "What if..." type questions.',
    socratic: 'Use the Socratic method. Ask questions that guide them to think deeper. Don\'t give answers — help them discover insights themselves.',
    critical: 'Encourage critical thinking. Ask them to evaluate claims, consider different perspectives, and think about what might be missing or biased.',
  };

  const ageDesc = ageDescriptions[settings.age] || ageDescriptions[9];
  const styleDesc = styleDescriptions[settings.style] || styleDescriptions['socratic'];

  const nameInstruction = userName
    ? `The child's name is ${userName}. Use it occasionally to make the conversation personal.`
    : "Use their name if they mention it.";

  // Build learner context from profile
  const learnerContext = learnerProfile.buildLearnerContext(profile);

  return `You are WatchWise, a friendly and engaging thinking buddy for kids. Your job is to help children think critically and reflectively about the YouTube videos they watch. You grow and learn alongside them — you remember what they like, how they think, and what they've watched before.

The child just finished watching: "${videoTitle}" by ${videoChannel}.

WHAT YOU KNOW ABOUT THIS KID:
${learnerContext}

YOUR APPROACH:
- You are talking to ${ageDesc}
- ${styleDesc}
- Keep your messages SHORT — 1-3 sentences max. Kids lose interest with long messages.
- Be genuinely interested and encouraging. Never judgmental.
- Reference specific things from the video title/topic to show you know what they watched.
- ${nameInstruction}
- When relevant, connect this video to things they've watched before or topics they're interested in. ("Hey, this reminds me of that space video you watched last week...")
- If they keep watching the same type of content, gently encourage them to think about it from new angles rather than repeating the same questions.
- NO emojis. Keep it natural and text-like.

TOOLS YOU CAN USE (these run silently — the kid never sees you using them):
- recallPastConversations: search what this kid watched and said before, to make a real connection rather than a generic one. Use it when this video's topic might link to something in their history.
- getVideoContext: pull the full description and tags for the video they just watched, so your questions are specific to the actual content, not just the title.
Use a tool only when it will make your question noticeably better. Then ask your question in plain text.

${isFinal
    ? `This is the child's final response. Give a brief, positive wrap-up that validates their thinking. 1-2 sentences max. Make them feel good about reflecting.

AFTER your wrap-up message, on a NEW LINE, write "---AGENT_NOTES---" followed by a brief note (1-2 sentences) about what you learned about this kid from this conversation — their interests, how they think, what surprised you. This note will be saved for future conversations. The kid will NOT see anything after the separator.`
    : `This is turn ${settings.currentTurn || 0} of ${settings.turnsRequired}. Ask ONE clear question and wait for their answer.`}

IMPORTANT: If the child gives a very short or dismissive answer (like "idk", "it was good", "nothing"), gently redirect with a more specific, easier question. Don't accept one-word answers — help them articulate their thoughts, but don't be annoying about it.`;
}

// --- Agent tools (run server-side; the kid never sees them) ---
function buildTools(videoId, profile) {
  return {
    recallPastConversations: tool({
      description:
        "Search this kid's past video conversations by topic or keyword to find a real connection to what they're watching now. Returns up to 5 matching past conversations with what the kid said.",
      inputSchema: z.object({
        query: z
          .string()
          .describe('A topic or keyword to search past conversations for, e.g. "space" or "minecraft"'),
      }),
      execute: async ({ query }) => {
        const q = query.toLowerCase();
        const matches = (profile.conversationInsights || [])
          .filter(
            (c) =>
              c.videoTitle.toLowerCase().includes(q) ||
              (c.topics || []).some((t) => t.toLowerCase().includes(q)) ||
              (c.kidSaid || '').toLowerCase().includes(q)
          )
          .slice(-5)
          .map((c) => ({
            videoTitle: c.videoTitle,
            topics: c.topics,
            kidSaid: c.kidSaid,
            date: c.date,
          }));

        if (matches.length === 0) {
          return { found: false, message: 'No past conversations match that topic.' };
        }
        return { found: true, conversations: matches };
      },
    }),

    getVideoContext: tool({
      description:
        'Fetch more detail about the video the kid just watched (full description, tags, category) so your question can be specific to the actual content, not just the title.',
      inputSchema: z.object({
        reason: z
          .string()
          .describe('Briefly, what you hope to learn from the video details (e.g. "what topics it covers")'),
      }),
      execute: async () => {
        const apiKey = process.env.YOUTUBE_API_KEY;
        if (!apiKey || !videoId) {
          return { available: false, message: 'No extra context available.' };
        }
        try {
          const url = new URL('https://www.googleapis.com/youtube/v3/videos');
          url.searchParams.set('part', 'snippet');
          url.searchParams.set('id', videoId);
          url.searchParams.set('key', apiKey);

          const response = await fetch(url.toString());
          const data = await response.json();
          const snippet = data.items && data.items[0] && data.items[0].snippet;

          if (!snippet) {
            return { available: false, message: 'No extra context available.' };
          }
          return {
            available: true,
            description: (snippet.description || '').slice(0, 1500),
            tags: (snippet.tags || []).slice(0, 15),
          };
        } catch {
          return { available: false, message: 'Could not load video context.' };
        }
      },
    }),
  };
}

// --- Chat endpoint: Vercel AI SDK with tool-using agent + persistent learner profile ---
app.post('/api/chat', async (req, res) => {
  const { videoTitle, videoChannel, videoId, history, settings, isFinal } = req.body;

  const userName = req.session.user ? req.session.user.name : null;
  const profileId = req.session.user ? req.session.user.name.toLowerCase().replace(/\s+/g, '_') : DEFAULT_PROFILE_ID;
  const profile = learnerProfile.loadProfile(profileId);

  // Set the kid's name from YouTube profile if we have it
  if (userName && profile.name === 'Kid') {
    profile.name = userName;
    learnerProfile.saveProfile(profile);
  }

  const systemPrompt = buildSystemPrompt(videoTitle, videoChannel, settings, isFinal, userName, profile);

  // Build messages array
  const messages = (history || []).map((msg) => ({
    role: msg.role === 'assistant' ? 'assistant' : 'user',
    content: msg.content,
  }));

  if (messages.length === 0) {
    messages.push({
      role: 'user',
      content: `I just finished watching "${videoTitle}". Ask me about it!`,
    });
  }

  const chain = resolveModelChain(settings.model);
  if (chain.length === 0) {
    return res.json({
      message: isFinal
        ? 'Great job thinking about what you watched!'
        : 'What was the most interesting thing in that video?',
    });
  }

  // Try each model in order; fall back to the next one if a provider errors out
  // (e.g. Gemini 503s under load) so the reflection gate keeps working.
  let responseMessage = null;
  for (const candidate of chain) {
    try {
      const { text } = await generateText({
        model: candidate.model,
        system: systemPrompt,
        messages,
        tools: buildTools(videoId, profile),
        stopWhen: stepCountIs(4), // allow the agent to call a tool, then answer
        maxOutputTokens: 400,
        temperature: 0.8,
        providerOptions: candidate.providerOptions,
      });
      responseMessage = text;
      if (candidate.label !== chain[0].label) {
        console.log(`Chat: primary model failed; served via fallback (${candidate.label}).`);
      }
      break;
    } catch (err) {
      console.error(`Chat error (${candidate.label}):`, err.message || err);
      // fall through and try the next candidate
    }
  }

  // Every model failed — fail safe with a generic question so the gate still works.
  if (responseMessage === null) {
    return res.json({
      message: isFinal
        ? 'Great job thinking about what you watched!'
        : 'What was the most interesting thing in that video?',
    });
  }

  // Final turn: split off the private agent notes (the kid must never see them)
  // and persist them to the learner profile. Compute the visible message first so
  // a profile-write error can never crash the request or leak the notes.
  if (isFinal && responseMessage) {
    const noteSeparator = '---AGENT_NOTES---';
    const noteIdx = responseMessage.indexOf(noteSeparator);
    const visibleMessage = noteIdx !== -1 ? responseMessage.slice(0, noteIdx).trim() : responseMessage;
    const agentNotes = noteIdx !== -1 ? responseMessage.slice(noteIdx + noteSeparator.length).trim() : '';

    try {
      learnerProfile.updateProfileAfterConversation(profile, videoTitle, videoChannel, history || []);
      if (agentNotes) {
        // Append to existing notes rather than replacing
        const existingNotes = profile.agentNotes || '';
        const combinedNotes = existingNotes
          ? `${existingNotes}\n[${new Date().toLocaleDateString()}] ${agentNotes}`
          : agentNotes;
        learnerProfile.updateAgentNotes(profile, combinedNotes);
      }
    } catch (err) {
      console.error('Profile update error:', err.message || err);
    }

    return res.json({ message: visibleMessage });
  }

  res.json({ message: responseMessage });
});

// --- Learner Profile API (for parent settings panel) ---
app.get('/api/learner-profile', async (req, res) => {
  // PIN-protected on the frontend side
  const profileId = req.query.profileId || DEFAULT_PROFILE_ID;
  const profile = learnerProfile.loadProfile(profileId);
  res.json(profile);
});

// --- Imported subscriptions (from Google Takeout, served from data/, no OAuth) ---
// Lets the kid's curated channels work even on a supervised account that the
// YouTube API refuses. Populated by scripts/import-takeout.js.
app.get('/api/imported-subscriptions', (req, res) => {
  const file = path.join(__dirname, '..', 'data', 'import', 'subscriptions.json');
  try {
    if (!fs.existsSync(file)) return res.json({ items: [] });
    const items = JSON.parse(fs.readFileSync(file, 'utf-8'));
    res.json({ items: Array.isArray(items) ? items : [] });
  } catch (err) {
    console.error('Imported subscriptions error:', err.message || err);
    res.json({ items: [] });
  }
});

// --- PIN Verification ---
app.post('/api/verify-pin', (req, res) => {
  const { pin } = req.body;
  const correctPin = process.env.PARENT_PIN || '1234';
  res.json({ valid: pin === correctPin });
});

// --- Catch-all for SPA ---
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

// --- Start ---
app.listen(PORT, () => {
  console.log(`WatchWise running at http://localhost:${PORT}`);

  if (googleProvider) {
    console.log('  AI model: Gemini 2.5 Flash (kid-safe filters: max) via Vercel AI SDK');
    if (anthropicProvider) console.log('  Fallback model available: Claude Haiku');
  } else if (anthropicProvider) {
    console.log('  AI model: Claude Haiku via Vercel AI SDK');
  } else if (openrouterProvider) {
    console.log(`  AI model: ${OPENROUTER_FALLBACK_MODEL} (OpenRouter)`);
  } else {
    console.log('  WARNING: No AI model configured! Set GEMINI_API_KEY, GEMMA_API_KEY, or ANTHROPIC_API_KEY');
  }

  if (openrouterProvider && (googleProvider || anthropicProvider)) {
    console.log(`  Fallback model available: ${OPENROUTER_FALLBACK_MODEL} (OpenRouter)`);
  }

  if (!GOOGLE_CLIENT_ID) {
    console.log('  YouTube sign-in disabled (no GOOGLE_CLIENT_ID). Search-only mode.');
  }
});
