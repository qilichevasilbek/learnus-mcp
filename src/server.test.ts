import test from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createLearnusServer } from "./learnus/index.js";

const EXPECTED = [
  "learnus_sync",
  "learnus_last_run",
  "learnus_courses",
  "learnus_announcements",
  "learnus_fetch_announcement",
  "learnus_fetch_url",
  "learnus_assignments",
  "learnus_materials",
  "learnus_calendar",
  "learnus_grades",
  "learnus_syllabus",
  "learnus_attendance",
  "portal_timetable",
];

async function connect() {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const server = createLearnusServer();
  await server.connect(serverSide);
  const client = new Client({ name: "test", version: "0.0.0" });
  await client.connect(clientSide);
  return { client, server };
}

test("an MCP client sees all thirteen tools with schemas", async () => {
  const { client, server } = await connect();
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((t) => t.name).sort(), [...EXPECTED].sort());
  for (const t of tools) {
    assert.ok(t.description && t.description.length > 40, `${t.name} has a description`);
    assert.equal(t.inputSchema.type, "object", `${t.name} has an object input schema`);
  }
  await client.close();
  await server.close();
});

test("a cache-reading tool answers over the protocol without a browser", async () => {
  const { client, server } = await connect();
  const result = await client.callTool({ name: "learnus_last_run", arguments: {} });
  const text = (result.content as Array<{ type: string; text: string }>)[0].text;
  assert.match(text, /Last sync|No sync has run yet/);
  await client.close();
  await server.close();
});
