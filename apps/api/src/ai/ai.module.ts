import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { AiController } from './ai.controller';

/**
 * AI chat module.
 *
 * Owns the streaming `POST /ai/chat` endpoint. Imports {@link AuthModule} for
 * the `SessionGuard`. The validated API env (`API_CONFIG`) and `PrismaService`
 * are provided by their respective `@Global()` modules, so the controller can
 * inject them without importing those modules here. Model routing lives in
 * `@walletwise/ai`; provider strings never appear in this module.
 */
@Module({
  imports: [AuthModule],
  controllers: [AiController],
})
export class AiModule {}
