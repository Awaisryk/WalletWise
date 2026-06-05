import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { ImportController } from './import.controller';

/**
 * CSV import endpoints. Imports {@link AuthModule} so the `SessionGuard` is
 * resolved through DI (otherwise its `PrismaService` dependency is undefined).
 * `PrismaService` (global) and `JobBus` (exported by the global `QueueModule`)
 * are injectable without importing those modules here.
 */
@Module({
  imports: [AuthModule],
  controllers: [ImportController],
})
export class ImportModule {}
