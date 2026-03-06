type Statistics = {
    cpuUsage: number;
    ramUsage: number;
    storageData: number;
}

type StaticData = {
    totalStorage: number;
    cpuModel: string;
    totalMemoryGB: number;
}

type OpenAITokens = {
    accessToken: string;
    refreshToken: string;
    expiresAt: number;
}

type OpenAIAuthStatus = {
    loggedIn: boolean;
    email?: string;
    expiresAt?: number;
}

type OpenAILoginResult = {
    success: boolean;
    email?: string;
    error?: string;
}

type GoogleTokens = {
    accessToken: string;
    refreshToken: string;
    idToken?: string;
    expiresAt: number;
}

type GoogleUser = {
    email: string;
    name?: string;
    picture?: string;
}

type GoogleAuthStatus = {
    loggedIn: boolean;
    email?: string;
    name?: string;
    picture?: string;
    expiresAt?: number;
}

type GoogleLoginResult = {
    success: boolean;
    email?: string;
    name?: string;
    error?: string;
}

type UserSettings = {
    anthropicBaseUrl?: string;
    anthropicAuthToken?: string;
    anthropicModel?: string;
    proxyEnabled?: boolean;
    proxyUrl?: string;
    openaiTokens?: OpenAITokens;
    webhookToken?: string;
    userName?: string;
    workDescription?: string;
    globalPrompt?: string;
    quickWindowShortcut?: string;
    googleTokens?: GoogleTokens;
    googleUser?: GoogleUser;
    splashSeen?: boolean;
    alertDingtalkWebhook?: string;
    alertDingtalkSecret?: string;
    darkMode?: boolean;
}

type KnowledgeReviewStatus = "draft" | "verified" | "archived";

type KnowledgeCandidate = {
    id: string;
    title: string;
    scenario: string;
    steps: string;
    result: string;
    risk: string;
    sourceSessionId: string;
    assistantId?: string;
    createdAt: string;
    updatedAt: string;
    reviewStatus: KnowledgeReviewStatus;
}

type KnowledgeDoc = {
    id: string;
    title: string;
    content: string;
    createdAt: string;
    updatedAt: string;
}

type ScheduledTaskHookFilter = {
    assistantId?: string;
    titlePattern?: string;
    onlyOnError?: boolean;
}

type ScheduledTask = {
    id: string;
    name: string;
    enabled: boolean;
    prompt: string;
    cwd?: string;
    skillPath?: string;
    scheduleType: "once" | "interval" | "daily" | "heartbeat" | "hook";
    // For "once" type
    scheduledTime?: string;
    // For "interval" type
    intervalValue?: number;
    intervalUnit?: "minutes" | "hours" | "days" | "weeks";
    // For "daily" type — run at a fixed time each day/week
    dailyTime?: string;    // "HH:MM"
    dailyDays?: number[];  // 0=Sun…6=Sat; empty = every day
    // For "heartbeat" type — periodic self-check
    heartbeatInterval?: number;  // minutes, default 30
    suppressIfShort?: boolean;   // hide session if response < 80 chars or contains <no-action>
    // For "hook" type — triggered by internal events
    hookEvent?: "startup" | "session.complete";
    hookFilter?: ScheduledTaskHookFilter;
    lastRun?: string;
    nextRun?: string;
    assistantId?: string;
    // SOP association — populated when task is created from a SOP schedule config
    sopId?: string;
    stageId?: string;   // set when task triggers a specific stage; absent = trigger whole SOP
    hidden?: boolean;   // true = not shown in calendar UI
    createdAt: string;
    updatedAt: string;
}

type ScheduledTaskInput = Omit<ScheduledTask, "id" | "createdAt" | "updatedAt">

type SchedulerRunTaskPayload = {
    taskId: string;
    name: string;
    prompt: string;
    cwd?: string;
    skillPath?: string;
    assistantId?: string;
    planItemId?: string;
    sopName?: string;
    planTaskName?: string;
    workflowSopId?: string;
    workflowStageId?: string;
    scheduledTaskId?: string;
}

