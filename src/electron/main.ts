import { sendTestDingtalkAlert } from "./libs/app-logger.js";
import { app, BrowserWindow, ipcMain, dialog, shell, protocol, globalShortcut, screen, Tray, Menu, nativeImage } from "electron"
import fs from "fs"
import { ipcMainHandle, isDev, DEV_PORT } from "./util.js";
import { getPreloadPath, getUIPath, getIconPath, getTrayIconPath } from "./pathResolver.js";
import { getStaticData, pollResources } from "./test.js";
import { handleClientEvent, sessions } from "./ipc-handlers.js";
// Inject the shared SessionStore into bot modules so they use the same DB connection
setSessionStore(sessions);
setFeishuSessionStore(sessions);
setTelegramSessionStore(sessions);
import type { ClientEvent } from "./types.js";
import "./libs/claude-settings.js";
import { loadUserSettings, saveUserSettings, type UserSettings } from "./libs/user-settings.js";
import { loadAssistantsConfig, saveAssistantsConfig, assistantConfigEvents, type AssistantsConfig, DEFAULT_PERSONA, DEFAULT_CORE_VALUES, DEFAULT_RELATIONSHIP, DEFAULT_COGNITIVE_STYLE, DEFAULT_OPERATING_GUIDELINES, DEFAULT_HEARTBEAT_RULES } from "./libs/assistants-config.js";
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
  readAbstract,
  listSops, readSop, writeSop, searchSops, deleteSop,
  ScopedMemory,
} from "./libs/memory-store.js";
import { 
  loadScheduledTasks, 
  addScheduledTask, 
  updateScheduledTask, 
  deleteScheduledTask,
  startScheduler,
  stopScheduler,
  setSchedulerSessionRunner,
  runHookTasks,
  type ScheduledTask
} from "./libs/scheduler.js";
import { startHeartbeatLoop, stopHeartbeatLoop, startMemoryCompactTimer, stopMemoryCompactTimer } from "./libs/heartbeat.js";
import { loadPlanItems, updatePlanItem } from "./libs/plan-store.js";
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
    listKnowledgeDocs,
    createKnowledgeDoc,
    updateKnowledgeDoc,
    deleteKnowledgeDoc,
    getKnowledgeBasePath,
} from "./libs/knowledge-store.js";

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
            updateDingtalkBotConfig(assistant.id, updates);
            updateTelegramBotConfig(assistant.id, updates);
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

    // Plan table handlers
    ipcMainHandle("get-plan-items", () => {
        return loadPlanItems();
    });

    function buildPlanPrompt(content: string, sopName: string, planItemId: string): string {
        return `${content}

---
【计划项执行规范 - 必须遵守】
本次任务来自计划表（SOP: ${sopName}，计划项 ID: ${planItemId}），执行全程须调用以下 MCP 工具管理状态：

1. **任务开始时**：调用 upsert_plan_item
   - sop_name: "${sopName}"
   - status: "in_progress"
   - content: 当前任务描述

2. **任务完成后**：必须调用 complete_plan_item
   - sop_name: "${sopName}"
   - result: 执行结果摘要（100字以内）

3. **任务失败时**：调用 fail_plan_item
   - sop_name: "${sopName}"
   - reason: 失败原因

⚠️ 无论任务成功还是失败，结束前都必须调用对应工具更新计划项状态，否则计划表将无法同步进度。`;
    }

    ipcMainHandle("retry-plan-item", (_: any, id: string) => {
        const items = loadPlanItems();
        const item = items.find((i) => i.id === id);
        if (!item) return { ok: false, error: "Plan item not found" };

        updatePlanItem(id, { status: "pending", result: "", completedAt: null });

        const windows = BrowserWindow.getAllWindows();
        for (const win of windows) {
            if (!win.isDestroyed()) {
                win.webContents.send("scheduler:run-task", {
                    name: item.sopName,
                    sopName: item.sopName,
                    planTaskName: item.content.split("\n")[0].slice(0, 40),
                    prompt: buildPlanPrompt(item.content, item.sopName, id),
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

        updatePlanItem(id, { status: "in_progress" });

        const windows = BrowserWindow.getAllWindows();
        for (const win of windows) {
            if (!win.isDestroyed()) {
                win.webContents.send("scheduler:run-task", {
                    name: item.sopName,
                    sopName: item.sopName,
                    planTaskName: item.content.split("\n")[0].slice(0, 40),
                    prompt: buildPlanPrompt(item.content, item.sopName, id),
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
    ipcMainHandle("memory-read", (_: any, target: string, date?: string, assistantId?: string) => {
        const scoped = assistantId ? new ScopedMemory(assistantId) : null;
        if (target === "long-term") return { content: readLongTermMemory() };
        if (target === "daily") return { content: readDailyMemory(date ?? new Date().toISOString().slice(0, 10)) };
        if (target === "assistant-daily") return { content: scoped ? scoped.readDaily(date ?? new Date().toISOString().slice(0, 10)) : "" };
        if (target === "context") return { content: buildMemoryContext() };
        if (target === "session-state") return { content: scoped ? scoped.readSessionState() : readSessionState() };
        if (target === "abstract") return { content: readAbstract() };
        return { content: "", memoryDir: getMemoryDir() };
    });

    ipcMainHandle("memory-write", (_: any, target: string, content: string, date?: string, assistantId?: string) => {
        const scoped = assistantId ? new ScopedMemory(assistantId) : null;
        if (target === "long-term") { writeLongTermMemory(content); return { success: true }; }
        if (target === "daily-append") { appendDailyMemory(content, date); return { success: true }; }
        if (target === "daily") { writeDailyMemory(content, date ?? new Date().toISOString().slice(0, 10)); return { success: true }; }
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
                const raw = readFileSync(settingsPath, "utf8");
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
                    if (!statSync(skillPath).isDirectory()) continue;
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
                        if (match.description && !skill.description) skill.description = match.description;
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

    // Install skill via curl + unzip (no git required)
    // Supports:
    //   - GitHub subdirectory: https://github.com/user/repo/tree/branch/subdir
    //   - GitHub full repo:    https://github.com/user/repo
    ipcMainHandle("install-skill", async (_: any, url: string) => {
        const { execSync } = await import("child_process");
        const { mkdtempSync, cpSync, rmSync } = await import("fs");
        const { tmpdir } = await import("os");
        const home = homedir();

        const urlClean = url.replace(/\.git\/?$/, "").replace(/\/+$/, "");

        // Normalize blob URLs to tree URLs:
        // /blob/branch/path/SKILL.md → /tree/branch/path (strip file, use parent dir)
        // /blob/branch/path          → /tree/branch/path (already a directory)
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

        // Parse GitHub URL
        const subdirMatch = normalizedUrl.match(/^https:\/\/github\.com\/([^/]+)\/([^/]+)\/tree\/([^/]+)\/(.+)$/);
        const repoMatch = !subdirMatch && normalizedUrl.match(/^https:\/\/github\.com\/([^/]+)\/([^/]+?)(\.git)?$/);

        const targets = [
            join(home, ".claude", "skills", skillName),
            join(home, ".codex", "skills", skillName),
        ];

        const isWin = process.platform === "win32";

        // Download GitHub zip and extract to targetDir (no git)
        // - macOS/Linux: curl + unzip (both built-in)
        // - Windows:     curl (built-in since Win10) + PowerShell Expand-Archive
        const installFromGithub = (user: string, repo: string, branch: string, subPath: string | null, targetDir: string) => {
            const zipUrl = `https://github.com/${user}/${repo}/archive/refs/heads/${branch}.zip`;
            const tmpDir = mkdtempSync(join(tmpdir(), "skill-"));
            const zipFile = join(tmpDir, "skill.zip");
            const extractDir = join(tmpDir, "extract");
            try {
                execSync(`curl -fsSL "${zipUrl}" -o "${zipFile}"`, { timeout: 60000 });
                mkdirSync(extractDir, { recursive: true });

                if (isWin) {
                    // PowerShell Expand-Archive always extracts everything; we pick subdir after
                    const psZip = zipFile.replace(/\\/g, "/");
                    const psExtract = extractDir.replace(/\\/g, "/");
                    execSync(
                        `powershell -NoProfile -Command "Expand-Archive -LiteralPath '${psZip}' -DestinationPath '${psExtract}' -Force"`,
                        { timeout: 60000 }
                    );
                } else {
                    // macOS/Linux: unzip supports pattern to avoid extracting the whole archive
                    const zipPrefix = `${repo}-${branch}/${subPath ?? ""}`;
                    if (subPath) {
                        execSync(`unzip -q "${zipFile}" "${zipPrefix}/*" -d "${extractDir}"`, { timeout: 30000 });
                    } else {
                        execSync(`unzip -q "${zipFile}" -d "${extractDir}"`, { timeout: 30000 });
                    }
                }

                const srcDir = subPath
                    ? join(extractDir, `${repo}-${branch}`, ...subPath.split("/"))
                    : join(extractDir, `${repo}-${branch}`);
                if (existsSync(targetDir)) rmSync(targetDir, { recursive: true, force: true });
                cpSync(srcDir, targetDir, { recursive: true });
            } finally {
                rmSync(tmpDir, { recursive: true, force: true });
            }
        };

        const results: string[] = [];

        for (const targetDir of targets) {
            try {
                const parentDir = join(targetDir, "..");
                if (!existsSync(parentDir)) mkdirSync(parentDir, { recursive: true });

                const action = existsSync(targetDir) ? "更新" : "安装";

                if (subdirMatch) {
                    const [, user, repo, branch, subPath] = subdirMatch;
                    installFromGithub(user, repo, branch, subPath, targetDir);
                } else if (repoMatch) {
                    const [, user, repo] = repoMatch;
                    try {
                        installFromGithub(user, repo, "main", null, targetDir);
                    } catch {
                        installFromGithub(user, repo, "master", null, targetDir);
                    }
                } else {
                    throw new Error(`不支持的地址格式: ${normalizedUrl}`);
                }

                results.push(`${action}: ${targetDir}`);
            } catch (err) {
                results.push(`失败 (${targetDir}): ${(err as Error).message}`);
            }
        }

        console.log("[install-skill]", results);
        return { success: true, skillName, message: results.join("\n") };
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
        icon: string;
        stages: HandStage[];
        workflowCount: number;
    }

    /**
     * Auto-fix common LLM TOML mistakes before parsing:
     * - [settings] → [[settings]]  (LLM forgets double brackets for array-of-tables)
     * - [requires] → [[requires]]
     */
    function fixTomlArrayTables(raw: string): string {
        return raw
            .replace(/^\[settings\]$/gm, "[[settings]]")
            .replace(/^\[requires\]$/gm, "[[requires]]");
    }

    function parseHandTomlFile(tomlPath: string): HandSopResult | null {
        try {
            const raw = fixTomlArrayTables(readFileSync(tomlPath, "utf8"));
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const data = parseToml(raw) as Record<string, any>;

            const id = String(data.id ?? "");
            const name = String(data.name ?? id);
            const description = String(data.description ?? "");
            const icon = String(data.icon ?? "📋");

            const systemPrompt: string = String(data.agent?.system_prompt ?? "");
            const globalMcps: string[] = Array.isArray(data.mcp_servers)
                ? data.mcp_servers.map(String)
                : [];
            const stages = extractHandStages(systemPrompt, globalMcps);

            return { id, name, description, icon, stages, workflowCount: stages.length };
        } catch (err) {
            console.error("[sop.list] Failed to parse HAND.toml:", tomlPath, err);
            return null;
        }
    }

    // All known tool names that can appear in system_prompt
    const KNOWN_TOOLS = [
        "file_read", "file_write", "file_list",
        "web_fetch", "web_search",
        "shell_exec",
        "memory_store", "memory_recall",
        "schedule_create", "schedule_list", "schedule_delete",
        "knowledge_add_entity", "knowledge_add_relation", "knowledge_query",
        "event_publish",
    ];

    // Common MCP server names
    const KNOWN_MCPS = [
        "dingtalk-ai-table", "dingtalk-contacts", "dingtalk-message",
        "feishu-doc", "feishu-sheet", "feishu-message", "feishu-calendar",
        "exa", "github", "slack", "notion", "airtable",
        "google-calendar", "google-sheets", "google-docs",
        "jira", "confluence", "linear", "asana",
        "stripe", "twilio", "sendgrid",
    ];

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

    function loadHandsFromDir(dir: string): HandSopResult[] {
        if (!existsSync(dir)) return [];
        const results: HandSopResult[] = [];
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
name = "..."             # 完整名称
description = "..."      # 一句话描述
category = "..."         # communication / finance / hr / operations / content
icon = "..."             # emoji
\`\`\`

### 2. tools 数组
根据 SOP 实际需要，从以下工具中选择合适的：
- 文件操作：file_read, file_write, file_list
- 网络：web_fetch, web_search
- 命令行：shell_exec（适用于需要运行脚本、调用 API 的场景）
- 记忆：memory_store, memory_recall
- 调度：schedule_create, schedule_list, schedule_delete
- 知识图谱：knowledge_add_entity, knowledge_add_relation, knowledge_query
- 事件：event_publish

### 3. mcp_servers 数组
根据业务需要选择相关 MCP 服务，如 dingtalk-ai-table、feishu-doc、exa 等。
若不需要外部 MCP 则写 mcp_servers = []

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
2. 步骤二（使用 memory_store 记录…）
...
【本阶段工具】file_read、memory_store（从 tools 数组中选取本阶段实际用到的，英文原始名）
【本阶段MCP】feishu-doc、dingtalk-ai-table（从 mcp_servers 数组中选取本阶段用到的，不用可省略）

═══ 第二阶段：阶段名称 ═══
目标：...
1. ...
【本阶段工具】web_search、event_publish
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

## 写入指令
使用 Write 工具将完整 HAND.toml 写入：${targetPath}

## 用户描述
${description}`;

        const abortController = new AbortController();
        // App-configured key takes precedence over ~/.claude/settings.json
        const settings = loadUserSettings();
        const envOverride: Record<string, string> = {};
        if (settings.anthropicAuthToken) envOverride.ANTHROPIC_API_KEY = settings.anthropicAuthToken;
        if (settings.anthropicBaseUrl)   envOverride.ANTHROPIC_BASE_URL = settings.anthropicBaseUrl;

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

        // Verify file was written
        if (!existsSync(targetPath)) {
            // Clean up empty temp dir
            try { rmSync(tmpDir, { recursive: true }); } catch { /* ignore */ }
            throw new Error("Agent 未生成 HAND.toml，请检查 Claude 配置后重试");
        }

        // Auto-fix common LLM TOML mistakes and overwrite the file
        const rawContent = readFileSync(targetPath, "utf8");
        const fixedContent = fixTomlArrayTables(rawContent);
        if (fixedContent !== rawContent) {
            writeFileSync(targetPath, fixedContent, "utf8");
            console.log("[sop.generate] Applied TOML auto-fix (single→double brackets)");
        }

        // Parse the written file
        const parsed = parseHandTomlFile(targetPath);
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
