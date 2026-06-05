import { Global, Module } from '@nestjs/common';
import { loadWorkerEnv, type WorkerEnv } from '@walletwise/config';

/**
 * DI token for the validated worker environment. Inject with
 * `@Inject(WORKER_CONFIG) env: WorkerEnv`. Mirrors the API's `API_CONFIG`.
 */
export const WORKER_CONFIG = Symbol.for('WALLETWISE_WORKER_CONFIG');

@Global()
@Module({
  providers: [
    {
      provide: WORKER_CONFIG,
      useFactory: (): WorkerEnv => loadWorkerEnv(process.env),
    },
  ],
  exports: [WORKER_CONFIG],
})
export class WorkerConfigModule {}
