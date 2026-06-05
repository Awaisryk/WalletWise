import {
  Output,
  generateText,
  type FlexibleSchema,
  type JSONValue,
  type LanguageModel,
  type LanguageModelUsage,
  type ModelMessage,
} from "ai";

type StructuredOutputPrompt =
  | {
      prompt: string;
      messages?: never;
    }
  | {
      messages: ModelMessage[];
      prompt?: never;
    };

export type GenerateStructuredObjectArgs<T> = StructuredOutputPrompt & {
  model: LanguageModel;
  schema: FlexibleSchema<T>;
  schemaName?: string;
  schemaDescription?: string;
  system?: string;
  temperature?: number;
  maxOutputTokens?: number;
  maxRetries?: number;
  providerOptions?: Record<string, Record<string, JSONValue>>;
};

export interface GenerateStructuredObjectResult<T> {
  object: T;
  usage: LanguageModelUsage;
}

export async function generateStructuredObject<T>(
  args: GenerateStructuredObjectArgs<T>,
): Promise<GenerateStructuredObjectResult<T>> {
  const {
    model,
    schema,
    schemaName,
    schemaDescription,
    system,
    temperature,
    maxOutputTokens,
    maxRetries,
    providerOptions,
    ...prompt
  } = args;

  const result = await generateText({
    model,
    system,
    ...prompt,
    temperature,
    ...(providerOptions ? { providerOptions } : {}),
    maxOutputTokens,
    maxRetries,
    output: Output.object({
      schema,
      name: schemaName,
      description: schemaDescription,
    }),
  });

  return {
    object: result.output as T,
    usage: result.usage,
  };
}
