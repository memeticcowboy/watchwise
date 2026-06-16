// === WatchWise App ===

(function () {
  'use strict';

  // --- State ---
  const state = {
    currentVideo: null,
    player: null,
    playerReady: false,
    conversationHistory: [],
    conversationTurns: 0,
    requiredTurns: 2,
    gateUnlocked: false,
    watchHistory: [],
    settings: {
      questionsPerVideo: 2,
      childAge: 9,
      conversationStyle: 'socratic',
      dailyLimit: 5,
      aiModel: 'gemini',
    },
    todayVideoCount: 0,
    isSearching: false,
    isChatting: false,
    loggedIn: false,
    user: null,
  };

  // --- DOM refs ---
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => document.querySelectorAll(sel);

  const els = {
    searchInput: $('#search-input'),
    searchBtn: $('#search-btn'),
    resultsGrid: $('#results-grid'),
    welcomeMessage: $('#welcome-message'),
    searchResults: $('#search-results'),
    playerScreen: $('#player-screen'),
    playerContainer: $('#youtube-player'),
    videoTitle: $('#video-title'),
    videoChannel: $('#video-channel'),
    conversationGate: $('#conversation-gate'),
    gateVideoTitle: $('#gate-video-title'),
    chatMessages: $('#chat-messages'),
    chatInput: $('#chat-input'),
    chatSendBtn: $('#chat-send-btn'),
    historyBtn: $('#history-btn'),
    historyPanel: $('#history-panel'),
    historyClose: $('#history-close'),
    historyList: $('#history-list'),
    settingsBtn: $('#settings-btn'),
    settingsPanel: $('#settings-panel'),
    settingsClose: $('#settings-close'),
    saveSettings: $('#save-settings'),
    pinModal: $('#pin-modal'),
    pinCancel: $('#pin-cancel'),
    pinError: $('#pin-error'),
    limitModal: $('#limit-modal'),
    limitOk: $('#limit-ok'),
    statVideos: $('#stat-videos'),
    statConvos: $('#stat-convos'),
    accountBtn: $('#account-btn'),
    accountIconDefault: $('#account-icon-default'),
    accountAvatar: $('#account-avatar'),
    homeFeed: $('#home-feed'),
    subsSection: $('#subs-section'),
    subsRow: $('#subs-row'),
    recsSection: $('#recs-section'),
    recsGrid: $('#recs-grid'),
    welcomeSignin: $('#welcome-signin'),
    settingsAccountStatus: $('#settings-account-status'),
    settingsSignin: $('#settings-signin'),
    settingsSignout: $('#settings-signout'),
  };

  // --- Init ---
  function init() {
    loadSettings();
    loadWatchHistory();
    loadDailyCount();
    bindEvents();
    loadYouTubeAPI();
    checkAuthStatus();

    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('/sw.js').catch(() => {});
    }
  }

  // --- YouTube IFrame API ---
  function loadYouTubeAPI() {
    const tag = document.createElement('script');
    tag.src = 'https://www.youtube.com/iframe_api';
    document.head.appendChild(tag);
  }

  window.onYouTubeIframeAPIReady = function () {
    state.playerReady = true;
  };

  function createPlayer(videoId) {
    if (state.player) {
      state.player.destroy();
    }

    state.player = new YT.Player('youtube-player', {
      videoId: videoId,
      width: '100%',
      height: '100%',
      playerVars: {
        autoplay: 1,
        modestbranding: 1,
        rel: 0,
        playsinline: 1,
      },
      events: {
        onStateChange: onPlayerStateChange,
      },
    });
  }

  function onPlayerStateChange(event) {
    // YT.PlayerState.ENDED === 0
    if (event.data === 0) {
      onVideoEnded();
    }
  }

  function onVideoEnded() {
    // Record in watch history
    addToWatchHistory(state.currentVideo);

    // Show conversation gate
    showConversationGate();
  }

  // --- Auth ---
  async function checkAuthStatus() {
    try {
      const res = await fetch('/api/auth-status');
      const data = await res.json();

      state.loggedIn = data.loggedIn;
      state.user = data.user || null;
      updateAuthUI();

      if (state.loggedIn) {
        loadHomeFeed();
      }
    } catch {
      // Auth check failed silently — search-only mode
    }
  }

  function updateAuthUI() {
    if (state.loggedIn && state.user) {
      // Show avatar in header
      if (state.user.picture) {
        els.accountAvatar.src = state.user.picture;
        els.accountAvatar.classList.remove('hidden');
        els.accountIconDefault.classList.add('hidden');
      }

      // Hide welcome sign-in button, show home feed
      els.welcomeSignin.classList.add('hidden');
      els.welcomeMessage.classList.add('hidden');
      els.homeFeed.classList.remove('hidden');

      // Update settings panel
      els.settingsAccountStatus.textContent = `Signed in as ${state.user.name}`;
      els.settingsSignin.classList.add('hidden');
      els.settingsSignout.classList.remove('hidden');
    } else {
      // Show default icon
      els.accountIconDefault.classList.remove('hidden');
      els.accountAvatar.classList.add('hidden');

      // Show sign-in prompt
      els.welcomeSignin.classList.remove('hidden');
      els.homeFeed.classList.add('hidden');

      // Update settings panel
      els.settingsAccountStatus.textContent = 'Not signed in';
      els.settingsSignin.classList.remove('hidden');
      els.settingsSignout.classList.add('hidden');
    }
  }

  function signIn() {
    window.location.href = '/auth/google';
  }

  async function signOut() {
    try {
      await fetch('/auth/logout', { method: 'POST' });
    } catch {}
    state.loggedIn = false;
    state.user = null;
    updateAuthUI();
    els.welcomeMessage.classList.remove('hidden');
  }

  // --- Home Feed ---
  async function loadHomeFeed() {
    if (!state.loggedIn) return;

    // Load subscriptions and recommendations in parallel
    const [subsRes, recsRes] = await Promise.allSettled([
      fetch('/api/subscriptions').then((r) => r.json()),
      fetch('/api/recommendations').then((r) => r.json()),
    ]);

    // Render subscriptions
    if (subsRes.status === 'fulfilled' && subsRes.value.items && subsRes.value.items.length > 0) {
      renderSubscriptions(subsRes.value.items);
    }

    // Render recommendations
    if (recsRes.status === 'fulfilled' && recsRes.value.items && recsRes.value.items.length > 0) {
      renderRecommendations(recsRes.value.items);
    }
  }

  function renderSubscriptions(subs) {
    els.subsSection.classList.remove('hidden');
    els.subsRow.innerHTML = subs.map((sub) => `
      <div class="sub-chip" data-channel-id="${escapeAttr(sub.channelId)}" data-channel-name="${escapeAttr(sub.title)}">
        <img class="sub-avatar" src="${escapeAttr(sub.thumbnail)}" alt="" loading="lazy" referrerpolicy="no-referrer">
        <span>${escapeHtml(sub.title)}</span>
      </div>
    `).join('');

    // Click a subscription to see their latest videos
    els.subsRow.querySelectorAll('.sub-chip').forEach((chip) => {
      chip.addEventListener('click', async () => {
        const channelId = chip.dataset.channelId;
        const channelName = chip.dataset.channelName;

        // Highlight selected chip
        els.subsRow.querySelectorAll('.sub-chip').forEach((c) => c.classList.remove('active'));
        chip.classList.add('active');

        // Load channel videos into results grid
        els.resultsGrid.innerHTML = '<div class="loading"><div class="spinner"></div></div>';
        els.homeFeed.classList.add('hidden');
        els.resultsGrid.parentElement.querySelector('#welcome-message').classList.add('hidden');

        try {
          const res = await fetch(`/api/channel-videos?channelId=${encodeURIComponent(channelId)}`);
          const data = await res.json();
          if (data.items && data.items.length > 0) {
            renderSearchResults(data.items);
          } else {
            els.resultsGrid.innerHTML = `<p style="padding:20px;color:var(--text-secondary)">No recent videos from ${escapeHtml(channelName)}.</p>`;
          }
        } catch {
          els.resultsGrid.innerHTML = '<p style="padding:20px;color:var(--text-secondary)">Failed to load channel videos.</p>';
        }
      });
    });
  }

  function renderRecommendations(items) {
    els.recsSection.classList.remove('hidden');
    els.recsGrid.innerHTML = items.map((item) => `
      <div class="video-card" data-id="${escapeAttr(item.videoId)}" data-title="${escapeAttr(item.title)}" data-channel="${escapeAttr(item.channel)}" data-thumb="${escapeAttr(item.thumbnail)}">
        <img class="thumb" src="${escapeAttr(item.thumbnail)}" alt="" loading="lazy">
        <div class="info">
          <h3>${escapeHtml(item.title)}</h3>
          <p>${escapeHtml(item.channel)}</p>
        </div>
      </div>
    `).join('');

    // Bind click events on recommendation cards
    els.recsGrid.querySelectorAll('.video-card').forEach((card) => {
      card.addEventListener('click', () => {
        playVideo({
          videoId: card.dataset.id,
          title: card.dataset.title,
          channel: card.dataset.channel,
          thumbnail: card.dataset.thumb,
        });
      });
    });
  }

  // --- Search ---
  async function searchVideos(query) {
    if (!query.trim() || state.isSearching) return;

    state.isSearching = true;
    els.welcomeMessage.classList.add('hidden');
    els.homeFeed.classList.add('hidden');
    els.resultsGrid.innerHTML = '<div class="loading"><div class="spinner"></div></div>';

    try {
      const res = await fetch(`/api/search?q=${encodeURIComponent(query)}`);
      const data = await res.json();

      if (data.error) {
        els.resultsGrid.innerHTML = `<p style="padding:20px;color:var(--text-secondary)">${escapeHtml(data.error)}</p>`;
        return;
      }

      renderSearchResults(data.items || []);
    } catch (err) {
      els.resultsGrid.innerHTML = '<p style="padding:20px;color:var(--text-secondary)">Failed to search. Check your connection.</p>';
    } finally {
      state.isSearching = false;
    }
  }

  function renderSearchResults(items) {
    if (items.length === 0) {
      els.resultsGrid.innerHTML = '<p style="padding:20px;color:var(--text-secondary)">No results found. Try a different search!</p>';
      return;
    }

    els.resultsGrid.innerHTML = items.map((item) => `
      <div class="video-card" data-id="${escapeAttr(item.videoId)}" data-title="${escapeAttr(item.title)}" data-channel="${escapeAttr(item.channel)}" data-thumb="${escapeAttr(item.thumbnail)}">
        <img class="thumb" src="${escapeAttr(item.thumbnail)}" alt="" loading="lazy">
        <div class="info">
          <h3>${escapeHtml(item.title)}</h3>
          <p>${escapeHtml(item.channel)}</p>
        </div>
      </div>
    `).join('');

    // Bind click events
    els.resultsGrid.querySelectorAll('.video-card').forEach((card) => {
      card.addEventListener('click', () => {
        const videoData = {
          videoId: card.dataset.id,
          title: card.dataset.title,
          channel: card.dataset.channel,
          thumbnail: card.dataset.thumb,
        };
        playVideo(videoData);
      });
    });
  }

  // --- Play Video ---
  function playVideo(videoData) {
    // Check daily limit
    if (state.settings.dailyLimit > 0 && state.todayVideoCount >= state.settings.dailyLimit) {
      showLimitModal();
      return;
    }

    // Check if conversation gate is pending
    if (!state.gateUnlocked && state.currentVideo) {
      showConversationGate();
      return;
    }

    state.currentVideo = videoData;
    state.gateUnlocked = false;

    // Show player
    els.searchResults.classList.add('hidden');
    els.conversationGate.classList.add('hidden');
    els.playerScreen.classList.remove('hidden');
    els.videoTitle.textContent = videoData.title;
    els.videoChannel.textContent = videoData.channel;

    // Create or reload player
    if (state.playerReady) {
      createPlayer(videoData.videoId);
    }

    state.todayVideoCount++;
    saveDailyCount();
    updateStats();
  }

  // --- Conversation Gate ---
  function showConversationGate() {
    els.playerScreen.classList.add('hidden');
    els.searchResults.classList.add('hidden');
    els.conversationGate.classList.remove('hidden');
    els.conversationGate.style.display = 'flex';

    els.gateVideoTitle.textContent = state.currentVideo.title;

    // Reset conversation
    state.conversationHistory = [];
    state.conversationTurns = 0;
    state.requiredTurns = state.settings.questionsPerVideo;
    els.chatMessages.innerHTML = '';

    // Start the conversation with the agent
    startConversation();
  }

  async function startConversation() {
    addTypingIndicator();

    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          videoTitle: state.currentVideo.title,
          videoChannel: state.currentVideo.channel,
          videoId: state.currentVideo.videoId,
          history: [],
          settings: {
            age: state.settings.childAge,
            style: state.settings.conversationStyle,
            turnsRequired: state.requiredTurns,
            model: state.settings.aiModel,
          },
        }),
      });

      const data = await res.json();
      removeTypingIndicator();
      addMessage('agent', data.message);
      state.conversationHistory.push({ role: 'assistant', content: data.message });
    } catch (err) {
      removeTypingIndicator();
      addMessage('agent', "Hey! I'd love to hear about what you just watched. What was the video about?");
      state.conversationHistory.push({ role: 'assistant', content: "Hey! I'd love to hear about what you just watched. What was the video about?" });
    }
  }

  async function sendChatMessage() {
    const text = els.chatInput.value.trim();
    if (!text || state.isChatting) return;

    state.isChatting = true;
    els.chatSendBtn.disabled = true;
    els.chatInput.value = '';

    addMessage('user', text);
    state.conversationHistory.push({ role: 'user', content: text });
    state.conversationTurns++;

    // Check if we've met the required turns
    if (state.conversationTurns >= state.requiredTurns) {
      addTypingIndicator();

      try {
        // Get one final response then unlock
        const res = await fetch('/api/chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            videoTitle: state.currentVideo.title,
            videoChannel: state.currentVideo.channel,
            videoId: state.currentVideo.videoId,
            history: state.conversationHistory,
            settings: {
              age: state.settings.childAge,
              style: state.settings.conversationStyle,
              turnsRequired: state.requiredTurns,
            },
            isFinal: true,
          }),
        });

        const data = await res.json();
        removeTypingIndicator();
        addMessage('agent', data.message);
      } catch {
        removeTypingIndicator();
        addMessage('agent', "Great thinking! You really thought about that.");
      }

      // Unlock after a short pause
      setTimeout(() => {
        unlockGate();
      }, 1500);
    } else {
      // Continue the conversation
      addTypingIndicator();

      try {
        const res = await fetch('/api/chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            videoTitle: state.currentVideo.title,
            videoChannel: state.currentVideo.channel,
            videoId: state.currentVideo.videoId,
            history: state.conversationHistory,
            settings: {
              age: state.settings.childAge,
              style: state.settings.conversationStyle,
              turnsRequired: state.requiredTurns,
              currentTurn: state.conversationTurns,
              model: state.settings.aiModel,
            },
          }),
        });

        const data = await res.json();
        removeTypingIndicator();
        addMessage('agent', data.message);
        state.conversationHistory.push({ role: 'assistant', content: data.message });
      } catch {
        removeTypingIndicator();
        addMessage('agent', "Interesting! Tell me more about that.");
        state.conversationHistory.push({ role: 'assistant', content: "Interesting! Tell me more about that." });
      }
    }

    state.isChatting = false;
    els.chatSendBtn.disabled = false;
    els.chatInput.focus();
  }

  function unlockGate() {
    state.gateUnlocked = true;

    // Update watch history entry with conversation status
    updateWatchHistoryConversation(state.currentVideo.videoId, state.conversationHistory);

    addMessage('system', 'Nice job thinking about what you watched! You can search for another video now.');

    // After a pause, go back to home/search
    setTimeout(() => {
      els.conversationGate.classList.add('hidden');
      els.conversationGate.style.display = '';
      els.searchResults.classList.remove('hidden');
      els.resultsGrid.innerHTML = '';
      state.currentVideo = null;

      // Show home feed or welcome depending on auth
      if (state.loggedIn) {
        els.homeFeed.classList.remove('hidden');
      } else {
        els.welcomeMessage.classList.remove('hidden');
      }
    }, 2000);
  }

  // --- Chat UI helpers ---
  function addMessage(type, text) {
    const bubble = document.createElement('div');
    bubble.className = `chat-bubble ${type}`;
    bubble.textContent = text;
    els.chatMessages.appendChild(bubble);
    els.chatMessages.scrollTop = els.chatMessages.scrollHeight;
  }

  function addTypingIndicator() {
    const bubble = document.createElement('div');
    bubble.className = 'chat-bubble typing';
    bubble.id = 'typing-indicator';
    bubble.innerHTML = '<div class="typing-dots"><span></span><span></span><span></span></div>';
    els.chatMessages.appendChild(bubble);
    els.chatMessages.scrollTop = els.chatMessages.scrollHeight;
  }

  function removeTypingIndicator() {
    const el = $('#typing-indicator');
    if (el) el.remove();
  }

  // --- Watch History ---
  function addToWatchHistory(video) {
    const entry = {
      videoId: video.videoId,
      title: video.title,
      channel: video.channel,
      thumbnail: video.thumbnail,
      watchedAt: new Date().toISOString(),
      conversationCompleted: false,
      conversation: [],
    };

    state.watchHistory.unshift(entry);
    if (state.watchHistory.length > 100) state.watchHistory.pop();
    saveWatchHistory();
  }

  function updateWatchHistoryConversation(videoId, conversation) {
    const entry = state.watchHistory.find((e) => e.videoId === videoId);
    if (entry) {
      entry.conversationCompleted = true;
      entry.conversation = conversation;
      saveWatchHistory();
    }
  }

  function renderWatchHistory() {
    if (state.watchHistory.length === 0) {
      els.historyList.innerHTML = '<p style="padding:20px;color:var(--text-secondary);text-align:center">No videos watched yet!</p>';
      return;
    }

    els.historyList.innerHTML = state.watchHistory.map((item) => `
      <div class="history-item">
        <img class="thumb" src="${escapeAttr(item.thumbnail)}" alt="" loading="lazy">
        <div class="info">
          <h4>${escapeHtml(item.title)}</h4>
          <p>${escapeHtml(item.channel)} &middot; ${formatDate(item.watchedAt)}</p>
          <span class="badge ${item.conversationCompleted ? 'completed' : 'skipped'}">
            ${item.conversationCompleted ? 'Discussed' : 'No discussion'}
          </span>
        </div>
      </div>
    `).join('');
  }

  // --- Learner Profile (parent view) ---
  async function loadLearnerProfile() {
    const profileLoading = $('#profile-loading');
    const profileData = $('#profile-data');
    const profileEmpty = $('#profile-empty');

    profileLoading.classList.remove('hidden');
    profileData.classList.add('hidden');
    profileEmpty.classList.add('hidden');

    try {
      const res = await fetch('/api/learner-profile');
      const profile = await res.json();

      profileLoading.classList.add('hidden');

      if (profile.totalConversations === 0) {
        profileEmpty.classList.remove('hidden');
        return;
      }

      profileData.classList.remove('hidden');
      $('#profile-total-convos').textContent = profile.totalConversations;
      $('#profile-avg-response').textContent = profile.avgResponseLength;

      // Interests
      const interestsEl = $('#profile-interests');
      if (profile.interests && profile.interests.length > 0) {
        const tags = profile.interests.slice(0, 8).map((i) =>
          `<span class="interest-tag" style="opacity:${0.4 + (i.strength / 10) * 0.6}">${escapeHtml(i.topic)} (${i.videoCount})</span>`
        ).join('');
        interestsEl.innerHTML = `<p class="profile-label">Top Interests</p><div class="interest-tags">${tags}</div>`;
      } else {
        interestsEl.innerHTML = '';
      }

      // Agent notes
      const notesEl = $('#profile-agent-notes');
      if (profile.agentNotes) {
        notesEl.innerHTML = `<p class="profile-label">Agent's Notes</p><p class="profile-notes">${escapeHtml(profile.agentNotes)}</p>`;
      } else {
        notesEl.innerHTML = '';
      }

      // Recent conversations
      const recentEl = $('#profile-recent');
      const recent = (profile.conversationInsights || []).slice(-5).reverse();
      if (recent.length > 0) {
        const items = recent.map((r) =>
          `<div class="profile-recent-item">
            <strong>${escapeHtml(r.videoTitle)}</strong>
            <span class="profile-recent-topics">${r.topics.join(', ')}</span>
            <p class="profile-recent-said">"${escapeHtml(r.kidSaid.slice(0, 100))}${r.kidSaid.length > 100 ? '...' : ''}"</p>
          </div>`
        ).join('');
        recentEl.innerHTML = `<p class="profile-label">Recent Conversations</p>${items}`;
      } else {
        recentEl.innerHTML = '';
      }
    } catch {
      profileLoading.classList.add('hidden');
      profileEmpty.classList.remove('hidden');
    }
  }

  // --- Panels ---
  function showPanel(panel) {
    panel.classList.remove('hidden');
    requestAnimationFrame(() => {
      panel.classList.add('visible');
    });
  }

  function hidePanel(panel) {
    panel.classList.remove('visible');
    panel.addEventListener('transitionend', () => {
      panel.classList.add('hidden');
    }, { once: true });
  }

  // --- PIN ---
  let pinValue = '';
  let pinCallback = null;

  function showPinModal(callback) {
    pinValue = '';
    pinCallback = callback;
    updatePinDots();
    els.pinError.classList.add('hidden');
    els.pinModal.classList.remove('hidden');
  }

  function hidePinModal() {
    els.pinModal.classList.add('hidden');
  }

  function onPinKey(key) {
    if (key === 'del') {
      pinValue = pinValue.slice(0, -1);
    } else if (pinValue.length < 4) {
      pinValue += key;
    }

    updatePinDots();

    if (pinValue.length === 4) {
      verifyPin(pinValue);
    }
  }

  function updatePinDots() {
    $$('.pin-dot').forEach((dot, i) => {
      dot.classList.toggle('filled', i < pinValue.length);
    });
  }

  async function verifyPin(pin) {
    try {
      const res = await fetch('/api/verify-pin', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pin }),
      });
      const data = await res.json();

      if (data.valid) {
        hidePinModal();
        if (pinCallback) pinCallback();
      } else {
        els.pinError.classList.remove('hidden');
        pinValue = '';
        updatePinDots();
      }
    } catch {
      els.pinError.classList.remove('hidden');
      pinValue = '';
      updatePinDots();
    }
  }

  // --- Settings ---
  function loadSettings() {
    try {
      const saved = localStorage.getItem('watchwise_settings');
      if (saved) {
        Object.assign(state.settings, JSON.parse(saved));
      }
    } catch {}

    applySettingsToUI();
  }

  function applySettingsToUI() {
    $('#setting-questions').value = state.settings.questionsPerVideo;
    $('#setting-age').value = state.settings.childAge;
    $('#setting-style').value = state.settings.conversationStyle;
    $('#setting-limit').value = state.settings.dailyLimit;
    $('#setting-model').value = state.settings.aiModel;
  }

  function saveSettings() {
    state.settings.questionsPerVideo = parseInt($('#setting-questions').value);
    state.settings.childAge = parseInt($('#setting-age').value);
    state.settings.conversationStyle = $('#setting-style').value;
    state.settings.dailyLimit = parseInt($('#setting-limit').value);
    state.settings.aiModel = $('#setting-model').value;

    localStorage.setItem('watchwise_settings', JSON.stringify(state.settings));
    hidePanel(els.settingsPanel);
  }

  function updateStats() {
    els.statVideos.textContent = state.todayVideoCount;
    els.statConvos.textContent = state.watchHistory.filter(
      (e) => e.conversationCompleted && isToday(e.watchedAt)
    ).length;
  }

  // --- Daily Count ---
  function loadDailyCount() {
    try {
      const saved = JSON.parse(localStorage.getItem('watchwise_daily') || '{}');
      const today = new Date().toISOString().split('T')[0];
      state.todayVideoCount = saved.date === today ? saved.count : 0;
    } catch {
      state.todayVideoCount = 0;
    }
    updateStats();
  }

  function saveDailyCount() {
    const today = new Date().toISOString().split('T')[0];
    localStorage.setItem('watchwise_daily', JSON.stringify({
      date: today,
      count: state.todayVideoCount,
    }));
  }

  // --- Watch History Persistence ---
  function loadWatchHistory() {
    try {
      state.watchHistory = JSON.parse(localStorage.getItem('watchwise_history') || '[]');
    } catch {
      state.watchHistory = [];
    }
  }

  function saveWatchHistory() {
    localStorage.setItem('watchwise_history', JSON.stringify(state.watchHistory));
  }

  // --- Limit Modal ---
  function showLimitModal() {
    els.limitModal.classList.remove('hidden');
  }

  // --- Events ---
  function bindEvents() {
    // Search
    els.searchBtn.addEventListener('click', () => searchVideos(els.searchInput.value));
    els.searchInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') searchVideos(els.searchInput.value);
    });

    // Chat
    els.chatSendBtn.addEventListener('click', sendChatMessage);
    els.chatInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') sendChatMessage();
    });

    // History panel
    els.historyBtn.addEventListener('click', () => {
      renderWatchHistory();
      showPanel(els.historyPanel);
    });
    els.historyClose.addEventListener('click', () => hidePanel(els.historyPanel));

    // Settings panel (PIN protected)
    els.settingsBtn.addEventListener('click', () => {
      showPinModal(() => {
        updateStats();
        applySettingsToUI();
        loadLearnerProfile();
        showPanel(els.settingsPanel);
      });
    });
    els.settingsClose.addEventListener('click', () => hidePanel(els.settingsPanel));
    els.saveSettings.addEventListener('click', saveSettings);

    // PIN pad
    $$('.pin-key').forEach((key) => {
      key.addEventListener('click', () => {
        const val = key.dataset.key;
        if (val) onPinKey(val);
      });
    });
    els.pinCancel.addEventListener('click', hidePinModal);

    // Limit modal
    els.limitOk.addEventListener('click', () => els.limitModal.classList.add('hidden'));

    // Auth
   els.accountBtn.addEventListener('click', () => {
      if (!state.loggedIn) {
        signIn();
      } else if (confirm('Sign out of YouTube?')) {
        signOut();
      }
    });
    els.welcomeSignin.addEventListener('click', signIn);
    els.settingsSignin.addEventListener('click', signIn);
    els.settingsSignout.addEventListener('click', signOut);
  }

  // --- Helpers ---
  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  function escapeAttr(str) {
    return str.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/'/g, '&#39;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function formatDate(iso) {
    const d = new Date(iso);
    const now = new Date();
    if (d.toDateString() === now.toDateString()) return 'Today';
    const yesterday = new Date(now);
    yesterday.setDate(yesterday.getDate() - 1);
    if (d.toDateString() === yesterday.toDateString()) return 'Yesterday';
    return d.toLocaleDateString();
  }

  function isToday(iso) {
    return new Date(iso).toDateString() === new Date().toDateString();
  }

  // --- Go ---
  init();
})();
