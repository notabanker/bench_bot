export interface BotSummary {
  id: string;
  name: string;
  description: string;
}

export interface AskBotRequest {
  fromBotId: string;
  toBotId: string;
  text: string;
  /** How many asks deep this chain already is; 0 when a user message started it. */
  depth: number;
}

export type AskBotResult = { ok: true; answer: string } | { ok: false; reason: string };

/** Bots asking bots: the `list_bots` and `ask_bot` tools. */
export interface DelegationService {
  /** Every bot the caller may ask, without the caller itself. */
  listBots(callerBotId: string): Promise<BotSummary[]>;
  /** Never throws: asking itself, an unknown bot or a too-deep chain becomes `{ ok: false }`. */
  askBot(request: AskBotRequest): Promise<AskBotResult>;
}
