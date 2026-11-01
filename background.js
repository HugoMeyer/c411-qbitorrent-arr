const DEFAULTS = {
  qbUrl: '', username: '', password: '', defaultCategory: '', lastCategory: '',
  radarrUrl: '', radarrKey: '', radarrRoot: '', radarrProfile: '', radarrCategory: '',
  sonarrUrl: '', sonarrKey: '', sonarrRoot: '', sonarrProfile: '', sonarrCategory: '',
  lidarrUrl: '', lidarrKey: '', lidarrRoot: '', lidarrProfile: '', lidarrMetaProfile: '', lidarrCategory: 'lidarr',
  notifyEnabled: true, notifyAll: false, listBadges: true
};
const ARM_TIMEOUT_MS = 20000;
let pending = null; // { tabId, category, paused, media, expires }

async function getConfig() {
  const cfg = await chrome.storage.local.get(DEFAULTS);
  cfg.qbUrl = (cfg.qbUrl || DEFAULTS.qbUrl).replace(/\/+$/, '');
  return cfg;
}

// ---------- qBittorrent ----------

// qBittorrent rejects requests whose Origin/Referer don't match its host (CSRF protection).
async function ensureHeaderRule(base) {
  if (!base) throw new Error('URL qBittorrent non configurée : ouvre les options de l’extension.');
  const origin = new URL(base).origin;
  await chrome.declarativeNetRequest.updateSessionRules({
    removeRuleIds: [1],
    addRules: [{
      id: 1,
      priority: 1,
      action: {
        type: 'modifyHeaders',
        requestHeaders: [
          { header: 'Origin', operation: 'set', value: origin },
          { header: 'Referer', operation: 'set', value: origin + '/' }
        ]
      },
      condition: {
        requestDomains: [new URL(base).hostname],
        tabIds: [chrome.tabs.TAB_ID_NONE],
        resourceTypes: ['xmlhttprequest', 'other']
      }
    }]
  });
}

async function login(cfg) {
  const res = await fetch(cfg.qbUrl + '/api/v2/auth/login', {
    method: 'POST',
    credentials: 'include',
    body: new URLSearchParams({ username: cfg.username, password: cfg.password })
  });
  const text = (await res.text()).trim();
  if (!res.ok || text !== 'Ok.') throw new Error(`Connexion qBittorrent refusée (${res.status} ${text})`);
}

async function qbFetch(path, opts = {}, retry = true) {
  const cfg = await getConfig();
  await ensureHeaderRule(cfg.qbUrl);
  const res = await fetch(cfg.qbUrl + path, { credentials: 'include', ...opts });
  if ((res.status === 401 || res.status === 403) && retry) {
    await login(cfg);
    return qbFetch(path, opts, false);
  }
  return res;
}

async function getCategories() {
  const res = await qbFetch('/api/v2/torrents/categories');
  if (!res.ok) throw new Error(`Impossible de lire les catégories (${res.status})`);
  return Object.keys(await res.json()).sort((a, b) => a.localeCompare(b));
}

async function addTorrent({ base64, filename, category, paused }) {
  const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
  const buildForm = () => {
    const form = new FormData();
    form.append('torrents', new Blob([bytes], { type: 'application/x-bittorrent' }), filename || 'file.torrent');
    if (category) form.append('category', category);
    if (paused) { form.append('paused', 'true'); form.append('stopped', 'true'); }
    return form;
  };
  let res = await qbFetch('/api/v2/torrents/add', { method: 'POST', body: buildForm() }, false);
  if (res.status === 401 || res.status === 403) {
    await login(await getConfig());
    res = await qbFetch('/api/v2/torrents/add', { method: 'POST', body: buildForm() }, false);
  }
  const text = (await res.text()).trim();
  if (!res.ok || text === 'Fails.') throw new Error(`qBittorrent a refusé le torrent (${res.status} ${text})`);
  await chrome.storage.local.set({ lastCategory: category || '' });
  const hash = await infoHash(bytes).catch(() => null);
  if (hash) await trackTorrent(hash, filename);
  return hash;
}

