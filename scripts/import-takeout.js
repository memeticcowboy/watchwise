// One-time importer for a Google Takeout YouTube export.
//
// Reads (from data/import/extracted/Takeout/YouTube and YouTube Music/):
//   - history/watch-history.html   (bare video IDs + timestamps)
//   - subscriptions/subscriptions.csv
// Enriches video IDs via the YouTube Data API, then writes (all under data/, git-ignored):
//   - data/import/history-enriched.json    cache of videoId -> { title, channelId, channelTitle, durationSec }
//   - data/import/subscriptions.json       [{ channelId, title, thumbnail }] for the app's "Your Channels"
//   - data/import/watch-history-report.html standalone, self-contained review report
//   - data/profiles/<id>.json              seeded learner profile (interests/topics/agent notes)
//
// No personal data is committed — this script is generic code; everything it reads/writes stays in data/.
// Usage: node scripts/import-takeout.js [profileId]

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const learner = require('../server/learner-profile');

const ROOT = path.join(__dirname, '..');
const IMPORT_DIR = path.join(ROOT, 'data', 'import');
const EXTRACT = path.join(IMPORT_DIR, 'extracted', 'Takeout', 'YouTube and YouTube Music');
const HISTORY_HTML = path.join(EXTRACT, 'history', 'watch-history.html');
const SUBS_CSV = path.join(EXTRACT, 'subscriptions', 'subscriptions.csv');
const ENRICHED_JSON = path.join(IMPORT_DIR, 'history-enriched.json');
const SUBS_JSON = path.join(IMPORT_DIR, 'subscriptions.json');
const REPORT_HTML = path.join(IMPORT_DIR, 'watch-history-report.html');

const API_KEY = process.env.YOUTUBE_API_KEY;
const PROFILE_ID = process.argv[2] || process.env.LEARNER_PROFILE_ID || 'default';

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function isoToSeconds(d) {
  const m = (d || '').match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
  if (!m) return 0;
  return parseInt(m[1] || 0, 10) * 3600 + parseInt(m[2] || 0, 10) * 60 + parseInt(m[3] || 0, 10);
}

function parseHistory() {
  const raw = fs.readFileSync(HISTORY_HTML, 'utf8');
  const re = /watch\?v=([A-Za-z0-9_-]{11})[^<]*<br>([^<]*)<br>/g;
  const views = [];
  let m;
  while ((m = re.exec(raw)) !== null) {
    const dm = m[2].match(/([A-Z][a-z]{2} \d{1,2}, \d{4})/);
    views.push({ id: m[1], date: dm ? dm[1] : null });
  }
  return views;
}

function parseSubs() {
  const raw = fs.readFileSync(SUBS_CSV, 'utf8').replace(/^﻿/, '').trim();
  return raw.split(/\r?\n/).slice(1).map((line) => {
    const c1 = line.indexOf(',');
    const c2 = line.indexOf(',', c1 + 1);
    return { channelId: line.slice(0, c1).trim(), title: line.slice(c2 + 1).trim() };
  }).filter((s) => s.channelId);
}

async function ytBatch(endpoint, ids, part) {
  const out = {};
  for (let i = 0; i < ids.length; i += 50) {
    const batch = ids.slice(i, i + 50);
    const url = new URL(`https://www.googleapis.com/youtube/v3/${endpoint}`);
    url.searchParams.set('part', part);
    url.searchParams.set('id', batch.join(','));
    url.searchParams.set('maxResults', '50');
    url.searchParams.set('key', API_KEY);
    try {
      const res = await fetch(url.toString());
      const data = await res.json();
      if (data.error) {
        console.error(`  ${endpoint} API error:`, data.error.message);
        if (/quota/i.test(data.error.message)) { console.error('  Quota exceeded — stopping early.'); break; }
        continue;
      }
      for (const it of data.items || []) out[it.id] = it;
    } catch (e) {
      console.error(`  ${endpoint} fetch failed at ${i}:`, e.message);
    }
    if (i > 0 && i % 1000 === 0) console.log(`  ...${endpoint}: ${i}/${ids.length}`);
  }
  return out;
}

