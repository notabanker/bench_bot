import { join } from "node:path";
import type { FsService, PolicyService, ToolDefinition, ToolResult } from "@bench_bot/services";

/** Reads `args[key]` as a non-empty string or throws a message the model can act on. */
export function stringArg(args: unknown, key: string): string {
  const value = (args as Record<string, unknown> | null)?.[key];
  if (typeof value !== "string" || value === "") {
    throw new Error(`Argument "${key}" must be a non-empty string`);
  }
  return value;
}

function blockedResult(action: string, reason: string): ToolResult {
  return {
    ok: false,
    output: `Refused by the safety rules: ${reason}`,
    blocked: { action, reason },
  };
}

/**
 * fs_read, fs_write, fs_list: files inside the bot's own workspace. When a policy is given, each
 * call is checked first (Phase 10).
 */
export function fsTools(fs: FsService, policy?: PolicyService): ToolDefinition[] {
  const pathParam = {
    path: { type: "string", description: "Path relative to your workspace folder" },
  };
  const check = (kind: "read" | "write", workspacePath: string, path: string, botId: string) =>
    policy?.check({ kind, path: join(workspacePath, path) }, { botId, workspacePath });

  return [
    {
      schema: {
        name: "fs_read",
        description: "Read a text file from your workspace folder.",
        parameters: {
          type: "object",
          properties: pathParam,
          required: ["path"],
          additionalProperties: false,
        },
      },
      async run(args, ctx) {
        const path = stringArg(args, "path");
        const decision = check("read", ctx.workspacePath, path, ctx.botId);
        if (decision && !decision.allow) return blockedResult(`read ${path}`, decision.reason);
        return { ok: true, output: await fs.read(ctx.workspacePath, path) };
      },
    },
    {
      schema: {
        name: "fs_write",
        description:
          "Create or overwrite a text file in your workspace folder. Missing folders are created.",
        parameters: {
          type: "object",
          properties: {
            ...pathParam,
            content: { type: "string", description: "The full file content" },
          },
          required: ["path", "content"],
          additionalProperties: false,
        },
      },
      async run(args, ctx) {
        const path = stringArg(args, "path");
        const content = (args as { content?: unknown }).content;
        if (typeof content !== "string") throw new Error('Argument "content" must be a string');
        const decision = check("write", ctx.workspacePath, path, ctx.botId);
        if (decision && !decision.allow) return blockedResult(`write ${path}`, decision.reason);
        await fs.write(ctx.workspacePath, path, content);
        return { ok: true, output: `Wrote ${content.length} characters to ${path}` };
      },
    },
    {
      schema: {
        name: "fs_list",
        description: "List files and folders in your workspace folder (or a sub-folder).",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string", description: "Sub-folder; omit for the workspace root" },
          },
          additionalProperties: false,
        },
      },
      async run(args, ctx) {
        const raw = (args as { path?: unknown } | null)?.path;
        const path = typeof raw === "string" && raw ? raw : ".";
        const entries = await fs.list(ctx.workspacePath, path);
        if (entries.length === 0) return { ok: true, output: "(empty)" };
        return {
          ok: true,
          output: entries
            .map((e) => (e.kind === "dir" ? `${e.name}/` : `${e.name} (${e.size} bytes)`))
            .join("\n"),
        };
      },
    },
  ];
}
