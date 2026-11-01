const DEFAULTS = {
  qbUrl: '', username: '', password: '', defaultCategory: '',
  radarrUrl: '', radarrKey: '', radarrRoot: '', radarrProfile: '', radarrCategory: '',
  sonarrUrl: '', sonarrKey: '', sonarrRoot: '', sonarrProfile: '', sonarrCategory: '',
  lidarrUrl: '', lidarrKey: '', lidarrRoot: '', lidarrProfile: '', lidarrMetaProfile: '', lidarrCategory: 'lidarr',
  notifyEnabled: true, notifyAll: false, listBadges: true
};
const CHECK_FIELDS = ['notifyEnabled', 'notifyAll', 'listBadges'];
const TEXT_FIELDS = ['qbUrl', 'username', 'password', 'radarrUrl', 'radarrKey', 'sonarrUrl', 'sonarrKey', 'lidarrUrl', 'lidarrKey'];
const CAT_FIELDS = ['defaultCategory', 'radarrCategory', 'sonarrCategory', 'lidarrCategory'];
const ARR_FIELDS = ['radarrProfile', 'radarrRoot', 'sonarrProfile', 'sonarrRoot', 'lidarrProfile', 'lidarrMetaProfile', 'lidarrRoot'];
const SELECT_FIELDS = [...CAT_FIELDS, ...ARR_FIELDS];
const ARR_NAMES = { radarr: 'Radarr', sonarr: 'Sonarr', lidarr: 'Lidarr' };
const $ = (id) => document.getElementById(id);
let saved = {};

function status(text, ok) {
  $('status').textContent = text;
  $('status').className = ok ? 'ok' : 'err';
}

function fillSelect(sel, items, selected, emptyLabel) {
  sel.innerHTML = '';
  if (emptyLabel) sel.add(new Option(emptyLabel, ''));
  for (const { value, label } of items) sel.add(new Option(label, value));
  if (selected && ![...sel.options].some((o) => o.value === String(selected))) sel.add(new Option(String(selected), selected));
  sel.value = selected || '';
}

function readForm() {
  const cfg = {};
  for (const f of TEXT_FIELDS) {
    const v = f === 'password' ? $(f).value : $(f).value.trim();
    cfg[f] = f.endsWith('Url') ? v.replace(/\/+$/, '') : v;
  }
  for (const f of SELECT_FIELDS) cfg[f] = $(f).value;
  for (const f of CHECK_FIELDS) cfg[f] = $(f).checked;
  cfg.qbUrl = cfg.qbUrl || DEFAULTS.qbUrl;
  return cfg;
}

async function save() {
  const cfg = readForm();
  const origins = [];
  for (const f of ['qbUrl', 'radarrUrl', 'sonarrUrl', 'lidarrUrl']) {
    if (!cfg[f]) continue;
    try { origins.push(new URL(cfg[f]).origin + '/*'); } catch { status(`URL invalide : ${cfg[f]}`, false); return false; }
  }
  if (!(await chrome.permissions.request({ origins }))) { status('Permission refusée', false); return false; }
  await chrome.storage.local.set(cfg);
  saved = cfg;
  status('Enregistré ✔', true);
  return true;
}

async function testQbit() {
  if (!(await save())) return;
  status('Connexion à qBittorrent…', true);
  const res = await chrome.runtime.sendMessage({ type: 'getCategories' });
  if (!res.ok) return status(res.error, false);
  const items = res.categories.map((c) => ({ value: c, label: c }));
  for (const id of CAT_FIELDS) fillSelect($(id), items, saved[id], '(aucune)');
  status(`qBittorrent connecté ✔ ${res.categories.length} catégorie(s).`, true);
}

async function testArr(service) {
  if (!(await save())) return;
  const name = ARR_NAMES[service];
  status(`Connexion à ${name}…`, true);
  const res = await chrome.runtime.sendMessage({ type: 'arrMeta', service, cfg: saved });
  if (!res.ok) return status(res.error, false);
  fillSelect($(service + 'Profile'), res.profiles.map((p) => ({ value: String(p.id), label: p.name })), saved[service + 'Profile'] || String(res.profiles[0]?.id || ''));
  fillSelect($(service + 'Root'), res.roots.map((r) => ({ value: r, label: r })), saved[service + 'Root'] || res.roots[0] || '');
  if (res.metaProfiles) {
    // "None" keeps only the albums added by hand (from C411): a real profile is the safer default.
    const def = res.metaProfiles.find((p) => p.name !== 'None') || res.metaProfiles[0];
    fillSelect($(service + 'MetaProfile'), res.metaProfiles.map((p) => ({
      value: String(p.id), label: p.name === 'None' ? 'None (seulement les albums ajoutés)' : p.name
    })), saved[service + 'MetaProfile'] || String(def ? def.id : ''));
  }
  saved = readForm();
  await chrome.storage.local.set(saved);
  status(`${name} connecté ✔ Profil${res.metaProfiles ? 's' : ''} et dossier racine enregistrés (modifiables ci-dessus).`, true);
}

(async () => {
  saved = await chrome.storage.local.get(DEFAULTS);
  for (const f of TEXT_FIELDS) $(f).value = saved[f];
  for (const f of CAT_FIELDS) fillSelect($(f), [], saved[f], '(aucune)');
  for (const f of ARR_FIELDS) fillSelect($(f), [], saved[f], '(cliquer sur Tester)');
  for (const f of CHECK_FIELDS) $(f).checked = saved[f];

  $('save').onclick = save;
  $('test').onclick = testQbit;
  for (const b of document.querySelectorAll('[data-load]')) b.onclick = () => testArr(b.dataset.load);
})();
