import { Global, Inject, Injectable, Module, OnModuleDestroy } from '@nestjs/common';
import { Queue, type JobsOptions } from 'bullmq';
import IORedis from 'ioredis';
import type { ApiEnv } from '@walletwise/config';
import { WALLETWISE_QUEUE, type JobName } from '@walletwise/contracts';
import { API_CONFIG } from '../config/api-config.module';

/** DI token for the singleton BullMQ producer queue. */
export const WALLETWISE_QUEUE_TOKEN = Symbol.for('WALLETWISE_QUEUE');

/**
 * Default job options applied to every enqueue. Producers can override per
 * call. `attempts`/`backoff` give at-least-once retry with exponential
 * backoff; the retention windows keep completed/failed jobs around long
 * enough to inspect (`/import/:id` reads the DB, not the queue, so these are
 * purely for operability) without unbounded Redis growth.
 */
const DEFAULT_JOB_OPTS: JobsOptions = {
  attempts: 3,
  backoff: { type: 'exponential', delay: 1000 },
  removeOnComplete: { age: 3600, count: 1000 },
  removeOnFail: { age: 86400 },
};

/**
 * Lightweight producer for WalletWise background jobs. API controllers call
 * `enqueue()`; the BullMQ worker (apps/worker) consumes from the same
 * `WALLETWISE_QUEUE`. Splitting production from consumption keeps the API
 * stateless and gives us at-least-once retry semantics for free.
 *
 * The queue name is shared with apps/worker via `@walletwise/contracts`; do
 * not hardcode it on either side.
 */
@Injectable()
export class JobBus implements OnModuleDestroy {
  constructor(@Inject(WALLETWISE_QUEUE_TOKEN) private readonly queue: Queue) {}

  /**
   * Enqueue a job. `name` is a typed `JobName` from the contract; `payload`
   * is the matching payload type (callers pass the right shape). Returns the
   * created BullMQ job so the caller can read `job.id` (e.g. to correlate an
   * `ImportJob` row with its queue job).
   */
  async enqueue<T extends object>(name: JobName, payload: T, opts?: JobsOptions) {
    return this.queue.add(name, payload, { ...DEFAULT_JOB_OPTS, ...opts });
  }

  async onModuleDestroy(): Promise<void> {
    await this.queue.close();
  }
}

@Global()
@Module({
  providers: [
    {
      provide: WALLETWISE_QUEUE_TOKEN,
      inject: [API_CONFIG],
      useFactory: (env: ApiEnv): Queue => {
        // BullMQ requires `maxRetriesPerRequest: null` for its blocking
        // commands; we use a dedicated ioredis connection that BullMQ owns.
        const connection = new IORedis(env.REDIS_URL, {
          maxRetriesPerRequest: null,
        });
        return new Queue(WALLETWISE_QUEUE, { connection });
      },
    },
    JobBus,
  ],
  exports: [JobBus],
})
export class QueueModule {}
