import { expect, mock, test } from 'claude-code/testing'

const NOW = Date.parse('2026-10-22T18:00:00Z')
const row = { model: 'claude-opus-5-5', usd: 12.5, reqs: 40, input: 100, output: 50000, cacheRead: 9000000, cacheWrite: 200000, isPriced: true }
const period = { start: NOW - 3600e3, end: NOW + 3600e3, startLabel: '17:00', endLabel: '22:00', usd: 12.5, models: [row], isGuessed: false }
const SCAN = { now: NOW, window: period, week: period, cache: { lastTs: NOW, ttlMin: 60 }, tzOffsetMin: 180, scannedMs: 5 }

const band = (bodyColumns: number) =>
  ({ hasSurvey: false, isWorking: false, maxRows: 40, bodyColumns, scroll: { top: 0, bodyRows: 40, contentRows: 40 }, view: {} }) as never

async function openCard($: Parameters<Parameters<typeof test>[1]>[0], on: Parameters<Parameters<typeof test>[1]>[1]) {
  mock.clock(on, { now: NOW })
  on('session.usage', async () => ({ value: { startedAt: 0, context: { window: 1000000 }, rateLimits: [] } }) as never)
  on('session.id', async () => ({ value: 'test-session' }) as never)
  on('command.run', async () => ({ text: '' }))
  on('process.run', async () => ({ value: { exitCode: 0, stdout: JSON.stringify(SCAN), stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }) as never)
  await $.command.run({ command: 'usage-footer', args: '' } as never)
}

test('a narrow terminal drops the optional columns and keeps cost and total', async ($, on) => {
  await openCard($, on)
  const ui = await $.ui.mount({ plugin: 'usage-footer', surface: 'terminal', component: 'AbovePrompt', props: band(60) })
  expect(await ui.find({ type: 'Text', text: /^Input$/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /^Cache write$/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /^Total$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^Cost$/ })).toBeDefined()
  await ui.unmount()
})

test('a medium terminal keeps every column', async ($, on) => {
  await openCard($, on)
  const ui = await $.ui.mount({ plugin: 'usage-footer', surface: 'terminal', component: 'AbovePrompt', props: band(130) })
  expect(await ui.find({ type: 'Text', text: /^Input$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^Cache write$/ })).toBeDefined()
  await ui.unmount()
})

test('a wide terminal still draws both windows', async ($, on) => {
  await openCard($, on)
  const ui = await $.ui.mount({ plugin: 'usage-footer', surface: 'terminal', component: 'AbovePrompt', props: band(200) })
  expect(await ui.find({ type: 'Text', text: /5-hour window/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /Weekly window/ })).toBeDefined()
  await ui.unmount()
})

test('the desktop card keeps every column', async ($, on) => {
  await openCard($, on)
  const ui = await $.ui.mount({ plugin: 'usage-footer', surface: 'desktop', component: 'AbovePrompt', props: band(100) })
  expect(await ui.find({ type: 'Text', text: /^Input$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^Cache write$/ })).toBeDefined()
  await ui.unmount()
})
