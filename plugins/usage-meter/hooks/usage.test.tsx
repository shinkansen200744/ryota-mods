import { expect, mock, test } from 'claude-code/testing'
import {
  hasRoom,
  isNewWindow,
  judgeStop,
  mergeStopLog,
  parseStopLine,
  STOP_LOG_HEADER,
  stopLogLine,
  stopMessage,
} from './autostop'

const PANE = {
  plugin: 'usage-meter',
  component: 'Pane',
  requestId: 'usage-meter',
  props: {
    title: '使用量',
    isFocused: false,
    bodyColumns: 30,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 20 },
    view: {},
  },
} as const

test('データが無ければ案内を出す', async ($, on) => {
  mock.clock(on, { now: 1_700_000_000_000 })
  mock.store(on)
  on('agent.list', () => ({ value: [] }))
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(
    await ui.find({ type: 'Text', text: /まだ使用量のデータがありません/ }),
  ).toBeDefined()
  await ui.unmount()
})

test('保存済みの使用量とリセットまでの時間を描く', async ($, on) => {
  mock.clock(on, { now: 1_700_000_000_000 })
  mock.store(on)
  const at = new Date(1_700_000_000_000 + 2 * 3_600_000).toISOString()
  on('ui.status', () => ({ value: undefined }))
  on('session.measure', () => ({ changed: [] }))
  await $.session.measure({
    rateLimits: [{ kind: 'five_hour', percentUsed: 42, resetsAt: at }],
  } as never)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /42%/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /リセット/ })).toBeDefined()
  await ui.unmount()
})

test('96% で toast を出し、モデルへの注意書きを足す', async ($, on) => {
  mock.clock(on, { now: 1_700_000_000_000 })
  mock.store(on)
  const toasts: string[] = []
  on('ui.toast', (_, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.status', () => ({ value: undefined }))
  on('session.measure', () => ({ changed: [] }))
  on('prompt.compose', () => ({ sections: [] }))
  const at = new Date(1_700_000_000_000 + 3_600_000).toISOString()
  const rateLimits = [{ kind: 'five_hour', percentUsed: 96, resetsAt: at }]

  await $.session.measure({ rateLimits } as never)
  await $.session.measure({ rateLimits } as never)
  expect(toasts.length).toBe(1)
  expect(toasts[0]).toMatch(/95%/)

  const out = await $.prompt.compose({ model: 'm', promptModel: 'm', surfaces: [], tools: [], outputStyle: null, traits: [] } as never)
  const warning = out.sections.find(s => s.id === 'usage-meter:warning')
  expect(warning).toBeDefined()
  // リセット(JST 11/15 8:13)の 2 分後に再開を予約させる（水曜）
  expect(warning?.text).toContain('`15 8 15 11 *`')
  expect(warning?.text).toContain('11/15 (水) 8:15')
})

test('サブエージェントの一覧に description と実行中が出る', async ($, on) => {
  mock.clock(on, { now: 1_700_000_000_000 })
  mock.store(on)
  on('agent.list', () => ({
    value: [
      { id: 'a1', description: '調査タスク', type: 'Explore', status: 'running' },
    ],
  }))
  on('turn.complete', () => ({ text: '' }))
  await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 't', reason: 'answer' } as never)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /調査タスク/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /実行中/ })).toBeDefined()
  await ui.unmount()
})

test('サブエージェントが完了すると toast を出す', async ($, on) => {
  mock.clock(on, { now: 1_700_000_000_000 })
  mock.store(on)
  const toasts: string[] = []
  let status: 'running' | 'completed' = 'running'
  on('ui.toast', (_, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.notify', () => ({ value: {} as never }))
  on('process.run', () => ({ value: { exitCode: 0, stdout: '', stderr: '' } as never }))
  on('agent.list', () => ({
    value: [{ id: 'a1', description: '調査タスク', type: 'Explore', status }],
  }))
  on('turn.complete', () => ({ text: '' }))
  const done = {
    answer: '',
    durationMs: 1,
    isAborted: false,
    turnId: 't',
    reason: 'answer',
  } as never
  await $.turn.complete(done)
  status = 'completed'
  await $.turn.complete(done)
  await $.turn.complete(done)
  expect(toasts.length).toBe(1)
  expect(toasts[0]).toMatch(/サブエージェント完了: 調査タスク/)
})

test('spawn の model が保存され、実行中は 1 行で出る', async ($, on) => {
  mock.clock(on, { now: 1_700_000_000_000 })
  mock.store(on)
  on('agent.list', () => ({
    value: [{ id: 'a1', description: '調査タスク', type: 'Explore', status: 'running' }],
  }))
  on('agent.spawn', () => ({ agentId: 'a1', model: 'claude-sonnet-5-5' }) as never)
  await $.agent.spawn({ description: '調査タスク', prompt: 'p' } as never)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /調査タスク/ })).toBeDefined()
  await ui.unmount()
})

