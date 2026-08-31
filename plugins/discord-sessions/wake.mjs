#!/usr/bin/env node
// Wake a background session from anywhere (the concierge session, a terminal,
// a script). Writes a request file; the watcher owns the spawning so the woken
// session keeps its channel binding, its model pin and its effort pin.
//
//   node wake.mjs library-ssr           wake the session named like that
//   node wake.mjs C:/path/to/project    fresh session in that folder
//   node wake.mjs --list                what runs right now
import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'

const STATE_DIR = process.env.DISCORD_STATE_DIR ?? join(homedir(), '.claude', 'channels', 'discord')
const REQ_DIR = join(STATE_DIR, 'requests')
const LIVE_DIR = join(STATE_DIR, 'live')

const readJson = (f, fallback) => {
  try {
    return JSON.parse(readFileSync(f, 'utf8'))
  } catch {
    return fallback
  }
}

const alive = pid => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

const arg = process.argv[2]

if (!arg || arg === '--help') {
  process.stdout.write('usage: wake.mjs <session-name|path> | --list\n')
  process.exit(arg ? 0 : 1)
}

if (arg === '--list') {
  const rows = []
  if (existsSync(LIVE_DIR)) {
    for (const f of readdirSync(LIVE_DIR)) {
      const e = readJson(join(LIVE_DIR, f), null)
      if (!e?.channelName || !alive(e.pid)) continue
      rows.push(`${e.channelName}  ${e.cwd}  ${e.background ? 'background' : 'terminal'}`)
    }
  }
  process.stdout.write(rows.length > 0 ? rows.join('\n') + '\n' : 'nothing running\n')
  process.exit(0)
}

mkdirSync(REQ_DIR, { recursive: true })
const id = `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`
writeFileSync(
  join(REQ_DIR, `${id}.json`),
  JSON.stringify({ target: arg, at: new Date().toISOString(), from: 'wake.mjs' }),
)
process.stdout.write(`wake requested for ${arg}\n`)
