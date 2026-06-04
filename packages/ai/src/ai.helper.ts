import { createGroq } from '@ai-sdk/groq';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import type { LanguageModel } from 'ai';

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
}
