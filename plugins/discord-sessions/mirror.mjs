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
const discordSentTexts = []
let fromDiscord = false
let originChatId = null
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
      // safety net for anything the model wrote in the terminal but did not
      // send to the channel. Terminal turns stay in the terminal.
      const txt = typeof c === 'string' ? c : c.filter(b => b.type === 'text').map(b => b.text).join('\n')
      fromDiscord = /<channel[^>]*source="(plugin:)?discord/.test(txt)
      // Post where the conversation actually happened (thread or channel),
      // not to the bound channel name — a thread message must be mirrored
      // into its thread.
      originChatId = txt.match(/<channel[^>]*chat_id="(\d+)"/)?.[1] ?? null
      break
    }
    continue
  }
  if (rec.type !== 'assistant') continue
  for (const block of rec.message?.content ?? []) {
    if (block.type === 'text' && block.text?.trim()) texts.unshift(block.text.trim())
    if (block.type === 'tool_use' && /discord.*(reply|ask_user)$/.test(block.name ?? '')) {
      discordSentTexts.push(String(block.input?.text ?? block.input?.intro ?? ''))
    }
  }
}
if (!fromDiscord || texts.length === 0) process.exit(0)

// A reply during the turn no longer skips the whole mirror: interim
// narration between tool calls was landing only in the terminal. Mirror
// every block Discord did not get; a block counts as sent when its start
// appears in one of the turn's replies.
const sentBlob = discordSentTexts.join('\n')
const missing = texts.filter(t => {
  if (/^Replied on Discord\.?$/i.test(t)) return false
  return !(t.length >= 20 && sentBlob.includes(t.slice(0, 80)))
})
if (missing.length === 0) process.exit(0)

// Live mirroring: this script also runs on PostToolUse, so blocks stream to
// Discord as the turn progresses instead of arriving in a batch at the end.
// A rolling per-session state of already-mirrored block keys prevents
// re-posting the same block on the next hook invocation.
import { mkdirSync, writeFileSync } from 'fs'
const stateDir = join(STATE_DIR, 'mirror-state')
const stateFile = join(stateDir, `${hook.session_id}.json`)
let mirrored = []
try {
  mirrored = JSON.parse(readFileSync(stateFile, 'utf8'))
} catch {}
const keyOf = t => t.slice(0, 80)
const fresh = missing.filter(t => !mirrored.includes(keyOf(t)))
if (fresh.length === 0) process.exit(0)
try {
  mkdirSync(stateDir, { recursive: true })
  writeFileSync(stateFile, JSON.stringify([...mirrored, ...fresh.map(keyOf)].slice(-100)))
} catch {}
// Markdown tables don't render on Discord — convert to monospace blocks.
function mdTablesToAscii(text) {
  const src = text.split('\n')
  const out = []
  let i = 0
  while (i < src.length) {
    if (/^\s*\|.*\|\s*$/.test(src[i]) && i + 1 < src.length && /^\s*\|[\s:|-]+\|\s*$/.test(src[i + 1])) {
      const rows = []
      let j = i
      while (j < src.length && /^\s*\|.*\|\s*$/.test(src[j])) {
        if (!/^\s*\|[\s:|-]+\|\s*$/.test(src[j])) {
          rows.push(src[j].trim().replace(/^\||\|$/g, '').split('|').map(c => c.trim().replace(/\*\*/g, '')))
        }
        j++
      }
      const widths = []
      for (const r of rows) r.forEach((c, k) => { widths[k] = Math.max(widths[k] ?? 0, c.length) })
      const total = widths.reduce((a, b) => a + b, 0) + 2 * (widths.length - 1)
      if (total <= 60) {
        const fmt = r => r.map((c, k) => (c ?? '').padEnd(widths[k])).join('  ').trimEnd()
        out.push('```', fmt(rows[0]), widths.map(w => '-'.repeat(w)).join('  '), ...rows.slice(1).map(fmt), '```')
      } else {
        // Discord wraps long lines inside code blocks, which shreds wide
        // tables. Render one record per row instead — fits any screen width.
        const headers = rows[0]
        out.push('```')
        rows.slice(1).forEach((r, idx) => {
          if (idx > 0) out.push('')
          out.push(`▸ ${r[0]}`)
          for (let k = 1; k < r.length; k++) {
            if ((r[k] ?? '').trim()) out.push(`  ${headers[k]}: ${r[k]}`)
          }
        })
        out.push('```')
      }
      i = j
    } else {
      out.push(src[i])
      i++
    }
  }
  return out.join('\n')
}

const blocks = fresh.map(mdTablesToAscii).filter(t => t.trim())
if (blocks.length === 0) process.exit(0)

const api = async (path, init) => {
  const res = await fetch(`https://discord.com/api/v10${path}`, {
    ...init,
    headers: { Authorization: `Bot ${token}`, 'Content-Type': 'application/json' },
  })
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`)
  return res.json()
}

try {
  let targetId = originChatId
  if (!targetId) {
    const channels = await api(`/guilds/${guildId}/channels`)
    const ch = channels.find(c => c.type === 0 && c.name === channelName)
    if (!ch) process.exit(0)
    targetId = ch.id
  }
  // 🖥️ marks messages mirrored from the terminal transcript. Flag 4096 =
  // SUPPRESS_NOTIFICATIONS (@silent): these are progress notes, no ping.
  for (const block of blocks) {
    const full = `🖥️ ${block}`
    for (let i = 0; i < full.length && i < 3 * 1900; i += 1900) {
      await api(`/channels/${targetId}/messages`, {
        method: 'POST',
        body: JSON.stringify({ content: full.slice(i, i + 1900), flags: 4096 }),
      })
    }
  }
} catch (err) {
  process.stderr.write(`discord mirror: ${err}\n`)
}
