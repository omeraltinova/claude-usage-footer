// Scans Claude Code transcripts (~/.claude/projects/**/*.jsonl) and prints, as JSON,
// the API-equivalent cost of the account's current 5-hour and weekly limit windows, per model,
// plus when this session's main thread last hit the prompt cache.
// Incremental: byte offsets and parsed entries are cached in the OS temp folder.
//
// node usage-scan.mjs --session <id> [--window-start <ms>] [--week-start <ms>] [--fable-week-start <ms>]
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const HOUR = 3600e3
const DAY = 24 * HOUR
const KEEP_MS = 8 * DAY
const CHUNK = 16 * 1024 * 1024
const CACHE_VERSION = 2

// $ per million tokens: [match, input, output, cache-read ratio of input]
// Cache writes are 1.25x input (5 min TTL) and 2x input (1 hour TTL).
const PRICES = [
  ['fable-5-1', 10, 50, 0.025],
  ['mythos-5-1', 10, 50, 0.025],
  ['fable-5', 10, 50, 0.1],
  ['mythos-5', 10, 50, 0.1],
  ['opus-5-5', 4, 20, 0.05],
  ['opus-5', 5, 25, 0.1],
  ['opus-4-8', 5, 25, 0.1],
  ['opus-4-7', 5, 25, 0.1],
  ['opus-4-6', 5, 25, 0.1],
  ['opus-4-5', 5, 25, 0.1],
  ['opus-4', 15, 75, 0.1],
  ['sonnet-5-5', 2, 10, 0.1],
  ['sonnet-5', 2, 10, 0.1],
  ['sonnet-4', 3, 15, 0.1],
  ['sonnet-3', 3, 15, 0.1],
  ['haiku-4', 1, 5, 0.1],
  ['haiku-3-5', 0.8, 4, 0.1],
]
// Fast mode multiplies every token price (Opus 5 / 5.5: 2x).
const FAST_MULTIPLIER = 2
const WEB_SEARCH_USD = 0.01

function argOf(name) {
  const at = process.argv.indexOf(name)
  return at === -1 ? undefined : process.argv[at + 1]
}

function priceOf(model) {
  return PRICES.find(([match]) => model.includes(match))
}

function costOf(entry) {
  const price = priceOf(entry.m)
  if (!price) return 0
  const [, input, output, readRatio] = price
  const tokens =
    entry.i * input +
    entry.o * output +
    entry.c5 * input * 1.25 +
    entry.c1 * input * 2 +
    entry.cr * input * readRatio
  return (tokens / 1e6) * (entry.f ? FAST_MULTIPLIER : 1) + entry.w * WEB_SEARCH_USD
}

function listTranscripts(dir, out) {
  let names
  try {
    names = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const one of names) {
    const full = path.join(dir, one.name)
    if (one.isDirectory()) listTranscripts(full, out)
    else if (one.isFile() && one.name.endsWith('.jsonl')) out.push(full)
  }
  return out
}

function loadCache(file) {
  try {
    const cache = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (cache.version === CACHE_VERSION) return cache
  } catch {}
  return { version: CACHE_VERSION, files: {}, entries: [] }
}

// Reads complete lines from `offset` to the end; returns the new offset (after the last newline).
function readNewLines(file, offset, size, onLine) {
  const fd = fs.openSync(file, 'r')
  try {
    let position = offset
    let carry = ''
    while (position < size) {
      const length = Math.min(CHUNK, size - position)
      const buffer = Buffer.alloc(length)
      const read = fs.readSync(fd, buffer, 0, length, position)
      if (read <= 0) break
      position += read
      const text = carry + buffer.toString('utf8', 0, read)
      const lines = text.split('\n')
      carry = lines.pop() ?? ''
      for (const line of lines) onLine(line)
    }
    return position - Buffer.byteLength(carry, 'utf8')
  } finally {
    fs.closeSync(fd)
  }
}

function toEntry(line, since) {
  if (!line.includes('"assistant"') || !line.includes('"usage"')) return undefined
  let row
  try {
    row = JSON.parse(line)
  } catch {
    return undefined
  }
  const message = row.message
  const usage = message?.usage
  if (row.type !== 'assistant' || !usage || !message.model || message.model === '<synthetic>') {
    return undefined
  }
  const t = Date.parse(row.timestamp)
  if (!Number.isFinite(t) || t < since) return undefined
  const creation = usage.cache_creation ?? {}
  const written = usage.cache_creation_input_tokens ?? 0
  const c1 = creation.ephemeral_1h_input_tokens ?? 0
  const c5 = creation.ephemeral_5m_input_tokens ?? Math.max(0, written - c1)
  return {
    k: `${message.id}:${row.requestId ?? ''}`,
    t,
    m: message.model,
    i: usage.input_tokens ?? 0,
    o: usage.output_tokens ?? 0,
    cr: usage.cache_read_input_tokens ?? 0,
    c5,
    c1,
    f: usage.speed === 'fast' ? 1 : 0,
    w: usage.server_tool_use?.web_search_requests ?? 0,
    s: row.sessionId ?? '',
    sc: row.isSidechain ? 1 : 0,
  }
}

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

