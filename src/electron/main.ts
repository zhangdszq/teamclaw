import { sendTestDingtalkAlert } from "./libs/app-logger.js";
import { app, BrowserWindow, ipcMain, dialog, shell, protocol, globalShortcut, screen, Tray, Menu, nativeImage } from "electron"
import fs from "fs"
import { ipcMainHandle, isDev, DEV_PORT } from "./util.js";
import { getPreloadPath, getUIPath, getIconPath, getTrayIconPath } from "./pathResolver.js";
import { getStaticData, pollResources } from "./test.js";
import { handleClientEvent, sessions } from "./ipc-handlers.js";
import { buildConversationDigest, extractExperienceViaAI } from "./libs/experience-extractor.js";
// Inject the shared SessionStore into bot modules so they use the same DB connection
setSessionStore(sessions);
setFeishuSessionStore(sessions);
setTelegramSessionStore(sessions);
import type { ClientEvent } from "./types.js";
import "./libs/claude-settings.js";
import { loadUserSettings, saveUserSettings, type UserSettings } from "./libs/user-settings.js";
import { loadAssistantsConfig, saveAssistantsConfig, assistantConfigEvents, resolveDefaultProvider, type AssistantsConfig, DEFAULT_PERSONA, DEFAULT_CORE_VALUES, DEFAULT_RELATIONSHIP, DEFAULT_COGNITIVE_STYLE, DEFAULT_OPERATING_GUIDELINES, DEFAULT_HEARTBEAT_RULES } from "./libs/assistants-config.js";
import { loadBotConfig, saveBotConfig, testBotConnection, type BotPlatformConfig, type DingtalkBotConfig, type TelegramBotConfig } from "./libs/bot-config.js";
import {
  startDingtalkBot,
  stopDingtalkBot,
  getDingtalkBotStatus,
  updateDingtalkBotConfig,
  onDingtalkBotStatusChange,
  onDingtalkSessionUpdate,
  setSessionStore,
  sendProactiveDingtalkMessage,
  sendProactiveMediaDingtalk,
  getLastSeenTargets,
  type DingtalkBotOptions,
} from "./libs/dingtalk-bot.js";
import {
  startFeishuBot,
  stopFeishuBot,
  getFeishuBotStatus,
  onFeishuBotStatusChange,
  setFeishuSessionStore,
  updateFeishuBotConfig,
  type FeishuBotOptions,
} from "./libs/feishu-bot.js";
import {
  startTelegramBot,
  stopTelegramBot,
  getTelegramBotStatus,
  updateTelegramBotConfig,
  onTelegramBotStatusChange,
  onTelegramSessionUpdate,
  setTelegramSessionStore,
  sendProactiveTelegramMessage,
  type TelegramBotOptions,
} from "./libs/telegram-bot.js";
import { reloadClaudeSettings } from "./libs/claude-settings.js";
import { ensureBuiltinMcpServers } from "./libs/builtin-mcps.js";
import { seedBuiltinSkills } from "./libs/builtin-skills.js";
import {
    loadGoals,
    addGoal,
    updateGoal,
    deleteGoal,
    triggerGoalRun,
    setGoalCompleteNotifier,
    type LongTermGoal,
} from "./libs/goals-manager.js";
import { runEnvironmentChecks, validateApiConfig } from "./libs/env-check.js";
import { openAILogin, openAILogout, getOpenAIAuthStatus, ensureCodexAuthSync } from "./libs/openai-auth.js";
import { googleLogin, googleLogout, getGoogleAuthStatus } from "./libs/google-auth.js";
import { startEmbeddedApi, stopEmbeddedApi, isEmbeddedApiRunning, setWebhookSessionRunner } from "./api/server.js";
import {
  readLongTermMemory, readDailyMemory, buildMemoryContext,
  writeLongTermMemory, appendDailyMemory, writeDailyMemory,
  listDailyMemories, getMemoryDir, getMemorySummary,
  runMemoryJanitor, refreshRootAbstract,
  readSessionState, writeSessionState, clearSessionState,
  readAbstract, localDateStr,
  listSops, readSop, writeSop, searchSops, deleteSop,
  ScopedMemory,
} from "./libs/memory-store.js";
import { 
  loadScheduledTasks, 
  addScheduledTask, 
  updateScheduledTask, 
  deleteScheduledTask,
  deleteScheduledTasksBySopId,
  startScheduler,
  stopScheduler,
  setSchedulerSessionRunner,
  setSopRunner,
  setSopStageRunner,
  runHookTasks,
  type ScheduledTask
} from "./libs/scheduler.js";
import { startHeartbeatLoop, stopHeartbeatLoop, startMemoryCompactTimer, stopMemoryCompactTimer, readLastCompactionAt } from "./libs/heartbeat.js";
import { loadPlanItems, updatePlanItem, upsertPlanItem } from "./libs/plan-store.js";
import {
    loadWorkflowRun,
    saveWorkflowRun,
    createWorkflowRun,
    updateWorkflowStage,
    getNextPendingStage,
    loadWorkflowExperiences,
    loadWorkflowHistory,
    saveStageExperience,
    type StageExperience,
} from "./libs/workflow-store.js";
import { readFileSync, readdirSync, existsSync, statSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import Anthropic from "@anthropic-ai/sdk";
import { parse as parseToml } from "smol-toml";
import { query as agentQuery } from "@anthropic-ai/claude-agent-sdk";
import { rmSync } from "fs";
import { getSettingSources } from "./libs/claude-settings.js";
import {
    listKnowledgeCandidates,
    updateKnowledgeCandidateReviewStatus,
    deleteKnowledgeCandidate,
    getKnowledgeCandidateById,
    updateKnowledgeCandidate,
    createKnowledgeCandidate,
    listKnowledgeDocs,
    createKnowledgeDoc,
    updateKnowledgeDoc,
    deleteKnowledgeDoc,
    getKnowledgeBasePath,
} from "./libs/knowledge-store.js";
import { SHARED_TOOL_CATALOG, type ToolCatalogEntry } from "./libs/shared-mcp.js";

// ─── Memory janitor: run on startup + every 24 h ─────────────
function startMemoryJanitor(): void {
    try {
        const result = runMemoryJanitor();
        if (result.archived > 0) {
            console.log(`[MemoryJanitor] Archived ${result.archived} expired item(s).`);
        }
        refreshRootAbstract();
    } catch (e) {
        console.warn("[MemoryJanitor] Failed:", e);
    }
}

const JANITOR_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 h

// ─── Auto-connect bots on startup ────────────────────────────
async function autoConnectBots(win: BrowserWindow): Promise<void> {
    const config = loadAssistantsConfig();
    for (const assistant of config.assistants) {
        // DingTalk
        const dingtalk = assistant.bots?.dingtalk as DingtalkBotConfig | undefined;
        if (dingtalk?.connected && dingtalk.appKey && dingtalk.appSecret) {
            console.log(`[AutoConnect] Starting DingTalk bot for assistant: ${assistant.name}`);
            try {
                await startDingtalkBot({
                    appKey: dingtalk.appKey,
                    appSecret: dingtalk.appSecret,
                    robotCode: dingtalk.robotCode,
                    corpId: dingtalk.corpId,
                    agentId: dingtalk.agentId,
                    assistantId: assistant.id,
                    assistantName: assistant.name,
                    persona: assistant.persona,
                    coreValues: assistant.coreValues,
                    relationship: assistant.relationship,
                    cognitiveStyle: assistant.cognitiveStyle,
                    operatingGuidelines: assistant.operatingGuidelines,
                    userContext: config.userContext,
                    provider: assistant.provider,
                    model: assistant.model,
                    defaultCwd: assistant.defaultCwd,
                    messageType: dingtalk.messageType,
                    cardTemplateId: dingtalk.cardTemplateId,
                    cardTemplateKey: dingtalk.cardTemplateKey,
                    dmPolicy: dingtalk.dmPolicy,
                    groupPolicy: dingtalk.groupPolicy,
                    allowFrom: dingtalk.allowFrom,
                    maxConnectionAttempts: dingtalk.maxConnectionAttempts,
                    initialReconnectDelay: dingtalk.initialReconnectDelay,
                    maxReconnectDelay: dingtalk.maxReconnectDelay,
                    reconnectJitter: dingtalk.reconnectJitter,
                    ownerStaffIds: dingtalk.ownerStaffIds,
                });
                console.log(`[AutoConnect] DingTalk bot connected for: ${assistant.name}`);
            } catch (err) {
                console.error(`[AutoConnect] Failed to connect DingTalk bot for ${assistant.name}:`, err);
                win.webContents.send("dingtalk-bot-status", {
                    assistantId: assistant.id,
                    status: "error",
                    detail: err instanceof Error ? err.message : String(err),
                });
            }
        }

        // Telegram
        const telegram = assistant.bots?.telegram as TelegramBotConfig | undefined;
        if (telegram?.connected && telegram.token) {
            console.log(`[AutoConnect] Starting Telegram bot for assistant: ${assistant.name}`);
            try {
                await startTelegramBot({
                    token: telegram.token,
                    proxy: telegram.proxy,
                    assistantId: assistant.id,
                    assistantName: assistant.name,
                    skillNames: assistant.skillNames,
                    persona: assistant.persona,
                    coreValues: assistant.coreValues,
                    relationship: assistant.relationship,
                    cognitiveStyle: assistant.cognitiveStyle,
                    operatingGuidelines: assistant.operatingGuidelines,
                    userContext: config.userContext,
                    provider: assistant.provider,
                    model: assistant.model,
                    defaultCwd: assistant.defaultCwd,
                    dmPolicy: telegram.dmPolicy,
                    groupPolicy: telegram.groupPolicy,
                    allowFrom: telegram.allowFrom,
                    requireMention: telegram.requireMention,
                    ownerUserIds: telegram.ownerUserIds,
                });
                console.log(`[AutoConnect] Telegram bot connected for: ${assistant.name}`);
            } catch (err) {
                console.error(`[AutoConnect] Failed to connect Telegram bot for ${assistant.name}:`, err);
                win.webContents.send("telegram-bot-status", {
                    assistantId: assistant.id,
                    status: "error",
                    detail: err instanceof Error ? err.message : String(err),
                });
            }
        }

        // Feishu
        const feishu = assistant.bots?.feishu as FeishuBotConfig | undefined;
        if (feishu?.connected && feishu.appId && feishu.appSecret) {
            console.log(`[AutoConnect] Starting Feishu bot for assistant: ${assistant.name}`);
            try {
                await startFeishuBot({
                    appId: feishu.appId,
                    appSecret: feishu.appSecret,
                    domain: feishu.domain,
                    assistantId: assistant.id,
                    assistantName: assistant.name,
                    persona: assistant.persona,
                    coreValues: assistant.coreValues,
                    relationship: assistant.relationship,
                    cognitiveStyle: assistant.cognitiveStyle,
                    operatingGuidelines: assistant.operatingGuidelines,
                    userContext: config.userContext,
                    provider: assistant.provider,
                    model: assistant.model,
                    defaultCwd: assistant.defaultCwd,
                });
                console.log(`[AutoConnect] Feishu bot connected for: ${assistant.name}`);
            } catch (err) {
                console.error(`[AutoConnect] Failed to connect Feishu bot for ${assistant.name}:`, err);
                win.webContents.send("feishu-bot-status", {
                    assistantId: assistant.id,
                    status: "error",
                    detail: err instanceof Error ? err.message : String(err),
                });
            }
        }
    }
}

// Must be called before app is ready
protocol.registerSchemesAsPrivileged([
    { scheme: "localfile", privileges: { secure: true, standard: true, supportFetchAPI: true, bypassCSP: true } }
]);

let isQuitting = false;

app.on("ready", async () => {
    // Serve local files via localfile:// — file:// is blocked from http://localhost by Chromium
    protocol.handle("localfile", async (request) => {
        try {
            const { promises: fs } = await import("fs");
            const url = new URL(request.url);
            // localfile:///absolute/path  → hostname="" pathname="/absolute/path"
            // localfile://partial/path    → hostname="partial" pathname="/path" (browser normalised away one slash)
            // Reconstruct the full absolute path in both cases.
            const filePath = decodeURIComponent(
                url.hostname ? `/${url.hostname}${url.pathname}` : url.pathname
            );
            const data = await fs.readFile(filePath);
            const ext = filePath.split(".").pop()?.toLowerCase() ?? "";
            const mimeMap: Record<string, string> = {
                jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png",
                gif: "image/gif", webp: "image/webp", bmp: "image/bmp",
                svg: "image/svg+xml", ico: "image/x-icon", tiff: "image/tiff", avif: "image/avif",
            };
            return new Response(data, { headers: { "Content-Type": mimeMap[ext] ?? "application/octet-stream" } });
        } catch {
            return new Response("Not found", { status: 404 });
        }
    });

    // Ensure app name shows correctly in dev mode (overrides the default "Electron")
    app.setName("AI Team");

    // Set Dock icon on macOS (required in dev mode; production uses .icns from app bundle)
    if (process.platform === "darwin" && app.dock) {
        try {
            app.dock.setIcon(getIconPath());
        } catch (e) {
            console.warn("[main] Failed to set dock icon:", e);
        }
    }

    // Run memory janitor once on startup, then every 24 h
    startMemoryJanitor();
    setInterval(startMemoryJanitor, JANITOR_INTERVAL_MS);

    // Ensure Codex auth.json is in sync with stored tokens
    ensureCodexAuthSync();

    // Seed built-in MCP servers (opennews, opentwitter) into ~/.claude/settings.json
    ensureBuiltinMcpServers();

    // Deploy built-in skills (skill-creator, etc.) to ~/.claude/skills/ and ~/.codex/skills/
    seedBuiltinSkills();

    // Start the embedded API server
    console.log("Starting embedded API server...");
    const started = await startEmbeddedApi();
    if (started) {
        console.log("Embedded API server started successfully");
        // Wire webhook route to the same session handler
        setWebhookSessionRunner(handleClientEvent);
    } else {
        console.error("Failed to start embedded API server");
    }
    function createMainWindow(): BrowserWindow {
        const isMac = process.platform === "darwin";
        const win = new BrowserWindow({
            width: 1200,
            height: 800,
            minWidth: 900,
            minHeight: 600,
            webPreferences: {
                preload: getPreloadPath(),
            },
            icon: getIconPath(),
            ...(isMac
                ? { titleBarStyle: "hiddenInset", trafficLightPosition: { x: 15, y: 18 } }
                : { frame: false }),
            backgroundColor: "#FAF9F6",
        });

        if (isDev()) {
            win.loadURL(`http://localhost:${DEV_PORT}`);
        } else {
            win.loadFile(getUIPath());
        }
        // Hide instead of close so the app stays alive for quick window
        win.on("close", (e) => {
            if (!isQuitting) {
                e.preventDefault();
                win.hide();
            }
        });

        pollResources(win);
        return win;
    }

    let mainWindow = createMainWindow();

    // ─── System tray ─────────────────────────────────────────────────
    try {
        let trayIcon: Electron.NativeImage;
        if (process.platform === "win32") {
            // Windows tray needs a square icon (16x16 logical); resize app-icon @2x = 32x32 raw
            trayIcon = nativeImage.createFromPath(getIconPath()).resize({ width: 32, height: 32 });
        } else {
            // macOS: pill-shaped template icon, 120x44 raw = 60x22pt @2x Retina
            trayIcon = nativeImage.createFromBuffer(
                fs.readFileSync(getTrayIconPath()),
                { scaleFactor: 2.0 }
            );
        }
        const tray = new Tray(trayIcon);
        tray.setToolTip("VK Cowork");
        tray.on("click", () => {
            if (mainWindow.isDestroyed()) {
                mainWindow = createMainWindow();
            }
            if (mainWindow.isMinimized()) mainWindow.restore();
            if (!mainWindow.isVisible()) mainWindow.show();
            mainWindow.focus();
        });
        tray.setContextMenu(Menu.buildFromTemplate([
            { label: "打开主窗口", click: () => tray.emit("click") },
            { type: "separator" },
            { label: "退出", click: () => app.quit() },
        ]));
    } catch (e) {
        console.warn("[main] Failed to create system tray:", e);
    }

    // ─── Window controls (for custom frameless title bar on Windows) ─
    ipcMain.on("window-minimize", () => mainWindow?.minimize());
    ipcMain.on("window-maximize", () => {
        if (mainWindow?.isMaximized()) {
            mainWindow.unmaximize();
        } else {
            mainWindow?.maximize();
        }
    });
    ipcMain.on("window-close", () => mainWindow?.close());
    ipcMain.handle("window-is-maximized", () => mainWindow?.isMaximized() ?? false);
    mainWindow.on("maximize", () => {
      if (!mainWindow?.isDestroyed()) {
        mainWindow.webContents.send("window-maximized-change", true);
      }
    });
    mainWindow.on("unmaximize", () => {
      if (!mainWindow?.isDestroyed()) {
        mainWindow.webContents.send("window-maximized-change", false);
      }
    });

    // ─── Quick Window ────────────────────────────────────────────────
    const DEFAULT_QUICK_SHORTCUT = "Alt+Space";
    let quickWindow: BrowserWindow | null = null;
    let suppressBlur = false;

    function createQuickWindow() {
        const cursor = screen.getCursorScreenPoint();
        const display = screen.getDisplayNearestPoint(cursor);
        const { width: screenW } = display.workAreaSize;
        const winWidth = 640;
        const winHeight = 152;
        const x = display.workArea.x + Math.round((screenW - winWidth) / 2);
        const y = display.workArea.y + Math.round(display.workAreaSize.height * 0.28);

        quickWindow = new BrowserWindow({
            width: winWidth,
            height: winHeight,
            x,
            y,
            frame: false,
            transparent: true,
            resizable: false,
            movable: true,
            alwaysOnTop: true,
            skipTaskbar: true,
            show: false,
            hasShadow: true,
            roundedCorners: true,
            webPreferences: {
                preload: getPreloadPath(),
            },
        });

        const quickUrl = isDev()
            ? `http://localhost:${DEV_PORT}?mode=quick`
            : getUIPath();

        if (isDev()) {
            quickWindow.loadURL(quickUrl);
        } else {
            quickWindow.loadFile(quickUrl, { query: { mode: "quick" } });
        }
        quickWindow.on("blur", () => {
            setTimeout(() => {
                if (suppressBlur) return;
                if (quickWindow && !quickWindow.isDestroyed() && quickWindow.isVisible()) {
                    quickWindow.hide();
                }
            }, 100);
        });

        quickWindow.on("closed", () => {
            quickWindow = null;
        });
    }

    function getQuickWindowPosition(): { x: number; y: number } {
        const cursor = screen.getCursorScreenPoint();
        const display = screen.getDisplayNearestPoint(cursor);
        const { width: screenW } = display.workAreaSize;
        const winWidth = 640;
        const x = display.workArea.x + Math.round((screenW - winWidth) / 2);
        const y = display.workArea.y + Math.round(display.workAreaSize.height * 0.28);
        return { x, y };
    }

    function toggleQuickWindow() {
        if (!quickWindow || quickWindow.isDestroyed()) {
            createQuickWindow();
        }
        if (quickWindow!.isVisible()) {
            quickWindow!.hide();
        } else {
            // Reposition to current display on every show
            const { x, y } = getQuickWindowPosition();
            quickWindow!.setBounds({ x, y, width: 640, height: 152 });
            // true → show → focus, then lock to current Space after a frame.
            // Must be async: macOS needs at least one runloop pass to actually
            // move the window into the active Space before we restrict it.
            quickWindow!.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
            quickWindow!.show();
            quickWindow!.focus();
            quickWindow!.webContents.send("quick-window-show");
            setTimeout(() => {
                if (quickWindow && !quickWindow.isDestroyed()) {
                    quickWindow.setVisibleOnAllWorkspaces(false, { visibleOnFullScreen: true });
                }
            }, 100);
        }
    }

    function registerQuickShortcut(accelerator: string) {
        globalShortcut.unregisterAll();
        if (!accelerator) return;
        try {
            globalShortcut.register(accelerator, toggleQuickWindow);
        } catch (e) {
            console.warn("[QuickWindow] Failed to register shortcut:", accelerator, e);
        }
    }

    const savedShortcut = loadUserSettings().quickWindowShortcut ?? DEFAULT_QUICK_SHORTCUT;
    registerQuickShortcut(savedShortcut);

    ipcMainHandle("get-quick-window-shortcut", () => {
        return loadUserSettings().quickWindowShortcut ?? DEFAULT_QUICK_SHORTCUT;
    });

    ipcMainHandle("save-quick-window-shortcut", (_: any, shortcut: string) => {
        const settings = loadUserSettings();
        settings.quickWindowShortcut = shortcut;
        saveUserSettings(settings);
        registerQuickShortcut(shortcut);
        return true;
    });

    ipcMain.on("resize-quick-window", (_: any, height: number) => {
        if (quickWindow && !quickWindow.isDestroyed()) {
            // Suppress blur during resize — Windows fires blur on setBounds
            suppressBlur = true;
            const bounds = quickWindow.getBounds();
            quickWindow.setBounds({ x: bounds.x, y: bounds.y, width: bounds.width, height: Math.round(height) });
            // Re-focus after resize to reclaim input
            quickWindow.focus();
            setTimeout(() => { suppressBlur = false; }, 300);
        }
    });

    ipcMain.on("hide-quick-window", () => {
        quickWindow?.hide();
    });

    let showMainPending = false;

    function showMainWindowNow() {
        if (showMainPending) return;
        showMainPending = true;
        suppressBlur = true;

        console.log("[QuickWindow] showMainWindowNow called");

        if (mainWindow.isDestroyed()) {
            console.log("[QuickWindow] main window destroyed, recreating");
            mainWindow = createMainWindow();
            // Hide quick window after main is created
            if (quickWindow && !quickWindow.isDestroyed()) quickWindow.hide();
            showMainPending = false;
            suppressBlur = false;
            return;
        }

        // Step 1: Prepare main window (restore/show) but don't focus yet
        if (mainWindow.isMinimized()) mainWindow.restore();
        if (!mainWindow.isVisible()) mainWindow.show();

        // Step 2: Make main window always-on-top (above the quick window)
        mainWindow.setAlwaysOnTop(true, "screen-saver");
        mainWindow.moveTop();

        // Step 3: Now hide the quick window
        if (quickWindow && !quickWindow.isDestroyed() && quickWindow.isVisible()) {
            quickWindow.hide();
            console.log("[QuickWindow] quick window hidden");
        }

        // Step 4: Focus main window after a tick (let Windows process the hide)
        setTimeout(() => {
            if (mainWindow.isDestroyed()) {
                showMainPending = false;
                suppressBlur = false;
                return;
            }

            app.focus({ steal: true });
            mainWindow.focus();
            console.log("[QuickWindow] main window focused");

            // Step 5: Release alwaysOnTop after focus is stable
            setTimeout(() => {
                showMainPending = false;
                suppressBlur = false;
                if (!mainWindow.isDestroyed()) {
                    mainWindow.setAlwaysOnTop(false);
                    console.log("[QuickWindow] alwaysOnTop released");
                }
            }, 800);
        }, 100);
    }

    ipcMain.on("show-main-window", showMainWindowNow);

    // Initialize scheduler — inject sessionRunner so tasks fire directly in main process
    startScheduler();
    setSchedulerSessionRunner(handleClientEvent);

    // Register SOP-specific runners for scheduled SOP tasks
    setSopRunner((sopId, scheduledTaskId) => {
        const allSops = loadHandsFromDir(HANDS_DIR);
        const sop = allSops.find((s) => s.id === sopId);
        if (!sop || !sop.stages.length) {
            console.warn(`[Scheduler/SopRunner] SOP not found or empty: ${sopId}`);
            return;
        }
        // Concurrency guard: skip if already running
        const existing = loadWorkflowRun(sopId);
        if (existing?.status === "running") {
            console.warn(`[Scheduler/SopRunner] SOP ${sopId} already running, skipping scheduled trigger`);
            return;
        }
        const run = createWorkflowRun(
            sopId,
            sop.stages.map((s) => ({ id: s.id, label: s.label })),
            { triggerType: "scheduled", scheduledTaskId },
        );
        dispatchWorkflowStage(sop, run, run.stages[0].stageId, scheduledTaskId);
    });

    setSopStageRunner((sopId, stageId, scheduledTaskId) => {
        const allSops = loadHandsFromDir(HANDS_DIR);
        const sop = allSops.find((s) => s.id === sopId);
        if (!sop) {
            console.warn(`[Scheduler/SopStageRunner] SOP not found: ${sopId}`);
            return;
        }
        let run = loadWorkflowRun(sopId);
        // Concurrency guard: skip if this specific stage is already running
        if (run?.stages.find((s) => s.stageId === stageId)?.status === "in_progress") {
            console.warn(`[Scheduler/SopStageRunner] Stage ${stageId} of SOP ${sopId} already in_progress, skipping`);
            return;
        }
        if (!run || run.status === "completed") {
            run = createWorkflowRun(
                sopId,
                sop.stages.map((s) => ({ id: s.id, label: s.label })),
                { triggerType: "scheduled", scheduledTaskId },
            );
        }
        // Reset the stage so it re-runs cleanly
        updateWorkflowStage(sopId, stageId, {
            status: "pending",
            error: undefined,
            output: undefined,
            sessionId: undefined,
            startedAt: undefined,
            completedAt: undefined,
            duration: undefined,
        });
        const freshRun = loadWorkflowRun(sopId)!;
        dispatchWorkflowStage(sop, freshRun, stageId, scheduledTaskId);
    });

    // Run startup hooks after window settles (5 s delay)
    setTimeout(() => {
        try { runHookTasks("startup"); } catch (e) { console.warn("[Startup] Hook error:", e); }
    }, 5000);

    // Start process-level heartbeat loop (replaces scheduler-based heartbeat)
    startHeartbeatLoop(handleClientEvent);
    startMemoryCompactTimer(handleClientEvent);

    // Auto-connect all bots that were previously connected
    autoConnectBots(mainWindow);

    // Broadcast assistant config changes (e.g. auto-populated ownerUserIds/ownerStaffIds) to renderer
    assistantConfigEvents.on("bot-owner-ids-changed", (payload: { assistantId: string; platform: string }) => {
        const wins = BrowserWindow.getAllWindows();
        for (const win of wins) {
            if (!win.isDestroyed()) {
                win.webContents.send("assistant-bot-owner-ids-changed", payload);
            }
        }
    });

    ipcMainHandle("getStaticData", () => {
        return getStaticData();
    });

    // Handle client events
    ipcMain.on("client-event", (ipcEvent, event: ClientEvent) => {
        if (event.type === "session.start") {
            const isFromQuick = quickWindow && !quickWindow.isDestroyed() && ipcEvent.sender === quickWindow.webContents;
            const isFromMain = !mainWindow.isDestroyed() && ipcEvent.sender === mainWindow.webContents;
            console.log(`[IPC] session.start received — fromQuick=${isFromQuick}, fromMain=${isFromMain}, quickWindow=${!!quickWindow}, assistantId=${event.payload.assistantId}`);
        }

        handleClientEvent(event);

        // If session.start came from the quick window, auto-show main window
        if (
            event.type === "session.start" &&
            quickWindow &&
            !quickWindow.isDestroyed() &&
            ipcEvent.sender === quickWindow.webContents
        ) {
            console.log("[QuickWindow] session.start from quick window, showing main");

            // Tell the main window to prepare for the incoming session
            if (!mainWindow.isDestroyed()) {
                mainWindow.webContents.send("quick-window-session", {
                    assistantId: event.payload.assistantId,
                });
            }

            setTimeout(() => showMainWindowNow(), 150);
        }
    });

    // Handle session title generation (simple fallback - can be enhanced later)
    ipcMainHandle("generate-session-title", async (_: any, userInput: string | null) => {
        if (!userInput) return "New Session";
        // Simple title generation - truncate to reasonable length
        const title = userInput.slice(0, 50).trim();
        return title || "New Session";
    });

    // Generate skill tags for an assistant using the agent SDK
    ipcMainHandle("generate-skill-tags", async (_: any, persona: string, skillNames: string[], assistantName: string) => {
        try {
            const { generateSkillTags } = await import("./api/services/runner.js");
            return await generateSkillTags(persona, skillNames, assistantName);
        } catch (error) {
            console.error("[main] Failed to generate skill tags:", error);
            return [];
        }
    });

    // Handle recent cwds request
    ipcMainHandle("get-recent-cwds", (_: any, limit?: number) => {
        const boundedLimit = limit ? Math.min(Math.max(limit, 1), 20) : 8;
        return sessions.listRecentCwds(boundedLimit);
    });

    // Handle directory selection
    ipcMainHandle("select-directory", async () => {
        const result = await dialog.showOpenDialog(mainWindow, {
            properties: ['openDirectory']
        });
        
        if (result.canceled) {
            return null;
        }
        
        return result.filePaths[0];
    });

    // Handle user settings
    ipcMainHandle("get-user-settings", () => {
        return loadUserSettings();
    });

    ipcMainHandle("save-user-settings", (_: any, settings: Partial<UserSettings>) => {
        // Merge with existing settings to preserve fields like openaiTokens
        const existing = loadUserSettings();
        const merged = { ...existing, ...settings };
        saveUserSettings(merged);
        reloadClaudeSettings();
        return true;
    });

    ipcMainHandle("get-knowledge-candidates", () => {
        return listKnowledgeCandidates();
    });

    ipcMainHandle("update-knowledge-candidate-status", (_: any, id: string, status: "draft" | "verified" | "archived") => {
        return updateKnowledgeCandidateReviewStatus(id, status);
    });

    ipcMainHandle("delete-knowledge-candidate", (_: any, id: string) => {
        return deleteKnowledgeCandidate(id);
    });

    ipcMainHandle("refine-knowledge-candidate", async (_: any, id: string) => {
        const candidate = getKnowledgeCandidateById(id);
        if (!candidate) return null;
        const history = sessions.getSessionHistory(candidate.sourceSessionId);
        if (!history?.messages?.length) return null;
        const digest = buildConversationDigest(history.messages);
        if (digest.length < 100) return null;
        const aiResult = await extractExperienceViaAI(digest, candidate.title);
        if (!aiResult) return null;
        return updateKnowledgeCandidate(id, aiResult);
    });

    ipcMainHandle("create-knowledge-candidate-from-like", async (_: any, sessionId: string, text: string) => {
        if (!sessionId || !text) return null;
        console.log("[IPC] create-knowledge-candidate-from-like called, sessionId:", sessionId, "text length:", text.length);

        const session = sessions.getSession(sessionId);
        const title = session?.title || "普通会话";
        const candidate = createKnowledgeCandidate({
            title: `${title.slice(0, 100)} · 经验候选`,
            scenario: title.slice(0, 120),
            steps: "",
            result: text.slice(0, 1200),
            risk: "待人工审核",
            sourceSessionId: sessionId,
            assistantId: session?.assistantId,
        });
        console.log("[IPC] Created new candidate from like:", candidate.id);

        setImmediate(async () => {
            try {
                const history = sessions.getSessionHistory(sessionId);
                if (!history?.messages?.length) return;
                const digest = buildConversationDigest(history.messages);
                if (digest.length < 50) return;
                const aiResult = await extractExperienceViaAI(digest, title);
                if (aiResult) {
                    updateKnowledgeCandidate(candidate.id, aiResult);
                    console.log("[IPC] Liked candidate refined via AI:", candidate.id);
                }
            } catch (err) {
                console.warn("[IPC] AI refinement for liked candidate failed:", err);
            }
        });

        return candidate;
    });

    ipcMainHandle("get-knowledge-docs", () => {
        return listKnowledgeDocs();
    });

    ipcMainHandle("create-knowledge-doc", (_: any, title: string, content: string) => {
        return createKnowledgeDoc(title, content);
    });

    ipcMainHandle("update-knowledge-doc", (_: any, id: string, title: string, content: string) => {
        return updateKnowledgeDoc(id, title, content);
    });

    ipcMainHandle("delete-knowledge-doc", (_: any, id: string) => {
        return deleteKnowledgeDoc(id);
    });

    ipcMainHandle("get-knowledge-base-path", () => {
        return getKnowledgeBasePath();
    });

    ipcMainHandle("test-alert-webhook", async (_: any, input: { webhookUrl: string; secret?: string }) => {
        try {
            const settings = loadUserSettings();
            return await sendTestDingtalkAlert(input.webhookUrl, input.secret, {
                userName: settings.userName,
                workDescription: settings.workDescription,
                email: settings.googleUser?.email,
            });
        } catch (err) {
            const error = err instanceof Error ? err.message : String(err);
            console.error("[test-alert-webhook] unexpected error:", error);
            return { ok: false, error };
        }
    });

    ipcMainHandle("get-assistants-config", () => {
        const config = loadAssistantsConfig();
        return {
            ...config,
            defaults: {
                defaultProvider: resolveDefaultProvider(),
                persona: DEFAULT_PERSONA,
                coreValues: DEFAULT_CORE_VALUES,
                relationship: DEFAULT_RELATIONSHIP,
                cognitiveStyle: DEFAULT_COGNITIVE_STYLE,
                operatingGuidelines: DEFAULT_OPERATING_GUIDELINES,
                heartbeatRules: DEFAULT_HEARTBEAT_RULES,
            },
        };
    });

    ipcMainHandle("save-assistants-config", (_: any, config: AssistantsConfig) => {
        const result = saveAssistantsConfig(config);
        const configUpdates = {
            provider: undefined as "claude" | "codex" | undefined,
            model: undefined as string | undefined,
            persona: undefined as string | undefined,
            coreValues: undefined as string | undefined,
            relationship: undefined as string | undefined,
            cognitiveStyle: undefined as string | undefined,
            operatingGuidelines: undefined as string | undefined,
            userContext: config.userContext,
            assistantName: undefined as string | undefined,
            defaultCwd: undefined as string | undefined,
        };
        for (const assistant of config.assistants) {
            const updates = {
                ...configUpdates,
                provider: assistant.provider,
                model: assistant.model,
                persona: assistant.persona,
                coreValues: assistant.coreValues,
                relationship: assistant.relationship,
                cognitiveStyle: assistant.cognitiveStyle,
                operatingGuidelines: assistant.operatingGuidelines,
                assistantName: assistant.name,
                defaultCwd: assistant.defaultCwd,
                skillNames: assistant.skillNames,
            };
            const dingtalk = assistant.bots?.dingtalk as DingtalkBotConfig | undefined;
            updateDingtalkBotConfig(assistant.id, {
                ...updates,
                messageType: dingtalk?.messageType,
                cardTemplateId: dingtalk?.cardTemplateId,
                cardTemplateKey: dingtalk?.cardTemplateKey,
                dmPolicy: dingtalk?.dmPolicy,
                groupPolicy: dingtalk?.groupPolicy,
                allowFrom: dingtalk?.allowFrom,
            });
            updateTelegramBotConfig(assistant.id, updates);
            updateFeishuBotConfig(assistant.id, updates);
        }

        // Notify all renderer windows so Sidebar refreshes without restart
        const wins = BrowserWindow.getAllWindows();
        for (const win of wins) {
            if (!win.isDestroyed()) {
                win.webContents.send("assistants-config-changed", result);
            }
        }

        return result;
    });

    // Bot config handlers
    ipcMainHandle("get-bot-config", () => {
        return loadBotConfig();
    });

    ipcMainHandle("save-bot-config", (_: any, config: BotConfig) => {
        return saveBotConfig(config);
    });

    ipcMainHandle("test-bot-connection", async (_: any, platformConfig: BotPlatformConfig) => {
        return await testBotConnection(platformConfig);
    });

    // DingTalk bot lifecycle handlers
    ipcMainHandle("start-dingtalk-bot", async (_: any, input: DingtalkBotOptions) => {
        try {
            await startDingtalkBot(input);
            return { status: getDingtalkBotStatus(input.assistantId) as DingtalkBotStatus };
        } catch (err) {
            const detail = err instanceof Error ? err.message : String(err);
            return { status: "error" as DingtalkBotStatus, detail };
        }
    });

    ipcMainHandle("stop-dingtalk-bot", (_: any, assistantId: string) => {
        stopDingtalkBot(assistantId);
    });

    ipcMainHandle("get-dingtalk-bot-status", (_: any, assistantId: string) => {
        return { status: getDingtalkBotStatus(assistantId) as DingtalkBotStatus };
    });

    ipcMainHandle("send-proactive-dingtalk", async (_: any, input: { assistantId: string; text: string; targets?: string[]; title?: string }) => {
        return await sendProactiveDingtalkMessage(input.assistantId, input.text, {
            targets: input.targets,
            title: input.title,
        });
    });

    ipcMainHandle("send-proactive-dingtalk-media", async (_: any, input: { assistantId: string; filePath: string; targets?: string[]; mediaType?: "image" | "voice" | "video" | "file" }) => {
        return await sendProactiveMediaDingtalk(input.assistantId, input.filePath, {
            targets: input.targets,
            mediaType: input.mediaType,
        });
    });

    ipcMainHandle("get-dingtalk-last-seen", (_: any, assistantId: string) => {
        return getLastSeenTargets(assistantId);
    });

    // Forward DingTalk bot status changes to renderer
    onDingtalkBotStatusChange((assistantId, status, detail) => {
        const windows = BrowserWindow.getAllWindows();
        for (const win of windows) {
            if (!win.isDestroyed()) {
                win.webContents.send("dingtalk-bot-status", { assistantId, status, detail });
            }
        }
    });

    // Forward DingTalk session title/status updates to renderer via existing server-event channel
    onDingtalkSessionUpdate((sessionId, updates) => {
        const event = JSON.stringify({
            type: "session.status",
            payload: { sessionId, status: updates.status ?? "idle", title: updates.title },
        });
        const windows = BrowserWindow.getAllWindows();
        for (const win of windows) {
            if (!win.isDestroyed()) {
                win.webContents.send("server-event", event);
            }
        }
    });

    // Feishu bot lifecycle handlers
    ipcMainHandle("start-feishu-bot", async (_: any, input: FeishuBotOptions) => {
        try {
            await startFeishuBot(input);
            return { status: getFeishuBotStatus(input.assistantId) as FeishuBotStatus };
        } catch (err) {
            const detail = err instanceof Error ? err.message : String(err);
            return { status: "error" as FeishuBotStatus, detail };
        }
    });

    ipcMainHandle("stop-feishu-bot", (_: any, assistantId: string) => {
        stopFeishuBot(assistantId);
    });

    ipcMainHandle("get-feishu-bot-status", (_: any, assistantId: string) => {
        return { status: getFeishuBotStatus(assistantId) as FeishuBotStatus };
    });

    // Telegram bot lifecycle handlers
    ipcMainHandle("start-telegram-bot", async (_: any, input: TelegramBotOptions) => {
        try {
            await startTelegramBot(input);
            return { status: getTelegramBotStatus(input.assistantId) as TelegramBotStatus };
        } catch (err) {
            const detail = err instanceof Error ? err.message : String(err);
            console.error("[Telegram] startTelegramBot failed:", detail);
            return { status: "error" as TelegramBotStatus, detail };
        }
    });

    ipcMainHandle("stop-telegram-bot", (_: any, assistantId: string) => {
        stopTelegramBot(assistantId);
    });

    ipcMainHandle("get-telegram-bot-status", (_: any, assistantId: string) => {
        return { status: getTelegramBotStatus(assistantId) as TelegramBotStatus };
    });

    ipcMainHandle("send-proactive-telegram", async (_: any, input: { assistantId: string; text: string; targets?: string[] }) => {
        return await sendProactiveTelegramMessage(input.assistantId, input.text, {
            targets: input.targets,
        });
    });

    // Forward Telegram bot status changes to renderer
    onTelegramBotStatusChange((assistantId, status, detail) => {
        const windows = BrowserWindow.getAllWindows();
        for (const win of windows) {
            if (!win.isDestroyed()) {
                win.webContents.send("telegram-bot-status", { assistantId, status, detail });
            }
        }
    });

    // Forward Telegram session title/status updates to renderer
    onTelegramSessionUpdate((sessionId, updates) => {
        const event = JSON.stringify({
            type: "session.status",
            payload: { sessionId, status: updates.status ?? "idle", title: updates.title },
        });
        const windows = BrowserWindow.getAllWindows();
        for (const win of windows) {
            if (!win.isDestroyed()) {
                win.webContents.send("server-event", event);
            }
        }
    });

    // Forward Feishu bot status changes to renderer
    onFeishuBotStatusChange((assistantId, status, detail) => {
        const windows = BrowserWindow.getAllWindows();
        for (const win of windows) {
            if (!win.isDestroyed()) {
                win.webContents.send("feishu-bot-status", { assistantId, status, detail });
            }
        }
    });

    // Scheduler handlers
    ipcMainHandle("get-scheduled-tasks", () => {
        return loadScheduledTasks();
    });

    ipcMainHandle("add-scheduled-task", async (_: any, task: Omit<ScheduledTask, "id" | "createdAt" | "updatedAt">) => {
        return await addScheduledTask(task);
    });

    ipcMainHandle("update-scheduled-task", async (_: any, id: string, updates: Partial<ScheduledTask>) => {
        return await updateScheduledTask(id, updates);
    });

    ipcMainHandle("delete-scheduled-task", async (_: any, id: string) => {
        return await deleteScheduledTask(id);
    });

    function normalizeWorkCategory(value: string): "客户服务" | "情报监控" | "内部运营" | "增长销售" | "" {
        const raw = value.trim();
        if (!raw) return "";
        const mapping: Record<string, "客户服务" | "情报监控" | "内部运营" | "增长销售"> = {
            "客户服务": "客户服务",
            "情报监控": "情报监控",
            "内部运营": "内部运营",
            "增长销售": "增长销售",
            communication: "客户服务",
            content: "增长销售",
            operations: "内部运营",
            finance: "内部运营",
            hr: "内部运营",
            competitor: "情报监控",
            intelligence: "情报监控",
            sales: "增长销售",
            growth: "增长销售",
        };
        return mapping[raw] ?? "";
    }

    function getSopCategoryMap(): Map<string, ReturnType<typeof normalizeWorkCategory>> {
        const map = new Map<string, ReturnType<typeof normalizeWorkCategory>>();
        for (const sop of loadHandsFromDir(HANDS_DIR)) {
            map.set(sop.name, normalizeWorkCategory(sop.category));
            map.set(sop.id, normalizeWorkCategory(sop.category));
        }
        return map;
    }

    // Plan table handlers
    const PLAN_TIMEOUT_MS = 2 * 60 * 60 * 1000; // 2 hours
    ipcMainHandle("get-plan-items", () => {
        const categoryMap = getSopCategoryMap();
        const now = Date.now();
        const items = loadPlanItems();
        for (const item of items) {
            if (
                item.status === "in_progress" &&
                now - new Date(item.updatedAt).getTime() > PLAN_TIMEOUT_MS
            ) {
                updatePlanItem(item.id, {
                    status: "failed",
                    result: "超时自动标记失败（in_progress 超过 2 小时无响应）",
                });
                console.warn(`[PlanStore] Timeout: ${item.sopName} · ${item.targetName || item.id} auto-failed after 2h`);
            }
        }
        return loadPlanItems().map((item) => ({
            ...item,
            category: item.category || categoryMap.get(item.sopName) || "",
        }));
    });

    function buildPlanPrompt(content: string, sopName: string, planItemId: string, category = "", targetId = "", targetName = ""): string {
        return `${content}

---
【计划项执行规范 - 必须遵守】
本次任务来自计划表（SOP: ${sopName}，计划项 ID: ${planItemId}），执行全程须调用以下 MCP 工具管理状态：

1. **任务开始时**：调用 upsert_plan_item
   - sop_name: "${sopName}"
   - category: "${category}"
   - target_id: "${targetId}"
   - target_name: "${targetName}"
   - status: "in_progress"
   - content: 当前任务描述

2. **任务完成后**：必须调用 complete_plan_item
   - sop_name: "${sopName}"
   - target_id: "${targetId}"
   - result: 执行结果摘要（100字以内）

3. **任务失败时**：调用 fail_plan_item
   - sop_name: "${sopName}"
   - target_id: "${targetId}"
   - reason: 失败原因

⚠️ 无论任务成功还是失败，结束前都必须调用对应工具更新计划项状态，否则计划表将无法同步进度。`;
    }

    ipcMainHandle("retry-plan-item", (_: any, id: string) => {
        const items = loadPlanItems();
        const item = items.find((i) => i.id === id);
        if (!item) return { ok: false, error: "Plan item not found" };
        const effectiveCategory = item.category || getSopCategoryMap().get(item.sopName) || "";

        updatePlanItem(id, { status: "pending", result: "", completedAt: null });

        const windows = BrowserWindow.getAllWindows();
        for (const win of windows) {
            if (!win.isDestroyed()) {
                win.webContents.send("scheduler:run-task", {
                    name: item.sopName,
                    sopName: item.sopName,
                    planTaskName: item.content.split("\n")[0].slice(0, 40),
                    prompt: buildPlanPrompt(item.content, item.sopName, id, effectiveCategory, item.targetId, item.targetName),
                    assistantId: item.assistantId,
                    cwd: undefined,
                    planItemId: id,
                });
            }
        }
        return { ok: true };
    });

    ipcMainHandle("run-plan-item-now", (_: any, id: string) => {
        const items = loadPlanItems();
        const item = items.find((i) => i.id === id);
        if (!item) return { ok: false, error: "Plan item not found" };
        const effectiveCategory = item.category || getSopCategoryMap().get(item.sopName) || "";

        updatePlanItem(id, { status: "in_progress" });

        const windows = BrowserWindow.getAllWindows();
        for (const win of windows) {
            if (!win.isDestroyed()) {
                win.webContents.send("scheduler:run-task", {
                    name: item.sopName,
                    sopName: item.sopName,
                    planTaskName: item.content.split("\n")[0].slice(0, 40),
                    prompt: buildPlanPrompt(item.content, item.sopName, id, effectiveCategory, item.targetId, item.targetName),
                    assistantId: item.assistantId,
                    cwd: undefined,
                    planItemId: id,
                });
            }
        }
        return { ok: true };
    });

    ipcMainHandle("update-plan-item-session", (_: any, planItemId: string, sessionId: string) => {
        const result = updatePlanItem(planItemId, { sessionId });
        return result ? { ok: true } : { ok: false, error: "Plan item not found" };
    });

    // Handle environment checks
    ipcMainHandle("check-environment", async () => {
        return await runEnvironmentChecks();
    });

    // Handle API config validation
    ipcMainHandle("validate-api-config", async (_: any, baseUrl?: string, authToken?: string, model?: string) => {
        return await validateApiConfig(baseUrl, authToken, model);
    });

    // OpenAI Codex OAuth handlers
    ipcMainHandle("openai-login", async () => {
        return await openAILogin(mainWindow);
    });

    ipcMainHandle("openai-logout", () => {
        openAILogout();
        return { success: true };
    });

    ipcMainHandle("openai-auth-status", () => {
        return getOpenAIAuthStatus();
    });

    // Google OAuth handlers
    ipcMainHandle("google-login", async () => {
        return await googleLogin();
    });

    ipcMainHandle("google-logout", () => {
        googleLogout();
        return { success: true };
    });

    ipcMainHandle("google-auth-status", () => {
        return getGoogleAuthStatus();
    });

    // Memory system
    // The optional last argument `assistantId` scopes per-assistant operations.
    // Shared operations (long-term, daily, abstract) are unaffected by assistantId.
    ipcMainHandle("memory-read", async (_: any, target: string, date?: string, assistantId?: string) => {
        const scoped = assistantId ? new ScopedMemory(assistantId) : null;
        if (target === "long-term") return { content: readLongTermMemory() };
        if (target === "assistant-long-term") return { content: scoped ? scoped.readLongTermMemory() : "" };
        if (target === "daily") return { content: readDailyMemory(date ?? localDateStr()) };
        if (target === "assistant-daily") return { content: scoped ? scoped.readDaily(date ?? localDateStr()) : "" };
        if (target === "context") return { content: await buildMemoryContext() };
        if (target === "session-state") return { content: scoped ? scoped.readSessionState() : readSessionState() };
        if (target === "abstract") return { content: readAbstract() };
        return { content: "", memoryDir: getMemoryDir() };
    });

    ipcMainHandle("memory-write", (_: any, target: string, content: string, date?: string, assistantId?: string) => {
        const scoped = assistantId ? new ScopedMemory(assistantId) : null;
        if (target === "long-term") { writeLongTermMemory(content); return { success: true }; }
        if (target === "assistant-long-term") { scoped?.writeLongTermMemory(content); return { success: true }; }
        if (target === "daily-append") { appendDailyMemory(content, date); return { success: true }; }
        if (target === "daily") { writeDailyMemory(content, date ?? localDateStr()); return { success: true }; }
        if (target === "assistant-daily-append") { scoped?.appendDaily(content, date); return { success: true }; }
        if (target === "session-state") {
            if (scoped) scoped.writeSessionState(content); else writeSessionState(content);
            return { success: true };
        }
        if (target === "session-state-clear") {
            if (scoped) scoped.clearSessionState(); else clearSessionState();
            return { success: true };
        }
        return { success: false, error: "Unknown target" };
    });

    ipcMainHandle("memory-list", (_: any, assistantId?: string) => {
        const scoped = assistantId ? new ScopedMemory(assistantId) : null;
        return {
            memoryDir: getMemoryDir(),
            summary: scoped ? scoped.getMemorySummary() : getMemorySummary(),
            dailies: listDailyMemories(),
            assistantDailies: scoped ? scoped.listDailies() : [],
            lastCompactionAt: readLastCompactionAt(),
        };
    });

    // Request folder access permission (macOS)
    // This opens a dialog for the user to select a folder, which grants access
    ipcMainHandle("request-folder-access", async (_: any, folderPath?: string) => {
        const defaultPath = folderPath || app.getPath("downloads");
        const result = await dialog.showOpenDialog(mainWindow, {
            title: "Grant Folder Access",
            message: "Please select the folder to grant access permission",
            defaultPath,
            properties: ["openDirectory", "createDirectory"],
            securityScopedBookmarks: true
        });
        
        if (result.canceled) {
            return { granted: false, path: null };
        }
        
        return { 
            granted: true, 
            path: result.filePaths[0],
            bookmark: result.bookmarks?.[0]
        };
    });

    // Open macOS Privacy & Security settings
    ipcMainHandle("open-privacy-settings", async () => {
        if (process.platform === "darwin") {
            // Open Privacy & Security > Files and Folders
            await shell.openExternal("x-apple.systempreferences:com.apple.preference.security?Privacy_FilesAndFolders");
            return true;
        }
        return false;
    });

    // Open a path in the system file manager
    ipcMainHandle("open-path", async (_: any, targetPath: string) => {
        console.log("[open-path] Opening:", targetPath);
        if (!existsSync(targetPath)) {
            mkdirSync(targetPath, { recursive: true });
        }
        const err = await shell.openPath(targetPath);
        if (err) {
            console.error("[open-path] Failed:", err);
            return false;
        }
        return true;
    });

    // Reveal a file or directory in the system file manager (Finder/Explorer), selecting it
    ipcMainHandle("show-item-in-folder", async (_: any, targetPath: string) => {
        console.log("[show-item-in-folder] Revealing:", targetPath);
        shell.showItemInFolder(targetPath);
        return true;
    });

    // Open a web URL in system default browser
    ipcMainHandle("open-external-url", async (_: any, rawUrl: string) => {
        try {
            const parsed = new URL(rawUrl);
            if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
            await shell.openExternal(parsed.toString());
            return true;
        } catch {
            return false;
        }
    });

    // Handle image selection (returns path only, Agent will use built-in analyze_image tool)
    ipcMainHandle("select-image", async () => {
        const result = await dialog.showOpenDialog(mainWindow, {
            title: "Select Image",
            filters: [
                { name: "Images", extensions: ["jpg", "jpeg", "png", "gif", "webp"] }
            ],
            properties: ["openFile"]
        });
        
        if (result.canceled || result.filePaths.length === 0) {
            return null;
        }
        
        return result.filePaths[0];
    });

    // Generate a small thumbnail data URL from a local image path
    ipcMainHandle("get-image-thumbnail", async (_: any, filePath: string) => {
        try {
            const { nativeImage } = await import("electron");
            const img = nativeImage.createFromPath(filePath);
            if (img.isEmpty()) return null;
            const size = img.getSize();
            const maxDim = 128;
            const scale = Math.min(maxDim / size.width, maxDim / size.height, 1);
            const resized = img.resize({ width: Math.round(size.width * scale), height: Math.round(size.height * scale) });
            return resized.toDataURL();
        } catch {
            return null;
        }
    });

    // Save an image to a user-chosen path via Save dialog
    ipcMainHandle("save-image", async (_: any, sourcePath: string) => {
        const path = await import("path");
        const fs = await import("fs");
        const defaultName = path.basename(sourcePath) || "image.png";
        const { ext } = path.parse(defaultName);
        const extLower = ext.toLowerCase();
        const filterMap: Record<string, string> = {
            ".jpg": "JPEG", ".jpeg": "JPEG", ".png": "PNG",
            ".gif": "GIF", ".webp": "WebP", ".bmp": "BMP", ".svg": "SVG",
        };
        const result = await dialog.showSaveDialog(mainWindow, {
            title: "保存图片",
            defaultPath: defaultName,
            filters: [
                { name: filterMap[extLower] ?? "图片", extensions: [extLower.replace(".", "") || "png"] },
                { name: "所有文件", extensions: ["*"] },
            ],
        });
        if (result.canceled || !result.filePath) return { ok: false, reason: "canceled" };
        try {
            await fs.promises.copyFile(sourcePath, result.filePath);
            return { ok: true, savedTo: result.filePath };
        } catch (err) {
            return { ok: false, reason: String(err) };
        }
    });

    // Handle file/folder selection (returns array of { path, isDir })
    ipcMainHandle("select-file", async () => {
        const result = await dialog.showOpenDialog(mainWindow, {
            title: "选择文件或文件夹",
            properties: ["openFile", "openDirectory", "multiSelections"]
        });
        
        if (result.canceled || result.filePaths.length === 0) {
            return null;
        }
        
        const { statSync } = await import("fs");
        return result.filePaths.map(p => {
            let isDir = false;
            try { isDir = statSync(p).isDirectory(); } catch { /* ignore */ }
            return { path: p, isDir };
        });
    });

    // Handle pasted image - save base64 to temp file and return path
    ipcMainHandle("save-pasted-image", async (_: any, base64Data: string, mimeType: string) => {
        const fs = await import("fs");
        const path = await import("path");
        const os = await import("os");
        
        try {
            // Determine file extension from mime type
            const extMap: Record<string, string> = {
                "image/png": ".png",
                "image/jpeg": ".jpg",
                "image/gif": ".gif",
                "image/webp": ".webp"
            };
            const ext = extMap[mimeType] || ".png";
            
            // Create temp file path
            const tempDir = os.tmpdir();
            const fileName = `pasted-image-${Date.now()}${ext}`;
            const filePath = path.join(tempDir, fileName);
            
            // Convert base64 to buffer and save
            const buffer = Buffer.from(base64Data, "base64");
            fs.writeFileSync(filePath, buffer);
            
            return filePath;
        } catch (error) {
            console.error("Failed to save pasted image:", error);
            return null;
        }
    });

    // Return skills-catalog.json for SOP panel categorisation
    ipcMainHandle("skill-catalog", () => {
        const catalogPath = app.isPackaged
            ? join(process.resourcesPath, "skills-catalog.json")
            : join(app.getAppPath(), "skills-catalog.json");
        try {
            if (!existsSync(catalogPath)) return { skills: [], categories: [] };
            return JSON.parse(readFileSync(catalogPath, "utf8"));
        } catch {
            return { skills: [], categories: [] };
        }
    });

    // Get Claude config (MCP servers and Skills)
    ipcMainHandle("get-claude-config", () => {
        const claudeDir = join(homedir(), ".claude");
        const result: ClaudeConfigInfo = {
            mcpServers: [],
            skills: []
        };

        // Read MCP servers from settings.json
        try {
            const settingsPath = join(claudeDir, "settings.json");
            if (existsSync(settingsPath)) {
                const raw = readFileSync(settingsPath, "utf8").replace(/^\uFEFF/, "");
                const parsed = JSON.parse(raw) as { mcpServers?: Record<string, { command: string; args?: string[]; env?: Record<string, string> }> };
                if (parsed.mcpServers) {
                    for (const [name, config] of Object.entries(parsed.mcpServers)) {
                        result.mcpServers.push({
                            name,
                            command: config.command,
                            args: config.args,
                            env: config.env
                        });
                    }
                }
            }
        } catch (error) {
            console.error("Failed to read MCP servers:", error);
        }

        // Read Skills from ~/.claude/skills directory
        try {
            const skillsDir = join(claudeDir, "skills");
            if (existsSync(skillsDir) && statSync(skillsDir).isDirectory()) {
                const skillDirs = readdirSync(skillsDir);
                for (const skillName of skillDirs) {
                    // Skip hidden directories and non-directory entries
                    if (skillName.startsWith(".")) continue;
                    const skillPath = join(skillsDir, skillName);
                    try {
                        if (!statSync(skillPath).isDirectory()) continue;
                    } catch {
                        // broken symlink or inaccessible entry — skip
                        continue;
                    }
                    const skillFilePath = join(skillPath, "SKILL.md");
                    // Only include skills that have a SKILL.md file
                    if (!existsSync(skillFilePath)) continue;
                    let description: string | undefined;
                    try {
                        const content = readFileSync(skillFilePath, "utf8");
                        const lines = content.split("\n");
                        const descriptionLines: string[] = [];
                        let foundFirstHeading = false;
                        let collectingDescription = false;

                        for (const line of lines) {
                            const trimmed = line.trim();
                            if (!foundFirstHeading && !trimmed) continue;
                            if (trimmed.startsWith("#")) {
                                if (!foundFirstHeading) {
                                    foundFirstHeading = true;
                                    collectingDescription = true;
                                    continue;
                                } else {
                                    break;
                                }
                            }
                            if (collectingDescription && trimmed) {
                                if (trimmed.startsWith("```")) continue;
                                if (trimmed.startsWith("- `") || trimmed.startsWith("* `")) continue;
                                descriptionLines.push(trimmed);
                                if (descriptionLines.length >= 3 || descriptionLines.join(" ").length > 300) break;
                            }
                        }

                        if (descriptionLines.length > 0) {
                            description = descriptionLines.join(" ").substring(0, 300);
                        }
                    } catch {
                        // Ignore read errors
                    }
                    result.skills.push({
                        name: skillName,
                        fullPath: skillFilePath,
                        description
                    });
                }
            }
        } catch (error) {
            console.error("Failed to read Skills:", error);
        }

        // Enrich skills with catalog metadata (label, description, category)
        try {
            const catalogPath = app.isPackaged
                ? join(process.resourcesPath, "skills-catalog.json")
                : join(app.getAppPath(), "skills-catalog.json");
            if (existsSync(catalogPath)) {
                const catalog = JSON.parse(readFileSync(catalogPath, "utf8"));
                const catalogSkills: { name: string; label?: string; description?: string; category?: string; installPath?: string }[] = catalog.skills ?? [];

                // Build lookup: catalog name -> catalog entry, AND derived dir name -> catalog entry
                const byName = new Map<string, typeof catalogSkills[0]>();
                const byDirName = new Map<string, typeof catalogSkills[0]>();
                for (const cs of catalogSkills) {
                    byName.set(cs.name, cs);
                    if (cs.installPath) {
                        const url = cs.installPath.replace(/\.git\/?$/, "").replace(/\/+$/, "");
                        const blobM = url.match(/^https:\/\/github\.com\/[^/]+\/[^/]+\/blob\/[^/]+\/(.+)$/);
                        let dirName: string;
                        if (blobM) {
                            const parts = blobM[1].split("/");
                            const last = parts[parts.length - 1];
                            dirName = last.includes(".") ? parts[parts.length - 2] ?? "" : last;
                        } else {
                            dirName = url.split("/").pop() ?? "";
                        }
                        if (dirName) byDirName.set(dirName, cs);
                    }
                }

                for (const skill of result.skills) {
                    const match = byName.get(skill.name) ?? byDirName.get(skill.name);
                    if (match) {
                        if (match.label) skill.label = match.label;
                        if (match.description) skill.description = match.description;
                        if (match.category) skill.category = match.category;
                    }
                }
            }
        } catch {
            // Catalog enrichment is best-effort
        }

        return result;
    });

    // Save MCP server to settings.json
    ipcMainHandle("save-mcp-server", (_: any, server: McpServer) => {
        const claudeDir = join(homedir(), ".claude");
        const settingsPath = join(claudeDir, "settings.json");
        
        try {
            // Ensure .claude directory exists
            if (!existsSync(claudeDir)) {
                mkdirSync(claudeDir, { recursive: true });
            }

            // Read existing settings or create new
            let settings: Record<string, unknown> = {};
            if (existsSync(settingsPath)) {
                const raw = readFileSync(settingsPath, "utf8");
                settings = JSON.parse(raw);
            }

            // Initialize mcpServers if not exists
            if (!settings.mcpServers || typeof settings.mcpServers !== "object") {
                settings.mcpServers = {};
            }

            // Add or update the server
            const mcpServers = settings.mcpServers as Record<string, { command: string; args?: string[]; env?: Record<string, string> }>;
            mcpServers[server.name] = {
                command: server.command,
                ...(server.args && server.args.length > 0 ? { args: server.args } : {}),
                ...(server.env && Object.keys(server.env).length > 0 ? { env: server.env } : {})
            };

            // Write back
            writeFileSync(settingsPath, JSON.stringify(settings, null, 2), "utf8");
            
            return { success: true, message: `MCP 服务器 "${server.name}" 已保存` };
        } catch (error) {
            console.error("Failed to save MCP server:", error);
            return { success: false, message: `保存失败: ${error instanceof Error ? error.message : String(error)}` };
        }
    });

    // Delete MCP server from settings.json
    ipcMainHandle("delete-mcp-server", (_: any, name: string) => {
        const claudeDir = join(homedir(), ".claude");
        const settingsPath = join(claudeDir, "settings.json");
        
        try {
            if (!existsSync(settingsPath)) {
                return { success: false, message: "配置文件不存在" };
            }

            const raw = readFileSync(settingsPath, "utf8");
            const settings = JSON.parse(raw) as Record<string, unknown>;

            if (!settings.mcpServers || typeof settings.mcpServers !== "object") {
                return { success: false, message: "没有 MCP 服务器配置" };
            }

            const mcpServers = settings.mcpServers as Record<string, unknown>;
            if (!(name in mcpServers)) {
                return { success: false, message: `MCP 服务器 "${name}" 不存在` };
            }

            delete mcpServers[name];

            // Write back
            writeFileSync(settingsPath, JSON.stringify(settings, null, 2), "utf8");
            
            return { success: true, message: `MCP 服务器 "${name}" 已删除` };
        } catch (error) {
            console.error("Failed to delete MCP server:", error);
            return { success: false, message: `删除失败: ${error instanceof Error ? error.message : String(error)}` };
        }
    });

    // Read skill content
    ipcMainHandle("read-skill-content", (_: any, skillPath: string) => {
        try {
            if (existsSync(skillPath)) {
                return readFileSync(skillPath, "utf8");
            }
            return null;
        } catch (error) {
            console.error("Failed to read skill content:", error);
            return null;
        }
    });

    // Install skill — electron.net download (Chromium network stack) + fflate unzip.
    // Supports:
    //   - GitHub subdirectory: https://github.com/user/repo/tree/branch/subdir
    //   - GitHub full repo:    https://github.com/user/repo
    ipcMainHandle("install-skill", async (_: any, url: string) => {
        const { net } = await import("electron");
        const { unzipSync } = await import("fflate");
        const { mkdtempSync, cpSync, rmSync, writeFileSync } = await import("fs");
        const { tmpdir } = await import("os");
        const home = homedir();

        // Download via electron.net (Chromium network stack — follows redirects, respects system proxy)
        const downloadBuffer = (dlUrl: string): Promise<Buffer> => new Promise((resolve, reject) => {
            const request = net.request({ url: dlUrl, redirect: "follow" });
            const chunks: Buffer[] = [];
            request.on("response", (response) => {
                if (response.statusCode !== 200) {
                    return reject(new Error(`HTTP ${response.statusCode} for ${dlUrl}`));
                }
                response.on("data", (chunk: Buffer) => chunks.push(chunk));
                response.on("end", () => resolve(Buffer.concat(chunks)));
                response.on("error", reject);
            });
            request.on("error", reject);
            request.end();
        });

        const urlClean = url.replace(/\.git\/?$/, "").replace(/\/+$/, "");

        // Normalize blob URLs to tree URLs
        let normalizedUrl = urlClean;
        const blobMatch = urlClean.match(/^https:\/\/github\.com\/([^/]+)\/([^/]+)\/blob\/([^/]+)\/(.+)$/);
        if (blobMatch) {
            const [, user, repo, branch, filePath] = blobMatch;
            const parts = filePath.split("/");
            const lastPart = parts[parts.length - 1];
            const dirPath = lastPart.includes(".") ? parts.slice(0, -1).join("/") : filePath;
            normalizedUrl = `https://github.com/${user}/${repo}/tree/${branch}/${dirPath}`;
        }

        const skillName = normalizedUrl.split("/").pop() || "unknown-skill";

        const subdirMatch = normalizedUrl.match(/^https:\/\/github\.com\/([^/]+)\/([^/]+)\/tree\/([^/]+)\/(.+)$/);
        const repoMatch = !subdirMatch && normalizedUrl.match(/^https:\/\/github\.com\/([^/]+)\/([^/]+?)(\.git)?$/);

        const targets = [
            join(home, ".claude", "skills", skillName),
            join(home, ".codex", "skills", skillName),
        ];

        // Download + unzip entirely in Node.js (no child_process), works on all platforms
        const installFromGithub = async (user: string, repo: string, branch: string, subPath: string | null, targetDir: string) => {
            const zipUrl = `https://github.com/${user}/${repo}/archive/refs/heads/${branch}.zip`;
            const tmpDir = mkdtempSync(join(tmpdir(), "skill-"));
            try {
                const zipBuf = await downloadBuffer(zipUrl);
                const files = unzipSync(new Uint8Array(zipBuf));

                // Determine the prefix inside the zip (e.g. "repo-branch/" or "repo-branch/subPath/")
                const prefix = subPath
                    ? `${repo}-${branch}/${subPath}/`
                    : `${repo}-${branch}/`;

                let extractedAny = false;
                for (const [zipPath, data] of Object.entries(files)) {
                    if (!zipPath.startsWith(prefix)) continue;
                    const relPath = zipPath.slice(prefix.length);
                    if (!relPath) continue; // skip the dir entry itself

                    // ZIP directory entries end with '/' — create dir and skip
                    if (zipPath.endsWith("/")) {
                        mkdirSync(join(tmpDir, relPath.replace(/\/$/, "")), { recursive: true });
                        continue;
                    }

                    const destPath = join(tmpDir, relPath);
                    mkdirSync(join(destPath, ".."), { recursive: true });
                    writeFileSync(destPath, data);
                    extractedAny = true;
                }

                if (!extractedAny) throw new Error(`zip 中未找到路径: ${prefix}`);

                if (existsSync(targetDir)) rmSync(targetDir, { recursive: true, force: true });
                mkdirSync(join(targetDir, ".."), { recursive: true });
                cpSync(tmpDir, targetDir, { recursive: true });
            } finally {
                rmSync(tmpDir, { recursive: true, force: true });
            }
        };

        const results: string[] = [];
        let hasSuccess = false;

        for (const targetDir of targets) {
            try {
                const parentDir = join(targetDir, "..");
                if (!existsSync(parentDir)) mkdirSync(parentDir, { recursive: true });

                const action = existsSync(targetDir) ? "更新" : "安装";

                if (subdirMatch) {
                    const [, user, repo, branch, subPath] = subdirMatch;
                    await installFromGithub(user, repo, branch, subPath, targetDir);
                } else if (repoMatch) {
                    const [, user, repo] = repoMatch;
                    try {
                        await installFromGithub(user, repo, "main", null, targetDir);
                    } catch {
                        await installFromGithub(user, repo, "master", null, targetDir);
                    }
                } else {
                    throw new Error(`不支持的地址格式: ${normalizedUrl}`);
                }

                hasSuccess = true;
                results.push(`${action}: ${targetDir}`);
            } catch (err) {
                results.push(`失败 (${targetDir}): ${(err as Error).message}`);
            }
        }

        console.log("[install-skill]", results);
        return { success: hasSuccess, skillName, message: results.join("\n") };
    });

    // Delete (uninstall) a skill from both ~/.claude/skills/ and ~/.codex/skills/
    ipcMainHandle("delete-skill", async (_: any, skillName: string) => {
        const { rmSync } = await import("fs");
        const home = homedir();

        const targets = [
            join(home, ".claude", "skills", skillName),
            join(home, ".codex", "skills", skillName),
        ];

        const results: string[] = [];

        for (const targetDir of targets) {
            try {
                if (existsSync(targetDir)) {
                    rmSync(targetDir, { recursive: true, force: true });
                    results.push(`已删除: ${targetDir}`);
                } else {
                    results.push(`不存在: ${targetDir}`);
                }
            } catch (err) {
                results.push(`失败 (${targetDir}): ${(err as Error).message}`);
            }
        }

        console.log("[delete-skill]", results);
        return { success: true, message: results.join("\n") };
    });

    // Check if embedded API is running
    ipcMainHandle("is-sidecar-running", () => {
        return isEmbeddedApiRunning();
    });

    // Goals IPC handlers
    ipcMainHandle("goals-list", () => loadGoals());

    ipcMainHandle("goals-add", (_: any, input: Omit<LongTermGoal, "id" | "status" | "totalRuns" | "progressLog" | "createdAt" | "updatedAt" | "completedAt" | "nextRunAt" | "consecutiveErrors">) => {
        const goal = addGoal(input);
        triggerGoalRun(goal);
        return goal;
    });

    ipcMainHandle("goals-update", (_: any, id: string, updates: Partial<LongTermGoal>) => updateGoal(id, updates));

    ipcMainHandle("goals-delete", (_: any, id: string) => deleteGoal(id));

    ipcMainHandle("goals-run-now", (_: any, id: string) => {
        const goals = loadGoals();
        const goal = goals.find((g) => g.id === id);
        if (goal) triggerGoalRun(goal);
    });

    setGoalCompleteNotifier(() => {
        const windows = BrowserWindow.getAllWindows();
        for (const win of windows) {
            if (!win.isDestroyed()) {
                win.webContents.send("goal-completed");
            }
        }
    });

    // ─── SOP Hands IPC handlers ──────────────────────────────────────────────

    // All hands live in the user config directory — writable, syncable, user-owned
    const HANDS_DIR = join(homedir(), ".vk-cowork", "hands");

    // On first run, seed built-in hands from the project's hands/ directory
    function seedBuiltinHands() {
        const builtinDir = join(app.getAppPath(), "hands");
        if (!existsSync(builtinDir)) return;
        if (!existsSync(HANDS_DIR)) mkdirSync(HANDS_DIR, { recursive: true });
        for (const entry of readdirSync(builtinDir)) {
            const src = join(builtinDir, entry, "HAND.toml");
            const dst = join(HANDS_DIR, entry, "HAND.toml");
            if (!existsSync(src)) continue;
            // Only copy if destination doesn't exist yet (don't overwrite user edits)
            if (!existsSync(dst)) {
                mkdirSync(join(HANDS_DIR, entry), { recursive: true });
                writeFileSync(dst, readFileSync(src, "utf8"), "utf8");
                console.log(`[hands] Seeded built-in hand: ${entry}`);
            }
        }
    }

    seedBuiltinHands();

    // All known tool names that can appear in system_prompt.
    // Includes both the canonical MCP tool names and legacy HAND.toml aliases.
    const KNOWN_TOOLS = [
        "file_read", "read_document", "file_write", "file_list",
        "web_fetch", "web_search",
        "shell_exec", "run_script",
        "memory_store", "save_memory", "memory_recall", "query_team_memory", "read_working_memory", "save_working_memory",
        "schedule_create", "create_scheduled_task", "schedule_list", "list_scheduled_tasks", "schedule_delete", "delete_scheduled_task",
        "knowledge_add_entity", "knowledge_add_relation", "knowledge_query",
        "event_publish", "send_notification",
    ];

    // Map HAND.toml aliases to actual MCP tool names.
    const TOOL_ALIAS_MAP: Record<string, string> = {
        file_read: "read_document",
        shell_exec: "run_script",
        memory_store: "save_memory",
        memory_recall: "read_working_memory",
        schedule_create: "create_scheduled_task",
        schedule_list: "list_scheduled_tasks",
        schedule_delete: "delete_scheduled_task",
        event_publish: "send_notification",
    };

    // Tools listed in KNOWN_TOOLS that are not yet implemented
    const UNIMPLEMENTED_TOOLS = new Set([
        "knowledge_add_entity", "knowledge_add_relation", "knowledge_query",
    ]);

    // Tools that must never appear in stage 【推荐工具】 regardless of HAND.toml content.
    // Mirrors the sopExclude flag in SHARED_TOOL_CATALOG, plus legacy aliases.
    const SOP_STAGE_EXCLUDED_TOOLS = new Set([
        // Scheduler — managed by framework (sop.setSopSchedule / register_sop_schedule)
        "create_scheduled_task", "schedule_create",
        "list_scheduled_tasks",  "schedule_list",
        "delete_scheduled_task", "schedule_delete",
        // Plan table — synced automatically by the workflow framework
        "upsert_plan_item", "complete_plan_item", "fail_plan_item", "list_plan_items",
        // SOP meta-ops — must not appear in business stage steps
        "save_sop", "list_sops", "read_sop", "search_sops",
        // Memory tools redundant in SOP context (framework injects prevOutput)
        "read_working_memory", "memory_recall",
        "query_team_memory",
        "distill_memory",
    ]);

    // Common MCP server names
    const KNOWN_MCPS = [
        "dingtalk-ai-table", "dingtalk-contacts", "dingtalk-message",
        "feishu-doc", "feishu-sheet", "feishu-message", "feishu-calendar",
        "exa", "github", "slack", "notion", "airtable",
        "google-calendar", "google-sheets", "google-docs",
        "jira", "confluence", "linear", "asana",
        "stripe", "twilio", "sendgrid",
    ];

    // Clean up orphan temp dirs left from interrupted sop.generate calls.
    // - Empty dirs (no HAND.toml): delete.
    // - Dirs with a valid HAND.toml: auto-rename to the id declared inside.
    function cleanupOrphanSopDirs() {
        try {
            if (!existsSync(HANDS_DIR)) return;
            for (const entry of readdirSync(HANDS_DIR)) {
                if (!entry.startsWith("sop-")) continue;
                const dirPath = join(HANDS_DIR, entry);
                const tomlPath = join(dirPath, "HAND.toml");
                if (!existsSync(tomlPath)) {
                    try {
                        rmSync(dirPath, { recursive: true });
                        console.log(`[hands] Cleaned up orphan empty temp dir: ${entry}`);
                    } catch { /* best-effort */ }
                } else {
                    // Has content but wrong dir name — try to rename to actual id
                    try {
                        const parsed = parseHandTomlFile(tomlPath);
                        if (parsed && parsed.id && parsed.id !== entry) {
                            const targetDir = join(HANDS_DIR, parsed.id);
                            if (!existsSync(targetDir)) {
                                mkdirSync(targetDir, { recursive: true });
                                writeFileSync(join(targetDir, "HAND.toml"), readFileSync(tomlPath, "utf8"), "utf8");
                                rmSync(dirPath, { recursive: true });
                                console.log(`[hands] Renamed orphan temp dir: ${entry} → ${parsed.id}`);
                            } else {
                                // Target already exists — safe to remove the stale temp copy
                                rmSync(dirPath, { recursive: true });
                                console.log(`[hands] Removed stale temp dir (target exists): ${entry}`);
                            }
                        }
                    } catch { /* best-effort */ }
                }
            }
        } catch { /* ignore */ }
    }
    cleanupOrphanSopDirs();

    // Track all in-flight sop.generate abort controllers keyed by tmpId.
    // Using a Map ensures concurrent calls don't clobber each other's abort handle.
    const sopGenerateAborts = new Map<string, AbortController>();

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
        category: "客户服务" | "情报监控" | "内部运营" | "增长销售" | "";
        icon: string;
        stages: HandStage[];
        workflowCount: number;
        createdAt?: string;
    }

    /**
     * Auto-fix common LLM TOML mistakes before parsing:
     * - [settings] → [[settings]]  (LLM forgets double brackets for array-of-tables)
     * - [requires] → [[requires]]
     * - Unescaped inner quotes inside single-line string values
     * - Indented """ inside multi-line strings (decorative quoting)
     * - Missing opening quote: key =value"  →  key = "value"
     * - Missing closing quote: key = "value  →  key = "value"
     */
    function fixTomlArrayTables(raw: string): string {
        return raw
            .replace(/^\[settings\]$/gm, "[[settings]]")
            .replace(/^\[requires\]$/gm, "[[requires]]")
            .replace(
                /^(\s*[\w][\w.-]*\s*=\s*)(?!"{3})"(.*)"(\s*(?:#.*)?)$/gm,
                (_match, prefix, content, suffix) => {
                    const fixed = content.replace(/(?<!\\)"/g, '\\"');
                    return fixed !== content ? `${prefix}"${fixed}"${suffix}` : _match;
                },
            )
            .replace(/^(\s+)"""\s*$/gm, "$1---")
            // key =value"  (missing opening quote)
            .replace(/^(\s*[\w][\w.-]*\s*=\s*)([^"\s\[\{][^"]*)"(\s*(?:#.*)?)$/gm, '$1"$2"$3')
            // key = "value  (missing closing quote, no trailing " on line)
            .replace(/^(\s*[\w][\w.-]*\s*=\s*)"([^"]+)(\s*(?:#.*)?)$/gm, '$1"$2"$3');
    }

    // Extended parse result with raw data for workflow execution
    interface ParsedHandData extends HandSopResult {
        systemPrompt: string;
        settings: Array<{ key: string; label: string; default?: string }>;
        agentName?: string;
    }

    function parseHandTomlFile(tomlPath: string): ParsedHandData | null {
        try {
            const raw = fixTomlArrayTables(readFileSync(tomlPath, "utf8"));
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const data = parseToml(raw) as Record<string, any>;

            const id = String(data.id ?? "");
            const name = String(data.name ?? id);
            const description = String(data.description ?? "");
            const category = normalizeWorkCategory(String(data.category ?? ""));
            const icon = String(data.icon ?? "");

            const systemPrompt: string = String(data.agent?.system_prompt ?? "");
            const agentName: string | undefined = data.agent?.name ? String(data.agent.name) : undefined;
            const globalMcps: string[] = Array.isArray(data.mcp_servers)
                ? data.mcp_servers.map(String)
                : [];
            const stages = extractHandStages(systemPrompt, globalMcps);

            const settings: Array<{ key: string; label: string; default?: string }> = [];
            if (Array.isArray(data.settings)) {
                for (const s of data.settings) {
                    if (s && typeof s === "object" && s.key) {
                        settings.push({
                            key: String(s.key),
                            label: String(s.label ?? s.key),
                            default: s.default != null ? String(s.default) : undefined,
                        });
                    }
                }
            }

            let createdAt: string | undefined;
            try {
                const stat = statSync(tomlPath);
                createdAt = (stat.birthtime ?? stat.mtime).toISOString();
            } catch { /* ignore */ }

            return { id, name, description, category, icon, stages, workflowCount: stages.length, systemPrompt, settings, agentName, createdAt };
        } catch (err) {
            console.error("[sop.list] Failed to parse HAND.toml:", tomlPath, err);
            return null;
        }
    }

    function extractTaggedItems(body: string, annotationKey: string, knownList: string[]): string[] {
        const found = new Set<string>();
        const annotationMatch = body.match(new RegExp(`【${annotationKey}】([^\\n]+)`));
        if (annotationMatch) {
            const line = annotationMatch[1];
            for (const item of knownList) {
                if (line.includes(item)) found.add(item);
            }
            if (found.size > 0) return [...found].slice(0, 4);
        }
        // Fallback: scan body text for known names
        for (const item of knownList) {
            if (body.includes(item)) found.add(item);
        }
        return [...found].slice(0, 3);
    }

    function extractHandStages(systemPrompt: string, globalMcps: string[] = []): HandStage[] {
        const stageRegex = /═══\s*(第[^═]*?阶段[^═]*?)\s*═══([\s\S]*?)(?=═══|$)/g;
        const stages: HandStage[] = [];
        let match: RegExpExecArray | null;

        while ((match = stageRegex.exec(systemPrompt)) !== null) {
            const label = match[1].trim();
            const body = match[2].trim();

            const goalMatch = body.match(/^目标[：:]\s*(.+)/m);
            const goal = goalMatch ? goalMatch[1].trim() : "";

            const itemMatches = [...body.matchAll(/^\d+\.\s+(.+)/mg)];
            const items = itemMatches.slice(0, 4).map((m) => m[1].trim());

            const tools = extractTaggedItems(body, "本阶段工具", KNOWN_TOOLS);
            const mcp = extractTaggedItems(body, "本阶段MCP", KNOWN_MCPS);

            stages.push({
                id: `stage_${stages.length + 1}`,
                label,
                goal,
                items,
                tools,
                mcp,
            });
        }

        // If no stage had any MCP annotations, distribute globalMcps evenly
        const anyMcp = stages.some((s) => s.mcp.length > 0);
        if (!anyMcp && globalMcps.length > 0 && stages.length > 0) {
            stages.forEach((stage, i) => {
                // Round-robin: assign each global MCP to the most relevant stage index
                stage.mcp = globalMcps.filter((_, idx) => idx % stages.length === i).slice(0, 3);
            });
        }

        return stages;
    }

    function loadHandsFromDir(dir: string): ParsedHandData[] {
        if (!existsSync(dir)) return [];
        const results: ParsedHandData[] = [];
        for (const entry of readdirSync(dir)) {
            const tomlPath = join(dir, entry, "HAND.toml");
            if (!existsSync(tomlPath)) continue;
            const parsed = parseHandTomlFile(tomlPath);
            if (parsed) results.push(parsed);
        }
        return results;
    }

    ipcMainHandle("sop.list", () => {
        return loadHandsFromDir(HANDS_DIR);
    });

    ipcMainHandle("sop.delete", async (_: any, sopId: string) => {
        const sopDir = join(HANDS_DIR, sopId);
        if (!existsSync(sopDir)) return false;
        rmSync(sopDir, { recursive: true, force: true });
        // Clean up all scheduled tasks associated with this SOP
        await deleteScheduledTasksBySopId(sopId);
        console.log(`[sop.delete] Deleted SOP: ${sopId}`);
        return true;
    });

    // ── SOP schedule management ────────────────────────────────────────────────
    // Set (create or update) a scheduled task for a SOP or one of its stages.
    // stageId is optional: absent = whole-SOP trigger; present = single-stage trigger.
    ipcMainHandle("sop.setSopSchedule", async (_: any, params: {
        sopId: string;
        stageId?: string;
        name: string;
        scheduleType: "once" | "interval" | "daily";
        scheduledTime?: string;
        intervalValue?: number;
        intervalUnit?: "minutes" | "hours" | "days" | "weeks";
        dailyTime?: string;
        dailyDays?: number[];
        existingTaskId?: string;  // if provided, updates the existing task
    }) => {
        if (params.existingTaskId) {
            const updated = await updateScheduledTask(params.existingTaskId, {
                name: params.name,
                scheduleType: params.scheduleType,
                scheduledTime: params.scheduledTime,
                intervalValue: params.intervalValue,
                intervalUnit: params.intervalUnit,
                dailyTime: params.dailyTime,
                dailyDays: params.dailyDays,
                enabled: true,
            });
            if (!updated) throw new Error(`Task not found: ${params.existingTaskId}`);
            return updated;
        }
        const task = await addScheduledTask({
            name: params.name,
            prompt: "",   // SOP tasks don't use a prompt — they trigger the workflow directly
            enabled: true,
            scheduleType: params.scheduleType,
            scheduledTime: params.scheduledTime,
            intervalValue: params.intervalValue,
            intervalUnit: params.intervalUnit,
            dailyTime: params.dailyTime,
            dailyDays: params.dailyDays,
            sopId: params.sopId,
            stageId: params.stageId,
            hidden: true,   // SOP-linked tasks are hidden from the calendar
        });
        return task;
    });

    // Get all scheduled tasks for a given SOP (optionally filtered by stageId).
    ipcMainHandle("sop.getSopSchedules", (_: any, sopId: string, stageId?: string) => {
        const tasks = loadScheduledTasks().filter((t) =>
            t.sopId === sopId && (stageId === undefined || t.stageId === stageId),
        );
        return tasks;
    });

    // Remove a specific SOP-linked scheduled task.
    ipcMainHandle("sop.removeSopSchedule", async (_: any, taskId: string) => {
        return deleteScheduledTask(taskId);
    });

    ipcMainHandle("sop.rename", (_: any, sopId: string, newName: string) => {
        const tomlPath = join(HANDS_DIR, sopId, "HAND.toml");
        if (!existsSync(tomlPath)) throw new Error(`SOP not found: ${sopId}`);
        let raw = readFileSync(tomlPath, "utf8");
        raw = raw.replace(
            /^(name\s*=\s*)"[^"]*"/m,
            `$1"${newName.replace(/"/g, '\\"')}"`,
        );
        writeFileSync(tomlPath, raw, "utf8");
        console.log(`[sop.rename] Renamed ${sopId} → "${newName}"`);
        const parsed = parseHandTomlFile(tomlPath);
        if (!parsed) throw new Error("解析重命名后的 HAND.toml 失败");
        return parsed satisfies HandSopResult;
    });

    ipcMainHandle("sop.generate.cancel", () => {
        if (sopGenerateAborts.size > 0) {
            console.log(`[sop.generate] Cancelling ${sopGenerateAborts.size} in-flight generation(s)`);
            for (const ctrl of sopGenerateAborts.values()) ctrl.abort();
        }
        return null;
    });

    /**
     * Scan all capabilities available at runtime for SOP generation:
     * 1. Built-in shared MCP tools (from SHARED_TOOL_CATALOG)
     * 2. External MCP servers configured in ~/.claude/settings.json
     * 3. Installed Skills in ~/.claude/skills/
     */
    function scanAvailableCapabilities(): {
        tools: ToolCatalogEntry[];
        mcpServers: Array<{ name: string }>;
        skills: Array<{ name: string; description?: string }>;
    } {
        // 1. Built-in tools — exclude tools marked sopExclude (framework-managed or meta-ops)
        const tools = SHARED_TOOL_CATALOG.filter((t) => !t.sopExclude);

        // 2. External MCP servers from ~/.claude/settings.json
        const mcpServers: Array<{ name: string }> = [];
        try {
            const settingsPath = join(homedir(), ".claude", "settings.json");
            if (existsSync(settingsPath)) {
                const raw = readFileSync(settingsPath, "utf8").replace(/^\uFEFF/, "");
                const parsed = JSON.parse(raw) as { mcpServers?: Record<string, unknown> };
                if (parsed.mcpServers) {
                    for (const name of Object.keys(parsed.mcpServers)) {
                        mcpServers.push({ name });
                    }
                }
            }
        } catch (err) {
            console.warn("[sop.generate] Failed to read MCP servers:", err);
        }

        // 3. Installed Skills from ~/.claude/skills/
        const skills: Array<{ name: string; description?: string }> = [];
        try {
            const skillsDir = join(homedir(), ".claude", "skills");
            if (existsSync(skillsDir) && statSync(skillsDir).isDirectory()) {
                for (const entry of readdirSync(skillsDir)) {
                    if (entry.startsWith(".")) continue;
                    const skillPath = join(skillsDir, entry);
                    try {
                        if (!statSync(skillPath).isDirectory()) continue;
                    } catch { continue; }
                    const skillFile = join(skillPath, "SKILL.md");
                    if (!existsSync(skillFile)) continue;
                    let description: string | undefined;
                    try {
                        const lines = readFileSync(skillFile, "utf8").split("\n");
                        const descLines: string[] = [];
                        let foundHeading = false;
                        let collecting = false;
                        for (const line of lines) {
                            const t = line.trim();
                            if (!foundHeading && !t) continue;
                            if (t.startsWith("#")) {
                                if (!foundHeading) { foundHeading = true; collecting = true; continue; }
                                else break;
                            }
                            if (collecting && t && !t.startsWith("```") && !t.startsWith("- `") && !t.startsWith("* `")) {
                                descLines.push(t);
                                if (descLines.join(" ").length > 200) break;
                            }
                        }
                        if (descLines.length > 0) description = descLines.join(" ").slice(0, 200);
                    } catch { /* ignore */ }
                    skills.push({ name: entry, description });
                }
            }
        } catch (err) {
            console.warn("[sop.generate] Failed to read skills:", err);
        }

        return { tools, mcpServers, skills };
    }

    ipcMainHandle("sop.generate", async (_: any, description: string) => {
        // Prepare a temporary output dir so the agent has a concrete write target
        const tmpId = `sop-${Date.now()}`;
        const tmpDir = join(HANDS_DIR, tmpId);
        mkdirSync(tmpDir, { recursive: true });
        const targetPath = join(tmpDir, "HAND.toml");

        // Use full vvip-educare as few-shot reference
        const examplePath = join(HANDS_DIR, "vvip-educare", "HAND.toml");
        const exampleFull = existsSync(examplePath)
            ? readFileSync(examplePath, "utf8")
            : "";

        // Scan runtime capabilities
        const capabilities = scanAvailableCapabilities();

        // Build tools section: group by category
        const toolsByCategory = new Map<string, ToolCatalogEntry[]>();
        for (const t of capabilities.tools) {
            const group = toolsByCategory.get(t.category) ?? [];
            group.push(t);
            toolsByCategory.set(t.category, group);
        }
        const toolsSection = [...toolsByCategory.entries()]
            .map(([cat, items]) =>
                `- **${cat}**：${items.map(i => `\`${i.name}\`（${i.description}）`).join("、")}`
            )
            .join("\n");

        // Build MCP section
        const mcpSection = capabilities.mcpServers.length > 0
            ? `用户已配置的 MCP 服务（从 ~/.claude/settings.json 扫描）：\n${capabilities.mcpServers.map(m => `- \`${m.name}\``).join("\n")}`
            : "用户当前未配置外部 MCP 服务，mcp_servers 数组填 []。";

        // Build Skills section
        const skillsSection = capabilities.skills.length > 0
            ? `已安装的 Agent Skills（SOP 步骤中可以引用这些 Skill 名）：\n${capabilities.skills.map(s => `- \`${s.name}\`${s.description ? `：${s.description}` : ""}`).join("\n")}`
            : "用户当前未安装任何 Skill，无需在 SOP 中引用。";

        const prompt = `你是一个专业的 SOP（标准操作流程）设计师。
请根据用户描述，生成一份和参考示例结构完全一致的 HAND.toml 文件，写入路径：${targetPath}

━━━ 参考示例（完整文件，请完全对照此格式）━━━
\`\`\`toml
${exampleFull}
\`\`\`
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

## 必须包含的章节（缺一不可）

### 1. 顶部元数据
\`\`\`
id = "xxx-yyy"           # 小写英文 + 连字符
name = "..."             # 完整名称，如果用户有定制要求，name 应体现其业务特色（如"K12 家长学习跟进"而非通用的"VIP 学习跟进"）
description = "..."      # 一句话描述，融入用户的业务场景
category = "..."         # 只能填：客户服务 / 情报监控 / 内部运营 / 增长销售
icon = "..."             # emoji
\`\`\`

### 2. tools 数组（从以下已实现工具中选择，不得填写列表以外的工具名）
${toolsSection}

### 3. mcp_servers 数组
${mcpSection}

### 3.5. Skills（可选引用）
${skillsSection}

### 4. [[requires]] 前置依赖
列出所有需要的 API Key / 账号凭证。每个依赖包含：
- key、label、requirement_type、check_value、description
- [requires.install] 子节：signup_url、docs_url、env_example、estimated_time、steps

⚠️ TOML 格式：[[requires]] 必须用双方括号，[requires] 单方括号会报错

### 5. [[settings]] 用户配置项
列出所有运行时可配置的参数，如负责人姓名、频率、通知渠道等。
每个 setting 包含：key、label、description、setting_type（text/select/number/boolean）、default
select 类型需有 [[settings.options]] 子节

⚠️ TOML 格式严格要求：
- 所有 settings 条目必须使用 [[settings]]（双方括号，数组表）
- 绝对不能用 [settings]（单方括号），否则 TOML 解析会报错
- 正确示例：
  [[settings]]
  key = "owner_name"
  label = "负责人姓名"
  [[settings]]
  key = "notify_channel"
  [[settings.options]]
  value = "dingtalk"

### 6. [agent] 配置
\`\`\`toml
[agent]
name = "..."
description = "..."
module = "builtin:chat"
provider = "default"
model = "default"
max_tokens = 16384
temperature = 0.4
max_iterations = 60
system_prompt = """
（多行 SOP 操作手册，必须包含以下结构）

═══ 第一阶段：阶段名称 ═══
目标：本阶段目标描述

1. 步骤一（调用 tool_name 完成…）
2. 步骤二（使用 save_memory 记录…）
...
【本阶段工具】read_document、save_memory（从 tools 数组中选取本阶段实际用到的，必须使用真实工具名）
【本阶段MCP】feishu-doc、dingtalk-ai-table（从 mcp_servers 数组中选取本阶段用到的，不用可省略）

═══ 第二阶段：阶段名称 ═══
目标：...
1. ...
【本阶段工具】web_search、send_notification
【本阶段MCP】exa
...（共 3-6 个阶段，每个阶段末尾必须有【本阶段工具】，如有用到 MCP 也加【本阶段MCP】）

═══ 异常处理 ═══
| 异常场景 | 自动响应 |
|---       |---       |
| ...      | ...      |

═══ 安全约束 ═══
1. ...
"""
\`\`\`

### 7. [dashboard] + [[dashboard.metrics]]
列出 4-8 个关键监控指标，每个包含：label、memory_key（snake_case）、format（number/percentage/text）

## 定制化要求
如果用户描述中包含「用户定制要求」部分，**必须**将这些要求融入到每个阶段的具体步骤中：
- 每个阶段的 goal 和步骤描述要体现用户的业务场景（客户群体、沟通渠道、频率等）
- system_prompt 中每个阶段的操作指令要使用用户指定的工具/渠道/对象
- settings 配置项要反映用户提到的可变参数

## 定时调度说明

SOP 的定时调度（如"每日 09:00 执行"）由框架统一在 SOP 配置界面管理，阶段步骤中不需要也不应该创建定时任务。

如果某阶段需要根据执行结果动态调整调度频率，正确做法是：
1. 使用 \`send_notification\` 向用户说明情况并请示新的调度设置
2. 用户确认后在对话中告知 Assistant，由 Assistant 调用工具更新
3. 该阶段【本阶段工具】应包含 \`send_notification\`，不应包含任何调度类工具

## 写入指令
使用 Write 工具将完整 HAND.toml 写入：${targetPath}

## 用户描述
${description}`;

        const abortController = new AbortController();
        sopGenerateAborts.set(tmpId, abortController);

        // 3-minute hard timeout — abort the agent if it takes too long
        const GENERATE_TIMEOUT_MS = 3 * 60 * 1000;
        const timeoutHandle = setTimeout(() => {
            console.warn("[sop.generate] Timeout reached, aborting agent");
            abortController.abort();
        }, GENERATE_TIMEOUT_MS);

        // App-configured key takes precedence over ~/.claude/settings.json
        const settings = loadUserSettings();
        const envOverride: Record<string, string> = {};
        if (settings.anthropicAuthToken) envOverride.ANTHROPIC_API_KEY = settings.anthropicAuthToken;
        if (settings.anthropicBaseUrl)   envOverride.ANTHROPIC_BASE_URL = settings.anthropicBaseUrl;

        try {
            const q = agentQuery({
                prompt,
                options: {
                    cwd: HANDS_DIR,
                    abortController,
                    permissionMode: "bypassPermissions",
                    allowDangerouslySkipPermissions: true,
                    maxTurns: 15,
                    settingSources: getSettingSources(),
                    env: { ...process.env, ...envOverride },
                },
            });

            // Drain the agent stream
            for await (const msg of q) {
                if (msg.type === "result") {
                    console.log("[sop.generate] Agent finished, result type:", msg.subtype);
                }
            }
        } finally {
            clearTimeout(timeoutHandle);
            sopGenerateAborts.delete(tmpId);
        }

        // Check if aborted by user/timeout before checking file
        if (abortController.signal.aborted) {
            try { rmSync(tmpDir, { recursive: true }); } catch { /* ignore */ }
            throw new Error("生成已取消");
        }

        // Verify file was written
        if (!existsSync(targetPath)) {
            // Clean up empty temp dir
            try { rmSync(tmpDir, { recursive: true }); } catch { /* ignore */ }
            throw new Error("Agent 未生成 HAND.toml，请检查 Claude 配置后重试");
        }

        // Layer 2: deterministic regex fixes
        const rawContent = readFileSync(targetPath, "utf8");
        const fixedContent = fixTomlArrayTables(rawContent);
        if (fixedContent !== rawContent) {
            writeFileSync(targetPath, fixedContent, "utf8");
            console.log("[sop.generate] Applied TOML auto-fix (regex)");
        }

        // Parse attempt 1
        let parsed = parseHandTomlFile(targetPath);

        // Layer 3: Agent SDK fallback — ask LLM to fix the broken TOML
        if (!parsed) {
            console.log("[sop.generate] Regex-fixed TOML still invalid, invoking Agent fix…");
            const brokenToml = readFileSync(targetPath, "utf8");
            let parseError = "";
            try { parseToml(brokenToml); } catch (e: any) { parseError = e.message ?? String(e); }

            // Reuse the same abort controller so user-cancel also stops the fix phase.
            // Add a 90-second hard timeout specifically for this shorter sub-task.
            const FIX_TIMEOUT_MS = 90 * 1000;
            const fixTimeoutHandle = setTimeout(() => {
                console.warn("[sop.generate] TOML fix timeout, aborting");
                abortController.abort();
            }, FIX_TIMEOUT_MS);
            try {
                const fixQ = agentQuery({
                    prompt: `以下 TOML 文件有格式错误，请修复后用 Write 工具写回同一路径。
只修复 TOML 语法问题，不要改变任何业务内容。

错误信息：${parseError}

文件路径：${targetPath}

原始内容：
\`\`\`toml
${brokenToml}
\`\`\`

请将修复后的完整 TOML 写入：${targetPath}`,
                    options: {
                        cwd: HANDS_DIR,
                        abortController,
                        permissionMode: "bypassPermissions",
                        allowDangerouslySkipPermissions: true,
                        maxTurns: 3,
                        settingSources: getSettingSources(),
                        env: { ...process.env, ...envOverride },
                    },
                });
                for await (const msg of fixQ) {
                    if (msg.type === "result") {
                        console.log("[sop.generate] TOML fix agent finished:", msg.subtype);
                    }
                }
            } finally {
                clearTimeout(fixTimeoutHandle);
            }

            // Re-apply regex fix on the agent output, then parse again
            if (existsSync(targetPath)) {
                const reFixed = fixTomlArrayTables(readFileSync(targetPath, "utf8"));
                writeFileSync(targetPath, reFixed, "utf8");
            }
            parsed = parseHandTomlFile(targetPath);
        }

        if (!parsed) {
            try { rmSync(tmpDir, { recursive: true }); } catch { /* ignore */ }
            throw new Error("生成的 HAND.toml 格式解析失败，请重试");
        }

        // Rename temp dir to actual id if different
        const actualId = parsed.id;
        if (actualId !== tmpId) {
            const actualDir = join(HANDS_DIR, actualId);
            if (!existsSync(actualDir)) {
                mkdirSync(actualDir, { recursive: true });
                writeFileSync(join(actualDir, "HAND.toml"), readFileSync(targetPath, "utf8"), "utf8");
            }
            try { rmSync(tmpDir, { recursive: true }); } catch { /* ignore */ }
            parsed.id = actualId;
        }

        console.log(`[sop.generate] Created SOP: ${parsed.id} (${parsed.stages.length} stages)`);
        return parsed satisfies HandSopResult;
    });

    // ═══ Workflow Run handlers ═══════════════════════════════════════════════

    ipcMainHandle("workflow.get-run", (_: any, sopId: string) => {
        return loadWorkflowRun(sopId);
    });

    /**
     * Build a stage-specific prompt with full context:
     * settings + stage instructions + prev output + abstracts + tool hints + experience + constraints.
     */
    function buildStagePrompt(
        sop: ParsedHandData,
        stage: { stageId: string; label: string },
        prevOutput?: string,
        allAbstracts?: Array<{ label: string; abstract: string }>,
    ): string {
        const stageInfo = sop.stages.find((s) => s.id === stage.stageId);
        const lines: string[] = [];

        lines.push(`你正在执行 SOP「${sop.name}」的工作流阶段：${stage.label}\n`);

        // Inject settings from HAND.toml (key=default pairs)
        if (sop.settings.length > 0) {
            lines.push("【SOP 配置参数】");
            for (const s of sop.settings) {
                if (s.default) {
                    lines.push(`- ${s.label}（${s.key}）= ${s.default}`);
                }
            }
            lines.push("");
        }

        if (stageInfo) {
            if (stageInfo.goal) lines.push(`目标：${stageInfo.goal}\n`);
            if (stageInfo.items.length > 0) {
                lines.push("步骤：");
                stageInfo.items.forEach((item, i) => lines.push(`${i + 1}. ${item}`));
                lines.push("");
            }

            // Soft tool/MCP recommendations — resolve aliases and flag unimplemented
            if (stageInfo.tools.length > 0) {
                const resolved: string[] = [];
                const unavailable: string[] = [];
                for (const t of stageInfo.tools) {
                    if (SOP_STAGE_EXCLUDED_TOOLS.has(t)) continue;
                    if (UNIMPLEMENTED_TOOLS.has(t)) {
                        unavailable.push(t);
                    } else {
                        resolved.push(TOOL_ALIAS_MAP[t] ?? t);
                    }
                }
                const deduped = [...new Set(resolved)];
                if (deduped.length > 0) {
                    lines.push(`【推荐工具】${deduped.join(", ")}（优先使用，也可按需使用其他工具）`);
                }
                if (unavailable.length > 0) {
                    lines.push(`【暂不可用】${unavailable.join(", ")}（尚未实现，请用已有工具替代，并在摘要中说明）`);
                }
            }
            if (stageInfo.mcp.length > 0) {
                lines.push(`【推荐MCP】${stageInfo.mcp.join(", ")}（优先使用，也可按需使用其他MCP）`);
            }
            if (stageInfo.tools.length > 0 || stageInfo.mcp.length > 0) {
                lines.push("");
            }
        }

        // Inject last successful run's stage abstract for dedup reference
        const history = loadWorkflowHistory(sop.id);
        const lastCompleted = [...history].reverse().find(
            (r) => r.status === "completed" || r.status === "failed",
        );
        if (lastCompleted) {
            const lastStage = lastCompleted.stages.find((s) => s.stageId === stage.stageId);
            if (lastStage?.abstract) {
                lines.push("---");
                lines.push("【上次执行摘要（用于增量去重，非本次数据源）】");
                lines.push(`上次执行时间：${lastStage.completedAt ?? lastCompleted.startedAt ?? "未知"}`);
                lines.push(`上次该阶段结果：${lastStage.abstract}`);
                lines.push("");
            }
        }

        // Inject experience from past runs
        const experiences = loadWorkflowExperiences(sop.id);
        const stageExperiences = experiences.filter((e) => e.stageId === stage.stageId);
        if (stageExperiences.length > 0) {
            lines.push("---");
            lines.push("【历史执行经验（仅供参考，优先按当前指令执行）】");
            const latest = stageExperiences[stageExperiences.length - 1];
            lines.push(`经验标题：${latest.title}`);
            if (latest.steps) lines.push(`关键步骤：${latest.steps}`);
            if (latest.risk && latest.risk !== "无") lines.push(`注意事项：${latest.risk}`);
            lines.push("");
        }

        if (prevOutput) {
            lines.push("---");
            lines.push("【上一阶段的输出结果】");
            lines.push(prevOutput);
            lines.push("");
        }

        if (allAbstracts && allAbstracts.length > 0) {
            lines.push("---");
            lines.push("【工作流历史摘要索引（可按需参考）】");
            allAbstracts.forEach((a) => {
                lines.push(`- ${a.label}：${a.abstract}`);
            });
            lines.push("");
        }

        lines.push("---");
        lines.push("【执行规范】");
        lines.push("1. 必须从数据源重新获取数据（如调用 API、访问网页），不要用 memory_recall 的旧数据代替实际执行。");
        lines.push("2. 可以参考【上次执行摘要】进行增量处理和去重，只处理新增/变更的内容。");
        lines.push("3. 你在自动化工作流中执行，没有人类在线互动，必须自主决策并完成任务，不要提问或等待确认。");
        lines.push("4. 完成后**必须**输出以下格式的结构化摘要（摘要之后不要再输出任何内容）：");
        lines.push("");
        lines.push("## 阶段结果摘要");
        lines.push("- 要点1");
        lines.push("- 要点2");
        lines.push("");
        lines.push("### 步骤完成情况");
        if (stageInfo && stageInfo.items.length > 0) {
            stageInfo.items.forEach((item, i) => {
                lines.push(`- [ ] ${i + 1}. ${item}`);
            });
            lines.push("");
            lines.push("（将 [ ] 改为 [x] 表示已完成，未完成的步骤请说明原因）");
        }
        lines.push("");
        lines.push("5. 如果遇到错误或推荐工具不可用，请在摘要中明确说明。");

        return lines.join("\n");
    }

    /**
     * Resolve the assistantId for a HAND SOP by matching agent.name to configured assistants.
     */
    function resolveAssistantIdForSop(sop: ParsedHandData): string {
        if (!sop.agentName) return "";
        try {
            const config = loadAssistantsConfig();
            const match = config.assistants.find(
                (a) => a.name === sop.agentName || a.id === sop.agentName,
            );
            return match?.id ?? "";
        } catch {
            return "";
        }
    }

    /**
     * Run a single workflow stage: send it as a scheduled task to the renderer.
     * @param scheduledTaskId - when dispatched by a ScheduledTask, its ID propagates into the session context
     */
    function dispatchWorkflowStage(
        sop: ParsedHandData,
        run: ReturnType<typeof loadWorkflowRun>,
        stageId: string,
        scheduledTaskId?: string,
    ) {
        if (!run) return;
        const stage = run.stages.find((s) => s.stageId === stageId);
        if (!stage) return;

        const stageIdx = run.stages.findIndex((s) => s.stageId === stageId);
        const prevStage = stageIdx > 0 ? run.stages[stageIdx - 1] : null;
        const abstracts = run.stages
            .filter((s) => s.abstract && s.stageId !== stageId)
            .map((s) => ({ label: s.label, abstract: s.abstract! }));

        // Pass prev stage abstract instead of full output to reduce prompt bloat
        const prevOutput = prevStage?.abstract || prevStage?.output;
        const prompt = buildStagePrompt(sop, stage, prevOutput, abstracts);

        updateWorkflowStage(run.sopId, stageId, {
            status: "in_progress",
            startedAt: new Date().toISOString(),
            inputPrompt: prompt,
        });

        const assistantId = resolveAssistantIdForSop(sop);

        const windows = BrowserWindow.getAllWindows();
        for (const win of windows) {
            if (!win.isDestroyed()) {
                win.webContents.send("scheduler:run-task", {
                    name: `${sop.name} · ${stage.label}`,
                    sopName: sop.name,
                    planTaskName: stage.label,
                    prompt,
                    assistantId,
                    cwd: undefined,
                    workflowSopId: run.sopId,
                    workflowStageId: stageId,
                    scheduledTaskId,
                });
            }
        }
    }

    ipcMainHandle("workflow.execute", (_: any, sopId: string) => {
        const allSops = loadHandsFromDir(HANDS_DIR);
        const sop = allSops.find((s) => s.id === sopId);
        if (!sop) throw new Error(`SOP not found: ${sopId}`);
        if (!sop.stages.length) throw new Error(`SOP has no stages: ${sopId}`);

        const run = createWorkflowRun(
            sopId,
            sop.stages.map((s) => ({ id: s.id, label: s.label })),
        );

        // Auto-create a plan table entry to track this workflow run
        const assistantId = resolveAssistantIdForSop(sop);
        const planItem = upsertPlanItem({
            sopName: sop.name,
            category: sop.category || "",
            assistantId,
            content: `${sop.name}\n触发时间：${new Date().toLocaleString("zh-CN")}`,
            status: "in_progress",
            scheduledTime: new Date().toISOString(),
        });
        run.planItemId = planItem.id;
        saveWorkflowRun(run);

        // Start the first stage
        dispatchWorkflowStage(sop, run, run.stages[0].stageId);
        return run;
    });

    ipcMainHandle("workflow.execute-stage", (_: any, sopId: string, stageId: string) => {
        const allSops = loadHandsFromDir(HANDS_DIR);
        const sop = allSops.find((s) => s.id === sopId);
        if (!sop) throw new Error(`SOP not found: ${sopId}`);

        // Load or create a workflow run for single-stage execution
        let run = loadWorkflowRun(sopId);
        if (!run || run.status === "completed") {
            run = createWorkflowRun(
                sopId,
                sop.stages.map((s) => ({ id: s.id, label: s.label })),
            );

            // Auto-create plan item for the new run
            if (!run.planItemId) {
                const assistantId = resolveAssistantIdForSop(sop);
                const planItem = upsertPlanItem({
                    sopName: sop.name,
                    category: sop.category || "",
                    assistantId,
                    content: `${sop.name}\n触发时间：${new Date().toLocaleString("zh-CN")}`,
                    status: "in_progress",
                    scheduledTime: new Date().toISOString(),
                });
                run.planItemId = planItem.id;
                saveWorkflowRun(run);
            }
        }

        // Reset this stage
        updateWorkflowStage(sopId, stageId, {
            status: "pending",
            error: undefined,
            output: undefined,
            sessionId: undefined,
            startedAt: undefined,
            completedAt: undefined,
            duration: undefined,
        });

        run = loadWorkflowRun(sopId)!;
        dispatchWorkflowStage(sop, run, stageId);
        return run;
    });

    ipcMainHandle("workflow.retry-stage", (_: any, sopId: string, stageId: string) => {
        const allSops = loadHandsFromDir(HANDS_DIR);
        const sop = allSops.find((s) => s.id === sopId);
        if (!sop) return null;

        const run = loadWorkflowRun(sopId);
        if (!run) return null;

        // Restore plan item to in_progress when retrying a failed workflow
        if (run.planItemId && (run.status === "failed" || run.status === "completed")) {
            updatePlanItem(run.planItemId, {
                status: "in_progress",
                result: "",
                completedAt: null,
            });
        }

        updateWorkflowStage(sopId, stageId, {
            status: "pending",
            error: undefined,
            output: undefined,
            sessionId: undefined,
            startedAt: undefined,
            completedAt: undefined,
            duration: undefined,
        });

        const updatedRun = loadWorkflowRun(sopId)!;
        dispatchWorkflowStage(sop, updatedRun, stageId);
        return updatedRun;
    });

    // Listen for workflow stage completion from renderer
    ipcMain.on("workflow-stage-complete", (_: any, payload: {
        sopId: string;
        stageId: string;
        output: string;
        abstract: string;
        sessionId?: string;
        error?: string;
    }) => {
        const { sopId, stageId, output, abstract: stageAbstract, sessionId, error } = payload;

        // Validate step completion against stage definition
        const allSopsForValidation = loadHandsFromDir(HANDS_DIR);
        const sopDef = allSopsForValidation.find((s) => s.id === sopId);
        const stageDef = sopDef?.stages.find((s) => s.id === stageId);
        if (stageDef && stageDef.items.length > 0 && !error) {
            const checkboxes = [...output.matchAll(/- \[(x| )\]\s*\d+\.\s*(.+)/gi)];
            const completed = checkboxes.filter((m) => m[1].toLowerCase() === "x").length;
            const total = stageDef.items.length;
            if (checkboxes.length === 0) {
                console.warn(`[workflow] Stage ${stageId}: agent did not output step checklist (${total} steps expected)`);
            } else if (completed < total) {
                const missed = checkboxes
                    .filter((m) => m[1] === " ")
                    .map((m) => m[2].trim());
                console.warn(`[workflow] Stage ${stageId}: ${completed}/${total} steps completed. Incomplete: ${missed.join("; ")}`);
            }
        }

        updateWorkflowStage(sopId, stageId, {
            status: error ? "failed" : "completed",
            output,
            abstract: stageAbstract,
            sessionId,
            error,
        });

        // Auto-sync plan table when the entire workflow finishes or fails
        const runAfterUpdate = loadWorkflowRun(sopId);
        if (runAfterUpdate?.planItemId) {
            const isTerminal = runAfterUpdate.status === "completed" || runAfterUpdate.status === "failed" || !!error;
            const noMoreStages = !getNextPendingStage(runAfterUpdate, stageId);
            if (isTerminal || (noMoreStages && !error)) {
                const allAbstracts = runAfterUpdate.stages
                    .filter((s) => s.abstract)
                    .map((s) => `${s.label}：${s.abstract}`)
                    .join("\n");
                updatePlanItem(runAfterUpdate.planItemId, {
                    status: error ? "failed" : "completed",
                    result: allAbstracts || stageAbstract || (error ? `失败：${error}` : "已完成"),
                    completedAt: error ? null : new Date().toISOString(),
                });
            }
        }

        // Auto-advance to next stage if completed
        if (!error) {
            const run = loadWorkflowRun(sopId);
            if (run) {
                const next = getNextPendingStage(run, stageId);
                if (next) {
                    const allSops = loadHandsFromDir(HANDS_DIR);
                    const sop = allSops.find((s) => s.id === sopId);
                    if (sop) {
                        dispatchWorkflowStage(sop, run, next.stageId);
                    }
                }
            }
        }

        // Async: extract stage experience via AI for future runs
        if (output && output.length > 50) {
            const run = loadWorkflowRun(sopId);
            const stageRun = run?.stages.find((s) => s.stageId === stageId);
            const stageLabel = stageRun?.label ?? stageId;

            extractExperienceViaAI(output, `SOP阶段：${stageLabel}`)
                .then((aiResult) => {
                    if (!aiResult) return;
                    const exp: StageExperience = {
                        stageId,
                        stageLabel,
                        runId: run?.id ?? "",
                        extractedAt: new Date().toISOString(),
                        title: aiResult.title,
                        scenario: aiResult.scenario,
                        steps: aiResult.steps,
                        result: aiResult.result,
                        risk: aiResult.risk,
                    };
                    saveStageExperience(sopId, exp);
                    console.log(`[workflow] Extracted experience for ${sopId}/${stageId}: ${aiResult.title}`);
                })
                .catch((err) => {
                    console.warn(`[workflow] Failed to extract experience for ${sopId}/${stageId}:`, err);
                });
        }
    });

    // Read directory contents (one level deep)
    ipcMainHandle("read-dir", (_: any, dirPath: string) => {
        const IGNORE = new Set([
            ".git", "node_modules", ".DS_Store", "__pycache__",
            ".next", "dist", "build", ".cache", ".venv", "venv",
        ]);
        try {
            const names = readdirSync(dirPath);
            const result: Array<{ name: string; path: string; isDir: boolean; size: number; modifiedAt: number }> = [];
            for (const name of names) {
                if (IGNORE.has(name) || name.startsWith(".")) continue;
                try {
                    const fullPath = join(dirPath, name);
                    const stat = statSync(fullPath);
                    result.push({
                        name,
                        path: fullPath,
                        isDir: stat.isDirectory(),
                        size: stat.size,
                        modifiedAt: stat.mtimeMs,
                    });
                } catch { /* skip inaccessible entries */ }
            }
            result.sort((a, b) => {
                if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
                return a.name.localeCompare(b.name);
            });
            return result;
        } catch (err) {
            console.error("[read-dir] Error reading", dirPath, err);
            return [];
        }
    });
});

// Keep app alive when all windows are closed (quick window shortcut stays active)
app.on("window-all-closed", () => {
    // Don't quit — the global shortcut should remain active
    // On macOS this is default behavior; on Windows/Linux we explicitly prevent quit
});

// Mark quitting so main window close handler allows actual destroy
app.on("before-quit", () => {
    isQuitting = true;
});

// Stop embedded API and unregister shortcuts when app is quitting
app.on("will-quit", () => {
    globalShortcut.unregisterAll();
    console.log("Stopping embedded API server...");
    stopEmbeddedApi();
});
