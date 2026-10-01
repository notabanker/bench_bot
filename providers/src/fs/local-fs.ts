import { mkdir, readdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { FsEntry, FsService } from "@bench_bot/services";

export class OutsideWorkspaceError extends Error {
  constructor(readonly path: string) {
    super(`"${path}" is outside the bot's workspace`);
    this.name = "OutsideWorkspaceError";
  }
}

/** Largest file `read` returns, so one tool call cannot flood the model's context. */
export const MAX_READ_BYTES = 256 * 1024;

/** FsService on the local disk, confined to one workspace folder per call. */
export class LocalFs implements FsService {
  async read(workspacePath: string, path: string): Promise<string> {
    const target = await this.resolve(workspacePath, path);
    const info = await stat(target);
    if (info.size > MAX_READ_BYTES) {
      throw new Error(`"${path}" is ${info.size} bytes; the limit is ${MAX_READ_BYTES}`);
    }
    return readFile(target, "utf8");
  }

  async write(workspacePath: string, path: string, content: string): Promise<void> {
    const target = await this.resolve(workspacePath, path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content, "utf8");
  }

  async list(workspacePath: string, path = "."): Promise<FsEntry[]> {
    const target = await this.resolve(workspacePath, path);
    let names: string[];
    try {
      names = await readdir(target);
    } catch (error) {
      if (isNotFound(error) && path === ".") return []; // A fresh workspace may not exist yet.
      throw error;
    }
    const entries = await Promise.all(
      names.sort().map(async (name): Promise<FsEntry> => {
        const info = await stat(join(target, name));
        return info.isDirectory() ? { name, kind: "dir" } : { name, kind: "file", size: info.size };
      }),
    );
    return entries;
  }

  /**
   * Absolute path of `path` inside the workspace. Rejects absolute paths, `..` escapes and
   * symlinks that point outside, by checking the real path of the deepest existing ancestor.
   */
  async resolve(workspacePath: string, path: string): Promise<string> {
    if (isAbsolute(path)) throw new OutsideWorkspaceError(path);
    const root = resolve(workspacePath);
    const target = resolve(root, path);
    if (!isInside(root, target)) throw new OutsideWorkspaceError(path);

    await mkdir(root, { recursive: true });
    const realRoot = await realpath(root);
    const realTarget = await realpathOfExisting(target);
    if (!isInside(realRoot, realTarget)) throw new OutsideWorkspaceError(path);
    return target;
  }
}

function isInside(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

/** Real path of `target`, or of its deepest existing ancestor joined with the missing rest. */
async function realpathOfExisting(target: string): Promise<string> {
  let current = target;
  const missing: string[] = [];
  for (;;) {
    try {
      return join(await realpath(current), ...missing.reverse());
    } catch (error) {
      if (!isNotFound(error)) throw error;
      const parent = dirname(current);
      if (parent === current) throw error;
      missing.push(current.slice(parent.length + 1));
      current = parent;
    }
  }
}

function isNotFound(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === "ENOENT";
}
