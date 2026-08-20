/**
 * 让 Tauri 窗口的高度跟着卡片内容走。
 *
 * 固定高度做不到：等确认时多一块确认条，任务名长了还会换成两行，
 * 按最坏情况定高，跑着的时候底下就空一大块；按常态定高，确认条又会被
 * overflow:hidden 切掉。所以只能量完再改窗口。
 */

const inTauri = () => '__TAURI_INTERNALS__' in globalThis

export function autoSizeWindow(card: HTMLElement): () => void {
  if (!inTauri()) return () => {}

  let applied = 0
  let stopped = false

  const apply = async () => {
    const height = Math.ceil(card.getBoundingClientRect().height)
    // 差一两个像素不值得动窗口，免得跟 ResizeObserver 来回打架
    if (stopped || height < 100 || Math.abs(height - applied) <= 1) return
    applied = height

    const [{ getCurrentWindow }, { LogicalSize }] = await Promise.all([
      import('@tauri-apps/api/window'),
      import('@tauri-apps/api/dpi'),
    ])
    const width = Math.ceil(card.getBoundingClientRect().width)
    await getCurrentWindow().setSize(new LogicalSize(width, height))
  }

  const observer = new ResizeObserver(() => void apply())
  observer.observe(card)
  void apply()

  return () => {
    stopped = true
    observer.disconnect()
  }
}