// Returns the index just past the bencoded element starting at i.
function bencodeEnd(b, i) {
  const c = b[i];
  if (c === 0x69) { while (b[i] !== 0x65) i++; return i + 1; } // i...e
  if (c === 0x6c || c === 0x64) { // l...e / d...e
    i++;
    while (b[i] !== 0x65) { if (i >= b.length) throw new Error('bencode'); i = bencodeEnd(b, i); }
    return i + 1;
  }
  let colon = i;
  while (b[colon] !== 0x3a) { if (colon >= b.length) throw new Error('bencode'); colon++; }
  const len = Number(new TextDecoder('latin1').decode(b.subarray(i, colon)));
  return colon + 1 + len;
}

// v1 infohash = SHA-1 of the raw bencoded "info" dictionary.
async function infoHash(bytes) {
  if (bytes[0] !== 0x64) return null;
  let i = 1;
  while (bytes[i] !== 0x65) {
    const keyEnd = bencodeEnd(bytes, i);
    const key = new TextDecoder('latin1').decode(bytes.subarray(bytes.indexOf(0x3a, i) + 1, keyEnd));
    const valEnd = bencodeEnd(bytes, keyEnd);
    if (key === 'info') {
      const digest = await crypto.subtle.digest('SHA-1', bytes.slice(keyEnd, valEnd));
      return [...new Uint8Array(digest)].map((x) => x.toString(16).padStart(2, '0')).join('');
    }
    i = valEnd;
  }
  return null;
}

// ---------- Completion notifications ----------

async function trackTorrent(hash, name) {
  const { tracked = {} } = await chrome.storage.local.get('tracked');
  tracked[hash] = { name: (name || '').replace(/\.torrent$/i, ''), added: Date.now() };
  await chrome.storage.local.set({ tracked });
}

async function pollCompletions() {
  const cfg = await getConfig();
  if (!cfg.notifyEnabled) return;
  const { tracked = {} } = await chrome.storage.local.get('tracked');
  const { incomplete = [] } = await chrome.storage.session.get('incomplete');
  const hashes = Object.keys(tracked);
  if (!cfg.notifyAll && !hashes.length) return;

  const res = await qbFetch(cfg.notifyAll ? '/api/v2/torrents/info' : `/api/v2/torrents/info?hashes=${hashes.join('|')}`);
  if (!res.ok) return;
  const list = await res.json();
  const seen = new Set(list.map((t) => t.hash));

  for (const t of list) {
    if (t.progress < 1) continue;
    const wasWatched = tracked[t.hash] || (cfg.notifyAll && incomplete.includes(t.hash));
    if (!wasWatched) continue;
    chrome.notifications.create('done:' + t.hash, {
      type: 'basic',
      iconUrl: 'icon128.png',
      title: 'Téléchargement terminé',
      message: t.name,
      contextMessage: t.category ? `Catégorie : ${t.category}` : 'qBittorrent'
    });
    delete tracked[t.hash];
  }
  // Forget tracked torrents removed from qBittorrent.
  for (const h of hashes) {
    if (tracked[h] && !seen.has(h) && Date.now() - tracked[h].added > 10 * 60000) delete tracked[h];
  }
  await chrome.storage.local.set({ tracked });
  await chrome.storage.session.set({ incomplete: list.filter((t) => t.progress < 1).map((t) => t.hash) });
}

function ensureAlarm() {
  chrome.alarms.get('poll', (a) => { if (!a) chrome.alarms.create('poll', { periodInMinutes: 0.5 }); });
}
chrome.runtime.onInstalled.addListener(ensureAlarm);
chrome.runtime.onStartup.addListener(ensureAlarm);
ensureAlarm();
chrome.alarms.onAlarm.addListener((a) => { if (a.name === 'poll') pollCompletions().catch(() => {}); });
chrome.notifications.onClicked.addListener(async (id) => {
  chrome.notifications.clear(id);
  const cfg = await getConfig();
  chrome.tabs.create({ url: cfg.qbUrl });
});

// ---------- Popup / list badges ----------

async function listTorrents() {
  const [tRes, iRes] = await Promise.all([
    qbFetch('/api/v2/torrents/info?sort=added_on&reverse=true'),
    qbFetch('/api/v2/transfer/info')
  ]);
  if (!tRes.ok) throw new Error(`qBittorrent ${tRes.status}`);
  const torrents = (await tRes.json()).map((t) => ({
    hash: t.hash, name: t.name, state: t.state, progress: t.progress, dlspeed: t.dlspeed, upspeed: t.upspeed,
    eta: t.eta, size: t.size, category: t.category, ratio: t.ratio, completion_on: t.completion_on, added_on: t.added_on
  }));
  const info = iRes.ok ? await iRes.json() : {};
  return { torrents, dlspeed: info.dl_info_speed || 0, upspeed: info.up_info_speed || 0 };
}

