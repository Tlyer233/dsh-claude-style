/**
 * A mascot's sheets, as the addresses the sprite paints from.
 *
 * Each sheet is served by the host half under the assets route and named after
 * its own content, so the browser fetches a sheet once and caches it for good.
 * Nothing is converted here: the first time an animation is wanted its image
 * is decoded ahead of the frame that paints it, and a sheet that does not
 * arrive leaves its animation out and says so once — the host half serves the
 * sheets, so a host that predates the plugin's build answers 404.
 *
 * @param urls - sheet key → its address on the route.
 * @param name - the character's name, for the one warning a failed sheet prints.
 * @param onReady - `onReady(key)`: a sheet became playable; the caller reads the
 *     state again and plays what it asks for.
 * @returns `{ ready, failed, url, dispose }`.
 */
export function createRoutedSheets(urls: Record<string, string>, name: string, onReady: (key: string) => void) {  /** Sheet key → 'loading' | 'ready' | 'failed'. */
  const sheets = new Map<string, 'loading' | 'ready' | 'failed'>()
  /** The decoded sheets, kept so a pose can be sampled without a second request. */
  const images = new Map<string, HTMLImageElement>()
  /** One 12×12 canvas reused for every pose sample. */
  let canvas: HTMLCanvasElement | null = null
  /** False once disposed: a load landing after the character left is dropped. */
  let alive = true

  /**
   * Whether a sheet is ready to paint, starting its load the first time.
   * @param key - the animation.
   */
  function ready(key: string) {
    const known = sheets.get(key)
    if (known !== undefined) return known === 'ready'
    const address = urls[key]
    // The table and the sheets are one list; a name outside it is a bug here.
    if (address === undefined) throw new Error(`dsh-claude-style: no ${name} sheet for "${key}"`)
    sheets.set(key, 'loading')
    const image = new Image()
    image.src = address
    const settle = (ok: boolean) => {
      if (sheets.get(key) !== 'loading') return
      sheets.set(key, ok ? 'ready' : 'failed')
      if (ok) images.set(key, image)
      if (ok && alive) onReady(key)
      if (!ok) console.warn(`[dsh-claude-style] ${name}'s "${key}" sheet did not load from ${address}; the host half serves it, so restart the host after an update.`)
    }
    image.decode().then(() => settle(true), () => settle(false))
    return false
  }

  /** Whether a sheet's load already failed: an animation that will never come. */
  function failed(key: string) {
    return sheets.get(key) === 'failed'
  }

  /** The address a ready sheet plays from. */
  function url(key: string) {
    return urls[key]
  }

  /**
   * Ask for these sheets ahead of the state that wants them. The idle sheet
   * goes first so the pet can appear at once; the rest keep loading behind it.
   */
  function preload(keys: string[]) {
    for (const key of keys) ready(key)
  }

  /**
   * A frame's pose as its alpha silhouette, sampled at 12×12: the cell's
   * top-left and size are in the sheet's own image pixels. Two frames of
   * different sheets can be compared by this, which is what lets a state
   * change start from the new sheet's most similar pose instead of frame 0.
   */
  function pose(key: string, frame: number, cellWidth: number, cellHeight: number, columns: number) {
    const image = images.get(key)
    if (image === undefined) return null
    if (canvas === null) {
      canvas = document.createElement('canvas')
      canvas.width = 12
      canvas.height = 12
    }
    const context = canvas.getContext('2d', { willReadFrequently: true })
    if (context === null) return null
    const x = (frame % columns) * cellWidth
    const y = Math.floor(frame / columns) * cellHeight
    context.clearRect(0, 0, 12, 12)
    context.drawImage(image, x, y, cellWidth, cellHeight, 0, 0, 12, 12)
    const data = context.getImageData(0, 0, 12, 12).data
    const alpha: number[] = []
    for (let at = 3; at < data.length; at += 4) alpha.push(data[at])
    return alpha
  }

  function dispose() {
    alive = false
    sheets.clear()
    images.clear()
    canvas = null
  }

  return { ready, failed, url, preload, pose, dispose }
}

/**
 * A routed character's `createSheets` in one place: both Deepy and Whalegirl
 * paint the same shared `--dsh-claude-mascot-sheet` and differ only in their
 * addresses and the name a failed load mentions.
 *
 * @param urls - sheet key → its address on the route.
 * @param name - the character's name, for the failed-load warning.
 */
export function createRoutedSheetAdapter(urls: Record<string, string>, name: string) {
  return (onReady: () => void) => {
    const sheets = createRoutedSheets(urls, name, onReady)
    return {
      ready: sheets.ready,
      failed: sheets.failed,
      paint(style: CSSStyleDeclaration, key: string) {
        style.setProperty('--dsh-claude-mascot-sheet', `url("${sheets.url(key)}")`)
      },
      preload: sheets.preload,
      pose: sheets.pose,
      dispose: sheets.dispose,
    }
  }
}
