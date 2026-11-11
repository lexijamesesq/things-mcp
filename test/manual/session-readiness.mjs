// Explicit bounded lifecycle observation; never launches Things or sends task events.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { verifyLock } from "../../src/lock.ts";
import { Native } from "../../src/native.ts";

const config = JSON.parse(readFileSync(process.argv[2], "utf8"));
verifyLock(
  join(dirname(config.nativePath), "Things MCP"),
  join(dirname(config.journal), "executor.lock"),
);
const native = new Native(config.nativePath);
const observations = [];
for (let i = 0; i < 35; i++) {
  const reply = await native.call({ operation: "status" });
  observations.push({
    at: new Date().toISOString(),
    ok: reply.ok,
    error: reply.error ?? null,
    dispatched: reply.dispatched,
  });
  if (reply.dispatched) throw new Error("Status unexpectedly dispatched a task event");
  await new Promise((resolve) => setTimeout(resolve, 1000));
}
console.log(
  JSON.stringify({
    observations,
    lockedSessionDenied: observations.some((x) => x.error === "owner_session_unavailable"),
    availableObserved: observations.some((x) => x.ok),
  }),
);
