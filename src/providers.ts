import { createProviderRegistry, type LanguageModel } from 'ai';
import { createOpenAI } from '@ai-sdk/openai';
import { anthropic } from '@ai-sdk/anthropic';
import { google } from '@ai-sdk/google';
import { deepseek } from '@ai-sdk/deepseek';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';

/**
 * Vendor-agnostic model resolution. LLM_MODEL uses "provider:model" syntax,
 * e.g. "openai:gpt-4o", "anthropic:claude-sonnet-4-5", "google:gemini-2.5-flash",
 * "deepseek:deepseek-chat", "meta:muse-spark-1.2",
 * or "openai-compatible:llama3.1" against LLM_BASE_URL (Ollama, vLLM, LM Studio...).
 */
export function resolveModel(spec: string, baseUrl: string | null): LanguageModel {
  const registry = createProviderRegistry({
    openai: createOpenAI({}),
    anthropic,
    google,
    deepseek,
    // Meta Model API (Muse Spark) — OpenAI-compatible Chat Completions at
    // api.meta.ai, Bearer MODEL_API_KEY (llama.developer.meta.com/docs).
    meta: createOpenAICompatible({
      name: 'meta',
      baseURL: 'https://api.meta.ai/v1',
      apiKey: process.env.MODEL_API_KEY,
    }),
    'openai-compatible': createOpenAICompatible({
      name: 'openai-compatible',
      baseURL: baseUrl ?? 'http://localhost:11434/v1',
    }),
  });
  return registry.languageModel(
    spec as Parameters<typeof registry.languageModel>[0],
  );
}
