import type {
  ToolContext,
  ToolDefinition,
  ToolResult,
  ToolSchema,
  ToolService,
} from "@bench_bot/services";

export class ToolRegistry implements ToolService {
  readonly #tools = new Map<string, ToolDefinition>();

  register(tool: ToolDefinition): void {
    const name = tool.schema.name;
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(name)) {
      // OpenAI-style APIs reject other names, so catch it at registration, not mid-run.
      throw new Error(`Tool name "${name}" must match [a-zA-Z0-9_-]{1,64}`);
    }
    if (this.#tools.has(name)) throw new Error(`Tool "${name}" is already registered`);
    this.#tools.set(name, tool);
  }

  schemas(names?: readonly string[]): ToolSchema[] {
    const picked = names
      ? names.flatMap((n) => this.#tools.get(n) ?? [])
      : [...this.#tools.values()];
    return picked.map((t) => t.schema);
  }

  async run(name: string, args: unknown, ctx: ToolContext): Promise<ToolResult> {
    const tool = this.#tools.get(name);
    if (!tool) return { ok: false, output: `Unknown tool "${name}"` };
    try {
      return await tool.run(args, ctx);
    } catch (error) {
      return { ok: false, output: error instanceof Error ? error.message : String(error) };
    }
  }
}
