/**
 * The thin seam between the tool definitions in ./learnus and the MCP SDK.
 *
 * `tool(name, description, zodShape, handler)` has the same shape the tools
 * were originally written against, so the 13 definitions did not change; this
 * file turns them into a standard `McpServer` that any MCP client can use.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { z } from "zod";

export type ToolShape = Record<string, z.ZodTypeAny>;

export interface ToolResult {
  [key: string]: unknown;
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}

export interface ToolDefinition<S extends ToolShape = ToolShape> {
  name: string;
  description: string;
  shape: S;
  handler: (args: z.infer<z.ZodObject<S>>) => Promise<ToolResult>;
}

export function tool<S extends ToolShape>(
  name: string,
  description: string,
  shape: S,
  handler: (args: z.infer<z.ZodObject<S>>) => Promise<ToolResult>
): ToolDefinition<S> {
  return { name, description, shape, handler };
}

export function createMcpServer(options: {
  name: string;
  version: string;
  tools: ToolDefinition<any>[];
}): McpServer {
  const server = new McpServer({ name: options.name, version: options.version });
  for (const def of options.tools) {
    server.registerTool(
      def.name,
      { description: def.description, inputSchema: def.shape },
      async (args: any) => {
        try {
          return await def.handler(args);
        } catch (err) {
          // A thrown scraper error must reach the agent as a tool error, not
          // tear down the transport.
          const message = err instanceof Error ? err.message : String(err);
          return { content: [{ type: "text" as const, text: `Error: ${message}` }], isError: true };
        }
      }
    );
  }
  return server;
}
