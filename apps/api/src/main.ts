import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import fastifyCookie from '@fastify/cookie';
import fastifyCors from '@fastify/cors';
import supertokens from 'supertokens-node';
import { plugin as supertokensFastify, errorHandler } from 'supertokens-node/framework/fastify';
import { PrismaClient } from '@prisma/client';
import { loadApiEnv } from '@walletwise/config';
import { AppModule } from './app.module';
import { initSuperTokens } from './auth/supertokens.init';

async function bootstrap(): Promise<void> {
  const env = loadApiEnv(process.env);

  // SuperTokens init MUST run before NestFactory.create so the CORS plugin can
  // call `supertokens.getAllCORSHeaders()`. We give it a transient
  // PrismaClient used only inside the SuperTokens sign-up override; the
  // long-lived PrismaService inside Nest is a separate instance.
  const stPrisma = new PrismaClient();
  initSuperTokens(env, stPrisma);

  const adapter = new FastifyAdapter({ trustProxy: true });

  const app = await NestFactory.create<NestFastifyApplication>(AppModule, adapter, {
    bufferLogs: true,
  });

  // Cookies are required by the SuperTokens session recipe.
  await app.register(fastifyCookie as unknown as Parameters<typeof app.register>[0]);

  // CORS: allow the configured client origin with credentials so SuperTokens
  // session cookies flow, and surface SuperTokens' own request headers.
  await app.register(fastifyCors as unknown as Parameters<typeof app.register>[0], {
    origin: env.CLIENT_ORIGIN,
    credentials: true,
    allowedHeaders: ['content-type', ...supertokens.getAllCORSHeaders()],
  });

  // SuperTokens Fastify plugin registers /auth/* handlers and request
  // decorations. Its errorHandler must be registered so SuperTokens auth
  // errors return the correct responses. The cast bridges the FastifyRequest
  // type augmented by @fastify/cookie against SuperTokens' base request type.
  await app.register(supertokensFastify as unknown as Parameters<typeof app.register>[0]);
  const fastifyInstance = app.getHttpAdapter().getInstance();
  fastifyInstance.setErrorHandler(errorHandler() as unknown as Parameters<typeof fastifyInstance.setErrorHandler>[0]);

  app.enableShutdownHooks();
  await app.listen({ host: '0.0.0.0', port: env.PORT });
  console.log(`WalletWise API listening on http://0.0.0.0:${env.PORT}`);
}

bootstrap().catch((err) => {
  console.error('Failed to bootstrap WalletWise API:', err);
  process.exit(1);
});
