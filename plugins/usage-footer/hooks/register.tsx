import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { UsageLimit, UsagePeriod, UsageScan } from '../types'

const MINUTE = 60e3
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

const DANGER = '#e05050'
const GOOD = '#3fb950'
const TIGHT = '#d29922'
const OVER = '#f85149'

// Where the limit lands at the window's end if use keeps its pace so far:
// past 100% red, 85-100% yellow, below green. Uncolored without a reading.
function paceColor(limit: UsageLimit | undefined, lengthMs: number, now: number): string | undefined {
  const resetMs = limit?.resetsAt ? Date.parse(limit.resetsAt) : NaN
  if (!limit || !Number.isFinite(resetMs)) return undefined
  if (limit.percentUsed >= 100) return OVER
  // Early in a window the pace swings wildly: count at least a tenth of it as elapsed.
  const elapsed = Math.max(lengthMs / 10, Math.min(lengthMs, lengthMs - (resetMs - now)))
  const projected = (limit.percentUsed * lengthMs) / elapsed
  return projected >= 100 ? OVER : projected >= 85 ? TIGHT : GOOD
}

// Green with the cache fresh, through yellow, to red as it runs out.
function cacheColor(leftMs: number | undefined, ttlMin: number): string | undefined {
  if (leftMs === undefined) return undefined
  if (leftMs <= 0) return OVER
  const fraction = Math.min(1, leftMs / (ttlMin * MINUTE))
  const hue = Math.round(fraction * 120)
  return hslToHex(hue, 70, 50)
}

// When the limit fills at the pace so far, or where it ends the window if it does not.
function forecast(limit: UsageLimit | undefined, lengthMs: number, now: number, tzOffsetMin: number): string | undefined {
  const resetMs = limit?.resetsAt ? Date.parse(limit.resetsAt) : NaN
  if (!limit || !Number.isFinite(resetMs)) return undefined
  if (limit.percentUsed >= 100) return `Limit reached · resets ${clock(resetMs, tzOffsetMin, lengthMs > DAY)}`
  const elapsed = Math.max(lengthMs / 10, Math.min(lengthMs, lengthMs - (resetMs - now)))
  const perMs = limit.percentUsed / elapsed
  if (perMs <= 0) return `On pace: won't fill · now ${limit.percentUsed}%`
  const fillAt = now + (100 - limit.percentUsed) / perMs
  if (fillAt < resetMs) {
    return `On pace: fills ~${clock(fillAt, tzOffsetMin, lengthMs > DAY)} (in ${span(fillAt - now)}) · now ${limit.percentUsed}%`
  }
  const endPercent = Math.round(limit.percentUsed + perMs * (resetMs - now))
  return `On pace: won't fill · ~${endPercent}% at window end · now ${limit.percentUsed}%`
}

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

function clock(ms: number, tzOffsetMin: number, withDay: boolean): string {
  const local = new Date(ms + tzOffsetMin * MINUTE)
  const time = `${String(local.getUTCHours()).padStart(2, '0')}:${String(local.getUTCMinutes()).padStart(2, '0')}`
  return withDay ? `${DAYS[local.getUTCDay()]} ${time}` : time
}

function span(ms: number): string {
  if (ms >= DAY) return `${Math.floor(ms / DAY)}d ${Math.floor((ms % DAY) / HOUR)}h`
  if (ms >= HOUR) return `${Math.floor(ms / HOUR)}h ${Math.floor((ms % HOUR) / MINUTE)}m`
  return `${Math.max(1, Math.ceil(ms / MINUTE))}m`
}

function hslToHex(hue: number, saturation: number, lightness: number): string {
  const s = saturation / 100
  const l = lightness / 100
  const k = (n: number) => (n + hue / 30) % 12
  const a = s * Math.min(l, 1 - l)
  const channel = (n: number) =>
    Math.round(255 * (l - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1))))
      .toString(16)
      .padStart(2, '0')
  return `#${channel(0)}${channel(8)}${channel(4)}`
}
const FAMILY_COLORS: Record<string, string> = {
  opus: '#d97757',
  sonnet: '#6a9bcc',
  haiku: '#629987',
  fable: '#a78bfa',
  mythos: '#a78bfa',
}

