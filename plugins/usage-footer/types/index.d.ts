export type UsageModelRow = {
  model: string
  usd: number
  reqs: number
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  isPriced: boolean
}

export type UsagePeriod = {
  start: number
  end: number
  startLabel: string
  endLabel: string
  usd: number
  models: UsageModelRow[]
  isGuessed?: boolean
}

export type UsageScan = {
  now: number
  window: UsagePeriod | null
  week: UsagePeriod
  fableWeek?: UsagePeriod
  cache: { lastTs: number; ttlMin: number } | null
  tzOffsetMin?: number
  scannedMs: number
}

export type UsageLimit = { kind: string; percentUsed: number; resetsAt?: string }

declare module 'claude-code' {
  interface PluginState {
    'usage-footer': {
      scan: UsageScan | null
      limits: UsageLimit[]
      lastCall: number
      isWorking: boolean
      model: string
      error: string | null
      isOpen: boolean
    }
  }
}
