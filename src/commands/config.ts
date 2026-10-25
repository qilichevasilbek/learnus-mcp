/** `learnus-mcp config` — copy-paste snippets for registering the server with an agent. */
import { HOME_DIR } from "../learnus/config.js";
import { SERVER_JS } from "./paths.js";

const claudeDesktopPath = () =>
  process.platform === "darwin"
    ? "~/Library/Application Support/Claude/claude_desktop_config.json"
    : process.platform === "win32"
      ? "%APPDATA%\\Claude\\claude_desktop_config.json"
      : "~/.config/Claude/claude_desktop_config.json";

export function configCommand(): void {
  const js = SERVER_JS;
  console.log(`No password goes in these snippets: run \`node ${js} login\` once and the server reads it
from your OS keystore. Cache and session files live in ${HOME_DIR}.

── Claude Code ──────────────────────────────────────────────
claude mcp add learnus --scope user -- node "${js}"

── Claude Desktop (${claudeDesktopPath()}) ──
{
  "mcpServers": {
    "learnus": { "command": "node", "args": ["${js.replace(/\\/g, "\\\\")}"] }
  }
}

── Cline / Cursor (their MCP settings JSON) ─────────────────
{
  "mcpServers": {
    "learnus": { "command": "node", "args": ["${js.replace(/\\/g, "\\\\")}"] }
  }
}

── Codex (~/.codex/config.toml) ─────────────────────────────
[mcp_servers.learnus]
command = "node"
args = ["${js.replace(/\\/g, "\\\\")}"]

If your agent runs somewhere with no keystore (a server, a container), pass YONSEI_ID and
YONSEI_PW in the "env" block instead.`);
}