const scan = atom({ plugin: 'usage-footer', key: 'scan' } as const, null)
const limits = atom({ plugin: 'usage-footer', key: 'limits' } as const, [])
const lastCall = atom({ plugin: 'usage-footer', key: 'lastCall' } as const, 0)
const error = atom({ plugin: 'usage-footer', key: 'error' } as const, null)
const isOpen = atom({ plugin: 'usage-footer', key: 'isOpen' } as const, false)
const isWorking = atom({ plugin: 'usage-footer', key: 'isWorking' } as const, false)
const model = atom({ plugin: 'usage-footer', key: 'model' } as const, '')

// claude-opus-5-5 -> Opus 5.5, claude-haiku-4-5-20251001 -> Haiku 4.5
function modelName(id: string): string {
  const [family = id, ...version] = id.replace(/^claude-/, '').replace(/-\d{8}$/, '').split('-')
  return `${family.charAt(0).toUpperCase()}${family.slice(1)} ${version.join('.')}`.trim()
}

function modelColor(id: string): string {
  const family = id.replace(/^claude-/, '').split('-')[0] ?? ''
  return FAMILY_COLORS[family] ?? '#8a8a8a'
}

function usd(value: number): string {
  return value >= 1000 ? `$${value.toFixed(0)}` : `$${value.toFixed(2)}`
}

// The desktop cuts the footer at a fixed width: whole dollars there, cents in the card.
function usdShort(value: number): string {
  return `$${Math.round(value)}`
}

function tokens(value: number): string {
  if (value >= 1e6) return `${(value / 1e6).toFixed(1)}M`
  if (value >= 1e3) return `${(value / 1e3).toFixed(value >= 1e5 ? 0 : 1)}k`
  return String(value)
}

// Share of the prompt the cache served: read over everything sent (uncached + written + read).
function hitRate(row: { input: number; cacheRead: number; cacheWrite: number }): string {
  const sent = row.input + row.cacheRead + row.cacheWrite
  return sent > 0 ? `${((row.cacheRead / sent) * 100).toFixed(1)}%` : '—'
}

function startOf(list: UsageLimit[], kind: string, lengthMs: number): number | undefined {
  const resetsAt = list.find(limit => limit.kind === kind)?.resetsAt
  const resetMs = resetsAt ? Date.parse(resetsAt) : NaN
  return Number.isFinite(resetMs) ? resetMs - lengthMs : undefined
}

function weekLimit(list: UsageLimit[]): UsageLimit | undefined {
  return list.find(limit => limit.kind === 'seven_day') ?? list.find(limit => limit.kind.startsWith('seven_day') && !isFableKind(limit.kind))
}

function isFableKind(kind: string): boolean {
  return /fable|mythos/.test(kind)
}

function fableLimit(list: UsageLimit[]): UsageLimit | undefined {
  return list.find(limit => isFableKind(limit.kind))
}

function isFable(id: string): boolean {
  return /fable|mythos/.test(id)
}

function cacheLeftMs(data: UsageScan | null, last: number, now: number): number | undefined {
  const lastTs = Math.max(last, data?.cache?.lastTs ?? 0)
  if (lastTs === 0) return undefined
  return lastTs + (data?.cache?.ttlMin ?? 60) * MINUTE - now
}

// Apps started from the macOS Dock (and some Windows shortcuts) do not get the shell's PATH:
// after PATH, try where Node usually lives on macOS, Linux and Windows.
const NODE_CANDIDATES = [
  'node',
  '/opt/homebrew/bin/node',
  '/usr/local/bin/node',
  '/usr/bin/node',
  'C:/Program Files/nodejs/node.exe',
]
let nodePath: string | undefined

