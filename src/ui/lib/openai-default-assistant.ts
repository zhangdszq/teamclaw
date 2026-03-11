export type OpenAIDefaultAssistantMigrationReason =
  | "switched"
  | "already-openai"
  | "has-claude-auth"
  | "multiple-assistants"
  | "unsupported-default-assistant"
  | "unsupported-provider"
  | "no-default-assistant";

export type OpenAIDefaultAssistantMigrationResult = {
  config: AssistantsConfig;
  changed: boolean;
  reason: OpenAIDefaultAssistantMigrationReason;
};

function getResolvedDefaultAssistant(config: AssistantsConfig): AssistantConfig | undefined {
  const defaultId = config.defaultAssistantId ?? config.assistants[0]?.id;
  return config.assistants.find((assistant) => assistant.id === defaultId);
}

export function defaultAssistantUsesProvider(
  config: AssistantsConfig,
  provider: AssistantConfig["provider"],
): boolean {
  return getResolvedDefaultAssistant(config)?.provider === provider;
}

export function maybeSwitchDefaultAssistantToOpenAI(
  config: AssistantsConfig,
  options: { hasClaudeAuth: boolean },
): OpenAIDefaultAssistantMigrationResult {
  const defaultAssistant = getResolvedDefaultAssistant(config);
  if (!defaultAssistant) {
    return { config, changed: false, reason: "no-default-assistant" };
  }

  if (defaultAssistant.provider === "openai") {
    return { config, changed: false, reason: "already-openai" };
  }

  if (options.hasClaudeAuth) {
    return { config, changed: false, reason: "has-claude-auth" };
  }

  if (config.assistants.length !== 1) {
    return { config, changed: false, reason: "multiple-assistants" };
  }

  if (defaultAssistant.id !== "default-assistant") {
    return { config, changed: false, reason: "unsupported-default-assistant" };
  }

  if (defaultAssistant.provider !== "claude") {
    return { config, changed: false, reason: "unsupported-provider" };
  }

  return {
    config: {
      ...config,
      assistants: config.assistants.map((assistant) =>
        assistant.id === defaultAssistant.id
          ? { ...assistant, provider: "openai" }
          : assistant,
      ),
    },
    changed: true,
    reason: "switched",
  };
}