test('モデル色の凡例が出る', async ($, on) => {
  mock.clock(on, { now: 1_700_000_000_000 })
  mock.store(on)
  on('agent.list', () => ({ value: [] }))
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  for (const n of ['Opus', 'Sonnet', 'Haiku', 'Fable']) {
    expect(await ui.find({ type: 'Text', text: n })).toBeDefined()
  }
  await ui.unmount()
})

// --- 自動ストップ ---
const NOW = 1_700_000_000_000
const past = new Date(NOW - 3_600_000).toISOString()
const future = new Date(NOW + 3_600_000).toISOString()
const future2 = new Date(NOW + 6 * 3_600_000).toISOString()
const mine = (five: number, week = 10, r5 = future) => [
  { kind: 'five_hour', percentUsed: five, resetsAt: r5 },
  { kind: 'seven_day', percentUsed: week, resetsAt: future },
]
const other = (five: number, week: number, r5 = future, rw = future) => ({
  at: NOW,
  limits: [
    { kind: 'five_hour', percentUsed: five, resetsAt: r5 },
    { kind: 'seven_day', percentUsed: week, resetsAt: rw },
  ],
})

test('自動ストップ: 5h 95 ちょうどで止め、94.9 では止めない', async () => {
  const acc = { me: 'a', b: other(10, 10) }
  expect(judgeStop(mine(95), acc, NOW)).toMatchObject({ me: 'a', five: 95, key: future })
  expect(judgeStop(mine(94.9), acc, NOW)).toBeUndefined()
  // 週間 100% でも 5h が低ければ止めない
  expect(judgeStop(mine(50, 100), acc, NOW)).toBeUndefined()
})

test('自動ストップ: リセット済みの 5h は 0 扱い', async () => {
  expect(judgeStop(mine(99, 10, past), { me: 'a' }, NOW)).toBeUndefined()
  expect(judgeStop([], { me: 'a' }, NOW)).toBeUndefined()
  expect(judgeStop(mine(99), { me: '' }, NOW)).toBeUndefined()
})

test('自動ストップ: 余裕あり（もう片方 5h 95 / 週 85 ちょうどは余裕あり）', async () => {
  const push = (o: ReturnType<typeof other> | undefined) =>
    hasRoom(judgeStop(mine(97), { me: 'a', ...(o ? { b: o } : {}) }, NOW)!)
  expect(push(other(95, 85))).toBe(true)
  expect(push(other(96, 85))).toBe(false)
  expect(push(other(50, 86))).toBe(false)
  // もう片方がリセット済みなら 0 扱いで送る
  expect(push(other(99, 99, past, past))).toBe(true)
  // 記録なしは止めるが余裕ありとは書かない
  const none = judgeStop(mine(97), { me: 'a' }, NOW)!
  expect(none.otherFive).toBeUndefined()
  expect(hasRoom(none)).toBe(false)
  expect(stopMessage(none)).toBe('いったんストップ（5時間 97% に到達）')
})

test('自動ストップ: 同じ枠では 2 回止めず、枠が変われば再び止める', async () => {
  const a = judgeStop(mine(96), { me: 'a' }, NOW)!
  expect(isNewWindow(a, undefined)).toBe(true)
  expect(isNewWindow(a, a.key)).toBe(false)
  const next = judgeStop(mine(96, 10, future2), { me: 'a' }, NOW)!
  expect(isNewWindow(next, a.key)).toBe(true)
})

