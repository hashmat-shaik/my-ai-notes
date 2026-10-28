import { HELPER_FLAG, keepAwakePatch } from "./keep-awake"

export type ProviderKey = "claude" | "gemini"
/** Which helper tab to use, so the research chat and the notes merge never share one. */
export type Slot = "research" | "merge"

type Selectors = {
  input: string[] // the message box (contenteditable)
  send: string[] // the send button
  stop: string[] // anything that exists ONLY while the model is still streaming (a <button> here is also clicked on Stop)
  response: string[] // one element per assistant message
}

export type ProviderCfg = { label: string; url: string; hosts: string[]; sel: Selectors }

/**
 * ⚠️ These selectors are the fragile part. Claude.ai and Gemini change their markup
 * from time to time. When a step times out, the error tells you which one — open
 * DevTools on the provider tab, inspect that element, and fix the list below.
 * Selectors are tried in order; the first one that matches wins.
 */
export const PROVIDERS: Record<ProviderKey, ProviderCfg> = {
  claude: {
    label: "Claude",
    url: "https://claude.ai/new",
    hosts: ["claude.ai"],
    sel: {
      input: [
        'div[contenteditable="true"].ProseMirror',
        'div[contenteditable="true"][role="textbox"]',
        '[data-testid="chat-input"]'
      ],
      send: ['button[aria-label="Send message"]', 'button[aria-label="Send Message"]'],
      stop: ['[data-is-streaming="true"]', 'button[aria-label="Stop response"]', 'button[aria-label="Stop Response"]'],
      response: [".font-claude-response", "[data-is-streaming]"]
    }
  },
  gemini: {
    label: "Gemini",
    url: "https://gemini.google.com/app",
    hosts: ["gemini.google.com"],
    sel: {
      input: [
        'rich-textarea div.ql-editor[contenteditable="true"]',
        'div.ql-editor[contenteditable="true"]',
        'div[contenteditable="true"][role="textbox"]'
      ],
      send: ["button.send-button", 'button[aria-label="Send message"]'],
      stop: ['button[aria-label="Stop response"]', "button.stop"],
      response: ["model-response message-content", "message-content", ".model-response-text"]
    }
  }
}

export function isProviderHost(url: string) {
  try {
    const host = new URL(url).hostname
    return Object.values(PROVIDERS).some((p) => p.hosts.includes(host))
  } catch {
    return false
  }
}

type PageResult = { ok: true; html: string; stopped: boolean } | { ok: false; error: string }
export type AskResult =
  | { ok: true; html: string; stopped: boolean; chatUrl?: string }
  | { ok: false; error: string }

/**
 * Injected INTO the Claude/Gemini tab. Must be fully self-contained
 * (no references to anything outside this function).
 */
