import { createServer, type IncomingMessage } from "node:http";
import { NodeStreamableHTTPServerTransport } from "@modelcontextprotocol/node";
import { fromJsonSchema, type JsonSchemaType, McpServer } from "@modelcontextprotocol/server";
import { binding, type Trust, verifyAssertion } from "./assertion.ts";
import { Fault } from "./contract.ts";
import type { Service } from "./service.ts";

const string: JsonSchemaType = { type: "string" };
const start: JsonSchemaType = {
  type: "string",
  pattern: "^[0-9]{4}-[0-9]{2}-[0-9]{2}$",
  description:
    "Scheduled start date, YYYY-MM-DD (1904–9999), in the timezone from things_capabilities. To put a task in Today, supply today's date in that timezone. Not a deadline. Omit to leave unchanged; clearing is unsupported.",
};
const schemas: Record<string, { properties: Record<string, JsonSchemaType>; required?: string[] }> =
  {
    things_status: { properties: {} },
    things_capabilities: { properties: {} },
    things_get: { properties: { id: string }, required: ["id"] },
    things_list: {
      properties: {
        scope: string,
        limit: { type: "integer", minimum: 1, maximum: 500 },
        cursor: string,
      },
    },
    things_create: {
      properties: { operationId: string, title: string, notes: string, start },
      required: ["operationId", "title"],
    },
    things_update: {
      properties: {
        operationId: string,
        id: string,
        expectedRevision: string,
        title: string,
        notes: { type: ["string", "null"] },
        start,
      },
      required: ["operationId", "id", "expectedRevision"],
    },
    things_set_status: {
      properties: {
        operationId: string,
        id: string,
        expectedRevision: string,
        status: { type: "string", enum: ["open", "completed"] },
      },
      required: ["operationId", "id", "expectedRevision", "status"],
    },
    things_operation_status: { properties: { operationId: string }, required: ["operationId"] },
  };
async function body(req: IncomingMessage) {
  const parts: Buffer[] = [];
  let size = 0;
  for await (const part of req) {
    const chunk = Buffer.from(part);
    size += chunk.length;
    if (size > 262144) throw new Fault("body_limit");
    parts.push(chunk);
  }
  return Buffer.concat(parts);
}
export function httpServer(
  service: Service,
  trust: Trust,
  hosts: string[],
  origins: string[],
  originPath = "/mcp",
) {
  const http = createServer(async (req, res) => {
    try {
      if (
        !hosts.includes(req.headers.host ?? "") ||
        (req.headers.origin && !origins.includes(req.headers.origin))
      ) {
        res.writeHead(403).end();
        return;
      }
      if (req.url !== originPath) {
        res.writeHead(404).end();
        return;
      }
      const raw = await body(req);
      const token = req.headers["x-things-grant"];
      if (typeof token !== "string") {
        res.writeHead(401, { "Cache-Control": "no-store" }).end();
        return;
      }
      const principal = await verifyAssertion(
        token,
        trust,
        binding(req.method ?? "", req.url, req.headers["content-type"] ?? "", raw),
      );
      let parsed: unknown;
      if (raw.length) {
        try {
          parsed = JSON.parse(raw.toString("utf8"));
        } catch {
          res.writeHead(400).end();
          return;
        }
      }
      if (Array.isArray(parsed)) {
        res.writeHead(400).end();
        return;
      }
      const mcp = new McpServer({ name: "things-mcp", version: "0.2.0" });
      for (const [name, schema] of Object.entries(schemas))
        mcp.registerTool(
          name,
          {
            description:
              name === "things_list"
                ? "List open Inbox tasks using a bounded ID snapshot; other scopes are not yet verified."
                : name === "things_update" || name === "things_set_status"
                  ? "Requires a fresh revision. Targets the specified task ID; recurrence rules are not edited."
                  : name,
            inputSchema: fromJsonSchema({ type: "object", additionalProperties: false, ...schema }),
            annotations: {
              readOnlyHint: !["things_create", "things_update", "things_set_status"].includes(name),
              destructiveHint: ["things_update", "things_set_status"].includes(name),
              idempotentHint: true,
              openWorldHint: false,
            },
          },
          async (args) => {
            try {
              const value = await service.call(name, args, principal);
              return { content: [{ type: "text", text: JSON.stringify(value) }] };
            } catch (error) {
              return {
                isError: true,
                content: [
                  {
                    type: "text",
                    text: JSON.stringify({
                      error: error instanceof Fault ? error.code : "unavailable",
                    }),
                  },
                ],
              };
            }
          },
        );
      const transport = new NodeStreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      await mcp.connect(transport);
      await transport.handleRequest(req, res, parsed);
      res.on("close", () => {
        void transport.close();
        void mcp.close();
      });
    } catch (error) {
      if (!res.headersSent)
        res
          .writeHead(error instanceof Fault && error.code === "body_limit" ? 413 : 401, {
            "Cache-Control": "no-store",
          })
          .end();
      else res.end();
    }
  });
  http.requestTimeout = 15000;
  http.headersTimeout = 10000;
  return http;
}