type EnvironmentCheck = {
    id: string;
    name: string;
    status: 'ok' | 'warning' | 'error' | 'checking';
    message: string;
}

type EnvironmentCheckResult = {
    checks: EnvironmentCheck[];
    allPassed: boolean;
}

type ValidateApiResult = {
    valid: boolean;
    message: string;
}

type FolderAccessResult = {
    granted: boolean;
    path: string | null;
    bookmark?: string;
}

type InstallResult = {
    success: boolean;
    message: string;
    output?: string;
}

type McpServer = {
    name: string;
    command: string;
    args?: string[];
    env?: Record<string, string>;
}

type SkillInfo = {
    name: string;
    fullPath: string;
    description?: string;
    label?: string;
    category?: string;
}

type AssistantConfig = {
    id: string;
    name: string;
    avatar?: string;
    provider: "claude" | "codex";
    model?: string;
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
    bots?: Partial<Record<BotPlatformType, BotPlatformConfig>>;
}

type AssistantDefaults = {
    defaultProvider: "claude" | "codex";
    persona: string;
    coreValues: string;
    relationship: string;
    cognitiveStyle: string;
    operatingGuidelines: string;
    heartbeatRules: string;
}

type AssistantsConfig = {
    assistants: AssistantConfig[];
    defaultAssistantId?: string;
    userContext?: string;
    defaults?: AssistantDefaults;
}

type ClaudeConfigInfo = {
    mcpServers: McpServer[];
    skills: SkillInfo[];
}

type SkillCatalogItem = {
    name: string;
    label: string;
    description: string;
    category: string;
    tags: string[];
}

type SkillCatalogCategory = {
    id: string;
    label: string;
    icon?: string;
    color?: string;
    order?: number;
}

type SkillCatalogData = {
    skills: SkillCatalogItem[];
    categories: SkillCatalogCategory[];
}

type SaveMcpResult = {
    success: boolean;
    message: string;
}

type MemoryReadResult = {
    content: string;
    memoryDir?: string;
}

type MemoryWriteResult = {
    success: boolean;
    error?: string;
}

type MemoryFileInfo = {
    date: string;
    path: string;
    size: number;
}

type DirEntry = {
    name: string;
    path: string;
    isDir: boolean;
    size: number;
    modifiedAt: number;
}

type MemoryListResult = {
    memoryDir: string;
    summary: {
        longTermSize: number;
        dailyCount: number;
        totalSize: number;
    };
    dailies: MemoryFileInfo[];
    assistantDailies?: MemoryFileInfo[];
    lastCompactionAt?: string | null;
}

type BotPlatformType = "telegram" | "feishu" | "wecom" | "discord" | "dingtalk";

type TelegramBotConfig = {
    platform: "telegram";
    token: string;
    proxy?: string;
    /** Private chat policy */
    dmPolicy?: "open" | "allowlist";
    /** Group chat policy */
    groupPolicy?: "open" | "allowlist";
    /** Allowlisted Telegram user IDs or group chat IDs */
    allowFrom?: string[];
    /** Require @mention in groups before responding (default: true) */
    requireMention?: boolean;
    /** Owner Telegram user IDs for proactive messaging */
    ownerUserIds?: string[];
    connected: boolean;
};

type FeishuBotConfig = {
    platform: "feishu";
    appId: string;
    appSecret: string;
    domain: "feishu" | "lark";
    connected: boolean;
};

type WecomBotConfig = {
    platform: "wecom";
    corpId: string;
    agentId: string;
    secret: string;
    connected: boolean;
};

type DiscordBotConfig = {
    platform: "discord";
    token: string;
    connected: boolean;
};

