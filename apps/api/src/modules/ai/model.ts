import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import type { z } from "zod";

import { AppError, ErrorCode } from "../../lib/errors.js";

/**
 * What the assistant needs from a language model. AnthropicModel calls
 * Claude; tests use a scripted fake. The model only ever advises: nothing it
 * returns is executed without Shipyard's own checks and a person's click.
 */
export interface AiModel {
  /** One answer, parsed and validated against `schema`. */
  structured<S extends z.ZodType>(input: { system: string; prompt: string; schema: S }): Promise<z.infer<S>>;
  /** One turn of a tool-using conversation. */
  turn(input: {
    system: string;
    messages: Anthropic.Beta.BetaMessageParam[];
    tools: Anthropic.Beta.BetaTool[];
  }): Promise<Anthropic.Beta.BetaMessage>;
}

/** Server-side fallback: if a safety classifier declines, the API retries on a suitable model within the same call. */
function fallback(): {
  betas: Anthropic.Beta.AnthropicBeta[];
  fallbacks: "default";
} {
  return { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" };
}

export class AnthropicModel implements AiModel {
  private readonly client: Anthropic;

  /** Credentials come from the environment (ANTHROPIC_API_KEY, or an `ant auth login` profile). */
  constructor(private readonly model: string) {
    this.client = new Anthropic();
  }

  async structured<S extends z.ZodType>(input: { system: string; prompt: string; schema: S }): Promise<z.infer<S>> {
    const response = await this.call(() =>
      this.client.beta.messages.parse({
        ...fallback(),
        model: this.model,
        max_tokens: 16000,
        output_config: {
          effort: "medium",
          format: betaZodOutputFormat(input.schema),
        },
        system: input.system,
        messages: [{ role: "user", content: input.prompt }],
      }),
    );
    if (response.stop_reason === "refusal") throw refused();
    if (response.parsed_output === null || response.parsed_output === undefined) {
      throw new AppError(ErrorCode.AI_FAILED, "The assistant's answer wasn't in the expected shape. Try again.", { statusCode: 502 });
    }
    return response.parsed_output as z.infer<S>;
  }

  async turn(input: {
    system: string;
    messages: Anthropic.Beta.BetaMessageParam[];
    tools: Anthropic.Beta.BetaTool[];
  }): Promise<Anthropic.Beta.BetaMessage> {
    const response = await this.call(() =>
      this.client.beta.messages.create({
        ...fallback(),
        stream: false,
        model: this.model,
        max_tokens: 16000,
        output_config: { effort: "medium" },
        system: input.system,
        tools: input.tools,
        messages: input.messages,
      }),
    );
    if (response.stop_reason === "refusal") throw refused();
    return response;
  }

  private async call<T>(request: () => Promise<T>): Promise<T> {
    try {
      return await request();
    } catch (error) {
      if (error instanceof Anthropic.RateLimitError) {
        throw new AppError(ErrorCode.AI_UNAVAILABLE, "The assistant is rate limited right now. Try again in a minute.", {
          statusCode: 503,
        });
      }
      if (error instanceof Anthropic.AuthenticationError) {
        throw new AppError(ErrorCode.AI_UNAVAILABLE, "The assistant's API key was refused. Check ANTHROPIC_API_KEY.", { statusCode: 503 });
      }
      if (error instanceof Anthropic.APIError) {
        throw new AppError(ErrorCode.AI_UNAVAILABLE, `The assistant isn't available (${error.status ?? "network"}). Try again.`, {
          statusCode: 503,
        });
      }
      throw error;
    }
  }
}

function refused(): AppError {
  return new AppError(ErrorCode.AI_FAILED, "The assistant declined to answer this one.", { statusCode: 422 });
}
