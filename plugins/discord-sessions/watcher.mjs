#!/usr/bin/env bun
/**
 * Wake-on-message watcher for per-session Discord routing.
 *
 * Tiny always-on process (Task Scheduler, at logon) that holds a Discord
 * gateway connection so the bot is online whenever the PC is on/locked.
 * When a message lands in a channel that no live Claude session owns, it
 * wakes one:
 *   - a session with a matching name exists on disk  -> resume it in its folder
 *   - new channel + first message contains a path    -> new session in that folder
 *   - no path                                        -> new session in defaultDir
 * The triggering message is spooled to pending/<channelId>.json; the woken
 * session's MCP server delivers it after binding. Live sessions register in
 * live/<pid>.json (written by the patched server.ts) — the watcher never
 * spawns over a live one, so terminal sessions keep priority.
 *
 * Control commands (allowlisted user, any watched channel):
 *   !killall   kill every background session the watcher spawned
 *   !sessions  list live sessions (terminal + background)
 *
 * Idle background sessions are killed after idleMinutes (watcher.json).
 */

import { createRequire } from 'module'
import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  readdirSync,
  statSync,
  rmSync,
  existsSync,
  openSync,
  readSync,
  closeSync,
  appendFileSync,
} from 'fs'
import { homedir } from 'os'
import { join, basename } from 'path'
import { execFileSync, spawn } from 'child_process'

const HOME = homedir()
const STATE_DIR = process.env.DISCORD_STATE_DIR ?? join(HOME, '.claude', 'channels', 'discord')
const LIVE_DIR = join(STATE_DIR, 'live')
const SPOOL_DIR = join(STATE_DIR, 'pending')
const PROJECTS_DIR = join(HOME, '.claude', 'projects')
const CONFIG_FILE = join(STATE_DIR, 'watcher.json')
const STATE_FILE = join(STATE_DIR, 'watcher-state.json')
const LOG_FILE = join(STATE_DIR, 'watcher-log.txt')
const LOCK_FILE = join(STATE_DIR, 'watcher.lock')

function log(s) {
  const line = `${new Date().toISOString()} ${s}\n`
  try {
    if (existsSync(LOG_FILE) && statSync(LOG_FILE).size > 2 * 1024 * 1024) rmSync(LOG_FILE)
  } catch {}
  try {
    appendFileSync(LOG_FILE, line)
  } catch {}
  process.stderr.write(line)
}

function readJson(f, fallback) {
  try {
    return JSON.parse(readFileSync(f, 'utf8'))
  } catch {
    return fallback
  }
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

// ── single instance ─────────────────────────────────────────────────────────
{
  const lock = readJson(LOCK_FILE, null)
  if (lock && lock.pid !== process.pid && pidAlive(lock.pid)) {
    process.stderr.write(`watcher already running (pid ${lock.pid}), exiting\n`)
    process.exit(0)
  }
  writeFileSync(LOCK_FILE, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }))
}

// ── config / access / routing ───────────────────────────────────────────────
const config = { idleMinutes: 30, defaultDir: HOME, ...readJson(CONFIG_FILE, {}) }
const routing = readJson(join(STATE_DIR, 'channels.json'), {})
const access = readJson(join(STATE_DIR, 'access.json'), {})
const allowFrom = access.allowFrom ?? []

let TOKEN = process.env.DISCORD_BOT_TOKEN
if (!TOKEN) {
  const env = readFileSync(join(STATE_DIR, '.env'), 'utf8')
  TOKEN = env.match(/^DISCORD_BOT_TOKEN=(.+)$/m)?.[1]?.trim()
}
if (!TOKEN) {
  log('no DISCORD_BOT_TOKEN, exiting')
  process.exit(1)
}

