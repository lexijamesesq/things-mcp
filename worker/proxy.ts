import { importJWK, SignJWT } from "jose";
import type { WorkerEnv } from "./oauth.ts";
export type Grant = { owner: string; client: string; grant: string; scopes: string[] };
export const toolScopes: Record<string, string[]> = {
  things_status: ["things.read"],
  things_capabilities: ["things.read"],
  things_list: ["things.read"],
  things_get: ["things.read"],
  things_create: ["things.create"],
  things_update: ["things.read", "things.update"],
  things_set_status: ["things.read", "things.complete"],
  things_operation_status: [],
};
export async function bytes(request: Request, limit: number) {
  const reader = request.body?.getReader();
  if (!reader) return new Uint8Array();
  const parts: Uint8Array[] = [];
  let length = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.length;
    if (length > limit) {
      await reader.cancel();
      throw new Error("body_limit");
    }
    parts.push(value);
  }
  const output = new Uint8Array(length);
  let at = 0;
  for (const part of parts) {
    output.set(part, at);
    at += part.length;
  }
  return output;
}
export async function forward(
  request: Request,
  env: WorkerEnv,
  grant: Grant,
  fetcher: typeof fetch,
): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname !== "/mcp" || url.search) return new Response(null, { status: 404 });
  if (!(await env.OWNER_RATE.limit({ key: grant.owner })).success)
    return new Response(null, { status: 429 });
  const raw = await bytes(request, 262144);
  if (request.method === "POST") {
    let rpc: unknown;
    try {
      rpc = JSON.parse(new TextDecoder().decode(raw));
    } catch {
      return new Response(null, { status: 400 });
    }
    if (!rpc || Array.isArray(rpc) || typeof rpc !== "object")
      return new Response(null, { status: 400 });
    if ("method" in rpc && rpc.method === "tools/call") {
      const params = "params" in rpc ? rpc.params : null;
      const name =
        params && typeof params === "object" && "name" in params ? params.name : undefined;
      if (
        typeof name !== "string" ||
        !Object.hasOwn(toolScopes, name) ||
        !toolScopes[name].every((s) => grant.scopes.includes(s))
      )
        return new Response(null, { status: 403 });
    }
  }
  const contentType = (request.headers.get("content-type") ?? "").trim().toLowerCase();
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", raw));
  const bodySha256 = btoa(String.fromCharCode(...digest))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
  const assertion = await new SignJWT({
    client: grant.client,
    grant: grant.grant,
    scopes: grant.scopes,
    binding: {
      method: request.method.toUpperCase(),
      path: env.ORIGIN_PATH,
      contentType,
      bodySha256,
    },
  })
    .setProtectedHeader({ alg: "EdDSA", kid: env.SIGNING_KID })
    .setIssuer(env.PUBLIC_ORIGIN)
    .setAudience(env.STUDIO_AUDIENCE)
    .setSubject(grant.owner)
    .setIssuedAt()
    .setExpirationTime("30s")
    .sign(await importJWK(JSON.parse(env.SIGNING_JWK), "EdDSA"));
  const headers = new Headers();
  for (const name of [
    "accept",
    "content-type",
    "mcp-protocol-version",
    "mcp-client-info",
    "origin",
  ]) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }
  headers.set("x-things-grant", assertion);
  headers.set("CF-Access-Client-Id", env.CF_ACCESS_CLIENT_ID);
  headers.set("CF-Access-Client-Secret", env.CF_ACCESS_CLIENT_SECRET);
  // One attempt; no redirect following and no mutation retry on network errors.
  return fetcher(env.PUBLIC_ORIGIN + env.ORIGIN_PATH, {
    method: request.method,
    headers,
    body: ["GET", "HEAD"].includes(request.method) ? undefined : raw,
    redirect: "manual",
    signal: AbortSignal.timeout(30000),
  });
}
