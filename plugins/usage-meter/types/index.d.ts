export type UsageLimit = {
  kind: string
  percentUsed: number
  resetsAt?: string
}

/** ペインに出すサブエージェント 1 件 */
export type UsageAgent = {
  id: string
  description: string
  type: string
  status: string
  startedAt?: number
  tool?: string
  model?: string
}

/** エージェントごとに自前で覚える開始時刻と今のツール */
export type UsageAgentMeta = {
  startedAt?: number
  tool?: string
  model?: string
}

/** アカウントごとに最後に記録した使用量（ccs の A/B） */
export type UsageSnapshot = {
  at: number
  limits: UsageLimit[]
}

export type UsageAccounts = {
  /** いま動いているアカウント（'a' / 'b'） */
  me: string
  a?: UsageSnapshot
  b?: UsageSnapshot
}

/** 止めた時点の使用量（無い値は省く） */
export type UsageStopInfo = {
  /** 止めたアカウント（'a' / 'b'） */
  me: string
  /** いまの 5h / 週間 */
  five: number
  week?: number
  /** もう片方の 5h / 週間（記録が無ければ省く） */
  otherFive?: number
  otherWeek?: number
  /** 止めた 5h 枠の resetsAt（無ければ 'none'） */
  key: string
}

/** 自動ストップの状態。lastKey の枠では止めない */
export type UsageAutoStop = {
  phase: 'none' | 'stopped' | 'logged'
  info?: UsageStopInfo
  lastKey?: string
}

declare module 'claude-code' {
  interface PluginState {
    'usage-meter': {
      limits: Shaped<UsageLimit[]>
      now: Shaped<number>
      /** 95% 超えを通知済みの `kind|resetsAt` */
      notified: Shaped<string[]>
      /** メインループのモデル（`$.session.model()` の値） */
      mainModel: Shaped<string>
      agents: Shaped<UsageAgent[]>
      agentMeta: Shaped<Record<string, UsageAgentMeta>>
      /** A/B 両アカウントの使用量（$HOME\.claude-usage-a|b.json から読む） */
      /** 自動ストップの状態（セッション内で 1 回だけ止める） */
      autoStop: Shaped<UsageAutoStop>
      accounts: Shaped<UsageAccounts>
    }
  }
}
