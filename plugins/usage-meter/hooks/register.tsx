import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { UsageAccounts, UsageAgent, UsageLimit, UsageAutoStop } from '../types'
import { isNewWindow, judgeStop, stopLogLine, stopLogScript, stopMessage } from './autostop'

type Engine = EngineInterface

const PANE = 'usage-meter'
const TITLE = '使用量'
// 幅の希望（ドック時。最小 24）。既定は端末幅の最大45%
const PANE_COLUMNS = 30
// 枠線と左右の余白で 4 列使うので、バーは 26
const BAR_WIDTH = 26
const HOUR = 3_600_000
const LONG_TURN_MS = 30_000
const WINDOW_MS: Record<string, number> = {
  five_hour: 5 * HOUR,
  seven_day: 7 * 24 * HOUR,
}
const LABEL: Record<string, string> = {
  five_hour: '5時間枠',
  seven_day: '週間枠',
  spend_limit: '利用上限',
}
const ORDER = ['five_hour', 'seven_day', 'fable', 'spend_limit']

// Fable 専用の枠（kind に fable を含むもの。例: seven_day_fable）
const isFable = (kind: string) => kind.toLowerCase().includes('fable')
const isWeekKind = (kind: string) =>
  kind === 'seven_day' || (isFable(kind) && !kind.includes('five_hour'))
const labelOf = (kind: string) =>
  LABEL[kind] ?? (isFable(kind) ? (isWeekKind(kind) ? 'Fable枠（週間）' : 'Fable枠') : kind)
const windowOf = (kind: string): number | undefined =>
  WINDOW_MS[kind] ??
  (isFable(kind) ? (isWeekKind(kind) ? WINDOW_MS.seven_day : WINDOW_MS.five_hour) : undefined)
const orderOf = (kind: string) => {
  const i = ORDER.indexOf(isFable(kind) ? 'fable' : kind)
  return i < 0 ? 99 : i
}
// Fable 枠は Fable を使って数字が動いてから出す（0% の間は出さない）
const shown = (list: UsageLimit[]) =>
  list.filter(l => !isFable(l.kind) || l.percentUsed > 0)
const WARN_PCT = 95
const CLEAR_PCT = 90
// 自動ストップの記録先（$HOME 直下のファイル名。パスは PowerShell 側で組み立てる）
const WATCHED = ['five_hour', 'seven_day']
const FINAL = ['completed', 'failed', 'killed']

// 形を変えたらタグも変える（古い保存値は initial として読まれる）。
const limits = atom({ plugin: 'usage-meter', key: 'limits' } as const, [], {
  shape: 'limits-1',
})
const nowAtom = atom({ plugin: 'usage-meter', key: 'now' } as const, 0, {
  shape: 'now-1',
})
const notified = atom({ plugin: 'usage-meter', key: 'notified' } as const, [], {
  shape: 'notified-1',
})
const agents = atom({ plugin: 'usage-meter', key: 'agents' } as const, [], {
  shape: 'agents-1',
})
const mainModel = atom({ plugin: 'usage-meter', key: 'mainModel' } as const, '', {
  shape: 'main-model-1',
})
const agentMeta = atom({ plugin: 'usage-meter', key: 'agentMeta' } as const, {}, {
  shape: 'agent-meta-1',
})
// 自動ストップの状態（セッション内で 1 回だけ止める）。none → stopped（止めた）→ logged（記録済み）
const autoStop = atom({ plugin: 'usage-meter', key: 'autoStop' } as const, { phase: 'none' }, {
  shape: 'auto-stop-1',
})
const accounts = atom({ plugin: 'usage-meter', key: 'accounts' } as const, { me: '' }, {
  shape: 'accounts-1',
})

// ccs の A/B 判定（CLAUDE_CONFIG_DIR が .claude-b なら B）。PowerShell 側で使う
const PS_ACCOUNT = "$me = if ($env:CLAUDE_CONFIG_DIR -like '*.claude-b') { 'b' } else { 'a' }"

const MODEL_FAMILIES = [
  { key: 'opus', name: 'Opus', color: '#c084fc' },
  { key: 'sonnet', name: 'Sonnet', color: '#60a5fa' },
  { key: 'haiku', name: 'Haiku', color: '#4ade80' },
  { key: 'fable', name: 'Fable', color: '#fbbf24' },
]