type DingtalkBotConfig = {
    platform: "dingtalk";
    appKey: string;
    appSecret: string;
    /** For Card API and media download — defaults to appKey */
    robotCode?: string;
    corpId?: string;
    agentId?: string;
    /** Reply mode: "markdown" (default) or "card" (AI streaming card) */
    messageType?: "markdown" | "card";
    /** Required when messageType="card" */
    cardTemplateId?: string;
    /** Card template content field key — defaults to "msgContent" */
    cardTemplateKey?: string;
    /** Private chat policy */
    dmPolicy?: "open" | "allowlist";
    /** Group chat policy */
    groupPolicy?: "open" | "allowlist";
    /** Allowlisted staff IDs or conversation IDs */
    allowFrom?: string[];
    /** Max reconnect attempts (default: 10) */
    maxConnectionAttempts?: number;
    /** Initial reconnect delay ms (default: 1000) */
    initialReconnectDelay?: number;
    /** Max reconnect delay ms (default: 60000) */
    maxReconnectDelay?: number;
    /** Jitter factor 0–1 (default: 0.3) */
    reconnectJitter?: number;
    /**
     * Owner staff ID(s) for proactive push messages.
     * Fill in your own staffId so the bot can notify you proactively.
     */
    ownerStaffIds?: string[];
    connected: boolean;
};

type BotPlatformConfig =
    | TelegramBotConfig
    | FeishuBotConfig
    | WecomBotConfig
    | DiscordBotConfig
    | DingtalkBotConfig;

type BotConfig = {
    platforms: Partial<Record<BotPlatformType, BotPlatformConfig>>;
};

type BotTestResult = {
    success: boolean;
    message: string;
};

type DingtalkBotStatus = "disconnected" | "connecting" | "connected" | "error";

type StartDingtalkBotInput = {
    appKey: string;
    appSecret: string;
    robotCode?: string;
    corpId?: string;
    agentId?: string;
    assistantId: string;
    assistantName: string;
    persona?: string;
    coreValues?: string;
    relationship?: string;
    cognitiveStyle?: string;
    operatingGuidelines?: string;
    userContext?: string;
    provider?: "claude" | "codex";
    model?: string;
    defaultCwd?: string;
    messageType?: "markdown" | "card";
    cardTemplateId?: string;
    cardTemplateKey?: string;
    dmPolicy?: "open" | "allowlist";
    groupPolicy?: "open" | "allowlist";
    allowFrom?: string[];
    maxConnectionAttempts?: number;
    initialReconnectDelay?: number;
    maxReconnectDelay?: number;
    reconnectJitter?: number;
    ownerStaffIds?: string[];
};

type SendProactiveDingtalkInput = {
    assistantId: string;
    text: string;
    /** Target IDs: staffId, conversationId (cid...), or "user:<id>" / "group:<id>" prefix */
    targets?: string[];
    title?: string;
};

type SendProactiveMediaDingtalkInput = {
    assistantId: string;
    filePath: string;
    targets?: string[];
    mediaType?: "image" | "voice" | "video" | "file";
};

type SendProactiveDingtalkResult = {
    ok: boolean;
    error?: string;
};

type DingtalkBotStatusResult = {
    status: DingtalkBotStatus;
    detail?: string;
};

type TelegramBotStatus = "disconnected" | "connecting" | "connected" | "error";

type StartTelegramBotInput = {
    token: string;
    proxy?: string;
    assistantId: string;
    assistantName: string;
    skillNames?: string[];
    persona?: string;
    coreValues?: string;
    relationship?: string;
    cognitiveStyle?: string;
    operatingGuidelines?: string;
    userContext?: string;
    provider?: "claude" | "codex";
    model?: string;
    defaultCwd?: string;
    dmPolicy?: "open" | "allowlist";
    groupPolicy?: "open" | "allowlist";
    allowFrom?: string[];
    requireMention?: boolean;
    ownerUserIds?: string[];
};

type TelegramBotStatusResult = {
    status: TelegramBotStatus;
    detail?: string;
};

