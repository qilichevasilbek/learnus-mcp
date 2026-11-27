/** The one MCP server agents connect to: LearnUS + 전자출결 tools, the shuttle, and dorm seminar rooms. */
import { createLearnusServer } from "./learnus/index.js";
import { shuttleTools } from "./shuttle/index.js";
import { seminarRoomTools } from "./dorm/index.js";

export function createServer() {
  return createLearnusServer([...shuttleTools(), ...seminarRoomTools()]);
}