// モデルの id / エイリアスから色と短い名前を決める（例: claude-opus-5-5 → Opus 5.5）
function modelInfo(model: string | undefined): { name: string; color: string } {
  const raw = (model ?? '').trim()
  if (!raw) return { name: '?', color: 'gray' }
  const lower = raw.toLowerCase()
  const fam = MODEL_FAMILIES.find(f => lower.includes(f.key))
  if (!fam) return { name: raw.slice(0, 12), color: 'gray' }
  // 語の直後の「5-5」「5.5」「5」だけ版とみなす（日付や [1m] は拾わない）
  const m = new RegExp(`${fam.key}[-. ]?(\\d{1,2})(?:[-.](\\d{1,2}))?(?!\\d)`).exec(lower)
  const ver = m ? (m[2] ? `${m[1]}.${m[2]}` : m[1]) : ''
  return { name: ver ? `${fam.name} ${ver}` : fam.name, color: fam.color }
}

const clamp = (n: number, lo: number, hi: number) =>
  Math.min(hi, Math.max(lo, n))
const pad2 = (n: number) => String(n).padStart(2, '0')

// 日本時間 (UTC+9 固定) の各要素
const jst = (ms: number) => {
  const d = new Date(ms + 9 * HOUR)
  return {
    wday: d.getUTCDay(),
    month: d.getUTCMonth() + 1,
    day: d.getUTCDate(),
    hour: d.getUTCHours(),
    min: d.getUTCMinutes(),
  }
}

const parseReset = (l: UsageLimit): number | undefined => {
  if (!l.resetsAt) return undefined
  const t = Date.parse(l.resetsAt)
  return Number.isNaN(t) ? undefined : t
}

const normalize = (list: readonly UsageLimit[] | undefined): UsageLimit[] =>
  (list ?? []).map(l => ({
    kind: l.kind,
    percentUsed: l.percentUsed,
    ...(l.resetsAt ? { resetsAt: l.resetsAt } : {}),
  }))

const sorted = (list: UsageLimit[]) =>
  [...list].sort((a, b) => orderOf(a.kind) - orderOf(b.kind))

const levelColor = (pct: number) =>
  pct >= 80 ? '#f87171' : pct >= 50 ? '#facc15' : '#4ade80'

const PARTIAL = ['', '▏', '▎', '▍', '▌', '▋', '▊', '▉']

// 1/8 セル単位でなめらかに伸びるバー
const bar = (pct: number, width: number) => {
  const eighths = clamp(
    Math.round((clamp(pct, 0, 100) / 100) * width * 8),
    0,
    width * 8,
  )
  const full = Math.floor(eighths / 8)
  const part = PARTIAL[eighths % 8] ?? ''
  return {
    on: '█'.repeat(full) + part,
    off: '░'.repeat(Math.max(0, width - full - (part ? 1 : 0))),
  }
}

const thinBar = (pct: number, width: number) => {
  const filled = clamp(Math.round((clamp(pct, 0, 100) / 100) * width), 0, width)
  return { on: '▃'.repeat(filled), off: '▁'.repeat(width - filled) }
}

const remainShort = (ms: number, isWeek: boolean) => {
  const mins = Math.max(0, Math.ceil(ms / 60_000))
  const d = Math.floor(mins / 1440)
  const h = Math.floor((mins % 1440) / 60)
  const m = mins % 60
  if (isWeek && d > 0) return `${d}d${h}h`
  return h > 0 ? `${h}h${pad2(m)}m` : `${m}m`
}

const WEEKDAYS = ['日', '月', '火', '水', '木', '金', '土']

// 週間枠は「(日)23:00」、5時間枠は「23:00」
const resetClock = (at: number, isWeek: boolean) => {
  const j = jst(at)
  const hm = `${j.hour}:${pad2(j.min)}`
  return isWeek ? `(${WEEKDAYS[j.wday]})${hm}` : hm
}

const RESUME_PROMPT = '使用量がリセットされました。中断した作業の続きを再開してください。'
const RESUME_DELAY_MS = 2 * 60_000

