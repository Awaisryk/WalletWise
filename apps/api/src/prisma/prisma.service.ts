import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

/**
 * App-singleton Prisma client. Connects on `onModuleInit` and disconnects on
 * shutdown.
 *
 * Plain client by design: WalletWise enforces per-user data ownership in
 * application code (services add `userId` to their own queries). There is no
 * RLS, no `SET LOCAL`, and no `withUser` helper here.
 *
 * `PrismaClient` is imported from `@prisma/client` (a direct dependency)
 * rather than from `@walletwise/db` so we resolve the generated client, not
 * the workspace package's TS source.
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
