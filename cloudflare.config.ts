import { bindings, defineConfig, triggers } from "cf/config";
export default defineConfig({
  accountId: process.env.THINGS_CF_ACCOUNT_ID,
  worker: {
    name: "things-mcp",
    entrypoint: "./worker/index.ts",
    compatibilityDate: "2026-11-10",
    compatibilityFlags: ["global_fetch_strictly_public"],
    workersDev: false,
    previewUrls: false,
    observability: { enabled: true, redactQueryString: true, traces: { enabled: true } },
    triggers: ["/mcp*", "/authorize*", "/oauth/*", "/register*", "/.well-known/*"].map((path) =>
      triggers.fetch({
        pattern: `${process.env.THINGS_PUBLIC_HOST ?? "things.example.com"}${path}`,
        zone: process.env.THINGS_CF_ZONE ?? "example.com",
      }),
    ),
    env: {
      OAUTH_KV: bindings.kv({
        id: process.env.THINGS_OAUTH_KV_ID ?? "00000000000000000000000000000000",
      }),
      PUBLIC_ORIGIN: bindings.json(
        `https://${process.env.THINGS_PUBLIC_HOST ?? "things.example.com"}`,
      ),
      ORIGIN_PATH: bindings.json("/_origin/mcp"),
      OWNER_EMAIL: bindings.json(process.env.THINGS_OWNER_EMAIL ?? "owner@example.com"),
      ACCESS_ISSUER: bindings.json(
        process.env.THINGS_ACCESS_ISSUER ?? "https://example.cloudflareaccess.com",
      ),
      ACCESS_AUD: bindings.secret(),
      OWNER_SUBJECT: bindings.secret(),
      SIGNING_JWK: bindings.secret(),
      SIGNING_KID: bindings.json("2026-11-10-a"),
      STUDIO_AUDIENCE: bindings.json("things-mcp-studio"),
      CF_ACCESS_CLIENT_ID: bindings.secret(),
      CF_ACCESS_CLIENT_SECRET: bindings.secret(),
      PUBLIC_RATE: bindings.rateLimit({ namespace: "1001", simple: { limit: 60, period: 60 } }),
      OWNER_RATE: bindings.rateLimit({ namespace: "1002", simple: { limit: 60, period: 60 } }),
    },
  },
});
