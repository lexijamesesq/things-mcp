import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { convertV4MiniflareOptions, Miniflare } from "miniflare";
import { build } from "rolldown";

const directory = mkdtempSync(join(tmpdir(), "things-oauth-validation-"));

const entry = join(directory, "entry.ts");
const oauthPath = fileURLToPath(new URL("../../worker/oauth.ts", import.meta.url));
writeFileSync(
  entry,
  `import {handleWorkerRequest} from ${JSON.stringify(oauthPath)};
export default { fetch(req,env,ctx){env.OWNER_RATE={limit:async()=>({success:true})};return handleWorkerRequest(req,env,ctx,{verifyAccess:async r=>r.headers.get('x-test-owner')==='yes'?{userId:'owner',email:'owner@example.test'}:null,fetcher:async()=>new Response('forwarded')});}};`,
);
const built = await build({
  input: entry,
  external: ["cloudflare:workers"],
  output: { format: "esm", dir: join(directory, "build") },
});
const script = built.output.find((x) => x.type === "chunk").code;
const mf = new Miniflare({
  ...convertV4MiniflareOptions({
    modules: true,
    script,
    compatibilityDate: "2026-11-10",
    compatibilityFlags: ["global_fetch_strictly_public"],
    kvNamespaces: ["OAUTH_KV"],
    bindings: {
      PUBLIC_ORIGIN: "https://things.example",
      OWNER_SUBJECT: "owner",
      ORIGIN_PATH: "/_origin/mcp",
      SIGNING_JWK: JSON.stringify(
        await crypto.subtle.exportKey(
          "jwk",
          (await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"])).privateKey,
        ),
      ),
      SIGNING_KID: "test",
      STUDIO_AUDIENCE: "test",
      CF_ACCESS_CLIENT_ID: "test",
      CF_ACCESS_CLIENT_SECRET: "test",
    },
  }),
  enableDevRegistry: false,
  resourceTmpPath: join(directory, "runtime"),
});

const callbacks = [];
const injections = [];
const responsePages = [];
const target = createServer((q, s) => {
  if (q.url.startsWith("/callback")) callbacks.push({ url: q.url, referer: q.headers.referer });
  else if (!q.url.startsWith("/favicon")) injections.push(q.url);
  s.end("callback reached");
});
target.listen(0, "127.0.0.1");
await once(target, "listening");
const callback = `http://127.0.0.1:${target.address().port}/callback`;
const origin = createServer(async (q, s) => {
  try {
    const chunks = [];
    for await (const c of q) chunks.push(c);
    const response = await mf.dispatchFetch("https://things.example" + q.url, {
      method: q.method,
      headers: { ...q.headers, "x-test-owner": "yes" },
      body: q.method === "GET" ? undefined : Buffer.concat(chunks),
      redirect: "manual",
    });
    const html = await response.text();
    if (q.method === "POST" && q.url === "/authorize")
      responsePages.push({ headers: response.headers, html });
    s.writeHead(response.status, Object.fromEntries(response.headers));
    s.end(html);
  } catch (e) {
    s.writeHead(500);
    s.end(String(e));
  }
});
origin.listen(0, "127.0.0.1");
await once(origin, "listening");
const injected =
  '</script><script>globalThis.injected=true;fetch("' +
  callback.replace("/callback", "/injection") +
  '")</script><img src=x onerror="globalThis.injected=true">';
const registration = await mf.dispatchFetch("https://things.example/register", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    client_name: injected,
    redirect_uris: [callback],
    token_endpoint_auth_method: "none",
  }),
});
assert.equal(registration.status, 201);
const client = await registration.json();
const state = injected + "\u2028\u2029";
const auth = new URLSearchParams({
  client_id: client.client_id,
  redirect_uri: callback,
  response_type: "code",
  code_challenge: createHash("sha256").update("x".repeat(43)).digest("base64url"),
  code_challenge_method: "S256",
  state,
});
const profile = join(directory, "chrome");
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

  for (const decision of ["approve", "deny"]) {
    await send(
      "Page.navigate",
      { url: `http://127.0.0.1:${origin.address().port}/authorize?${auth}` },
      sessionId,
    );
    await new Promise((r) => setTimeout(r, 300));
    const before = await send(
      "Runtime.evaluate",
      {
        expression:
          'JSON.stringify({scripts:document.scripts.length,injected:!!globalThis.injected,buttons:document.querySelectorAll("button").length})',
        returnByValue: true,
      },
      sessionId,
    );
    assert.deepEqual(JSON.parse(before.result.result.value), {
      scripts: 0,
      injected: false,
      buttons: 2,
    });
    await send(
      "Runtime.evaluate",
      { expression: `document.querySelector('button[value="${decision}"]').click()` },
      sessionId,
    );
    for (let i = 0; i < 30 && callbacks.length < (decision === "approve" ? 1 : 2); i++)
      await new Promise((r) => setTimeout(r, 100));
    assert.equal(callbacks.length, decision === "approve" ? 1 : 2);
    const reached = new URL(callbacks.at(-1).url, callback);
    assert.equal(reached.searchParams.get("state"), state);
    assert.equal(callbacks.at(-1).referer, undefined);
    if (decision === "approve") assert.ok(reached.searchParams.get("code"));
    else assert.equal(reached.searchParams.get("error"), "access_denied");
    const page = responsePages.at(-1);
    assert.equal((page.html.match(/<script /g) ?? []).length, 1);
    assert.doesNotMatch(page.html, /<img/);
    assert.equal(page.headers.get("referrer-policy"), "no-referrer");
    assert.match(page.headers.get("content-security-policy"), /script-src 'nonce-/);
  }
  assert.deepEqual(injections, []);
  const cspErrors = events.filter(
    (x) => x.method === "Log.entryAdded" && /Content Security Policy/.test(x.params.entry.text),
  );
  assert.deepEqual(cspErrors, []);
  console.log(
    JSON.stringify({
      passed: true,
      approveCallback: true,
      denyCallback: true,
      maliciousClientNameEscaped: true,
      stateRoundTrip: true,
      referrerOmitted: true,
      cspErrors: 0,
    }),
  );
  await send("Browser.close");
  ws.close();
} finally {
  browser.kill();
  origin.close();
  target.close();
  await mf.dispose();
  setTimeout(() => rmSync(directory, { recursive: true, force: true }), 1000).unref();
}