type SendProactiveTelegramInput = {
    assistantId: string;
    text: string;
    targets?: string[];
};

type SendProactiveTelegramResult = {
    ok: boolean;
    error?: string;
};

type FeishuBotStatus = "disconnected" | "connecting" | "connected" | "error";

type StartFeishuBotInput = {
    appId: string;
    appSecret: string;
    domain?: "feishu" | "lark";
    assistantId: string;
    assistantName: string;
    persona?: string;
    coreValues?: string;
    relationship?: string;
    cognitiveStyle?: string;
    operatingGuidelines?: string;
    userContext?: string;
    provider?: "claude" | "codex";
    model?: string;
    defaultCwd?: string;
    maxConnectionAttempts?: number;
};

type FeishuBotStatusResult = {
    status: FeishuBotStatus;
    detail?: string;
};

type GoalProgressEntry = {
    sessionId: string;
    runAt: string;
    summary: string;
    isComplete: boolean;
    nextSteps?: string;
}

type LongTermGoal = {
    id: string;
    name: string;
    description: string;
    status: "active" | "paused" | "completed" | "abandoned";
    assistantId?: string;
    cwd?: string;
    retryInterval: number;
    maxRuns: number;
    totalRuns: number;
    progressLog: GoalProgressEntry[];
    nextRunAt?: string;
    consecutiveErrors?: number;
    createdAt: string;
    updatedAt: string;
    completedAt?: string;
}

type WorkCategory = "客户服务" | "情报监控" | "内部运营" | "增长销售" | "";

type PlanItemStatus = "pending" | "in_progress" | "human_review" | "completed" | "failed";

type PlanItem = {
    id: string;
    sopName: string;
    category: WorkCategory;
    targetId: string;
    targetName: string;
    assistantId: string;
    content: string;
    scheduledTime: string;
    completedAt: string | null;
    status: PlanItemStatus;
    result: string;
    sessionId: string | null;
    scheduledTaskId?: string;
    createdAt: string;
    updatedAt: string;
}

type GoalAddInput = {
    name: string;
    description: string;
    cwd?: string;
    assistantId?: string;
    retryInterval: number;
    maxRuns: number;
}

type UnsubscribeFunction = () => void;

