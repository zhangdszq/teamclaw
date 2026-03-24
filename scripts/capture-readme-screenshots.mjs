#!/usr/bin/env node
/**
 * Connects to Electron via Chrome DevTools Protocol and captures README screenshots.
 * Prerequisite: app running with --remote-debugging-port=9222
 *
 * Waits for UI data loads: main shell, no visible spinners, dialogs present where expected.
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import WebSocket from "ws";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(__dirname, "..", "assets", "readme");
const CDP = "http://127.0.0.1:9222";

let msgId = 0;
/** @param {WebSocket} ws */
function cdpSend(ws, method, params = {}) {
  const id = ++msgId;
  return new Promise((resolve, reject) => {
    const onMsg = (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (msg.id !== id) return;
      ws.off("message", onMsg);
      if (msg.error) reject(new Error(msg.error.message || JSON.stringify(msg.error)));
      else resolve(msg.result);
    };
    ws.on("message", onMsg);
    ws.send(JSON.stringify({ id, method, params }));
  });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitForCdp(port = 9222, maxMs = 60000) {
  const start = Date.now();
  while (Date.now() - start < maxMs) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (r.ok) return;
    } catch {
      /* retry */
    }
    await sleep(300);
  }
  throw new Error(`CDP not ready on port ${port} after ${maxMs}ms`);
}

/** @param {WebSocket} ws */
async function capturePng(ws, filePath) {
  await cdpSend(ws, "Page.bringToFront", {});
  const { data } = await cdpSend(ws, "Page.captureScreenshot", {
    format: "png",
    fromSurface: true,
  });
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, Buffer.from(data, "base64"));
  console.log("Wrote", filePath);
}

/** @param {WebSocket} ws */
async function evaluate(ws, expression) {
  const result = await cdpSend(ws, "Runtime.evaluate", {
    expression,
    awaitPromise: false,
    returnByValue: true,
  });
  if (result.exceptionDetails) {
    const t = result.exceptionDetails.exception?.description || JSON.stringify(result.exceptionDetails);
    throw new Error(t);
  }
  return result.result?.value;
}

/** Visible loading spinners (Tailwind animate-spin) */
const EXPR_NO_VISIBLE_SPINNERS = `(() => {
  const spinners = [...document.querySelectorAll(".animate-spin")];
  const visible = spinners.filter((el) => {
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    const st = window.getComputedStyle(el);
    if (st.visibility === "hidden" || st.opacity === "0" || st.display === "none") return false;
    return true;
  });
  return visible.length === 0;
})()`;

/** Main app shell: sidebar + bottom nav with 设置 */
const EXPR_MAIN_SHELL_READY = `(() => {
  const aside = document.querySelector("aside");
  if (!aside) return false;
  const hasSettings = [...document.querySelectorAll("button")].some((b) =>
    b.textContent?.includes("设置"),
  );
  return hasSettings;
})()`;

/** @param {WebSocket} ws */
async function waitUntilTrue(ws, expression, label, timeoutMs = 60000, intervalMs = 300) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const ok = await evaluate(ws, expression);
    if (ok === true) return;
    await sleep(intervalMs);
  }
  throw new Error(`Timeout waiting for: ${label}`);
}

/** @param {WebSocket} ws */
async function waitForNoVisibleSpinners(ws, timeoutMs = 90000) {
  await waitUntilTrue(ws, EXPR_NO_VISIBLE_SPINNERS, "no visible spinners", timeoutMs);
}

/** @param {WebSocket} ws */
async function waitForMainShell(ws) {
  await waitUntilTrue(ws, EXPR_MAIN_SHELL_READY, "main shell (sidebar + 设置)", 90000);
}

/** @param {WebSocket} ws */
async function waitForDialog(ws, timeoutMs = 30000) {
  const expr = `(() => !!document.querySelector('[role="dialog"]'))()`;
  await waitUntilTrue(ws, expr, "dialog open", timeoutMs);
}

/** @param {WebSocket} ws */
async function waitForNoDialog(ws, timeoutMs = 8000) {
  const expr = `(() => !document.querySelector('[role="dialog"]'))()`;
  await waitUntilTrue(ws, expr, "dialog closed", timeoutMs);
}

/** @param {WebSocket} ws */
async function pressEscape(ws) {
  for (const type of ["keyDown", "keyUp"]) {
    await cdpSend(ws, "Input.dispatchKeyEvent", {
      type,
      windowsVirtualKeyCode: 27,
      code: "Escape",
      key: "Escape",
      nativeVirtualKeyCode: 27,
    });
  }
  await sleep(500);
}

