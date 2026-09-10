"use client";

// ============================================================
// /reset-password — where the emailed link actually lands.
//
// This page did not exist either. Between it and /auth/callback,
// password recovery is now a closed loop: request → email →
// callback exchanges the link for a session → this form sets the
// new password.
//
// Reaching this page already means the user is authenticated:
// /auth/callback traded their link for a real session before
// redirecting here. That session is what authorises the
// `updateUser` call below — there is no "old password" field
// because possession of the emailed link is the proof.
//
// Which is exactly why the no-session case has to be handled
// loudly rather than showing an empty form: without a session
// `updateUser` fails, and a form that looks fine but can never
// submit is worse than an honest error.
// ============================================================

import Image from "next/image";
import { Suspense, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { ArrowLeft, CheckCircle } from "lucide-react";

/** Supabase rejects anything shorter server-side; mirror it here so the
 *  user finds out while typing instead of after a round trip. */
const MIN_PASSWORD_LENGTH = 6;

function AuthFrame({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-6 bg-navy px-4 py-10">
      {/* Signing in is where the brand should be loudest: the site puts
          its auth screens on a full navy ground with the mark reversed
          out in white (see AuthShell in pagina-estudio). The logo file
          is a dark stroke on transparent, hence brightness-0 + invert. */}
      <Image
        src="/bsign-logo.png"
        alt="BSign Estudio"
        width={696}
        height={480}
        priority
        className="h-16 w-auto brightness-0 invert"
      />
      {children}
    </div>
  );
}

function ResetPasswordForm() {
  const router = useRouter();
  const supabase = createClient();

  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [success, setSuccess] = useState(false);
  // null = still checking. Rendering the form before this settles would
  // flash a usable-looking form at someone whose link has expired.
  const [hasSession, setHasSession] = useState<boolean | null>(null);

  useEffect(() => {
    let active = true;

    // Two ways a session can show up here, and both have to be watched:
    //
    //   - It is already set, because /auth/callback exchanged the code
    //     server-side and wrote the cookies before redirecting. This is
    //     the normal path.
    //   - It arrives client-side, because the project runs the implicit
    //     flow and Supabase put the tokens in the URL fragment. The
    //     fragment never reaches the server, so the browser client is
    //     the only thing that can pick it up; it fires
    //     PASSWORD_RECOVERY once it has parsed the hash.
    const { data: sub } = supabase.auth.onAuthStateChange((event, session) => {
      if (!active) return;
      if (session) setHasSession(true);
      else if (event === "SIGNED_OUT") setHasSession(false);
    });

    supabase.auth.getSession().then(({ data }) => {
      if (!active) return;
      setHasSession((prev) => prev ?? !!data.session);
    });

    return () => {
      active = false;
      sub.subscription.unsubscribe();
    };
  }, [supabase]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    if (password.length < MIN_PASSWORD_LENGTH) {
      setError(`Password must be at least ${MIN_PASSWORD_LENGTH} characters`);
      return;
    }
    if (password !== confirmPassword) {
      setError("Passwords do not match");
      return;
    }

    setLoading(true);
    const { error: updateError } = await supabase.auth.updateUser({ password });

    if (updateError) {
      setError(updateError.message);
      setLoading(false);
      return;
    }

    setSuccess(true);
    setLoading(false);
    // The recovery session is a real session, so the user is already
    // signed in — send them straight into the app rather than making
    // them retype the password they just chose.
    router.refresh();
    setTimeout(() => router.push("/dashboard"), 1200);
  };

  if (hasSession === null) {
    return (
      <AuthFrame>
        <Card className="w-full max-w-md border-border bg-card">
          <CardContent className="flex items-center justify-center gap-3 py-10">
            <div className="h-5 w-5 animate-spin rounded-full border-2 border-primary border-t-transparent" />
            <span className="text-sm text-muted-foreground">
              Verifying your link...
            </span>
          </CardContent>
        </Card>
      </AuthFrame>
    );
  }

  if (hasSession === false) {
    return (
      <AuthFrame>
        <Card className="w-full max-w-md border-border bg-card">
          <CardHeader className="justify-items-center text-center">
            <CardTitle className="text-xl text-foreground">
              This link is no longer valid
            </CardTitle>
            <CardDescription className="text-muted-foreground">
              Password reset links expire, and each one can only be used
              once. Request a new one to continue.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            <Link href="/forgot-password">
              <Button className="w-full">Request a new link</Button>
            </Link>
            <Link
              href="/login"
              className="flex items-center justify-center gap-2 text-sm text-muted-foreground hover:text-foreground"
            >
              <ArrowLeft className="h-4 w-4" />
              Back to sign in
            </Link>
          </CardContent>
        </Card>
      </AuthFrame>
    );
  }

  if (success) {
    return (
      <AuthFrame>
        <Card className="w-full max-w-md border-border bg-card">
          <CardHeader className="justify-items-center text-center">
            <div className="mb-2 flex h-12 w-12 items-center justify-center rounded-pill bg-primary/10">
              <CheckCircle className="h-6 w-6 text-primary" />
            </div>
            <CardTitle className="text-xl text-foreground">
              Password updated
            </CardTitle>
            <CardDescription className="text-muted-foreground">
              You&apos;re signed in. Taking you to your dashboard...
            </CardDescription>
          </CardHeader>
        </Card>
      </AuthFrame>
    );
  }

  return (
    <AuthFrame>
      <Card className="w-full max-w-md border-border bg-card">
        <CardHeader className="justify-items-center text-center">
          <CardTitle className="text-xl text-foreground">
            Choose a new password
          </CardTitle>
          <CardDescription className="text-muted-foreground">
            Pick something you haven&apos;t used here before
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="flex flex-col gap-4">
            {error && (
              <div className="rounded-lg border border-red-500/20 bg-red-500/10 px-4 py-3 text-sm text-red-400">
                {error}
              </div>
            )}

            <div className="flex flex-col gap-2">
              <Label htmlFor="password" className="text-muted-foreground">
                New password
              </Label>
              <Input
                id="password"
                type="password"
                autoComplete="new-password"
                placeholder={`At least ${MIN_PASSWORD_LENGTH} characters`}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                className="border-border bg-card text-foreground placeholder:text-muted-foreground focus-visible:border-primary focus-visible:ring-primary/15"
              />
            </div>

            <div className="flex flex-col gap-2">
              <Label htmlFor="confirmPassword" className="text-muted-foreground">
                Confirm password
              </Label>
              <Input
                id="confirmPassword"
                type="password"
                autoComplete="new-password"
                placeholder="Repeat your password"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                required
                className="border-border bg-card text-foreground placeholder:text-muted-foreground focus-visible:border-primary focus-visible:ring-primary/15"
              />
            </div>

            <Button
              type="submit"
              disabled={loading}
              className="mt-2 h-10 w-full bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
            >
              {loading ? "Updating..." : "Update password"}
            </Button>
          </form>
        </CardContent>
      </Card>
    </AuthFrame>
  );
}

export default function ResetPasswordPage() {
  return (
    <Suspense fallback={null}>
      <ResetPasswordForm />
    </Suspense>
  );
}
