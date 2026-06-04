import { z } from 'zod';

const base = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().default(4000),
  CLIENT_ORIGIN: z.string().url(),
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().min(1),
  SUPERTOKENS_CORE_URL: z.string().url(),
  SUPERTOKENS_API_KEY: z.string().optional(),
  AI_ENV: z.enum(['dev', 'prod']).default('dev'),
  LOCAL_AI_BASE_URL: z.string().url().optional(),
  GROQ_API_KEY: z.string().optional(),
  CHAT_MODEL: z.string().optional(),
  AI_PROVIDER: z.string().optional(),
  AI_REASONING_EFFORT: z.enum(['low', 'medium', 'high']).optional(),
});

const apiSchema = base;
const workerSchema = base.extend({
  WORKER_CONCURRENCY: z.coerce.number().default(5),
});

export type ApiEnv = z.infer<typeof apiSchema>;
export type WorkerEnv = z.infer<typeof workerSchema>;

export function loadApiEnv(src: NodeJS.ProcessEnv | Record<string, unknown> = process.env): ApiEnv {
  return apiSchema.parse(src);
}
export function loadWorkerEnv(src: NodeJS.ProcessEnv | Record<string, unknown> = process.env): WorkerEnv {
  return workerSchema.parse(src);
}
