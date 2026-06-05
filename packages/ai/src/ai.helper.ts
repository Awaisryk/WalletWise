import { createGroq } from '@ai-sdk/groq';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import type { LanguageModel } from 'ai';

/**
 * Return the first argument that is (or parses to) a finite number so
 * {@link AIHelper.normalizeUsage} can coalesce token counts that arrive under
 * different keys / shapes across providers.
 */
function firstFiniteNumber(...values: unknown[]): number | undefined {
  for (const value of values) {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string' && value.trim()) {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return undefined;
}

/**
 * Task-based model routing for WalletWise.
 *
 * Controllers and tools NEVER hardcode provider strings or model ids — they
 * ask {@link AIHelper} for the model/temperature/provider-options that belong
 * to a given {@link AITask} in a given environment. This keeps the cost/latency
 * story in one place: cheap text model for chat, multimodal only for vision.
 */
export enum AITask {
  CHAT = 'chat',
  PARSE_VISION = 'parse_vision',
}

export type AIProvider = 'local' | 'groq';

export interface ModelConfig {
  provider: AIProvider;
  model: string;
  temperature: number;
}

/**
 * The provider/model split per task and environment.
 *
 *   CHAT.dev          -> local OpenAI-compatible gpt-oss (LM Studio / Ollama)
 *   CHAT.prod         -> Groq openai/gpt-oss-120b, low reasoning effort
 *   PARSE_VISION.*    -> Groq Llama-4 Scout (multimodal) for receipt OCR
 */
const MAP: Record<AITask, { dev: ModelConfig; prod: ModelConfig }> = {
  [AITask.CHAT]: {
    dev: { provider: 'local', model: 'gpt-oss', temperature: 0.3 },
    prod: { provider: 'groq', model: 'openai/gpt-oss-120b', temperature: 0.3 },
  },
  [AITask.PARSE_VISION]: {
    dev: { provider: 'groq', model: 'meta-llama/llama-4-scout-17b-16e-instruct', temperature: 0.1 },
    prod: { provider: 'groq', model: 'meta-llama/llama-4-scout-17b-16e-instruct', temperature: 0.1 },
  },
};

/** Minimal config surface the helper needs to construct providers. */
export interface AICfg {
  GROQ_API_KEY?: string;
  LOCAL_AI_BASE_URL?: string;
}

export class AIHelper {
  /** The provider/model/temperature triple for a task+env. */
  static getModelConfig(task: AITask, env: 'dev' | 'prod'): ModelConfig {
    return MAP[task][env];
  }

  /** Just the temperature for a task+env (sugar over {@link getModelConfig}). */
  static getTemperature(task: AITask, env: 'dev' | 'prod'): number {
    return MAP[task][env].temperature;
  }

  /**
   * Construct the concrete language model for a task+env. Groq tasks use the
   * Groq provider keyed off `GROQ_API_KEY`; the `local` provider talks to an
   * OpenAI-compatible server (LM Studio default `http://localhost:1234/v1`).
   */
  static getModel(task: AITask, env: 'dev' | 'prod', cfg: AICfg): LanguageModel {
    const c = MAP[task][env];
    if (c.provider === 'groq') {
      return createGroq({ apiKey: cfg.GROQ_API_KEY })(c.model);
    }
    return createOpenAICompatible({
      name: 'local',
      baseURL: cfg.LOCAL_AI_BASE_URL ?? 'http://localhost:1234/v1',
      // Match the local server's capabilities: report token usage (so cost
      // accounting still runs) and advertise structured-output support (needed
      // for reliable tool calls from gpt-oss on an OpenAI-compatible endpoint).
      includeUsage: true,
      supportsStructuredOutputs: true,
    })(c.model);
  }

  /**
   * Provider-specific options. gpt-oss on Groq supports a `reasoningEffort`
   * knob — we pin it `low` for chat to keep latency/cost down. Returns
   * `undefined` when there is nothing to set so callers can spread it safely.
   */
  static getProviderOptions(task: AITask, env: 'dev' | 'prod'): { groq: { reasoningEffort: 'low' } } | undefined {
    const c = MAP[task][env];
    if (c.provider === 'groq' && c.model.includes('gpt-oss')) {
      return { groq: { reasoningEffort: 'low' as const } };
    }
    return undefined;
  }

  /**
   * USD cost of one model call, using the price table for the providers
   * WalletWise uses:
   *
   *   groq gpt-oss-120b   -> $0.15 / M input, $0.75 / M output, cached = 50% input
   *   groq llama-4-scout  -> $0.10 / M input, $0.10 / M output, cached = 50% input
   *   local               -> $0 (dev runs against a local OpenAI-compatible server)
   *
   * Token counts are coalesced through {@link normalizeUsage} so the ai-sdk v6
   * usage shape (`inputTokens` / `outputTokens` / `cachedInputTokens` /
   * `totalTokens`) and raw provider payloads both work.
   */
  static calculateCost(
    usage: {
      inputTokens?: number;
      outputTokens?: number;
      reasoningTokens?: number;
      cachedInputTokens?: number;
      inputTokenDetails?: {
        cacheReadTokens?: number;
        noCacheTokens?: number;
      };
      outputTokenDetails?: {
        reasoningTokens?: number;
      };
      raw?: Record<string, any>;
    },
    task: AITask,
    env: 'dev' | 'prod',
  ): number {
    const config = this.getModelConfig(task, env);
    const normalizedUsage = this.normalizeUsage(usage);
    let inputCostPerM = 0;
    let cachedInputCostPerM = 0;
    let outputCostPerM = 0;

    // Set pricing based on provider and model.
    switch (config.provider) {
      case 'groq':
        if (config.model.includes('llama-4-maverick')) {
          inputCostPerM = 0.2;
          outputCostPerM = 0.6;
          // cached input is 50% of the input price
          cachedInputCostPerM = inputCostPerM * 0.5;
        } else if (config.model.includes('gpt-oss')) {
          // Groq gpt-oss-120b public pricing (as of 2026-05):
          //   $0.15 / M input, $0.75 / M output, cached input = 50% of input.
          inputCostPerM = 0.15;
          outputCostPerM = 0.75;
          cachedInputCostPerM = inputCostPerM * 0.5; // 0.075
        } else {
          // llama-4-scout / other Groq text models.
          inputCostPerM = 0.1;
          outputCostPerM = 0.1;
          cachedInputCostPerM = inputCostPerM * 0.5;
        }
        break;

      case 'local':
        // Dev runs against a local OpenAI-compatible server (no real $ cost).
        inputCostPerM = 0;
        outputCostPerM = 0;
        cachedInputCostPerM = 0;
        break;

      default:
        // Unknown provider, assume no cost.
        return 0;
    }

    const cachedInputTokens = Math.min(
      normalizedUsage.cachedInputTokens ?? 0,
      normalizedUsage.inputTokens ?? 0,
    );
    const nonCachedInputTokens = Math.max(
      (normalizedUsage.inputTokens ?? 0) - cachedInputTokens,
      0,
    );

    const cost =
      (nonCachedInputTokens * inputCostPerM) / 1_000_000 +
      (cachedInputTokens * cachedInputCostPerM) / 1_000_000 +
      ((normalizedUsage.outputTokens ?? 0) * outputCostPerM) / 1_000_000 +
      ((normalizedUsage.reasoningTokens ?? 0) * outputCostPerM) / 1_000_000;

    return cost;
  }

  /**
   * Normalize a usage object into a flat `{ inputTokens, outputTokens,
   * reasoningTokens, cachedInputTokens, totalTokens, nonCachedInputTokens }`
   * shape. Tolerates the ai-sdk v6 usage shape plus assorted raw provider
   * payload keys.
   */
  static normalizeUsage(usage?: {
    inputTokens?: number;
    outputTokens?: number;
    reasoningTokens?: number;
    cachedInputTokens?: number;
    totalTokens?: number;
    inputTokenDetails?: {
      noCacheTokens?: number;
      cacheReadTokens?: number;
      cacheWriteTokens?: number;
      [key: string]: unknown;
    };
    outputTokenDetails?: {
      textTokens?: number;
      reasoningTokens?: number;
      [key: string]: unknown;
    };
    raw?: Record<string, any>;
    [key: string]: unknown;
  }) {
    const raw = usage?.raw ?? {};
    const promptDetails = raw.prompt_tokens_details ?? raw.promptTokenDetails ?? {};
    const completionDetails = raw.completion_tokens_details ?? raw.completionTokenDetails ?? {};

    const inputTokens = firstFiniteNumber(usage?.inputTokens, raw.prompt_tokens, raw.input_tokens);
    const outputTokens = firstFiniteNumber(
      usage?.outputTokens,
      raw.completion_tokens,
      raw.output_tokens,
    );
    const noCacheTokens = firstFiniteNumber(
      usage?.inputTokenDetails?.noCacheTokens,
      (usage?.inputTokenDetails as any)?.noCache,
      promptDetails.no_cache_tokens,
      promptDetails.noCacheTokens,
    );
    const cachedInputTokens =
      firstFiniteNumber(
        usage?.cachedInputTokens,
        usage?.inputTokenDetails?.cacheReadTokens,
        (usage?.inputTokenDetails as any)?.cacheRead,
        promptDetails.cached_tokens,
        promptDetails.cache_read_tokens,
        promptDetails.cacheReadTokens,
      ) ??
      (inputTokens !== undefined && noCacheTokens !== undefined
        ? Math.max(inputTokens - noCacheTokens, 0)
        : undefined);
    const reasoningTokens = firstFiniteNumber(
      usage?.reasoningTokens,
      usage?.outputTokenDetails?.reasoningTokens,
      (usage?.outputTokenDetails as any)?.reasoning,
      completionDetails.reasoning_tokens,
      completionDetails.reasoningTokens,
    );
    const totalTokens = firstFiniteNumber(
      usage?.totalTokens,
      raw.total_tokens,
      raw.totalTokens,
      inputTokens !== undefined || outputTokens !== undefined
        ? (inputTokens ?? 0) + (outputTokens ?? 0)
        : undefined,
    );

    return {
      inputTokens,
      outputTokens,
      reasoningTokens,
      cachedInputTokens,
      totalTokens,
      nonCachedInputTokens:
        inputTokens !== undefined ? Math.max(inputTokens - (cachedInputTokens ?? 0), 0) : undefined,
    };
  }
}
