// 自動ストップの判定（純粋関数。claude-code には依存しない）
import type { UsageAccounts, UsageLimit, UsageSnapshot, UsageStopInfo } from '../types'

export const STOP_FIVE_PCT = 95 // いまのアカウントの 5h がこれ以上で止める
export const ROOM_OTHER_FIVE_MAX = 95 // 余裕ありと書く条件: もう片方の 5h がこれ以下
export const ROOM_OTHER_WEEK_MAX = 85 // 余裕ありと書く条件: もう片方の週間がこれ以下

const parseAt = (l: UsageLimit): number | undefined => {
  if (!l.resetsAt) return undefined
  const t = Date.parse(l.resetsAt)
  return Number.isNaN(t) ? undefined : t
}

// リセット時刻を過ぎた窓は 0%。窓が無ければ undefined
export const pctOf = (
  list: readonly UsageLimit[] | undefined,
  kind: string,
  now: number,
): number | undefined => {
  const l = list?.find(x => x.kind === kind)
  if (!l) return undefined
  const at = parseAt(l)
  return at !== undefined && at <= now ? 0 : l.percentUsed
}

// いまの 5h が 95% 以上なら StopInfo、そうでなければ undefined（週間・もう片方は止める判定に使わない）
export function judgeStop(
  mine: readonly UsageLimit[] | undefined,
  acc: UsageAccounts,
  now: number,
): UsageStopInfo | undefined {
  const me = acc.me === 'b' ? 'b' : acc.me === 'a' ? 'a' : ''
  if (!me) return undefined
  const five = pctOf(mine, 'five_hour', now)
  if (five === undefined || five < STOP_FIVE_PCT) return undefined
  const snap: UsageSnapshot | undefined = acc[me === 'a' ? 'b' : 'a']
  const week = pctOf(mine, 'seven_day', now)
  const otherFive = snap ? pctOf(snap.limits, 'five_hour', now) : undefined
  const otherWeek = snap ? pctOf(snap.limits, 'seven_day', now) : undefined
  const key = mine?.find(l => l.kind === 'five_hour')?.resetsAt ?? 'none'
  return {
    me,
    five,
    key,
    ...(week !== undefined ? { week } : {}),
    ...(otherFive !== undefined ? { otherFive } : {}),
    ...(otherWeek !== undefined ? { otherWeek } : {}),
  }
}

// 同じ 5h 枠では 2 回止めない（lastKey は前回止めた枠の resetsAt）
export const isNewWindow = (info: UsageStopInfo, lastKey: string | undefined) =>
  info.key !== lastKey

// もう片方に余裕があるか: もう片方の記録があり、5h ≤ 95 かつ 週 ≤ 85
export const hasRoom = (s: UsageStopInfo) =>
  s.otherFive !== undefined &&
  s.otherWeek !== undefined &&
  s.otherFive <= ROOM_OTHER_FIVE_MAX &&
  s.otherWeek <= ROOM_OTHER_WEEK_MAX

const r = (n: number) => Math.round(n)
const otherName = (s: UsageStopInfo) => (s.me === 'a' ? 'B' : 'A')

// toast / deny 用（deny は register 側で「止めて。」を頭に付ける）。もう片方に余裕があれば書き足す
export const stopMessage = (s: UsageStopInfo) =>
  `いったんストップ（5時間 ${r(s.five)}% に到達${
    hasRoom(s)
      ? `。${otherName(s)} に余裕あり：5h ${r(s.otherFive!)}% / 週 ${r(s.otherWeek!)}%`
      : ''
  }）`

// ---- claude-stop.txt: 止まったセッションの一覧（1 行目 # 見出し、2 行目から 1 セッション 1 行・タブ区切り）----
export const STOP_LOG_HEADER =
  '# 止まったセッション一覧（日時\taccount\t5h\tweek\tother_5h\tother_week\tcwd\tsession）'
export const STOP_LOG_TTL_MS = 24 * 60 * 60 * 1000

const p2 = (n: number) => String(n).padStart(2, '0')
// ローカル時刻の yyyy-MM-dd HH:mm（文字列比較で時刻順になる）
export const stopTs = (at: Date) =>
  `${at.getFullYear()}-${p2(at.getMonth() + 1)}-${p2(at.getDate())} ${p2(at.getHours())}:${p2(at.getMinutes())}`
const TS_RE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/

