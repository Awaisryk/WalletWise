import { createParamDecorator, ExecutionContext, UnauthorizedException } from '@nestjs/common';
import type { WalletwiseUser } from './session.guard';

/**
 * Param decorator that lifts the current user off the request.
 *
 *   `@User() user: WalletwiseUser`  -> the whole `{ id, authId }`
 *   `@User('id') userId: string`    -> a single field
 *
 * Requires `SessionGuard` to have run; throws Unauthorized otherwise (i.e. the
 * controller forgot the guard).
 */
export const User = createParamDecorator(
  (data: keyof WalletwiseUser | undefined, ctx: ExecutionContext) => {
    const req = ctx.switchToHttp().getRequest<{ walletwiseUser?: WalletwiseUser }>();
    const user = req.walletwiseUser;
    if (!user) {
      throw new UnauthorizedException('Authentication required');
    }
    return data ? user[data] : user;
  },
);
