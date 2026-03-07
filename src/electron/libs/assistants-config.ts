import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { EventEmitter } from "events";
import { loadUserSettings } from "./user-settings.js";

// Emits "bot-owner-ids-changed" with { assistantId, platform } when auto-populated
export const assistantConfigEvents = new EventEmitter();

export type AssistantConfig = {
  id: string;
  name: string;
  avatar?: string;
  provider: "claude" | "codex";
  model?: string;
  /** Per-assistant API key — overrides global anthropicAuthToken when set */
  apiAuthToken?: string;
  /** Per-assistant API base URL — overrides global anthropicBaseUrl when set */
  apiBaseUrl?: string;
  skillNames?: string[];
  skillTags?: string[];
  persona?: string;
  coreValues?: string;
  relationship?: string;
  cognitiveStyle?: string;
  operatingGuidelines?: string;
  heartbeatInterval?: number;
  heartbeatRules?: string;
  defaultCwd?: string;
  bots?: Record<string, unknown>;
};

export type AssistantsConfig = {
  assistants: AssistantConfig[];
  defaultAssistantId?: string;
  userContext?: string;
};

const VK_COWORK_DIR = join(homedir(), ".vk-cowork");
const ASSISTANTS_FILE = join(VK_COWORK_DIR, "assistants-config.json");

/**
 * Determine which provider to use for the default assistant based on what has
 * been configured.  Claude takes priority when both are available, because
 * it is the primary agent framework and users who have also logged into
 * OpenAI still expect Claude to be the default.
 *
 * - Claude: anthropicAuthToken in user-settings  OR  ANTHROPIC_AUTH_TOKEN env var
 * - Codex:  openaiTokens in user-settings  OR  ~/.codex/auth.json exists
 *
 * Falls back to "claude" when neither is configured.
 */
export function resolveDefaultProvider(): "claude" | "codex" {
  const settings = loadUserSettings();

  const hasClaude =
    !!settings.anthropicAuthToken ||
    !!process.env.ANTHROPIC_AUTH_TOKEN;

  const hasCodex =
    !!settings.openaiTokens?.accessToken ||
    existsSync(join(homedir(), ".codex", "auth.json"));

  if (hasClaude) return "claude";
  if (hasCodex) return "codex";
  return "claude";
}

// ─── Per-assistant defaults (backfilled on upgrade) ─────────────────────────

export const DEFAULT_PERSONA = `你是小助理，用户的私人 AI 伙伴。
- 有温度但不啰嗦，像一个靠谱的老同事
- 你有自己的判断力和性格，不是一个无条件顺从的工具
- 你记得和用户之间发生过的事情，会基于共同经历调整自己的行为`;

export const DEFAULT_CORE_VALUES = `1. 有用比好听重要 — 不表演、不客套、不堆砌，直接给方案和结果
2. 接手就负责 — 不回来说"我做不到因为…"，带着解决方案回来
3. 提前想一步 — 最好的帮助是不需要开口要的
4. 诚实沟通 — 不确定就说不确定，做错了就承认，不回避实质问题
5. 尊重隐私 — 不主动探询用户不愿分享的信息，对已知隐私严格保密`;

export const DEFAULT_RELATIONSHIP = `我为你工作，但不卑不亢。更像一个值得信赖的幕僚：
- 被问到时给出真实看法，不说"你说得对但是…"这类废话
- 认为重要时主动提建议，而不是等着被问
- 对明显有问题的事情会礼貌反驳一次，但不反复纠缠
- 最终尊重你的决定，执行时全力以赴
- 关系随时间成长 — 合作越久越了解你的偏好，不需要反复解释`;

export const DEFAULT_COGNITIVE_STYLE = `- 默认行动：明显有帮助就直接做，不为小事请示
- 大事请示：对外沟通、重大决策、不可逆操作先确认
- 记下来：可能以后有用的信息先记录到记忆
- 从纠正中学习：你指出的问题我会更新认知，不犯同样的错
- 结构化思维：复杂问题先拆解再逐步解决，不一股脑堆砌
- 承认边界：超出能力范围的事坦诚说明，给出替代方案`;

export const DEFAULT_OPERATING_GUIDELINES = `- 直接给出结果，不要叙述思考过程或执行步骤
- 调用工具时保持沉默，只在工具全部完成后给出结论
- 禁止把工具调用的中间状态、路径、API 返回值写进最终回复
- 遇到障碍时主动换方法重试，穷尽所有途径
- 截图/发文件类任务：工具执行完只需回复"已完成"或简短说明
- 多步骤任务先做完再汇报，不要边做边播报进度`;

export const DEFAULT_HEARTBEAT_RULES = `- 结合今日记忆，识别未完成的待办/任务/承诺事项
- 发现可推进或逾期的任务时，使用 send_notification 工具主动推送给用户
- 重要/紧急事项立即汇报并推送
- 不重要的信息积累到日报，不主动推送
- 没有值得汇报的事就输出 <no-action> 保持沉默
- 晚 22 点至早 8 点只报紧急事项
- 汇报时简明扼要，不重复已知信息`;

export const DEFAULT_USER_CONTEXT = "";

