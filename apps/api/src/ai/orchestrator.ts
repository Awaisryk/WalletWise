import {
  convertToModelMessages,
  streamText,
  stepCountIs,
  type ModelMessage,
  type StreamTextResult,
  type ToolSet,
  type UIMessage,
} from 'ai';
import { Logger } from '@nestjs/common';
import { AIHelper, AITask, type AICfg } from '@walletwise/ai';
import {
  extractProviderErrorInfo,
  formatProviderErrorForLog,
  isProviderGenerationError,
  truncateFailedGeneration,
} from './provider-error';

const logger = new Logger('ChatOrchestrator');

export interface RunChatParams {
  /** AI environment — selects dev (local) vs prod (Groq) model routing. */
  env: 'dev' | 'prod';
  /** Provider credentials / base URLs pulled from the validated API env. */
  cfg: AICfg;
  /**
   * Conversation messages. The chat client sends UI messages (objects with a
   * `parts` array); we convert those to model messages before the call. If
   * plain model messages are passed (server-internal callers, tests) they are
   * used as-is.
   */
  messages: UIMessage[] | ModelMessage[];
  /** The base system prompt for the turn. */
  system: string;
  /**
   * The finance tool catalog for this turn, constructed per-request by
   * `buildTools({ prisma, userId })`. The tools close over the server-side
   * `userId`, so every query they run is scoped to the current user — the model
   * never supplies an identity. Optional so server-internal callers/tests can
   * run a tool-less turn.
   */
  tools?: ToolSet;
  /**
   * The dynamic `<runtime_context>` block (today, timezone, remembered facts).
   * Injected as a reference message immediately before the latest user message
   * so the system prompt + tool catalog stay byte-stable (cacheable) across
   * turns and users. Omitted by server-internal callers/tests.
   */
  runtimeContext?: string;
}

export interface RunChatOptions {
  /**
   * Invoked when the underlying `streamText` finishes. The controller uses this
   * to read the turn's usage and roll the cumulative cost into Redis.
   */
  onFinish?: (event?: any) => void | Promise<void>;
}

/**
 * Runs one WalletWise chat turn through ai-sdk v6 `streamText`.
 *
 * Model, temperature, and provider options are resolved from {@link AIHelper}
 * for the CHAT task so provider strings never leak into the controller. Returns
 * the raw `streamText` result so the controller can pipe it straight to the HTTP
 * response.
 */
export async function runChat(
  params: RunChatParams,
  opts?: RunChatOptions,
): Promise<StreamTextResult<ToolSet, never>> {
  const { env, cfg, messages, system, tools, runtimeContext } = params;

  // UI messages carry a `parts` array; convert them to model messages. Plain
  // model-message arrays (no `parts`) are passed through untouched.
  const incoming = Array.isArray(messages) ? messages : [];
  const modelMessages: ModelMessage[] =
    incoming.length > 0 && (incoming[0] as { parts?: unknown }).parts
      ? await convertToModelMessages(incoming as UIMessage[])
      : (incoming as ModelMessage[]);

  // Inject the dynamic <runtime_context> as a reference message immediately
  // before the latest user message. Keeping it here (not in `system`) means the
  // system prompt + tool catalog form a byte-stable, cacheable prefix; the
  // volatile per-turn data rides late, closest to the question it informs.
  //
  // Role is `assistant`, NOT `system`: most chat models reject a `system` turn
  // in the middle of a conversation. An assistant-authored reference block is
  // broadly accepted, and `reference_context_rules` in the system prompt tells
  // the model to treat `<runtime_context>` as data rather than instructions.
  if (runtimeContext) {
    const ref: ModelMessage = { role: 'assistant', content: runtimeContext };
    if (modelMessages.length > 0) {
      modelMessages.splice(modelMessages.length - 1, 0, ref);
    } else {
      modelMessages.push(ref);
    }
  }

  const providerOptions = AIHelper.getProviderOptions(AITask.CHAT, env);
  const chatModelConfig = AIHelper.getModelConfig(AITask.CHAT, env);

  // Groq's gpt-oss models occasionally surface `tool_use_failed` /
  // `json_validate_failed` generation errors inside raw chunks or the stream
  // error; we log them once (deduped) for debugging without exposing them to
  // the user.
  const loggedProviderErrors = new Set<string>();
  const logProviderError = (source: string, payload: unknown) => {
    const info = extractProviderErrorInfo(payload);
    if (!isProviderGenerationError(info)) return;
    const dedupeKey = [source, info?.requestId, info?.code, info?.message].join('|');
    if (loggedProviderErrors.has(dedupeKey)) return;
    loggedProviderErrors.add(dedupeKey);

    const failedGeneration = info?.failedGeneration
      ? process.env.AI_LOG_FAILED_GENERATION === 'true' || process.env.NODE_ENV !== 'production'
        ? info.failedGeneration
        : truncateFailedGeneration(info.failedGeneration)
      : null;
    logger.warn(
      `[AIProviderError] source=${source} provider=${chatModelConfig.provider} model=${chatModelConfig.model} task=${AITask.CHAT} ${formatProviderErrorForLog(
        info!,
      )}${failedGeneration ? ` failed_generation=${failedGeneration}` : ''}`,
    );
  };

  return streamText({
    model: AIHelper.getModel(AITask.CHAT, env, cfg),
    system,
    messages: modelMessages,
    // The finance tool catalog (query_spending, list_transactions, memory, …).
    // When omitted (server-internal/test turns) the model just answers from the
    // prompt. `toolChoice: 'auto'` lets the model decide whether to call a tool;
    // `stepCountIs(8)` bounds the gather→answer loop.
    ...(tools ? { tools, toolChoice: 'auto' as const } : {}),
    stopWhen: stepCountIs(8),
    temperature: AIHelper.getTemperature(AITask.CHAT, env),
    maxRetries: 0,
    ...(providerOptions ? { providerOptions } : {}),
    includeRawChunks: true,
    onChunk: ({ chunk }) => {
      if ((chunk as any)?.type !== 'raw') return;
      logProviderError('chat_chunk', (chunk as any).rawValue ?? (chunk as any).raw ?? chunk);
    },
    onError: ({ error }) => {
      logProviderError('chat_stream', error);
    },
    onFinish: async (event) => {
      await opts?.onFinish?.(event);
    },
  });
}
