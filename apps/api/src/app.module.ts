import { Module } from '@nestjs/common';
import { ApiConfigModule } from './config/api-config.module';
import { PrismaModule } from './prisma/prisma.module';
import { AuthModule } from './auth/auth.module';
import { AiModule } from './ai/ai.module';

/**
 * Root module.
 *   1. ApiConfigModule  — loads + validates env (throws fast on misconfig).
 *   2. PrismaModule     — global, app-singleton Prisma client.
 *   3. AuthModule       — SessionGuard (SuperTokens is init()-ed in main.ts).
 *   4. AiModule         — streaming POST /ai/chat.
 *
 * Domain modules (transactions, imports, ...) get added in later phases.
 */
@Module({
  imports: [ApiConfigModule, PrismaModule, AuthModule, AiModule],
})
export class AppModule {}
