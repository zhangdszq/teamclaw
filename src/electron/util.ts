import { ipcMain, WebContents, WebFrameMain } from "electron";
import { getUIPath } from "./pathResolver.js";
import { pathToFileURL } from "url";
import path from "path";
export const DEV_PORT = 5173;

// Checks if you are in development mode
export function isDev(): boolean {
    return process.env.NODE_ENV == "development";
}

// Making IPC Typesafe
export function ipcMainHandle<Key extends keyof EventPayloadMapping>(key: Key, handler: (...args: any[]) => EventPayloadMapping[Key] | Promise<EventPayloadMapping[Key]>) {
    ipcMain.handle(key, (event, ...args) => {
        if (event.senderFrame) validateEventFrame(event.senderFrame);

        return handler(event, ...args)
    });
}

export function ipcWebContentsSend<Key extends keyof EventPayloadMapping>(key: Key, webContents: WebContents, payload: EventPayloadMapping[Key]) {
    webContents.send(key, payload);
}

export function validateEventFrame(frame: WebFrameMain) {
    if (isDev() && new URL(frame.url).host === `localhost:${DEV_PORT}`) return;

    // Production renderer must come from local dist-react/index.html.
    // Allow query/hash differences (e.g. ?mode=quick) and tolerate trailing slash variance.
    const expectedUrl = pathToFileURL(getUIPath());
    const expectedPath = path.normalize(decodeURIComponent(expectedUrl.pathname)).replace(/\/+$/, "");

    let actualUrl: URL;
    try {
        actualUrl = new URL(frame.url);
    } catch {
        throw new Error("Malicious event");
    }

    if (actualUrl.protocol !== "file:") {
        console.warn("[IPC] Blocked non-file sender frame:", actualUrl.toString());
        throw new Error("Malicious event");
    }

    const actualPath = path.normalize(decodeURIComponent(actualUrl.pathname)).replace(/\/+$/, "");
    if (actualPath !== expectedPath) {
        console.warn("[IPC] Blocked unexpected sender frame:", {
            actual: actualUrl.toString(),
            expected: expectedUrl.toString(),
        });
        throw new Error("Malicious event");
    }
}
