#!/usr/bin/env bun
/**
 * Installs dependencies on first run (plugin installation does not run
 * bun install), then hands off to the real server. Must stay free of
 * external imports. Running the server file directly (instead of a package
 * script with --cwd) keeps the session's working directory visible to the
 * server, which uses it as a fallback for channel binding.
 */
import { existsSync } from 'fs'
import { join } from 'path'

const root = import.meta.dir
if (!existsSync(join(root, 'node_modules', 'discord.js'))) {
  process.stderr.write('discord-sessions: installing dependencies (first run)\n')
  const r = Bun.spawnSync(['bun', 'install', '--no-summary'], {
    cwd: root,
    stdout: 'ignore',
    stderr: 'inherit',
  })
  if (r.exitCode !== 0) {
    process.stderr.write('discord-sessions: bun install failed\n')
    process.exit(1)
  }
}

await import('./server.ts')
