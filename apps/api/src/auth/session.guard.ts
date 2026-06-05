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
 * Authenticates a request via the SuperTokens session, resolves our app user,
 * and attaches `{ id, authId }` to the request.
 *
 * TODO: Replace this custom guard/session plumbing with the official
 * SuperTokens NestJS integration/module if we keep this stack beyond the
 * assessment.
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
    const user = await this.prisma.user.findUnique({
      where: { authId },
      select: { id: true, authId: true },
    });
    if (!user) throw new UnauthorizedException('User profile not found');

    req.session = session;
    req.walletwiseUser = { id: user.id, authId: user.authId };
    return true;
  }
}
