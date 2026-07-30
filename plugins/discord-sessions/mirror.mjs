#!/usr/bin/env node
// Stop hook: mirror the turn's terminal text to the session's Discord channel.
// Deterministic safety net for the "info must not be lost in the terminal"
// rule — runs after every turn, no model cooperation needed.
//
// Skips when: the session has no channel binding, the turn already sent a
// Discord reply/ask_user (model communicated on its own), or the turn
// produced no text.
import { readFileSync, statSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'

const STATE_DIR = process.env.DISCORD_STATE_DIR ?? join(homedir(), '.claude', 'channels', 'discord')

let hook = {}
try {
  hook = JSON.parse(readFileSync(0, 'utf8'))
} catch {}
if (!hook.session_id || !hook.transcript_path) process.exit(0)

// Bound channel: last bind-log line for this session. Written by the plugin
// server on every (re)bind.
let channelName = null
try {
  const log = readFileSync(join(STATE_DIR, 'bind-log.txt'), 'utf8').trim().split('\n')
  for (let i = log.length - 1; i >= 0; i--) {
    if (!log[i].includes(hook.session_id)) continue
    const m = log[i].match(/bound to #(\S+)/)
    if (m) channelName = m[1]
    break
  }
} catch {}
if (!channelName) process.exit(0)

// Token + guild.
let token = null
try {
  for (const line of readFileSync(join(STATE_DIR, '.env'), 'utf8').split('\n')) {
    const m = line.match(/^DISCORD_BOT_TOKEN=(.*)$/)
    if (m) token = m[1].trim()
  }
} catch {}
let guildId = null
try {
  guildId = JSON.parse(readFileSync(join(STATE_DIR, 'channels.json'), 'utf8')).guildId ?? null
} catch {}
if (!token || !guildId) process.exit(0)

// Collect this turn's assistant text: walk the transcript backward until the
// last real user message (typed text or channel-injected, not tool results).
let lines = []
try {
  const p = hook.transcript_path
  const size = statSync(p).size
  const buf = readFileSync(p)
  lines = buf.slice(Math.max(0, size - 2 * 1024 * 1024)).toString('utf8').trim().split('\n')
} catch {
  process.exit(0)
}

const texts = []
let sawDiscordSend = false
let fromDiscord = false
for (let i = lines.length - 1; i >= 0; i--) {
  let rec
  try {
    rec = JSON.parse(lines[i])
  } catch {
    continue
  }
  if (rec.type === 'user') {
    const c = rec.message?.content
    const isReal =
      typeof c === 'string' ||
      (Array.isArray(c) && c.some(b => b.type === 'text') && !c.some(b => b.type === 'tool_result'))
    if (isReal) {
      // Surface separation: only Discord-originated turns get mirrored, as a
      // safety net when the model forgot to reply there. Terminal turns stay
      // in the terminal.
      const txt = typeof c === 'string' ? c : c.filter(b => b.type === 'text').map(b => b.text).join('\n')
      fromDiscord = /<channel[^>]*source="(plugin:)?discord/.test(txt)
      break
    }
    continue
  }
  if (rec.type !== 'assistant') continue
  for (const block of rec.message?.content ?? []) {
    if (block.type === 'text' && block.text?.trim()) texts.unshift(block.text.trim())
    if (block.type === 'tool_use' && /discord.*(reply|ask_user|edit_message|react)$/.test(block.name ?? '')) {
      sawDiscordSend = true
    }
  }
}
if (!fromDiscord || sawDiscordSend || texts.length === 0) process.exit(0)

const content = texts.join('\n\n')
if (!content.trim() || /^Replied on Discord\.?$/i.test(content.trim())) process.exit(0)

const api = async (path, init) => {
  const res = await fetch(`https://discord.com/api/v10${path}`, {
    ...init,
    headers: { Authorization: `Bot ${token}`, 'Content-Type': 'application/json' },
  })
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`)
  return res.json()
}

try {
  const channels = await api(`/guilds/${guildId}/channels`)
  const ch = channels.find(c => c.type === 0 && c.name === channelName)
  if (!ch) process.exit(0)
  // 🖥️ marks messages mirrored from the terminal transcript.
  const full = `🖥️ ${content}`
  for (let i = 0; i < full.length && i < 3 * 1900; i += 1900) {
    await api(`/channels/${ch.id}/messages`, {
      method: 'POST',
      body: JSON.stringify({ content: full.slice(i, i + 1900) }),
    })
  }
} catch (err) {
  process.stderr.write(`discord mirror: ${err}\n`)
}