// 高い窓のうち最も遅いリセットの 2 分後（JST）を再開時刻にして、cron と表示用の文字列を返す
const resumePlan = (high: UsageLimit[]) => {
  const times = high.map(parseReset).filter((t): t is number => t !== undefined)
  if (times.length === 0) return undefined
  const at = Math.max(...times) + RESUME_DELAY_MS
  const j = jst(at)
  return {
    cron: `${j.min} ${j.hour} ${j.day} ${j.month} *`,
    label: `${j.month}/${j.day} (${WEEKDAYS[j.wday]}) ${j.hour}:${pad2(j.min)}`,
  }
}

// 再開予約の指示文。再開時刻が取れなければ空
const resumeText = (high: UsageLimit[]) => {
  const plan = resumePlan(high)
  if (!plan) return ''
  return `中断する前に、CronCreate で再開を1回だけ予約すること（cron: \`${plan.cron}\`、recurring: false、prompt: 『${RESUME_PROMPT}』）。先に CronList を見て、同じ prompt の予約が既にあれば作らないこと。予約したら再開時刻（${plan.label}）をユーザーに伝えること。`
}

const elapsedText = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000))
  return s < 60 ? `${s}秒` : `${Math.floor(s / 60)}分`
}

const durationText = (ms: number) => {
  const s = Math.round(ms / 1000)
  return s < 60 ? `${s}秒` : `${Math.floor(s / 60)}分${pad2(s % 60)}秒`
}

// 全角を 2 列として数え、max 列に収まるよう末尾を「…」で切る
const charWidth = (ch: string) => ((ch.codePointAt(0) ?? 0) >= 0x2e80 ? 2 : 1)

// 表示幅（全角 2 列）
const colWidth = (text: string) => {
  let w = 0
  for (const ch of text) w += charWidth(ch)
  return w
}

const cut = (text: string, max: number) => {
  let w = 0
  let out = ''
  for (const ch of text) {
    const cw = charWidth(ch)
    if (w + cw > max - 1) return `${out}…`
    w += cw
    out += ch
  }
  return out
}

const warnLimits = (list: UsageLimit[]) =>
  list.filter(l => WATCHED.includes(l.kind) && l.percentUsed >= WARN_PCT)

const warnText = (l: UsageLimit) => {
  const at = parseReset(l)
  const isWeek = l.kind === 'seven_day'
  const clock = at !== undefined ? `、リセット ${resetClock(at, isWeek)}` : ''
  return `${LABEL[l.kind] ?? l.kind} ${Math.round(l.percentUsed)}%${clock}`
}

const statusLine = (list: UsageLimit[], now: number): string | undefined => {
  const five = list.find(l => l.kind === 'five_hour')
  const week = list.find(l => l.kind === 'seven_day')
  const mini = (pct: number) => {
    const n = clamp(Math.round(pct / 20), 0, 5)
    return '▰'.repeat(n) + '▱'.repeat(5 - n)
  }
  const parts: string[] = []
  if (five) {
    const at = parseReset(five)
    let left = ''
    if (at !== undefined) {
      const mins = Math.max(0, Math.ceil((at - now) / 60_000))
      left = ` (${Math.floor(mins / 60)}:${pad2(mins % 60)})`
    }
    parts.push(`5h ${mini(five.percentUsed)} ${Math.round(five.percentUsed)}%${left}`)
  }
  if (week) {
    parts.push(`週 ${mini(week.percentUsed)} ${Math.round(week.percentUsed)}%`)
  }
  const fable = shown(list).find(l => isFable(l.kind))
  if (fable) {
    parts.push(`Fable ${mini(fable.percentUsed)} ${Math.round(fable.percentUsed)}%`)
  }
  return parts.length ? parts.join(' │ ') : undefined
}

async function refresh($: Engine) {
  const u = await $.session.usage()
  const list = normalize(u.rateLimits)
  await update($, limits, () => list)
  $.ui.status(statusLine(list, await $.clock.now()))
  void saveAccount($, list)
}

const runPs = ($: Engine, script: string) =>
  $.process.run(['powershell.exe', '-NoProfile', '-NonInteractive', '-Command', script], {
    timeoutMs: 15_000,
  })

