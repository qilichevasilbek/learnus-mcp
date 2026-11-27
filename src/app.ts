/** The one MCP server agents connect to: LearnUS + 전자출결 tools, plus the shuttle. */
import { createLearnusServer } from "./learnus/index.js";
import { shuttleTools } from "./shuttle/index.js";

export function createServer() {
  return createLearnusServer(shuttleTools());
}
