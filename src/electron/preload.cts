import electron, { webUtils } from "electron";

electron.contextBridge.exposeInMainWorld("electron", {
    subscribeStatistics: (callback) =>
        ipcOn("statistics", stats => {
            callback(stats);
        }),
    getStaticData: () => ipcInvoke("getStaticData"),
    
    // Claude Agent IPC APIs
    sendClientEvent: (event: any) => {
        electron.ipcRenderer.send("client-event", event);
    },
    onServerEvent: (callback: (event: any) => void) => {
        const cb = (_: Electron.IpcRendererEvent, payload: string) => {
            try {
                const event = JSON.parse(payload);
                callback(event);
            } catch (error) {
                console.error("Failed to parse server event:", error);
            }
        };
        electron.ipcRenderer.on("server-event", cb);
        return () => electron.ipcRenderer.off("server-event", cb);
    },
    generateSessionTitle: (userInput: string | null) => 
        ipcInvoke("generate-session-title", userInput),
    getRecentCwds: (limit?: number) => 
        ipcInvoke("get-recent-cwds", limit),
    selectDirectory: () => 
        ipcInvoke("select-directory"),
    getUserSettings: () => 
        ipcInvoke("get-user-settings"),
    saveUserSettings: (settings: any) => 
        ipcInvoke("save-user-settings", settings),
    getKnowledgeCandidates: () =>
        ipcInvoke("get-knowledge-candidates"),
    updateKnowledgeCandidateStatus: (id: string, status: "draft" | "verified" | "archived") =>
        ipcInvoke("update-knowledge-candidate-status", id, status),
    deleteKnowledgeCandidate: (id: string) =>
        ipcInvoke("delete-knowledge-candidate", id),
    getKnowledgeDocs: () =>
        ipcInvoke("get-knowledge-docs"),
    createKnowledgeDoc: (title: string, content: string) =>
        ipcInvoke("create-knowledge-doc", title, content),
    updateKnowledgeDoc: (id: string, title: string, content: string) =>
        ipcInvoke("update-knowledge-doc", id, title, content),
    deleteKnowledgeDoc: (id: string) =>
        ipcInvoke("delete-knowledge-doc", id),
    getKnowledgeBasePath: () =>
        ipcInvoke("get-knowledge-base-path"),
    testAlertWebhook: (webhookUrl: string, secret?: string) =>
        ipcInvoke("test-alert-webhook", { webhookUrl, secret }),
    checkEnvironment: () => 
        ipcInvoke("check-environment"),
    validateApiConfig: (baseUrl?: string, authToken?: string, model?: string) => 
        ipcInvoke("validate-api-config", baseUrl, authToken, model),
    requestFolderAccess: (folderPath?: string) => 
        ipcInvoke("request-folder-access", folderPath),
    openPrivacySettings: () => 
        ipcInvoke("open-privacy-settings"),
    openPath: (targetPath: string) => 
        ipcInvoke("open-path", targetPath),
    openExternalUrl: (url: string) =>
        ipcInvoke("open-external-url", url),
    installClaudeCLI: () => 
        ipcInvoke("install-claude-cli"),
    isClaudeCLIInstalled: () => 
        ipcInvoke("is-claude-cli-installed"),
    onInstallProgress: (callback: (message: string) => void) => {
        const cb = (_: Electron.IpcRendererEvent, message: string) => callback(message);
        electron.ipcRenderer.on("install-progress", cb);
        return () => electron.ipcRenderer.off("install-progress", cb);
    },
    // Image selection (path only, Agent uses built-in analyze_image tool)
    selectImage: () => 
        ipcInvoke("select-image"),
    savePastedImage: (base64Data: string, mimeType: string) => 
        ipcInvoke("save-pasted-image", base64Data, mimeType),
    // File selection (any file type, returns array of paths)
    selectFile: () =>
        ipcInvoke("select-file"),
    // Get file system path for a dropped File object (Electron 32+ replacement for File.path)
    getPathForFile: (file: File) => webUtils.getPathForFile(file),
    // Generate a thumbnail data URL for a local image (128px max dim, returns data:image/png;base64,...)
    getImageThumbnail: (filePath: string) =>
        ipcInvoke("get-image-thumbnail", filePath),
    // Open Save dialog and copy the source image to the chosen path
    saveImage: (sourcePath: string) =>
        ipcInvoke("save-image", sourcePath),
    // Install tools
    installNodeJs: () => 
        ipcInvoke("install-nodejs"),
    installSdk: () => 
        ipcInvoke("install-sdk"),
    // Claude config (MCP & Skills)
    getClaudeConfig: () => 
        ipcInvoke("get-claude-config"),
    skillCatalog: () =>
        ipcInvoke("skill-catalog"),
    saveMcpServer: (server: any) => 
        ipcInvoke("save-mcp-server", server),
    deleteMcpServer: (name: string) => 
        ipcInvoke("delete-mcp-server", name),
    readSkillContent: (skillPath: string) => 
        ipcInvoke("read-skill-content", skillPath),
    installSkill: (url: string) => 
        ipcInvoke("install-skill", url),
    deleteSkill: (skillName: string) =>
        ipcInvoke("delete-skill", skillName),
    getAssistantsConfig: () =>
        ipcInvoke("get-assistants-config"),
    saveAssistantsConfig: (config: AssistantsConfig) =>
        ipcInvoke("save-assistants-config", config),
    // Bot config
    getBotConfig: () =>
        ipcInvoke("get-bot-config"),
    saveBotConfig: (config: BotConfig) =>
        ipcInvoke("save-bot-config", config),
    testBotConnection: (platformConfig: BotPlatformConfig) =>
        ipcInvoke("test-bot-connection", platformConfig),
    // DingTalk bot lifecycle
    startDingtalkBot: (input: StartDingtalkBotInput) =>
        ipcInvoke("start-dingtalk-bot", input),
    stopDingtalkBot: (assistantId: string) =>
        ipcInvoke("stop-dingtalk-bot", assistantId),
    getDingtalkBotStatus: (assistantId: string) =>
        ipcInvoke("get-dingtalk-bot-status", assistantId),
    sendProactiveDingtalk: (input: SendProactiveDingtalkInput) =>
        ipcInvoke("send-proactive-dingtalk", input),
    sendProactiveMediaDingtalk: (input: SendProactiveMediaDingtalkInput) =>
        ipcInvoke("send-proactive-dingtalk-media", input),
    getDingtalkLastSeen: (assistantId: string) =>
        ipcInvoke("get-dingtalk-last-seen", assistantId),
    // Telegram bot lifecycle
    startTelegramBot: (input: StartTelegramBotInput) =>
        ipcInvoke("start-telegram-bot", input),
    stopTelegramBot: (assistantId: string) =>
        ipcInvoke("stop-telegram-bot", assistantId),
    getTelegramBotStatus: (assistantId: string) =>
        ipcInvoke("get-telegram-bot-status", assistantId),
    sendProactiveTelegram: (input: SendProactiveTelegramInput) =>
        ipcInvoke("send-proactive-telegram", input),
    onTelegramBotStatus: (cb: (assistantId: string, status: TelegramBotStatus, detail?: string) => void) => {
        const handler = (_: Electron.IpcRendererEvent, payload: { assistantId: string; status: TelegramBotStatus; detail?: string }) => {
            cb(payload.assistantId, payload.status, payload.detail);
        };
        electron.ipcRenderer.on("telegram-bot-status", handler);
        return () => electron.ipcRenderer.off("telegram-bot-status", handler);
    },
    // Feishu bot lifecycle
    startFeishuBot: (input: StartFeishuBotInput) =>
        ipcInvoke("start-feishu-bot", input),
    stopFeishuBot: (assistantId: string) =>
        ipcInvoke("stop-feishu-bot", assistantId),
    getFeishuBotStatus: (assistantId: string) =>
        ipcInvoke("get-feishu-bot-status", assistantId),
    onFeishuBotStatus: (cb: (assistantId: string, status: FeishuBotStatus, detail?: string) => void) => {
        const handler = (_: Electron.IpcRendererEvent, payload: { assistantId: string; status: FeishuBotStatus; detail?: string }) => {
            cb(payload.assistantId, payload.status, payload.detail);
        };
        electron.ipcRenderer.on("feishu-bot-status", handler);
        return () => electron.ipcRenderer.off("feishu-bot-status", handler);
    },
    onDingtalkBotStatus: (cb: (assistantId: string, status: DingtalkBotStatus, detail?: string) => void) => {
        const handler = (_: Electron.IpcRendererEvent, payload: { assistantId: string; status: DingtalkBotStatus; detail?: string }) => {
            cb(payload.assistantId, payload.status, payload.detail);
        };
        electron.ipcRenderer.on("dingtalk-bot-status", handler);
        return () => electron.ipcRenderer.off("dingtalk-bot-status", handler);
    },
    onAssistantBotOwnerIdsChanged: (cb: (assistantId: string, platform: string) => void) => {
        const handler = (_: Electron.IpcRendererEvent, payload: { assistantId: string; platform: string }) => {
            cb(payload.assistantId, payload.platform);
        };
        electron.ipcRenderer.on("assistant-bot-owner-ids-changed", handler);
        return () => electron.ipcRenderer.off("assistant-bot-owner-ids-changed", handler);
    },
    // OpenAI Codex OAuth
    openaiLogin: () => 
        ipcInvoke("openai-login"),
    openaiLogout: () => 
        ipcInvoke("openai-logout"),
    openaiAuthStatus: () => 
        ipcInvoke("openai-auth-status"),
    // Google OAuth
    googleLogin: () =>
        ipcInvoke("google-login"),
    googleLogout: () =>
        ipcInvoke("google-logout"),
    googleAuthStatus: () =>
        ipcInvoke("google-auth-status"),
    // Memory
    memoryRead: (target: string, date?: string) => 
        ipcInvoke("memory-read", target, date),
    memoryWrite: (target: string, content: string, date?: string) => 
        ipcInvoke("memory-write", target, content, date),
    memoryList: () => 
        ipcInvoke("memory-list"),
    // Scheduler
    getScheduledTasks: () => 
        ipcInvoke("get-scheduled-tasks"),
    addScheduledTask: (task: any) => 
        ipcInvoke("add-scheduled-task", task),
    updateScheduledTask: (id: string, updates: any) => 
        ipcInvoke("update-scheduled-task", id, updates),
    deleteScheduledTask: (id: string) => 
        ipcInvoke("delete-scheduled-task", id),
    onSchedulerRunTask: (callback: (task: any) => void) => {
        const cb = (_: Electron.IpcRendererEvent, task: any) => callback(task);
        electron.ipcRenderer.on("scheduler:run-task", cb);
        return () => electron.ipcRenderer.off("scheduler:run-task", cb);
    },
    // Plan table
    getPlanItems: () =>
        ipcInvoke("get-plan-items"),
    retryPlanItem: (id: string) =>
        ipcInvoke("retry-plan-item", id),
    runPlanItemNow: (id: string) =>
        ipcInvoke("run-plan-item-now", id),
    updatePlanItemSession: (planItemId: string, sessionId: string) =>
        ipcInvoke("update-plan-item-session", planItemId, sessionId),
    onPlanItemsChanged: (callback: () => void) => {
        const cb = () => callback();
        electron.ipcRenderer.on("plan-items-changed", cb);
        return () => electron.ipcRenderer.off("plan-items-changed", cb);
    },
    readDir: (dirPath: string) =>
        ipcInvoke("read-dir", dirPath),
    generateSkillTags: (persona: string, skillNames: string[], assistantName: string) =>
        ipcInvoke("generate-skill-tags", persona, skillNames, assistantName),
    // Quick window
    getQuickWindowShortcut: () =>
        ipcInvoke("get-quick-window-shortcut"),
    saveQuickWindowShortcut: (shortcut: string) =>
        ipcInvoke("save-quick-window-shortcut", shortcut),
    isQuickWindow: () => {
        return new URLSearchParams(window.location.search).get("mode") === "quick";
    },
    hideQuickWindow: () => {
        electron.ipcRenderer.send("hide-quick-window");
    },
    resizeQuickWindow: (height: number) => {
        electron.ipcRenderer.send("resize-quick-window", height);
    },
    showMainWindow: () => {
        electron.ipcRenderer.send("show-main-window");
    },
    onQuickWindowShow: (callback: () => void) => {
        const cb = () => callback();
        electron.ipcRenderer.on("quick-window-show", cb);
        return () => electron.ipcRenderer.off("quick-window-show", cb);
    },
    onQuickWindowSession: (callback: (data: { assistantId?: string }) => void) => {
        const cb = (_: Electron.IpcRendererEvent, data: any) => callback(data);
        electron.ipcRenderer.on("quick-window-session", cb);
        return () => electron.ipcRenderer.off("quick-window-session", cb);
    },
    // Window controls (custom title bar)
    windowMinimize: () => electron.ipcRenderer.send("window-minimize"),
    windowMaximize: () => electron.ipcRenderer.send("window-maximize"),
    windowClose: () => electron.ipcRenderer.send("window-close"),
    windowIsMaximized: () => electron.ipcRenderer.invoke("window-is-maximized") as Promise<boolean>,
    onWindowMaximizedChange: (callback: (isMaximized: boolean) => void) => {
        const cb = (_: Electron.IpcRendererEvent, val: boolean) => callback(val);
        electron.ipcRenderer.on("window-maximized-change", cb);
        return () => electron.ipcRenderer.off("window-maximized-change", cb);
    },
    getPlatform: () => process.platform,
    // Goals
    goalsList: () =>
        ipcInvoke("goals-list"),
    goalsAdd: (input: GoalAddInput) =>
        ipcInvoke("goals-add", input),
    goalsUpdate: (id: string, updates: Partial<LongTermGoal>) =>
        ipcInvoke("goals-update", id, updates),
    goalsDelete: (id: string) =>
        ipcInvoke("goals-delete", id),
    goalsRunNow: (id: string) =>
        ipcInvoke("goals-run-now", id),
    onGoalCompleted: (callback: () => void) => {
        const cb = () => callback();
        electron.ipcRenderer.on("goal-completed", cb);
        return () => electron.ipcRenderer.off("goal-completed", cb);
    },
    // SOP Hands
    sopList: () =>
        ipcInvoke("sop.list"),
    sopGenerate: (description: string) =>
        ipcInvoke("sop.generate", description),
} satisfies Window['electron'])

function ipcInvoke<Key extends keyof EventPayloadMapping>(key: Key, ...args: any[]): Promise<EventPayloadMapping[Key]> {
    return electron.ipcRenderer.invoke(key, ...args);
}

function ipcOn<Key extends keyof EventPayloadMapping>(key: Key, callback: (payload: EventPayloadMapping[Key]) => void) {
    const cb = (_: Electron.IpcRendererEvent, payload: any) => callback(payload)
    electron.ipcRenderer.on(key, cb);
    return () => electron.ipcRenderer.off(key, cb)
}
