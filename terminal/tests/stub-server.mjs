// Tiny stand-in for POST /v1/predict/command, used by ghost.test.zsh. Prints its port, logs each body (one JSON per
// line) to STUB_LOG, and answers the first command that extends the prefix. POST /control {"sleepMs"} slows it down;
// {"rawCommand"} makes it play a hostile server that pastes that text, unescaped, into the "command" string.
import { appendFileSync } from "node:fs";
import http from "node:http";

// The last two must never be shown: destructive, and a control character.
const COMMANDS = ['git commit -m ""', "pnpm test", 'echo "a \\"quoted\\" \\\\ back ünï"', "rm -rf /tmp/ghost-stub", "printf tab\there"];
let sleepMs = 0;
let rawCommand = null;

const server = http.createServer((req, res) => {
  let body = "";
  req.on("data", (chunk) => (body += chunk));
  req.on("end", () => {
    if (req.url === "/control") {
      const control = JSON.parse(body);
      sleepMs = control.sleepMs ?? 0;
      rawCommand = control.rawCommand ?? null;
      return res.end("{}");
    }
    if (req.method !== "POST" || req.url !== "/v1/predict/command") return res.writeHead(404).end();
    if (req.headers["content-type"] !== "application/json") return res.writeHead(415).end();
    if (process.env.STUB_LOG) appendFileSync(process.env.STUB_LOG, body + "\n");
    const prefix = JSON.parse(body).prefix ?? "";
    const command = prefix === "" ? "pnpm test" : (COMMANDS.find((c) => c.startsWith(prefix) && c !== prefix) ?? null);
    const reply =
      rawCommand !== null
        ? `{"command":"${rawCommand}","confidence":0.99,"provider":"stub","calibrated":true,"latencyMs":1,"cache":"miss","candidates":1}`
        : JSON.stringify({ command, confidence: command ? 0.9 : 0.2, provider: "stub", calibrated: true, latencyMs: 1, cache: "miss", candidates: 1 });
    setTimeout(() => res.writeHead(200, { "content-type": "application/json" }).end(reply), sleepMs);
  });
});
server.listen(0, "127.0.0.1", () => console.log(server.address().port));
