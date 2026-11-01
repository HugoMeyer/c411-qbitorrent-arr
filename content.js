(() => {
  const MARK = 'data-qbt-injected';
  const ARM_TIMEOUT_MS = 20000;
  let armTimer = null;

  const norm = (el) => (el.textContent || '').replace(/\s+/g, ' ').trim();

  function send(msg) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(msg, (res) => {
          if (chrome.runtime.lastError) resolve({ ok: false, error: chrome.runtime.lastError.message });
          else resolve(res || { ok: false, error: 'Pas de réponse' });
        });
      } catch (e) {
        resolve({ ok: false, error: 'Extension mise à jour : recharge la page (F5).' });
      }
    });
  }

  function toast(text, isError = false) {
    let box = document.getElementById('qbt-toasts');
    if (!box) {
      box = document.createElement('div');
      box.id = 'qbt-toasts';
      Object.assign(box.style, {
        position: 'fixed', bottom: '20px', right: '20px', zIndex: 2147483647,
        display: 'flex', flexDirection: 'column', gap: '8px', alignItems: 'flex-end'
      });
      document.body.appendChild(box);
    }
    const el = document.createElement('div');
    el.textContent = text;
    Object.assign(el.style, {
      padding: '12px 16px', borderRadius: '8px', font: '14px system-ui, sans-serif',
      color: '#fff', background: isError ? '#c0392b' : '#27ae60',
      boxShadow: '0 4px 16px rgba(0,0,0,.3)', maxWidth: '400px'
    });
    box.appendChild(el);
    setTimeout(() => el.remove(), isError ? 8000 : 5000);
  }

  const MUSIC_SOURCES = ['Deezer', 'MusicBrainz', 'Discogs', 'NFO (partiel)'];

  // C411 music card: purple border, album title in the h3, artist in p[title], MusicBrainz/Deezer/Discogs links.
  function detectMusic() {
    const card = [...document.querySelectorAll('div.border-l-purple-500')].find((d) => d.querySelector('h3') &&
      [...d.querySelectorAll('span')].some((s) => MUSIC_SOURCES.includes(norm(s))));
    if (!card) return null;
    const h3 = card.querySelector('h3');
    let album = [...h3.childNodes].filter((n) => n.nodeType === Node.TEXT_NODE).map((n) => n.textContent)
      .join(' ').replace(/\s+/g, ' ').trim();
    if (album === 'Album inconnu') album = '';
    const year = ((h3.querySelector('span') || {}).textContent || '').match(/\b(19|20)\d{2}\b/);
    const artistEl = [...card.querySelectorAll('p[title]')].find((p) => !/^Crédits/.test(norm(p)));
    const ids = {};
    const MB = { 'release-group': 'mbReleaseGroup', release: 'mbRelease', artist: 'mbArtist' };
    for (const a of card.querySelectorAll('a[href]')) {
      const href = a.href;
      let m;
      if ((m = href.match(/musicbrainz\.org\/(release-group|release|artist)\/([0-9a-f-]{36})/i))) ids[MB[m[1].toLowerCase()]] = m[2].toLowerCase();
      else if ((m = href.match(/deezer\.com\/(?:[a-z]{2}\/)?album\/(\d+)/i))) ids.deezer = m[1];
      else if ((m = href.match(/discogs\.com\/(?:[^?#]*\/)?release\/(\d+)/i))) ids.discogs = m[1];
    }
    return {
      type: 'music', ids, fromCard: true, seasons: [], album, year: year ? year[0] : '',
      artist: artistEl ? artistEl.getAttribute('title').trim() : ''
    };
  }

  // Without a music card: "Artiste - Album (2001) [FLAC]" or scene style "Artiste-Album-WEB-2001-GROUPE".
  function guessMusic(title = pageTitle()) {
    const t = title.replace(/\[[^\]]*\]|\{[^}]*\}/g, ' ');
    let parts = t.split(/\s+[-–—]\s+/);
    if (parts.length < 2) parts = t.replace(/[._]/g, ' ').split('-');
    const clean = (s) => (s || '').replace(/\(([^)]*)\)/g, (m, x) => (/^(19|20)\d{2}$/.test(x.trim()) ? ' ' : m))
      .replace(/\s(19|20)\d{2}\b.*$/, '').replace(/\s+/g, ' ').trim();
    const year = t.match(/\b(19|20)\d{2}\b/);
    return { artist: clean(parts[0]), album: clean(parts[1]), year: year ? year[0] : '' };
  }

  function detectMedia() {
    const label = [...document.querySelectorAll('span')].find((s) => norm(s) === 'Fiches :');
    if (!label) {
      const music = detectMusic();
      if (music) return music;
    }
    let links = label ? [...label.parentElement.querySelectorAll('a[href]')] : [];
    if (!links.length) links = [...document.querySelectorAll('a[href]')];

    const ids = {};
    for (const a of links) {
      const href = a.href;
      let m;
      if (!ids.imdb && (m = href.match(/imdb\.com\/title\/(tt\d+)/))) ids.imdb = m[1];
      else if (!ids.tmdb && (m = href.match(/themoviedb\.org\/(movie|tv)\/(\d+)/))) { ids.tmdbKind = m[1]; ids.tmdb = m[2]; }
      else if (!ids.tvdb && (m = href.match(/thetvdb\.com\/.*\bseries\/(\d+)/))) ids.tvdb = m[1];
    }
    const type = ids.tmdbKind === 'tv' || ids.tvdb ? 'series' : ids.tmdbKind === 'movie' ? 'movie' : '';
    return { type, ids, fromFiches: !!label, seasons: type === 'series' ? detectSeasons() : [] };
  }

  function pageTitle() {
    const h1 = document.querySelector('h1');
    return h1 ? norm(h1) : document.title;
  }

  // "S01", "S02E05", "S01-S03" → [1], [2], [1, 2, 3]. Complete packs without Sxx → [].
  function detectSeasons(title = pageTitle()) {
    const found = new Set();
    for (const m of title.matchAll(/S(\d{1,2})\s*-\s*S(\d{1,2})(?![0-9])/gi)) {
      const [a, b] = [Number(m[1]), Number(m[2])].sort((x, y) => x - y);
      if (b - a <= 50) for (let n = a; n <= b; n++) found.add(n);
    }
    for (const m of title.matchAll(/(?:^|[^A-Za-z0-9])S(\d{1,2})(?=E\d|[^A-Za-z0-9]|$)/g)) found.add(Number(m[1]));
    return [...found].sort((a, b) => a - b);
  }

  const pageHashFromUrl = () => {
    const m = location.pathname.match(/\/torrents\/([a-f0-9]{40})\b/i);
    return m ? m[1].toLowerCase() : '';
  };

  function detectHash() {
    const fromUrl = pageHashFromUrl();
    if (fromUrl) return fromUrl;
    const label = [...document.querySelectorAll('span, div, dt, p')].find((el) => /^Hash\s*:?$/i.test(norm(el)));
    const scope = label ? label.parentElement : document.body;
    const m = (scope.textContent || '').match(/\b([a-f0-9]{40})\b/i);
    return m ? m[1].toLowerCase() : '';
  }

  // ---------- Status badge (duplicates / library) ----------

  let badge = null;
  let lastStatus = null;
  let statusKey = '';
  let statusRequest = 0;

  function badgeEl() {
    const ours = document.querySelector(`button[${MARK}="ours"]`);
    if (!ours) return null;
    if (!badge) {
      badge = document.createElement('span');
      Object.assign(badge.style, {
        display: 'inline-flex', flexWrap: 'wrap', gap: '6px', alignItems: 'center',
        marginLeft: '0.5rem', font: '12px system-ui, sans-serif', verticalAlign: 'middle'
      });
    }
    if (badge.previousElementSibling !== ours) ours.insertAdjacentElement('afterend', badge);
    return badge;
  }

  function pill(text, color, title) {
    const el = document.createElement('span');
    el.textContent = text;
    if (title) el.title = title;
    Object.assign(el.style, {
      padding: '3px 8px', borderRadius: '999px', whiteSpace: 'nowrap',
      background: color + '26', color, border: `1px solid ${color}66`
    });
    return el;
  }

  const QB_STATES = {
    downloading: 'téléchargement', stalledDL: 'en attente', metaDL: 'métadonnées', forcedDL: 'téléchargement',
    queuedDL: 'en file', pausedDL: 'en pause', stoppedDL: 'en pause', checkingDL: 'vérification',
    uploading: 'seed', stalledUP: 'seed', forcedUP: 'seed', queuedUP: 'seed (file)', pausedUP: 'terminé',
    stoppedUP: 'terminé', checkingUP: 'vérification', error: 'erreur', missingFiles: 'fichiers manquants'
  };

  function qbitText(q) {
    const pct = Math.floor((q.progress || 0) * 100);
    return `qBittorrent : ${pct >= 100 ? 'complet' : pct + ' %'} · ${QB_STATES[q.state] || q.state}`;
  }

  function renderBadge() {
    const el = badgeEl();
    if (!el) return;
    el.replaceChildren();
    const s = lastStatus;
    if (!s) return;
    if (s.qbit) el.append(pill('⚠ ' + qbitText(s.qbit), '#f59e0b', s.qbit.name + (s.qbit.category ? ` — catégorie : ${s.qbit.category}` : '')));
    const lib = s.library;
    if (!lib) return;
    if (!lib.inLibrary) { el.append(pill(`Pas dans ${lib.service}`, '#9ca3af')); return; }
    if (lib.service === 'Lidarr') {
      if (lib.artistOnly) el.append(pill('Lidarr : artiste présent, album absent', '#9ca3af', lib.title));
      else if (!lib.total) el.append(pill('Lidarr : album présent', '#3b82f6', lib.title));
      else {
        const complete = lib.files >= lib.total;
        el.append(pill(`${complete ? '✔ ' : ''}Lidarr : ${lib.files}/${lib.total} pistes`, complete ? '#22c55e' : '#3b82f6', lib.title));
      }
      return;
    }
    if (lib.service === 'Radarr') {
      el.append(pill(lib.hasFile ? '✔ Radarr : fichier présent' : 'Radarr : fichier manquant',
        lib.hasFile ? '#22c55e' : '#3b82f6', lib.title));
      return;
    }
    if (lib.seasons && lib.seasons.length) {
      for (const se of lib.seasons) {
        const name = 'S' + String(se.number).padStart(2, '0');
        if (!se.exists) { el.append(pill(`Sonarr : ${name} inconnue`, '#9ca3af', lib.title)); continue; }
        const complete = se.total > 0 && se.files >= se.total;
        el.append(pill(`${complete ? '✔ ' : ''}Sonarr ${name} : ${se.files}/${se.total} ép.`,
          complete ? '#22c55e' : '#3b82f6', lib.title));
      }
    } else {
      el.append(pill(`Sonarr : ${lib.files}/${lib.total} ép.`, '#3b82f6', lib.title));
    }
  }

  async function refreshStatus(force = false) {
    if (!document.querySelector(`button[${MARK}="ours"]`)) return;
    const media = detectMedia();
    const hash = detectHash();
    const useMedia = (media.fromFiches || media.fromCard) && media.type;
    const key = [location.pathname, hash, useMedia ? JSON.stringify(media) : ''].join('|');
    if (!force && key === statusKey) { renderBadge(); return; }
    statusKey = key;
    lastStatus = null;
    renderBadge();
    if (!hash && !useMedia) return;
    const reqId = ++statusRequest;
    const res = await send({ type: 'pageStatus', hash, media: useMedia ? media : null });
    if (reqId !== statusRequest || !res.ok) return;
    lastStatus = res;
    renderBadge();
  }

  // ctx (list rows): { name, qbit } — no Radarr/Sonarr/Lidarr IDs are available outside the torrent page.
  function chooseCategory(ctx = null) {
    const listMode = !!ctx;
    const detected = listMode ? { type: '', ids: {} } : detectMedia();
    const knownQbit = listMode ? ctx.qbit : lastStatus && lastStatus.qbit;
    const idsText = [
      detected.ids.imdb && `IMDb ${detected.ids.imdb}`,
      detected.ids.tmdb && `TMDB ${detected.ids.tmdb}`,
      detected.ids.tvdb && `TVDB ${detected.ids.tvdb}`,
      (detected.ids.mbRelease || detected.ids.mbReleaseGroup) && 'MusicBrainz',
      detected.ids.deezer && `Deezer ${detected.ids.deezer}`,
      detected.ids.discogs && `Discogs ${detected.ids.discogs}`
    ].filter(Boolean).join(' · ') || 'aucun ID trouvé';

    return new Promise(async (resolve) => {
      const host = document.createElement('div');
      const root = host.attachShadow({ mode: 'closed' });
      root.innerHTML = `
        <style>
          .bg { position: fixed; inset: 0; background: rgba(0,0,0,.55); z-index: 2147483646;
                display: flex; align-items: center; justify-content: center; font: 14px system-ui, sans-serif; }
          .box { background: #1e1e24; color: #eee; border-radius: 10px; padding: 20px; width: 340px;
                 max-height: 92vh; overflow-y: auto; box-shadow: 0 10px 40px rgba(0,0,0,.5); }
          h3 { margin: 0 0 14px; font-size: 16px; }
          select { width: 100%; padding: 8px; border-radius: 6px; background: #2b2b33; color: #eee; border: 1px solid #444; }
          label { display: flex; gap: 8px; align-items: center; margin-top: 12px; }
          .row { display: flex; justify-content: flex-end; gap: 8px; margin-top: 18px; }
          button { padding: 8px 14px; border-radius: 6px; border: 0; cursor: pointer; font-weight: 600; }
          .ok { background: #3b82f6; color: #fff; } .ok:disabled { opacity: .5; cursor: default; }
          .cancel { background: #3a3a44; color: #eee; }
          .err { color: #ff7b72; margin-top: 10px; white-space: pre-wrap; }
          .lbl { margin: 12px 0 4px; font-weight: 600; } .lbl:first-of-type { margin-top: 0; }
          .ids { margin-top: 4px; font-size: 12px; color: #999; }
          .warn { background: #f59e0b22; color: #fbbf24; border: 1px solid #f59e0b66; border-radius: 6px;
                  padding: 8px 10px; margin-bottom: 12px; }
          input[type=text] { width: 100%; box-sizing: border-box; padding: 8px; border-radius: 6px;
                  background: #2b2b33; color: #eee; border: 1px solid #444; }
          .hint { font-size: 12px; color: #999; margin-top: 4px; }
          .tname { font-size: 12px; color: #bbb; margin: -6px 0 12px; word-break: break-all; }
          .listhint { margin: 0 0 4px; }
        </style>
        <div class="bg">
          <div class="box">
            <h3>Envoyer à qBittorrent</h3>
            <div class="tname" hidden></div>
            <div class="warn" hidden></div>
            <div class="arrsel">
            <div class="lbl">Ajouter à</div>
            <select class="type">
              <option value="">Ne pas ajouter</option>
              <option value="movie">Radarr (film)</option>
              <option value="series">Sonarr (série)</option>
              <option value="music">Lidarr (musique)</option>
            </select>
            <div class="ids">${idsText}</div>
            </div>
            <div class="ids listhint" hidden>Radarr/Sonarr/Lidarr : ouvre la fiche du torrent pour l’ajout automatique.</div>
            <div class="arr" hidden>
              <div class="lbl">Dossier racine</div>
              <select class="root" disabled><option>Chargement…</option></select>
              <div class="stype-wrap" hidden>
                <div class="lbl">Type de série</div>
                <select class="stype">
                  <option value="standard">Standard</option>
                  <option value="anime">Anime</option>
                  <option value="daily">Quotidienne</option>
                </select>
              </div>
              <div class="music-wrap" hidden>
                <div class="lbl">Ajouter dans Lidarr</div>
                <select class="lmode">
                  <option value="album">L’album (et l’artiste si besoin)</option>
                  <option value="artist">L’artiste seul</option>
                </select>
                <div class="lbl">Artiste</div>
                <input type="text" class="artist" placeholder="Nom de l’artiste">
                <div class="album-wrap">
                  <div class="lbl">Album</div>
                  <input type="text" class="album" placeholder="Titre de l’album">
                </div>
              </div>
            </div>
            <div class="lbl">Catégorie qBittorrent</div>
            <select class="cat" disabled><option>Chargement des catégories…</option></select>
            <label><input type="checkbox" class="paused"> Ajouter en pause</label>
            <div class="err" hidden></div>
            <div class="row">
              <button class="cancel">Annuler</button>
              <button class="ok" disabled>Envoyer</button>
            </div>
          </div>
        </div>`;
      document.body.appendChild(host);
      // Typing in our fields must not trigger C411 keyboard shortcuts.
      for (const t of ['keydown', 'keyup', 'keypress']) host.addEventListener(t, (e) => e.stopPropagation());

      const select = root.querySelector('.cat');
      const typeSelect = root.querySelector('.type');
      const rootSelect = root.querySelector('.root');
      const stypeSelect = root.querySelector('.stype');
      const lmodeSelect = root.querySelector('.lmode');
      const artistInput = root.querySelector('.artist');
      const albumInput = root.querySelector('.album');
      const arrBox = root.querySelector('.arr');
      const warn = root.querySelector('.warn');
      const SERVICE = { movie: 'radarr', series: 'sonarr', music: 'lidarr' };
      const guess = detected.type === 'music' ? detected : guessMusic();
      artistInput.value = guess.artist || '';
      albumInput.value = guess.album || '';
      lmodeSelect.onchange = () => { root.querySelector('.album-wrap').hidden = lmodeSelect.value === 'artist'; };
      // Names edited by hand: the MusicBrainz IDs found on the page may no longer match.
      const musicMedia = () => {
        const artist = artistInput.value.trim();
        const album = albumInput.value.trim();
        const sameArtist = detected.type === 'music' && artist === (detected.artist || '');
        const sameAlbum = sameArtist && album === (detected.album || '');
        return {
          type: 'music', artist, album, year: guess.year, rootFolder: rootSelect.value, lmode: lmodeSelect.value,
          ids: sameAlbum ? detected.ids : sameArtist && detected.ids.mbArtist ? { mbArtist: detected.ids.mbArtist } : {}
        };
      };
      if (knownQbit) {
        warn.hidden = false;
        warn.textContent = `⚠ Ce torrent est déjà dans qBittorrent (${qbitText(knownQbit).replace('qBittorrent : ', '')}).`;
      }
      if (listMode) {
        root.querySelector('.arrsel').hidden = true;
        root.querySelector('.listhint').hidden = false;
        if (ctx.name) { const n = root.querySelector('.tname'); n.hidden = false; n.textContent = ctx.name; }
      }
      const ok = root.querySelector('.ok');
      const err = root.querySelector('.err');
      const close = (value) => { host.remove(); resolve(value); };

      root.querySelector('.cancel').onclick = () => close(null);
      root.querySelector('.bg').onclick = (e) => { if (e.target.classList.contains('bg')) close(null); };
      root.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(null); if (e.key === 'Enter' && !ok.disabled) ok.click(); });
      ok.onclick = () => close({
        category: select.value,
        paused: root.querySelector('.paused').checked,
        media: typeSelect.value === 'music' ? musicMedia() : typeSelect.value ? {
          type: typeSelect.value,
          ids: detected.ids,
          rootFolder: rootSelect.value,
          seriesType: typeSelect.value === 'series' ? stypeSelect.value : undefined
        } : null
      });

      const res = await send({ type: 'getCategories' });
      if (!res.ok) {
        select.innerHTML = '<option value="">(aucune catégorie)</option>';
        err.hidden = false;
        err.textContent = res.error + '\nVérifie les options de l’extension.';
        return;
      }
      select.innerHTML = '';
      select.add(new Option('(aucune catégorie)', ''));
      for (const c of res.categories) select.add(new Option(c, c));
      select.value = res.categories.includes(res.selected) ? res.selected : '';

      for (const opt of typeSelect.options) {
        if (opt.value && !res.arrEnabled[opt.value]) { opt.disabled = true; opt.textContent += ' — non configuré'; }
      }
      const hasIds = detected.type === 'music' || detected.ids.imdb || detected.ids.tmdb || detected.ids.tvdb;
      typeSelect.value = hasIds && res.arrEnabled[detected.type] ? detected.type : '';
      const applyTypeCategory = () => {
        const cat = res.byType[typeSelect.value];
        if (cat && res.categories.includes(cat)) select.value = cat;
      };
      const guessSeriesType = () => {
        stypeSelect.value = /anim/i.test(rootSelect.value) ? 'anime' : 'standard';
      };
      rootSelect.onchange = guessSeriesType;
      let rootsRequest = 0;
      const loadRoots = async () => {
        const kind = typeSelect.value;
        arrBox.hidden = !kind;
        root.querySelector('.stype-wrap').hidden = kind !== 'series';
        root.querySelector('.music-wrap').hidden = kind !== 'music';
        if (!kind) { rootsRequest++; err.hidden = true; ok.disabled = false; return; }
        const reqId = ++rootsRequest;
        rootSelect.disabled = true;
        ok.disabled = true;
        rootSelect.innerHTML = '<option>Chargement…</option>';
        const meta = await send({ type: 'arrMeta', service: SERVICE[kind] });
        if (reqId !== rootsRequest) return;
        rootSelect.innerHTML = '';
        if (!meta.ok || !meta.roots.length) {
          err.hidden = false;
          err.textContent = meta.ok ? 'Aucun dossier racine configuré.' : meta.error;
          return;
        }
        err.hidden = true;
        for (const r of meta.roots) rootSelect.add(new Option(r, r));
        const def = res.defaultRoot[kind];
        rootSelect.value = meta.roots.includes(def) ? def : meta.roots[0];
        guessSeriesType();
        rootSelect.disabled = false;
        ok.disabled = false;
      };
      typeSelect.onchange = () => { applyTypeCategory(); loadRoots(); };
      applyTypeCategory();

      select.disabled = false;
      ok.disabled = false;
      ok.focus();
      loadRoots();
    });
  }

  function clickNormalDownloadIfOffered() {
    const deadline = Date.now() + 5000;
    const tryClick = () => {
      const label = [...document.querySelectorAll('span, div, button, a')]
        .find((el) => norm(el) === 'Téléchargement normal' && el.offsetParent !== null);
      if (label) {
        (label.closest('button, a, [role="menuitem"], [role="option"], [role="button"], li') || label).click();
        return;
      }
      if (Date.now() < deadline) setTimeout(tryClick, 150);
    };
    setTimeout(tryClick, 150);
  }

  async function sendToQbit(nativeButton, ctx = null) {
    const choice = await chooseCategory(ctx);
    if (!choice) return;

    const armed = await send({ type: 'arm', ...choice });
    if (!armed.ok) return toast(armed.error, true);

    clearTimeout(armTimer);
    armTimer = setTimeout(() => {
      send({ type: 'disarm' });
      toast('Aucun téléchargement détecté. Réessaie.', true);
    }, ARM_TIMEOUT_MS);

    nativeButton.click();
    clickNormalDownloadIfOffered();
  }

  async function handleTorrent({ url, filename, category, paused, media }) {
    clearTimeout(armTimer);
    try {
      const res = await fetch(url, { credentials: 'include' });
      if (!res.ok) throw new Error(`Téléchargement du .torrent impossible (${res.status})`);
      const bytes = new Uint8Array(await res.arrayBuffer());
      const head = new TextDecoder('latin1').decode(bytes.slice(0, 4096));
      if (head[0] !== 'd' || !new TextDecoder('latin1').decode(bytes).includes('4:info')) {
        throw new Error('Le fichier récupéré n’est pas un .torrent valide');
      }
      let bin = '';
      for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      const up = await send({ type: 'upload', base64: btoa(bin), filename, category, paused, media });
      if (!up.ok) throw new Error(up.error);
      toast(`Envoyé à qBittorrent${category ? ` (catégorie : ${category})` : ''} ✔`);
      if (up.arrResult) toast(`✔ ${up.arrResult}`);
      if (up.arrError) toast(up.arrError, true);
      setTimeout(() => { refreshStatus(true); qbIndex = null; refreshListBadges(); }, 1500);
    } catch (e) {
      toast(e.message, true);
    }
  }

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === 'fetchTorrent') handleTorrent(msg);
  });

  // ---------- qBittorrent buttons: torrent page, and right after each download icon in lists ----------

  // Native download button -> our button. C411's own elements are never modified (Vue may re-render or
  // reuse them); our button is recreated whenever it is no longer in the page.
  const pairs = new Map();

  function pairUp(native, make) {
    const ours = pairs.get(native);
    if (ours && ours.isConnected) return;
    const el = make();
    pairs.set(native, el);
    native.insertAdjacentElement('afterend', el);
  }

  function sweepPairs() {
    for (const [native, ours] of pairs) {
      if (native.isConnected && ours.isConnected) continue;
      if (!native.isConnected) ours.remove();
      pairs.delete(native);
    }
  }

  function pageButton(btn) {
    const ours = btn.cloneNode(false);
    ours.removeAttribute('id');
    ours.setAttribute(MARK, 'ours');
    const icon = btn.querySelector('[data-slot="leadingIcon"], .iconify, svg');
    if (icon) ours.append(icon.cloneNode(true));
    ours.append(document.createTextNode(icon ? ' qBittorrent' : '⇩ qBittorrent'));
    ours.title = 'Envoyer à qBittorrent';
    ours.style.marginLeft = '0.5rem';
    ours.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      sendToQbit(btn);
    });
    return ours;
  }

  const gridToken = (el) => (typeof el.className === 'string'
    ? (el.className.split(/\s+/).find((c) => c.startsWith('lg:grid-cols-[')) || '') : '');

  // Result rows are CSS grids whose columns come from a `lg:grid-cols-[…]` class. Only a few levels up
  // are checked, so that a page-layout grid is never taken for a row.
  function rowGrid(btn) {
    let el = btn.parentElement;
    for (let depth = 0; el && depth < 3; depth++, el = el.parentElement) if (gridToken(el)) return el;
    return null;
  }

  // On desktop, the download-icon column (the last one) is doubled so that our icon fits next to C411's.
  // The rule targets the class itself: rows and header sharing it stay aligned, rows added later are
  // covered, and the mobile layout (below Tailwind's `lg` breakpoint) is left untouched.
  const gridRules = new Map();

  function widenColumn(token) {
    if (gridRules.has(token)) return;
    const cols = token.slice('lg:grid-cols-['.length, -1).split('_');
    const last = /^(\d+(?:\.\d+)?)px$/.exec(cols[cols.length - 1]);
    if (!last) { gridRules.set(token, ''); return; }
    cols[cols.length - 1] = `${Number(last[1]) * 2}px`;
    const sel = `.${CSS.escape(token)}`;
    gridRules.set(token, `@media (min-width: 64rem) { ${sel}${sel} { grid-template-columns: ${cols.join(' ')}; } }`);
  }

  function applyGridRules() {
    const css = [...gridRules.values()].filter(Boolean).join('\n');
    if (!css) return;
    let style = document.getElementById('qbt-style');
    if (!style) {
      style = document.createElement('style');
      style.id = 'qbt-style';
      style.setAttribute(MARK, 'style');
      (document.head || document.documentElement).append(style);
    }
    if (style.textContent !== css) style.textContent = css;
  }

  function rowLink(row) {
    const wrapping = row.closest('a[href*="/torrents/"]');
    if (wrapping) return wrapping;
    let el = row.parentElement;
    for (let depth = 0; el && depth < 5; depth++, el = el.parentElement) {
      const links = [...el.querySelectorAll('a[href*="/torrents/"]')]
        .filter((a) => /\/torrents\/[^/?#]+/.test(a.getAttribute('href')));
      const uniq = [...new Set(links.map((a) => a.getAttribute('href')))];
      if (uniq.length === 1) return links.find((a) => norm(a)) || links[0];
      if (uniq.length > 1) return null;
    }
    return null;
  }

  function listButton(btn, row) {
    const ours = btn.cloneNode(true);
    for (const attr of ['id', 'data-state', 'data-grace-area-trigger']) ours.removeAttribute(attr);
    ours.setAttribute(MARK, 'ours-list');
    ours.setAttribute('aria-label', 'Envoyer à qBittorrent');
    ours.title = 'Envoyer à qBittorrent';
    ours.style.color = '#60a5fa';
    ours.style.marginLeft = '2px';
    ours.addEventListener('click', async (e) => {
      e.preventDefault();
      e.stopPropagation();
      const a = rowLink(row);
      let qbit = null;
      if (a) {
        const t = matchAnchor(a, await loadIndex());
        if (t) qbit = { name: t.name, progress: t.progress, state: t.state };
      }
      // innerText: only the layout shown at this screen size (rows hold both a desktop and a mobile one).
      const name = a ? (a.innerText || a.textContent || '').replace(/\s+/g, ' ').trim() : '';
      sendToQbit(btn, { name, qbit });
    });
    return ours;
  }

  const hasDownloadIcon = (btn) => !!btn.querySelector('[class*="arrow-down-tray"]');

  function inject() {
    sweepPairs();
    for (const btn of document.querySelectorAll('button')) {
      if (btn.hasAttribute(MARK)) continue;
      const text = norm(btn);
      if (text === 'Télécharger') { pairUp(btn, () => pageButton(btn)); continue; }
      if (text) continue;
      const grid = rowGrid(btn);
      const label = btn.getAttribute('aria-label');
      // Desktop rows and search "media" rows label their download icon; the mobile result cards don't.
      const listed = label === 'Télécharger'
        || (label === null && !grid && hasDownloadIcon(btn) && !!btn.closest('a[href*="/torrents/"]'));
      if (!listed) continue;
      if (grid) widenColumn(gridToken(grid));
      pairUp(btn, () => listButton(btn, grid || btn.parentElement));
    }
    applyGridRules();
  }

  // ---------- List badges (search results, etc.) ----------

  const PILL = 'data-qbt-pill';
  const normName = (s) => (s || '').toLowerCase().replace(/\.torrent$/, '').replace(/[^a-z0-9]+/g, '');
  let qbIndex = null; // { byName: Map, byHash: Map, at }

  async function loadIndex() {
    if (qbIndex && Date.now() - qbIndex.at < 30000) return qbIndex;
    const res = await send({ type: 'qbitIndex' });
    const torrents = res.ok ? res.torrents : [];
    qbIndex = {
      at: Date.now(),
      byName: new Map(torrents.map((t) => [normName(t.name), t])),
      byHash: new Map(torrents.map((t) => [t.hash, t]))
    };
    return qbIndex;
  }

  function matchAnchor(a, idx) {
    const h = (a.getAttribute('href') || '').match(/[a-f0-9]{40}/i);
    if (h && idx.byHash.has(h[0].toLowerCase())) return idx.byHash.get(h[0].toLowerCase());
    const candidates = [a.title, norm(a)];
    for (const el of a.querySelectorAll('*')) if (!el.children.length) candidates.push(el.textContent);
    for (const c of candidates) {
      const k = normName(c);
      if (k.length >= 12 && idx.byName.has(k)) return idx.byName.get(k);
    }
    return null;
  }

  // Where to put the pill: next to the "copy file name" button of the result row, if any.
  function pillSlots(a) {
    let el = a;
    for (let depth = 0; el && depth < 8; depth++, el = el.parentElement) {
      const btns = el.querySelectorAll('button[aria-label="Copier le nom du fichier"]');
      if (btns.length && btns.length <= 2) return [...btns].map((b) => ({ ref: b, where: 'beforebegin' }));
      if (btns.length > 2) break;
    }
    // Card-like links (e.g. notifications): put it at the end of the last text line, inside the link.
    const lines = a.querySelectorAll('p');
    if (lines.length) return [{ ref: lines[lines.length - 1], where: 'beforeend' }];
    return [{ ref: a, where: 'afterend' }];
  }

  function existingPillAt(ref, where) {
    const el = where === 'beforebegin' ? ref.previousElementSibling
      : where === 'beforeend' ? ref.lastElementChild
        : ref.nextElementSibling;
    return !!(el && el.hasAttribute(PILL));
  }

  const anchorPills = new WeakMap();

  async function refreshListBadges() {
    const idx = await loadIndex();
    if (!idx.byName.size) return;
    const onDetail = !!document.querySelector(`button[${MARK}="ours"]`);
    const currentHash = pageHashFromUrl() || (onDetail ? detectHash() : '');
    const h1 = onDetail ? document.querySelector('h1') : null;
    const titleKey = h1 ? normName(h1.textContent) : '';
    for (const a of document.querySelectorAll('a[href]')) {
      if (a.closest(`[${PILL}]`) || a.closest('#qbt-toasts')) continue;
      // The torrent of the current page is already shown next to the qBittorrent button.
      const selfLink = currentHash && (a.getAttribute('href') || '').toLowerCase().includes(currentHash);
      const hidden = !a.getClientRects().length;
      if (selfLink || hidden) {
        (anchorPills.get(a) || []).forEach((p) => p.remove());
        anchorPills.delete(a);
        continue;
      }
      let t = matchAnchor(a, idx);
      if (t && ((currentHash && t.hash === currentHash) || (titleKey.length >= 12 && normName(t.name) === titleKey))) t = null;
      let pills = (anchorPills.get(a) || []).filter((p) => p.isConnected);
      if (!t) { pills.forEach((p) => p.remove()); anchorPills.delete(a); continue; }
      const done = t.progress >= 1;
      const text = done ? '✔ qBit' : `⇩ ${Math.floor(t.progress * 100)} %`;
      if (!pills.length) {
        pills = pillSlots(a)
          .filter(({ ref, where }) => !existingPillAt(ref, where))
          .map(({ ref, where }) => {
            const p = pill(text, done ? '#22c55e' : '#3b82f6', `Déjà dans qBittorrent : ${t.name}`);
            p.setAttribute(PILL, '');
            Object.assign(p.style, { fontSize: '10px', padding: '1px 6px', flexShrink: '0', lineHeight: '1.4' });
            if (where !== 'beforebegin') p.style.marginLeft = '6px';
            if (where === 'beforeend') p.style.display = 'inline-block';
            ref.insertAdjacentElement(where, p);
            return p;
          });
        anchorPills.set(a, pills);
      } else {
        for (const p of pills) if (p.textContent !== text) p.textContent = text;
      }
    }
  }

  let refreshTimer = null;
  const isOwn = (n) => n.nodeType === 1 && (n.hasAttribute(PILL) || n.hasAttribute(MARK));
  // The removal of one of our buttons (e.g. by a Vue re-render) is a page change: it must be put back.
  const isOwnButton = (n) => n.nodeType === 1 && n.tagName === 'BUTTON' && n.hasAttribute(MARK);
  const isOwnMutation = (m) => (badge && badge.contains(m.target)) || isOwn(m.target)
    || ([...m.addedNodes, ...m.removedNodes].every(isOwn) && ![...m.removedNodes].some(isOwnButton));

  // C411 is rendered by the server, then Vue "hydrates" it: nodes added before that are thrown away or
  // reused by Vue (buttons lost after a reload). page-hook.js flags <html> once hydration is over.
  function whenHydrated(start) {
    const t0 = Date.now();
    (function wait() {
      if (document.documentElement.hasAttribute('data-qbt-hydrated') || Date.now() - t0 > 15000) start();
      else setTimeout(wait, 100);
    })();
  }

  whenHydrated(() => {
    new MutationObserver((mutations) => {
      if (mutations.every(isOwnMutation)) return;
      inject();
      clearTimeout(refreshTimer);
      refreshTimer = setTimeout(() => { refreshStatus(); refreshListBadges(); }, 600);
    }).observe(document.documentElement, { childList: true, subtree: true });
    setInterval(() => { if (!document.hidden) refreshListBadges(); }, 30000);
    inject();
    refreshStatus();
    refreshListBadges();
  });
})();
