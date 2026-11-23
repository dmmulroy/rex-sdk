import { OpenAiLanguageModel } from "@effect/ai-openai";
import { TypeSafeClient, TypeSafeDecisionModel } from "@effect/ai-typesafe";
import { Config, Layer } from "effect";
import type { TraitsConfig } from "traits";

import { chatGptSubscriptionOpenAiClientLayer } from "./traits-chatgpt-subscription-client.ts";

const typeSafeClientLayer = TypeSafeClient.layerConfig({
  apiKey: Config.Redacted("TYPESAFE_API_KEY"),
});

/**
 * Traits configuration that checks code with TypeSafe Jev and drafts traits with GPT-6.1 Terra
 * through pi's ChatGPT subscription sign-in.
 *
 * **Gotchas**
 *
 * Needs `TYPESAFE_API_KEY` in the environment and an `openai-codex` sign-in in pi; Traits
 * fails to start without both.
 */
export default {
  excludes: ["src/generated/**", "schema/**", "pnpm-lock.yaml"],
  layerDecisionModel: TypeSafeDecisionModel.layer({ model: "jev-latest" }).pipe(
    Layer.provide(typeSafeClientLayer),
  ),
  layerLanguageModel: OpenAiLanguageModel.layer({ model: "gpt-6.1-terra" }).pipe(
    Layer.provide(chatGptSubscriptionOpenAiClientLayer),
  ),
} satisfies TraitsConfig;
