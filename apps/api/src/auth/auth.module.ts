import { Module } from '@nestjs/common';
import { SessionGuard } from './session.guard';

/**
 * Auth wiring. SuperTokens itself is `init()`-ed in `main.ts` BEFORE Nest
 * creation so the CORS plugin and `getAllCORSHeaders()` work. This module owns
 * the `SessionGuard`. `PrismaModule` is `@Global()`, so `PrismaService` is
 * already available for injection here.
 */
@Module({
  providers: [SessionGuard],
  exports: [SessionGuard],
})
export class AuthModule {}
