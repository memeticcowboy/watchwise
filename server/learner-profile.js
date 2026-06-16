const fs = require('fs');
const path = require('path');

const PROFILES_DIR = path.join(__dirname, '..', 'data', 'profiles');

// Ensure data directory exists
function ensureDir() {
  if (!fs.existsSync(PROFILES_DIR)) {
    fs.mkdirSync(PROFILES_DIR, { recursive: true });
  }
}

function profilePath(profileId) {
  return path.join(PROFILES_DIR, `${profileId}.json`);
}

// Default empty profile
function createProfile(profileId, name) {
  return {
    id: profileId,
    name: name || 'Kid',
    createdAt: new Date().toISOString(),

    // Accumulated knowledge about the kid
    interests: [],           // [{ topic, strength, firstSeen, lastSeen, videoCount }]
    thinkingPatterns: [],     // [{ pattern, examples, frequency }]
    conversationInsights: [], // [{ date, videoTitle, insight }] — last 50

    // Aggregated stats
    totalVideosWatched: 0,
    totalConversations: 0,
    avgResponseLength: 0,
    topicBreakdown: {},      // { "science": 12, "gaming": 8, ... }

    // The agent's evolving understanding (updated after each conversation)
    agentNotes: '',          // Free-form notes the agent builds over time
  };
}

function loadProfile(profileId) {
  ensureDir();
  const filePath = profilePath(profileId);

  if (fs.existsSync(filePath)) {
    try {
      return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    } catch {
      return createProfile(profileId);
    }
  }

  return createProfile(profileId);
}

function saveProfile(profile) {
  ensureDir();
  fs.writeFileSync(profilePath(profile.id), JSON.stringify(profile, null, 2));
}

// Extract likely topic categories from a video title
function extractTopics(videoTitle) {
  const title = videoTitle.toLowerCase();
  const topicPatterns = {
    science: /science|experiment|physics|chemistry|biology|space|nasa|planet|atom/,
    math: /math|equation|calcul|number|geometry|algebra/,
    gaming: /minecraft|roblox|fortnite|gaming|gameplay|playthrough|speedrun|let'?s play/,
    animals: /animal|dog|cat|wildlife|dinosaur|shark|insect|bird|ocean life/,
    history: /history|ancient|medieval|world war|civilization|empire/,
    art: /drawing|painting|art|craft|diy|creative|design|origami/,
    music: /music|song|beat|instrument|guitar|piano|drum|singing/,
    sports: /soccer|football|basketball|baseball|sports|athletic|olympics/,
    cooking: /cook|recipe|baking|food|kitchen|chef/,
    tech: /coding|programming|robot|technology|computer|ai|engineer/,
    nature: /nature|weather|volcano|earthquake|forest|mountain|ocean/,
    comedy: /funny|comedy|prank|fail|blooper|laugh|meme/,
  };

  const found = [];
  for (const [topic, pattern] of Object.entries(topicPatterns)) {
    if (pattern.test(title)) {
      found.push(topic);
    }
  }

  return found.length > 0 ? found : ['general'];
}

// Update the profile after a completed conversation
function updateProfileAfterConversation(profile, videoTitle, videoChannel, conversation) {
  const now = new Date().toISOString();
  const topics = extractTopics(videoTitle);

  // Update topic breakdown
  for (const topic of topics) {
    profile.topicBreakdown[topic] = (profile.topicBreakdown[topic] || 0) + 1;
  }

  // Update interests
  for (const topic of topics) {
    const existing = profile.interests.find((i) => i.topic === topic);
    if (existing) {
      existing.strength = Math.min(10, existing.strength + 1);
      existing.lastSeen = now;
      existing.videoCount++;
    } else {
      profile.interests.push({
        topic,
        strength: 1,
        firstSeen: now,
        lastSeen: now,
        videoCount: 1,
      });
    }
  }

  // Sort interests by strength (strongest first)
  profile.interests.sort((a, b) => b.strength - a.strength);

  // Keep top 20 interests
  if (profile.interests.length > 20) {
    profile.interests = profile.interests.slice(0, 20);
  }

  // Analyze kid's responses for thinking patterns
  const kidResponses = conversation
    .filter((m) => m.role === 'user')
    .map((m) => m.content);

  const totalResponseLength = kidResponses.reduce((sum, r) => sum + r.length, 0);
  const avgLen = kidResponses.length > 0 ? totalResponseLength / kidResponses.length : 0;

  // Update running average response length
  const prevTotal = profile.avgResponseLength * profile.totalConversations;
  profile.totalConversations++;
  profile.totalVideosWatched++;
  profile.avgResponseLength = Math.round(
    (prevTotal + avgLen) / profile.totalConversations
  );

  // Store a conversation insight (keep last 50)
  const kidSummary = kidResponses.join(' ').slice(0, 200);
  profile.conversationInsights.push({
    date: now,
    videoTitle,
    videoChannel,
    topics,
    kidSaid: kidSummary,
    responseLength: avgLen,
  });

  if (profile.conversationInsights.length > 50) {
    profile.conversationInsights = profile.conversationInsights.slice(-50);
  }

  saveProfile(profile);
  return profile;
}

// Build a context summary for the agent prompt
function buildLearnerContext(profile) {
  if (profile.totalConversations === 0) {
    return `This is the first time chatting with ${profile.name}. You don't know them yet — be warm and curious about who they are.`;
  }

  const lines = [];
  lines.push(`You've been ${profile.name}'s thinking buddy for ${profile.totalConversations} conversations.`);

  // Top interests
  const topInterests = profile.interests.slice(0, 5);
  if (topInterests.length > 0) {
    const interestStr = topInterests.map((i) => i.topic).join(', ');
    lines.push(`Their biggest interests: ${interestStr}.`);
  }

  // Recent viewing
  const recent = profile.conversationInsights.slice(-5);
  if (recent.length > 0) {
    const recentTitles = recent.map((r) => `"${r.videoTitle}"`).join(', ');
    lines.push(`Recently watched: ${recentTitles}.`);
  }

  // Engagement level
  if (profile.avgResponseLength < 20) {
    lines.push('They tend to give short answers — use specific, concrete questions to draw them out.');
  } else if (profile.avgResponseLength > 80) {
    lines.push('They usually give detailed, thoughtful answers — you can ask deeper follow-ups.');
  }

  // Cross-video connections
  const topTopics = Object.entries(profile.topicBreakdown)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3);

  if (topTopics.length > 0 && topTopics[0][1] >= 3) {
    lines.push(
      `They keep coming back to ${topTopics[0][0]} content (${topTopics[0][1]} videos). ` +
      `Look for chances to connect today's video to their ongoing ${topTopics[0][0]} interest.`
    );
  }

  // Agent's own notes from previous sessions
  if (profile.agentNotes) {
    lines.push(`Your personal notes about ${profile.name}: ${profile.agentNotes}`);
  }

  return lines.join('\n');
}

// Let the agent update its own notes about the kid
function updateAgentNotes(profile, notes) {
  profile.agentNotes = notes.slice(0, 1000); // cap at 1000 chars
  saveProfile(profile);
}

module.exports = {
  createProfile,
  loadProfile,
  saveProfile,
  updateProfileAfterConversation,
  buildLearnerContext,
  updateAgentNotes,
  extractTopics,
};
