// Document Picture-in-Picture：把整个圆盘搬进一个系统级置顶小窗。
// 只有 Chromium 系支持；不支持时按钮会藏起来。

type PipApi = { requestWindow(o: { width: number; height: number }): Promise<Window> }

const api = (): PipApi | null =>
  (globalThis as unknown as { documentPictureInPicture?: PipApi }).documentPictureInPicture ?? null

export const pipSupported = () => api() !== null

function copyStyles(dst: Document) {
  // dev 下 Vite 注入 <style>，build 后是 <link>，两种都搬过去
  document.querySelectorAll('link[rel="stylesheet"], style').forEach((node) => {
    dst.head.append(node.cloneNode(true))
  })
}

/**
 * 搬的必须是 React 的根容器本身。React 把事件委托挂在根容器上，
 * 只搬里面某个子节点的话，PiP 窗里的事件冒泡不到那个容器，按钮会全废。
 */
export async function openPip(width: number, height: number) {
  const pip = api()
  if (!pip) throw new Error('this browser has no Document Picture-in-Picture')

  const root = document.getElementById('root')
  const home = document.getElementById('home')
  if (!root || !home) throw new Error('root/home missing')

  const win = await pip.requestWindow({ width, height })
  copyStyles(win.document)
  win.document.body.classList.add('in-pip')
  win.document.body.append(root)
  document.body.classList.add('away')

  win.addEventListener('pagehide', () => {
    home.append(root)
    document.body.classList.remove('away')
  })
  return win
}
