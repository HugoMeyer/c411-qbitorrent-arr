<p align="center">
  <img src="icon128.png" width="96" alt="C411 → qBittorrent logo">
</p>

<h1 align="center">C411 → qBittorrent</h1>

<p align="center">
  A Chrome extension that sends torrents from <b>C411</b> straight to your <b>qBittorrent</b> WebUI, with a category you choose,
  and can add the movie or series to <b>Radarr</b> / <b>Sonarr</b> automatically.
</p>

<p align="center">
  <img alt="Manifest V3" src="https://img.shields.io/badge/Manifest-V3-4285F4?logo=googlechrome&logoColor=white">
  <img alt="qBittorrent" src="https://img.shields.io/badge/qBittorrent-WebUI%20API%20v2-2F67BA?logo=qbittorrent&logoColor=white">
  <img alt="Radarr" src="https://img.shields.io/badge/Radarr-v3%2B-FFC230">
  <img alt="Sonarr" src="https://img.shields.io/badge/Sonarr-v3%2B-35C5F4">
</p>

---

## ✨ Features

### One-click sending
- **qBittorrent button** next to C411's own **Télécharger** button on torrent pages.
- **qBittorrent button in result lists**, at the end of each row, after the download icon. Columns stay aligned.
- **Category picker** before every send. It lists your qBittorrent categories and remembers the last one you used.
- **Add paused** option.
- Handles C411's **"Téléchargement normal"** prompt automatically when it appears.

### Radarr / Sonarr integration
- Detects **IMDb, TMDB and TheTVDB** IDs from the torrent page's *Fiches* section.
- **Add to Radarr (movie) or Sonarr (series)** from the same dialog.
- **Root folder picker**, handy if you keep anime and series in separate folders.
- **Series type** (Standard, Anime, Daily), set to *Anime* automatically when the folder name contains "anim".
- **Per-service default category**, e.g. `radarr` or `tv-sonarr`.
- 🛡️ **Never monitored.** Items are added **unmonitored, with no automatic search**. Radarr and Sonarr never download anything on their own. C411 stays your only source.

### Status at a glance
- **Duplicate warning** if the torrent is already in qBittorrent.
- **Status badge** on torrent pages showing qBittorrent progress and whether the title is already in Radarr or Sonarr.
- **List badges** (`✔ qBit` / `⇩ 42 %`) on search results and notifications for torrents you already have.

### Toolbar popup and notifications
- **Popup** listing active and recently completed torrents, with pause and resume.
- **Desktop notifications** when a download completes.

---

## 📦 Installation

The extension is not on the Chrome Web Store. Load it unpacked:

1. Download or clone this repository, and keep the folder somewhere permanent.
2. Open `chrome://extensions`.
3. Enable **Developer mode** (top-right toggle).
4. Click **Load unpacked** and select the extension folder (the one containing `manifest.json`).
5. Pin the extension to your toolbar if you like.

> Works in Chrome and any Chromium-based browser (Edge, Brave, Vivaldi…).

---

## ⚙️ Configuration

Right-click the extension icon and choose **Options**.

| Section | Settings |
|---|---|
| **qBittorrent** | WebUI URL, username, password, default category → **Test** |
| **Radarr** *(optional)* | URL, API key, quality profile, default root folder, qBittorrent category → **Test** |
| **Sonarr** *(optional)* | URL, API key, quality profile, default root folder, qBittorrent category → **Test** |
| **Display** | List badges, completion notifications |

- API keys are under **Settings → General → Security** in Radarr and Sonarr.
- When you save, Chrome asks for permission to reach your servers. Accept it.
- Credentials and API keys are stored **locally** in your browser (`chrome.storage.local`). They are never sent anywhere other than your own servers.

---

## 🚀 Usage

1. Open a torrent page on C411, or a results list.
2. Click **qBittorrent**.
3. Choose:
   - **Add to:** Radarr, Sonarr, or nothing *(torrent page only)*
   - **Root folder** and **series type** *(when adding to Sonarr or Radarr)*
   - **qBittorrent category**
   - **Add paused** *(optional)*
4. Click **Envoyer**. A toast confirms that the torrent was sent and that the title was added.

> Radarr and Sonarr can only be used from the torrent page, because C411 doesn't show the IMDb, TMDB or TheTVDB IDs in result lists.

---

## 🔧 How it works

```
C411 page ──click──▶ content script ──"arm"──▶ service worker
                                              │
   native "Télécharger" is clicked ◀──────────┘
                                              │
   chrome.downloads intercepts & cancels the .torrent download
                                              │
   the .torrent is fetched and validated ─────▶ Radarr/Sonarr API (add, unmonitored)
                                              ▶ qBittorrent API (/api/v2/torrents/add)
```

- The extension reuses C411's own download flow, so it doesn't need your C411 credentials or passkey.
- The torrent infohash is computed locally (bencode + SHA-1) to track progress and send notifications.
- A `declarativeNetRequest` rule sets the `Origin` and `Referer` headers, so qBittorrent's CSRF protection accepts the requests.

---

## 🔐 Permissions

| Permission | Why |
|---|---|
| `downloads` | Intercept the `.torrent` download triggered on C411 |
| `storage` | Save your settings locally |
| `declarativeNetRequestWithHostAccess` | Set the Origin and Referer headers for the qBittorrent API |
| `notifications`, `alarms` | Notify you when downloads complete |
| `c411.org` | Inject the buttons and badges |
| Optional host access | Only for the qBittorrent, Radarr and Sonarr URLs you enter |

---

## 🩹 Troubleshooting

| Problem | Fix |
|---|---|
| "Extension mise à jour : recharge la page (F5)" | You reloaded the extension. Refresh the C411 tab. |
| Stuck on "Chargement des catégories…" | Check the qBittorrent URL and credentials in Options, then click **Test**. |
| `Connexion qBittorrent refusée` | Wrong credentials, or the WebUI blocks the IP after failed logins. |
| "Aucun téléchargement détecté" | C411 didn't start a download within 20 s. Try again. |
| Radarr or Sonarr is greyed out in the dialog | The service isn't configured, or the page has no *Fiches* IDs. |

After editing files, click **↻** on the extension in `chrome://extensions`, then refresh C411.

---

## 📁 Project structure

```
manifest.json   MV3 manifest
background.js   Service worker: qBittorrent and *arr APIs, download interception, notifications
content.js      C411 integration: buttons, dialog, badges
page-hook.js    Main-world hook that keeps blob URLs alive long enough to fetch them
options.html/js Settings page
popup.html/js   Toolbar popup (torrent list, pause and resume)
icon*.png       Icons
```

---

## ⚠️ Disclaimer

This is an unofficial, personal project. It is not affiliated with C411, qBittorrent, Radarr or Sonarr. Use it in line with your tracker's rules and the laws of your country.
