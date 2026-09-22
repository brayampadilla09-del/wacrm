// ============================================================
// Service worker — exists for three reasons, and does nothing
// beyond them on purpose.
//
//   1. Installability. Chrome/Android (and desktop Chrome) will
//      not fire the "Add to Home Screen" / install prompt for a
//      PWA unless a service worker is registered with a `fetch`
//      handler — a manifest alone isn't enough there (unlike iOS
//      Safari, which needs no service worker at all). This file
//      is the minimum that satisfies that check.
//
//   2. A real "you're offline" screen instead of the browser's
//      default dinosaur/no-connection page when someone opens the
//      installed app with no signal.
//
//   3. Web Push (migration 043) — showing the OS notification when
//      a push arrives, and routing a tap on it back into the app.
//      This is the only part of the file that runs with the app
//      fully closed.
//
// It deliberately does NOT cache API responses, RSC payloads, or
// page HTML. This is a live-data CRM — an inbox message list, a
// contact record, or a pipeline board served from a stale cache
// is actively misleading, not a convenience. Every request that
// isn't the offline fallback itself goes straight to the network,
// every time. The only things ever cached are the offline page
// and its icon, both static and versioned by CACHE_NAME below.
// ============================================================

const CACHE_NAME = "wacrm-shell-v1";
const OFFLINE_URL = "/offline.html";

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) => cache.addAll([OFFLINE_URL, "/icon-192.png"]))
      // Take over from any previous service worker on next load
      // rather than waiting for every open tab to close — this is a
      // frequently-deployed app, and a stuck old worker would mean
      // "offline" never gets the current fallback page.
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((key) => key !== CACHE_NAME)
            .map((key) => caches.delete(key)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  // Only ever intervene for page navigations (someone opening or
  // reloading a URL). Every other request — API calls, JS/CSS
  // chunks, images, the Supabase realtime socket — passes straight
  // through unhandled, exactly as if this service worker did not
  // exist.
  if (event.request.mode !== "navigate") return;

  event.respondWith(
    fetch(event.request).catch(() => caches.match(OFFLINE_URL)),
  );
});

// ============================================================
// Web Push
// ============================================================

self.addEventListener("push", (event) => {
  let payload = { title: "wacrm", body: "" };
  try {
    if (event.data) payload = event.data.json();
  } catch {
    // A non-JSON push body would otherwise throw and drop the
    // notification entirely — fall back to a generic one instead.
  }

  event.waitUntil(
    self.registration.showNotification(payload.title || "wacrm", {
      body: payload.body,
      icon: "/icon-192.png",
      badge: "/icon-192.png",
      data: { url: payload.url || "/" },
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = event.notification.data?.url || "/";

  event.waitUntil(
    self.clients
      .matchAll({ type: "window", includeUncontrolled: true })
      .then((clients) => {
        // Reuse an already-open tab instead of opening a new one —
        // most people leave wacrm open in the background.
        for (const client of clients) {
          if ("focus" in client) {
            client.navigate(url);
            return client.focus();
          }
        }
        return self.clients.openWindow(url);
      }),
  );
});
