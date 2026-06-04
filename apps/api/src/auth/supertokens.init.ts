import supertokens from 'supertokens-node';
import Session from 'supertokens-node/recipe/session';
import EmailPassword from 'supertokens-node/recipe/emailpassword';
import type { ApiEnv } from '@walletwise/config';
import type { PrismaClient } from '@prisma/client';

let initialized = false;

/**
 * Initialise SuperTokens with the EmailPassword + Session recipes.
 *
 * On a successful sign-up we upsert a `User` row keyed by `authId` (the
 * SuperTokens user id) so our app has an internal `User.id` to hang owned
 * rows off. The override accepts a `PrismaClient` so it can write to our
 * schema; this is a separate, transient client from the long-lived
 * `PrismaService` inside Nest (see `main.ts`).
 *
 * Idempotent: a no-op after the first call (SuperTokens itself throws on a
 * double init).
 *
 * `apiDomain` is derived from `PORT` because WalletWise has no dedicated
 * `API_DOMAIN` env var (see spec §11); in dev the API is reached at
 * `http://localhost:<PORT>`.
 */
export function initSuperTokens(env: ApiEnv, prisma: PrismaClient): void {
  if (initialized) return;
  initialized = true;

  supertokens.init({
    framework: 'fastify',
    supertokens: {
      connectionURI: env.SUPERTOKENS_CORE_URL,
      apiKey: env.SUPERTOKENS_API_KEY || undefined,
    },
    appInfo: {
      appName: 'WalletWise',
      apiDomain: `http://localhost:${env.PORT}`,
      websiteDomain: env.CLIENT_ORIGIN,
      apiBasePath: '/auth',
      websiteBasePath: '/auth',
    },
    recipeList: [
      EmailPassword.init({
        override: {
          apis: (originalImplementation) => ({
            ...originalImplementation,
            signUpPOST: async (input) => {
              const response = await originalImplementation.signUpPOST!(input);
              if (response.status !== 'OK') return response;

              const emailField = input.formFields.find((f) => f.id === 'email');
              const email = emailField?.value ?? '';

              try {
                await prisma.user.upsert({
                  where: { authId: response.user.id },
                  update: {},
                  create: {
                    authId: response.user.id,
                    email,
                  },
                });
              } catch (e) {
                console.error('Failed to persist user post-signUp:', e);
              }

              return response;
            },
          }),
        },
      }),
      Session.init({
        cookieSecure: env.NODE_ENV === 'production',
      }),
    ],
  });
}

export { supertokens };
