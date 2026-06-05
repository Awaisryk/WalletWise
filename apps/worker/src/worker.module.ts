import { Module } from '@nestjs/common';
import { WorkerConfigModule } from './config/worker-config.module';
import { PrismaModule } from './prisma/prisma.module';
import { ProcessorsModule } from './processors/processors.module';

/**
 * Root module for the standalone worker process.
 *   1. WorkerConfigModule — loads + validates worker env (incl. WORKER_CONCURRENCY).
 *   2. PrismaModule       — global, app-singleton Prisma client.
 *   3. ProcessorsModule   — BullMQ Worker (Dispatcher) + job processors.
 *
 * Mirrors the structure of apps/api/src/app.module.ts.
 */
@Module({
  imports: [WorkerConfigModule, PrismaModule, ProcessorsModule],
})
export class WorkerModule {}
