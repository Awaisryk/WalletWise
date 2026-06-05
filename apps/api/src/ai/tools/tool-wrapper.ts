import { z } from 'zod';
import { redisClient } from '../../redis/redis.service';

// Simple PII redaction for logging
function redactPII(value: any): any {
  const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
  const PHONE_RE = /\b(?:\+?\d[\s-]?){7,}\d\b/g; // crude but effective for logs
  const URL_RE = /\bhttps?:\/\/[^\s]+/gi;

  const redactString = (s: string) =>
    s
      .replace(EMAIL_RE, '<redacted-email>')
      .replace(PHONE_RE, '<redacted-phone>')
      .replace(URL_RE, '<redacted-url>');

  if (typeof value === 'string') return redactString(value);
  if (Array.isArray(value)) return value.map(redactPII);
  if (value && typeof value === 'object') {
    const out: any = Array.isArray(value) ? [] : {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = redactPII(v);
    }
    return out;
  }
  return value;
}

export async function logToolCall(params: {
  conversationId: string;
  toolName: string;
  durationMs: number;
  success: boolean;
  error?: string;
  revision?: number;
  inputSummary?: any;
}) {
  try {
    const key = `walletwise:tool-calls:${params.conversationId}`;
    const existing = await redisClient.get(key);
    const logs = existing ? JSON.parse(existing) : [];
    logs.push({
      ts: Date.now(),
      toolName: params.toolName,
      durationMs: params.durationMs,
      success: params.success,
      error: params.error || null,
      revision: params.revision ?? null,
      input: redactPII(params.inputSummary || {}),
    });
    // keep 500 entries, TTL 24h
    const trimmed = logs.slice(-500);
    await redisClient.setEx(key, 86400, JSON.stringify(trimmed));
    // Also console log succinctly
    // eslint-disable-next-line no-console
    console.log(
      `[Tool] ${params.success ? 'OK' : 'ERR'} ${params.toolName} in ${params.durationMs.toFixed(
        1,
      )}ms rev=${params.revision ?? '-'}`,
    );
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn('Failed to log tool call', e);
  }
}

export type ToolContext = {
  experimental_context?: {
    conversationId?: string;
    userId?: string;
  };
  /**
   * The conversation history the model has seen UP TO this tool call —
   * provided by the AI SDK's ToolExecutionOptions. Optional + loosely typed
   * because not every code path supplies it (tests sometimes call execute with
   * a bare context object).
   */
  messages?: ReadonlyArray<any>;
};

export type ToolExecuteResult = {
  summary?: string;
  metadata?: any;
  [key: string]: any;
};

export function createTool<Input extends z.ZodType<any>>(opts: {
  name: string;
  description: string;
  inputSchema: Input;
  execute: (
    input: z.infer<Input>,
    context: ToolContext,
  ) => Promise<ToolExecuteResult & { ignoreLog?: boolean; inputSummary?: any }>;
}) {
  return {
    description: opts.description,
    inputSchema: opts.inputSchema,
    execute: async (input: z.infer<Input>, extra: any) => {
      const t0 = performance.now();
      const context = extra as ToolContext;
      const conversationId = context?.experimental_context?.conversationId || 'unknown';

      try {
        const result = await opts.execute(input, context);

        if (!result.ignoreLog) {
          await logToolCall({
            conversationId,
            toolName: opts.name,
            durationMs: performance.now() - t0,
            success: true,
            revision: result.revision,
            inputSummary: result.inputSummary,
          });
        }

        // Remove internal flags before returning
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        const { ignoreLog, inputSummary, ...cleanResult } = result;
        return cleanResult;
      } catch (err: any) {
        await logToolCall({
          conversationId,
          toolName: opts.name,
          durationMs: performance.now() - t0,
          success: false,
          error: String(err?.message || err),
        });
        throw err;
      }
    },
  };
}
