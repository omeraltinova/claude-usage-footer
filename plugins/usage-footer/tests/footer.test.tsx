import { expect, mock, test } from 'claude-code/testing'

const SCAN = {
  now: 1790962806153,
  window: {
    start: 1790949600000,
    end: 1790967600000,
    startLabel: '17:00',
    endLabel: '22:00',
    usd: 61.33,
    isGuessed: false,
    models: [
      { model: 'claude-opus-5-5', usd: 61.13, reqs: 452, input: 904, output: 514608, cacheRead: 213608413, cacheWrite: 1038622, isPriced: true },
      { model: 'claude-haiku-4-5-20251001', usd: 0.2, reqs: 13, input: 108, output: 3025, cacheRead: 703192, cacheWrite: 75820, isPriced: true },
    ],
  },
  week: {
    start: 1790888400000,
    end: 1790974800000,
    startLabel: '00:00',
    endLabel: '00:00',
    usd: 100.3,
    models: [{ model: 'claude-opus-5-5', usd: 100.3, reqs: 913, input: 1836, output: 946153, cacheRead: 321089743, cacheWrite: 2185213, isPriced: true }],
  },
  cache: { lastTs: 1790962805617, ttlMin: 60 },
  scannedMs: 20,
}

for (const surface of ['terminal', 'desktop'] as const) {
  test(`footer before the first scan draws on ${surface}`, async ($, on) => {
    mock.clock(on, { now: SCAN.now })
    const ui = await $.ui.mount({ plugin: 'usage-footer', surface, component: 'SessionMode', props: { modes: ['focus'] } })
    expect(await ui.find({ type: 'Text', text: surface === 'terminal' ? /cache —/ : /◷/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /focus/ })).toBeDefined()
    await ui.unmount()
  })

  test(`footer and pane draw a scan on ${surface}`, async ($, on) => {
    mock.clock(on, { now: SCAN.now })
    on('ui.open', async () => ({ value: { isPlaced: true } }) as never)
    on('command.run', async () => ({ text: '' }))
    on('session.usage', async () => ({ value: { startedAt: 0, context: { tokens: 237900, window: 1000000, percent: 24 }, rateLimits: [{ kind: 'five_hour', percentUsed: 42, resetsAt: '2026-10-02T18:00:00Z' }] } }) as never)
    on('ui.render', async ($, e) => { const { Text } = $.ui.resolve(e as never) as never as { Text: never }; return h(Text, null, 'engine') as never })
    on('session.id', async () => ({ value: 'test-session' }) as never)
    on('process.run', async () => ({
      value: {
        exitCode: 0,
        stdout: JSON.stringify(SCAN),
        stderr: '',
        isStdoutTruncated: false,
        isStderrTruncated: false,
      },
    }) as never)
    await $.command.run({ command: 'usage-footer', args: '' } as never)

    const footer = await $.ui.mount({ plugin: 'usage-footer', surface, component: 'SessionMode', props: { modes: [] } })
    expect(await footer.find({ type: 'Text', text: surface === 'terminal' ? /5h \$61\.33/ : /5h \$61/ })).toBeDefined()
    expect(await footer.find({ type: 'Text', text: surface === 'terminal' ? /7d \$100\.30/ : /7d \$100/ })).toBeDefined()

    const band = await $.ui.mount({
      plugin: 'usage-footer',
      surface,
      component: 'AbovePrompt',
      props: { hasSurvey: false, isWorking: false, maxRows: 30, bodyColumns: 80, scroll: { top: 0, bodyRows: 30, contentRows: 30 }, view: {} } as never,
    })
    expect(await band.find({ type: 'Text', text: /Haiku 4\.5/ })).toBeDefined()
    await band.press({ key: 'close' })
    expect(await band.find({ type: 'Text', text: /Haiku 4\.5/ })).toBeUndefined()
    await band.unmount()
    await footer.unmount()
  })
}