// いまのアカウントの使用量を $HOME\.claude-usage-a|b.json に書く。失敗は無視
async function saveAccount($: Engine, list: UsageLimit[]) {
  if (list.length === 0) return
  const json = JSON.stringify({ at: await $.clock.now(), limits: list }).replace(/'/g, "''")
  const script =
    `${PS_ACCOUNT}; ` +
    `[IO.File]::WriteAllText("$HOME\\.claude-usage-$me.json", '${json}')`
  await runPs($, script).catch(() => {})
  await loadAccounts($)
}

// A/B 両方の記録を読む。B の記録が無ければ（1アカウント運用なら）表示しない
async function loadAccounts($: Engine) {
  const script =
    `${PS_ACCOUNT}; $r = @{ me = $me }; ` +
    `foreach ($k in 'a','b') { $f = "$HOME\\.claude-usage-$k.json"; ` +
    `if (Test-Path $f) { $r[$k] = Get-Content $f -Raw | ConvertFrom-Json } }; ` +
    `$r | ConvertTo-Json -Depth 6 -Compress`
  try {
    const { exitCode, stdout } = await runPs($, script)
    if (exitCode !== 0) return
    const v = JSON.parse(stdout) as UsageAccounts
    await update($, accounts, () => v)
  } catch {
    // 読めなければ前回の値のまま
  }
}

// もう片方のアカウントで、今のフォルダの会話の続きを新しいタブに開く（ccs の手動切り替えと同じ）
async function openOther($: Engine, target: string) {
  const dir = await $.session.cwd()
  try {
    await $.process.run(
      ['wt.exe', 'new-tab', '-d', dir, 'pwsh.exe', '-NoExit', '-Command', `ccs ${target} -c`],
      { timeoutMs: 15_000 },
    )
    $.ui.toast(
      `新しいタブでアカウント ${target.toUpperCase()} の続きを開きました。このタブは /exit で閉じてください`,
    )
  } catch {
    $.ui.toast('新しいタブを開けませんでした')
  }
}

// リセット時刻を過ぎた窓は 0% とみなす
const pctNow = (l: UsageLimit | undefined, now: number) => {
  if (!l) return undefined
  const at = parseReset(l)
  return at !== undefined && at <= now ? 0 : l.percentUsed
}

// 5h が 95% 以上で、まだ止めていない枠なら止める（phase を stopped にして StopInfo を返す）
async function checkAutoStop($: Engine) {
  const st = await read($, autoStop)
  const info = judgeStop(await read($, limits), await read($, accounts), await $.clock.now())
  if (!info || !isNewWindow(info, st.lastKey)) return undefined
  await update($, autoStop, () => ({ phase: 'stopped', info, lastKey: info.key }))
  return info
}

// 止めたあとのターン完了で、記録ファイル（止まったセッションの一覧）に自分の行を入れる。失敗は無視
async function logAutoStop($: Engine, st: UsageAutoStop) {
  await update($, autoStop, () => ({ ...st, phase: 'logged' }))
  if (!st.info) return
  try {
    const now = new Date(await $.clock.now())
    const line = stopLogLine(st.info, now, await $.session.cwd(), await $.session.id())
    const script = stopLogScript(line, now)
    await runPs($, script)
  } catch {
    // 書けなくても続ける
  }
}

// メインループのモデルを読み直して保存する。失敗しても落とさない
async function refreshModel($: Engine) {
  try {
    const m = await $.session.model()
    await update($, mainModel, () => m)
  } catch {
    // 取れなければ保存済みの値のまま
  }
}

// 同じ窓・同じリセット周期では 1 回だけ toast を出す。90% 未満に戻れば記録を消す
async function notifyHigh($: Engine, list: UsageLimit[]) {
  for (const kind of WATCHED) {
    const l = list.find(x => x.kind === kind)
    if (!l) continue
    const key = `${kind}|${l.resetsAt ?? ''}`
    if (l.percentUsed < CLEAR_PCT) {
      await update($, notified, ks => ks.filter(k => !k.startsWith(`${kind}|`)))
    } else if (l.percentUsed >= WARN_PCT) {
      const seen = await read($, notified)
      if (seen.includes(key)) continue
      await update($, notified, ks => [
        ...ks.filter(k => !k.startsWith(`${kind}|`)),
        key,
      ])
      const at = parseReset(l)
      const clock =
        at !== undefined ? `（リセット ${resetClock(at, kind === 'seven_day')}）` : ''
      $.ui.toast(`⚠ ${LABEL[kind] ?? kind}の使用量が ${WARN_PCT}% を超えました${clock}`)
    }
  }
}

// 通知音 (Windows)。失敗は無視し、wav が無ければシステム音にする。
function playSound($: Engine, isOk: boolean) {
  const wav = isOk
    ? 'C:\\Windows\\Media\\Windows Unlock.wav'
    : 'C:\\Windows\\Media\\Windows Critical Stop.wav'
  const fallback = isOk ? 'Asterisk' : 'Hand'
  const script =
    `if (Test-Path '${wav}') { (New-Object Media.SoundPlayer '${wav}').PlaySync() } ` +
    `else { [System.Media.SystemSounds]::${fallback}.Play(); Start-Sleep -Milliseconds 800 }`
  $.process
    .run(['powershell.exe', '-NoProfile', '-NonInteractive', '-Command', script], {
      timeoutMs: 15_000,
    })
    .catch(() => {})
}

// toast は常に、OS 通知と音は 🔔 がオンのときだけ（hasSound が false なら音なし）
async function announce($: Engine, text: string, isOk: boolean, hasSound = true) {
  $.ui.toast(text)
  const store = await $.store.get('enabled')
  if (store === false) return
  try {
    await $.ui.notify(text, { title: 'Claude Code' })
  } catch {
    // 通知できなくても続ける
  }
  if (hasSound) playSound($, isOk)
}

// $.agent.list() を読み直して保存し、実行中 → 完了/失敗に変わったものを通知する
async function syncAgents($: Engine, isQuiet: boolean) {
  let rows: Awaited<ReturnType<Engine['agent']['list']>>
  try {
    rows = await $.agent.list()
  } catch {
    return
  }
  const meta = await read($, agentMeta)
  const prev = await read($, agents)
  const list: UsageAgent[] = rows.map(a => ({
    id: a.id,
    description: a.description,
    type: a.type,
    status: a.status,
    ...(meta[a.id]?.startedAt !== undefined ? { startedAt: meta[a.id]?.startedAt } : {}),
    ...(meta[a.id]?.tool ? { tool: meta[a.id]?.tool } : {}),
    ...(meta[a.id]?.model ? { model: meta[a.id]?.model } : {}),
  }))
  await update($, agents, () => list)

  const prevById = new Map(prev.map(p => [p.id, p.status]))
  for (const a of list) {
    if (!FINAL.includes(a.status)) continue
    const before = prevById.get(a.id)
    // 初回の同期や、以前から終わっているものは通知しない
    if (isQuiet || before === undefined || FINAL.includes(before)) continue
    const isOk = a.status === 'completed'
    await announce(
      $,
      `${isOk ? '✓ サブエージェント完了' : '✗ サブエージェント失敗'}: ${a.description}`,
      isOk,
      false,
    )
  }
}

// パネルを出す。/reload-plugins のあとは「頼まれていない open」になり、狭い端末（110〜144桁未満）では
// 置かれずに待ってしまう。置けなかったら印を残し、次にその人がプロンプトを送ったとき（＝頼まれた open）に開き直す。
// その人が自分で閉じたときは、ふたたび /usage-meter するまで勝手に開かない（$.store に残すので再読み込み後も同じ）
let pendingOpen = false
async function ensurePane($: Engine) {
  if ((await $.store.get('paneClosed')) === true) { pendingOpen = false; return }
  try {
    const r = await $.ui.open({ id: PANE, title: TITLE, columns: PANE_COLUMNS })
    pendingOpen = !r.isPlaced
  } catch {
    pendingOpen = true
  }
}

// フックはファイル直下で宣言する必要がある（register 内の const だと読み込みエラー）
async function openPane($: Engine) {
  await $.store.set('paneClosed', false)
  await $.ui.open({ id: PANE, title: TITLE, columns: PANE_COLUMNS })
  pendingOpen = false
  try {
    await refresh($)
  } catch {
    // 取得失敗時は保存済みの値を表示
  }
  await refreshModel($)

  return { text: '使用量パネルを開きました。' }
}

async function setTool($: Engine, id: string, tool: string | undefined) {
  await update($, agentMeta, m => ({
    ...m,
    [id]: { ...m[id], tool },
  }))
}

export const register: Register = (on, options) => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'usage-meter',
      description: '5時間・週間の使用量をパネルで表示',
    })
    await $.command.register({
      name: 'um',
      description: '使用量パネルを開く（/usage-meter の短縮）',
    })
    try {
      await refresh($)
    } catch {
      // 初期値が取れなくても measure で補われる
    }
    {
      const t = await $.clock.now()
      await update($, nowAtom, () => t)
    }
    await refreshModel($)
    await syncAgents($, true)
    void loadAccounts($)
    await ensurePane($)
    $.clock.every(30_000, () => {
      void (async () => {
        const t = await $.clock.now()
        await update($, nowAtom, () => t)
        $.ui.status(statusLine(await read($, limits), t))
        await refreshModel($)
        await syncAgents($, false)
        await loadAccounts($)
      })()
    })

    return next(e)
  })

  on('session.measure', async ($, e, next) => {
    const list = normalize(e.rateLimits)
    await update($, limits, () => list)
    $.ui.status(statusLine(list, await $.clock.now()))
    await notifyHigh($, list)
    void saveAccount($, list)

    return next(e)
  })

  // 95% 以上の窓があるあいだ、モデルに伝える
  on('prompt.compose', async ($, e, next) => {
    const out = await next(e)
    const high = warnLimits(await read($, limits))
    if (high.length === 0) return out

    return {
      sections: [
        ...out.sections,
        {
          id: 'usage-meter:warning',
          scope: 'session',
          text: `使用量の上限が近い（${high.map(warnText).join('、')}）。作業は区切りのよいところで止め、未完了の作業と次にやることを短く報告すること。サブエージェントの起動や大きな探索は避けること。${resumeText(high)}`,
        },
      ],
    }
  })

  on('agent.spawn', async ($, e, next) => {
    const out = await next(e)
    if (out.agentId) {
      const id = out.agentId
      const t = await $.clock.now()
      await update($, agentMeta, m => ({
        ...m,
        [id]: { ...m[id], startedAt: t, ...(out.model ? { model: out.model } : {}) },
      }))
    }
    await syncAgents($, false)

    return out
  })

  // 5h が上限に近いとき、次のツール呼び出しを止めて作業を区切らせる（枠ごとに 1 回）
  on('tool.call', async ($, e, next) => {
    const stop = await checkAutoStop($)
    if (stop) {
      const msg = stopMessage(stop)
      await announce($, `⏸ ${msg}`, false)
      return {
        deny: `止めて。${msg}。これ以上ツールを呼ばず、いまの状況（完了したこと・未完了のこと・次にやること）を短く報告してターンを終えること。ユーザーが続行を指示したら、以降は止めずに続けてよい。`,
      }
    }
    const id = e.agentId
    if (!id) return next(e)
    await setTool($, id, e.tool)
    const ran = await next(e)
    await setTool($, id, undefined)

    return ran
  })

  on('turn.complete', async ($, e, next) => {
    await syncAgents($, false)
    if (!e.agentId) {
      const st = await read($, autoStop)
      if (st.phase === 'stopped') await logAutoStop($, st)
    }
    if (!e.agentId && !e.isAborted && e.durationMs >= LONG_TURN_MS) {
      await announce(
        $,
        `✓ Claude の作業が終わりました（${durationText(e.durationMs)}）`,
        true,
      )
    }

    return next(e)
  })

  // /usage-meter と短縮の /um は同じ動き
  // 再読み込みのあと置けなかったパネルを、その人のプロンプトに合わせて開く（頼まれた open は幅に関係なく置かれる）
  on('prompt.submit', async ($, e, next) => {
    if (pendingOpen) {
      const open = (await $.ui.panes()).some(p => p.id === PANE && p.isPlaced)
      if (open) pendingOpen = false
      else await ensurePane($)
    }
    return next(e)
  })

  // その人が閉じたら覚える（再読み込みで勝手に開き直さない）。プラグインの入れ替え（unload）は閉じたうちに入れない
  on('ui.close', async ($, e, next) => {
    if (e.id === PANE && e.origin === 'person') { await $.store.set('paneClosed', true); pendingOpen = false }
    return next(e)
  })

  on('command.run', { command: 'usage-meter' }, openPane)
  on('command.run', { command: 'um' }, openPane)

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const list = shown(sorted(await read($, limits)))
    const stamp = await read($, nowAtom) // 再描画の購読を兼ねる
    const agentList = await read($, agents)
    const main = modelInfo(await read($, mainModel))
    const now = await $.clock.now()
    const isOn = (await $.store.get('enabled')) !== false
    const j = jst(stamp > 0 ? stamp : now)
    const updated = `${pad2(j.hour)}:${pad2(j.min)}`

    const toggle = async () => {
      await $.store.set('enabled', !isOn)
      void $.ui.invalidate('ui.render')
    }

    const title = (
      <Box justifyContent="space-between">
        <Text bold>Claude 使用量</Text>
        <Box>
          <Text dimColor>{updated} </Text>
          <Button key="toggle" onPress={toggle}>
            {isOn ? '🔔' : '🔕'}
          </Button>
        </Box>
      </Box>
    )

    // 色の凡例（27 列）。色は MODEL_FAMILIES を共有する
    const legendRow = (
      <Text>
        {MODEL_FAMILIES.map((f, i) => (
          <Text key={f.key}>
            {i > 0 ? ' ' : ''}
            <Text color={f.color}>●</Text>
            <Text dimColor>{f.name}</Text>
          </Text>
        ))}
      </Text>
    )

    // A/B 両アカウントの一覧（B の記録があるときだけ）。使っていない側は記録した時刻を出す
    const acc = await read($, accounts)
    const other = acc.me === 'b' ? 'a' : 'b'
    const accountRows = acc.b ? (
      <Box flexDirection="column" marginTop={1}>
        <Button key="switch" onPress={() => void openOther($, other)}>
          ▶ {other.toUpperCase()} で続きを開く
        </Button>
        {(['a', 'b'] as const).map(k => {
          const snap = acc[k]
          const isMe = acc.me === k
          if (!snap) {
            return (
              <Text dimColor>
                {k.toUpperCase()} 記録なし
              </Text>
            )
          }
          const five = pctNow(snap.limits.find(l => l.kind === 'five_hour'), now)
          const week = pctNow(snap.limits.find(l => l.kind === 'seven_day'), now)
          const t = jst(snap.at)
          const pctText = (p: number | undefined) =>
            p === undefined ? <Text dimColor>-</Text> : (
              <Text color={levelColor(p)}>{Math.round(p)}%</Text>
            )
          return (
            <Text>
              <Text bold color={isMe ? 'cyan' : undefined}>
                {k.toUpperCase()}
              </Text>{' '}
              5h {pctText(five)} 週 {pctText(week)}{' '}
              <Text dimColor>{isMe ? 'いま' : `${pad2(t.hour)}:${pad2(t.min)}時点`}</Text>
            </Text>
          )
        })}
      </Box>
    ) : null

    const modelRow = (
      <Text>
        <Text color={main.color}>● </Text>
        <Text bold>{main.name}</Text>
        <Text dimColor>  メイン</Text>
      </Text>
    )

    // サブエージェント欄 (使用量カードを優先し、行数に収まる分だけ)
    const rowsLeft =
      (e.viewport?.rows ?? 40) - 3 - (list.length === 0 ? 2 : list.length * 9) - 1 - 1 - 1 -
      (accountRows ? 4 : 0)
    const running = agentList.filter(a => !FINAL.includes(a.status))
    const finished = agentList
      .filter(a => a.status === 'completed' || a.status === 'failed')
      .slice(-3)
      .reverse()
    let budget = rowsLeft - 2
    const runShown = []
    for (const a of running) {
      if (budget < 1) break
      runShown.push(a)
      budget -= 1
    }
    const finShown = budget > 0 ? finished.slice(0, budget) : []

    const agentSection = (
      <Box flexDirection="column" marginTop={1}>
        {running.length === 0 && finShown.length === 0 ? (
          <Text dimColor>サブエージェントはいません</Text>
        ) : (
          <Text bold>サブエージェント {running.length}件実行中</Text>
        )}
        {rowsLeft >= 3 &&
          runShown.map(a => {
            const mi = a.model ? modelInfo(a.model) : undefined
            const el = a.startedAt !== undefined ? elapsedText(now - a.startedAt) : ''
            const elW = el ? colWidth(el) + 1 : 0
            const desc = cut(a.description, PANE_COLUMNS - 2 - elW)
            // 幅に余裕があるときだけ tool を後ろに足す
            const room = PANE_COLUMNS - 2 - colWidth(desc) - elW - 1
            const tool = a.tool && colWidth(a.tool) <= room ? a.tool : ''
            return (
              <Text>
                <Text color={mi?.color ?? 'cyan'}>● </Text>
                {desc}
                {el && <Text dimColor> {el}</Text>}
                {tool && <Text dimColor> {tool}</Text>}
              </Text>
            )
          })}
        {rowsLeft >= 3 &&
          finShown.map(a => (
            <Text dimColor>
              <Text color={a.status === 'completed' ? 'green' : 'red'}>
                {a.status === 'completed' ? '✓' : '✗'}
              </Text>{' '}
              {cut(a.description, 20)}
            </Text>
          ))}
      </Box>
    )

    if (list.length === 0) {
      return (
        <Box flexDirection="column">
          {title}
          {modelRow}
          {legendRow}
          {accountRows}
          <Text dimColor>
            まだ使用量のデータがありません（Claude.ai サブスクでの最初の応答後に表示されます）
          </Text>
          {agentSection}
        </Box>
      )
    }

    return (
      <Box flexDirection="column">
        {title}
        {modelRow}
        {legendRow}
        {accountRows}
        {list.map(l => {
          const pct = clamp(l.percentUsed, 0, 100)
          const color = levelColor(pct)
          const winMs = windowOf(l.kind)
          const isWeek = isWeekKind(l.kind)
          const at = parseReset(l)

          let elapsed: number | undefined
          let reset = null
          let timeRow = null
          let pace = null
          if (at !== undefined) {
            const leftMs = Math.max(0, at - now)
            reset = (
              <Text wrap="truncate-end">
                リセット {remainShort(leftMs, isWeek)}後{' '}
                <Text dimColor>
                  {isWeek ? resetClock(at, true) : `(${resetClock(at, false)})`}
                </Text>
              </Text>
            )
            if (winMs) {
              elapsed = clamp(
                Math.round(((winMs - leftMs) / winMs) * 100),
                0,
                100,
              )
              timeRow = <Text dimColor>時間の進み {elapsed}%</Text>
              const diff = pct - elapsed
              pace =
                diff >= 10 ? (
                  <Text color={pct >= 80 ? '#f87171' : '#facc15'} bold>
                    ⚠ 速め
                  </Text>
                ) : diff <= -10 ? (
                  <Text color="#4ade80">✓ 余裕</Text>
                ) : (
                  <Text color="#4ade80">● 順調</Text>
                )
            }
          }

          const used = bar(pct, BAR_WIDTH)
          const tb = thinBar(elapsed ?? 0, BAR_WIDTH)

          return (
            <Box
              flexDirection="column"
              borderStyle="round"
              borderColor={color}
              paddingX={1}
              marginTop={1}
            >
              <Box justifyContent="space-between">
                <Text bold>{labelOf(l.kind)}</Text>
                <Text bold color={color}>
                  {Math.round(pct)}%
                </Text>
              </Box>
              <Text>
                <Text color={color}>{used.on}</Text>
                <Text color="#3f3f46">{used.off}</Text>
              </Text>
              {elapsed !== undefined && (
                <Text>
                  <Text color="#38bdf8">{tb.on}</Text>
                  <Text color="#3f3f46">{tb.off}</Text>
                </Text>
              )}
              {timeRow}
              {pace}
              {reset}
            </Box>
          )
        })}
        <Text dimColor>上＝使用量／下＝時間の進み</Text>
        {agentSection}
      </Box>
    )
  })
}
