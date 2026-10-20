export const HELPER_FLAG = "ainotes=1"

/**
 * True only in tabs this extension opened itself (marked by a query flag, then remembered
 * per-tab in sessionStorage). Your normal Claude/Gemini tabs are never touched.
 */
export function isHelperPage(): boolean {
  try {
    if (location.search.includes(HELPER_FLAG)) {
      sessionStorage.setItem("__ainotes", "1")
      return true
    }
    return sessionStorage.getItem("__ainotes") === "1"
  } catch {
    return false
  }
}

/**
 * Injected into the provider page's MAIN world. Background tabs are "hidden", and many sites stop
 * rendering streamed text (requestAnimationFrame never fires) until you look at them.
 * This makes the page believe it is visible and keeps animation callbacks running.
 * Must be fully self-contained and idempotent.
 */
export function keepAwakePatch() {
  const w = window as any
  if (w.__aiNotesAwake) return
  w.__aiNotesAwake = true

  const def = (obj: any, prop: string, val: any) => {
    try {
      Object.defineProperty(obj, prop, { configurable: true, get: () => val })
    } catch {}
  }
  def(Document.prototype, "hidden", false)
  def(Document.prototype, "visibilityState", "visible")
  def(Document.prototype, "webkitHidden", false)
  def(Document.prototype, "webkitVisibilityState", "visible")
  try {
    Document.prototype.hasFocus = () => true
  } catch {}

  // Swallow "you're hidden now" events (only when aimed at window/document, so input blur still works).
  const stop = (e: Event) => {
    if (e.target === window || e.target === document) e.stopImmediatePropagation()
  }
  ;["visibilitychange", "webkitvisibilitychange", "blur", "pagehide", "freeze"].forEach((type) => {
    window.addEventListener(type, stop, true)
    document.addEventListener(type, stop, true)
  })

  // rAF never fires in hidden tabs: race it against a timer so UI updates still happen.
  const nativeRaf = window.requestAnimationFrame.bind(window)
  const nativeCaf = window.cancelAnimationFrame.bind(window)
  let counter = 0
  const pending = new Map<number, { raf: number; timer: number }>()
  window.requestAnimationFrame = (cb: FrameRequestCallback) => {
    const id = ++counter
    let done = false
    const run = (ts: number) => {
      if (done) return
      done = true
      const e = pending.get(id)
      if (e) {
        nativeCaf(e.raf)
        clearTimeout(e.timer)
        pending.delete(id)
      }
      cb(ts)
    }
    pending.set(id, { raf: nativeRaf(run), timer: window.setTimeout(() => run(performance.now()), 50) })
    return id
  }
  window.cancelAnimationFrame = (id: number) => {
    const e = pending.get(id)
    if (e) {
      nativeCaf(e.raf)
      clearTimeout(e.timer)
      pending.delete(id)
    }
  }
}

