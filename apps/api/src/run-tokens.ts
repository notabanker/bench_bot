import { randomBytes } from "node:crypto";
import type { ToolContext } from "@bench_bot/services";

interface Grant {
  ctx: ToolContext;
  tools: string[];
  controller: AbortController;
}

/**
 * One-time passwords for engine-side tool bridges. A token is valid only while its run lasts and
 * only for the tools the bot may use; revoking it aborts any tool call still running.
 */
export class RunTokens {
  readonly #grants = new Map<string, Grant>();

  issue(ctx: Omit<ToolContext, "signal">, tools: string[]): { token: string; revoke: () => void } {
    const token = randomBytes(24).toString("base64url");
    const controller = new AbortController();
    this.#grants.set(token, { ctx: { ...ctx, signal: controller.signal }, tools, controller });
    return {
      token,
      revoke: () => {
        controller.abort();
        this.#grants.delete(token);
      },
    };
  }

  get(token: string | undefined): Grant | undefined {
    return token ? this.#grants.get(token) : undefined;
  }
}
