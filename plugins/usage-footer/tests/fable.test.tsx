import { expect, mock, test } from 'claude-code/testing'

const NOW = Date.parse('2026-10-02T18:00:00Z')
const fableRow = { model: 'claude-fable-5-1', usd: 40.5, reqs: 120, input: 500, output: 90000, cacheRead: 30000000, cacheWrite: 400000, isPriced: true }
const opusRow = { model: 'claude-opus-5-5', usd: 61.13, reqs: 452, input: 904, output: 514608, cacheRead: 213608413, cacheWrite: 1038622, isPriced: true }
const period = (models: unknown[], usd: number) => ({ start: NOW - 3600e3, end: NOW + 3600e3, startLabel: '17:00', endLabel: '22:00', usd, models, isGuessed: false })
const SCAN = {
  now: NOW,
  window: period([opusRow, fableRow], 101.63),
  week: period([opusRow, fableRow], 101.63),
  fableWeek: period([fableRow], 40.5),
  cache: { lastTs: NOW - 600e3, ttlMin: 60 },
  tzOffsetMin: 180,
  scannedMs: 20,
}
const LIMITS = [
  { kind: 'five_hour', percentUsed: 44, resetsAt: '2026-10-02T20:00:00Z' },
  { kind: 'seven_day', percentUsed: 23, resetsAt: '2026-10-08T08:00:00Z' },
  { kind: 'seven_day_fable', percentUsed: 61, resetsAt: '2026-10-07T08:00:00Z' },
]

for (const surface of ['terminal', 'desktop'] as const) {
  test(`fable footer and card draw on ${surface}`, async ($, on) => {
    mock.clock(on, { now: NOW })
    on('session.usage', async () => ({ value: { startedAt: 0, context: { window: 1000000 }, rateLimits: LIMITS } }) as never)
    on('session.model', async () => ({ value: 'claude-fable-5-1' }) as never)
    on('session.id', async () => ({ value: 'test-session' }) as never)
    on('command.register', async () => ({ value: {} }) as never)
    on('process.run', async () => ({ value: { exitCode: 0, stdout: JSON.stringify(SCAN), stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }) as never)
    on('session.start', async (_$, e) => ({ cwd: (e as { cwd: string }).cwd }) as never)
    on('command.run', async () => ({ text: '' }))
    on('ui.render', async ($, e) => { const { Text } = $.ui.resolve(e as never) as never as { Text: never }; return h(Text, null, 'engine') as never })

    await $.session.start({ cwd: '.', source: 'startup' } as never)
    await $.command.run({ command: 'usage-footer', args: '' } as never)

    const footer = await $.ui.mount({ plugin: 'usage-footer', surface, component: 'SessionMode', props: { modes: [] } })
    expect(await footer.find({ type: 'Text', text: surface === 'terminal' ? /7d Fable \$40\.50/ : /F \$41/ })).toBeDefined()
    expect(await footer.find({ type: 'Text', text: surface === 'terminal' ? /5h \$101\.63/ : /5h \$102/ })).toBeDefined()

    const band = await $.ui.mount({
      plugin: 'usage-footer',
      surface,
      component: 'AbovePrompt',
      props: { hasSurvey: false, isWorking: false, maxRows: 40, bodyColumns: 100, scroll: { top: 0, bodyRows: 40, contentRows: 40 }, view: {} } as never,
    })
    expect(await band.find({ type: 'Text', text: /Weekly · Fable/ })).toBeDefined()
    expect(await band.find({ type: 'Text', text: /Fable 5\.1/ })).toBeDefined()
    expect(await band.find({ type: 'Text', text: /\$40\.50/ })).toBeDefined()
    await footer.unmount()
    await band.unmount()
  })
}
