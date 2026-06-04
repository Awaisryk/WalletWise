import { Module } from '@nestjs/common';
import { ImportController } from './import.controller';

/**
 * CSV import endpoints. `PrismaService` (global) and `JobBus` (exported by the
 * global `QueueModule`) are both injectable without importing anything here.
 */
@Module({
  controllers: [ImportController],
})
export class ImportModule {}