type EventPayloadMapping = {
    statistics: Statistics;
    getStaticData: StaticData;
    "generate-session-title": string;
    "get-recent-cwds": string[];
    "select-directory": string | null;
    "get-user-settings": UserSettings;
    "save-user-settings": boolean;
    "get-knowledge-candidates": KnowledgeCandidate[];
    "update-knowledge-candidate-status": KnowledgeCandidate | null;
    "delete-knowledge-candidate": boolean;
    "refine-knowledge-candidate": KnowledgeCandidate | null;
    "create-knowledge-candidate-from-like": KnowledgeCandidate | null;
    "get-knowledge-docs": KnowledgeDoc[];
    "create-knowledge-doc": KnowledgeDoc;
    "update-knowledge-doc": KnowledgeDoc | null;
    "delete-knowledge-doc": boolean;
    "get-knowledge-base-path": string;
    "test-alert-webhook": { ok: boolean; error?: string };
    "check-environment": EnvironmentCheckResult;
    "validate-api-config": ValidateApiResult;
    "request-folder-access": FolderAccessResult;
    "open-privacy-settings": boolean;
    "open-path": boolean;
    "show-item-in-folder": boolean;
    "open-external-url": boolean;
    "install-claude-cli": InstallResult;
    "is-claude-cli-installed": boolean;
    "select-image": string | null;
    "save-pasted-image": string | null;
    "select-file": { path: string; isDir: boolean }[] | null;
    "get-image-thumbnail": string | null;
    "save-image": { ok: boolean; savedTo?: string; reason?: string };
    "install-nodejs": InstallResult;
    "install-sdk": InstallResult;
    "get-claude-config": ClaudeConfigInfo;
    "skill-catalog": SkillCatalogData;
    "save-mcp-server": SaveMcpResult;
    "delete-mcp-server": SaveMcpResult;
    "read-skill-content": string | null;
    "install-skill": { success: boolean; skillName: string; message: string };
    "delete-skill": { success: boolean; message: string };
    "get-assistants-config": AssistantsConfig;
    "save-assistants-config": AssistantsConfig;
    "get-bot-config": BotConfig;
    "save-bot-config": BotConfig;
    "test-bot-connection": BotTestResult;
    "start-dingtalk-bot": DingtalkBotStatusResult;
    "stop-dingtalk-bot": void;
    "get-dingtalk-bot-status": DingtalkBotStatusResult;
    "send-proactive-dingtalk": SendProactiveDingtalkResult;
    "send-proactive-dingtalk-media": SendProactiveDingtalkResult;
    "get-dingtalk-last-seen": Array<{ target: string; isGroup: boolean; lastSeenAt: number }>;
    "start-telegram-bot": TelegramBotStatusResult;
    "stop-telegram-bot": void;
    "get-telegram-bot-status": TelegramBotStatusResult;
    "send-proactive-telegram": SendProactiveTelegramResult;
    "start-feishu-bot": FeishuBotStatusResult;
    "stop-feishu-bot": void;
    "get-feishu-bot-status": FeishuBotStatusResult;
    "is-sidecar-running": boolean;
    // OpenAI Codex OAuth
    "openai-login": OpenAILoginResult;
    "openai-logout": { success: boolean };
    "openai-auth-status": OpenAIAuthStatus;
    // Google OAuth
    "google-login": GoogleLoginResult;
    "google-logout": { success: boolean };
    "google-auth-status": GoogleAuthStatus;
    // Memory
    "memory-read": MemoryReadResult;
    "memory-write": MemoryWriteResult;
    "memory-list": MemoryListResult;
    // Scheduler
    "get-scheduled-tasks": ScheduledTask[];
    "add-scheduled-task": ScheduledTask;
    "update-scheduled-task": ScheduledTask | null;
    "delete-scheduled-task": boolean;
    "read-dir": DirEntry[];
    "generate-skill-tags": string[];
    // Plan table
    "get-plan-items": PlanItem[];
    "retry-plan-item": { ok: boolean; error?: string };
    "run-plan-item-now": { ok: boolean; error?: string };
    "update-plan-item-session": { ok: boolean; error?: string };
    "get-quick-window-shortcut": string;
    "save-quick-window-shortcut": boolean;
    // Goals
    "goals-list": LongTermGoal[];
    "goals-add": LongTermGoal;
    "goals-update": LongTermGoal | null;
    "goals-delete": boolean;
    "goals-run-now": void;
    // SOP Hands
    "sop.list": HandSopResult[];
    "sop.generate": HandSopResult;
    "sop.generate.cancel": null;
    "sop.delete": boolean;
    "sop.rename": HandSopResult;
    "sop.setSopSchedule": ScheduledTask;
    "sop.getSopSchedules": ScheduledTask[];
    "sop.removeSopSchedule": boolean;
    // Workflow runs
    "workflow.get-run": WorkflowRun | null;
    "workflow.execute": WorkflowRun;
    "workflow.execute-stage": WorkflowRun;
    "workflow.retry-stage": WorkflowRun | null;
}

interface HandStage {
    id: string;
    label: string;
    goal: string;
    items: string[];
    tools: string[];
    mcp: string[];
}

interface HandSopResult {
    id: string;
    name: string;
    description: string;
    category: WorkCategory;
    icon: string;
    stages: HandStage[];
    workflowCount: number;
    createdAt?: string;
}

// ── Workflow Run (per-stage execution tracking) ──────────────────────────────

type WorkflowStatus = "idle" | "running" | "completed" | "failed";
type WorkflowStageStatus = "pending" | "in_progress" | "completed" | "failed";

