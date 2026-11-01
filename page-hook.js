// Runs in the page context (MAIN world, document_start).
(() => {
  // Delays blob URL revocation so the extension can still read the .torrent blob after the site
  // triggers the download.
  const originalRevoke = URL.revokeObjectURL.bind(URL);
  URL.revokeObjectURL = (url) => setTimeout(() => originalRevoke(url), 120000);

  // C411 (Nuxt) is rendered by the server, then hydrated by Vue, which drops or reuses any node added
  // before it is done. Flag <html> once hydration is over: content.js waits for it.
  const t0 = Date.now();
  (function check() {
    const root = document.getElementById('__nuxt');
    const app = root && root.__vue_app__;
    const nuxt = app && app.$nuxt;
    const done = app ? !nuxt || nuxt.isHydrating === false : !root && document.readyState !== 'loading';
    if (done || Date.now() - t0 > 15000) document.documentElement.setAttribute('data-qbt-hydrated', '1');
    else setTimeout(check, 100);
  })();
})();