async function askInPage(prompt: string, cfg: ProviderCfg, timeoutMs: number, slot: string): Promise<PageResult> {
  let stopped = false
  const onMsg = (m: any) => {
    if (m?.type !== "STOP_ASK") return
    stopped = true
    for (const s of cfg.sel.stop) {
      const el = document.querySelector<HTMLElement>(s)
      if (el && el.tagName === "BUTTON") {
        el.click() // also halts generation on the provider's side
        break
      }
    }
  }
  chrome.runtime.onMessage.addListener(onMsg)

  try {
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
    const q = (sels: string[]) => {
      for (const s of sels) {
        const el = document.querySelector<HTMLElement>(s)
        if (el) return el
      }
      return null
    }
    const qAll = (sels: string[]) => {
      for (const s of sels) {
        const els = Array.from(document.querySelectorAll<HTMLElement>(s))
        if (els.length) return els
      }
      return [] as HTMLElement[]
    }
    const waitFor = async <T>(fn: () => T | null, ms: number, label: string, hint = ""): Promise<T> => {
      const start = Date.now()
      while (Date.now() - start < ms) {
        if (stopped) throw new Error("Stopped.")
        const v = fn()
        if (v) return v
        await sleep(300)
      }
      throw new Error(
        `Timed out waiting for ${label} on ${cfg.label}. ${hint}Open the ${cfg.label} tab to see what it's showing, or update the selectors in lib/remote-chat.ts.`
      )
    }

    // Tells the side panel the page script is alive and how long the page has gone without changing.
    const heartbeat = (phase: string, idleMs: number) => {
      try {
        chrome.runtime.sendMessage({ type: "HEARTBEAT", slot, phase, idleMs })?.catch?.(() => {})
      } catch {}
    }

    let before = qAll(cfg.sel.response).length

    // 1. Find the input and put the prompt in it.
    const input = await waitFor(() => q(cfg.sel.input), 30000, "the chat input", "You may be logged out. ")

    // A resumed chat renders its history asynchronously. Wait until the message count stops changing,
    // otherwise an old message that appears later would be mistaken for the new reply.
    for (let i = 0, stable = 0; i < 12 && stable < 3; i++) {
      await sleep(300)
      const n = qAll(cfg.sel.response).length
      if (n === before) stable++
      else {
        before = n
        stable = 0
      }
    }
    input.focus()
    document.execCommand("selectAll", false) // clear any leftover draft
    document.execCommand("delete", false)

    // A synthetic paste handles long/multiline text far better than typing.
    const dt = new DataTransfer()
    dt.setData("text/plain", prompt)
    input.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }))
    await sleep(600)
    if (!(input.innerText || "").trim()) {
      document.execCommand("insertText", false, prompt) // fallback
      await sleep(400)
    }

    // 2. Click send once it becomes enabled.
    const sendBtn = await waitFor(
      () => {
        const b = q(cfg.sel.send) as HTMLButtonElement | null
        return b && !b.disabled && b.getAttribute("aria-disabled") !== "true" ? b : null
      },
      10000,
      "the send button"
    )
    before = qAll(cfg.sel.response).length
    sendBtn.click()

    // 3. Wait for the new assistant message to appear.
    const getLast = () => {
      const els = qAll(cfg.sel.response)
      return els.length > before ? els[els.length - 1] : null
    }
    const sentAt = Date.now()
    while (!getLast()) {
      if (stopped) throw new Error("Stopped.")
      if (Date.now() - sentAt > 60000) {
        throw new Error(
          `Timed out waiting for the response to start on ${cfg.label}. It may be rate-limited or showing a CAPTCHA. ` +
            `Open the ${cfg.label} tab to see what it's showing, or update the selectors in lib/remote-chat.ts.`
        )
      }
      heartbeat("waiting-start", Date.now() - sentAt)
      await sleep(300)
    }

    // 4. Stream it back until the model is finished (or the user pressed Stop).
    let lastText = ""
    let lastChange = Date.now()
    const start = Date.now()
    let finished = false
    while (!stopped && Date.now() - start < timeoutMs) {
      const el = getLast()
      const text = (el?.innerText || "").trim()
      if (text !== lastText) {
        lastText = text
        lastChange = Date.now()
        try {
          chrome.runtime.sendMessage({ type: "STREAM", slot, html: el?.innerHTML || "" })?.catch?.(() => {})
        } catch {}
      }
      const streaming = !!q(cfg.sel.stop)
      heartbeat("streaming", Date.now() - lastChange)
      if (text && !streaming && Date.now() - lastChange > 2500) {
        finished = true
        break
      }
      await sleep(500)
    }
    // Ran out of time while still streaming: hand back what we have, flagged as partial, not as complete.
    const timedOut = !stopped && !finished
    if (stopped) await sleep(600) // let the last tokens render

    const el = getLast()
    const html = el?.innerHTML || ""
    if (!(el?.innerText || "").trim()) return { ok: false, error: stopped ? "Stopped." : "The response came back empty." }
    return { ok: true, html, stopped: stopped || timedOut }
  } catch (e: any) {
    return { ok: false, error: e?.message || String(e) }
  } finally {
    chrome.runtime.onMessage.removeListener(onMsg)
  }
}

async function waitForTabComplete(tabId: number, timeoutMs = 20000) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const t = await chrome.tabs.get(tabId)
    if (t.status === "complete") return
    await new Promise((r) => setTimeout(r, 300))
  }
}

const pathOf = (u?: string) => {
  try {
    return new URL(u || "").pathname.replace(/\/$/, "")
  } catch {
    return ""
  }
}

/**
 * Reuses our own provider tab (never your personal Claude/Gemini tabs).
 *  - fresh: go to the "new chat" page
 *  - otherwise: navigate to `chatUrl` so an earlier conversation can be resumed
 */
async function getProviderTab(provider: ProviderKey, fresh: boolean, chatUrl: string | undefined, slot: Slot) {
  const cfg = PROVIDERS[provider]
  const key = `tab:${provider}:${slot}`
  const base = fresh || !chatUrl ? cfg.url : chatUrl
  const target = base.includes(HELPER_FLAG) ? base : base + (base.includes("?") ? "&" : "?") + HELPER_FLAG
  const stored = (await chrome.storage.session.get(key))[key] as number | undefined

  if (stored) {
    try {
      const tab = await chrome.tabs.get(stored)
      if (tab.url && isProviderHost(tab.url)) {
        const alreadyThere = tab.url === target || (!fresh && pathOf(tab.url) === pathOf(target))
        if (!alreadyThere && !(fresh && pathOf(tab.url) === pathOf(cfg.url))) {
          await chrome.tabs.update(stored, { url: target })
          await new Promise((r) => setTimeout(r, 600))
          await waitForTabComplete(stored)
        }
        return await chrome.tabs.get(stored)
      }
    } catch {
      /* tab was closed — fall through and open a new one */
    }
  }

  const tab = await chrome.tabs.create({ url: target, active: false })
  await chrome.storage.session.set({ [key]: tab.id })
  await waitForTabComplete(tab.id!)
  return await chrome.tabs.get(tab.id!)
}

