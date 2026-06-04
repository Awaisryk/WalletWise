import { Body, Controller, Inject, Logger, Post, Res, UseGuards } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import type { UIMessage } from 'ai';
import type { ApiEnv } from '@walletwise/config';
import { SessionGuard } from '../auth/session.guard';
import { User } from '../auth/user.decorator';
import { API_CONFIG } from '../config/api-config.module';
import { runChat } from './orchestrator';

/** Body of `POST /ai/chat`. The chat client sends ai-sdk UI messages. */
interface ChatBody {
  messages?: UIMessage[];
}

/**
 * Base system prompt for the finance assistant. Phase 4 will append tool-usage
 * guidance once the query/compare/list tools exist; for now the assistant
 * answers normally but is told never to invent figures.
 */
const BASE_SYSTEM_PROMPT = [
  'You are WalletWise, a personal finance assistant.',
  'Answer using tools once they are available; for now, answer normally.',
  'Never fabricate numbers. If you cannot answer from what you have, say what',
  'information is missing instead of inventing data.',
].join(' ');

@Controller('ai')
export class AiController {
  private readonly logger = new Logger(AiController.name);

  constructor(@Inject(API_CONFIG) private readonly env: ApiEnv) {}

  /**
   * Streaming chat turn. Reads the conversation `messages` from the body and
   * the authenticated `userId` (reserved for the Phase 4 user-scoped tools),
   * runs the `streamText` loop, and pipes the resulting UI message stream to
   * the Fastify response.
   *
   * Because the app uses `FastifyAdapter`, we `reply.hijack()` to take over the
   * response lifecycle and hand the AI SDK the Node raw response (`reply.raw`),
   * mirroring resume-plus's `result.pipeUIMessageStreamToResponse(res, ...)`
   * (Express's `res` and Fastify's `reply.raw` are both Node `ServerResponse`s).
   */
  @Post('chat')
  @UseGuards(SessionGuard)
  async chat(
    @Body() body: ChatBody,
    @User('id') userId: string,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const messages = Array.isArray(body?.messages) ? body.messages : [];

    const result = await runChat({
      env: this.env.AI_ENV,
      cfg: {
        GROQ_API_KEY: this.env.GROQ_API_KEY,
        LOCAL_AI_BASE_URL: this.env.LOCAL_AI_BASE_URL,
      },
      messages,
      system: BASE_SYSTEM_PROMPT,
    });

    // Hand the response lifecycle to the AI SDK. `hijack()` stops Fastify from
    // sending its own reply; `reply.raw` is the underlying Node ServerResponse
    // the SDK writes the SSE-style UI message stream to.
    reply.hijack();
    result.pipeUIMessageStreamToResponse(reply.raw, {
      onError: (error: unknown) => {
        this.logger.error(
          `[ai/chat] stream error for user=${userId}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
        return 'An error occurred while generating the response.';
      },
    });
  }
}