// ── discord.js from the official plugin's node_modules ─────────────────────
function pluginDir() {
  const base = join(HOME, '.claude', 'plugins', 'cache', 'claude-plugins-official', 'discord')
  const versions = readdirSync(base).filter(v => existsSync(join(base, v, 'node_modules', 'discord.js')))
  if (versions.length === 0) throw new Error('official discord plugin cache not found')
  versions.sort((a, b) => statSync(join(base, b)).mtimeMs - statSync(join(base, a)).mtimeMs)
  return join(base, versions[0])
}
const requirePlugin = createRequire(join(pluginDir(), 'noop.js'))
const { Client, GatewayIntentBits, Partials } = requirePlugin('discord.js')

// ── claude executable ───────────────────────────────────────────────────────
function findClaude() {
  try {
    const out = execFileSync('where.exe', ['claude'], { encoding: 'utf8' })
    const line = out.split(/\r?\n/).find(l => l.trim())
    if (line) return line.trim()
  } catch {}
  throw new Error('claude executable not found on PATH')
}
const CLAUDE_EXE = findClaude()

// ── helpers shared with server.ts (keep in sync) ────────────────────────────
function slugify(s) {
  return s
    .toLowerCase()
    .trim()
    .replace(/[\s\/\\#@:*?"<>|]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '')
}

function readTail(file, bytes) {
  const fd = openSync(file, 'r')
  try {
    const size = statSync(file).size
    const len = Math.min(bytes, size)
    const buf = Buffer.alloc(len)
    readSync(fd, buf, 0, len, size - len)
    return buf.toString('utf8')
  } finally {
    closeSync(fd)
  }
}

function readHead(file, bytes) {
  const fd = openSync(file, 'r')
  try {
    const size = statSync(file).size
    const len = Math.min(bytes, size)
    const buf = Buffer.alloc(len)
    readSync(fd, buf, 0, len, 0)
    return buf.toString('utf8')
  } finally {
    closeSync(fd)
  }
}

// ── persisted state: spawned sessions + transcript index cache ─────────────
const state = { spawned: {}, index: {}, ...readJson(STATE_FILE, {}) }
let saveTimer = null
function saveState() {
  if (saveTimer) return
  saveTimer = setTimeout(() => {
    saveTimer = null
    try {
      writeFileSync(STATE_FILE, JSON.stringify(state))
    } catch {}
  }, 500)
}

// Adopt-or-drop spawned entries from a previous watcher run.
for (const [cid, s] of Object.entries(state.spawned)) {
  if (!pidAlive(s.pid)) delete state.spawned[cid]
}
saveState()

// ── session index: every transcript on the PC -> {title, cwd, sessionId} ───
function indexSessions() {
  const seen = new Set()
  let dirs = []
  try {
    dirs = readdirSync(PROJECTS_DIR)
  } catch {
    return []
  }
  for (const d of dirs) {
    const dir = join(PROJECTS_DIR, d)
    let files = []
    try {
      files = readdirSync(dir).filter(f => f.endsWith('.jsonl'))
    } catch {
      continue
    }
    for (const f of files) {
      const p = join(dir, f)
      seen.add(p)
      let st
      try {
        st = statSync(p)
      } catch {
        continue
      }
      const cached = state.index[p]
      if (cached && cached.mtimeMs === st.mtimeMs) continue
      let title = null
      let cwd = null
      try {
        const tail = readTail(p, 4 * 1024 * 1024)
        const titles = [...tail.matchAll(/"type":"custom-title","customTitle":"((?:[^"\\]|\\.)*)"/g)]
        if (titles.length > 0) title = JSON.parse(`"${titles[titles.length - 1][1]}"`)
        const head = readHead(p, 64 * 1024)
        const cm = head.match(/"cwd":"((?:[^"\\]|\\.)*)"/)
        if (cm) cwd = JSON.parse(`"${cm[1]}"`)
      } catch {}
      state.index[p] = { mtimeMs: st.mtimeMs, title, cwd, sessionId: basename(f, '.jsonl') }
    }
  }
  for (const p of Object.keys(state.index)) if (!seen.has(p)) delete state.index[p]
  saveState()
  return Object.values(state.index)
}

