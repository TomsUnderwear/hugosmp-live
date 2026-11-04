// HugoSMP Live – lokaler Server für die Twitch-/TikTok-Übersicht.
// Keine Abhängigkeiten: braucht nur Node 20+.  Start:  node server.js
import http from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(ROOT, 'public');
const DATA = path.join(ROOT, 'data');
const STORE_FILE = path.join(DATA, 'state.json');
const CACHE_FILE = path.join(DATA, 'cache.json'); // nur --once: Prüfstände zwischen zwei Läufen
// --once: einmal alles abfragen, public/data/streams.json schreiben, beenden (für GitHub Actions)
const ONCE = process.argv[2] === '--once';

loadEnv(path.join(ROOT, '.env'));
const config = loadConfig();

const TWITCH_ID = (process.env.TWITCH_CLIENT_ID || '').trim();
const TWITCH_SECRET = (process.env.TWITCH_CLIENT_SECRET || '').trim();
const PORT = Number(process.env.PORT || config.port || 3000);
const HOST = process.env.HOST || '127.0.0.1';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

function loadEnv(file) {
  if (!existsSync(file)) return;
  for (const raw of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = line.match(/^([A-Za-z0-9_]+)\s*=\s*(.*)$/);
    if (!m) continue;
    const value = m[2].replace(/^(['"])(.*)\1$/, '$2');
    if (!(m[1] in process.env)) process.env[m[1]] = value;
  }
}

function loadConfig() {
  const defaults = {
    port: 3000,
    tags: ['Auction', 'Hugosmp'],
    matchHashtags: true,
    matchPlainText: false,
    vod: {
      anywhere: ['rerun', 'wiederholung', 'reupload', 'nicht live', 'kein live', 'not live', 'vod läuft'],
      marked: ['vod', 'replay', 'aufzeichnung', 'restream'],
    },
    twitch: { languages: ['de'], gameIds: [], maxPages: 150, refreshSeconds: 60, excludeEmoteOnly: true },
    tiktok: {
      refreshSeconds: 120,
      autoAddTwitchStreamers: true,
      concurrency: 3,
      minecraftFeed: true,
      feedRefreshSeconds: 180,
      detectInImage: true,
      recheckMinutes: 10,
      detectTag: 'Hugosmp',
    },
  };
  let user = {};
  try {
    user = JSON.parse(readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
  } catch (e) {
    if (e.code !== 'ENOENT') console.warn('config.json konnte nicht gelesen werden:', e.message);
  }
  return {
    ...defaults,
    ...user,
    vod: { ...defaults.vod, ...user.vod },
    twitch: { ...defaults.twitch, ...user.twitch },
    tiktok: { ...defaults.tiktok, ...user.tiktok },
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const norm = (s) => String(s ?? '').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
const NB = '(?<![\\p{L}\\p{N}])'; // keine Buchstaben/Zahlen davor
const NA = '(?![\\p{L}\\p{N}])'; //  keine Buchstaben/Zahlen danach
const SEP = '[|,/&+:•·–\\-]'; //       Trenner innerhalb einer Klammer

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}

// "Hugo SMP", "hugo-smp" und "HugoSMP" sollen gleich behandelt werden.
const loose = (word) => [...norm(word)].map(escapeRe).join('[\\s_.\\-]*');
const words = (list) => list.map((w) => w.trim().split(/[\s-]+/).map(escapeRe).join('[\\s\\-]*')).join('|');

// ---------------------------------------------------------------------------
// Tag- und VOD-Erkennung
// ---------------------------------------------------------------------------

const matchers = config.tags.map((tag) => {
  const l = loose(tag);
  return {
    tag,
    key: norm(tag),
    // [Hugosmp], [HugoSMP | Tag 5], [Auction & Hugosmp] – aber nicht [auction house]
    bracket: new RegExp(`\\[(?:[^\\]]*${SEP})?\\s*${l}\\s*(?:${SEP}[^\\]]*)?\\]`, 'iu'),
    hashtag: new RegExp(`#${l}${NA}`, 'iu'),
    plain: new RegExp(`${NB}${l}${NA}`, 'iu'),
  };
});

function matchTags(title = '', tags = []) {
  const tagKeys = new Set((tags || []).map(norm));
  const t = title || '';
  return matchers
    .filter(
      (m) =>
        m.bracket.test(t) ||
        tagKeys.has(m.key) ||
        (config.matchHashtags && m.hashtag.test(t)) ||
        (config.matchPlainText && m.plain.test(t)),
    )
    .map((m) => m.tag);
}

const vodAnywhere = config.vod.anywhere.length ? new RegExp(`${NB}(?:${words(config.vod.anywhere)})${NA}`, 'iu') : null;
const vodMarked = config.vod.marked.length
  ? new RegExp(`(?:[\\[(]\\s*(?:${words(config.vod.marked)})\\s*[\\])]|^[^\\p{L}\\p{N}]*(?:${words(config.vod.marked)})${NA})`, 'iu')
  : null;
const vodTagKeys = new Set([...config.vod.anywhere, ...config.vod.marked].map(norm));

function isVod(title = '', tags = []) {
  const t = title || '';
  return Boolean(vodAnywhere?.test(t) || vodMarked?.test(t) || (tags || []).some((x) => vodTagKeys.has(norm(x))));
}

// ---------------------------------------------------------------------------
// HugoSMP im Bild erkennen (TikTok): Scoreboard zeigt "HUGOSMP.NET", "4515/9500"
// und Zeilen wie Geld / Gems / Stars / Kills / Tode / Clan / Keyall / Spielzeit.
// ---------------------------------------------------------------------------

const MINECRAFT_TAG_ID = 105; // TikTok game_tag_id für Minecraft
const HUGO_TEXT = /hugo\s*[-_.]?\s*smp/i;
const SCOREBOARD_LABELS = ['geld', 'gems', 'stars', 'kills', 'tode', 'clan', 'keyall', 'spielzeit'];
const SPECIFIC_LABELS = new Set(['gems', 'stars', 'keyall']);
const execFileP = promisify(execFile);

function levenshtein(a, b) {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[b.length];
}

/** Bewertet OCR-Text: true, wenn er nach HugoSMP-Scoreboard aussieht (OCR-Fehler werden toleriert). */
function ocrLooksLikeHugoSmp(text) {
  const tokens = text.toLowerCase().replace(/[^a-z0-9./ ]+/g, ' ').split(/\s+/).filter(Boolean);
  if (tokens.some((t) => t.length >= 6 && levenshtein(t.replace(/\.net$/, ''), 'hugosmp') <= 2)) return true;
  if (/hug[o0][s5]m/.test(tokens.join(''))) return true;
  if (/\b\d{3,4}\s*\/\s*95[o0]{2}\b/.test(text)) return true; // Spieler/Max-Slots von hugosmp.net
  const labels = SCOREBOARD_LABELS.filter((l) => tokens.some((t) => levenshtein(t, l) <= (l.length > 5 ? 1 : 0)));
  return labels.length >= 4 || (labels.length >= 3 && labels.some((l) => SPECIFIC_LABELS.has(l)));
}

let vision = null; // { worker, Jimp, ffmpegPath } – nur wenn die Pakete installiert sind

async function loadVision() {
  if (!config.tiktok.detectInImage) return;
  try {
    const [{ createWorker }, jimpMod, ffmpegMod] = await Promise.all([import('tesseract.js'), import('jimp'), import('ffmpeg-static')]);
    const cachePath = path.join(DATA, 'ocr');
    await mkdir(cachePath, { recursive: true });
    const worker = await createWorker('eng', 1, { cachePath, logger: () => {}, errorHandler: () => {} });
    vision = { worker, Jimp: jimpMod.default || jimpMod, ffmpegPath: ffmpegMod.default || ffmpegMod };
    console.log('  Bilderkennung: aktiv (HugoSMP-Scoreboard per OCR)');
  } catch (e) {
    console.warn('  Bilderkennung: aus –', e.message.split('\n')[0], '(npm install ausführen)');
  }
}

/** Ein Standbild aus einem laufenden Stream holen (FLV-URL), als JPEG-Buffer. */
async function grabFrame(urls) {
  for (const url of urls.filter(Boolean).slice(0, 2)) {
    try {
      const { stdout } = await execFileP(
        vision.ffmpegPath,
        ['-hide_banner', '-loglevel', 'error', '-rw_timeout', '10000000', '-i', url, '-frames:v', '1', '-f', 'image2pipe', '-vcodec', 'mjpeg', '-q:v', '3', 'pipe:1'],
        { encoding: 'buffer', timeout: 25_000, maxBuffer: 20_000_000, windowsHide: true },
      );
      if (stdout?.length) return stdout;
    } catch {}
  }
  return null;
}

async function fetchImage(url) {
  try {
    const r = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(15_000) });
    return r.ok ? Buffer.from(await r.arrayBuffer()) : null;
  } catch {
    return null;
  }
}

/** OCR auf dem rechten Bildrand (Scoreboard); im Hochformat zusätzlich aufs ganze Bild. */
async function frameShowsHugoSmp(buf) {
  if (!vision || !buf) return false;
  const { Jimp, worker } = vision;
  const img = await Jimp.read(buf);
  const { width: w, height: h } = img.bitmap;
  const portrait = w < h;
  const passes = [() => img.clone().crop(Math.round(w * 0.6), 0, Math.round(w * 0.4), h).greyscale().scale(portrait ? 2.5 : 2)];
  if (portrait) passes.push(() => img.clone().greyscale().scale(1.5));
  for (const make of passes) {
    const { data } = await worker.recognize(await make().getBufferAsync(Jimp.MIME_PNG));
    if (ocrLooksLikeHugoSmp(data.text)) return true;
  }
  return false;
}

/**
 * Prüft einen Minecraft-Live auf HugoSMP: erst Text (Titel, Bio, Name), dann Bild.
 * Liefert 'text', 'bild' oder null.
 */
async function detectHugoSmp({ texts, imageUrl, flvUrls }) {
  if (texts.some((t) => t && HUGO_TEXT.test(t))) return 'text';
  if (!vision) return null;
  const buf = (imageUrl && (await fetchImage(imageUrl))) || (flvUrls?.length ? await grabFrame(flvUrls) : null);
  try {
    return (await frameShowsHugoSmp(buf)) ? 'bild' : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Persistenter Zustand (TikTok-Accounts)
// ---------------------------------------------------------------------------

let store = { tiktokAccounts: [], ignored: [] };

async function loadStore() {
  try {
    const saved = JSON.parse(await readFile(STORE_FILE, 'utf8'));
    store = { tiktokAccounts: saved.tiktokAccounts || [], ignored: saved.ignored || [] };
  } catch (e) {
    if (e.code !== 'ENOENT') console.warn('data/state.json konnte nicht gelesen werden:', e.message);
  }
}

let saving = Promise.resolve();
function saveStore() {
  saving = saving
    .then(async () => {
      await mkdir(DATA, { recursive: true });
      const tmp = STORE_FILE + '.tmp';
      await writeFile(tmp, JSON.stringify(store, null, 2));
      await rename(tmp, STORE_FILE);
    })
    .catch((e) => console.error('Speichern fehlgeschlagen:', e.message));
  return saving;
}

const TIKTOK_NAME = /^[a-z0-9._]{2,24}$/;
const cleanName = (s) => String(s ?? '').trim().replace(/^@/, '').toLowerCase();

function discover(logins, source = 'twitch') {
  let added = 0;
  for (const login of logins) {
    const name = cleanName(login);
    if (!TIKTOK_NAME.test(name) || store.ignored.includes(name)) continue;
    if (store.tiktokAccounts.some((a) => a.name === name)) continue;
    store.tiktokAccounts.push({ name, source, addedAt: Date.now() });
    added++;
  }
  if (added) {
    saveStore();
    if (source === 'twitch' && !ONCE) tiktokLoop.run();
  }
}

// ---------------------------------------------------------------------------
// Live-Zustand
// ---------------------------------------------------------------------------

const state = {
  twitch: {
    configured: Boolean(TWITCH_ID && TWITCH_SECRET),
    scanning: false,
    updatedAt: null,
    nextAt: null,
    scanned: 0,
    durationMs: 0,
    streams: [],
    excluded: [],
    error: null,
  },
  tiktok: {
    scanning: false,
    updatedAt: null,
    nextAt: null,
    checked: 0,
    feedRooms: 0, // Minecraft-Lives aus TikToks Feed, die zuletzt durchsucht wurden
    vision: false,
    streams: [],
    excluded: [],
    error: null,
  },
};

// ---------------------------------------------------------------------------
// Twitch (offizielle Helix-API)
// ---------------------------------------------------------------------------

let token = null;
let tokenExpires = 0;

async function twitchToken(force = false) {
  if (!force && token && Date.now() < tokenExpires - 60_000) return token;
  const r = await fetch('https://id.twitch.tv/oauth2/token', {
    method: 'POST',
    body: new URLSearchParams({ client_id: TWITCH_ID, client_secret: TWITCH_SECRET, grant_type: 'client_credentials' }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!r.ok) throw new Error(`Twitch-Anmeldung fehlgeschlagen (${r.status}). Client-ID und Secret in .env prüfen.`);
  const j = await r.json();
  token = j.access_token;
  tokenExpires = Date.now() + j.expires_in * 1000;
  return token;
}

async function helix(query, retried = false) {
  const r = await fetch('https://api.twitch.tv/helix/' + query, {
    headers: { 'Client-Id': TWITCH_ID, Authorization: 'Bearer ' + (await twitchToken()) },
    signal: AbortSignal.timeout(15_000),
  });
  if (r.status === 401 && !retried) {
    await twitchToken(true);
    return helix(query, true);
  }
  if (r.status === 429) {
    const reset = Number(r.headers.get('ratelimit-reset')) * 1000;
    await sleep(Math.min(60_000, Math.max(1000, reset - Date.now())));
    return helix(query, retried);
  }
  if (!r.ok) throw new Error(`Twitch-API ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return r.json();
}

async function fetchUsers(ids) {
  const users = new Map();
  for (let i = 0; i < ids.length; i += 100) {
    const p = new URLSearchParams();
    for (const id of ids.slice(i, i + 100)) p.append('id', id);
    const j = await helix('users?' + p);
    for (const u of j.data) users.set(u.id, u);
  }
  return users;
}

async function scanTwitch() {
  if (!state.twitch.configured) return;
  const t0 = Date.now();
  const games = config.twitch.gameIds?.length ? config.twitch.gameIds : [null];
  const seen = new Map();

  for (const game of games) {
    let cursor = null;
    for (let page = 0; page < config.twitch.maxPages; page++) {
      const p = new URLSearchParams({ first: '100', type: 'live' });
      for (const lang of config.twitch.languages || []) if (lang) p.append('language', lang);
      if (game) p.set('game_id', String(game));
      if (cursor) p.set('after', cursor);
      const j = await helix('streams?' + p);
      for (const s of j.data) seen.set(s.id, s);
      cursor = j.pagination?.cursor;
      if (!cursor || !j.data.length) break;
    }
  }

  const hits = [];
  for (const s of seen.values()) {
    const matched = matchTags(s.title, s.tags);
    if (matched.length) hits.push({ s, matched });
  }

  const users = hits.length ? await fetchUsers(hits.map((h) => h.s.user_id)) : new Map();
  const chats = config.twitch.excludeEmoteOnly
    ? await mapLimit(hits, 6, async ({ s }) => {
        try {
          return (await helix('chat/settings?broadcaster_id=' + s.user_id)).data?.[0] ?? null;
        } catch {
          return null;
        }
      })
    : [];

  const stamp = Math.floor(Date.now() / 1000);
  const streams = [];
  const excluded = [];
  hits.forEach(({ s, matched }, i) => {
    const item = {
      key: 'tw:' + s.user_id,
      platform: 'twitch',
      login: s.user_login,
      name: s.user_name || s.user_login,
      title: s.title,
      viewers: s.viewer_count,
      startedAt: Date.parse(s.started_at) || null,
      game: s.game_name || '',
      tags: s.tags || [],
      matched,
      url: 'https://www.twitch.tv/' + s.user_login,
      thumbnail: s.thumbnail_url.replace('{width}', '640').replace('{height}', '360') + '?t=' + stamp,
      avatar: users.get(s.user_id)?.profile_image_url || null,
    };
    const reasons = [];
    if (chats[i]?.emote_mode) reasons.push('emote');
    if (isVod(s.title, s.tags)) reasons.push('vod');
    (reasons.length ? excluded : streams).push(reasons.length ? { ...item, reasons } : item);
  });

  streams.sort((a, b) => b.viewers - a.viewers);
  Object.assign(state.twitch, {
    streams,
    excluded,
    scanned: seen.size,
    updatedAt: Date.now(),
    durationMs: Date.now() - t0,
    error: null,
  });
  console.log(`[twitch] ${seen.size} Streams durchsucht, ${streams.length} Treffer, ${excluded.length} ausgeblendet (${Date.now() - t0} ms)`);

  if (config.tiktok.autoAddTwitchStreamers) discover(hits.map((h) => h.s.user_login));
}

// ---------------------------------------------------------------------------
// TikTok – zwei Quellen, weil es keine öffentliche Live-Suche gibt:
//  1. Accountliste (Twitch-Treffer, manuell, früher erkannte) – direkt geprüft
//  2. TikToks Minecraft-Live-Feed (Region DE) – jeder Live wird auf HugoSMP geprüft
// ---------------------------------------------------------------------------

const tiktokStatus = new Map(); // name -> letzter Prüfstand der Accountliste
const feedRooms = new Map(); //    roomId -> Minecraft-Live aus dem Feed
const hugoRooms = new Map(); //    roomId -> { via, at } – einmal erkannt, bleibt der Live erkannt
const recheckMs = () => config.tiktok.recheckMinutes * 60_000;

const TT_HEADERS = {
  'User-Agent': UA,
  Accept: 'application/json, text/plain, */*',
  'Accept-Language': 'de-DE,de;q=0.9,en;q=0.8',
  Referer: 'https://www.tiktok.com/',
};

function flvFromStreamData(raw) {
  try {
    const d = JSON.parse(raw || '{}').data || {};
    return ['hd', 'origin', 'sd', 'uhd', 'ld'].map((q) => d[q]?.main?.flv).filter(Boolean);
  } catch {
    return [];
  }
}

async function fetchTikTok(name) {
  const url = `https://www.tiktok.com/api-live/user/room/?aid=1988&sourceType=54&uniqueId=${encodeURIComponent(name)}`;
  const r = await fetch(url, { headers: TT_HEADERS, signal: AbortSignal.timeout(15_000) });
  if (!r.ok) throw new Error('TikTok antwortet mit HTTP ' + r.status);
  let j;
  try {
    j = JSON.parse(await r.text());
  } catch {
    throw new Error('Unerwartete Antwort von TikTok');
  }
  if (!j.data) {
    if (j.message === 'user_not_found') return { status: 'notfound' };
    throw new Error(j.message || 'Keine Daten von TikTok');
  }
  const { user = {}, liveRoom: room = {} } = j.data;
  const live = room.status === 2 || user.status === 2;
  return {
    status: live ? 'live' : 'offline',
    uniqueId: (user.uniqueId || name).toLowerCase(),
    nickname: user.nickname || name,
    avatar: user.avatarMedium || user.avatarThumb || null,
    bio: user.signature || '',
    roomId: user.roomId || null,
    title: room.title || '',
    hashtag: room.hashtag?.title || '',
    viewers: room.liveRoomStats?.userCount ?? 0,
    startedAt: room.startTime ? room.startTime * 1000 : null,
    cover: room.coverUrl || null,
    flvUrls: live ? flvFromStreamData(room.streamData?.pull_data?.stream_data) : [],
  };
}

/** HugoSMP-Erkennung mit Gedächtnis pro Live-Raum; OCR höchstens alle recheckMinutes. */
async function hugoForRoom(roomId, lastVisionAt, input) {
  if (roomId && hugoRooms.has(roomId)) return { via: hugoRooms.get(roomId).via, visionAt: lastVisionAt };
  if (Date.now() - lastVisionAt < recheckMs()) return { via: null, visionAt: lastVisionAt };
  const via = await detectHugoSmp(input);
  if (via && roomId) hugoRooms.set(roomId, { via, at: Date.now() });
  return { via, visionAt: vision ? Date.now() : lastVisionAt };
}

async function checkTikTok(name) {
  const prev = tiktokStatus.get(name);
  try {
    const r = await fetchTikTok(name);
    const entry = { ...r, matched: [], via: null, checkedAt: Date.now(), error: null, visionAt: 0 };
    if (r.status === 'live') {
      entry.matched = matchTags(r.title, r.hashtag ? [r.hashtag] : []);
      if (!entry.matched.length) {
        // Neuer Live → sofort prüfen; gleicher Live → nur alle paar Minuten erneut.
        const lastVisionAt = prev?.roomId === r.roomId ? prev?.visionAt || 0 : 0;
        const { via, visionAt } = await hugoForRoom(r.roomId, lastVisionAt, {
          texts: [r.title, r.bio, r.nickname],
          flvUrls: r.flvUrls,
        });
        entry.visionAt = visionAt;
        if (via) {
          entry.via = via;
          entry.matched = [config.tiktok.detectTag];
        }
      }
    }
    delete entry.flvUrls; // signierte Stream-URLs nicht aufheben/ausliefern
    tiktokStatus.set(name, entry);
    return entry;
  } catch (e) {
    const entry = { ...(prev || {}), status: 'error', error: e.message, checkedAt: Date.now() };
    tiktokStatus.set(name, entry);
    return entry;
  }
}

function tiktokItem(r) {
  return {
    key: 'tt:' + r.uniqueId,
    platform: 'tiktok',
    login: r.uniqueId,
    name: r.nickname || r.uniqueId,
    title: r.title,
    viewers: r.viewers,
    startedAt: r.startedAt,
    game: '',
    tags: r.hashtag ? [r.hashtag] : [],
    matched: r.matched,
    via: r.via || null,
    url: `https://www.tiktok.com/@${r.uniqueId}/live`,
    thumbnail: r.cover || r.avatar,
    avatar: r.avatar,
  };
}

function feedItem(d) {
  const o = d.owner || {};
  const login = String(o.display_id || d.owner_user_id || '').toLowerCase();
  const first = (x) => x?.url_list?.[0] || x?.urls?.[0] || null;
  return {
    key: 'tt:' + login,
    platform: 'tiktok',
    login,
    name: o.nickname || login,
    title: d.title || '',
    viewers: d.user_count ?? 0,
    startedAt: d.create_time ? d.create_time * 1000 : null,
    game: d.game_tag_detail?.display_name || 'Minecraft',
    tags: [],
    matched: [],
    url: `https://www.tiktok.com/@${login}/live`,
    thumbnail: first(d.stream_snapshot) || first(d.cover) || first(o.avatar_large) || null,
    avatar: first(o.avatar_thumb) || first(o.avatar_medium) || null,
  };
}

function rebuildTikTok() {
  const byKey = new Map();
  const add = (item) => {
    if (item.matched.length && !byKey.has(item.key)) byKey.set(item.key, item);
  };
  for (const { name } of store.tiktokAccounts) {
    const r = tiktokStatus.get(name);
    if (r?.status === 'live') add(tiktokItem(r));
  }
  for (const room of feedRooms.values()) {
    const it = room.item;
    // Steht der Account schon in der Liste und wurde danach geprüft, weiß die Liste es besser.
    const listed = tiktokStatus.get(it.login);
    if (listed && listed.checkedAt > room.lastSeen) continue;
    const matched = [...new Set([...matchTags(it.title), ...(room.via ? [config.tiktok.detectTag] : [])])];
    add({ ...it, matched, via: room.via || null });
  }
  const streams = [];
  const excluded = [];
  for (const item of byKey.values()) {
    if (isVod(item.title, item.tags)) excluded.push({ ...item, reasons: ['vod'] });
    else streams.push(item);
  }
  streams.sort((a, b) => b.viewers - a.viewers);
  Object.assign(state.tiktok, { streams, excluded });
}

async function scanTikTok() {
  const names = store.tiktokAccounts.map((a) => a.name);
  const results = await mapLimit(names, config.tiktok.concurrency, async (name) => {
    await sleep(150 + Math.random() * 300); // nicht zu aggressiv anfragen
    return checkTikTok(name);
  });
  rebuildTikTok();
  const failed = results.filter((r) => r.status === 'error');
  Object.assign(state.tiktok, {
    checked: names.length,
    updatedAt: Date.now(),
    error:
      names.length && failed.length === names.length
        ? `TikTok antwortet gerade nicht (${failed[0].error}). Neuer Versuch in ${config.tiktok.refreshSeconds} s.`
        : null,
  });
  console.log(`[tiktok] ${names.length} Accounts geprüft, ${state.tiktok.streams.length} Treffer, ${failed.length} Fehler`);
}

function feedUrl() {
  const p = new URLSearchParams({
    aid: '1988',
    app_language: 'de-DE',
    app_name: 'tiktok_web',
    channel: 'tiktok_web',
    channel_id: '1111009',
    device_platform: 'web_pc',
    region: 'DE',
    related_live_tag: 'Minecraft',
    req_from: 'pc_web_game_category_feed_refresh',
    webcast_language: 'de-DE',
  });
  return 'https://webcast.tiktok.com/webcast/feed/?' + p;
}

/** Durchsucht TikToks Minecraft-Lives und erkennt HugoSMP-Spieler (Titel/Bio/Scoreboard). */
async function scanTikTokFeed() {
  const found = new Map();
  // Jeder Abruf liefert ~30 andere empfohlene Lives; seltene Läufe holen dafür mehr.
  for (let i = 0; i < (ONCE ? 6 : 3); i++) {
    const r = await fetch(feedUrl(), {
      headers: { ...TT_HEADERS, Referer: 'https://www.tiktok.com/live/category/gaming/Minecraft' },
      signal: AbortSignal.timeout(15_000),
    });
    const j = await r.json();
    if (j.status_code !== 0) throw new Error('TikTok-Feed: ' + (j.data?.message || j.status_code));
    for (const it of j.data || []) {
      const d = it.data;
      if (d?.id_str && d.owner?.display_id && d.game_tag_detail?.game_tag_id === MINECRAFT_TAG_ID) found.set(d.id_str, d);
    }
    await sleep(500);
  }

  const now = Date.now();
  for (const [id, room] of feedRooms) if (now - room.lastSeen > 15 * 60_000) feedRooms.delete(id);
  for (const [id, h] of hugoRooms) if (now - h.at > 24 * 3_600_000) hugoRooms.delete(id);

  const rooms = [...found.values()].map((d) => {
    const prev = feedRooms.get(d.id_str);
    const room = { via: prev?.via || null, visionAt: prev?.visionAt || 0, item: feedItem(d), lastSeen: now };
    feedRooms.set(d.id_str, room);
    return { room, d };
  });
  state.tiktok.feedRooms = found.size;
  rebuildTikTok();

  let checked = 0;
  await mapLimit(rooms, 3, async ({ room, d }) => {
    if (room.via) return;
    if (matchTags(d.title).length) {
      discover([room.item.login], 'erkannt'); // Tag im Titel reicht – merken, keine OCR nötig
      return;
    }
    const flv = d.stream_url?.flv_pull_url || {};
    const snapshot = d.stream_snapshot?.urls || [];
    const before = room.visionAt;
    const { via, visionAt } = await hugoForRoom(d.id_str, room.visionAt, {
      texts: [d.title, d.owner?.bio_description, d.owner?.nickname],
      imageUrl: snapshot.find((u) => u.includes('.jpeg')) || snapshot[0],
      flvUrls: [flv.FULL_HD1, flv.HD1, flv.SD1, flv.SD2],
    });
    if (visionAt !== before) checked++;
    room.visionAt = visionAt;
    if (via) {
      room.via = via;
      console.log(`[tiktok-feed] HugoSMP erkannt (${via === 'bild' ? 'im Bild' : 'im Text'}): @${room.item.login}`);
      discover([room.item.login], 'erkannt'); // ab jetzt auch direkt prüfen
      rebuildTikTok();
    }
  });
  rebuildTikTok();
  const hits = [...feedRooms.values()].filter((r) => r.via).length;
  console.log(`[tiktok-feed] ${found.size} Minecraft-Lives, ${checked} per Bild geprüft, ${hits} HugoSMP`);
}

// ---------------------------------------------------------------------------
// Abfrage-Schleifen
// ---------------------------------------------------------------------------

function createLoop(key, fn, seconds) {
  let timer = null;
  let running = false;
  let again = false;
  const loop = {
    lastStart: 0,
    async run() {
      if (running) {
        again = true;
        return;
      }
      running = true;
      clearTimeout(timer);
      loop.lastStart = Date.now();
      state[key].scanning = true;
      try {
        await fn();
      } catch (e) {
        state[key].error = e.message;
        console.error(`[${key}]`, e.message);
      } finally {
        running = false;
        state[key].scanning = false;
        state[key].nextAt = Date.now() + seconds * 1000;
        timer = setTimeout(() => loop.run(), seconds * 1000);
        if (again) {
          again = false;
          loop.run();
        }
      }
    },
  };
  return loop;
}

state.tiktokFeed = { scanning: false, error: null, nextAt: null }; // intern, nicht in der API
const twitchLoop = createLoop('twitch', scanTwitch, config.twitch.refreshSeconds);
const tiktokLoop = createLoop('tiktok', scanTikTok, config.tiktok.refreshSeconds);
const feedLoop = createLoop('tiktokFeed', scanTikTokFeed, config.tiktok.feedRefreshSeconds);

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
};

function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': MIME['.json'], 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

async function readJson(req) {
  // Nur echtes JSON vom selben Ursprung annehmen – blockt fremde Webseiten (CSRF).
  if (!String(req.headers['content-type'] || '').includes('application/json')) throw Object.assign(new Error('JSON erwartet'), { status: 415 });
  const origin = req.headers.origin;
  if (origin && new URL(origin).host !== req.headers.host) throw Object.assign(new Error('Fremder Ursprung'), { status: 403 });
  let size = 0;
  const chunks = [];
  for await (const c of req) {
    size += c.length;
    if (size > 10_000) throw Object.assign(new Error('Zu groß'), { status: 413 });
    chunks.push(c);
  }
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
}

// Ändern nur direkt am eigenen PC. Anfragen über den Cloudflare-Tunnel tragen
// immer cf-connecting-ip / cf-ray – Besucher aus dem Internet können nur lesen.
function isLocal(req) {
  const ip = req.socket.remoteAddress || '';
  const loopback = ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
  const h = req.headers;
  return loopback && !h['cf-connecting-ip'] && !h['cf-ray'] && !h['x-forwarded-for'];
}

function accountList() {
  return store.tiktokAccounts.map((a) => {
    const s = tiktokStatus.get(a.name);
    return {
      name: a.name,
      source: a.source,
      status: s?.status || 'pending',
      nickname: s?.nickname || null,
      avatar: s?.avatar || null,
      matched: s?.matched || [],
      checkedAt: s?.checkedAt || null,
      error: s?.error || null,
    };
  });
}

async function api(req, res, url) {
  const route = `${req.method} ${url.pathname}`;

  if (route === 'GET /api/streams') {
    return json(res, 200, { now: Date.now(), canEdit: isLocal(req), tags: config.tags, twitch: state.twitch, tiktok: state.tiktok });
  }

  if (url.pathname.startsWith('/api/tiktok/') && !isLocal(req)) {
    return json(res, 403, { error: 'Die Accountliste kann nur am eigenen PC geändert werden.' });
  }

  if (route === 'POST /api/refresh') {
    await readJson(req);
    const fresh = (loop) => Date.now() - loop.lastStart > 15_000;
    if (state.twitch.configured && fresh(twitchLoop)) twitchLoop.run();
    if (fresh(tiktokLoop)) tiktokLoop.run();
    if (config.tiktok.minecraftFeed && Date.now() - feedLoop.lastStart > 60_000) feedLoop.run();
    return json(res, 202, { ok: true });
  }

  if (route === 'GET /api/tiktok/accounts') {
    return json(res, 200, { accounts: accountList(), autoAdd: config.tiktok.autoAddTwitchStreamers });
  }

  if (route === 'POST /api/tiktok/accounts') {
    const name = cleanName((await readJson(req)).name);
    if (!TIKTOK_NAME.test(name)) return json(res, 400, { error: 'Ungültiger TikTok-Name (2–24 Zeichen: a–z, 0–9, Punkt, Unterstrich).' });
    if (store.tiktokAccounts.some((a) => a.name === name)) return json(res, 409, { error: `@${name} ist schon in der Liste.` });
    const r = await checkTikTok(name);
    if (r.status === 'notfound') {
      tiktokStatus.delete(name);
      return json(res, 404, { error: `@${name} gibt es auf TikTok nicht.` });
    }
    store.tiktokAccounts.unshift({ name, source: 'manual', addedAt: Date.now() });
    store.ignored = store.ignored.filter((n) => n !== name);
    await saveStore();
    rebuildTikTok();
    return json(res, 201, { account: accountList().find((a) => a.name === name) });
  }

  const del = url.pathname.match(/^\/api\/tiktok\/accounts\/([^/]+)$/);
  if (req.method === 'DELETE' && del) {
    await readJson(req);
    const name = cleanName(decodeURIComponent(del[1]));
    const acc = store.tiktokAccounts.find((a) => a.name === name);
    if (!acc) return json(res, 404, { error: 'Nicht in der Liste.' });
    store.tiktokAccounts = store.tiktokAccounts.filter((a) => a.name !== name);
    if (acc.source === 'twitch' && !store.ignored.includes(name)) store.ignored.push(name);
    tiktokStatus.delete(name);
    await saveStore();
    rebuildTikTok();
    return json(res, 200, { ok: true });
  }

  return json(res, 404, { error: 'Unbekannter Endpunkt' });
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname.startsWith('/api/')) return await api(req, res, url);
    if (req.method !== 'GET' && req.method !== 'HEAD') return json(res, 405, { error: 'Nicht erlaubt' });

    const rel = decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname);
    const file = path.normalize(path.join(PUBLIC, rel));
    if (!file.startsWith(PUBLIC + path.sep)) return json(res, 403, { error: 'Verboten' });
    const body = await readFile(file).catch(() => null);
    if (!body) return json(res, 404, { error: 'Nicht gefunden' });
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(req.method === 'HEAD' ? undefined : body);
  } catch (e) {
    if (!e.status) console.error(e);
    if (!res.headersSent) json(res, e.status || 500, { error: e.status ? e.message : 'Interner Fehler' });
  }
});

// Testmodus:  node server.js --detect bild1.jpg bild2.jpg  → prüft Bilder auf HugoSMP
if (process.argv[2] === '--detect') {
  await loadVision();
  if (!vision) process.exit(1);
  for (const file of process.argv.slice(3)) {
    const t0 = Date.now();
    const hit = await frameShowsHugoSmp(await readFile(file));
    console.log(`${hit ? 'HugoSMP ' : 'kein    '} ${String(Date.now() - t0).padStart(5)} ms  ${path.basename(file)}`);
  }
  await vision.worker.terminate();
  process.exit(0);
}

// Einmal-Modus:  node server.js --once [ziel.json]  → alles einmal abfragen, JSON schreiben, beenden.
// Läuft auf GitHub Actions; die Seite liest dann public/data/streams.json statt /api/streams.
if (ONCE) {
  const out = process.argv[3] || path.join(PUBLIC, 'data', 'streams.json');
  await loadStore();
  try {
    const c = JSON.parse(await readFile(CACHE_FILE, 'utf8'));
    for (const [k, v] of c.tiktokStatus || []) tiktokStatus.set(k, v);
    for (const [k, v] of c.feedRooms || []) feedRooms.set(k, v);
    for (const [k, v] of c.hugoRooms || []) hugoRooms.set(k, v);
  } catch {}

  const step = async (key, fn) => {
    try {
      await fn();
    } catch (e) {
      state[key].error = e.message;
      console.error(`[${key}]`, e.message);
    }
  };
  const visionReady = loadVision();
  if (state.twitch.configured) await step('twitch', scanTwitch);
  else console.warn('[twitch] Keine Zugangsdaten – TWITCH_CLIENT_ID / TWITCH_CLIENT_SECRET fehlen');
  await visionReady;
  state.tiktok.vision = Boolean(vision);
  if (config.tiktok.minecraftFeed) await step('tiktokFeed', scanTikTokFeed);
  await step('tiktok', scanTikTok); // nach dem Feed: frisch erkannte Accounts gleich mitprüfen

  await mkdir(path.dirname(out), { recursive: true });
  await writeFile(out, JSON.stringify({ now: Date.now(), static: true, canEdit: false, tags: config.tags, twitch: state.twitch, tiktok: state.tiktok }));
  await writeFile(CACHE_FILE, JSON.stringify({ tiktokStatus: [...tiktokStatus], feedRooms: [...feedRooms], hugoRooms: [...hugoRooms] }));
  await saveStore();
  await vision?.worker.terminate();
  console.log(`Geschrieben: ${path.relative(ROOT, out)}`);
  process.exit(0);
}

await loadStore();
server.listen(PORT, HOST, () => {
  console.log(`\n  HugoSMP Live läuft auf  http://localhost:${PORT}\n`);
  console.log(`  Tags:   ${config.tags.map((t) => `[${t}]`).join('  ')}`);
  console.log(
    state.twitch.configured
      ? `  Twitch: aktiv – Sprachen ${config.twitch.languages.join(', ') || 'alle'}, alle ${config.twitch.refreshSeconds} s`
      : '  Twitch: KEINE Zugangsdaten – TWITCH_CLIENT_ID / TWITCH_CLIENT_SECRET in .env eintragen',
  );
  console.log(`  TikTok: ${store.tiktokAccounts.length} Accounts, alle ${config.tiktok.refreshSeconds} s`);
  console.log(`  TikTok-Minecraft-Feed: ${config.tiktok.minecraftFeed ? `alle ${config.tiktok.feedRefreshSeconds} s` : 'aus'}\n`);
});

if (state.twitch.configured) twitchLoop.run();
// Bilderkennung zuerst laden (beim ersten Start lädt Tesseract einmalig ~10 MB Sprachdaten).
loadVision().finally(() => {
  state.tiktok.vision = Boolean(vision);
  tiktokLoop.run();
  if (config.tiktok.minecraftFeed) feedLoop.run();
});
