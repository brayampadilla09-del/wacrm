"use client";

import Image from "next/image";
import { Suspense, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
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
import { CheckCircle, ArrowLeft } from "lucide-react";

function ForgotPasswordForm() {
  const searchParams = useSearchParams();
  const [email, setEmail] = useState("");
  // A link that expired, was already used, or lost its verifier lands
  // back here via /auth/callback carrying the reason. Seeding the error
  // state from the query string surfaces it on first paint, so
  // "nothing happened" becomes "request a new one" — and the first
  // submit clears it like any other error.
  const [error, setError] = useState<string | null>(() =>
    searchParams.get("error"),
  );
  const [loading, setLoading] = useState(false);
  const [success, setSuccess] = useState(false);
  const supabase = createClient();

  const handleReset = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setLoading(true);

    const { error } = await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: `${window.location.origin}/auth/callback?next=/reset-password`,
    });

    if (error) {
      setError(error.message);
      setLoading(false);
      return;
    }

    setSuccess(true);
    setLoading(false);
  };

  if (success) {
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
        <Card className="w-full max-w-md border-border bg-card">
          <CardHeader className="justify-items-center text-center">
            <div className="mb-2 flex h-12 w-12 items-center justify-center rounded-pill bg-primary/10">
              <CheckCircle className="h-6 w-6 text-primary" />
            </div>
            <CardTitle className="text-xl text-foreground">
              Check your email
            </CardTitle>
            <CardDescription className="text-muted-foreground">
              We&apos;ve sent a password reset link to{" "}
              <span className="text-foreground">{email}</span>. Please check your
              inbox.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Link href="/login">
              <Button
                variant="outline"
                className="w-full border-border text-muted-foreground hover:bg-muted hover:text-foreground"
              >
                Back to sign in
              </Button>
            </Link>
          </CardContent>
        </Card>
      </div>
    );
  }

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
      <Card className="w-full max-w-md border-border bg-card">
        <CardHeader className="justify-items-center text-center">
          <CardTitle className="text-xl text-foreground">Reset password</CardTitle>
          <CardDescription className="text-muted-foreground">
            Enter your email and we&apos;ll send you a reset link
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleReset} className="flex flex-col gap-4">
            {error && (
              <div className="rounded-lg border border-red-500/20 bg-red-500/10 px-4 py-3 text-sm text-red-400">
                {error}
              </div>
            )}

            <div className="flex flex-col gap-2">
              <Label htmlFor="email" className="text-muted-foreground">
                Email
              </Label>
              <Input
                id="email"
                type="email"
                placeholder="you@example.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                className="border-border bg-card text-foreground placeholder:text-muted-foreground focus-visible:border-primary focus-visible:ring-primary/15"
              />
            </div>

            <Button
              type="submit"
              disabled={loading}
              className="mt-2 h-10 w-full bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
            >
              {loading ? "Sending..." : "Send reset link"}
            </Button>
          </form>

          <Link
            href="/login"
            className="mt-6 flex items-center justify-center gap-2 text-sm text-muted-foreground hover:text-foreground"
          >
            <ArrowLeft className="h-4 w-4" />
            Back to sign in
          </Link>
        </CardContent>
      </Card>
    </div>
  );
}

export default function ForgotPasswordPage() {
  return (
    <Suspense fallback={null}>
      <ForgotPasswordForm />
    </Suspense>
  );
}
