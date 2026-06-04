import { Inject, Injectable, OnModuleDestroy } from '@nestjs/common';
import { Queue, type JobsOptions } from 'bullmq';
import IORedis, { type Redis } from 'ioredis';
import type { WorkerEnv } from '@walletwise/config';
import { WALLETWISE_QUEUE, type JobName } from '@walletwise/contracts';
import { WORKER_CONFIG } from '../config/worker-config.module';

/**
 * Default job options for jobs the worker itself enqueues (e.g. a
 * `rollup.rebuild` follow-up after a CSV import completes). Kept in sync with
 * the API's `JobBus` defaults so a worker-produced job behaves identically to
 * an API-produced one.
 */
const DEFAULT_JOB_OPTS: JobsOptions = {
  attempts: 3,
  backoff: { type: 'exponential', delay: 1000 },
  removeOnComplete: { age: 3600, count: 1000 },
  removeOnFail: { age: 86400 },
};

/**
 * The worker's own BullMQ producer, mirroring the API's `JobBus`. Processors
 * use it to chain follow-up jobs onto the same `WALLETWISE_QUEUE` (the worker
 * doesn't have access to the API's `JobBus`). It owns a dedicated ioredis
 * connection (`maxRetriesPerRequest: null`) that it closes on shutdown.
 */
@Injectable()
export class JobProducer implements OnModuleDestroy {
  private readonly connection: Redis;
  private readonly queue: Queue;

  constructor(@Inject(WORKER_CONFIG) env: WorkerEnv) {
    this.connection = new IORedis(env.REDIS_URL, { maxRetriesPerRequest: null });
    this.queue = new Queue(WALLETWISE_QUEUE, { connection: this.connection });
  }

  async enqueue<T extends object>(name: JobName, payload: T, opts?: JobsOptions) {
    return this.queue.add(name, payload, { ...DEFAULT_JOB_OPTS, ...opts });
  }

  async onModuleDestroy(): Promise<void> {
    await this.queue.close();
    await this.connection.quit().catch(() => {});
  }
}
