import { Body, Controller, Inject, Logger, Post, Res, UseGuards } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { createUIMessageStream, pipeUIMessageStreamToResponse } from 'ai';
import type { ApiEnv } from '@walletwise/config';
import { AIHelper, AITask } from '@walletwise/ai';
import { SessionGuard } from '../auth/session.guard';
import { User } from '../auth/user.decorator';
import { API_CONFIG } from '../config/api-config.module';
import { redisClient } from '../redis/redis.service';
import { runChat } from './orchestrator';

/** Body of `POST /ai/chat`. The chat client sends ai-sdk UI messages. */
interface ChatBody {
  messages: any[];
  conversationId?: string;
}

/**
 * Base system prompt for the finance assistant. Phase 4 will add the finance
 * tool catalog (query/compare/list transactions); the prompt already tells the
 * model to lean on tools and never invent figures.
 */
const BASE_SYSTEM_PROMPT = [
  'You are WalletWise, a personal finance assistant.',
  "Use available tools to answer questions about the user's transactions; never fabricate numbers.",
  "If you cannot answer from the data/tools, say what's missing.",
  'Be concise.',
].join(' ');

@Controller('ai')
export class AiController {
  private readonly logger = new Logger(AiController.name);

  constructor(@Inject(API_CONFIG) private readonly env: ApiEnv) {}

  /**
   * Streaming chat turn. Mirrors resume-plus's `AIController.resumeV2`
   * response-piping core (apps/server/src/ai/ai.controller.ts): build a
   * `createUIMessageStream`, run the model inside `execute`, `writer.merge` the
   * model's UI-message stream with a `messageMetadata` hook that attaches the
   * per-turn cost + cumulative session cost, then pipe to the HTTP response.
   *
   * Differences from resume-plus, all intentional for this phase:
   *   - no tools / snapshot / goal / plan / quota / message persistence
   *     (those land in Phase 4 and later)
   *   - `onFinish` is a no-op log (no DB writes yet)
   *   - cumulative cost lives at `walletwise:cost:${conversationId}` (24h TTL)
   *   - the response is Fastify's: we `reply.hijack()` and hand the SDK
   *     `reply.raw` (a Node `ServerResponse`) in place of Express's `res`. The
   *     `pipeUIMessageStreamToResponse({ response, stream })` argument shape is
   *     identical to resume-plus.
   */
  @Post('chat')
  @UseGuards(SessionGuard)
  async chat(
    @Body() body: ChatBody,
    @User('id') userId: string,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const env = this.env.AI_ENV;
    const cfg = {
      GROQ_API_KEY: this.env.GROQ_API_KEY,
      LOCAL_AI_BASE_URL: this.env.LOCAL_AI_BASE_URL,
    };
    const conversationId = body.conversationId;
    const costKey = conversationId ? `walletwise:cost:${conversationId}` : '';

    // onFinish is intentionally minimal for this phase — no message persistence
    // yet (Phase 4/later). Just log the turn finish reason for observability.
    const onFinish = (event?: any) => {
      this.logger.log(
        `[ai/chat] turn finished user=${userId} conv=${conversationId ?? 'none'} finishReason=${
          event?.finishReason ?? 'unknown'
        }`,
      );
    };

    const stream = createUIMessageStream({
      originalMessages: body.messages,
      execute: async ({ writer }) => {
        // Pre-read the prior cumulative cost for this conversation so the
        // synchronous `messageMetadata` hook can compute the new cumulative
        // without an await. Wrapped so Redis being down never breaks the stream.
        let prevCost = 0;
        try {
          if (costKey) {
            const prev = parseFloat((await redisClient.get(costKey)) || '0');
            prevCost = Number.isFinite(prev) ? prev : 0;
          }
        } catch {
          /* Redis down — start the cumulative from 0 for this turn. */
        }

        const result = await runChat({ env, cfg, messages: body.messages, system: BASE_SYSTEM_PROMPT }, { onFinish });

        // Pipe the model stream into the UI stream. The `messageMetadata` hook
        // fires on `finish` with the turn's `totalUsage`; we compute the turn
        // cost, roll it into the conversation's cumulative total, and persist
        // that total back to Redis (24h TTL, fire-and-forget so a Redis hiccup
        // never blocks the response).
        writer.merge(
          result.toUIMessageStream({
            messageMetadata: ({ part }) => {
              if (part.type === 'finish') {
                const usage = (part as any).totalUsage || {};
                const cost = AIHelper.calculateCost(usage, AITask.CHAT, env);
                const cumulativeCost = (prevCost || 0) + (cost || 0);

                // Persist the new cumulative cost (best-effort). Mirrors
                // resume-plus's `resume:v2:cost:*` 24h-TTL pattern.
                if (costKey) {
                  void (async () => {
                    try {
                      const prior = parseFloat((await redisClient.get(costKey)) || '0');
                      const base = Number.isFinite(prior) ? prior : 0;
                      await redisClient.setEx(costKey, 86400, String(base + (cost || 0)));
                    } catch {
                      /* noop */
                    }
                  })();
                }

                return {
                  totalTokens: usage.totalTokens,
                  cost,
                  cumulativeCost,
                  createdAt: Date.now(),
                };
              }
            },
          }),
        );
      },
    });

    // Hand the response lifecycle to the AI SDK. `hijack()` stops Fastify from
    // sending its own reply; `reply.raw` is the underlying Node ServerResponse.
    // resume-plus calls `pipeUIMessageStreamToResponse({ response: res, stream })`
    // with Express's `res`; Fastify's `reply.raw` is the same Node type, so the
    // argument object is identical.
    reply.hijack();
    pipeUIMessageStreamToResponse({ response: reply.raw, stream });
  }
}
