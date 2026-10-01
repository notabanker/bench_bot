/** What the model sees about a tool. `parameters` is a JSON Schema object. */
export interface ToolSchema {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface ToolContext {
  botId: string;
  threadId: string;
  runId: string;
  workspacePath: string;
  /** Bots already in this ask-chain, the calling bot last. Used to stop ask_bot loops. */
  chain: string[];
  signal?: AbortSignal;
}

/** `ok: false` is a normal outcome (file not found, refused by policy); the model reads `output`. */
export interface ToolResult {
  ok: boolean;
  output: string;
  /** Set when the safety policy refused the action; becomes a `blocked` event. */
  blocked?: { action: string; reason: string };
}

export interface ToolDefinition {
  schema: ToolSchema;
  run(args: unknown, ctx: ToolContext): Promise<ToolResult>;
}

export interface ToolService {
  /** Throws if a tool with the same name is already registered. */
  register(tool: ToolDefinition): void;
  /** Schemas of the named tools (all tools when `names` is omitted). Unknown names are skipped. */
  schemas(names?: readonly string[]): ToolSchema[];
  /** Never throws: an unknown tool or a crashing tool becomes `{ ok: false }`. */
  run(name: string, args: unknown, ctx: ToolContext): Promise<ToolResult>;
}
