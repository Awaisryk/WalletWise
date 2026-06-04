import {
  convertToModelMessages,
  streamText,
  stepCountIs,
  type ModelMessage,
  type StreamTextResult,
  type ToolSet,
  type UIMessage,
} from 'ai';
import { AIHelper, AITask, type AICfg } from '@walletwise/ai';

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
}

/**
 * Runs one WalletWise chat turn through ai-sdk v6 `streamText`.
 *
 * Model, temperature, and provider options are resolved from {@link AIHelper}
 * for the CHAT task so provider strings never leak into the controller. No
 * tools are wired yet — the finance tool catalog lands in Phase 4; the
 * `stopWhen: stepCountIs(6)` cap is already in place so adding tools later is a
 * one-line change.
 *
 * Returns the raw `streamText` result so the controller can pipe it straight
 * to the HTTP response.
 */
export async function runChat(
  params: RunChatParams,
): Promise<StreamTextResult<ToolSet, never>> {
  const { env, cfg, messages, system } = params;

  // UI messages carry a `parts` array; convert them to model messages. Plain
  // model-message arrays (no `parts`) are passed through untouched.
  const incoming = Array.isArray(messages) ? messages : [];
  const modelMessages: ModelMessage[] =
    incoming.length > 0 && (incoming[0] as { parts?: unknown }).parts
      ? await convertToModelMessages(incoming as UIMessage[])
      : (incoming as ModelMessage[]);

  const providerOptions = AIHelper.getProviderOptions(AITask.CHAT, env);

  return streamText({
    model: AIHelper.getModel(AITask.CHAT, env, cfg),
    system,
    messages: modelMessages,
    stopWhen: stepCountIs(6),
    temperature: AIHelper.getTemperature(AITask.CHAT, env),
    ...(providerOptions ? { providerOptions } : {}),
  });
}