function buildDefaultAssistants(): AssistantConfig[] {
  return [
    {
      id: "default-assistant",
      name: "小助理",
      provider: resolveDefaultProvider(),
      skillNames: [],
      persona: DEFAULT_PERSONA,
      coreValues: DEFAULT_CORE_VALUES,
      relationship: DEFAULT_RELATIONSHIP,
      cognitiveStyle: DEFAULT_COGNITIVE_STYLE,
      operatingGuidelines: DEFAULT_OPERATING_GUIDELINES,
      heartbeatInterval: 30,
      heartbeatRules: DEFAULT_HEARTBEAT_RULES,
    },
  ];
}

function buildDefaultConfig(): AssistantsConfig {
  const assistants = buildDefaultAssistants();
  return {
    assistants,
    defaultAssistantId: assistants[0]?.id,
  };
}

function ensureDirectory() {
  if (!existsSync(VK_COWORK_DIR)) {
    mkdirSync(VK_COWORK_DIR, { recursive: true });
  }
}

function optStr(val: unknown): string | undefined {
  return val ? String(val) : undefined;
}

function normalizeConfig(input?: Partial<AssistantsConfig> | null): AssistantsConfig {
  const rawAssistants = Array.isArray(input?.assistants) ? input.assistants : [];
  const assistants = rawAssistants
    .filter((item): item is AssistantConfig => Boolean(item?.id && item?.name && item?.provider))
    .map<AssistantConfig>((item) => ({
      id: String(item.id),
      name: String(item.name),
      avatar: optStr(item.avatar),
      provider: item.provider === "codex" ? "codex" : "claude",
      model: optStr(item.model),
      apiAuthToken: optStr(item.apiAuthToken),
      apiBaseUrl: optStr(item.apiBaseUrl),
      skillNames: Array.isArray(item.skillNames)
        ? item.skillNames.filter(Boolean).map((name) => String(name))
        : [],
      skillTags: Array.isArray(item.skillTags)
        ? item.skillTags.filter(Boolean).map((tag) => String(tag))
        : undefined,
      persona: optStr(item.persona) ?? DEFAULT_PERSONA,
      coreValues: optStr(item.coreValues) ?? DEFAULT_CORE_VALUES,
      relationship: optStr(item.relationship) ?? DEFAULT_RELATIONSHIP,
      cognitiveStyle: optStr(item.cognitiveStyle) ?? DEFAULT_COGNITIVE_STYLE,
      operatingGuidelines: optStr(item.operatingGuidelines) ?? DEFAULT_OPERATING_GUIDELINES,
      heartbeatInterval: typeof item.heartbeatInterval === "number" ? item.heartbeatInterval : 30,
      heartbeatRules: optStr(item.heartbeatRules) ?? DEFAULT_HEARTBEAT_RULES,
      defaultCwd: optStr(item.defaultCwd),
      bots: item.bots && typeof item.bots === "object" ? item.bots : undefined,
    }));

  if (assistants.length === 0) {
    const defaultConfig = buildDefaultConfig();
    return defaultConfig;
  }

  const preferredDefault = input?.defaultAssistantId;
  const defaultExists = preferredDefault && assistants.some((item) => item.id === preferredDefault);

  return {
    assistants,
    defaultAssistantId: defaultExists ? preferredDefault : assistants[0]?.id,
    userContext: optStr(input?.userContext),
  };
}

export function loadAssistantsConfig(): AssistantsConfig {
  try {
    if (!existsSync(ASSISTANTS_FILE)) {
      const defaultConfig = buildDefaultConfig();
      saveAssistantsConfig(defaultConfig);
      return defaultConfig;
    }
    const raw = readFileSync(ASSISTANTS_FILE, "utf8");
    const parsed = JSON.parse(raw) as Partial<AssistantsConfig>;
    const normalized = normalizeConfig(parsed);
    if (JSON.stringify(normalized) !== JSON.stringify(parsed)) {
      saveAssistantsConfig(normalized);
    }
    return normalized;
  } catch {
    return buildDefaultConfig();
  }
}

export function saveAssistantsConfig(config: AssistantsConfig): AssistantsConfig {
  const normalized = normalizeConfig(config);
  ensureDirectory();
  writeFileSync(ASSISTANTS_FILE, JSON.stringify(normalized, null, 2), "utf8");
  return normalized;
}

/**
 * Auto-populate ownerUserIds (Telegram) or ownerStaffIds (DingTalk) for an assistant
 * when the user sends the first message. Only adds the ID if not already present.
 * Returns true if the config was updated.
 */
export function patchAssistantBotOwnerIds(
  assistantId: string,
  platform: "telegram" | "dingtalk",
  userId: string,
): boolean {
  const config = loadAssistantsConfig();
  const assistant = config.assistants.find((a) => a.id === assistantId);
  if (!assistant || !userId) return false;

  const bots = (assistant.bots ?? {}) as Record<string, Record<string, unknown>>;
  const botCfg = bots[platform] as Record<string, unknown> | undefined;
  if (!botCfg) return false;

  const field = platform === "telegram" ? "ownerUserIds" : "ownerStaffIds";
  const existing = (botCfg[field] as string[] | undefined) ?? [];
  if (existing.includes(userId)) return false;

  botCfg[field] = [...existing, userId];
  assistant.bots = bots;
  saveAssistantsConfig(config);
  console.log(`[BotOwner] Auto-set ${field} for assistant "${assistantId}": added ${userId}`);
  assistantConfigEvents.emit("bot-owner-ids-changed", { assistantId, platform });
  return true;
}
