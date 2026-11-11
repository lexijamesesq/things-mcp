import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { convertV4MiniflareOptions, Miniflare } from "miniflare";
import { build } from "rolldown";

test("isolated workerd OAuth consent, PKCE, scope, client boundaries, refresh and revocation", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "things-oauth-validation-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const entry = join(directory, "entry.ts");
  const oauthPath = fileURLToPath(new URL("../worker/oauth.ts", import.meta.url));
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
  const req = (path, opts = {}) =>
    mf.dispatchFetch("https://things.example" + path, { ...opts, redirect: "manual" });
  const parse = async (r) => {
    const text = await r.text();
    return { status: r.status, data: text ? JSON.parse(text) : null };
  };
  try {
    const metadata = await parse(await req("/.well-known/oauth-authorization-server"));
    assert.equal(metadata.status, 200);
    assert.deepEqual(metadata.data.code_challenge_methods_supported, ["S256"]);
    assert.equal(metadata.data.client_id_metadata_document_supported, true);
    const client = await parse(
      await req("/register", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          client_name: "Validator",
          redirect_uris: ["http://127.0.0.1:4444/callback"],
          token_endpoint_auth_method: "none",
        }),
      }),
    );
    assert.equal(client.status, 201);
    const cid = client.data.client_id;
    const verifier = "x".repeat(43),
      challenge = createHash("sha256").update(verifier).digest("base64url");
    const auth = new URLSearchParams({
      client_id: cid,
      redirect_uri: "http://127.0.0.1:4444/callback",
      response_type: "code",
      code_challenge: challenge,
      code_challenge_method: "S256",
      state: "test",
    });
    assert.equal((await req("/authorize?" + auth)).status, 401);
    const unknown = new URLSearchParams(auth);
    unknown.set("scope", "things.read unknown.scope");
    const unknownResponse = await req("/authorize?" + unknown, {
      headers: { "x-test-owner": "yes" },
    });
    assert.equal(unknownResponse.status, 302);
    assert.equal(
      new URL(unknownResponse.headers.get("location")).searchParams.get("error"),
      "invalid_scope",
    );
    const noPkce = new URLSearchParams(auth);
    noPkce.delete("code_challenge");
    noPkce.delete("code_challenge_method");
    const noPkceResponse = await req("/authorize?" + noPkce, {
      headers: { "x-test-owner": "yes" },
    });
    assert.equal(noPkceResponse.status, 302);
    assert.equal(
      new URL(noPkceResponse.headers.get("location")).searchParams.get("error"),
      "invalid_request",
    );
    const foreign = await parse(
      await req("/register", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          client_name: "Foreign",
          redirect_uris: ["http://127.0.0.1:5555/callback"],
          token_endpoint_auth_method: "none",
        }),
      }),
    );
    assert.equal(foreign.status, 201);
    const get = await req("/authorize?" + auth, { headers: { "x-test-owner": "yes" } });
    const html = await get.text();
    assert.equal(get.status, 200);
    assert.match(html, /things.read/);
    assert.doesNotMatch(html, /<li>things.create/);
    const handle = html.match(/name="handle" value="([^"]+)"/)[1];
    const cookie = get.headers.get("set-cookie").split(";")[0];
    const post = (cookieHeader) =>
      req("/authorize", {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          "x-test-owner": "yes",
          ...(cookieHeader ? { cookie: cookieHeader } : {}),
        },
        body: new URLSearchParams({ handle, decision: "approve" }),
      });
    assert.equal((await post(null)).status, 400);
    const approved = await post(cookie);
    assert.equal(approved.status, 200);
    assert.equal(approved.headers.get("location"), null);
    assert.equal(approved.headers.get("referrer-policy"), "no-referrer");
    const callbackHtml = await approved.text();
    const callbackTarget = JSON.parse(
      callbackHtml.match(/location\.replace\((".*")\)<\/script>/)[1],
    );
    assert.match(approved.headers.get("content-security-policy"), /script-src 'nonce-/);
    assert.equal((callbackHtml.match(/<script /g) ?? []).length, 1);
    const code = new URL(callbackTarget).searchParams.get("code");
    const token = async (fields) =>
      parse(
        await req("/oauth/token", {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ client_id: cid, ...fields }),
        }),
      );
    const wrong = await token({
      grant_type: "authorization_code",
      code,
      redirect_uri: "http://127.0.0.1:4444/callback",
      code_verifier: "y".repeat(43),
    });
    assert.equal(wrong.status, 400);
    const issued = await token({
      grant_type: "authorization_code",
      code,
      redirect_uri: "http://127.0.0.1:4444/callback",
      code_verifier: verifier,
    });
    assert.equal(issued.status, 200);
    assert.equal(issued.data.scope, "things.read");

    const rpc = async (access, name) =>
      req("/mcp", {
        method: "POST",
        headers: { authorization: "Bearer " + access, "content-type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name, arguments: {} },
        }),
      });
    assert.equal((await rpc(issued.data.access_token, "things_status")).status, 200);
    assert.equal((await rpc(issued.data.access_token, "things_create")).status, 403);
    const foreignRefresh = await token({
      client_id: foreign.data.client_id,
      grant_type: "refresh_token",
      refresh_token: issued.data.refresh_token,
    });
    assert.equal(foreignRefresh.status, 400);
    const foreignRevoke = await token({
      client_id: foreign.data.client_id,
      token: issued.data.refresh_token,
      token_type_hint: "refresh_token",
    });
    assert.equal(foreignRevoke.status, 200);
    assert.equal((await rpc(issued.data.access_token, "things_status")).status, 200);
    const refreshed = await token({
      grant_type: "refresh_token",
      refresh_token: issued.data.refresh_token,
    });
    assert.equal(refreshed.status, 200);
    const prior = await token({
      grant_type: "refresh_token",
      refresh_token: issued.data.refresh_token,
    });
    assert.equal(prior.status, 200);
    const repeatedPrevious = await token({
      grant_type: "refresh_token",
      refresh_token: issued.data.refresh_token,
    });
    assert.equal(repeatedPrevious.status, 200);
    // Provider 1.2.4 intentionally accepts the previous refresh token; repeating it keeps it previous.
    // This is measured overlap, not strict single-use rotation or replay detection.
    prior.data.refresh_token = repeatedPrevious.data.refresh_token;
    assert.equal((await rpc(refreshed.data.access_token, "things_status")).status, 200);
    const revoked = await token({
      token: prior.data.refresh_token ?? refreshed.data.refresh_token,
      token_type_hint: "refresh_token",
    });
    assert.equal(revoked.status, 200);
    assert.equal((await rpc(issued.data.access_token, "things_status")).status, 401);
    assert.equal((await rpc(refreshed.data.access_token, "things_status")).status, 401);
    const reuse = await token({
      grant_type: "authorization_code",
      code,
      redirect_uri: "http://127.0.0.1:4444/callback",
      code_verifier: verifier,
    });
    assert.equal(reuse.status, 400);
  } finally {
    await mf.dispose();
  }
});