function hhmm(ms, withDay = false) {
  const date = new Date(ms)
  const time = `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
  return withDay ? `${DAYS[date.getDay()]} ${time}` : time
}

// Without a reading from the API: a block starts at the hour of the first request after
// the previous block ended, and lasts 5 hours.
function guessWindowStart(entries, now) {
  let start
  for (const entry of entries) {
    if (start === undefined || entry.t >= start + 5 * HOUR) {
      const hour = new Date(entry.t)
      hour.setMinutes(0, 0, 0)
      start = hour.getTime()
    }
  }
  return start !== undefined && now < start + 5 * HOUR ? start : undefined
}

function summarize(entries, start, end, withDay = false) {
  const byModel = new Map()
  let usd = 0
  for (const entry of entries) {
    if (entry.t < start || entry.t >= end) continue
    const cost = costOf(entry)
    usd += cost
    const row = byModel.get(entry.m) ?? {
      model: entry.m,
      usd: 0,
      reqs: 0,
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      isPriced: priceOf(entry.m) !== undefined,
    }
    row.usd += cost
    row.reqs += 1
    row.input += entry.i
    row.output += entry.o
    row.cacheRead += entry.cr
    row.cacheWrite += entry.c5 + entry.c1
    byModel.set(entry.m, row)
  }
  const models = [...byModel.values()].sort((a, b) => b.usd - a.usd)
  return { start, end, startLabel: hhmm(start, withDay), endLabel: hhmm(end, withDay), usd, models }
}

function main() {
  const startedAt = Date.now()
  const now = startedAt
  const sessionId = argOf('--session') ?? ''
  const windowArg = Number(argOf('--window-start'))
  const weekArg = Number(argOf('--week-start'))
  const fableWeekArg = Number(argOf('--fable-week-start'))
  const configDir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude')
  const root = path.join(configDir, 'projects')
  const cacheFile = path.join(os.tmpdir(), 'claude-usage-footer-cache.json')
  const cache = loadCache(cacheFile)
  const since = now - KEEP_MS

  const byKey = new Map()
  for (const entry of cache.entries) {
    if (entry.t >= since) byKey.set(entry.k, entry)
  }
  const add = entry => {
    const known = byKey.get(entry.k)
    if (!known || entry.o > known.o) byKey.set(entry.k, entry)
  }

  const files = {}
  for (const file of listTranscripts(root, [])) {
    let stat
    try {
      stat = fs.statSync(file)
    } catch {
      continue
    }
    const known = cache.files[file]
    if (stat.mtimeMs < since && !known) continue
    let offset = known && known.size <= stat.size ? known.offset : 0
    if (offset < stat.size) {
      try {
        offset = readNewLines(file, offset, stat.size, line => {
          const entry = toEntry(line, since)
          if (entry) add(entry)
        })
      } catch {
        continue
      }
    }
    if (stat.mtimeMs >= since) files[file] = { offset, size: stat.size }
  }

  const entries = [...byKey.values()].sort((a, b) => a.t - b.t)
  try {
    fs.writeFileSync(cacheFile, JSON.stringify({ version: CACHE_VERSION, files, entries }))
  } catch {}

  const windowStart = Number.isFinite(windowArg) && windowArg > 0
    ? windowArg
    : guessWindowStart(entries, now)

  const mine = entries.filter(entry => entry.s === sessionId && !entry.sc)
  const last = mine[mine.length - 1]
  const hasHourCache = mine.some(entry => entry.c1 > 0)
  const hasWrites = mine.some(entry => entry.c1 > 0 || entry.c5 > 0)

  const result = {
    now,
    window: windowStart === undefined
      ? null
      : { ...summarize(entries, windowStart, windowStart + 5 * HOUR), isGuessed: !(windowArg > 0) },
    // Without a reading of the weekly limit: the last 7 days.
    week: weekArg > 0
      ? { ...summarize(entries, weekArg, weekArg + 7 * DAY, true), isGuessed: false }
      : { ...summarize(entries, now - 7 * DAY, now, true), isGuessed: true },
    // Fable's own weekly limit counts Fable (and Mythos) requests alone.
    fableWeek: (() => {
      const fable = entries.filter(entry => /fable|mythos/.test(entry.m))
      const start = fableWeekArg > 0 ? fableWeekArg : weekArg > 0 ? weekArg : now - 7 * DAY
      const end = fableWeekArg > 0 || weekArg > 0 ? start + 7 * DAY : now
      return { ...summarize(fable, start, end, true), isGuessed: !(fableWeekArg > 0) }
    })(),
    cache: last ? { lastTs: last.t, ttlMin: hasHourCache || !hasWrites ? 60 : 5 } : null,
    tzOffsetMin: -new Date(now).getTimezoneOffset(),
    scannedMs: Date.now() - startedAt,
  }
  process.stdout.write(JSON.stringify(result))
}

main()
