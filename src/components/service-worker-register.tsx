"use client";

import { useEffect } from "react";

/**
 * Registers `public/sw.js`. Has to be a client component — there is
 * no server-side equivalent of `navigator.serviceWorker`.
 *
 * Renders nothing; mounted once from the root layout so it fires on
 * every page, same as ThemedToaster next to it.
 */
export function ServiceWorkerRegister() {
  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;

    // Registration can fail in perfectly normal situations — Safari
    // in a private tab, an extension blocking it, running over plain
    // HTTP in some dev setups — none of which should be user-facing.
    // The app works identically without it; only the install prompt
    // and the offline fallback page are unavailable.
    navigator.serviceWorker.register("/sw.js").catch(() => {});
  }, []);

  return null;
}
