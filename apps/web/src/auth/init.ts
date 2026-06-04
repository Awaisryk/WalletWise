import SuperTokens from "supertokens-auth-react";
import EmailPassword from "supertokens-auth-react/recipe/emailpassword";
import Session from "supertokens-auth-react/recipe/session";

/**
 * Initialise the SuperTokens frontend SDK (EmailPassword + Session).
 *
 * `apiDomain` is `window.location.origin` — the Vite dev server proxies
 * `/auth/*` to the API (port 4000), so auth requests stay same-origin and the
 * session cookie flows automatically. `apiBasePath` / `websiteBasePath` match
 * the backend (`apps/api/src/auth/supertokens.init.ts`, both `/auth`) and the
 * app name matches the backend `appInfo.appName`.
 *
 * Must be called once, before React renders (see `src/main.tsx`).
 */
export function initSuperTokens(): void {
  SuperTokens.init({
    appInfo: {
      appName: "WalletWise",
      apiDomain: window.location.origin,
      websiteDomain: window.location.origin,
      apiBasePath: "/auth",
      websiteBasePath: "/auth",
    },
    recipeList: [EmailPassword.init(), Session.init()],
  });
}
