import { useCallback, useEffect, useState } from "react";
import Session from "supertokens-auth-react/recipe/session";
import { LogOut } from "lucide-react";

import { AuthScreen } from "@/features/auth-screen";
import { ChatPanel } from "@/features/chat-panel";
import { ImportPanel } from "@/features/import-panel";
import { Button } from "@/components/ui/button";

type AuthState = "loading" | "authed" | "unauthed";

/**
 * Top-level app. Gates on `Session.doesSessionExist()`:
 *   - unauthenticated → the email/password auth screen
 *   - authenticated → the main app (header + CSV import + chat)
 *
 * We re-check the session after the auth form reports success and after
 * sign-out so the gate flips without a full reload.
 */
export default function App() {
  const [authState, setAuthState] = useState<AuthState>("loading");

  const refreshSession = useCallback(async () => {
    try {
      const exists = await Session.doesSessionExist();
      setAuthState(exists ? "authed" : "unauthed");
    } catch {
      setAuthState("unauthed");
    }
  }, []);

  useEffect(() => {
    void refreshSession();
  }, [refreshSession]);

  if (authState === "loading") {
    return (
      <div className="flex min-h-screen items-center justify-center text-sm text-muted-foreground">
        Loading…
      </div>
    );
  }

  if (authState === "unauthed") {
    return <AuthScreen onAuthenticated={() => void refreshSession()} />;
  }

  return (
    <div className="flex h-screen flex-col">
      <header className="flex items-center justify-between border-b px-4 py-3">
        <span className="text-lg font-semibold">WalletWise</span>
        <Button
          variant="outline"
          size="sm"
          onClick={async () => {
            await Session.signOut();
            await refreshSession();
          }}
        >
          <LogOut className="h-4 w-4" /> Sign out
        </Button>
      </header>

      <main className="mx-auto flex w-full max-w-2xl flex-1 flex-col gap-4 overflow-hidden p-4">
        <ImportPanel />
        <div className="flex min-h-0 flex-1 flex-col rounded-lg border bg-card p-4">
          <ChatPanel />
        </div>
      </main>
    </div>
  );
}
