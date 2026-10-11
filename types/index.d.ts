export type Limit = { kind: string; percentUsed: number; resetsAt?: string }
export type Measure = {
  context: { tokens?: number; window: number; percent?: number }
  rateLimits: Limit[]
}
export type TurnTokens = { input: number; output: number; cacheRead: number; cacheWrite: number }
export type Style = 'nerd' | 'unicode' | 'ascii'

declare module 'claude-code' {
  interface PluginState {
    'cc-gauge': {
      measure: Measure | null
      turn: TurnTokens | null
      now: number
      phase: number
      style: Style
    }
  }
}
