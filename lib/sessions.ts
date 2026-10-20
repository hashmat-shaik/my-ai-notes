import type { ProviderKey } from "./remote-chat"

export type Message = {
  id: string
  role: "user" | "assistant"
  content: string // markdown
  ts: number
  pinned?: boolean // flagged "add to notes"
  partial?: boolean // the user pressed Stop
}

export type Session = {
  id: string
  provider: ProviderKey
  title: string
  pageUrl: string // normalized URL of the first page studied (informational)
  siteKey?: string // what identifies "the same session": the site (or the video, on YouTube)
  contextUrl?: string // normalized URL of the page whose content the chat last received
  chatUrl?: string // URL of the Claude/Gemini conversation, so we can resume it later
  sentTranscript?: boolean // has this chat already received the video transcript?
  createdAt: number
  updatedAt: number
  messages: Message[]
}

const PREFIX = "session:"

export const newId = () => crypto.randomUUID()

export function createSession(provider: ProviderKey, title: string, pageUrl: string): Session {
  const now = Date.now()
  return { id: newId(), provider, title, pageUrl, siteKey: siteKey(pageUrl), createdAt: now, updatedAt: now, messages: [] }
}

/** Identifies the page content: ignores ?query and #hash (SPAs like Quran.com churn these constantly). */
export function normalizeUrl(raw: string) {
  try {
    const u = new URL(raw)
    if (u.hostname.includes("youtube.com") && u.pathname === "/watch") {
      return `${u.origin}/watch?v=${u.searchParams.get("v")}`
    }
    return u.origin + u.pathname.replace(/\/$/, "")
  } catch {
    return raw
  }
}

/** Sessions stick to a site, so navigating inside it keeps the same chat. YouTube is per video. */
export function siteKey(raw: string) {
  try {
    const u = new URL(raw)
    if (u.hostname.includes("youtube.com") && u.pathname === "/watch") {
      return `${u.hostname}|${u.searchParams.get("v")}`
    }
    return u.hostname
  } catch {
    return raw
  }
}

export async function listSessions(): Promise<Session[]> {
  const all = await chrome.storage.local.get(null)
  return Object.entries(all)
    .filter(([k]) => k.startsWith(PREFIX))
    .map(([, v]) => v as Session)
    .sort((a, b) => b.updatedAt - a.updatedAt)
}

export async function saveSession(s: Session) {
  s.updatedAt = Date.now()
  await chrome.storage.local.set({ [PREFIX + s.id]: s })
}

export async function deleteSession(id: string) {
  await chrome.storage.local.remove(PREFIX + id)
}

export async function getActiveId(): Promise<string | undefined> {
  return (await chrome.storage.local.get("activeSessionId")).activeSessionId
}

export async function setActiveId(id?: string) {
  if (id) await chrome.storage.local.set({ activeSessionId: id })
  else await chrome.storage.local.remove("activeSessionId")
}