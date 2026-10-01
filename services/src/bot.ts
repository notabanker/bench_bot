/** A bot as defined in its config file: Bot = identity + instructions + model + harness + tools. */
export interface BotDefinition {
  id: string;
  name: string;
  /** One line shown in the roster and to other bots deciding whom to ask. */
  description: string;
  instructions: string;
  /** Model id as the harness understands it, e.g. an OpenCode Go model id. */
  model: string;
  /** Id of a registered harness factory: "generic-loop", "opencode", "prime-agent". */
  harness: string;
  /** Names of the tools this bot may use. */
  tools: string[];
  /** Absolute path of this bot's own work folder. */
  workspacePath: string;
  /** Optional sidebar group. */
  section?: string;
}

/** The roster: every bot the app knows about. */
export interface BotDirectory {
  list(): Promise<BotDefinition[]>;
  /** Resolves to undefined when no bot has this id. */
  get(botId: string): Promise<BotDefinition | undefined>;
}
