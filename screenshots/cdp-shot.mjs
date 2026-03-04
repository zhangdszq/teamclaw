import { createRequire } from "module";
const require = createRequire(import.meta.url);
const WebSocket = require("ws");
const fs = require("fs");
const wsUrl = process.argv[2];
const outPath = process.argv[3];
const ws = new WebSocket(wsUrl);
ws.on("open", () => {
  ws.send(JSON.stringify({id:1, method:"Page.enable"}));
});
ws.on("message", (data) => {
  const msg = JSON.parse(data);
  if (msg.id === 1) {
    ws.send(JSON.stringify({id:2, method:"Page.captureScreenshot", params:{format:"png"}}));
  }
  if (msg.id === 2 && msg.result && msg.result.data) {
    fs.writeFileSync(outPath, Buffer.from(msg.result.data, "base64"));
    console.log("screenshot saved:", outPath);
    ws.close();
    process.exit(0);
  }
});
ws.on("error", (e) => { console.error("ws error:", e.message); process.exit(1); });
setTimeout(() => { console.error("timeout"); process.exit(1); }, 10000);
