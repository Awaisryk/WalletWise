import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { WorkerModule } from './worker.module';

/**
 * Standalone NestJS application (no HTTP server) that hosts BullMQ consumers.
 *
 * The worker is a sibling stateless process to the API. Both scale
 * horizontally and independently — the worker concurrency knob is
 * `WORKER_CONCURRENCY`. Graceful shutdown is wired via `enableShutdownHooks()`
 * plus the dispatcher's own `onModuleDestroy` hook, which lets BullMQ drain
 * in-flight jobs and close its ioredis connection before exit.
 *
 * Lifted from bugsport's apps/worker/src/main.ts (minus nestjs-pino — we use
 * the default Nest logger, same as apps/api).
 */
async function bootstrap(): Promise<void> {
  const app = await NestFactory.createApplicationContext(WorkerModule, {
    bufferLogs: true,
  });
  app.enableShutdownHooks();

  new Logger('Bootstrap').log('WalletWise worker started');
}

bootstrap().catch((err) => {
  console.error('Failed to bootstrap WalletWise worker:', err);
  process.exit(1);
});
