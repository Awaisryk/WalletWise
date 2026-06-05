import { z } from 'zod';

/**
 * An optional URL that tolerates an empty string. Env files routinely carry
 * empty placeholders (e.g. `LOCAL_AI_BASE_URL=`); a plain `.url().optional()`
 * would reject `''` because `.optional()` only accepts `undefined`. We map empty
 * (or whitespace-only) to `undefined` first, then validate.
 */
const optionalUrl = z.preprocess(
  (v) => (typeof v === 'string' && v.trim() === '' ? undefined : v),
  z.string().url().optional(),
);

const base = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().default(4000),
  CLIENT_ORIGIN: z.string().url(),
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().min(1),
  SUPERTOKENS_CORE_URL: z.string().url(),
  SUPERTOKENS_API_KEY: z.string().optional(),
  AI_ENV: z.enum(['dev', 'prod']).default('dev'),
  LOCAL_AI_BASE_URL: optionalUrl,
  GROQ_API_KEY: z.string().optional(),
  // OpenAI is an opt-in chat provider: set AI_PROVIDER=openai + OPENAI_API_KEY.
  // OPENAI_MODEL defaults to gpt-5 (see AIHelper); override e.g. gpt-5-mini.
  OPENAI_API_KEY: z.string().optional(),
  OPENAI_MODEL: z.string().optional(),
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
