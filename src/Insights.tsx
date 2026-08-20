import { fmtDur, type PauseRecord } from './model'

const DAY = 86_400_000
const BUCKETS = 12 // 24 小时分成 12 个两小时的桶；24 根柱子在 240px 宽里挤不开

const clockOf = (at: number) =>
  new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })

const dayLabel = (at: number, now: number) => {
  const d0 = new Date(now).setHours(0, 0, 0, 0)
  if (at >= d0) return '今天'
  if (at >= d0 - DAY) return '昨天'
  return new Date(at).toLocaleDateString([], { month: 'numeric', day: 'numeric' })
}

/** 还停着的那条按「到现在」算时长 */
const lengthOf = (p: PauseRecord, now: number) => Math.max(0, (p.endedAt ?? now) - p.at)

export default function Insights({
  pauses,
  now,
  onClose,
}: {
  pauses: PauseRecord[]
  now: number
  onClose: () => void
}) {
  const week = pauses.filter((p) => p.at > now - 7 * DAY)
  const today = pauses.filter((p) => p.at >= new Date(now).setHours(0, 0, 0, 0))
  const weekMs = week.reduce((a, p) => a + lengthOf(p, now), 0)

  const hours = Array.from({ length: BUCKETS }, () => 0)
  week.forEach((p) => {
    hours[Math.floor(new Date(p.at).getHours() / (24 / BUCKETS))]++
  })
  const peak = Math.max(1, ...hours)

  const byReason = new Map<string, number>()
  week.forEach((p) => {
    if (p.reason) byReason.set(p.reason, (byReason.get(p.reason) ?? 0) + 1)
  })
  const topReasons = [...byReason.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4)

  return (
    <div className="panel">
      <div className="panel-head">
        <span>暂停报告</span>
        <button className="icon" onClick={onClose}>
          ✕
        </button>
      </div>

      {week.length === 0 ? (
        <p className="empty">近 7 天没有暂停过。</p>
      ) : (
        <div className="insights">
          <p className="big">{week.length} 次</p>
          <p className="sheet-sub">
            近 7 天 · 共 {fmtDur(weekMs)} · 今天 {today.length} 次
          </p>

          <div className="block">
            <span className="block-title">什么时候暂停</span>
            <div className="hours">
              {hours.map((n, i) => (
                <i
                  key={i}
                  className={n === peak ? 'peak' : undefined}
                  style={{ height: `${Math.max(2, (n / peak) * 26)}px` }}
                  title={`${i * 2}:00–${i * 2 + 2}:00 · ${n} 次`}
                />
              ))}
            </div>
            <div className="hour-axis">
              <span>0</span>
              <span>6</span>
              <span>12</span>
              <span>18</span>
            </div>
          </div>

          {topReasons.length > 0 && (
            <div className="block">
              <span className="block-title">最常见</span>
              <div className="reasons">
                {topReasons.map(([reason, n]) => (
                  <span key={reason} className="reason-chip">
                    {reason} <b>{n}</b>
                  </span>
                ))}
              </div>
            </div>
          )}

          <div className="block grow">
            <span className="block-title">最近</span>
            <ul className="pause-list">
              {week.slice(0, 30).map((p, i) => (
                <li key={`${p.at}-${i}`}>
                  <span className="when">
                    {dayLabel(p.at, now)} {clockOf(p.at)}
                  </span>
                  <span className="len">{fmtDur(lengthOf(p, now))}</span>
                  <span className="why">{p.reason ?? p.sliceName}</span>
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}
    </div>
  )
}
