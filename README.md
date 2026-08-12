# claude-discord-sessions

Talk to each of your Claude Code sessions in its own Discord channel.

Rename a session "Library SSR" and it answers in `#library-ssr` of your private Discord server. Permission prompts show up as Allow/Deny buttons in the channel. Multiple-choice questions (plan approvals, config decisions) render as clickable buttons or popup forms. Your phone pings when a long task finishes.

This is a fork of the official `discord` plugin for Claude Code (Apache-2.0, by Anthropic), extended with per-session channel routing.

## What you get

- **One channel per session.** Session name = channel name (lowercase, spaces become dashes). No matching channel: the session answers in `#general`. Rename a session with `/rename` and it moves to the new channel within 30 seconds.
- **No @mention needed** in a session's own channel, and messages in a channel reach only the session bound to it.
- **Permission prompts in the channel** with Allow / Deny / See more buttons (instead of DM spam).
- **Readable tables.** Markdown tables ship as a `message.txt` attachment drawn in box characters, cells word-wrapped and capped at 62 columns so they stay readable on a phone.
- **Quote-reply context.** Reply to one of the bot's messages and the session sees which message you answered, with its text.
- **Clickable questions.** Claude asks multiple-choice questions with colored buttons, or a popup form with dropdowns and a free-text field for multi-question cases. You can always type a custom answer instead.
- **Manual rebinding.** Tell a session "talk in #x" (the `bind_channel` tool), or set `DISCORD_CHANNEL=x` when launching.
- **Missing channel? One click.** When a named session finds no matching channel, it offers in the fallback channel to create it and bind (needs the Manage Channels bot permission). You can also say "talk in #x, create it".
- **Always-on watcher (optional).** A tiny autostart process keeps the bot online with zero sessions open: message a channel and a hidden session wakes for it (resuming its conversation), then shuts down after 30 idle minutes. Terminal sessions always take priority. Windows tested; Linux/macOS support shipped via `install-watcher.sh` (systemd/launchd), not yet field-tested.
- **Watcher slash commands.** `/help`, `/sessions`, `/status`, `/logs`, `/usage` (plan limits, also shown permanently in the bot's status), `/skill` (searchable skill runner), `/kill` (emergency stop, nothing lost), `/killall`, `/restart`, `/open`/`/hide` (show a background session's live terminal on the PC), `/model` (per-channel model switch), `/rename-bot` (bot nickname), `/update`.

## Requirements

- Claude Code with `node` on PATH (you have this) and [bun](https://bun.sh) (`curl -fsSL https://bun.sh/install | bash`, or on Windows `powershell -c "irm bun.sh/install.ps1 | iex"`)
- Windows or Linux (macOS should work but is untested)
- A Discord account

## Install

**1. Create your bot** at https://discord.com/developers/applications:
- New Application, then in the **Bot** tab: Reset Token and copy it (keep it secret), and enable **MESSAGE CONTENT INTENT** (required).

**2. Create a private Discord server** (just for you). Keep `#general`, create one channel per project as needed (lowercase, dashes). Invite the bot: **OAuth2 > URL Generator**, scope `bot`, permissions: View Channels, Send Messages, Read Message History, Add Reactions, Manage Channels (optional, lets the bot create missing session channels for you). Open the generated URL.

**3. Install the plugin** in Claude Code:

```
/plugin marketplace add Ashr4f/claude-discord-sessions
/plugin install discord-sessions@claude-discord-sessions
```

If you use the official `discord` plugin, disable it (`/plugin`) — running both doubles every connection.

**4. Allow the plugin to deliver messages.** Claude Code only lets plugins on its default allowlist push inbound messages, and third-party plugins are not on it — without this step the bot can talk but never hears you. Add to `~/.claude/settings.json`:

```json
{
  "channelsEnabled": true,
  "allowedChannelPlugins": [
    { "marketplace": "claude-discord-sessions", "plugin": "discord-sessions" }
  ]
}
```

Note: `allowedChannelPlugins` replaces the default allowlist. If you also use other channel plugins (telegram, etc.), list them here too.

**5. Save your bot token:** create `~/.claude/channels/discord/.env` containing:

```
DISCORD_BOT_TOKEN=your-token-here
```

**6. Configure your server id:** create `~/.claude/channels/discord/channels.json`:

```json
{
  "guildId": "your-discord-server-id",
  "fallback": "general",
  "dmMode": "off",
  "map": {}
}
```

(Server id: enable Developer Mode in Discord settings, right-click your server, Copy Server ID. Without this file the plugin behaves like the stock DM-based plugin.)

**7. Pair and test:** restart Claude Code, DM the bot once, it replies with a code, then run `/discord-sessions:access pair <code>` in Claude Code. Rename a session (`/rename my project`), create `#my-project`, type one prompt in the session, wait 30s, and message the channel.

## Rules of thumb

- A brand-new or freshly resumed session binds only after you type one prompt in it (its transcript must exist).
- Keep session names unique: two sessions with the same name both answer in the same channel.
- Debugging: `~/.claude/channels/discord/bind-log.txt` records which session bound to which channel. Claude Code discards MCP server stderr, so this file is the visibility.

## Configuration reference (`~/.claude/channels/discord/channels.json`)

| Key | Meaning |
|-----|---------|
| `guildId` | Your private server's id. Enables routing. |
| `fallback` | Channel for sessions with no matching channel (default `general`). |
| `dmMode` | `off` (default): DMs are not delivered as chat. `on`: keep DM delivery. |
| `map` | Optional overrides: `{ "C:/path/to/project": "channel-name" }` binds by directory instead of session name. |

## How it works

Every Claude Code session spawns its own instance of the plugin's MCP server, all sharing your bot. Each instance figures out which session owns it: a SessionStart hook records the session id and transcript path keyed by the Claude process PID; the server walks its parent-PID chain to find that file, then reads the session's `/rename` title from the transcript. Slugified title = channel name. Each instance then delivers only its own channel's messages and drops everything else.

Binding priority: `DISCORD_CHANNEL` env var > session title > `map` entry for the project directory > project folder name > `fallback`.

## Updating

The plugin auto-updates on Claude Code startup like any marketplace plugin. To sync new features from Anthropic's upstream `discord` plugin into this fork, see [UPSTREAM.md](UPSTREAM.md).

## Security

- Only your paired Discord account can trigger the session or click permission/question buttons.
- The plugin pre-approves its own Discord tools (reply, react, ask_user, ...) via a bundled PreToolUse hook, so Claude never prompts you for permission just to answer you on Discord. This covers only this plugin's tools, nothing else.
- Anything posted in an opted-in channel by others is treated as untrusted; the plugin refuses access-control changes requested from Discord itself.
- The bot token lives only on your machine (`.env`), never in this repo.

## License

Apache-2.0. Based on the [official Discord channel plugin](https://github.com/anthropics/claude-plugins-official) by Anthropic; all modifications are fenced with `LOCAL PATCH` markers in `server.ts`. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
