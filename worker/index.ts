import { createRemoteJWKSet, jwtVerify } from "jose";
import { handleWorkerRequest, type WorkerEnv } from "./oauth.ts";
import { bytes } from "./proxy.ts";
export default {
  async fetch(request: Request, env: WorkerEnv, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (url.origin !== env.PUBLIC_ORIGIN) return new Response(null, { status: 403 });
    const origin = request.headers.get("origin");
    if (origin && origin !== env.PUBLIC_ORIGIN) return new Response(null, { status: 403 });
    if (
      !(await env.PUBLIC_RATE.limit({ key: request.headers.get("cf-connecting-ip") ?? "unknown" }))
        .success
    )
      return new Response(null, { status: 429 });
    try {
      const raw = await bytes(request, url.pathname === "/mcp" ? 262144 : 32768);
      const bounded = new Request(request.url, {
        method: request.method,
        headers: request.headers,
        body: ["GET", "HEAD"].includes(request.method) ? undefined : raw,
      });
      return await handleWorkerRequest(bounded, env, ctx, {
        verifyAccess: async (req) => {
          const token = req.headers.get("cf-access-jwt-assertion");
          if (!token) return null;
          try {
            const { payload } = await jwtVerify(
              token,
              createRemoteJWKSet(new URL(env.ACCESS_ISSUER + "/cdn-cgi/access/certs")),
              { issuer: env.ACCESS_ISSUER, audience: env.ACCESS_AUD, algorithms: ["RS256"] },
            );
            return typeof payload.sub === "string" &&
              payload.sub === env.OWNER_SUBJECT &&
              payload.email === env.OWNER_EMAIL
              ? { userId: payload.sub, email: env.OWNER_EMAIL }
              : null;
          } catch {
            return null;
          }
        },
      });
    } catch (error) {
      return Response.json(
        {
          error:
            error instanceof Error && error.message === "body_limit" ? "body_limit" : "unavailable",
        },
        {
          status: error instanceof Error && error.message === "body_limit" ? 413 : 503,
          headers: { "Cache-Control": "no-store" },
        },
      );
    }
  },
};
