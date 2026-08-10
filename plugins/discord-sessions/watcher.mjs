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
  realpathSync,
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
const { Client, GatewayIntentBits, Partials, ActionRowBuilder, StringSelectMenuBuilder } = requirePlugin('discord.js')

// ── claude executable ───────────────────────────────────────────────────────
const IS_WIN = process.platform === 'win32'

function findClaude() {
  try {
    const out = execFileSync(IS_WIN ? 'where.exe' : 'which', ['claude'], { encoding: 'utf8' })
    const line = out.split(/\r?\n/).find(l => l.trim())
    if (line) return line.trim()
  } catch {}
  const fallback = IS_WIN ? join(HOME, '.local', 'bin', 'claude.exe') : join(HOME, '.local', 'bin', 'claude')
  if (existsSync(fallback)) return fallback
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
// Re-adopt background sessions we lost track of (watcher restarted, state
// wiped): their servers stamp live/<pid>.json with background + claudePid.
try {
  for (const f of readdirSync(LIVE_DIR)) {
    const e = readJson(join(LIVE_DIR, f), null)
    if (!e?.background || !e.claudePid || !e.channelId) continue
    if (!pidAlive(e.pid) || !pidAlive(e.claudePid)) continue
    if (state.spawned[e.channelId] && pidAlive(state.spawned[e.channelId].pid)) continue
    state.spawned[e.channelId] = {
      pid: e.claudePid,
      channelName: e.channelName,
      cwd: e.cwd,
      spawnedAt: Date.parse(e.boundAt) || Date.now(),
      lastActivity: Date.now(),
    }
    log(`re-adopted background session #${e.channelName} (claude pid ${e.claudePid})`)
  }
} catch {}
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
// Windows paths are case-insensitive but .claude.json keys are not:
// "C:/Users/x/repo" (trusted) and "c:/Users/x/repo" (untrusted twin) coexist.
// Canonicalize to the on-disk casing so spawns run under the trusted identity.
function canonPath(p) {
  try {
    return (realpathSync.native ?? realpathSync)(p)
  } catch {
    return p
  }
}

function isTrusted(dir) {
  try {
    const j = JSON.parse(readFileSync(join(HOME, '.claude.json'), 'utf8'))
    const want = dir.replace(/\\/g, '/').toLowerCase()
    for (const [k, v] of Object.entries(j.projects ?? {})) {
      if (k.replace(/\\/g, '/').toLowerCase() === want && v?.hasTrustDialogAccepted) return true
    }
    return false
  } catch {
    return false
  }
}

function psQuote(s) {
  return `'${String(s).replace(/'/g, "''")}'`
}

// --channels is what makes Claude Code ACCEPT inbound channel notifications
// in the woken session; without it the bot binds and can send, but every
// inbound message is silently skipped (the wake message never arrives).
const CLAUDE_ARGS = ['--channels', 'plugin:discord@claude-plugins-official']

// Windows: Start-Process -WindowStyle Hidden gives claude a real console that
// stays hidden — verified working. A direct bun spawn (detached+windowsHide)
// gives no console at all and the TUI dies instantly; bun's execFileSync
// throws spurious ETIMEDOUT — hence async spawn of a PowerShell middleman.
function spawnClaudeWindows(cwd, channelName, resumeId) {
  const args = CLAUDE_ARGS.map(psQuote)
  if (resumeId) args.push("'--resume'", psQuote(resumeId))
  const script =
    `$env:DISCORD_CHANNEL=${psQuote(channelName)}; $env:DISCORD_WAKE='1'; ` +
    `$p = Start-Process -FilePath ${psQuote(CLAUDE_EXE)} -ArgumentList @(${args.join(', ')}) ` +
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

// Linux/macOS: the TUI needs a pty; `script` allocates one without any native
// dependency. Detached so the whole tree lives in its own process group and
// killTree can take it down with kill(-pid).
function spawnClaudePosix(cwd, channelName, resumeId) {
  const args = [...CLAUDE_ARGS]
  if (resumeId) args.push('--resume', resumeId)
  const env = { ...process.env, DISCORD_CHANNEL: channelName, DISCORD_WAKE: '1' }
  const shQuote = s => `'${String(s).replace(/'/g, "'\\''")}'`
  const child =
    process.platform === 'darwin'
      ? spawn('script', ['-q', '/dev/null', CLAUDE_EXE, ...args], { cwd, env, detached: true, stdio: 'ignore' })
      : spawn('script', ['-qefc', [CLAUDE_EXE, ...args].map(shQuote).join(' '), '/dev/null'], {
          cwd,
          env,
          detached: true,
          stdio: 'ignore',
        })
  child.unref()
  if (!child.pid) throw new Error('spawn failed: no pid')
  return Promise.resolve(child.pid)
}

function spawnClaude(cwd, channelName, resumeId) {
  return IS_WIN ? spawnClaudeWindows(cwd, channelName, resumeId) : spawnClaudePosix(cwd, channelName, resumeId)
}

// Async spawn, not execFileSync — bun's sync exec throws spurious ETIMEDOUT
// under a busy event loop (this bug hit spawnClaude first, then this).
function killTree(pid) {
  if (!IS_WIN) {
    // Detached spawn = own process group: negative pid kills the whole tree.
    try {
      process.kill(-pid, 'SIGKILL')
    } catch {
      try {
        process.kill(pid, 'SIGKILL')
      } catch {}
    }
    return Promise.resolve()
  }
  return new Promise(resolve => {
    let done = false
    const finish = () => {
      if (!done) {
        done = true
        resolve()
      }
    }
    const p = spawn('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
    p.on('close', finish)
    p.on('error', err => {
      log(`taskkill ${pid} failed: ${err}`)
      finish()
    })
    const t = setTimeout(() => {
      try {
        p.kill()
      } catch {}
      finish()
    }, 15_000)
    t.unref?.()
  })
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
    cwd = canonPath(sess.cwd)
    resumeId = sess.sessionId
    log(`#${channelName}: resuming session ${resumeId} in ${cwd}`)
  } else {
    cwd = canonPath(extractPath(msg.content) ?? config.defaultDir ?? HOME)
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
  '**Claude session watcher** — talk normally and a session wakes for this channel. Slash commands:',
  '`/skill` — run a skill here (type to search the full list)',
  '`/sessions` — list live sessions (terminal + background)',
  '`/usage` — plan usage (5h + weekly limits; also always visible in my profile status)',
  '`/kill` — stop one background session (also the emergency stop: nothing is lost, your next message wakes it with full history)',
  '`/killall` — stop all background sessions',
  '`/restart` — restart background session(s) (`all` or one channel)',
  '`/open` / `/hide` — show a background session\'s live terminal on the PC screen / tuck it away',
  '`/update` — update Claude Code itself',
  '`/status` — watcher uptime, Claude version, idle timers',
  '`/logs` — recent watcher log lines',
  '`/help` — this message',
  'You can also just ask the session ("run /daily") — it runs skills itself.',
].join('\n')

const STARTED_AT = Date.now()
let cachedVersion = null

async function killAllSpawned() {
  const entries = Object.entries(state.spawned)
  for (const [cid, s] of entries) {
    if (pidAlive(s.pid)) await killTree(s.pid)
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

async function killOneText(name) {
  const hit = findSpawnedByName(name)
  if (!hit) {
    return `No background session on \`#${name.replace(/^#/, '')}\`. Terminal sessions can only be closed from their terminal. \`/sessions\` shows what runs where.`
  }
  const [cid, s] = hit
  if (pidAlive(s.pid)) await killTree(s.pid)
  delete state.spawned[cid]
  saveState()
  return `🛑 Stopped the background session on #${s.channelName}.`
}

async function restartOne(cid, s) {
  if (pidAlive(s.pid)) await killTree(s.pid)
  await new Promise(r => setTimeout(r, 2000))
  if (pidAlive(s.pid)) {
    log(`restart: pid ${s.pid} survived the kill, not spawning a duplicate`)
    throw new Error(`could not stop the old session (pid ${s.pid})`)
  }
  indexSessions()
  const sess = findSessionByName(s.channelName)
  const pid = await spawnClaude(sess?.cwd ?? s.cwd, s.channelName, sess?.sessionId ?? null)
  state.spawned[cid] = { ...s, pid, spawnedAt: Date.now(), lastActivity: Date.now() }
  saveState()
}

async function restartText(target) {
  if (!target) return 'Usage: `/restart target:<channel|all>`'
  if (target === 'all') {
    const entries = Object.entries(state.spawned)
    if (entries.length === 0) return 'No background sessions to restart.'
    const failed = []
    for (const [cid, s] of entries) {
      try {
        await restartOne(cid, s)
      } catch (err) {
        failed.push(`#${s.channelName}: ${err.message}`)
      }
    }
    const ok = entries.length - failed.length
    return `🔄 Restarted ${ok} background session(s).${failed.length > 0 ? '\n⚠️ ' + failed.join('\n⚠️ ') : ''}`
  }
  const hit = findSpawnedByName(target)
  if (!hit) return `No background session on \`#${target.replace(/^#/, '')}\`. Terminal sessions restart from their terminal.`
  try {
    await restartOne(hit[0], hit[1])
  } catch (err) {
    return `⚠️ Restart of #${hit[1].channelName} failed: ${err.message}`
  }
  return `🔄 Restarted the background session on #${hit[1].channelName}. It resumes its conversation.`
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

async function updateText() {
  const out = (await runClaude(['update'], 180_000)).trim()
  const ver = (await runClaude(['--version'], 30_000)).trim()
  const summary = out.split('\n').slice(-3).join('\n')
  return `${summary || 'Done.'}\nCurrent version: ${ver}\nAlready-running sessions keep their version; background ones pick it up on their next wake (\`/restart target:all\` to force now).`
}

// Everything the terminal "/" list offers, minus per-project skills: user
// skills (~/.claude/skills), user commands (~/.claude/commands), and the
// skills + commands of every ENABLED plugin in the cache.
function frontmatterDesc(md) {
  const m = md.match(/^description:[ \t]*(.*)$/m)
  if (!m) return ''
  let v = m[1].trim()
  // YAML folded/literal blocks (">", ">-", "|", "|-") or an empty value:
  // the text lives on the following indented lines.
  if (v === '' || /^[>|][+-]?$/.test(v)) {
    const after = md.slice(m.index + m[0].length)
    const lines = []
    for (const line of after.split('\n').slice(1)) {
      if (/^[ \t]+\S/.test(line)) lines.push(line.trim())
      else if (line.trim() === '') continue
      else break
    }
    v = lines.join(' ')
  }
  // strip surrounding quotes
  v = v.replace(/^(['"])(.*)\1$/s, '$2').trim()
  return v
}

function clip(s, n) {
  return s.length > n ? s.slice(0, n - 1) + '…' : s
}

function listSkills() {
  const out = []
  const push = (name, desc) => {
    if (!out.some(s => s.name === name)) out.push({ name, desc })
  }
  try {
    for (const d of readdirSync(join(HOME, '.claude', 'skills'))) {
      try {
        push(d, frontmatterDesc(readFileSync(join(HOME, '.claude', 'skills', d, 'SKILL.md'), 'utf8')))
      } catch {}
    }
  } catch {}
  try {
    for (const f of readdirSync(join(HOME, '.claude', 'commands'))) {
      if (!f.endsWith('.md')) continue
      let desc = ''
      try {
        desc = frontmatterDesc(readFileSync(join(HOME, '.claude', 'commands', f), 'utf8'))
      } catch {}
      push(basename(f, '.md'), desc)
    }
  } catch {}
  // Plugin skills/commands, namespaced plugin:name like the terminal list.
  const enabled = readJson(join(HOME, '.claude', 'settings.json'), {}).enabledPlugins ?? {}
  const cacheRoot = join(HOME, '.claude', 'plugins', 'cache')
  try {
    for (const marketplace of readdirSync(cacheRoot)) {
      let plugins = []
      try {
        plugins = readdirSync(join(cacheRoot, marketplace))
      } catch {
        continue
      }
      for (const plugin of plugins) {
        if (enabled[`${plugin}@${marketplace}`] !== true) continue
        let versions = []
        try {
          versions = readdirSync(join(cacheRoot, marketplace, plugin))
        } catch {
          continue
        }
        for (const ver of versions.slice(-1)) {
          const base = join(cacheRoot, marketplace, plugin, ver)
          try {
            for (const d of readdirSync(join(base, 'skills'))) {
              try {
                push(`${plugin}:${d}`, frontmatterDesc(readFileSync(join(base, 'skills', d, 'SKILL.md'), 'utf8')))
              } catch {}
            }
          } catch {}
          try {
            for (const f of readdirSync(join(base, 'commands'))) {
              if (!f.endsWith('.md')) continue
              let desc = ''
              try {
                desc = frontmatterDesc(readFileSync(join(base, 'commands', f), 'utf8'))
              } catch {}
              push(`${plugin}:${basename(f, '.md')}`, desc)
            }
          } catch {}
        }
      }
    }
  } catch {}
  return out.sort((a, b) => a.name.localeCompare(b.name))
}

async function skillsCmd(msg, filter) {
  let skills = listSkills()
  if (filter) skills = skills.filter(s => s.name.toLowerCase().includes(filter.toLowerCase()))
  if (skills.length === 0) {
    await msg.reply(filter ? `No skills matching \`${filter}\`.` : 'No skills found.')
    return
  }
  // Discord: 25 options per select menu, 5 menus per message = 125 max.
  const total = skills.length
  const shown = skills.slice(0, 125)
  const rows = []
  for (let i = 0; i < shown.length; i += 25) {
    const chunk = shown.slice(i, i + 25)
    rows.push(
      new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId(`runskill:${i}`)
          .setPlaceholder(`Choose a skill to run (${chunk[0].name.slice(0, 20)} … ${chunk[chunk.length - 1].name.slice(0, 20)})`)
          .addOptions(
            chunk.map(s => ({
              label: clip(`/${s.name}`, 100),
              value: s.name.slice(0, 100),
              ...(s.desc ? { description: clip(s.desc, 100) } : {}),
            })),
          ),
      ),
    )
  }
  try {
    // Discord 500s when several menus WITH option descriptions share one
    // message (verified by bisecting) — one message per menu works.
    await msg.reply({
      content:
        `Pick a skill (${total} available${total > 125 ? ', showing 125 — narrow with `!skills <filter>`' : ''}) — it runs in this channel's session (waking it if needed):`,
      components: [rows[0]],
    })
    for (const row of rows.slice(1)) {
      await msg.channel.send({ components: [row] })
    }
  } catch (err) {
    log(`skills menu failed, falling back to text: ${err}`)
    const text = shown.map(s => `\`/${s.name}\``).join(' · ')
    await msg.reply(`Menus unavailable right now — ask the session directly ("run /name"). Available:\n${text.slice(0, 1900)}`)
  }
}

// Write the instruction the session will pick up (commands/<channelId>.json,
// polled by the patched server with verified retries).
function writeCommandFile(channelId, text, user) {
  const dir = join(STATE_DIR, 'commands')
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, `${channelId}.json`),
    JSON.stringify({ id: `skillcmd-${Date.now()}`, text, attempts: 0, user: user.username, userId: user.id }),
  )
}

// Spawn a session for a channel with no triggering message (skill picker).
async function spawnForChannel(channelId, channelName) {
  indexSessions()
  const sess = findSessionByName(channelName)
  const cwd = canonPath(sess?.cwd ?? config.defaultDir ?? HOME)
  if (!isTrusted(cwd)) return { ok: false, cwd }
  const pid = await spawnClaude(cwd, channelName, sess?.sessionId ?? null)
  state.spawned[channelId] = { pid, channelName, cwd, spawnedAt: Date.now(), lastActivity: Date.now() }
  saveState()
  log(`#${channelName}: spawned claude pid ${pid} for injected command`)
  return { ok: true, cwd }
}

async function statusText() {
  if (!cachedVersion) cachedVersion = (await runClaude(['--version'], 30_000)).trim()
  const up = Math.round((Date.now() - STARTED_AT) / 60000)
  const idleMs = Math.max(1, config.idleMinutes) * 60 * 1000
  const rows = [
    `**Watcher** — up ${Math.floor(up / 60)}h${up % 60}m (pid ${process.pid}, ${process.platform}) — Claude ${cachedVersion}`,
    `Idle shutdown: ${config.idleMinutes} min · default folder: \`${config.defaultDir}\` · guild: ${routing.guildId ?? 'any'}`,
  ]
  try {
    rows.push('', await usageText())
  } catch {}
  rows.push('', '**Sessions**')
  const spawnedRows = Object.values(state.spawned)
    .filter(s => pidAlive(s.pid))
    .map(s => {
      const left = Math.max(0, Math.round((s.lastActivity + idleMs - Date.now()) / 60000))
      const age = Math.max(0, Math.round((Date.now() - s.spawnedAt) / 60000))
      return `#${s.channelName} — \`${s.cwd}\` — background, up ${age} min, shuts down after ~${left} more min of silence`
    })
  const terminals = listLive().filter(r => r.includes('(terminal)'))
  rows.push(...(spawnedRows.length > 0 ? spawnedRows : ['No background sessions.']), ...terminals)
  return rows.join('\n')
}

function logsText() {
  let tail = ''
  try {
    tail = readTail(LOG_FILE, 16 * 1024)
  } catch {}
  const lines = tail.split('\n').filter(Boolean).slice(-12).join('\n')
  return lines ? '```\n' + lines.slice(-1800) + '\n```' : 'Log is empty.'
}

function sessionsText() {
  const rows = listLive()
  return rows.length > 0 ? '**Live sessions:**\n' + rows.join('\n') : 'No live sessions.'
}

// Show/hide the hidden console window of a background session (Windows).
function consoleWindow(claudePid, action) {
  return new Promise(resolve => {
    const p = spawn(
      'powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', join(STATE_DIR, 'show-console.ps1'), '-ClaudePid', String(claudePid), '-Action', action],
      { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true },
    )
    let out = ''
    p.stdout.on('data', d => (out += d))
    p.on('close', code => resolve({ ok: code === 0, out: out.trim() }))
    p.on('error', () => resolve({ ok: false, out: 'spawn failed' }))
    setTimeout(() => {
      try {
        p.kill()
      } catch {}
      resolve({ ok: false, out: 'timed out' })
    }, 20_000).unref?.()
  })
}

async function openText(name, action) {
  if (!IS_WIN) return 'Only available on Windows for now.'
  const hit = findSpawnedByName(name)
  if (!hit) return `No background session on \`#${name.replace(/^#/, '')}\`.`
  const r = await consoleWindow(hit[1].pid, action)
  if (!r.ok) return `⚠️ Could not ${action} the window (${r.out}).`
  return action === 'show'
    ? `🖥️ Terminal of #${hit[1].channelName} is now visible on the PC (closing that window kills the session — use /hide to tuck it away instead).`
    : `Hidden again. #${hit[1].channelName} keeps running in the background.`
}

// ── plan usage: same data as the TUI /usage, via Claude Code's own OAuth ───
// token (read-only; token refresh stays Claude Code's job — on 401 we just
// say so instead of touching the refresh flow).
async function fetchUsage() {
  const cred = readJson(join(HOME, '.claude', '.credentials.json'), {})?.claudeAiOauth
  if (!cred?.accessToken) throw new Error('no Claude credentials found')
  const r = await fetch('https://api.anthropic.com/api/oauth/usage', {
    headers: { Authorization: `Bearer ${cred.accessToken}`, 'anthropic-beta': 'oauth-2025-04-20' },
  })
  if (r.status === 401) throw new Error('Claude token expired — it refreshes automatically on any Claude activity, try again in a minute')
  if (!r.ok) throw new Error(`usage endpoint returned ${r.status}`)
  return r.json()
}

function resetsIn(iso) {
  if (!iso) return ''
  const ms = Date.parse(iso) - Date.now()
  if (!(ms > 0)) return ''
  const h = Math.floor(ms / 3600000)
  const m = Math.round((ms % 3600000) / 60000)
  return h >= 24 ? `resets in ${Math.floor(h / 24)}d${h % 24}h` : h > 0 ? `resets in ${h}h${String(m).padStart(2, '0')}` : `resets in ${m}min`
}

function usageBar(p) {
  const f = Math.max(0, Math.min(10, Math.round(p / 10)))
  return '█'.repeat(f) + '░'.repeat(10 - f)
}

async function usageText() {
  const u = await fetchUsage()
  const rows = ['**Plan usage**']
  if (u.five_hour) rows.push(`Session (5h): \`${usageBar(u.five_hour.utilization)}\` ${u.five_hour.utilization}% — ${resetsIn(u.five_hour.resets_at)}`)
  if (u.seven_day) rows.push(`Week (all models): \`${usageBar(u.seven_day.utilization)}\` ${u.seven_day.utilization}% — ${resetsIn(u.seven_day.resets_at)}`)
  for (const l of u.limits ?? []) {
    if (l.kind === 'weekly_scoped' && l.scope?.model?.display_name) {
      rows.push(`Week (${l.scope.model.display_name}): \`${usageBar(l.percent)}\` ${l.percent}% — ${resetsIn(l.resets_at)}`)
    }
  }
  const extra = u.extra_usage
  if (extra?.is_enabled && extra.used_credits > 0) {
    rows.push(`Extra credits used: ${(extra.used_credits / 10 ** (extra.decimal_places ?? 2)).toFixed(2)} ${extra.currency ?? ''}`)
  }
  return rows.join('\n')
}

// Bot presence shows the numbers all the time, refreshed every 10 min.
let lastPresence = ''
async function refreshPresence() {
  try {
    const u = await fetchUsage()
    const parts = []
    if (u.five_hour) parts.push(`5h ${u.five_hour.utilization}%`)
    if (u.seven_day) parts.push(`wk ${u.seven_day.utilization}%`)
    for (const l of u.limits ?? []) {
      if (l.kind === 'weekly_scoped' && l.scope?.model?.display_name) parts.push(`${l.scope.model.display_name} ${l.percent}%`)
    }
    const r5 = resetsIn(u.five_hour?.resets_at).replace('resets in ', '↻')
    const text = parts.join(' • ') + (r5 ? ` (${r5})` : '')
    if (!text || text === lastPresence) return
    lastPresence = text
    client.user?.setPresence({ activities: [{ type: 4, name: 'usage', state: text }], status: 'online' })
    log(`presence updated: ${text}`)
  } catch (err) {
    log(`presence refresh failed: ${err.message ?? err}`)
  }
}
setInterval(() => void refreshPresence(), 10 * 60 * 1000).unref?.()

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
  for (const f of files) {
    const e = readJson(join(LIVE_DIR, f), null)
    if (!e || !pidAlive(e.pid)) continue
    // The server stamps background:true when spawned by the watcher; fall
    // back to our spawned map for sessions predating that stamp.
    const bg = e.background || Object.values(state.spawned).some(s => s.channelName === e.channelName && pidAlive(s.pid))
    rows.push(`#${e.channelName} — \`${e.cwd}\` (${bg ? 'background' : 'terminal'})`)
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
      // Working indicator for slow commands (!restart all, !update):
      // hourglass while the handler runs, removed when the reply is out.
      const ackPromise = msg.react('⏳').catch(() => null)
      try {
        await runCommand(name.toLowerCase(), arg, msg)
      } catch (err) {
        log(`!${name} failed: ${err}`)
        await msg.reply(`⚠️ \`!${name}\` failed: ${err.message ?? err}`).catch(() => {})
      } finally {
        void ackPromise.then(r => r?.users.remove(client.user.id)).catch(() => {})
      }
      return
    }

    // Legacy "!" commands: kept working as a fallback, /commands are the
    // documented interface.
    async function runCommand(name, arg, msg) {
      switch (name) {
        case 'killall':
          await msg.reply(`🛑 Stopped ${await killAllSpawned()} background session(s). Watcher still alive.`)
          return
        case 'kill':
          await msg.reply(await killOneText((arg ?? '').trim() || '?'))
          return
        case 'restart':
          await msg.reply(await restartText((arg ?? '').trim().toLowerCase()))
          return
        case 'update':
          await msg.reply(await updateText())
          return
        case 'sessions':
          await msg.reply(sessionsText())
          return
        case 'status':
          await msg.reply(await statusText())
          return
        case 'logs':
          await msg.reply(logsText())
          return
        case 'skills':
          await skillsCmd(msg, (arg ?? '').trim())
          return
        case 'help':
          await msg.reply(HELP_TEXT)
          return
        default:
          await msg.reply(`Unknown command \`!${name}\` — \`/help\` lists the commands.`)
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
    // A spawned session can take minutes to bind on a big resume — well past
    // the 90s waking guard. As long as its pid is alive, never wake a second
    // one: spool the message, the booting session picks it up on bind (the
    // server re-reads the spool on every rebind tick).
    const booting = state.spawned[channelId]
    if (booting && pidAlive(booting.pid)) {
      spoolMessage(channelId, msg)
      log(`#${channelName}: session pid ${booting.pid} still booting, spooled ${msg.id} instead of double-waking`)
      return
    }

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

// Queue a skill for a channel's session (waking one if needed). Returns the
// message to show the user.
async function queueSkill(interaction, skill) {
  const ch = interaction.channel
  const isThread = typeof ch?.isThread === 'function' && ch.isThread()
  const channelId = isThread ? (ch.parentId ?? interaction.channelId) : interaction.channelId
  const channelName = isThread ? ch.parent?.name : ch?.name
  if (!channelName) return 'Could not resolve this channel.'
  writeCommandFile(channelId, `Run the /${skill} skill now.`, interaction.user)
  if (!channelOwned(channelId, channelName)) {
    const r = await spawnForChannel(channelId, channelName)
    if (!r.ok) return `⚠️ Can't run /${skill}: folder \`${r.cwd}\` was never trusted from a terminal.`
    log(`#${channelName}: skill /${skill} queued (session waking)`)
    return `▶️ /${skill} sent to #${channelName} (waking the session first, give it a moment).`
  }
  log(`#${channelName}: skill /${skill} queued`)
  return `▶️ /${skill} sent to #${channelName}.`
}

client.on('interactionCreate', async i => {
  try {
    if (i.isAutocomplete()) {
      const q = (i.options.getFocused() ?? '').toLowerCase()
      if (i.commandName === 'skill') {
        // live search over everything the terminal / list has
        const hits = listSkills()
          .filter(s => !q || s.name.toLowerCase().includes(q) || s.desc.toLowerCase().includes(q))
          .slice(0, 25)
          .map(s => ({ name: clip(`/${s.name}${s.desc ? ' — ' + s.desc : ''}`, 100), value: s.name.slice(0, 100) }))
        await i.respond(hits)
      } else if (i.commandName === 'kill' || i.commandName === 'restart' || i.commandName === 'open' || i.commandName === 'hide') {
        const names = Object.values(state.spawned)
          .filter(s => pidAlive(s.pid))
          .map(s => s.channelName)
        if (i.commandName === 'restart') names.unshift('all')
        await i.respond(
          names
            .filter(n => !q || n.toLowerCase().includes(q))
            .slice(0, 25)
            .map(n => ({ name: n === 'all' ? 'all (every background session)' : `#${n}`, value: n })),
        )
      }
      return
    }

    if (i.isChatInputCommand()) {
      if (!allowFrom.includes(i.user.id)) {
        await i.reply({ content: 'Not allowed.', ephemeral: true })
        return
      }
      switch (i.commandName) {
        case 'skill': {
          await i.deferReply()
          await i.editReply(await queueSkill(i, i.options.getString('name', true)))
          return
        }
        case 'sessions':
          await i.reply(sessionsText())
          return
        case 'usage': {
          await i.deferReply()
          try {
            await i.editReply(await usageText())
          } catch (err) {
            await i.editReply(`⚠️ ${err.message ?? err}`)
          }
          void refreshPresence()
          return
        }
        case 'status': {
          await i.deferReply()
          await i.editReply(await statusText())
          return
        }
        case 'logs':
          await i.reply(logsText())
          return
        case 'help':
          await i.reply(HELP_TEXT)
          return
        case 'update': {
          await i.deferReply()
          await i.editReply(await updateText())
          return
        }
        case 'killall': {
          await i.deferReply()
          await i.editReply(`🛑 Stopped ${await killAllSpawned()} background session(s). Watcher still alive.`)
          return
        }
        case 'kill': {
          await i.deferReply()
          await i.editReply(await killOneText(i.options.getString('channel', true)))
          return
        }
        case 'restart': {
          await i.deferReply()
          await i.editReply(await restartText(i.options.getString('target', true).toLowerCase()))
          return
        }
        case 'open': {
          await i.deferReply()
          await i.editReply(await openText(i.options.getString('channel', true), 'show'))
          return
        }
        case 'hide': {
          await i.deferReply()
          await i.editReply(await openText(i.options.getString('channel', true), 'hide'))
          return
        }
      }
      return
    }

    if (!i.isStringSelectMenu() || !i.customId.startsWith('runskill')) return
    if (!allowFrom.includes(i.user.id)) {
      await i.reply({ content: 'Not allowed.', ephemeral: true })
      return
    }
    const result = await queueSkill(i, i.values[0])
    await i.update({ content: result, components: [] })
  } catch (err) {
    log(`interaction error: ${err}`)
  }
})

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
  // Slash commands — guild-scoped registration is instant (global takes up
  // to an hour). type 3 = STRING option.
  if (routing.guildId) {
    void c.application.commands
      .set(
        [
          {
            name: 'skill',
            description: "Run a Claude skill in this channel's session",
            options: [
              { type: 3, name: 'name', description: 'Skill to run (type to search)', required: true, autocomplete: true },
            ],
          },
          { name: 'sessions', description: 'List live Claude sessions (terminal + background)' },
          { name: 'usage', description: 'Plan usage: 5h session and weekly limits' },
          { name: 'status', description: 'Watcher status: uptime, Claude version, idle timers' },
          { name: 'logs', description: 'Recent watcher log lines' },
          { name: 'help', description: 'How the watcher works, all commands' },
          { name: 'update', description: 'Update Claude Code itself' },
          { name: 'killall', description: 'Stop every background session (watcher stays alive)' },
          {
            name: 'kill',
            description: 'Stop one background session',
            options: [
              { type: 3, name: 'channel', description: 'Which background session', required: true, autocomplete: true },
            ],
          },
          {
            name: 'restart',
            description: 'Restart background session(s)',
            options: [
              { type: 3, name: 'target', description: 'A channel, or "all"', required: true, autocomplete: true },
            ],
          },
          {
            name: 'open',
            description: "Show a background session's live terminal on the PC screen",
            options: [
              { type: 3, name: 'channel', description: 'Which background session', required: true, autocomplete: true },
            ],
          },
          {
            name: 'hide',
            description: "Hide a background session's terminal window again",
            options: [
              { type: 3, name: 'channel', description: 'Which background session', required: true, autocomplete: true },
            ],
          },
        ],
        routing.guildId,
      )
      .then(() => log('registered slash commands'))
      .catch(err => log(`slash command registration failed: ${err}`))
  }
  void refreshPresence()
})

client.login(TOKEN).catch(err => {
  log(`login failed: ${err}`)
  process.exit(1)
})