// 1 セッション分の行（改行・タブは空白にする）。値が無ければ -
export function stopLogLine(
  s: UsageStopInfo,
  at: Date,
  cwd: string,
  sessionId: string,
): string {
  const clean = (v: string) => v.replace(/[\r\n\t]+/g, ' ').trim() || '-'
  const pct = (n: number | undefined) => (n === undefined ? '-' : `${r(n)}%`)
  return [
    stopTs(at),
    `account=${s.me.toUpperCase()}`,
    `5h=${pct(s.five)}`,
    `week=${pct(s.week)}`,
    `other_5h=${pct(s.otherFive)}`,
    `other_week=${pct(s.otherWeek)}`,
    `cwd=${clean(cwd)}`,
    `session=${clean(sessionId)}`,
  ].join('\t')
}

export type StopEntry = { at: string; cwd: string; session: string; raw: string }

// 1 行をパース。# 行・空行・日時や session= が無いおかしな行は undefined
export function parseStopLine(line: string): StopEntry | undefined {
  const raw = line.replace(/\r$/, '')
  if (!raw || raw.startsWith('#')) return undefined
  const f = raw.split('\t')
  if (f.length < 2 || !TS_RE.test(f[0]!)) return undefined
  const get = (k: string) => f.find(x => x.startsWith(`${k}=`))?.slice(k.length + 1)
  const session = get('session')
  if (!session) return undefined
  return { at: f[0]!, cwd: get('cwd') || '-', session, raw }
}

// 期限内（24 時間以内）か
export const isFreshStop = (e: StopEntry, now: Date) =>
  e.at >= stopTs(new Date(now.getTime() - STOP_LOG_TTL_MS))

// 既存の中身に newLine を取り込む: 同じ session= は置き換え、無ければ追加、24 時間より古い行・おかしな行は消す
export function mergeStopLog(existing: string, newLine: string, now: Date): string {
  const added = parseStopLine(newLine)
  const kept = existing
    .split('\n')
    .map(parseStopLine)
    .filter((e): e is StopEntry => !!e && isFreshStop(e, now))
    .filter(e => !(added && added.session !== '-' && e.session === added.session))
    .map(e => e.raw)
  return [STOP_LOG_HEADER, ...kept, ...(added ? [newLine] : [])].join('\n') + '\n'
}

// 排他（名前付き Mutex）して読み→マージ→一時ファイル→置き換え、をする PowerShell。
// pathExpr は PowerShell の式（既定 "$HOME\claude-stop.txt"）。マージの規則は mergeStopLog と同じ
export function stopLogScript(
  line: string,
  now: Date,
  pathExpr = '"$HOME\\claude-stop.txt"',
): string {
  const q = (v: string) => `'${v.replace(/'/g, "''")}'`
  const sid = parseStopLine(line)?.session ?? '-'
  const cut = stopTs(new Date(now.getTime() - STOP_LOG_TTL_MS))
  return [
    `$f = ${pathExpr}; $new = ${q(line)}; $sid = ${q(sid)}; $cut = ${q(cut)}; $hd = ${q(STOP_LOG_HEADER)}`,
    `$m = New-Object Threading.Mutex($false, 'Global\\claude-stop-file'); $got = $false`,
    `try { try { $got = $m.WaitOne(10000) } catch [Threading.AbandonedMutexException] { $got = $true }`,
    `if ($got) { $keep = @()`,
    `if (Test-Path -LiteralPath $f) { foreach ($l in [IO.File]::ReadAllLines($f)) {`,
    `if (-not $l -or $l.StartsWith('#')) { continue }`,
    '$c = $l.Split("`t"); if ($c.Count -lt 2 -or $c[0] -notmatch \'^\\d{4}-\\d{2}-\\d{2} \\d{2}:\\d{2}$\') { continue }',
    `$s = $c | Where-Object { $_.StartsWith('session=') } | Select-Object -First 1; if (-not $s -or $s.Length -le 8) { continue }`,
    `if ([string]::CompareOrdinal($c[0], $cut) -lt 0) { continue }`,
    `if ($sid -ne '-' -and $s.Substring(8) -eq $sid) { continue }`,
    `$keep += $l } }`,
    `$out = @($hd) + $keep + $new; $tmp = "$f.$PID.tmp"`,
    `[IO.File]::WriteAllText($tmp, ($out -join [Environment]::NewLine) + [Environment]::NewLine, (New-Object Text.UTF8Encoding $false))`,
    `Move-Item -LiteralPath $tmp -Destination $f -Force } }`,
    `finally { if ($got) { $m.ReleaseMutex() } $m.Dispose() }`,
  ].join('\n')
}
