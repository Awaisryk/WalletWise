import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import Session from 'supertokens-node/recipe/session';
import type { SessionContainer } from 'supertokens-node/recipe/session';
import { PrismaService } from '../prisma/prisma.service';

/**
 * The resolved current user, attached to the Fastify request by `SessionGuard`.
 *   - `id`     -> our internal `User.id` (use this for all owned-row queries)
 *   - `authId` -> the SuperTokens user id
 */
export interface WalletwiseUser {
  id: string;
  authId: string;
}

interface SessionRequest {
  headers: Record<string, string | string[] | undefined>;
  session?: SessionContainer;
  walletwiseUser?: WalletwiseUser;
}

/**
 * Authenticates a request via the SuperTokens EmailPassword session.
 *
 * Runs `verifySession` (via `Session.getSession`) against the Fastify
 * req/res, resolves our internal `User` by `authId`, and attaches
 * `{ id, authId }` to `request.walletwiseUser`. If the SuperTokens session is
 * valid but our row is missing (e.g. the sign-up upsert never ran), we create
 * it here as a safety net so a logged-in user always has an app identity.
 *
 * Throws `UnauthorizedException` when there is no valid session.
 */
@Injectable()
export class SessionGuard implements CanActivate {
  constructor(private readonly prisma: PrismaService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const httpCtx = context.switchToHttp();
    const req = httpCtx.getRequest<SessionRequest>();
    const reply = httpCtx.getResponse<unknown>();

    let session: SessionContainer | undefined;
    try {
      session = await Session.getSession(req as never, reply as never, {
        sessionRequired: true,
      });
    } catch {
      throw new UnauthorizedException('Authentication required');
    }

    if (!session) throw new UnauthorizedException('Authentication required');

    const authId = session.getUserId();
    const user = await this.prisma.user.upsert({
      where: { authId },
      update: {},
      create: {
        authId,
        // SuperTokens owns the email; if our row is missing we backfill a
        // placeholder keyed off authId to satisfy the unique constraint.
        email: `${authId}@users.noreply.walletwise`,
      },
      select: { id: true },
    });

    req.session = session;
    req.walletwiseUser = { id: user.id, authId };
    return true;
  }
}