interface WorkflowStageRun {
    stageId: string;
    label: string;
    status: WorkflowStageStatus;
    inputPrompt?: string;
    output?: string;
    abstract?: string;
    error?: string;
    sessionId?: string;
    startedAt?: string;
    completedAt?: string;
    duration?: number;
}

interface WorkflowRun {
    id: string;
    sopId: string;
    status: WorkflowStatus;
    startedAt?: string;
    completedAt?: string;
    stages: WorkflowStageRun[];
}

interface Window {
    electron: {
        subscribeStatistics: (callback: (statistics: Statistics) => void) => UnsubscribeFunction;
        getStaticData: () => Promise<StaticData>;
        // Claude Agent IPC APIs
        sendClientEvent: (event: any) => void;
        onServerEvent: (callback: (event: any) => void) => UnsubscribeFunction;
        generateSessionTitle: (userInput: string | null) => Promise<string>;
        getRecentCwds: (limit?: number) => Promise<string[]>;
        selectDirectory: () => Promise<string | null>;
        getUserSettings: () => Promise<UserSettings>;
        saveUserSettings: (settings: UserSettings) => Promise<boolean>;
        getKnowledgeCandidates: () => Promise<KnowledgeCandidate[]>;
        updateKnowledgeCandidateStatus: (id: string, status: KnowledgeReviewStatus) => Promise<KnowledgeCandidate | null>;
        deleteKnowledgeCandidate: (id: string) => Promise<boolean>;
        refineKnowledgeCandidate: (id: string) => Promise<KnowledgeCandidate | null>;
        createKnowledgeCandidateFromLike: (sessionId: string, text: string) => Promise<KnowledgeCandidate | null>;
        getKnowledgeDocs: () => Promise<KnowledgeDoc[]>;
        createKnowledgeDoc: (title: string, content: string) => Promise<KnowledgeDoc>;
        updateKnowledgeDoc: (id: string, title: string, content: string) => Promise<KnowledgeDoc | null>;
        deleteKnowledgeDoc: (id: string) => Promise<boolean>;
        getKnowledgeBasePath: () => Promise<string>;
        testAlertWebhook: (webhookUrl: string, secret?: string) => Promise<{ ok: boolean; error?: string }>;
        checkEnvironment: () => Promise<EnvironmentCheckResult>;
        validateApiConfig: (baseUrl?: string, authToken?: string, model?: string) => Promise<ValidateApiResult>;
        requestFolderAccess: (folderPath?: string) => Promise<FolderAccessResult>;
        openPrivacySettings: () => Promise<boolean>;
        openPath: (targetPath: string) => Promise<boolean>;
        showItemInFolder: (targetPath: string) => Promise<boolean>;
        openExternalUrl: (url: string) => Promise<boolean>;
        installClaudeCLI: () => Promise<InstallResult>;
        isClaudeCLIInstalled: () => Promise<boolean>;
        onInstallProgress: (callback: (message: string) => void) => UnsubscribeFunction;
        // Image selection (path only, Agent uses built-in analyze_image tool)
        selectImage: () => Promise<string | null>;
        savePastedImage: (base64Data: string, mimeType: string) => Promise<string | null>;
        // File/folder selection, returns array of { path, isDir }
        selectFile: () => Promise<{ path: string; isDir: boolean }[] | null>;
        // Get file system path for a dropped File object (Electron 32+ API)
        getPathForFile: (file: File) => string;
        // Generate a thumbnail data URL for a local image
        getImageThumbnail: (filePath: string) => Promise<string | null>;
        saveImage: (sourcePath: string) => Promise<{ ok: boolean; savedTo?: string; reason?: string }>;
        // Install tools
        installNodeJs: () => Promise<InstallResult>;
        installSdk: () => Promise<InstallResult>;
        // Claude config (MCP & Skills)
        getClaudeConfig: () => Promise<ClaudeConfigInfo>;
        skillCatalog: () => Promise<SkillCatalogData>;
        saveMcpServer: (server: McpServer) => Promise<SaveMcpResult>;
        deleteMcpServer: (name: string) => Promise<SaveMcpResult>;
        readSkillContent: (skillPath: string) => Promise<string | null>;
        installSkill: (url: string) => Promise<{ success: boolean; skillName: string; message: string }>;
        deleteSkill: (skillName: string) => Promise<{ success: boolean; message: string }>;
        getAssistantsConfig: () => Promise<AssistantsConfig>;
        saveAssistantsConfig: (config: AssistantsConfig) => Promise<AssistantsConfig>;
        // Bot config
        getBotConfig: () => Promise<BotConfig>;
        saveBotConfig: (config: BotConfig) => Promise<BotConfig>;
        testBotConnection: (platformConfig: BotPlatformConfig) => Promise<BotTestResult>;
        // DingTalk bot lifecycle
        startDingtalkBot: (input: StartDingtalkBotInput) => Promise<DingtalkBotStatusResult>;
        stopDingtalkBot: (assistantId: string) => Promise<void>;
        getDingtalkBotStatus: (assistantId: string) => Promise<DingtalkBotStatusResult>;
        onDingtalkBotStatus: (cb: (assistantId: string, status: DingtalkBotStatus, detail?: string) => void) => UnsubscribeFunction;
        sendProactiveDingtalk: (input: SendProactiveDingtalkInput) => Promise<SendProactiveDingtalkResult>;
        sendProactiveMediaDingtalk: (input: SendProactiveMediaDingtalkInput) => Promise<SendProactiveDingtalkResult>;
        getDingtalkLastSeen: (assistantId: string) => Promise<Array<{ target: string; isGroup: boolean; lastSeenAt: number }>>;
        // Telegram bot lifecycle
        startTelegramBot: (input: StartTelegramBotInput) => Promise<TelegramBotStatusResult>;
        stopTelegramBot: (assistantId: string) => Promise<void>;
        getTelegramBotStatus: (assistantId: string) => Promise<TelegramBotStatusResult>;
        onTelegramBotStatus: (cb: (assistantId: string, status: TelegramBotStatus, detail?: string) => void) => UnsubscribeFunction;
        sendProactiveTelegram: (input: SendProactiveTelegramInput) => Promise<SendProactiveTelegramResult>;
        // Feishu bot lifecycle
        startFeishuBot: (input: StartFeishuBotInput) => Promise<FeishuBotStatusResult>;
        stopFeishuBot: (assistantId: string) => Promise<void>;
        getFeishuBotStatus: (assistantId: string) => Promise<FeishuBotStatusResult>;
        onFeishuBotStatus: (cb: (assistantId: string, status: FeishuBotStatus, detail?: string) => void) => UnsubscribeFunction;
        onAssistantBotOwnerIdsChanged: (cb: (assistantId: string, platform: string) => void) => UnsubscribeFunction;
        onAssistantsConfigChanged: (cb: (config: AssistantsConfig) => void) => UnsubscribeFunction;
        // OpenAI Codex OAuth
        openaiLogin: () => Promise<OpenAILoginResult>;
        openaiLogout: () => Promise<{ success: boolean }>;
        openaiAuthStatus: () => Promise<OpenAIAuthStatus>;
        // Google OAuth
        googleLogin: () => Promise<GoogleLoginResult>;
        googleLogout: () => Promise<{ success: boolean }>;
        googleAuthStatus: () => Promise<GoogleAuthStatus>;
        // Memory
        memoryRead: (target: string, date?: string, assistantId?: string) => Promise<MemoryReadResult>;
        memoryWrite: (target: string, content: string, date?: string, assistantId?: string) => Promise<MemoryWriteResult>;
        memoryList: (assistantId?: string) => Promise<MemoryListResult>;
        // Scheduler
        getScheduledTasks: () => Promise<ScheduledTask[]>;
        addScheduledTask: (task: ScheduledTaskInput) => Promise<ScheduledTask>;
        updateScheduledTask: (id: string, updates: Partial<ScheduledTask>) => Promise<ScheduledTask | null>;
        deleteScheduledTask: (id: string) => Promise<boolean>;
        onSchedulerRunTask: (callback: (task: SchedulerRunTaskPayload) => void) => UnsubscribeFunction;
        // SOP schedule management
        sopSetSopSchedule: (params: {
            sopId: string;
            stageId?: string;
            name: string;
            scheduleType: "once" | "interval" | "daily";
            scheduledTime?: string;
            intervalValue?: number;
            intervalUnit?: "minutes" | "hours" | "days" | "weeks";
            dailyTime?: string;
            dailyDays?: number[];
            existingTaskId?: string;
        }) => Promise<ScheduledTask>;
        sopGetSopSchedules: (sopId: string, stageId?: string) => Promise<ScheduledTask[]>;
        sopRemoveSopSchedule: (taskId: string) => Promise<boolean>;
        // Plan table
        getPlanItems: () => Promise<PlanItem[]>;
        retryPlanItem: (id: string) => Promise<{ ok: boolean; error?: string }>;
        runPlanItemNow: (id: string) => Promise<{ ok: boolean; error?: string }>;
        updatePlanItemSession: (planItemId: string, sessionId: string) => Promise<{ ok: boolean; error?: string }>;
        onPlanItemsChanged: (callback: () => void) => UnsubscribeFunction;
        readDir: (dirPath: string) => Promise<DirEntry[]>;
        generateSkillTags: (persona: string, skillNames: string[], assistantName: string) => Promise<string[]>;
        // Quick window
        getQuickWindowShortcut: () => Promise<string>;
        saveQuickWindowShortcut: (shortcut: string) => Promise<boolean>;
        isQuickWindow: () => boolean;
        hideQuickWindow: () => void;
        resizeQuickWindow: (height: number) => void;
        showMainWindow: () => void;
        onQuickWindowShow: (callback: () => void) => UnsubscribeFunction;
        onQuickWindowSession: (callback: (data: { assistantId?: string }) => void) => UnsubscribeFunction;
        // Window controls (custom title bar)
        windowMinimize: () => void;
        windowMaximize: () => void;
        windowClose: () => void;
        windowIsMaximized: () => Promise<boolean>;
        onWindowMaximizedChange: (callback: (isMaximized: boolean) => void) => UnsubscribeFunction;
        getPlatform: () => string;
        // Goals
        goalsList: () => Promise<LongTermGoal[]>;
        goalsAdd: (input: GoalAddInput) => Promise<LongTermGoal>;
        goalsUpdate: (id: string, updates: Partial<LongTermGoal>) => Promise<LongTermGoal | null>;
        goalsDelete: (id: string) => Promise<boolean>;
        goalsRunNow: (id: string) => Promise<void>;
        onGoalCompleted: (callback: () => void) => UnsubscribeFunction;
        // SOP Hands
        sopList: () => Promise<HandSopResult[]>;
        sopGenerate: (description: string) => Promise<HandSopResult>;
        sopGenerateCancel: () => Promise<null>;
        sopDelete: (sopId: string) => Promise<boolean>;
        sopRename: (sopId: string, newName: string) => Promise<HandSopResult>;
        // Workflow runs
        workflowGetRun: (sopId: string) => Promise<WorkflowRun | null>;
        workflowExecute: (sopId: string) => Promise<WorkflowRun>;
        workflowExecuteStage: (sopId: string, stageId: string) => Promise<WorkflowRun>;
        workflowRetryStage: (sopId: string, stageId: string) => Promise<WorkflowRun | null>;
        workflowStageComplete: (payload: { sopId: string; stageId: string; output: string; abstract: string; sessionId?: string; error?: string }) => void;
        onWorkflowRunChanged: (callback: (sopId: string) => void) => UnsubscribeFunction;
    }
}
