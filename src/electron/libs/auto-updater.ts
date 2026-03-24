import { app, BrowserWindow } from "electron";
import log from "electron-log";
import electronUpdater, { type ProgressInfo, type UpdateDownloadedEvent, type UpdateInfo } from "electron-updater";
import { ipcMainHandle, ipcWebContentsSend } from "../util.js";

const { autoUpdater } = electronUpdater;

const FIRST_CHECK_DELAY_MS = 10_000;
const CHECK_INTERVAL_MS = 30 * 60 * 1000;

type UpdaterBroadcastPayload =
  | { type: "checking" }
  | { type: "available"; version: string; releaseNotes: string | null }
  | { type: "not-available"; version: string }
  | { type: "download-progress"; percent: number; bytesPerSecond: number; transferred: number; total: number }
  | { type: "downloaded"; version: string; releaseNotes: string | null }
  | { type: "error"; message: string };

let didInitialize = false;
let checkingForUpdates = false;
let downloadedVersion: string | null = null;

function normalizeReleaseNotes(releaseNotes: UpdateInfo["releaseNotes"]): string | null {
  if (!releaseNotes) return null;
  if (typeof releaseNotes === "string") return releaseNotes;
  if (Array.isArray(releaseNotes)) {
    return releaseNotes
      .map((note) => (typeof note.note === "string" ? note.note.trim() : ""))
      .filter(Boolean)
      .join("\n\n");
  }
  return null;
}

function broadcast(payload: UpdaterBroadcastPayload) {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) {
      ipcWebContentsSend("updater-event", window.webContents, payload);
    }
  }
}

function buildDisabledMessage(): string {
  if (!app.isPackaged) {
    return "自动更新仅在打包后的应用中可用";
  }
  return "当前构建未配置可用的更新源";
}

async function runUpdateCheck(enabled: boolean): Promise<boolean> {
  if (!enabled) {
    broadcast({ type: "error", message: buildDisabledMessage() });
    return false;
  }
  if (checkingForUpdates) {
    return false;
  }

  checkingForUpdates = true;
  try {
    await autoUpdater.checkForUpdates();
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log.error("[auto-updater] Failed to check for updates:", message);
    broadcast({ type: "error", message });
    return false;
  } finally {
    checkingForUpdates = false;
  }
}

export function setupAutoUpdater(options?: { enabled?: boolean; onBeforeInstall?: () => void }) {
  if (didInitialize) return;
  didInitialize = true;

  const enabled = options?.enabled ?? app.isPackaged;

  autoUpdater.logger = log;
  autoUpdater.autoDownload = enabled;
  autoUpdater.autoInstallOnAppQuit = enabled;

  ipcMainHandle("get-app-version", () => app.getVersion());
  ipcMainHandle("updater-check", async () => runUpdateCheck(enabled));
  ipcMainHandle("updater-install", () => {
    if (!enabled || !downloadedVersion) {
      if (!enabled) {
        broadcast({ type: "error", message: buildDisabledMessage() });
      }
      return false;
    }
    log.info("[auto-updater] quitAndInstall requested for version:", downloadedVersion);
    options?.onBeforeInstall?.();
    setImmediate(() => autoUpdater.quitAndInstall(false, true));
    return true;
  });

  if (!enabled) {
    return;
  }

  autoUpdater.on("checking-for-update", () => {
    broadcast({ type: "checking" });
  });

  autoUpdater.on("update-available", (info: UpdateInfo) => {
    downloadedVersion = null;
    broadcast({
      type: "available",
      version: info.version,
      releaseNotes: normalizeReleaseNotes(info.releaseNotes),
    });
  });

  autoUpdater.on("update-not-available", (info: UpdateInfo) => {
    downloadedVersion = null;
    broadcast({
      type: "not-available",
      version: info.version,
    });
  });

  autoUpdater.on("download-progress", (progress: ProgressInfo) => {
    broadcast({
      type: "download-progress",
      percent: progress.percent,
      bytesPerSecond: progress.bytesPerSecond,
      transferred: progress.transferred,
      total: progress.total,
    });
  });

  autoUpdater.on("update-downloaded", (info: UpdateDownloadedEvent) => {
    downloadedVersion = info.version;
    broadcast({
      type: "downloaded",
      version: info.version,
      releaseNotes: normalizeReleaseNotes(info.releaseNotes),
    });
  });

  autoUpdater.on("error", (error) => {
    const message = error?.message || String(error);
    log.error("[auto-updater] Error:", message);
    broadcast({ type: "error", message });
  });

  setTimeout(() => {
    void runUpdateCheck(enabled);
  }, FIRST_CHECK_DELAY_MS);

  setInterval(() => {
    void runUpdateCheck(enabled);
  }, CHECK_INTERVAL_MS);
}
