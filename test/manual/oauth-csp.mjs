import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";

const allowCallback = process.argv.includes("--allow-callback");
let hit = 0;
const target = createServer((q, s) => {
  if (q.url === "/callback") hit++;
  s.end("callback reached");
});
target.listen(0, "127.0.0.1");
await once(target, "listening");
const origin = createServer((q, s) => {
  if (q.url === "/authorize") {
    s.writeHead(302, { Location: `http://127.0.0.1:${target.address().port}/callback` });
    s.end();
  } else {
    s.writeHead(200, {
      "Content-Type": "text/html",
      "Content-Security-Policy": `default-src 'none'; form-action 'self'${allowCallback ? " http://127.0.0.1:" + target.address().port : ""}; frame-ancestors 'none'; base-uri 'none'`,
    });
    s.end('<form method="post" action="/authorize"><button>Allow</button></form>');
  }
});
origin.listen(0, "127.0.0.1");
await once(origin, "listening");
const profile = mkdtempSync("/private/tmp/things-csp-chrome-");
const browser = spawn(
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  [
    "--headless=new",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-background-networking",
    "--remote-debugging-port=0",
    "--user-data-dir=" + profile,
    "about:blank",
  ],
  { stdio: ["ignore", "ignore", "pipe"] },
);
try {
  let logs = "";
  const endpoint = await new Promise((resolve, reject) => {
    browser.stderr.on("data", (b) => {
      logs += b;
      const m = logs.match(/DevTools listening on (ws:\/\/[^\s]+)/);
      if (m) resolve(m[1]);
    });
    browser.on("exit", () => reject(new Error("Chrome exited")));
  });
  const ws = new WebSocket(endpoint);
  await once(ws, "open");
  let next = 0;
  const pending = new Map();
  const events = [];
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id) {
      pending.get(m.id)?.(m);
      pending.delete(m.id);
    } else events.push(m);
  };
  const send = (method, params = {}, sessionId) =>
    new Promise((r) => {
      const id = ++next;
      pending.set(id, r);
      ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  const {
    result: { targetId },
  } = await send("Target.createTarget", { url: "about:blank" });
  const {
    result: { sessionId },
  } = await send("Target.attachToTarget", { targetId, flatten: true });
  await send("Page.enable", {}, sessionId);
  await send("Log.enable", {}, sessionId);
  await send("Runtime.enable", {}, sessionId);
  await send("Page.navigate", { url: `http://127.0.0.1:${origin.address().port}/` }, sessionId);
  await new Promise((r) => setTimeout(r, 500));
  await send(
    "Runtime.evaluate",
    { expression: 'document.querySelector("button").click()' },
    sessionId,
  );
  await new Promise((r) => setTimeout(r, 500));
  assert.equal(hit, allowCallback ? 1 : 0);
  console.log(
    JSON.stringify({
      allowCallback,
      callbackHits: hit,
      errors: events.filter((x) => x.method === "Log.entryAdded").map((x) => x.params.entry.text),
    }),
  );
  await send("Browser.close");
  ws.close();
} finally {
  browser.kill();
  origin.close();
  target.close();
  setTimeout(() => rmSync(profile, { recursive: true, force: true }), 1000).unref();
}
