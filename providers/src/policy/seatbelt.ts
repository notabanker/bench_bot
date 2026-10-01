import { realpathSync } from "node:fs";

/** Quotes a path for the macOS sandbox profile language. */
function sbplString(path: string): string {
  return `"${path.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function withRealPaths(paths: string[]): string[] {
  const out = new Set<string>();
  for (const p of paths) {
    out.add(p);
    try {
      out.add(realpathSync(p));
    } catch {}
  }
  return [...out];
}

/**
 * A macOS sandbox (Seatbelt) profile: everything allowed except writing to `denied`, with
 * `allowed` carved back out. Later rules win, so the order matters.
 */
export function seatbeltProfile(paths: { denied: string[]; allowed: string[] }): string {
  const rule = (paths: string[]) =>
    withRealPaths(paths)
      .map((p) =>
        p.startsWith("/dev/") ? `(literal ${sbplString(p)})` : `(subpath ${sbplString(p)})`,
      )
      .join(" ");
  return [
    "(version 1)",
    "(allow default)",
    `(deny file-write* ${rule(paths.denied)})`,
    `(allow file-write* ${rule(paths.allowed)} (regex #"^/dev/ttys[0-9]+$") (regex #"^/dev/fd/"))`,
    "",
  ].join("\n");
}

export interface SandboxedCommand {
  command: string;
  args: string[];
  /** False where no sandbox exists (only macOS has one); the program then runs unconfined. */
  confined: boolean;
}

/** Wraps a program start in `sandbox-exec` on macOS. */
export function sandboxed(
  command: string,
  args: string[],
  paths: { denied: string[]; allowed: string[] },
  platform: NodeJS.Platform = process.platform,
): SandboxedCommand {
  if (platform !== "darwin") return { command, args, confined: false };
  return {
    command: "/usr/bin/sandbox-exec",
    args: ["-p", seatbeltProfile(paths), command, ...args],
    confined: true,
  };
}
