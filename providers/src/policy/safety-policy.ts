import { realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type {
  PolicyAction,
  PolicyContext,
  PolicyDecision,
  PolicyService,
} from "@bench_bot/services";

export interface SafetyPolicyOptions {
  /** The user's home folder. */
  home: string;
  /** bench_bot's own data (database, other bots' workspaces) and program folders. */
  protectedPaths: string[];
}

/** System folders no bot may write to. Exceptions inside them are listed in WRITABLE_SYSTEM_PATHS. */
export const SYSTEM_PATHS = [
  "/System",
  "/Library",
  "/Applications",
  "/bin",
  "/sbin",
  "/usr",
  "/etc",
  "/private/etc",
  "/var",
  "/private/var",
  "/dev",
  "/cores",
  "/boot",
  "/lib",
  "/lib64",
  "/proc",
  "/sys",
];

/** Places inside SYSTEM_PATHS that normal programs must be able to write (temp files, Homebrew). */
export const WRITABLE_SYSTEM_PATHS = [
  "/usr/local",
  "/var/folders",
  "/private/var/folders",
  "/var/tmp",
  "/private/var/tmp",
  "/tmp",
  "/private/tmp",
  "/dev/null",
  "/dev/zero",
  "/dev/tty",
  "/dev/stdout",
  "/dev/stderr",
  "/dev/fd",
];

/** Folders inside the home folder that can lock the user out or start programs at login. */
export const PROTECTED_HOME_PATHS = [
  "Library/Keychains",
  "Library/LaunchAgents",
  "Library/LaunchDaemons",
];

interface CommandRule {
  pattern: RegExp;
  reason: string;
}

/**
 * Matches where a program name starts: the beginning of the line, after ; & | ( ` or $(, or
 * after a launcher such as env/xargs/nohup. So `grep reboot notes.txt` is fine, `reboot` is not.
 */
const AT_COMMAND = String.raw`(?:^|[;&|(\x60]\s*|\$\(\s*|\b(?:env|xargs|nohup|exec|time|command|nice|watch)\s+(?:\S+=\S*\s+|-\S+\s+)*)`;
const END = String.raw`(?=\s|$|;|&|\||\))`;
const cmd = (names: string, rest = END) => new RegExp(`${AT_COMMAND}(?:${names})${rest}`);

/** Commands refused in a command line. (default — adjust) */
export const COMMAND_RULES: CommandRule[] = [
  { pattern: cmd("sudo|doas|pkexec"), reason: "admin rights (sudo) are not allowed" },
  {
    pattern: cmd("su", String.raw`(?=\s+-|\s*$|\s+root)`),
    reason: "switching to another user is not allowed",
  },
  {
    pattern: cmd(String.raw`mkfs(?:\.\w+)?|newfs_\w+|fdisk|gpt|parted`),
    reason: "formatting or partitioning disks is not allowed",
  },
  {
    pattern:
      /\bdiskutil\s+(erase\w*|reformat|partitionDisk|zeroDisk|randomDisk|secureErase|apfs\s+(delete\w*|eraseVolume)|resizeVolume|unmountDisk)\b/i,
    reason: "erasing or changing disks is not allowed",
  },
  {
    pattern: /\bdd\b[^\n]*\bof=\/dev\//,
    reason: "writing raw data to a disk device is not allowed",
  },
  {
    pattern: cmd("shutdown|reboot|halt|poweroff"),
    reason: "shutting down or restarting the computer is not allowed",
  },
  {
    pattern: cmd("csrutil|nvram|spctl|systemsetup|fdesetup|bless|kextload|kextunload|kmutil"),
    reason: "changing macOS system security settings is not allowed",
  },
  {
    pattern: /\blaunchctl\s+(bootout|unload|remove|disable|reboot)\b/,
    reason: "stopping system services is not allowed",
  },
  { pattern: cmd("pmset"), reason: "changing power settings is not allowed" },
  {
    pattern: /\btmutil\s+(delete\w*|disable)\b/,
    reason: "deleting Time Machine backups is not allowed",
  },
  {
    pattern:
      /\brm\s+(-[^\s]*\s+)*(--\s+)?("|')?(\/|~|\$HOME|\/\*|~\/\*|\$HOME\/\*|\/(System|Library|Applications|Users|usr|bin|sbin|etc|var|private)(\/\*)?)("|')?(\s|$|;|&|\|)/,
    reason: "deleting system folders or the whole home folder is not allowed",
  },
  {
    pattern:
      /\b(chmod|chown|chflags)\s+(-[^\s]*\s+)*\S+\s+("|')?(\/|\/(System|Library|usr|bin|sbin|etc|var|private|Users))("|')?(\s|$)/,
    reason: "changing permissions of system folders is not allowed",
  },
  { pattern: /:\(\)\s*\{\s*:\s*\|\s*:/, reason: "fork bombs are not allowed" },
  {
    pattern:
      /\bkillall\s+(-\S+\s+)*(Finder|Dock|WindowServer|loginwindow|launchd|SystemUIServer)\b/,
    reason: "stopping core macOS processes is not allowed",
  },
  { pattern: /\bkill\s+(-\S+\s+)*1(\s|$)/, reason: "stopping core macOS processes is not allowed" },
];

/**
 * The safety rules (docs/ARCHITECTURE.md §7a): almost everything is allowed without asking;
 * folder limits and a block list refuse what could break the Mac or bench_bot itself.
 */
export class SafetyPolicy implements PolicyService {
  readonly #home: string;
  readonly #protected: string[];

  constructor(options: SafetyPolicyOptions) {
    this.#home = resolve(options.home);
    this.#protected = options.protectedPaths.map((p) => resolve(p));
  }

  check(action: PolicyAction, ctx: PolicyContext): PolicyDecision {
    switch (action.kind) {
      case "read":
        return { allow: true };
      case "write":
        return this.checkWrite(action.path, ctx.workspacePath);
      case "command":
        return checkCommand(action.command);
    }
  }

  checkWrite(path: string, workspacePath: string): PolicyDecision {
    const target = realish(path);
    const workspace = realish(workspacePath);
    if (within(workspace, target)) return { allow: true };
    if (this.#protected.some((p) => within(realish(p), target))) {
      return { allow: false, reason: "bench_bot's own program and data are protected" };
    }
    for (const sub of PROTECTED_HOME_PATHS) {
      if (within(realish(join(this.#home, sub)), target)) {
        return { allow: false, reason: `~/${sub} is protected (keychain and login items)` };
      }
    }
    if (WRITABLE_SYSTEM_PATHS.some((p) => within(p, target) || within(realish(p), target)))
      return { allow: true };
    if (SYSTEM_PATHS.some((p) => within(p, target) || within(realish(p), target))) {
      return { allow: false, reason: "system folders are protected" };
    }
    if (target === "/" || target === this.#home)
      return {
        allow: false,
        reason: "the top of the disk and the home folder itself are protected",
      };
    return { allow: true };
  }

  /** Paths for the macOS sandbox profile. */
  sandboxPaths(workspacePath: string): { denied: string[]; allowed: string[] } {
    return {
      denied: [
        ...SYSTEM_PATHS,
        ...this.#protected,
        ...PROTECTED_HOME_PATHS.map((p) => join(this.#home, p)),
      ],
      allowed: [workspacePath, ...WRITABLE_SYSTEM_PATHS],
    };
  }
}

export function checkCommand(command: string): PolicyDecision {
  for (const rule of COMMAND_RULES) {
    if (rule.pattern.test(command)) return { allow: false, reason: rule.reason };
  }
  return { allow: true };
}

function within(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

/** Resolves symlinks of the deepest existing ancestor (macOS: /tmp → /private/tmp). */
function realish(path: string): string {
  let current = resolve(path);
  const rest: string[] = [];
  for (;;) {
    try {
      return join(realpathSync(current), ...rest.reverse());
    } catch {
      const parent = dirname(current);
      if (parent === current) return resolve(path);
      rest.push(current.slice(parent.length + 1));
      current = parent;
    }
  }
}
