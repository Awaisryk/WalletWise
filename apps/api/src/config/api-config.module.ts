import { Global, Module } from '@nestjs/common';
import { loadApiEnv, type ApiEnv } from '@walletwise/config';

/**
 * DI token for the validated API environment. Inject with
 * `@Inject(API_CONFIG) env: ApiEnv`.
 */
export const API_CONFIG = Symbol.for('WALLETWISE_API_CONFIG');

@Global()
@Module({
  providers: [
    {
      provide: API_CONFIG,
      useFactory: (): ApiEnv => loadApiEnv(process.env),
    },
  ],
  exports: [API_CONFIG],
})
export class ApiConfigModule {}
