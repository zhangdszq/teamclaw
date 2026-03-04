import { createRequire } from "module";
const require = createRequire(import.meta.url);
const WebSocket = require("ws");
const wsUrl = process.argv[2];
const ws = new WebSocket(wsUrl);
let msgId = 1;
ws.on("open", () => {
  ws.send(JSON.stringify({id: msgId++, method: "Runtime.enable"}));
  ws.send(JSON.stringify({id: msgId++, method: "Log.enable"}));
});
ws.on("message", (raw) => {
  const msg = JSON.parse(raw);
  if (msg.method === "Runtime.consoleAPICalled") {
    const args = (msg.params.args || []).map(a => a.value || a.description || "").join(" ");
    const type = msg.params.type;
    console.log(`[${type}] ${args}`);
  }
  if (msg.method === "Runtime.exceptionThrown") {
    console.log("[exception]", JSON.stringify(msg.params.exceptionDetails, null, 2));
  }
  if (msg.method === "Log.entryAdded") {
    const e = msg.params.entry;
    console.log(`[log:${e.level}] ${e.text}`);
  }
});
setTimeout(() => { ws.close(); process.exit(0); }, 15000);