export async function askProvider(
  provider: ProviderKey,
  prompt: string,
  opts: {
    fresh: boolean
    chatUrl?: string
    returnToTabId?: number
    slot?: Slot // which helper tab to use (default: research)
    flip?: "auto" | "never" // may we bring the helper tab forward when it stalls?
    onStatus?: (s: string) => void
  }
): Promise<AskResult> {
  const cfg = PROVIDERS[provider]
  try {
    opts.onStatus?.(opts.fresh ? `Opening a new ${cfg.label} chat...` : `Resuming your ${cfg.label} chat...`)
    const slot: Slot = opts.slot ?? "research"
    const tab = await getProviderTab(provider, opts.fresh, opts.chatUrl, slot)

    // Logged-out users get bounced to a login page.
    if (!tab.url || !isProviderHost(tab.url) || /\/(login|signin|sign-in|auth)/i.test(pathOf(tab.url))) {
      await chrome.tabs.update(tab.id!, { active: true })
      return {
        ok: false,
        error: `You're not logged in to ${cfg.label}. I've brought its tab forward — log in, then ask again.`
      }
    }

    // The earlier conversation was deleted/redirected on the provider's side.
    if (!opts.fresh && opts.chatUrl && pathOf(tab.url) !== pathOf(opts.chatUrl)) {
      return {
        ok: false,
        error: `Couldn't reopen the earlier ${cfg.label} chat (it may have been deleted). Click "New chat" to start over.`
      }
    }

    opts.onStatus?.(`Waiting for ${cfg.label} to answer...`)

    // Layer 1 (fallback): the document_start content script normally does this earlier and more reliably.
    try {
      await chrome.scripting.executeScript({ target: { tabId: tab.id! }, world: "MAIN", func: keepAwakePatch as any })
    } catch {
      /* best effort */
    }

    // Layer 2: if the page genuinely stops making progress, bring the tab forward until it
    // finishes, then go back. Decided from heartbeats, not from "no text yet" (thinking is fine).
    let woke = false
    let started = false // true once the page script sends its first heartbeat
    let lastBeat = Date.now()
    let phase = "waiting-start"
    let idleMs = 0
    const onActivity = (m: any) => {
      if ((m?.slot ?? "research") !== slot) return // another helper tab's traffic
      if (m?.type === "HEARTBEAT") {
        started = true
        lastBeat = Date.now()
        phase = m.phase
        idleMs = m.idleMs
      } else if (m?.type === "STREAM") {
        lastBeat = Date.now()
      }
    }
    chrome.runtime.onMessage.addListener(onActivity)
    const watchdog = setInterval(async () => {
      if (woke || opts.flip === "never") return
      const silentFor = Date.now() - lastBeat
      const frozen = silentFor > (started ? 8000 : 45000) // the page script itself stopped ticking (hard throttling)
      const stalledStreaming = phase === "streaming" && idleMs > 8000 // generating, but the page isn't repainting
      const stalledStart = phase === "waiting-start" && idleMs > 30000 // long "thinking" is allowed up to here
      if (!frozen && !stalledStreaming && !stalledStart) return
      woke = true
      console.info("[ai-notes] bringing helper tab forward:", { frozen, stalledStreaming, stalledStart, silentFor, phase, idleMs })
      opts.onStatus?.(`${cfg.label} stopped updating in the background — bringing it forward until it finishes…`)
      try {
        await chrome.tabs.update(tab.id!, { active: true })
      } catch {}
    }, 2000)

    let injection: any
    try {
      ;[injection] = await chrome.scripting.executeScript({
        target: { tabId: tab.id! },
        func: askInPage as any,
        args: [prompt, cfg, 240000, slot]
      })
    } finally {
      clearInterval(watchdog)
      chrome.runtime.onMessage.removeListener(onActivity)
      if (woke && opts.returnToTabId) {
        try {
          const [cur] = await chrome.tabs.query({ active: true, lastFocusedWindow: true })
          if (cur?.id === tab.id) await chrome.tabs.update(opts.returnToTabId, { active: true })
        } catch {}
      }
    }

    const result = injection?.result as PageResult | undefined
    if (!result) return { ok: false, error: "No result came back from the page script." }
    if (!result.ok) return result

    // After the first message the provider assigns the chat its own URL — remember it for resuming.
    // The URL can update a moment after the answer finishes, so poll briefly.
    let chatUrl: string | undefined
    for (let i = 0; i < 8; i++) {
      const after = await chrome.tabs.get(tab.id!)
      if (after.url && isProviderHost(after.url) && pathOf(after.url) !== pathOf(cfg.url)) {
        chatUrl = after.url
        break
      }
      await new Promise((r) => setTimeout(r, 750))
    }
    return { ok: true, html: result.html, stopped: result.stopped, chatUrl }
  } catch (e: any) {
    const msg = e?.message || String(e)
    if (/No tab with id|tab was closed|Frame with ID|Cannot access/i.test(msg)) {
      return { ok: false, error: `The ${cfg.label} tab was closed or became unreachable mid-request. Try again.` }
    }
    return { ok: false, error: msg }
  }
}

/** Ask the injected script in the provider tab to stop waiting (and press the provider's Stop button). */
export async function stopAsk(provider: ProviderKey, slot: Slot = "research") {
  const key = `tab:${provider}:${slot}`
  const id = (await chrome.storage.session.get(key))[key] as number | undefined
  if (!id) return
  try {
    await chrome.tabs.sendMessage(id, { type: "STOP_ASK" })
  } catch {
    /* nothing running */
  }
}