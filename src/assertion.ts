import { createHash } from "node:crypto";
import { importJWK, type JWK, jwtVerify } from "jose";
import { exact, Fault, type Principal, scopes } from "./contract.ts";
export type Trust = { issuer: string; audience: string; owner: string; keys: Record<string, JWK> };
export function binding(method: string, path: string, contentType: string, body: Uint8Array) {
  return {
    method: method.toUpperCase(),
    path,
    contentType: contentType.trim().toLowerCase(),
    bodySha256: createHash("sha256").update(body).digest("base64url"),
  };
}
export async function verifyAssertion(
  token: string,
  trust: Trust,
  request: ReturnType<typeof binding>,
): Promise<Principal> {
  try {
    const verified = await jwtVerify(
      token,
      async (header) => {
        if (header.alg !== "EdDSA" || !header.kid || !Object.hasOwn(trust.keys, header.kid))
          throw new Fault("denied");
        return importJWK(trust.keys[header.kid], "EdDSA");
      },
      {
        algorithms: ["EdDSA"],
        issuer: trust.issuer,
        audience: trust.audience,
        clockTolerance: 5,
        requiredClaims: ["iat", "exp", "sub", "client", "grant", "scopes", "binding"],
      },
    );
    const p = verified.payload;
    exact(p, ["iss", "aud", "sub", "iat", "exp", "client", "grant", "scopes", "binding"]);
    if (
      p.sub !== trust.owner ||
      typeof p.iat !== "number" ||
      typeof p.exp !== "number" ||
      p.exp - p.iat > 30 ||
      p.exp <= p.iat ||
      p.iat > Date.now() / 1000 + 5 ||
      typeof p.client !== "string" ||
      !p.client ||
      typeof p.grant !== "string" ||
      !p.grant ||
      !Array.isArray(p.scopes) ||
      !p.scopes.every((s) => typeof s === "string" && scopes.includes(s))
    )
      throw new Fault("denied");
    exact(p.binding, ["method", "path", "contentType", "bodySha256"]);
    const bound = p.binding as Record<string, unknown>;
    if (Object.entries(request).some(([k, v]) => bound[k] !== v)) throw new Fault("denied");
    return { owner: p.sub, client: p.client, grant: p.grant, scopes: p.scopes as string[] };
  } catch {
    throw new Fault("denied");
  }
}
