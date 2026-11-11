import { createHash } from "node:crypto";
export type Principal = { owner: string; client: string; grant: string; scopes: string[] };
export const scopes = ["things.read", "things.create", "things.update", "things.complete"];
export const required: Record<string, string[]> = {
  things_status: ["things.read"],
  things_capabilities: ["things.read"],
  things_list: ["things.read"],
  things_get: ["things.read"],
  things_create: ["things.create"],
  things_update: ["things.read", "things.update"],
  things_set_status: ["things.read", "things.complete"],
};
export class Fault extends Error {
  code: string;
  constructor(code: string) {
    super(code);
    this.code = code;
  }
}
export function authorize(p: Principal, needed: string[]) {
  if (!p.owner || !p.client || !p.grant || !needed.every((s) => p.scopes.includes(s)))
    throw new Fault("denied");
}
export function canonical(value: unknown): string {
  if (value === undefined) throw new Fault("invalid_argument");
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (value !== null && typeof value === "object")
    return (
      "{" +
      Object.keys(value)
        .sort()
        .map((k) => JSON.stringify(k) + ":" + canonical((value as Record<string, unknown>)[k]))
        .join(",") +
      "}"
    );
  return JSON.stringify(value);
}
export function hash(value: unknown) {
  return createHash("sha256").update(canonical(value)).digest("base64url");
}
export function revision(item: unknown, timezone: string, capabilityVersion: string) {
  return "v1:" + hash({ item, timezone, capabilityVersion });
}
export function uuid(value: unknown): asserts value is string {
  if (
    typeof value !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
  )
    throw new Fault("invalid_operation_id");
}
export function exact(value: unknown, keys: string[]): asserts value is Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).some((k) => !keys.includes(k))
  )
    throw new Fault("invalid_argument");
}
export function text(value: unknown, max = 1000, empty = false): asserts value is string {
  if (typeof value !== "string" || (!empty && !value.length) || value.length > max)
    throw new Fault("invalid_argument");
}