(async () => {
  if (!API_KEY) { console.error('Missing YOUTUBE_API_KEY in .env'); process.exit(1); }

  console.log('Parsing watch history...');
  const views = parseHistory();
  const uniqueIds = [...new Set(views.map((v) => v.id))];
  console.log(`  ${views.length} views, ${uniqueIds.length} unique videos`);

  console.log('Parsing subscriptions...');
  const subs = parseSubs();
  console.log(`  ${subs.length} subscriptions`);

  // Enrich videos (cached so report/profile tweaks don't re-spend quota)
  let vmap;
  if (fs.existsSync(ENRICHED_JSON)) {
    console.log('Loading cached video enrichment...');
    vmap = JSON.parse(fs.readFileSync(ENRICHED_JSON, 'utf8'));
  } else {
    console.log(`Enriching ${uniqueIds.length} videos via YouTube API (~${Math.ceil(uniqueIds.length / 50)} calls)...`);
    const raw = await ytBatch('videos', uniqueIds, 'snippet,contentDetails');
    vmap = {};
    for (const id of Object.keys(raw)) {
      const it = raw[id];
      vmap[id] = {
        title: it.snippet.title,
        channelId: it.snippet.channelId,
        channelTitle: it.snippet.channelTitle,
        durationSec: isoToSeconds(it.contentDetails && it.contentDetails.duration),
      };
    }
    fs.writeFileSync(ENRICHED_JSON, JSON.stringify(vmap));
    console.log(`  enriched ${Object.keys(vmap).length}/${uniqueIds.length} -> ${path.relative(ROOT, ENRICHED_JSON)}`);
  }

  // Subscription thumbnails -> subscriptions.json
  console.log('Fetching subscription channel thumbnails...');
  const chMap = await ytBatch('channels', subs.map((s) => s.channelId), 'snippet');
  const subsOut = subs.map((s) => {
    const it = chMap[s.channelId];
    const th = it && it.snippet.thumbnails && (it.snippet.thumbnails.default || it.snippet.thumbnails.medium);
    return { channelId: s.channelId, title: s.title, thumbnail: (th && th.url) || '' };
  });
  fs.writeFileSync(SUBS_JSON, JSON.stringify(subsOut, null, 2));
  console.log(`  wrote ${subsOut.length} subscriptions -> ${path.relative(ROOT, SUBS_JSON)}`);

  // Aggregate channels + topics from the views
  const channelAgg = {};
  const topicCounts = {};
  let shortViews = 0, knownViews = 0, unknownViews = 0;
  for (const v of views) {
    const meta = vmap[v.id];
    if (!meta) { unknownViews++; continue; }
    knownViews++;
    if (meta.durationSec && meta.durationSec <= 60) shortViews++;
    const c = channelAgg[meta.channelId] || (channelAgg[meta.channelId] = { title: meta.channelTitle, views: 0, uniques: new Set(), lastDate: v.date });
    c.views++;
    c.uniques.add(v.id);
  }
  for (const id of uniqueIds) {
    const meta = vmap[id];
    if (!meta) continue;
    for (const t of learner.extractTopics(meta.title)) topicCounts[t] = (topicCounts[t] || 0) + 1;
  }
  const channels = Object.entries(channelAgg)
    .map(([channelId, c]) => ({ channelId, title: c.title, views: c.views, unique: c.uniques.size, lastDate: c.lastDate }))
    .sort((a, b) => b.views - a.views);
  const topics = Object.entries(topicCounts).filter(([t]) => t !== 'general').sort((a, b) => b[1] - a[1]);

  const dates = views.map((v) => v.date).filter(Boolean);
  const newest = dates[0] || '';
  const oldest = dates[dates.length - 1] || '';
  const shortPct = knownViews ? Math.round((shortViews / knownViews) * 100) : 0;

  // Standalone report
  const rows = channels.map((c, i) =>
    `<tr><td class="num">${i + 1}</td><td><a href="https://www.youtube.com/channel/${esc(c.channelId)}" target="_blank" rel="noreferrer">${esc(c.title || '(unknown)')}</a></td><td class="num">${c.views}</td><td class="num">${c.unique}</td><td>${esc(c.lastDate || '')}</td></tr>`
  ).join('');
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<title>WatchWise — Imported Watch History</title>
<style>
body{font-family:system-ui,-apple-system,Arial,sans-serif;margin:24px;color:#111;background:#fff}
h1{margin:0 0 2px} .sub{color:#666;margin:0 0 18px;font-size:13px}
.cards{display:flex;gap:12px;flex-wrap:wrap;margin-bottom:22px}
.card{border:1px solid #e2e2e2;border-radius:10px;padding:12px 18px;min-width:120px}
.card .n{font-size:26px;font-weight:700} .card .l{color:#666;font-size:12px;margin-top:2px}
.tags span{display:inline-block;background:#eef0ff;color:#334;border-radius:12px;padding:3px 11px;margin:3px;font-size:12px}
table{border-collapse:collapse;width:100%;font-size:14px;margin-top:8px}
th,td{border-bottom:1px solid #eee;padding:6px 10px;text-align:left}
th{background:#f7f7f7;position:sticky;top:0} td.num,th.num{text-align:right;color:#444}
a{color:#3b5bdb;text-decoration:none} a:hover{text-decoration:underline}
.note{color:#999;font-size:12px;margin-top:22px}
</style></head><body>
<h1>Imported Watch History</h1>
<p class="sub">Generated locally from Google Takeout &middot; ${esc(oldest)} &rarr; ${esc(newest)} &middot; not uploaded anywhere (lives in git-ignored data/).</p>
<div class="cards">
<div class="card"><div class="n">${views.length.toLocaleString()}</div><div class="l">total views</div></div>
<div class="card"><div class="n">${uniqueIds.length.toLocaleString()}</div><div class="l">unique videos</div></div>
<div class="card"><div class="n">${channels.length.toLocaleString()}</div><div class="l">channels</div></div>
<div class="card"><div class="n">${shortPct}%</div><div class="l">&le; 1 min (Shorts)</div></div>
</div>
<h3>Top topics</h3>
<div class="tags">${topics.slice(0, 14).map(([t, n]) => `<span>${esc(t)} (${n})</span>`).join('') || '<em>none detected</em>'}</div>
<h3 style="margin-top:22px">Channels by views (${channels.length})</h3>
<table><thead><tr><th class="num">#</th><th>Channel</th><th class="num">views</th><th class="num">unique</th><th>last watched</th></tr></thead>
<tbody>${rows}</tbody></table>
${unknownViews ? `<p class="note">${unknownViews.toLocaleString()} views were of videos that are deleted/private/unavailable and couldn't be enriched.</p>` : ''}
<p class="note">WatchWise import tool &middot; source: Google Takeout watch-history.html</p>
</body></html>`;
  fs.writeFileSync(REPORT_HTML, html);
  console.log(`  wrote report -> ${path.relative(ROOT, REPORT_HTML)}`);

  // Seed learner profile
  const profile = learner.loadProfile(PROFILE_ID);
  const topCount = topics.length ? topics[0][1] : 1;
  const nowIso = new Date().toISOString();
  profile.interests = topics.slice(0, 20).map(([topic, count]) => ({
    topic,
    strength: Math.max(1, Math.round((count / topCount) * 10)),
    firstSeen: nowIso,
    lastSeen: nowIso,
    videoCount: count,
  }));
  profile.topicBreakdown = Object.fromEntries(topics);
  profile.totalVideosWatched = views.length;
  const topChannels = channels.slice(0, 8).map((c) => c.title).filter(Boolean).join(', ');
  const topTopicNames = topics.slice(0, 5).map(([t]) => t).join(', ') || 'a wide range of topics';
  profile.agentNotes = `Imported from YouTube watch history (${oldest}–${newest}, ${views.length} views, ${shortPct}% short-form). Frequent topics: ${topTopicNames}. Most-watched channels: ${topChannels}.`;
  profile.imported = { source: 'google-takeout', importedAt: nowIso, views: views.length, uniqueVideos: uniqueIds.length, channels: channels.length };
  learner.saveProfile(profile);
  console.log(`  seeded learner profile "${PROFILE_ID}" -> ${path.relative(ROOT, path.join('data', 'profiles', PROFILE_ID + '.json'))}`);

  // Summary
  console.log('\n=== SUMMARY ===');
  console.log(`views=${views.length} unique=${uniqueIds.length} enriched=${Object.keys(vmap).length} unavailable=${unknownViews}`);
  console.log(`channels=${channels.length} shorts=${shortPct}% range=${oldest}..${newest}`);
  console.log(`top channels: ${channels.slice(0, 5).map((c) => `${c.title}(${c.views})`).join(', ')}`);
  console.log(`top topics: ${topics.slice(0, 6).map(([t, n]) => `${t}(${n})`).join(', ')}`);
  console.log('DONE');
})();