test('自動ストップ: 文面と記録の中身（B 視点・記録なしは -）', async () => {
  const info = judgeStop(mine(96, 30), { me: 'b', a: other(20, 40) }, NOW)!
  expect(stopMessage(info)).toBe('いったんストップ（5時間 96% に到達。A に余裕あり：5h 20% / 週 40%）')
  const line = stopLogLine(info, new Date(2026, 0, 2, 3, 4, 5), 'C:/x', 'sid')
  expect(line.split('\t')).toEqual([
    '2026-01-02 03:04',
    'account=B',
    '5h=96%',
    'week=30%',
    'other_5h=20%',
    'other_week=40%',
    'cwd=C:/x',
    'session=sid',
  ])
  const bare = stopLogLine(judgeStop(mine(96), { me: 'a' }, NOW)!, new Date(2026, 0, 2), 'c', '')
  expect(bare).toContain('other_5h=-\tother_week=-')
  expect(bare.endsWith('session=-')).toBe(true)
})

test('自動ストップ: もう片方の記録が読めていない間は tool.call を止めない', async ($, on) => {
  mock.clock(on, { now: NOW })
  mock.store(on)
  on('ui.toast', () => ({ value: undefined }))
  on('ui.status', () => ({ value: undefined }))
  on('agent.list', () => ({ value: [] }))
  on('session.measure', () => ({ changed: [] }))
  on('tool.call', () => ({ result: 'ok' }) as never)
  await $.session.measure({ rateLimits: mine(97) } as never)
  const call = { tool: 'Bash', input: { command: 'ls' } } as never
  // accounts.me が空の間は判定しない
  expect('deny' in (await $.tool.call(call))).toBe(false)
})

const L = (at: Date, sid: string, acc = 'a') =>
  stopLogLine(judgeStop(mine(96), { me: acc as 'a' }, NOW)!, at, 'C:/w', sid)

test('停止記録: 同じセッションは置き換え・別セッションは追加', async () => {
  const now = new Date(2026, 0, 2, 12, 0)
  const t1 = L(new Date(2026, 0, 2, 10, 0), 's1')
  const t2 = L(new Date(2026, 0, 2, 11, 0), 's2')
  let txt = mergeStopLog('', t1, now)
  txt = mergeStopLog(txt, t2, now)
  expect(txt.split('\n')).toEqual([STOP_LOG_HEADER, t1, t2, ''])
  const t1b = L(new Date(2026, 0, 2, 11, 30), 's1', 'b')
  expect(mergeStopLog(txt, t1b, now).split('\n')).toEqual([STOP_LOG_HEADER, t2, t1b, ''])
})

test('停止記録: 24 時間より古い行・# 行・おかしな行は消える', async () => {
  const now = new Date(2026, 0, 3, 12, 0)
  const old = L(new Date(2026, 0, 2, 11, 59), 'old')
  const edge = L(new Date(2026, 0, 2, 12, 0), 'edge')
  const bad = ['garbage', '2026-01-03 10:00\taccount=A', 'xx\tsession=z', ''].join('\n')
  const fresh = L(new Date(2026, 0, 3, 9, 0), 'fresh')
  const out = mergeStopLog(`# x\n${old}\n${edge}\n${bad}\n${fresh}\r\n`, L(now, 'n'), now)
  expect(out.split('\n')).toEqual([STOP_LOG_HEADER, edge, fresh, L(now, 'n'), ''])
  expect(parseStopLine('# c')).toBeUndefined()
  expect(parseStopLine(fresh)?.session).toBe('fresh')
})

test('Fable 枠は 0% の間は出さず、使ってから出す', async ($, on) => {
  mock.clock(on, { now: 1_700_000_000_000 })
  mock.store(on)
  const at = new Date(1_700_000_000_000 + 2 * 3_600_000).toISOString()
  const status: (string | undefined)[] = []
  on('ui.status', (_$, e) => {
    status.push((e as { text?: string }).text)
    return { value: undefined }
  })
  on('session.measure', () => ({ changed: [] }))
  await $.session.measure({
    rateLimits: [
      { kind: 'five_hour', percentUsed: 42, resetsAt: at },
      { kind: 'seven_day_fable', percentUsed: 0, resetsAt: at },
    ],
  } as never)
  let ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /Fable枠/ })).toBeUndefined()
  await ui.unmount()

  await $.session.measure({
    rateLimits: [
      { kind: 'five_hour', percentUsed: 42, resetsAt: at },
      { kind: 'seven_day_fable', percentUsed: 13, resetsAt: at },
    ],
  } as never)
  ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /Fable枠（週間）/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /13%/ })).toBeDefined()
  await ui.unmount()
})
