const DEFAULTS = {
  qbUrl: '', username: '', password: '', defaultCategory: '',
  radarrUrl: '', radarrKey: '', radarrRoot: '', radarrProfile: '', radarrCategory: '',
  sonarrUrl: '', sonarrKey: '', sonarrRoot: '', sonarrProfile: '', sonarrCategory: '',
  notifyEnabled: true, notifyAll: false, listBadges: true
};
const CHECK_FIELDS = ['notifyEnabled', 'notifyAll', 'listBadges'];
const TEXT_FIELDS = ['qbUrl', 'username', 'password', 'radarrUrl', 'radarrKey', 'sonarrUrl', 'sonarrKey'];
const SELECT_FIELDS = ['defaultCategory', 'radarrCategory', 'sonarrCategory', 'radarrProfile', 'radarrRoot', 'sonarrProfile', 'sonarrRoot'];
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
  for (const f of ['qbUrl', 'radarrUrl', 'sonarrUrl']) {
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
  for (const id of ['defaultCategory', 'radarrCategory', 'sonarrCategory']) fillSelect($(id), items, saved[id], '(aucune)');
  status(`qBittorrent connecté ✔ ${res.categories.length} catégorie(s).`, true);
}

async function testArr(service) {
  if (!(await save())) return;
  const name = service === 'radarr' ? 'Radarr' : 'Sonarr';
  status(`Connexion à ${name}…`, true);
  const res = await chrome.runtime.sendMessage({ type: 'arrMeta', service, cfg: saved });
  if (!res.ok) return status(res.error, false);
  fillSelect($(service + 'Profile'), res.profiles.map((p) => ({ value: String(p.id), label: p.name })), saved[service + 'Profile'] || String(res.profiles[0]?.id || ''));
  fillSelect($(service + 'Root'), res.roots.map((r) => ({ value: r, label: r })), saved[service + 'Root'] || res.roots[0] || '');
  saved = readForm();
  await chrome.storage.local.set(saved);
  status(`${name} connecté ✔ Profil et dossier racine enregistrés (modifiables ci-dessus).`, true);
}

(async () => {
  saved = await chrome.storage.local.get(DEFAULTS);
  for (const f of TEXT_FIELDS) $(f).value = saved[f];
  for (const f of ['defaultCategory', 'radarrCategory', 'sonarrCategory']) fillSelect($(f), [], saved[f], '(aucune)');
  for (const f of ['radarrProfile', 'radarrRoot', 'sonarrProfile', 'sonarrRoot']) fillSelect($(f), [], saved[f], '(cliquer sur Tester)');
  for (const f of CHECK_FIELDS) $(f).checked = saved[f];

  $('save').onclick = save;
  $('test').onclick = testQbit;
  for (const b of document.querySelectorAll('[data-load]')) b.onclick = () => testArr(b.dataset.load);
})();
