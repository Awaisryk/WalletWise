import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

/**
 * App-singleton Prisma client for the worker. Mirrors the API's PrismaService
 * so test fakes are interchangeable. The client reads `DATABASE_URL` at
 * construction (env-var only, 12-factor compliant).
 *
 * `PrismaClient` is imported from `@prisma/client` (a direct dependency)
 * rather than from `@walletwise/db` so we resolve the generated client, not
 * the workspace package's TS source — keeping the worker's `tsc` build clean.
 */
@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PrismaService.name);

  async onModuleInit(): Promise<void> {
    await this.$connect();
    this.logger.log('Prisma connected');
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
    this.logger.log('Prisma disconnected');
  }
}
