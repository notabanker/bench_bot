export interface FsEntry {
  name: string;
  kind: "file" | "dir";
  size?: number;
}

/**
 * Files inside one bot workspace. Every `path` is relative to `workspacePath`; a path that
 * resolves outside it (`../`, absolute paths, symlinks out) is rejected with an error.
 */
export interface FsService {
  read(workspacePath: string, path: string): Promise<string>;
  /** Creates missing parent folders. */
  write(workspacePath: string, path: string, content: string): Promise<void>;
  /** Lists one folder; `path` defaults to the workspace root. */
  list(workspacePath: string, path?: string): Promise<FsEntry[]>;
}
