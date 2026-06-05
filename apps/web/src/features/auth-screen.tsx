import { useState } from "react";
import EmailPassword from "supertokens-auth-react/recipe/emailpassword";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";

interface AuthScreenProps {
  /** Called after a successful sign-in / sign-up so the app can re-gate. */
  onAuthenticated: () => void;
}

type Mode = "signin" | "signup";

/**
 * Minimal custom EmailPassword auth form. Uses the SuperTokens functional API
 * (`signIn` / `signUp`) rather than the prebuilt routed UI so we don't pull in
 * a router for a single screen. On `status: "OK"` the session cookie is set by
 * the backend and we call `onAuthenticated` to flip the app into its main view.
 */
export function AuthScreen({ onAuthenticated }: AuthScreenProps) {
  const [mode, setMode] = useState<Mode>("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const formFields = [
        { id: "email", value: email },
        { id: "password", value: password },
      ];
      const res =
        mode === "signin"
          ? await EmailPassword.signIn({ formFields })
          : await EmailPassword.signUp({ formFields });

      if (res.status === "OK") {
        onAuthenticated();
        return;
      }

      if (res.status === "FIELD_ERROR") {
        setError(res.formFields.map((f) => f.error).join(" "));
      } else if (res.status === "WRONG_CREDENTIALS_ERROR") {
        setError("Incorrect email or password.");
      } else {
        setError("Unable to authenticate. Please try again.");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-muted/40 p-4">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle>WalletWise</CardTitle>
          <p className="text-sm text-muted-foreground">
            {mode === "signin" ? "Sign in to your account" : "Create an account"}
          </p>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="flex flex-col gap-3">
            <Input
              type="email"
              placeholder="you@example.com"
              autoComplete="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
            />
            <Input
              type="password"
              placeholder="Password"
              autoComplete={mode === "signin" ? "current-password" : "new-password"}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
            />
            {error ? (
              <p className="text-sm text-destructive">{error}</p>
            ) : null}
            <Button type="submit" disabled={submitting}>
              {submitting
                ? "Please wait…"
                : mode === "signin"
                  ? "Sign in"
                  : "Sign up"}
            </Button>
          </form>
          <button
            type="button"
            className="mt-4 text-sm text-muted-foreground underline-offset-4 hover:underline"
            onClick={() => {
              setError(null);
              setMode((m) => (m === "signin" ? "signup" : "signin"));
            }}
          >
            {mode === "signin"
              ? "Need an account? Sign up"
              : "Already have an account? Sign in"}
          </button>
        </CardContent>
      </Card>
    </div>
  );
}
