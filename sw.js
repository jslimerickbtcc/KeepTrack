// KeepTrack service worker — passthrough during development.
// We'll add real offline caching back in Phase 4.
// Bumping CACHE_NAME purges any old cached shell from earlier versions.
const CACHE_NAME = "keeptrack-shell-v2";

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(keys.map((k) => caches.delete(k)));
      await self.clients.claim();
    })(),
  );
});

// No fetch handler — let the browser hit the network normally.