/** @param {WebSocket} ws */
async function settleAfterLoad(ws, extraMs = 1200) {
  try {
    await waitForNoVisibleSpinners(ws, 60000);
  } catch (e) {
    console.warn("[capture] spinner wait:", e.message);
  }
  await sleep(extraMs);
}

/** @param {WebSocket} ws */
async function closeSopOrOverlay(ws) {
  const clicked = await evaluate(
    ws,
    `(() => {
      const back = [...document.querySelectorAll("button")].find(
        (b) => b.textContent?.includes("返回") && b.getBoundingClientRect().width > 0,
      );
      if (back) {
        back.click();
        return true;
      }
      return false;
    })()`,
  );
  if (clicked) await sleep(1500);
  return clicked;
}

async function main() {
  await waitForCdp();
  const listRes = await fetch(`${CDP}/json/list`);
  const list = await listRes.json();
  const pageTarget =
    list.find((t) => t.type === "page" && t.title && /AI Team/i.test(t.title)) ||
    list.find((t) => t.type === "page" && t.url && /index\.html/i.test(t.url)) ||
    list.find((t) => t.type === "page" && t.url && t.url.startsWith("file:")) ||
    list.find((t) => t.type === "page" && t.url && !String(t.url).startsWith("devtools:"));

  if (!pageTarget?.webSocketDebuggerUrl) {
    console.error("No suitable page target:", JSON.stringify(list, null, 2));
    process.exit(1);
  }

  const ws = new WebSocket(pageTarget.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.once("open", resolve);
    ws.once("error", reject);
  });

  await cdpSend(ws, "Page.enable");
  await cdpSend(ws, "Runtime.enable");

  // Dismiss onboarding / Google gate when present
  await evaluate(
    ws,
    `(() => {
      const clickText = (pred) => {
        const btns = [...document.querySelectorAll("button")];
        const b = btns.find(pred);
        if (b) { b.click(); return true; }
        return false;
      };
      if (clickText((b) => b.textContent?.trim() === "跳过")) return "splash_skip";
      if (clickText((b) => b.textContent?.includes("跳过登录"))) return "google_skip";
      return "none";
    })()`,
  );
  await sleep(1500);
  await evaluate(
    ws,
    `(() => {
      const b = [...document.querySelectorAll("button")].find((x) => x.textContent?.includes("跳过登录"));
      if (b) { b.click(); return "google_skip2"; }
      return "none";
    })()`,
  );
  await sleep(2000);

  await waitForMainShell(ws);
  await settleAfterLoad(ws, 1800);

  const shots = [
    { file: "01-main-workspace.png", settleExtra: 2000 },
    { label: "团队管理", file: "02-team-management.png", settleExtra: 2200, expectDialog: true },
    { label: "技能商店", file: "03-skill-store.png", settleExtra: 3500, expectDialog: true },
    { label: "流程商店", file: "04-workflow-store.png", settleExtra: 5500, expectDialog: false, fullPage: true },
    { label: "日历", file: "05-scheduler.png", settleExtra: 2800, expectDialog: true },
    { label: "设置", file: "06-settings.png", settleExtra: 3500, expectDialog: true },
  ];

  // 01 — main workspace
  await capturePng(ws, path.join(OUT_DIR, shots[0].file));
  await sleep(shots[0].settleExtra);

  for (let i = 1; i < shots.length; i++) {
    const step = shots[i];
    await evaluate(
      ws,
      `(() => {
        const label = ${JSON.stringify(step.label)};
        const btn = [...document.querySelectorAll("button")].find((b) =>
          b.textContent?.includes(label),
        );
        if (btn) btn.click();
        return !!btn;
      })()`,
    );
    await sleep(800);
    // Workflow store opens full-page SOP (no role=dialog); others use modals
    if (step.expectDialog) {
      await waitForDialog(ws, 25000);
    } else {
      await sleep(1500);
    }
    await settleAfterLoad(ws, step.settleExtra);
    await capturePng(ws, path.join(OUT_DIR, step.file));
    if (step.fullPage) {
      await closeSopOrOverlay(ws);
      await pressEscape(ws);
    } else {
      await pressEscape(ws);
      await waitForNoDialog(ws, 12000).catch(() => {});
    }
    await sleep(800);
    await waitForMainShell(ws);
    await settleAfterLoad(ws, 600);
  }

  ws.close();
  console.log("Done. Output:", OUT_DIR);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
