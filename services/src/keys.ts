import { ServiceKey } from "@bench_bot/kernel";
import type { BotDirectory } from "./bot.ts";
import type { DelegationService } from "./delegation.ts";
import type { FsService } from "./fs.ts";
import type { HarnessCatalog } from "./harness.ts";
import type { LlmService } from "./llm.ts";
import type { PolicyService } from "./policy.ts";
import type { QueueService } from "./queue.ts";
import type { SessionService } from "./session.ts";
import type { ToolService } from "./tool.ts";

/** The kernel keys of every service. Register implementations under these, never under strings. */
export const Services = {
  bots: new ServiceKey<BotDirectory>("bots"),
  delegation: new ServiceKey<DelegationService>("delegation"),
  fs: new ServiceKey<FsService>("fs"),
  harnesses: new ServiceKey<HarnessCatalog>("harnesses"),
  llm: new ServiceKey<LlmService>("llm"),
  policy: new ServiceKey<PolicyService>("policy"),
  queue: new ServiceKey<QueueService>("queue"),
  session: new ServiceKey<SessionService>("session"),
  tools: new ServiceKey<ToolService>("tools"),
} as const;
