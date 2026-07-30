# Syncing with the upstream plugin

This repo forks the official `discord` plugin from `claude-plugins-official`.

Fork base: **discord plugin 0.0.4** (discord.js 14.25). Everything we changed
in `server.ts` is fenced with `LOCAL PATCH` comment markers. The 9 patch
blocks:

1. Routing config + session discovery + `bindSessionChannel` (big block above `type PendingEntry`)
2. DM drop guard at the top of the `isDM` branch in `gate()`
3. Bound-channel delivery in the guild branch of `gate()`
4. Bound-channel allowance in `fetchAllowedChannel()`
5. `bind_channel` tool (ListTools entry + CallTool case)
6. `rebind` + 30s interval in the `ready` handler
7. Bound-channel permission prompts in the permission_request notification handler (DM fallback)
8. Owner-only guard on permission button interactions (`pendingPermissions.has` check), otherwise other sessions' instances race the owner
9. `ask_user` tool: clickable questions (buttons or modal form), answers injected back as inbound channel messages
10. Channel-creation offer: when a named session finds no matching channel, buttons in the fallback channel create + bind it (`offerChannelCreation` + `chan:` interaction listener + `create` option on `bind_channel`)

Other deltas vs upstream: `.mcp.json` runs `bootstrap.ts` directly (dependency
bootstrap + preserves the session cwd; upstream's `--cwd` flag hides it),
`hooks/hooks.json` + `session-map.mjs` (session-PID mapping hook), and skill
namespace renames (`/discord:access` -> `/discord-sessions:access`).

## Porting a new upstream version

1. Get the new upstream `server.ts` (from `~/.claude/plugins/cache/claude-plugins-official/discord/<new-version>/` after an update, or the upstream repo).
2. Diff it against the fork base version to see what upstream changed.
3. Apply upstream's changes onto our `server.ts` (or re-apply our 9 blocks onto their new file, whichever diff is smaller).
4. Update `package.json` dependencies if upstream bumped them, delete `bun.lock` stale entries by running `bun install` in the plugin dir, and update the fork base version in this file.
5. Bump the plugin version in `.claude-plugin/plugin.json`, commit, push. Users pick it up automatically.