async function runNode($: EngineInterface, args: string[]) {
  for (const candidate of nodePath ? [nodePath] : NODE_CANDIDATES) {
    try {
      const ran = await $.process.run([candidate, ...args], { timeoutMs: 120e3 })
      nodePath = candidate
      return ran
    } catch {
      // not there: try the next one
    }
  }
  throw new Error('Node.js not found (install it, or put node on PATH)')
}

let isScanning = false
let isScanQueued = false

async function rescan($: EngineInterface): Promise<void> {
  if (isScanning) {
    isScanQueued = true
    return
  }
  isScanning = true
  try {
    const argv = ['node', `${$.plugin.root}/scripts/usage-scan.mjs`, '--session', await $.session.id()]
    const list = await read($, limits)
    // The account's own limit windows: each one started its length before it resets.
    const windowStart = startOf(list, 'five_hour', 5 * HOUR)
    const weekStart = startOf(list, weekLimit(list)?.kind ?? 'seven_day', 7 * DAY)
    if (windowStart !== undefined) argv.push('--window-start', String(windowStart))
    if (weekStart !== undefined) argv.push('--week-start', String(weekStart))
    const fable = fableLimit(list)
    const fableStart = fable ? startOf(list, fable.kind, 7 * DAY) : undefined
    if (fableStart !== undefined) argv.push('--fable-week-start', String(fableStart))

    const ran = await runNode($, argv.slice(1))
    if (ran.exitCode !== 0) throw new Error(ran.stderr.trim().split('\n').pop() || `exit ${ran.exitCode}`)
    const data = JSON.parse(ran.stdout) as UsageScan
    await update($, scan, () => data)
    await update($, error, () => null)
  } catch (failure) {
    const message = failure instanceof Error ? failure.message : String(failure)
    await update($, error, () => message.slice(0, 300))
  } finally {
    isScanning = false
    if (isScanQueued) {
      isScanQueued = false
      void rescan($)
    }
  }
}