function findSessionByName(channelName) {
  const hits = Object.entries(state.index)
    .filter(([, e]) => e.title && slugify(e.title) === channelName && e.cwd && existsSync(e.cwd))
    .sort(([, a], [, b]) => b.mtimeMs - a.mtimeMs)
  return hits.length > 0 ? hits[0][1] : null
}

// ── ownership: is some live session already bound to this channel? ─────────
function channelOwned(channelId, channelName) {
  let owned = false
  let files = []
  try {
    files = readdirSync(LIVE_DIR).filter(f => f.endsWith('.json'))
  } catch {}
  for (const f of files) {
    const p = join(LIVE_DIR, f)
    const entry = readJson(p, null)
    if (!entry) continue
    if (!pidAlive(entry.pid)) {
      try {
        rmSync(p)
      } catch {}
      continue
    }
    if (entry.channelId === channelId) owned = true
  }
  if (owned) return true
  // Fallback for sessions started before the live-registry patch: their
  // server only appended to bind-log.txt. Latest bind per pid, pid alive.
  if (channelName) {
    try {
      const tail = readTail(join(STATE_DIR, 'bind-log.txt'), 64 * 1024)
      const byPid = new Map()
      for (const m of tail.matchAll(/pid=(\d+) discord channel: session \S+ bound to #(\S+)/g)) {
        byPid.set(Number(m[1]), m[2])
      }
      for (const [pid, name] of byPid) {
        if (name === channelName && pidAlive(pid)) return true
      }
    } catch {}
  }
  return false
}

// ── spool: messages the woken session must answer once bound ───────────────
function spoolMessage(channelId, msg) {
  try {
    mkdirSync(SPOOL_DIR, { recursive: true })
    const f = join(SPOOL_DIR, `${channelId}.json`)
    const cur = readJson(f, { messages: [] })
    if (!cur.messages.some(m => m.messageId === msg.id)) {
      cur.messages.push({ chatId: msg.channelId, messageId: msg.id })
    }
    writeFileSync(f, JSON.stringify(cur))
  } catch (err) {
    log(`spool failed for ${channelId}: ${err}`)
  }
}

// Stale spools from before a reboot must not wake sessions for old messages.
try {
  for (const f of readdirSync(SPOOL_DIR)) {
    const p = join(SPOOL_DIR, f)
    if (Date.now() - statSync(p).mtimeMs > 30 * 60 * 1000) rmSync(p)
  }
} catch {}

// ── spawn / kill ────────────────────────────────────────────────────────────
// A hidden session can't answer the first-run trust dialog, so we only spawn
// in folders the user has already trusted from a real terminal (read-only
// check of ~/.claude.json — the watcher never modifies trust itself).
function isTrusted(dir) {
  try {
    const j = JSON.parse(readFileSync(join(HOME, '.claude.json'), 'utf8'))
    const key = dir.replace(/\\/g, '/')
    const alt = dir.replace(/\//g, '\\')
    const p = j.projects ?? {}
    return !!(p[key]?.hasTrustDialogAccepted || p[alt]?.hasTrustDialogAccepted || p[dir]?.hasTrustDialogAccepted)
  } catch {
    return false
  }
}

function psQuote(s) {
  return `'${String(s).replace(/'/g, "''")}'`
}

// Start-Process -WindowStyle Hidden gives claude a real console that stays
// hidden — verified working. A direct bun spawn (detached+windowsHide) gives
// no console at all and the TUI dies instantly; bun's execFileSync throws
// spurious ETIMEDOUT — hence async spawn of a PowerShell middleman.
function spawnClaude(cwd, channelName, resumeId) {
  // --channels is what makes Claude Code ACCEPT inbound channel notifications
  // in this session; without it the bot binds and can send, but every inbound
  // message is silently skipped (the wake message never arrives).
  const args = ["'--channels'", "'plugin:discord@claude-plugins-official'"]
  if (resumeId) args.push("'--resume'", psQuote(resumeId))
  const argList = `-ArgumentList @(${args.join(', ')})`
  const script =
    `$env:DISCORD_CHANNEL=${psQuote(channelName)}; ` +
    `$p = Start-Process -FilePath ${psQuote(CLAUDE_EXE)} ${argList} ` +
    `-WorkingDirectory ${psQuote(cwd)} -WindowStyle Hidden -PassThru; $p.Id`
  return new Promise((resolve, reject) => {
    const ps = spawn('powershell.exe', ['-NoProfile', '-Command', script], {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
    let out = ''
    let err = ''
    ps.stdout.on('data', d => (out += d))
    ps.stderr.on('data', d => (err += d))
    const t = setTimeout(() => {
      try {
        ps.kill()
      } catch {}
      reject(new Error('powershell spawn timed out'))
    }, 30_000)
    ps.on('error', e => {
      clearTimeout(t)
      reject(e)
    })
    ps.on('close', code => {
      clearTimeout(t)
      const pid = parseInt(out.trim(), 10)
      if (Number.isFinite(pid)) resolve(pid)
      else reject(new Error(`spawn failed (exit ${code}): ${out} ${err}`.trim()))
    })
  })
}

function killTree(pid) {
  try {
    execFileSync('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { encoding: 'utf8', timeout: 15_000 })
  } catch (err) {
    log(`taskkill ${pid} failed: ${err}`)
  }
}

// ── path extraction from a first message ────────────────────────────────────
function extractPath(text) {
  const m = (text ?? '').match(/(?:[A-Za-z]:[\\/]|~[\\/])[^\s"'<>|*?()]+/)
  if (!m) return null
  let p = m[0].replace(/[.,;:!?]+$/, '')
  if (p.startsWith('~')) p = join(HOME, p.slice(1))
  try {
    if (existsSync(p) && statSync(p).isDirectory()) return p
  } catch {}
  return null
}

// ── wake ────────────────────────────────────────────────────────────────────
const waking = new Set()

function removeHourglass(msg) {
  void msg.reactions
    .resolve('⏳')
    ?.users.remove(client.user.id)
    .catch(() => {})
}

// Clear the ⏳ once the woken session actually owns the channel.
function clearHourglassWhenOwned(msg, channelId, channelName) {
  const deadline = Date.now() + 120_000
  const timer = setInterval(() => {
    if (channelOwned(channelId, channelName)) {
      removeHourglass(msg)
      clearInterval(timer)
    } else if (Date.now() > deadline) {
      clearInterval(timer)
    }
  }, 3_000)
}

async function wake(channelId, channelName, msg) {
  spoolMessage(channelId, msg)
  void maybePostHelp(msg.channel, channelId)
  try {
    await msg.react('⏳')
  } catch {}

  // A terminal session might be binding right now — give the registry a beat.
  await new Promise(r => setTimeout(r, 2500))
  if (channelOwned(channelId, channelName)) {
    log(`#${channelName}: session appeared while waking, standing down (spool stays for it)`)
    removeHourglass(msg)
    return
  }

  indexSessions()
  const sess = findSessionByName(channelName)
  let cwd, resumeId
  if (sess) {
    cwd = sess.cwd
    resumeId = sess.sessionId
    log(`#${channelName}: resuming session ${resumeId} in ${cwd}`)
  } else {
    cwd = extractPath(msg.content) ?? config.defaultDir ?? HOME
    resumeId = null
    log(`#${channelName}: no known session, spawning fresh in ${cwd}`)
  }

  if (!isTrusted(cwd)) {
    log(`#${channelName}: ${cwd} not trusted, cannot wake a hidden session there`)
    removeHourglass(msg)
    try {
      await msg.reply(
        `⚠️ Can't wake a background session in \`${cwd}\`: that folder was never opened in Claude Code, so its one-time trust prompt is unanswered. Open a terminal there once (\`claude\`), accept the prompt, then message me again.`,
      )
    } catch {}
    return
  }

  let pid
  try {
    pid = await spawnClaude(cwd, channelName, resumeId)
  } catch (err) {
    log(`#${channelName}: spawn failed: ${err}`)
    removeHourglass(msg)
    try {
      await msg.react('❌')
    } catch {}
    return
  }
  clearHourglassWhenOwned(msg, channelId, channelName)
  state.spawned[channelId] = {
    pid,
    channelName,
    cwd,
    spawnedAt: Date.now(),
    lastActivity: Date.now(),
  }
  saveState()
  log(`#${channelName}: spawned claude pid ${pid}`)
}

// ── control commands ────────────────────────────────────────────────────────
const HELP_TEXT = [
  '**Claude session watcher** — talk normally and a session wakes for this channel. Commands:',
  '`!sessions` — list live sessions (terminal + background)',
  '`!kill <channel>` — stop that background session',
  '`!killall` — stop all background sessions',
  '`!restart <channel>` / `!restart all` — restart background session(s)',
  '`!update` — update Claude Code itself',
  '`!status` — watcher uptime, Claude version, idle timers',
  '`!logs` — recent watcher log lines',
  '`!help` — this message',
  "Skills and slash-command work (like /daily) — just ask the session in its channel, it runs them itself.",
].join('\n')

const STARTED_AT = Date.now()
let cachedVersion = null

function killAllSpawned() {
  const entries = Object.entries(state.spawned)
  for (const [cid, s] of entries) {
    if (pidAlive(s.pid)) killTree(s.pid)
    delete state.spawned[cid]
  }
  try {
    for (const f of readdirSync(SPOOL_DIR)) rmSync(join(SPOOL_DIR, f))
  } catch {}
  waking.clear()
  saveState()
  return entries.length
}

function findSpawnedByName(name) {
  const clean = name.replace(/^#/, '').toLowerCase()
  return Object.entries(state.spawned).find(([, s]) => s.channelName.toLowerCase() === clean) ?? null
}

async function killOne(msg, name) {
  const hit = findSpawnedByName(name)
  if (!hit) {
    await msg.reply(`No background session on \`#${name.replace(/^#/, '')}\`. Terminal sessions can only be closed from their terminal. \`!sessions\` shows what runs where.`)
    return
  }
  const [cid, s] = hit
  if (pidAlive(s.pid)) killTree(s.pid)
  delete state.spawned[cid]
  saveState()
  await msg.reply(`🛑 Stopped the background session on #${s.channelName}.`)
}

async function restartOne(cid, s) {
  if (pidAlive(s.pid)) killTree(s.pid)
  await new Promise(r => setTimeout(r, 2000))
  indexSessions()
  const sess = findSessionByName(s.channelName)
  const pid = await spawnClaude(sess?.cwd ?? s.cwd, s.channelName, sess?.sessionId ?? null)
  state.spawned[cid] = { ...s, pid, spawnedAt: Date.now(), lastActivity: Date.now() }
  saveState()
}

async function restartCmd(msg, target) {
  if (!target) {
    await msg.reply('Usage: `!restart <channel>` or `!restart all`')
    return
  }
  if (target === 'all') {
    const entries = Object.entries(state.spawned)
    if (entries.length === 0) {
      await msg.reply('No background sessions to restart.')
      return
    }
    for (const [cid, s] of entries) await restartOne(cid, s)
    await msg.reply(`🔄 Restarted ${entries.length} background session(s).`)
    return
  }
  const hit = findSpawnedByName(target)
  if (!hit) {
    await msg.reply(`No background session on \`#${target.replace(/^#/, '')}\`. Terminal sessions restart from their terminal.`)
    return
  }
  await restartOne(hit[0], hit[1])
  await msg.reply(`🔄 Restarted the background session on #${hit[1].channelName}. It resumes its conversation.`)
}

function runClaude(args, timeoutMs) {
  return new Promise(resolve => {
    const p = spawn(CLAUDE_EXE, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    let out = ''
    p.stdout.on('data', d => (out += d))
    p.stderr.on('data', d => (out += d))
    const t = setTimeout(() => {
      try {
        p.kill()
      } catch {}
      resolve(out + '\n(timed out)')
    }, timeoutMs)
    p.on('close', () => {
      clearTimeout(t)
      resolve(out)
    })
    p.on('error', e => {
      clearTimeout(t)
      resolve(String(e))
    })
  })
}

async function updateCmd(msg) {
  await msg.reply('⬆️ Updating Claude Code…')
  const out = (await runClaude(['update'], 180_000)).trim()
  const ver = (await runClaude(['--version'], 30_000)).trim()
  const summary = out.split('\n').slice(-3).join('\n')
  await msg.reply(`${summary || 'Done.'}\nCurrent version: ${ver}\nAlready-running sessions keep their version; background ones pick it up on their next wake (\`!restart all\` to force now).`)
}

async function statusCmd(msg) {
  if (!cachedVersion) cachedVersion = (await runClaude(['--version'], 30_000)).trim()
  const up = Math.round((Date.now() - STARTED_AT) / 60000)
  const idleMs = Math.max(1, config.idleMinutes) * 60 * 1000
  const rows = [
    `Watcher pid ${process.pid}, up ${Math.floor(up / 60)}h${up % 60}m — Claude ${cachedVersion}`,
    `Idle shutdown: ${config.idleMinutes} min, default folder: ${config.defaultDir}`,
  ]
  const spawnedRows = Object.values(state.spawned)
    .filter(s => pidAlive(s.pid))
    .map(s => {
      const left = Math.max(0, Math.round((s.lastActivity + idleMs - Date.now()) / 60000))
      return `#${s.channelName} — background, shuts down in ~${left} min of continued silence`
    })
  const terminals = listLive().filter(r => r.includes('(terminal)'))
  rows.push(...(spawnedRows.length > 0 ? spawnedRows : ['No background sessions.']), ...terminals)
  await msg.reply(rows.join('\n'))
}

async function logsCmd(msg) {
  let tail = ''
  try {
    tail = readTail(LOG_FILE, 16 * 1024)
  } catch {}
  const lines = tail.split('\n').filter(Boolean).slice(-12).join('\n')
  await msg.reply(lines ? '```\n' + lines.slice(-1800) + '\n```' : 'Log is empty.')
}

// First contact with a fresh channel: post the command list and try to pin
// it. Only once per channel, and only when the channel is (nearly) empty.
async function maybePostHelp(channel, channelId) {
  state.helpPosted = state.helpPosted ?? {}
  if (state.helpPosted[channelId]) return
  state.helpPosted[channelId] = true
  saveState()
  try {
    const recent = await channel.messages.fetch({ limit: 6 })
    const humanish = [...recent.values()].filter(m => !m.system)
    if (humanish.length > 3) return
    const sent = await channel.send(HELP_TEXT)
    try {
      await sent.pin()
    } catch {}
  } catch {}
}

function listLive() {
  const rows = []
  let files = []
  try {
    files = readdirSync(LIVE_DIR).filter(f => f.endsWith('.json'))
  } catch {}
  const spawnedPids = new Set(Object.values(state.spawned).map(s => s.pid))
  for (const f of files) {
    const e = readJson(join(LIVE_DIR, f), null)
    if (!e || !pidAlive(e.pid)) continue
    // A background session's live entry is written by its MCP server (child
    // of the claude pid we spawned) — mark by channel instead of pid.
    const bg = Object.values(state.spawned).some(s => s.channelName === e.channelName && pidAlive(s.pid))
    rows.push(`#${e.channelName} — ${e.cwd} (${bg ? 'background' : 'terminal'})`)
  }
  for (const s of Object.values(state.spawned)) {
    if (pidAlive(s.pid) && !rows.some(r => r.startsWith(`#${s.channelName} `))) {
      rows.push(`#${s.channelName} — ${s.cwd} (background, starting…)`)
    }
  }
  return rows
}

// ── idle reaper ─────────────────────────────────────────────────────────────
setInterval(() => {
  const idleMs = Math.max(1, config.idleMinutes) * 60 * 1000
  for (const [cid, s] of Object.entries(state.spawned)) {
    if (!pidAlive(s.pid)) {
      delete state.spawned[cid]
      saveState()
      continue
    }
    if (Date.now() - s.lastActivity > idleMs) {
      log(`#${s.channelName}: idle ${config.idleMinutes}min, shutting down pid ${s.pid}`)
      killTree(s.pid)
      delete state.spawned[cid]
      saveState()
    }
  }
}, 60_000)

// ── gateway ─────────────────────────────────────────────────────────────────
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
  partials: [Partials.Channel],
})

client.on('messageCreate', async msg => {
  try {
    if (!msg.guildId) return
    if (routing.guildId && msg.guildId !== routing.guildId) return
    if (msg.system) return

    const isThread = typeof msg.channel.isThread === 'function' && msg.channel.isThread()
    const channelId = isThread ? (msg.channel.parentId ?? msg.channelId) : msg.channelId

    // Any traffic (bot replies included) counts as activity for idle tracking.
    const sp = state.spawned[channelId]
    if (sp) {
      sp.lastActivity = Date.now()
      saveState()
    }

    if (msg.author?.bot) return
    if (!allowFrom.includes(msg.author.id)) return

    const content = (msg.content ?? '').trim()
    const cmd = content.match(/^!([a-z]+)(?:\s+(.+))?$/i)
    if (cmd) {
      const [, name, arg] = cmd
      switch (name.toLowerCase()) {
        case 'killall': {
          const n = killAllSpawned()
          await msg.reply(`🛑 Stopped ${n} background session(s). Watcher still alive.`)
          return
        }
        case 'kill':
          await killOne(msg, (arg ?? '').trim() || '?')
          return
        case 'restart':
          await restartCmd(msg, (arg ?? '').trim().toLowerCase())
          return
        case 'update':
          await updateCmd(msg)
          return
        case 'sessions': {
          const rows = listLive()
          await msg.reply(rows.length > 0 ? '**Live sessions:**\n' + rows.join('\n') : 'No live sessions.')
          return
        }
        case 'status':
          await statusCmd(msg)
          return
        case 'logs':
          await logsCmd(msg)
          return
        case 'status':
          await statusCmd(msg)
          return
        case 'logs':
          await logsCmd(msg)
          return
        case 'help':
          await msg.reply(HELP_TEXT)
          return
        default:
          await msg.reply(`Unknown command \`!${name}\` — \`!help\` lists them.`)
          return
      }
    }

    if (waking.has(channelId)) {
      spoolMessage(channelId, msg)
      return
    }

    let channelName
    if (isThread) {
      const parent = msg.channel.parent ?? (await client.channels.fetch(channelId).catch(() => null))
      channelName = parent?.name
    } else {
      channelName = msg.channel.name
    }
    if (!channelName) return
    if (channelOwned(channelId, channelName)) return

    waking.add(channelId)
    try {
      await wake(channelId, channelName, msg)
    } finally {
      setTimeout(() => waking.delete(channelId), 90_000)
    }
  } catch (err) {
    log(`messageCreate handler error: ${err}`)
  }
})

client.on('error', err => log(`client error: ${err}`))

// Freshly invited to a server: introduce the commands once, in the first
// channel we can write to.
client.on('guildCreate', async guild => {
  try {
    const chs = await guild.channels.fetch()
    const target = [...chs.values()].find(c => c && c.type === 0 && c.viewable && 'send' in c)
    if (target) await maybePostHelp(target, target.id)
  } catch (err) {
    log(`guildCreate help failed: ${err}`)
  }
})

client.once('ready', c => {
  log(`watcher connected as ${c.user.tag} (pid ${process.pid}, idle ${config.idleMinutes}min, default ${config.defaultDir})`)
})

client.login(TOKEN).catch(err => {
  log(`login failed: ${err}`)
  process.exit(1)
})