// qBittorrent 5 renamed pause/resume to stop/start.
async function toggleTorrent(hash, pause) {
  const body = () => new URLSearchParams({ hashes: hash });
  let res = await qbFetch(`/api/v2/torrents/${pause ? 'stop' : 'start'}`, { method: 'POST', body: body() });
  if (res.status === 404) res = await qbFetch(`/api/v2/torrents/${pause ? 'pause' : 'resume'}`, { method: 'POST', body: body() });
  if (!res.ok) throw new Error(`qBittorrent ${res.status}`);
}

// ---------- Radarr / Sonarr / Lidarr ----------

const ARR_LABEL = { radarr: 'Radarr', sonarr: 'Sonarr', lidarr: 'Lidarr' };

function arrErrorMessage(data) {
  if (Array.isArray(data)) return data.map((e) => e.errorMessage || e.message || JSON.stringify(e)).join(' ; ');
  if (data && typeof data === 'object') return data.message || data.error || JSON.stringify(data);
  return String(data).slice(0, 200);
}

async function arr(service, path, opts = {}, cfgOverride) {
  const cfg = cfgOverride || await getConfig();
  const base = (cfg[service + 'Url'] || '').trim().replace(/\/+$/, '');
  const key = (cfg[service + 'Key'] || '').trim();
  if (!base || !key) throw new Error(`${ARR_LABEL[service]} n’est pas configuré`);
  const res = await fetch(base + (service === 'lidarr' ? '/api/v1' : '/api/v3') + path, {
    ...opts,
    headers: { 'X-Api-Key': key, 'Content-Type': 'application/json' }
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  if (!res.ok) throw new Error(`${ARR_LABEL[service]} ${res.status} : ${arrErrorMessage(data)}`);
  return data;
}

async function arrMeta(service, cfg) {
  const [profiles, roots, metaProfiles] = await Promise.all([
    arr(service, '/qualityprofile', {}, cfg),
    arr(service, '/rootfolder', {}, cfg),
    service === 'lidarr' ? arr(service, '/metadataprofile', {}, cfg) : null
  ]);
  const out = {
    profiles: profiles.map((p) => ({ id: p.id, name: p.name })),
    roots: roots.map((r) => r.path)
  };
  if (metaProfiles) out.metaProfiles = metaProfiles.map((p) => ({ id: p.id, name: p.name }));
  return out;
}

const first = (x) => (Array.isArray(x) ? x[0] : x);
const asList = (x) => (Array.isArray(x) ? x : x ? [x] : []);

async function lookupMovie(ids) {
  let movie = null;
  if (ids.tmdb && ids.tmdbKind !== 'tv') movie = first(await arr('radarr', `/movie/lookup/tmdb?tmdbId=${ids.tmdb}`).catch(() => null));
  if (!movie && ids.imdb) movie = first(await arr('radarr', `/movie/lookup/imdb?imdbId=${ids.imdb}`).catch(() => null));
  return movie && movie.tmdbId ? movie : null;
}

async function findMovieInLibrary(tmdbId) {
  const list = asList(await arr('radarr', `/movie?tmdbId=${tmdbId}`));
  return list.find((m) => String(m.tmdbId) === String(tmdbId)) || null;
}

async function lookupSeries(ids) {
  const terms = [];
  if (ids.tvdb) terms.push(`tvdb:${ids.tvdb}`);
  if (ids.imdb) terms.push(`imdb:${ids.imdb}`);
  if (ids.tmdb && ids.tmdbKind === 'tv') terms.push(`tmdb:${ids.tmdb}`);
  for (const term of terms) {
    const results = await arr('sonarr', `/series/lookup?term=${encodeURIComponent(term)}`).catch(() => []);
    if (Array.isArray(results) && results.length) {
      const s = (ids.tvdb && results.find((r) => String(r.tvdbId) === String(ids.tvdb))) || results[0];
      if (s && s.tvdbId) return s;
    }
  }
  return null;
}

async function findSeriesInLibrary(tvdbId) {
  const list = asList(await arr('sonarr', `/series?tvdbId=${tvdbId}`));
  return list.find((s) => String(s.tvdbId) === String(tvdbId)) || null;
}

// Entries are always added unmonitored: downloads come from C411, never from Radarr/Sonarr.
async function addMovie(ids, cfg, rootFolder) {
  rootFolder = rootFolder || cfg.radarrRoot;
  if (!rootFolder || !cfg.radarrProfile) throw new Error('Radarr : dossier racine / profil qualité non configurés');
  const movie = await lookupMovie(ids);
  if (!movie) throw new Error('Radarr : film introuvable');

  if (movie.id || await findMovieInLibrary(movie.tmdbId)) return `déjà dans Radarr (${movie.title})`;
  await arr('radarr', '/movie', {
    method: 'POST',
    body: JSON.stringify({
      ...movie,
      qualityProfileId: Number(cfg.radarrProfile),
      rootFolderPath: rootFolder,
      monitored: false,
      minimumAvailability: movie.minimumAvailability || 'released',
      addOptions: { monitor: 'none', searchForMovie: false }
    })
  });
  return `ajouté à Radarr, non surveillé (${movie.title})`;
}

async function addSeries(ids, cfg, rootFolder, seriesType) {
  rootFolder = rootFolder || cfg.sonarrRoot;
  if (!rootFolder || !cfg.sonarrProfile) throw new Error('Sonarr : dossier racine / profil qualité non configurés');
  const series = await lookupSeries(ids);
  if (!series) throw new Error('Sonarr : série introuvable');

  const existing = await findSeriesInLibrary(series.tvdbId);
  if (existing) return `déjà dans Sonarr (${existing.title})`;

  await arr('sonarr', '/series', {
    method: 'POST',
    body: JSON.stringify({
      ...series,
      qualityProfileId: Number(cfg.sonarrProfile),
      languageProfileId: 1,
      rootFolderPath: rootFolder,
      seriesType: seriesType || series.seriesType || 'standard',
      monitored: false,
      seasonFolder: true,
      seasons: (series.seasons || []).map((s) => ({ ...s, monitored: false })),
      addOptions: { monitor: 'none', searchForMissingEpisodes: false, searchForCutoffUnmetEpisodes: false }
    })
  });
  return `ajouté à Sonarr, non surveillée (${series.title})`;
}

// ---------- Lidarr (music) ----------

const MBID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const mbCache = new Map();
const normTitle = (s) => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
  .replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').trim();
const sameTitle = (a, b) => {
  a = normTitle(a);
  b = normTitle(b);
  return !!a && !!b && (a === b || a.includes(b) || b.includes(a));
};
const mbArtistOf = (x) => ((((x && x['artist-credit']) || [])[0] || {}).artist || {}).id;
const quote = (s) => '"' + String(s).replace(/["\\]/g, ' ') + '"';
// A lookup may fail for one unknown ID (Lidarr metadata server): try the next way, but never hide
// a bad API key, a missing configuration or an unreachable server.
const softFail = (fallback) => (e) => {
  if (e instanceof TypeError || /^Lidarr (401|403) |n’est pas configuré/.test(e.message)) throw e;
  return fallback;
};

// Public MusicBrainz API (CORS enabled); answers are kept while the service worker lives.
function mbGet(path) {
  if (!mbCache.has(path)) {
    mbCache.set(path, fetch(`https://musicbrainz.org/ws/2/${path}${path.includes('?') ? '&' : '?'}fmt=json`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`MusicBrainz ${r.status}`))))
      .catch((e) => { mbCache.delete(path); throw e; }));
  }
  return mbCache.get(path);
}

// C411 links MusicBrainz releases; Lidarr works with release groups. Without IDs: MusicBrainz search.
async function musicIds(media) {
  const ids = { ...(media.ids || {}) };
  if (MBID.test(ids.mbRelease || '') && !ids.mbReleaseGroup) {
    const r = await mbGet(`release/${ids.mbRelease}?inc=release-groups+artist-credits`).catch(() => null);
    if (r && r['release-group']) {
      ids.mbReleaseGroup = r['release-group'].id;
      ids.mbArtist = ids.mbArtist || mbArtistOf(r);
    }
  }
  if (!ids.mbReleaseGroup && media.album && media.lmode !== 'artist') {
    const q = 'releasegroup:' + quote(media.album) + (media.artist ? ' AND artist:' + quote(media.artist) : '');
    const r = await mbGet(`release-group?limit=10&query=${encodeURIComponent(q)}`).catch(() => null);
    const rg = r && (r['release-groups'] || []).find((g) => g.score >= 80 && normTitle(g.title) === normTitle(media.album));
    if (rg) {
      ids.mbReleaseGroup = rg.id;
      ids.mbArtist = ids.mbArtist || mbArtistOf(rg);
    }
  }
  return ids;
}

async function lidarrFindArtist(mbArtist, name) {
  if (MBID.test(mbArtist || '')) {
    const a = asList(await arr('lidarr', `/artist?mbId=${mbArtist}`)).find((x) => x.foreignArtistId === mbArtist);
    if (a || !name) return a || null;
  }
  if (!name) return null;
  return asList(await arr('lidarr', '/artist')).find((x) => normTitle(x.artistName) === normTitle(name)) || null;
}

async function lidarrLookupArtist(media, ids) {
  if (MBID.test(ids.mbArtist || '')) {
    const a = first(await arr('lidarr', `/artist/lookup?term=${encodeURIComponent('lidarr:' + ids.mbArtist)}`).catch(softFail(null)));
    if (a && a.foreignArtistId) return a;
  }
  if (!media.artist) return null;
  const list = asList(await arr('lidarr', `/artist/lookup?term=${encodeURIComponent(media.artist)}`).catch(softFail([])));
  return list.find((a) => normTitle(a.artistName) === normTitle(media.artist)) || null;
}

async function lidarrLookupAlbum(media, ids) {
  for (const id of [ids.mbReleaseGroup, ids.mbRelease]) {
    if (!MBID.test(id || '')) continue;
    const a = first(await arr('lidarr', `/album/lookup?term=${encodeURIComponent('lidarr:' + id)}`).catch(softFail(null)));
    if (a && a.foreignAlbumId) return a;
  }
  if (!media.album) return null;
  const artistOk = (x) => !media.artist || (x.artist && ((ids.mbArtist && x.artist.foreignArtistId === ids.mbArtist) ||
    sameTitle(x.artist.artistName, media.artist)));
  for (const term of [[media.artist, media.album].filter(Boolean).join(' '), media.album]) {
    const list = asList(await arr('lidarr', `/album/lookup?term=${encodeURIComponent(term)}`).catch(softFail([])));
    const a = list.find((x) => sameTitle(x.title, media.album) && artistOk(x));
    if (a) return a;
  }
  return null;
}

// Root folder + profiles: options first, then the root folder defaults. "None" = only manually added albums.
async function lidarrTarget(cfg, rootFolder, forArtist) {
  const [roots, qps, mps] = (await Promise.all(['/rootfolder', '/qualityprofile', '/metadataprofile']
    .map((p) => arr('lidarr', p, {}, cfg)))).map(asList);
  const path = rootFolder || cfg.lidarrRoot || (roots[0] && roots[0].path);
  if (!path) throw new Error('Lidarr : aucun dossier racine');
  const rf = roots.find((r) => r.path === path) || {};
  const pick = (list, ids, ok = () => true) => ids.map(Number).find((id) => list.some((p) => p.id === id && ok(p)));
  const quality = pick(qps, [cfg.lidarrProfile, rf.defaultQualityProfileId, qps[0] && qps[0].id]);
  const realMeta = mps.find((p) => p.name !== 'None');
  const metadata = pick(mps, [cfg.lidarrMetaProfile, rf.defaultMetadataProfileId, realMeta && realMeta.id],
    (p) => !forArtist || p.name !== 'None');
  if (!quality || !metadata) throw new Error('Lidarr : profil qualité / métadonnées introuvable');
  return { path, quality, metadata };
}

// Artists and albums are always added unmonitored, without any search.
const lidarrArtistBody = (artist, t) => ({
  ...artist,
  qualityProfileId: t.quality,
  metadataProfileId: t.metadata,
  rootFolderPath: t.path,
  monitored: false,
  monitorNewItems: 'none',
  albumFolder: true,
  tags: [],
  addOptions: { monitor: 'none', searchForMissingAlbums: false }
});

async function addMusic(media, cfg) {
  const ids = await musicIds(media);
  if (media.lmode === 'artist') {
    let artist = await lidarrFindArtist(ids.mbArtist, media.artist);
    if (!artist) artist = await lidarrLookupArtist(media, ids);
    if (!artist) throw new Error('Lidarr : artiste introuvable');
    if (artist.id) return `déjà dans Lidarr (${artist.artistName})`;
    const t = await lidarrTarget(cfg, media.rootFolder, true);
    await arr('lidarr', '/artist', { method: 'POST', body: JSON.stringify(lidarrArtistBody(artist, t)) });
    return `artiste ajouté à Lidarr, non surveillé (${artist.artistName})`;
  }
  const album = await lidarrLookupAlbum(media, ids);
  if (!album) throw new Error('Lidarr : album introuvable (corrige artiste / album, ou choisis « L’artiste seul »)');
  const name = album.title + (album.artist && album.artist.artistName ? ` — ${album.artist.artistName}` : '');
  if (album.id) return `déjà dans Lidarr (${name})`;
  const inLib = asList(await arr('lidarr', `/album?foreignAlbumId=${album.foreignAlbumId}`))
    .find((x) => x.foreignAlbumId === album.foreignAlbumId);
  if (inLib) return `déjà dans Lidarr (${name})`;
  let artist = album.artist || {};
  if (!artist.id) {
    artist = (await lidarrFindArtist(artist.foreignArtistId)) ||
      lidarrArtistBody(artist, await lidarrTarget(cfg, media.rootFolder, false));
  }
  await arr('lidarr', '/album', {
    method: 'POST',
    body: JSON.stringify({ ...album, artist, monitored: false, anyReleaseOk: true, addOptions: { searchForNewAlbum: false } })
  });
  return `ajouté à Lidarr, non surveillé (${name})`;
}

async function addToArr(media) {
  if (!media || !media.type) return null;
  const cfg = await getConfig();
  if (media.type === 'music') return addMusic(media, cfg);
  return media.type === 'movie'
    ? addMovie(media.ids, cfg, media.rootFolder)
    : addSeries(media.ids, cfg, media.rootFolder, media.seriesType);
}

// ---------- Page status (duplicates / library) ----------

async function qbTorrentByHash(hash) {
  const res = await qbFetch(`/api/v2/torrents/info?hashes=${hash.toLowerCase()}`);
  if (!res.ok) throw new Error(`qBittorrent ${res.status}`);
  const t = first(await res.json());
  return t ? { name: t.name, state: t.state, progress: t.progress, category: t.category } : null;
}

async function movieStatus(ids) {
  let movie = null;
  if (ids.tmdb && ids.tmdbKind === 'movie') movie = await findMovieInLibrary(ids.tmdb);
  else {
    const found = await lookupMovie(ids);
    if (found) movie = found.id ? found : await findMovieInLibrary(found.tmdbId);
  }
  if (!movie) return { service: 'Radarr', inLibrary: false };
  return { service: 'Radarr', inLibrary: true, title: movie.title, hasFile: !!movie.hasFile, monitored: !!movie.monitored };
}

async function seriesStatus(ids, seasons) {
  let tvdbId = ids.tvdb;
  if (!tvdbId) {
    const found = await lookupSeries(ids);
    tvdbId = found && found.tvdbId;
  }
  const series = tvdbId ? await findSeriesInLibrary(tvdbId) : null;
  if (!series) return { service: 'Sonarr', inLibrary: false };
  const seasonInfo = seasons.map((n) => {
    const s = (series.seasons || []).find((x) => x.seasonNumber === n);
    const st = (s && s.statistics) || {};
    return { number: n, exists: !!s, monitored: !!(s && s.monitored), files: st.episodeFileCount || 0, total: st.totalEpisodeCount || st.episodeCount || 0 };
  });
  const st = series.statistics || {};
  return {
    service: 'Sonarr', inLibrary: true, title: series.title, seasons: seasonInfo,
    files: st.episodeFileCount || 0, total: st.episodeCount || st.totalEpisodeCount || 0
  };
}

async function musicStatus(media) {
  const ids = await musicIds(media);
  let album = null;
  let artist = null;
  if (ids.mbReleaseGroup) {
    album = asList(await arr('lidarr', `/album?foreignAlbumId=${ids.mbReleaseGroup}`))
      .find((x) => x.foreignAlbumId === ids.mbReleaseGroup) || null;
  }
  if (!album) {
    artist = await lidarrFindArtist(ids.mbArtist, media.artist);
    if (artist && media.album) {
      album = asList(await arr('lidarr', `/album?artistId=${artist.id}`))
        .find((x) => normTitle(x.title) === normTitle(media.album)) || null;
    }
  }
  if (!album) return artist ? { service: 'Lidarr', inLibrary: true, artistOnly: true, title: artist.artistName } : { service: 'Lidarr', inLibrary: false };
  const st = album.statistics || {};
  return { service: 'Lidarr', inLibrary: true, title: album.title, files: st.trackFileCount || 0, total: st.totalTrackCount || 0 };
}

async function pageStatus({ hash, media }) {
  const cfg = await getConfig();
  const [qbit, library] = await Promise.all([
    hash ? qbTorrentByHash(hash).catch(() => undefined) : undefined,
    (async () => {
      if (!media || !media.type) return undefined;
      if (media.type === 'movie' && cfg.radarrUrl && cfg.radarrKey) return movieStatus(media.ids);
      if (media.type === 'series' && cfg.sonarrUrl && cfg.sonarrKey) return seriesStatus(media.ids, media.seasons || []);
      if (media.type === 'music' && cfg.lidarrUrl && cfg.lidarrKey) return musicStatus(media);
      return undefined;
    })().catch(() => undefined)
  ]);
  return { qbit, library };
}

// ---------- Download interception ----------

chrome.downloads.onDeterminingFilename.addListener((item, suggest) => {
  if (!pending || Date.now() > pending.expires) {
    pending = null;
    suggest();
    return;
  }
  const job = pending;
  pending = null;
  chrome.downloads.cancel(item.id, () => {
    chrome.downloads.erase({ id: item.id });
  });
  suggest();
  chrome.tabs.sendMessage(job.tabId, {
    type: 'fetchTorrent',
    url: item.finalUrl || item.url,
    filename: (item.filename || '').split(/[\\/]/).pop() || 'file.torrent',
    category: job.category,
    paused: job.paused,
    media: job.media
  });
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    switch (msg.type) {
      case 'getCategories': {
        const cfg = await getConfig();
        const categories = await getCategories();
        return {
          categories,
          selected: cfg.lastCategory || cfg.defaultCategory,
          byType: { movie: cfg.radarrCategory, series: cfg.sonarrCategory, music: cfg.lidarrCategory },
          defaultRoot: { movie: cfg.radarrRoot, series: cfg.sonarrRoot, music: cfg.lidarrRoot },
          arrEnabled: {
            movie: !!(cfg.radarrUrl && cfg.radarrKey),
            series: !!(cfg.sonarrUrl && cfg.sonarrKey),
            music: !!(cfg.lidarrUrl && cfg.lidarrKey)
          }
        };
      }
      case 'pageStatus':
        return pageStatus(msg);
      case 'listTorrents':
        return listTorrents();
      case 'qbitIndex': {
        const cfg = await getConfig();
        if (!cfg.listBadges) return { torrents: [] };
        const { torrents } = await listTorrents();
        return { torrents: torrents.map(({ hash, name, progress, state }) => ({ hash, name, progress, state })) };
      }
      case 'toggleTorrent':
        await toggleTorrent(msg.hash, msg.pause);
        return {};
      case 'arrMeta':
        return arrMeta(msg.service, msg.cfg);
      case 'arm':
        pending = {
          tabId: sender.tab.id, category: msg.category, paused: msg.paused, media: msg.media,
          expires: Date.now() + ARM_TIMEOUT_MS
        };
        return {};
      case 'disarm':
        pending = null;
        return {};
      case 'upload': {
        // Add to Radarr/Sonarr/Lidarr first so it already knows the item when the download completes.
        let arrResult = null;
        let arrError = null;
        try { arrResult = await addToArr(msg.media); } catch (e) { arrError = e.message; }
        await addTorrent(msg);
        return { arrResult, arrError };
      }
      default:
        throw new Error('Message inconnu');
    }
  })()
    .then((data) => sendResponse({ ok: true, ...data }))
    .catch((err) => sendResponse({ ok: false, error: err.message }));
  return true;
});
