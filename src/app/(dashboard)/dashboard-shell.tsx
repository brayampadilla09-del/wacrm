"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { AuthProvider, useAuth } from "@/hooks/use-auth";
import { Sidebar } from "@/components/layout/sidebar";
import { Header } from "@/components/layout/header";
import { PresenceHeartbeat } from "@/components/presence/presence-heartbeat";

// Auth-gated dashboard shell. Extracted from the layout so the layout
// itself can stay a server component and export metadata (noindex) —
// client components can't export Next's metadata object.

function DashboardShellInner({ children }: { children: React.ReactNode }) {
  const { user, loading } = useAuth();
  const router = useRouter();

  // Sidebar drawer state — only used on mobile. On lg+ the sidebar is
  // always visible and this stays at `false` (ignored by the component).
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const closeSidebar = useCallback(() => setSidebarOpen(false), []);

  useEffect(() => {
    if (!loading && !user) {
      router.push("/login");
    }
  }, [user, loading, router]);

  if (loading) {
    return (
      <div className="flex h-screen items-center justify-center bg-background">
        <div className="flex flex-col items-center gap-3">
          <div className="h-8 w-8 animate-spin rounded-full border-2 border-primary border-t-transparent" />
          <p className="text-sm text-muted-foreground">Loading...</p>
        </div>
      </div>
    );
  }

  if (!user) return null;

  // h-dvh, not h-screen. On a phone browser `100vh` is the viewport
  // WITH the address bar hidden — taller than what's actually on
  // screen — so a `100vh` + `overflow-hidden` shell pushes its own
  // bottom edge underneath the browser chrome, and overflow-hidden
  // means you can't scroll down to reach it. That's what makes the
  // inbox composer (and any bottom-anchored control) unreachable on
  // mobile. `dvh` tracks the *visible* height and follows the bar as it
  // hides and shows. h-screen stays as the fallback for the rare browser
  // without dvh support; the later class wins where it does.
  return (
    <div className="flex h-screen h-dvh overflow-hidden bg-background">
      {/* Reports this tab's online/away presence once we know a user is
          signed in. Headless — renders nothing. */}
      <PresenceHeartbeat />
      <Sidebar open={sidebarOpen} onClose={closeSidebar} />
      <div className="flex flex-1 flex-col overflow-hidden">
        <Header onOpenSidebar={() => setSidebarOpen(true)} />
        {/* Thinner horizontal padding on mobile so cards have room to breathe.
            pb-safe-3 keeps that 1rem bottom padding everywhere except a
            phone with a gesture bar, where it grows so the last card
            isn't half-hidden behind the home indicator. The inbox opts
            out of this padding entirely (it negates it with -m-4) and
            handles its own bottom inset in the composer. */}
        <main className="flex-1 overflow-y-auto p-4 pb-safe-4 sm:p-6 sm:pb-safe-6">
          {children}
        </main>
      </div>
    </div>
  );
}

export function DashboardShell({ children }: { children: React.ReactNode }) {
  return (
    <AuthProvider>
      <DashboardShellInner>{children}</DashboardShellInner>
    </AuthProvider>
  );
}
