import type { MetadataRoute } from "next";

// Makes the CRM installable as a standalone app on a phone's home
// screen ("Add to Home Screen" on iOS, the install prompt on Android
// Chrome / desktop Chrome). Next.js serves whatever this returns at
// /manifest.webmanifest and wires up the <link rel="manifest"> tag
// automatically — no extra config in layout.tsx needed.
//
// Two things besides this file are required for the install prompt to
// actually fire on Android/desktop Chrome (iOS Safari has no such
// requirement — the manifest + apple-touch-icon meta tag in
// layout.tsx are enough there):
//   1. Served over HTTPS (or localhost for dev).
//   2. A registered service worker with a fetch handler — see
//      public/sw.js and the registration in layout.tsx.
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "wacrm",
    short_name: "wacrm",
    description: "WhatsApp CRM — inbox, contacts, pipelines, broadcasts and automations.",
    // Every screen already renders as a route under /dashboard once
    // signed in; the middleware bounces a signed-out visitor to
    // /login on its own, so start_url can point straight at the app
    // shell instead of needing its own redirect logic.
    start_url: "/dashboard",
    // "standalone" is what actually gets the browser chrome (address
    // bar, tab strip) out of the way — the whole point of installing
    // this as an app rather than bookmarking the page.
    display: "standalone",
    // Matches --background in light mode (globals.css) — this is what
    // paints behind the content before the page's own CSS loads, and
    // what iOS shows for a beat during the launch-icon-to-app
    // transition. Kept in sync with the `theme-color` meta tag in
    // layout.tsx, which is the same value for the same reason.
    background_color: "#fbf9f4",
    // The BSign navy — matches the icons' own background, so the
    // install-prompt card and the OS task switcher chrome (Android)
    // don't clash with the icon sitting inside them.
    theme_color: "#121643",
    orientation: "any",
    icons: [
      {
        src: "/icon-192.png",
        sizes: "192x192",
        type: "image/png",
        purpose: "any",
      },
      {
        src: "/icon-512.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "any",
      },
      {
        // Separate from the two above on purpose: a maskable icon is
        // cropped to a circle/squircle/rounded-square at the OS's
        // discretion, so it needs its own asset with the mark padded
        // well inside the safe zone. Reusing icon-512 here would let
        // Android's masking clip the BSign mark's outer curve.
        src: "/icon-512-maskable.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "maskable",
      },
    ],
  };
}
