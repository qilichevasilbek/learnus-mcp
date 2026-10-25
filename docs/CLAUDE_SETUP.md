# Setting up with Claude (Code and Desktop)

This is the same arrangement the Alice assistant uses: the agent gets real tools for LearnUS, and a short
instruction file tells it how to use them well.

## 1. Install and sign in

```bash
git clone https://github.com/qilichevasilbek/learnus-mcp.git
cd learnus-mcp
./scripts/setup.sh        # macOS / Linux
# Windows:  npm install && npm run build && npm run setup
```

The guided setup walks through six steps and asks before each change:

1. creates the folders under `~/.learnus-mcp` (see [Folders](../README.md#folders))
2. installs the browser the scraper drives
3. signs you in (saved securely, or by hand in a browser window)
4. registers the tools with Claude Code
5. installs the Claude skill (step 3 below)
6. fills the cache for the first time

Re-run `npm run doctor` at any point to see what is working and the exact command for anything that is not.

## 2. Connect the tools

**Claude Code** — setup does this for you. By hand:

```bash
claude mcp add learnus --scope user -- node /absolute/path/to/learnus-mcp/dist/server.js
```

`--scope user` makes the tools available in every project. Use `--scope project` to share it through a checked-in
`.mcp.json` (see `.mcp.json.example`); don't put your password in that file — it isn't needed.

**Claude Desktop** — run `node dist/server.js config` for a snippet with your real path, and paste it into
`claude_desktop_config.json`:

| OS | File |
|----|------|
| macOS | `~/Library/Application Support/Claude/claude_desktop_config.json` |
| Windows | `%APPDATA%\Claude\claude_desktop_config.json` |
| Linux | `~/.config/Claude/claude_desktop_config.json` |

Restart Claude after editing. Tools appear as `learnus_*` and `portal_timetable`.

## 3. Teach Claude how to use them

The tools work without it, but the skill in [`examples/claude-skill/SKILL.md`](../examples/claude-skill/SKILL.md)
encodes lessons learned the hard way: read the cache instead of re-scraping, check both assignments *and* calendar
for deadlines, treat the attendance portal as authoritative, and never say "it isn't on LearnUS" without checking.
Setup installs it to `~/.claude/skills/learnus/`; to do it by hand:

```bash
mkdir -p ~/.claude/skills/learnus
cp examples/claude-skill/SKILL.md ~/.claude/skills/learnus/SKILL.md
```

Prefer a single always-on instruction instead of a skill? Paste the body of that file into your `CLAUDE.md`.

## 4. Try it

Ask Claude: *"What's due this week?"*, *"How am I doing in my courses?"*, *"Can I skip tomorrow's class?"*

## Staying signed in

| You chose | What happens |
|-----------|--------------|
| Saved ID + password | The session renews itself whenever it expires. Credentials live in the macOS Keychain or Linux keyring, else a `0600` file. |
| Browser sign-in | A session lasts about 4 hours. After that, run `npm run login -- --browser` again, or switch to a saved login. |

Keep the cache fresh with a schedule, e.g. cron: `0 */4 * * * cd /path/to/learnus-mcp && node dist/server.js sync`.