function summaryText(data: UsageScan | null): string {
  if (!data) return 'No usage data yet.'
  const line = (title: string, period: UsagePeriod | null) =>
    period
      ? `${title}: ${usd(period.usd)} (${period.models.map(row => `${modelName(row.model)} ${usd(row.usd)}`).join(', ') || 'no requests'})`
      : `${title}: no requests`
  return [line('5-hour window', data.window), line('Weekly window', data.week), line('Weekly · Fable', data.fableWeek ?? null)].join('\n')
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'usage-footer',
      description: 'Toggle the card with the API-equivalent cost of the 5-hour and weekly windows, per model',
    })

    const usage = await $.session.usage()
    if (usage.rateLimits.length > 0) await update($, limits, () => [...usage.rateLimits])

    const current = await $.session.model().catch(() => '')
    await update($, model, () => current)
    void rescan($)
    // Each turn's end scans (session.measure); this catches other sessions' use meanwhile.
    $.clock.every(5 * MINUTE, () => void rescan($))
    // The cache countdown moves by the minute: redraw, nothing more.
    $.clock.every(MINUTE, () => $.ui.invalidate('ui.render'))

    return next(e)
  })

  // While a turn runs its requests keep the prompt cache warm; its end restarts the TTL.
  on('turn.start', async ($, e, next) => {
    await update($, isWorking, () => true)

    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId === undefined) {
      const now = await $.clock.now()
      await update($, isWorking, () => false)
      await update($, lastCall, () => now)
      if (e.usage?.model) await update($, model, () => e.usage?.model ?? '')
    }

    return next(e)
  })

  on('session.measure', async ($, e, next) => {
    if (e.rateLimits.length > 0) await update($, limits, () => [...e.rateLimits])
    void rescan($)

    return next(e)
  })

  on('command.run', { command: 'usage-footer' }, async $ => {
    await update($, isOpen, open => !open)
    await rescan($)

    return { text: summaryText(await read($, scan)) }
  })

  // The footer: colored values beside the model name, kept short so the desktop does
  // not cut them, and a ▾ that toggles the card.
  on('ui.render', { component: 'SessionMode' }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const data = await read($, scan)
    const list = await read($, limits)
    const now = await $.clock.now()
    const isLive = await read($, isWorking)
    const leftMs = isLive ? (data?.cache?.ttlMin ?? 60) * MINUTE : cacheLeftMs(data, await read($, lastCall), now)
    const usesFable = isFable(await read($, model))
    const toggle = () => void update($, isOpen, open => !open)

    // The terminal has room and no ◷ in many fonts: full words and cents there;
    // the desktop cuts its footer at a fixed width: a glyph and whole dollars.
    const isTerminal = e.surface === 'terminal'
    const money = isTerminal ? usd : usdShort
    const minutes = leftMs === undefined ? undefined : Math.max(0, Math.ceil(leftMs / MINUTE))
    const cache = isTerminal
      ? `cache ${minutes === undefined ? '—' : `${minutes}m`}`
      : `◷${minutes === undefined ? '—' : minutes}`
    const window = `5h ${data?.window ? money(data.window.usd) : data ? '$0' : '…'}`
    const week = `7d ${data ? money(data.week.usd) : '…'}`
    const fable = `${isTerminal ? '7d Fable' : 'F'} ${data?.fableWeek ? money(data.fableWeek.usd) : '…'}`

    return (
      <Box flexDirection="row" gap={1}>
        <Button key="toggle" plain label="▾" onPress={toggle} />
        <Text bold color={cacheColor(leftMs, data?.cache?.ttlMin ?? 60)}>
          {cache}
        </Text>
        <Text dimColor>—</Text>
        <Text bold color={paceColor(list.find(limit => limit.kind === 'five_hour'), 5 * HOUR, now)}>
          {window}
        </Text>
        <Text dimColor>—</Text>
        {usesFable ? (
          <Text bold color={paceColor(fableLimit(list), 7 * DAY, now)}>
            {fable}
          </Text>
        ) : (
          <Text bold color={paceColor(weekLimit(list), 7 * DAY, now)}>
            {week}
          </Text>
        )}
        {e.props.modes.length > 0 && <Text dimColor>{e.props.modes.join(' & ')}</Text>}
      </Box>
    )
  })

  // The card: drawn in the band right above the prompt while open.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey || !(await read($, isOpen))) return next(e)

    const { Box, Text, Button } = $.ui.resolve(e)
    const data = await read($, scan)
    const failure = await read($, error)
    const list = await read($, limits)
    const now = await $.clock.now()
    const leftMs = (await read($, isWorking)) ? (data?.cache?.ttlMin ?? 60) * MINUTE : cacheLeftMs(data, await read($, lastCall), now)
    const full = Math.max(32, e.props.bodyColumns - 2)
    const width = Math.min(full, 100)
    // The terminal band has few rows: no blank line above each table there.
    const isTerminal = e.surface === 'terminal'

    const row = (left: unknown, right: unknown, rowWidth = width) => (
      <Box flexDirection="row" justifyContent="space-between" width={rowWidth}>
        {left}
        {right}
      </Box>
    )
    // Columns: the model, then right-aligned figures.
    const COLUMNS: Array<[string, number]> = [
      ['Reqs', 6],
      ['Input', 8],
      ['Cache read', 12],
      ['Cache write', 13],
      ['Output', 9],
      ['Hit', 8],
      ['Cost', 10],
    ]
    const cells = (values: string[], isHeader: boolean) =>
      COLUMNS.map(([, size], at) => (
        <Box width={size} justifyContent="flex-end">
          <Text dimColor={isHeader} bold={!isHeader && at === COLUMNS.length - 1}>
            {values[at] ?? ''}
          </Text>
        </Box>
      ))
    const section = (title: string, period: UsagePeriod | null, color?: string, note?: string, sectionWidth = width) => {
      const models = period?.models ?? []
      const total = models.reduce(
        (sum, one) => ({ input: sum.input + one.input, cacheRead: sum.cacheRead + one.cacheRead, cacheWrite: sum.cacheWrite + one.cacheWrite }),
        { input: 0, cacheRead: 0, cacheWrite: 0 },
      )
      return (
        <Box flexDirection="column" width={sectionWidth}>
          {row(
            <Text>
              <Text bold>{title}</Text>
              <Text dimColor>
                {period ? `  ${period.startLabel} – ${period.endLabel}${period.isGuessed ? ' (estimated)' : ''}` : ''}
              </Text>
            </Text>,
            <Text>
              <Text dimColor>{models.length > 0 ? `cache hit ${hitRate(total)}   ` : ''}</Text>
              <Text bold color={color}>
                {usd(period?.usd ?? 0)}
              </Text>
            </Text>,
            sectionWidth,
          )}
          {note && <Text color={color}>{note}</Text>}
          {models.length === 0 ? (
            <Text dimColor>No requests</Text>
          ) : (
            <Box flexDirection="column" marginTop={isTerminal ? 0 : 1}>
              <Box flexDirection="row">
                <Box width={14}>
                  <Text dimColor>Model</Text>
                </Box>
                {cells(COLUMNS.map(([label]) => label), true)}
              </Box>
              {models.map(model => (
                <Box flexDirection="row">
                  <Box width={14} flexDirection="row" gap={1}>
                    <Text color={modelColor(model.model)}>●</Text>
                    <Text>{modelName(model.model)}</Text>
                  </Box>
                  {cells(
                    [
                      String(model.reqs),
                      tokens(model.input),
                      tokens(model.cacheRead),
                      tokens(model.cacheWrite),
                      tokens(model.output),
                      hitRate(model),
                      model.isPriced ? usd(model.usd) : 'n/a',
                    ],
                    false,
                  )}
                </Box>
              ))}
            </Box>
          )}
        </Box>
      )
    }

    const five = list.find(limit => limit.kind === 'five_hour')
    const tz = data?.tzOffsetMin ?? 0
    const windows: Array<[string, UsagePeriod | null, UsageLimit | undefined, number]> = [
      ['5-hour window', data?.window ?? null, five, 5 * HOUR],
      ['Weekly window', data?.week ?? null, weekLimit(list), 7 * DAY],
    ]
    if (fableLimit(list) || (data?.fableWeek?.usd ?? 0) > 0) {
      windows.push(['Weekly · Fable', data?.fableWeek ?? null, fableLimit(list), 7 * DAY])
    }
    // A wide terminal lays the windows side by side; each needs the table's 80 columns.
    const GAP = 4
    const sideWidth = Math.floor((full - GAP * (windows.length - 1)) / windows.length)
    const isSideBySide = isTerminal && sideWidth >= 82
    const sections = windows.map(([title, period, limit, lengthMs]) =>
      section(title, period, paceColor(limit, lengthMs, now), forecast(limit, lengthMs, now, tz), isSideBySide ? sideWidth : width),
    )

    return (
      <Box flexDirection="column" gap={1} paddingX={1}>
        {row(
          <Text>
            <Text bold>API equivalent</Text>
            <Text dimColor>
              {'  '}cache {leftMs === undefined ? '—' : leftMs > 0 ? `${Math.ceil(leftMs / MINUTE)} min left` : 'expired'}
            </Text>
          </Text>,
          <Button
            key="close"
            plain
            dimColor
            label="✕"
            onPress={() => void update($, isOpen, () => false)}
          />,
          // Keep clear of the band's own [-] mark in the top right corner of a wide terminal.
          isSideBySide ? full - 6 : width,
        )}
        {isSideBySide ? (
          <Box flexDirection="row" gap={GAP}>
            {sections}
          </Box>
        ) : (
          sections
        )}
        {failure && <Text color={DANGER}>Scan error: {failure}</Text>}
        <Text dimColor>At API list prices · all sessions and subagents included</Text>
      </Box>
    )
  })
}
