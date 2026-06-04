import { Body, Controller, Inject, Logger, Post, Res, UseGuards } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { createUIMessageStream, pipeUIMessageStreamToResponse } from 'ai';
import type { ApiEnv } from '@walletwise/config';
import { AIHelper, AITask } from '@walletwise/ai';
import { SessionGuard } from '../auth/session.guard';
import { User } from '../auth/user.decorator';
import { API_CONFIG } from '../config/api-config.module';
import { PrismaService } from '../prisma/prisma.service';
import { redisClient } from '../redis/redis.service';
import { runChat } from './orchestrator';
import { buildTools } from './tools';

/** Body of `POST /ai/chat`. The chat client sends ai-sdk UI messages. */
interface ChatBody {
  messages: any[];
  conversationId?: string;
}

/**
 * Base system prompt for the finance assistant. The finance tool catalog
 * (query_spending / list_transactions / compare_periods / memory) is wired in
 * `chat()`; the prompt tells the model to lean on tools and never invent
 * figures. At request time the user's remembered facts are appended as a
 * "Known facts about the user" block.
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

  constructor(
    @Inject(API_CONFIG) private readonly env: ApiEnv,
    private readonly prisma: PrismaService,
  ) {}

  /**
   * Streaming chat turn. Builds a `createUIMessageStream`, runs the model
   * inside `execute`, merges the model's UI-message stream with a
   * `messageMetadata` hook that attaches per-turn cost + cumulative session
   * cost, then pipes to the HTTP response.
   *
   * Implementation notes:
   *   - the finance tool catalog is constructed per-request and scoped to the
   *     session `userId`
   *   - `onFinish` is a no-op log (no DB writes yet)
   *   - cumulative cost lives at `walletwise:cost:${conversationId}` (24h TTL)
   *   - the response is Fastify's: we `reply.hijack()` and hand the SDK
   *     `reply.raw` (a Node `ServerResponse`)
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

    // Construct the finance tool catalog for this request. The tools close over
    // the server-side `userId` resolved from the SuperTokens session, so every
    // Prisma query they run is scoped to the current user. The LLM only supplies
    // non-identity inputs (dates, category, merchant, limit) — it can never set
    // `userId`.
    const tools = buildTools({ prisma: this.prisma, userId });

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

        // Load the user's remembered facts and prepend a compact block to the
        // system prompt so the assistant applies memory from the first token
        // (without forcing a get_user_facts tool round-trip). Best-effort: if
        // the read fails we just run with the base prompt.
        let system = BASE_SYSTEM_PROMPT;
        try {
          const facts = await this.prisma.userFact.findMany({ where: { userId } });
          if (facts.length > 0) {
            const factLines = facts.map((f) => `- ${f.key}: ${f.value} (${f.kind})`).join('\n');
            system = `${BASE_SYSTEM_PROMPT}\n\nKnown facts about the user:\n${factLines}`;
          }
        } catch (err) {
          this.logger.warn(`[ai/chat] failed to load user facts user=${userId}: ${String(err)}`);
        }

        const result = await runChat({ env, cfg, messages: body.messages, system, tools }, { onFinish });

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

                // Persist the new cumulative cost (best-effort).
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
    reply.hijack();
    pipeUIMessageStreamToResponse({ response: reply.raw, stream });
  }
}
