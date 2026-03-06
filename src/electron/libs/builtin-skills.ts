/**
 * Deploys built-in skills bundled with VK-Cowork.
 * On each app startup, copies skill directories into:
 *   - ~/.claude/skills/   (Claude / AI Team runner)
 *   - ~/.codex/skills/    (Codex runner)
 * Source: builtin-skills/ (packed via extraResources).
 */
import { existsSync, mkdirSync, readdirSync, statSync, cpSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { app } from "electron";

function getBuiltinSkillsDir(): string {
    if (app.isPackaged) {
        return join(process.resourcesPath, "builtin-skills");
    }
    return join(app.getAppPath(), "builtin-skills");
}

export function seedBuiltinSkills(): void {
    const srcDir = getBuiltinSkillsDir();

    if (!existsSync(srcDir)) {
        console.log("[BuiltinSkills] No builtin-skills directory found, skipping.");
        return;
    }

    const targets = [
        join(homedir(), ".claude", "skills"),
        join(homedir(), ".codex", "skills"),
    ];

    const entries = readdirSync(srcDir).filter((name) => {
        const full = join(srcDir, name);
        return statSync(full).isDirectory() && !name.startsWith(".");
    });

    if (entries.length === 0) {
        console.log("[BuiltinSkills] builtin-skills/ is empty, skipping.");
        return;
    }

    for (const targetBase of targets) {
        if (!existsSync(targetBase)) {
            mkdirSync(targetBase, { recursive: true });
        }

        for (const skillName of entries) {
            const src = join(srcDir, skillName);
            const dest = join(targetBase, skillName);
            try {
                cpSync(src, dest, { recursive: true, force: true });
                console.log(`[BuiltinSkills] Deployed ${skillName} -> ${dest}`);
            } catch (err) {
                console.error(`[BuiltinSkills] Failed to deploy ${skillName} to ${dest}:`, err);
            }
        }
    }
}
