/** Something a bot is about to do that the safety policy must check first. */
export type PolicyAction =
  | { kind: "read"; path: string }
  | { kind: "write"; path: string }
  | { kind: "command"; command: string; cwd: string };

export interface PolicyContext {
  botId: string;
  workspacePath: string;
}

export type PolicyDecision = { allow: true } | { allow: false; reason: string };

/**
 * Safety rules (docs/ARCHITECTURE.md §7a): almost everything is allowed without asking; folder
 * limits and a block list refuse what could break the Mac or bench_bot. Paths are absolute.
 */
export interface PolicyService {
  check(action: PolicyAction, ctx: PolicyContext): PolicyDecision;
}
