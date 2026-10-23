// Runs in the page context: delays blob URL revocation so the extension
// can still read the .torrent blob after the site triggers the download.
(() => {
  const originalRevoke = URL.revokeObjectURL.bind(URL);
  URL.revokeObjectURL = (url) => setTimeout(() => originalRevoke(url), 120000);
})();
