import path from "path"
import { app } from "electron"
import { existsSync } from "fs"

export function resolveAppAsset(...segments: string[]): string {
    const relativePath = path.join(...segments)
    const candidates = [
        path.join(app.getAppPath(), relativePath),
        path.join(process.resourcesPath, relativePath),
        path.join(app.getAppPath(), "..", relativePath),
    ]

    return candidates.find((candidate) => existsSync(candidate)) ?? candidates[0]
}

export function getPreloadPath() {
    const nextPath = resolveAppAsset("dist-electron", "electron", "preload.cjs")
    if (existsSync(nextPath)) return nextPath

    // Backward compatibility for stale local builds produced before the clean-output fix.
    return resolveAppAsset("dist-electron", "preload.cjs")
}

export function getUIPath() {
    return resolveAppAsset("dist-react", "index.html");
}

export function getIconPath() {
    return resolveAppAsset("app-icon.png")
}

export function getTrayIconPath() {
    return resolveAppAsset("trayIconTemplate.png")
}