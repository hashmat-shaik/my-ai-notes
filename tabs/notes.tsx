import "../styles/panel.css"
import "../styles/notes.css"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"

import { Icon } from "../components/Icon"
import { MergeReview } from "../components/MergeReview"
import { htmlToMarkdown, markdownToSafeHtml } from "../lib/markdown"
import {
  applyItems,
  buildMergePrompt,
  buildNoteContext,
  parseHeadings,
  parseMergeResponse,
  validateItems,
  type Heading,
  type MergeItem,
  type PinInput,
  type PinMeta
} from "../lib/merge"
import {
  addSnapshot,
  createNote,
  deleteNote,
  getNote,
  listNotes,
  listSnapshots,
  saveNote,
  type Note,
  type Snapshot
} from "../lib/notes-db"
import { askProvider, PROVIDERS, stopAsk, type ProviderKey } from "../lib/remote-chat"
import { listSessions, saveSession, type Session } from "../lib/sessions"

/* ---------------- helpers ---------------- */

const NOTE_BUDGET = 60000 // chars of note sent in full; larger notes send outline + relevant sections
const PIN_ANSWER_CAP = 6000
const PIN_TOTAL_BUDGET = 90000 // chars of pinned answers per merge, so one message stays within chat limits
const MAX_PINS_PER_MERGE = 30
const pinCap = (n: number) => Math.max(800, Math.min(PIN_ANSWER_CAP, Math.floor(PIN_TOTAL_BUDGET / Math.max(1, n))))

type Pin = {
  id: string
  sessionId: string
  question: string
  answer: string
  pageTitle: string
  pageUrl: string
  host: string
  ts: number
}

function collectPins(sessions: Session[]): Pin[] {
  const pins: Pin[] = []
  for (const s of sessions) {
    s.messages.forEach((m, i) => {
      if (m.role !== "assistant" || !m.pinned) return
      const prev = s.messages[i - 1]
      const url = m.pageUrl || s.contextUrl || s.pageUrl
      let host = ""
      try {
        host = new URL(url).hostname.replace(/^www\./, "")
      } catch {}
      pins.push({
        id: m.id,
        sessionId: s.id,
        question: prev?.role === "user" ? prev.content : "(question not found)",
        answer: m.content,
        pageTitle: m.pageTitle || s.title,
        pageUrl: url,
        host,
        ts: m.ts
      })
    })
  }
  return pins.sort((a, b) => b.ts - a.ts)
}

function ago(ts: number) {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000))
  if (s < 10) return "just now"
  if (s < 60) return `${s}s ago`
  const m = Math.round(s / 60)
  if (m < 60) return `${m} min ago`
  const h = Math.round(m / 60)
  if (h < 24) return `${h} h ago`
  return new Date(ts).toLocaleDateString()
}

const ymd = (ts: number) => new Date(ts).toLocaleDateString("en-CA") // YYYY-MM-DD, local time
const fmtK = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n))

function download(name: string, text: string, type = "text/markdown") {
  const url = URL.createObjectURL(new Blob([text], { type }))
  const a = document.createElement("a")
  a.href = url
  a.download = name
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

const safeName = (t: string) => t.replace(/[\\/:*?"<>|]+/g, "-").trim() || "notes"

type MergeState =
  | { phase: "idle" }
  | { phase: "running"; startedAt: number; status: string; info: string }
  | { phase: "review"; noteId: string; items: MergeItem[]; pinMeta: Map<number, PinMeta>; pinByN: Map<number, Pin> }
  | { phase: "error"; message: string; raw?: string }

type LastMerge = { noteId: string; snapshot: string; unpinned: Pin[]; applied: number }

/* ---------------- page ---------------- */

export default function NotesPage() {
  const [notes, setNotes] = useState<Note[]>([])
  const [loaded, setLoaded] = useState(false)
  const [draft, setDraft] = useState<Note | null>(null)
  const [mode, setMode] = useState<"edit" | "preview">("edit")
  const [saveState, setSaveState] = useState<"saved" | "saving" | "dirty">("saved")
  const [savedAt, setSavedAt] = useState(0)
  const [now, setNow] = useState(Date.now())
  const [menu, setMenu] = useState<null | "lib" | "more">(null)
  const [newName, setNewName] = useState("")
  const [filter, setFilter] = useState("")
  const [collapsed, setCollapsed] = useState<Set<number>>(new Set())
  const [activeIdx, setActiveIdx] = useState(-1)
  const [pins, setPins] = useState<Pin[]>([])
  const [skipPins, setSkipPins] = useState<Set<string>>(new Set()) // pins excluded from the next merge
  const [openPin, setOpenPin] = useState("")
  const [showRight, setShowRight] = useState(() => window.innerWidth >= 1000)
  const [toast, setToast] = useState("")

  const [merge, setMerge] = useState<MergeState>({ phase: "idle" })
  const [accepted, setAccepted] = useState<Record<string, boolean>>({})
  const [mergeProvider, setMergeProvider] = useState<ProviderKey>("claude")
  const [lastMerge, setLastMerge] = useState<LastMerge | null>(null)
  const [showVersions, setShowVersions] = useState(false)
  const [snaps, setSnaps] = useState<Snapshot[]>([])

  const taRef = useRef<HTMLTextAreaElement>(null)
  const previewRef = useRef<HTMLDivElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const draftRef = useRef<Note | null>(null)
  const dirty = useRef(false)
  const timer = useRef<number>()

  const showToast = (msg: string) => {
    setToast(msg)
    window.setTimeout(() => setToast(""), 3500)
  }

  /* ----- saving ----- */

  const flush = useCallback(async () => {
    window.clearTimeout(timer.current)
    const d = draftRef.current
    if (!d || !dirty.current) return
    dirty.current = false
    setSaveState("saving")
    try {
      const saved = await saveNote({ ...d })
      setSavedAt(saved.updatedAt)
      setSaveState(dirty.current ? "dirty" : "saved")
      setNotes(await listNotes())
    } catch (e) {
      dirty.current = true
      setSaveState("dirty")
      showToast("Couldn't save: " + ((e as Error)?.message || "unknown error"))
    }
  }, [])

  const edit = (patch: Partial<Note>) => {
    if (!draftRef.current) return
    const next = { ...draftRef.current, ...patch }
    draftRef.current = next
    setDraft(next)
    dirty.current = true
    setSaveState("dirty")
    window.clearTimeout(timer.current)
    timer.current = window.setTimeout(flush, 700)
  }

  /* ----- loading ----- */

  const loadPins = useCallback(async () => setPins(collectPins(await listSessions())), [])

  useEffect(() => {
    ;(async () => {
      const all = await listNotes()
      setNotes(all)
      const stored = await chrome.storage.local.get(["activeNoteId", "mergeProvider"])
      if (stored.mergeProvider === "claude" || stored.mergeProvider === "gemini") setMergeProvider(stored.mergeProvider)
      const target = all.find((n) => n.id === stored.activeNoteId) ?? all[0]
      if (target) {
        draftRef.current = target
        setDraft(target)
        setSavedAt(target.updatedAt)
      }
      setLoaded(true)
      loadPins()
    })()
  }, [loadPins])

  // Pins change in the Research panel => refresh live.
  useEffect(() => {
    const onChanged = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
      if (area === "local" && Object.keys(changes).some((k) => k.startsWith("session:"))) loadPins()
    }
    chrome.storage.onChanged.addListener(onChanged)
    return () => chrome.storage.onChanged.removeListener(onChanged)
  }, [loadPins])

  // Flush on Ctrl/Cmd+S and when the tab is hidden or closed; keep "Saved x ago" fresh.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
        e.preventDefault()
        flush()
      }
    }
    const onHide = () => {
      if (document.visibilityState === "hidden") flush()
    }
    const onMouse = (e: MouseEvent) => {
      if (!(e.target as Element).closest("[data-menu]")) setMenu(null)
    }
    window.addEventListener("keydown", onKey)
    window.addEventListener("pagehide", flush)
    document.addEventListener("visibilitychange", onHide)
    document.addEventListener("mousedown", onMouse)
    return () => {
      window.removeEventListener("keydown", onKey)
      window.removeEventListener("pagehide", flush)
      document.removeEventListener("visibilitychange", onHide)
      document.removeEventListener("mousedown", onMouse)
    }
  }, [flush])

  // One clock: refreshes "Saved x ago" every 20s, and the merge timer every second while running.
  useEffect(() => {
    const ms = merge.phase === "running" ? 1000 : 20000
    const t = window.setInterval(() => setNow(Date.now()), ms)
    return () => window.clearInterval(t)
  }, [merge.phase])

  useEffect(() => {
    document.title = draft ? `${draft.title || "Untitled"} — Notes` : "Notes"
  }, [draft?.title])

  /* ----- note actions ----- */

  const openNote = async (id: string) => {
    await flush()
    const n = await getNote(id)
    if (!n) return
    draftRef.current = n
    setDraft(n)
    dirty.current = false
    setSaveState("saved")
    setSavedAt(n.updatedAt)
    setActiveIdx(-1)
    setCollapsed(new Set())
    setFilter("")
    setMenu(null)
    await chrome.storage.local.set({ activeNoteId: id })
  }

  const handleCreate = async (name: string) => {
    await flush()
    const n = await createNote(name.trim() || "Untitled notes")
    setNotes(await listNotes())
    setNewName("")
    await openNote(n.id)
    setMode("edit")
  }

  const removeNote = async () => {
    if (!draft || !window.confirm(`Delete "${draft.title}"? This can't be undone (export it first if unsure).`)) return
    window.clearTimeout(timer.current)
    dirty.current = false
    await deleteNote(draft.id)
    const rest = await listNotes()
    setNotes(rest)
    setMenu(null)
    setMerge({ phase: "idle" })
    setLastMerge(null)
    if (rest[0]) {
      await openNote(rest[0].id)
    } else {
      draftRef.current = null
      setDraft(null)
      await chrome.storage.local.remove("activeNoteId")
    }
  }

  const exportCurrent = async () => {
    await flush()
    if (!draftRef.current) return
    download(`${safeName(draftRef.current.title)}.md`, draftRef.current.content)
    setMenu(null)
  }

  const backupAll = async () => {
    await flush()
    const all = await listNotes()
    download(
      `ai-notes-backup-${new Date().toISOString().slice(0, 10)}.json`,
      JSON.stringify({ version: 1, exportedAt: new Date().toISOString(), notes: all }, null, 2),
      "application/json"
    )
    setMenu(null)
  }

  const importFiles = async (files: FileList | null) => {
    if (!files?.length) return
    await flush()
    const existing = new Set((await listNotes()).map((n) => n.title))
    const unique = (t: string) => {
      let name = t
      let i = 2
      while (existing.has(name)) name = `${t} (${i++})`
      existing.add(name)
      return name
    }
    let last: Note | null = null
    let count = 0
    for (const f of Array.from(files)) {
      let text = ""
      try {
        text = await f.text()
      } catch {
        showToast(`Couldn't read ${f.name}.`)
        continue
      }
      if (/\.json$/i.test(f.name)) {
        try {
          const data = JSON.parse(text)
          for (const n of data.notes ?? []) {
            if (typeof n?.content === "string") {
              last = await createNote(unique(String(n.title || "Imported")), n.content)
              count++
            }
          }
        } catch {
          showToast(`${f.name} isn't a valid backup file.`)
        }
      } else {
        try {
          last = await createNote(unique(f.name.replace(/\.(md|markdown|txt)$/i, "")), text)
          count++
        } catch {
          showToast(`Couldn't import ${f.name}.`)
        }
      }
    }
    if (fileRef.current) fileRef.current.value = ""
    setNotes(await listNotes())
    setMenu(null)
    if (last) await openNote(last.id)
    if (count) showToast(`Imported ${count} note${count === 1 ? "" : "s"}.`)
  }

  /* ----- pins ----- */

  const setPinned = async (p: Pin, value: boolean) => {
    const s = (await listSessions()).find((x) => x.id === p.sessionId)
    if (!s) return
    s.messages = s.messages.map((m) => (m.id === p.id ? { ...m, pinned: value } : m))
    await saveSession(s) // the storage change event refreshes the list (here and in the side panel)
  }

  const togglePinSel = (id: string) =>
    setSkipPins((prev) => {
      const next = new Set(prev)
      next.has(id) ? next.delete(id) : next.add(id)
      return next
    })

  const selectedPins = useMemo(() => pins.filter((p) => !skipPins.has(p.id)), [pins, skipPins])

  /* ----- outline ----- */

  const content = draft?.content ?? ""
  const headings = useMemo(() => parseHeadings(content), [content])

  const visibleHeadings = useMemo(() => {
    if (filter.trim()) return headings.filter((h) => h.text.toLowerCase().includes(filter.trim().toLowerCase()))
    const out: Heading[] = []
    let skipBelow = 0
    for (const h of headings) {
      if (skipBelow && h.level > skipBelow) continue
      skipBelow = 0
      out.push(h)
      if (collapsed.has(h.idx)) skipBelow = h.level
    }
    return out
  }, [headings, filter, collapsed])

  const hasKids = (h: Heading) => (headings[h.idx + 1]?.level ?? 0) > h.level

  const toggleCollapse = (idx: number) =>
    setCollapsed((prev) => {
      const next = new Set(prev)
      next.has(idx) ? next.delete(idx) : next.add(idx)
      return next
    })

  const jumpTo = (h: Heading, forceMode?: "edit" | "preview") => {
    setActiveIdx(h.idx)
    if ((forceMode ?? mode) === "edit") {
      const ta = taRef.current
      if (!ta) return
      ta.focus()
      ta.setSelectionRange(h.offset, h.offset + h.length)
      ta.scrollTop = Math.max(0, (h.offset / Math.max(1, ta.value.length)) * ta.scrollHeight - 60)
    } else {
      const els = Array.from(previewRef.current?.querySelectorAll("h1,h2,h3,h4,h5,h6") ?? [])
      const clean = (s: string) => s.replace(/[*_`]/g, "").replace(/\s+/g, " ").trim().toLowerCase()
      const nth = headings.filter((x) => x.idx < h.idx && clean(x.text) === clean(h.text)).length
      const same = els.filter((el) => clean(el.textContent || "") === clean(h.text))
      ;(same[nth] ?? els[h.idx])?.scrollIntoView({ behavior: "smooth", block: "start" })
    }
  }

  /** Used by the merge review ("Found in: …"): switch to the editor and jump to that heading. */
  const jumpToIdx = (idx: number) => {
    setMode("edit")
    requestAnimationFrame(() => {
      const h = parseHeadings(draftRef.current?.content ?? "")[idx]
      if (h) jumpTo(h, "edit")
    })
  }

  const onCaret = () => {
    const ta = taRef.current
    if (!ta) return
    let a = -1
    for (const h of headings) {
      if (h.offset <= ta.selectionStart) a = h.idx
      else break
    }
    setActiveIdx(a)
  }

  const previewHtml = useMemo(() => (mode === "preview" ? markdownToSafeHtml(content) : ""), [mode, content])
  const words = useMemo(() => (content.trim().match(/\S+/g) || []).length, [content])

  /* ----- AI merge ----- */

  const estTokens = useMemo(() => {
    const noteChars = Math.min(content.length, NOTE_BUDGET)
    const pinChars = selectedPins.reduce((n, p) => n + p.question.length + Math.min(p.answer.length, pinCap(selectedPins.length)), 0)
    return Math.round((noteChars + pinChars + 1800) / 4)
  }, [content, selectedPins])

  const canMerge = !!draft && selectedPins.length > 0 && merge.phase !== "running"

  const runMerge = async () => {
    if (!draftRef.current || merge.phase === "running") return
    const chosen = selectedPins
    if (!chosen.length) return
    if (chosen.length > MAX_PINS_PER_MERGE) {
      showToast(`Select at most ${MAX_PINS_PER_MERGE} pins per merge, then run it again for the rest.`)
      return
    }
    await flush()
    setShowRight(true)
    setLastMerge(null)

    const note = draftRef.current
    const inputs: PinInput[] = chosen.map((p, i) => ({
      n: i + 1,
      question: p.question,
      answer: p.answer.slice(0, pinCap(chosen.length)),
      title: p.pageTitle,
      url: p.pageUrl,
      date: ymd(p.ts)
    }))
    const ctx = buildNoteContext(note.content, inputs, NOTE_BUDGET)
    const prompt = buildMergePrompt(ctx.text, inputs, ctx.trimmed)

    setMerge({
      phase: "running",
      startedAt: Date.now(),
      status: "Preparing…",
      info: ctx.trimmed ? `Large note: sending the outline plus ${ctx.shown} of ${ctx.total} sections.` : ""
    })
    setNow(Date.now())

    try {
      const tab = await chrome.tabs.getCurrent()
      const res = await askProvider(mergeProvider, prompt, {
        fresh: true, // always a clean chat, separate from your research conversation
        slot: "merge",
        returnToTabId: tab?.id,
        onStatus: (status) => setMerge((m) => (m.phase === "running" ? { ...m, status } : m))
      })

      if (res.ok === false) {
        setMerge(res.error === "Stopped." ? { phase: "idle" } : { phase: "error", message: res.error })
        return
      }
      if (res.stopped) {
        setMerge({ phase: "error", message: "Stopped before the AI finished, so nothing was merged." })
        return
      }

      const md = htmlToMarkdown(res.html)
      const parsed = parseMergeResponse(md)
      if (!parsed.length) {
        setMerge({
          phase: "error",
          message: "I couldn't read the AI's answer as merge items; it may have ignored the requested format. Try again.",
          raw: md
        })
        return
      }

      // Check against the note as it is NOW (you may have kept typing while it ran).
      const current =
        draftRef.current?.id === note.id ? draftRef.current.content : (await getNote(note.id))?.content
      const items = validateItems(current ?? note.content, parsed)
      const init: Record<string, boolean> = {}
      for (const it of items) {
        // Suspected duplicates and unlocatable refinements start unchecked: strictness is the point.
        init[it.id] = it.action !== "SKIP" && it.status !== "old-not-found" && !it.similar
      }
      setAccepted(init)
      setMerge({
        phase: "review",
        noteId: note.id,
        items,
        pinMeta: new Map(inputs.map((p) => [p.n, { n: p.n, title: p.title, url: p.url, date: p.date }])),
        pinByN: new Map(chosen.map((p, i) => [i + 1, p]))
      })
    } catch (e) {
      setMerge({ phase: "error", message: (e as Error)?.message || "Something went wrong." })
    }
  }

  const moveItem = (id: string, target: string) =>
    setMerge((m) => {
      if (m.phase !== "review") return m
      return {
        ...m,
        items: m.items.map((it) => {
          if (it.id !== id) return it
          if (target === "new") {
            return { ...it, targetIdx: undefined, newSection: it.newSection ?? { level: 2, title: it.section || "New topic" } }
          }
          const h = headings[Number(target)]
          if (!h) return it
          return { ...it, targetIdx: h.idx, section: h.text, status: it.action === "REFINE" ? it.status : "ok" }
        })
      }
    })

  const approve = async () => {
    if (merge.phase !== "review") return
    const chosen = merge.items.filter((i) => i.action !== "SKIP" && accepted[i.id])
    if (!chosen.length) return showToast("Nothing selected to add.")

    if (draftRef.current?.id !== merge.noteId) await openNote(merge.noteId)
    await flush()
    const d = draftRef.current
    if (!d) return

    const before = d.content
    await addSnapshot(d.id, before, `Before merging ${chosen.length} item${chosen.length === 1 ? "" : "s"}`)
    const result = applyItems(before, chosen, merge.pinMeta)
    edit({ content: result.content })
    await flush()

    // A pin leaves the list once everything from it was added or was already covered.
    const handled: Pin[] = []
    merge.pinMeta.forEach((_meta, n) => {
      const refs = merge.items.filter((i) => i.pins.includes(n))
      const done = refs.length > 0 && refs.every((i) => i.action === "SKIP" || (accepted[i.id] && result.applied.includes(i.id)))
      const pin = merge.pinByN.get(n)
      if (done && pin) handled.push(pin)
    })
    for (const p of handled) await setPinned(p, false)

    setLastMerge({ noteId: d.id, snapshot: before, unpinned: handled, applied: result.applied.length })
    setMerge({ phase: "idle" })
    setAccepted({})
    if (result.failed.length) {
      showToast(`${result.failed.length} item${result.failed.length === 1 ? "" : "s"} couldn't be applied because the text changed.`)
    }
  }

  const undoMerge = async () => {
    const lm = lastMerge
    if (!lm) return
    if (draftRef.current?.id !== lm.noteId) await openNote(lm.noteId)
    await flush()
    if (draftRef.current && draftRef.current.content !== lm.snapshot) {
      // Edits made after the merge would be lost; keep them in Version history.
      await addSnapshot(draftRef.current.id, draftRef.current.content, "Before undoing a merge")
    }
    edit({ content: lm.snapshot })
    await flush()
    for (const p of lm.unpinned) await setPinned(p, true)
    setLastMerge(null)
    showToast("Merge undone. Anything you typed since is in Version history.")
  }

  /* ----- version history ----- */

  const openVersions = async () => {
    if (!draft) return
    await flush()
    setSnaps(await listSnapshots(draft.id))
    setShowVersions(true)
    setMenu(null)
  }

  const restoreVersion = async (s: Snapshot) => {
    if (!draftRef.current) return
    await flush()
    await addSnapshot(draftRef.current.id, draftRef.current.content, "Before restoring an older version")
    edit({ content: s.content })
    await flush()
    setShowVersions(false)
    showToast("Version restored.")
  }

  /* ---------------- render ---------------- */

  if (!loaded) return <div className="notes-empty muted">Loading notes…</div>

  if (!draft) {
    return (
      <div className="notes-empty">
        <div className="empty-icon">
          <Icon name="notebook" size={24} />
        </div>
        <h2>Create your first note</h2>
        <p className="muted">One note per subject works best — the AI merge reads the whole note to avoid repeating what you already have.</p>
        <form
          className="create-row"
          onSubmit={(e) => {
            e.preventDefault()
            handleCreate(newName || "My notes")
          }}>
          <input value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="Subject, e.g. Machine Learning" autoFocus />
          <button className="btn primary" type="submit">
            Create note
          </button>
        </form>
        <button className="btn" onClick={() => fileRef.current?.click()}>
          <Icon name="upload" size={14} /> Import .md / backup
        </button>
        <input ref={fileRef} type="file" hidden multiple accept=".md,.markdown,.txt,.json" onChange={(e) => importFiles(e.target.files)} />
        {toast && <div className="toast">{toast}</div>}
      </div>
    )
  }

  return (
    <div className="notes-app">
      {/* ---------- top bar ---------- */}
      <header className="notes-top">
        <Icon name="notebook" size={20} />

        <div className="title-wrap" data-menu>
          <input
            className="title-input"
            value={draft.title}
            placeholder="Untitled"
            aria-label="Note title"
            size={Math.max(10, draft.title.length + 2)}
            onChange={(e) => edit({ title: e.target.value })}
          />
          <button className="icon-btn" aria-label="Switch note" onClick={() => setMenu(menu === "lib" ? null : "lib")}>
            <Icon name="chevron-down" />
          </button>

          {menu === "lib" && (
            <div className="menu">
              <div className="menu-label">Your notes</div>
              <div className="menu-scroll">
                {notes.map((n) => (
                  <button key={n.id} className={`menu-item ${n.id === draft.id ? "current" : ""}`} onClick={() => openNote(n.id)}>
                    <span className="menu-title">{n.title || "Untitled"}</span>
                    <span className="muted">{ago(n.updatedAt)}</span>
                  </button>
                ))}
              </div>
              <div className="menu-sep" />
              <form
                className="menu-create"
                onSubmit={(e) => {
                  e.preventDefault()
                  handleCreate(newName)
                }}>
                <input value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="New note name…" />
                <button className="btn primary" type="submit">
                  <Icon name="plus" size={14} />
                </button>
              </form>
            </div>
          )}
        </div>

        <span className={`save ${saveState}`} role="status">
          <span className="dot" />
          {saveState === "saving" ? "Saving…" : saveState === "dirty" ? "Unsaved changes" : `Saved ${ago(savedAt)}`}
        </span>

        <div className="spacer" />

        <button
          className="btn primary"
          disabled={!canMerge}
          onClick={runMerge}
          title={
            selectedPins.length === 0
              ? "Pin answers in the Research panel, then merge them here"
              : `Merge ${selectedPins.length} pinned Q&A${selectedPins.length === 1 ? "" : "s"} into this note`
          }>
          <Icon name="plus" size={14} /> {merge.phase === "running" ? "Merging…" : `Add pinned (${selectedPins.length})`}
        </button>
        <button className={`icon-btn ${showRight ? "on" : ""}`} title="Toggle side panel" aria-label="Toggle side panel" onClick={() => setShowRight((v) => !v)}>
          <Icon name="panel-right" />
        </button>

        <div className="more-wrap" data-menu>
          <button className="icon-btn" aria-label="More actions" onClick={() => setMenu(menu === "more" ? null : "more")}>
            <Icon name="more" />
          </button>
          {menu === "more" && (
            <div className="menu right">
              <button className="menu-item" onClick={openVersions}>
                <Icon name="history" size={15} /> Version history…
              </button>
              <div className="menu-sep" />
              <button className="menu-item" onClick={exportCurrent}>
                <Icon name="download" size={15} /> Export this note (.md)
              </button>
              <button className="menu-item" onClick={backupAll}>
                <Icon name="download" size={15} /> Back up all notes (.json)
              </button>
              <button className="menu-item" onClick={() => fileRef.current?.click()}>
                <Icon name="upload" size={15} /> Import .md or backup…
              </button>
              <div className="menu-sep" />
              <button className="menu-item danger" onClick={removeNote}>
                <Icon name="trash" size={15} /> Delete this note
              </button>
            </div>
          )}
        </div>
        <input ref={fileRef} type="file" hidden multiple accept=".md,.markdown,.txt,.json" onChange={(e) => importFiles(e.target.files)} />
      </header>

      <div className={`notes-body ${showRight ? "" : "no-right"} ${merge.phase === "review" ? "review" : ""}`}>
        {/* ---------- outline ---------- */}
        <aside className="outline">
          <div className="side-head">
            <strong>Outline</strong>
          </div>
          <div className="search-box">
            <Icon name="search" size={14} />
            <input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Search headings…" aria-label="Search headings" />
          </div>
          <div className="side-scroll">
            {visibleHeadings.length === 0 && (
              <p className="muted pad">{filter ? "No matching headings." : "Add headings (## Topic) and they'll appear here."}</p>
            )}
            {visibleHeadings.map((h) => (
              <div
                key={h.idx}
                className={`outline-item lvl-${Math.min(h.level, 4)} ${activeIdx === h.idx ? "active" : ""}`}
                style={{ paddingLeft: 8 + (filter ? 0 : (h.level - 1) * 14) }}>
                {!filter && hasKids(h) ? (
                  <button className="caret" aria-label={collapsed.has(h.idx) ? "Expand" : "Collapse"} onClick={() => toggleCollapse(h.idx)}>
                    <Icon name={collapsed.has(h.idx) ? "chevron-right" : "chevron-down"} size={13} />
                  </button>
                ) : (
                  <span className="caret-spacer" />
                )}
                <button className="outline-text" onClick={() => jumpTo(h)} title={h.text}>
                  {h.text}
                </button>
              </div>
            ))}
          </div>
        </aside>

        {/* ---------- editor / preview ---------- */}
        <section className="editor-area">
          {lastMerge && lastMerge.noteId === draft.id && (
            <div className="undo-bar" role="status">
              <Icon name="check" size={14} />
              <span>
                Merged {lastMerge.applied} item{lastMerge.applied === 1 ? "" : "s"}
                {lastMerge.unpinned.length > 0 && ` · ${lastMerge.unpinned.length} pin${lastMerge.unpinned.length === 1 ? "" : "s"} cleared`}.
              </span>
              <button className="link" onClick={undoMerge}>
                Undo
              </button>
              <span className="spacer" />
              <button className="icon-btn sm" aria-label="Dismiss" onClick={() => setLastMerge(null)}>
                <Icon name="x" size={13} />
              </button>
            </div>
          )}

          <div className="editor-bar">
            <div className="seg" role="group" aria-label="Editor mode">
              <button className={mode === "edit" ? "active" : ""} onClick={() => setMode("edit")}>
                <Icon name="edit" size={13} /> Edit
              </button>
              <button className={mode === "preview" ? "active" : ""} onClick={() => setMode("preview")}>
                <Icon name="eye" size={13} /> Preview
              </button>
            </div>
            <div className="spacer" />
            <span className="muted small">
              {words.toLocaleString()} words · {headings.length} headings
            </span>
          </div>

          {mode === "edit" ? (
            <textarea
              ref={taRef}
              className="editor"
              value={content}
              spellCheck
              placeholder="Start writing in Markdown…"
              onChange={(e) => edit({ content: e.target.value })}
              onKeyUp={onCaret}
              onClick={onCaret}
            />
          ) : (
            <div className="preview-scroll">
              <div ref={previewRef} className="md preview" dangerouslySetInnerHTML={{ __html: previewHtml }} />
            </div>
          )}
        </section>

        {/* ---------- pinned + merge ---------- */}
        {showRight && (
          <aside className="side-right">
            {merge.phase === "review" ? (
              <MergeReview
                items={merge.items}
                accepted={accepted}
                headings={headings}
                pinMeta={merge.pinMeta}
                onSet={(id, v) => setAccepted((a) => ({ ...a, [id]: v }))}
                onMove={moveItem}
                onJump={jumpToIdx}
                onRejectAll={() => setAccepted({})}
                onApprove={approve}
                onDiscard={() => {
                  setMerge({ phase: "idle" })
                  setAccepted({})
                }}
              />
            ) : (
              <>
                <div className="side-head">
                  <Icon name="bookmark" size={15} />
                  <strong>Pinned Q&amp;As</strong>
                  <span className="muted">({pins.length})</span>
                  <span className="spacer" />
                  {pins.length > 1 && (
                    <>
                      <button className="link small" onClick={() => setSkipPins(new Set())}>
                        All
                      </button>
                      <button className="link small" onClick={() => setSkipPins(new Set(pins.map((p) => p.id)))}>
                        None
                      </button>
                    </>
                  )}
                </div>
                <div className="side-scroll">
                  {pins.length === 0 ? (
                    <p className="muted pad">
                      Pin an answer in the Research panel (bookmark icon) and it will show up here, ready to merge into your notes.
                    </p>
                  ) : (
                    pins.map((p) => (
                      <div key={p.id} className={`pin-card ${openPin === p.id ? "open" : ""} ${skipPins.has(p.id) ? "muted-card" : ""}`}>
                        <div className="pin-top">
                          <input
                            type="checkbox"
                            aria-label="Include in the next merge"
                            checked={!skipPins.has(p.id)}
                            disabled={merge.phase === "running"}
                            onChange={() => togglePinSel(p.id)}
                          />
                          <button className="pin-head" aria-expanded={openPin === p.id} onClick={() => setOpenPin(openPin === p.id ? "" : p.id)}>
                            <div className="pin-main">
                              <div className="pin-q">{p.question}</div>
                              <div className="pin-meta" title={p.pageTitle}>
                                {p.host || "page"} · {new Date(p.ts).toLocaleDateString()}
                              </div>
                            </div>
                            <Icon name={openPin === p.id ? "chevron-down" : "chevron-right"} size={15} />
                          </button>
                        </div>
                        {openPin === p.id && (
                          <div className="pin-body">
                            <div className="md" dangerouslySetInnerHTML={{ __html: markdownToSafeHtml(p.answer) }} />
                            <div className="pin-actions">
                              <a className="btn" href={p.pageUrl} target="_blank" rel="noopener noreferrer">
                                <Icon name="external" size={13} /> Source
                              </a>
                              <button className="btn" onClick={() => setPinned(p, false)}>
                                Unpin
                              </button>
                            </div>
                          </div>
                        )}
                      </div>
                    ))
                  )}

                  {merge.phase === "running" && (
                    <div className="merge-card">
                      <div className="merge-title">
                        <span className="spinner" /> Merging with {PROVIDERS[mergeProvider].label}…
                      </div>
                      <p className="muted">
                        {merge.status} · {Math.max(0, Math.round((now - merge.startedAt) / 1000))}s
                      </p>
                      {merge.info && <p className="muted">{merge.info}</p>}
                      <button className="btn" onClick={() => stopAsk(mergeProvider, "merge")}>
                        Cancel
                      </button>
                    </div>
                  )}

                  {merge.phase === "error" && (
                    <div className="merge-card error">
                      <div className="merge-title">
                        <Icon name="alert" size={15} /> Merge didn't finish
                      </div>
                      <p>{merge.message}</p>
                      {merge.raw && (
                        <details>
                          <summary className="muted small">What the AI replied</summary>
                          <pre className="raw">{merge.raw}</pre>
                        </details>
                      )}
                      <div className="row">
                        <button className="btn primary" disabled={!canMerge} onClick={runMerge}>
                          Try again
                        </button>
                        <button className="btn" onClick={() => setMerge({ phase: "idle" })}>
                          Dismiss
                        </button>
                      </div>
                    </div>
                  )}

                  {merge.phase === "idle" && (
                    <div className="merge-card">
                      <div className="merge-title">
                        <Icon name="sparkle" size={15} /> AI Merge
                      </div>
                      <p className="muted">
                        Compares the checked pins with this whole note and shows only what's new or refined, plus what it skipped as already covered. Nothing is written until you approve.
                      </p>
                      <div className="merge-opts">
                        <span className="muted small">Merge with</span>
                        <div className="seg small" role="group" aria-label="AI provider for merging">
                          {(Object.keys(PROVIDERS) as ProviderKey[]).map((k) => (
                            <button
                              key={k}
                              className={mergeProvider === k ? "active" : ""}
                              onClick={() => {
                                setMergeProvider(k)
                                chrome.storage.local.set({ mergeProvider: k })
                              }}>
                              {PROVIDERS[k].label}
                            </button>
                          ))}
                        </div>
                      </div>
                      <p className="muted small">
                        ~{fmtK(estTokens)} tokens go to {PROVIDERS[mergeProvider].label} in a separate chat (your research chat is untouched).
                      </p>
                    </div>
                  )}
                </div>
              </>
            )}
          </aside>
        )}
      </div>

      {/* ---------- version history ---------- */}
      {showVersions && (
        <div className="modal-back" onMouseDown={() => setShowVersions(false)}>
          <div className="modal" role="dialog" aria-label="Version history" onMouseDown={(e) => e.stopPropagation()}>
            <div className="modal-head">
              <strong>Version history</strong>
              <span className="spacer" />
              <button className="icon-btn" aria-label="Close" onClick={() => setShowVersions(false)}>
                <Icon name="x" />
              </button>
            </div>
            <p className="muted small pad">A copy is saved automatically before every merge and every restore.</p>
            <div className="modal-list">
              {snaps.length === 0 && <p className="muted pad">No versions yet. They appear after your first merge.</p>}
              {snaps.map((s) => (
                <div key={s.id} className="session-row">
                  <div className="session-main">
                    <div className="session-title">{s.reason}</div>
                    <div className="session-sub">
                      {new Date(s.createdAt).toLocaleString()} · {s.content.split(/\s+/).filter(Boolean).length.toLocaleString()} words
                    </div>
                  </div>
                  <button className="btn" onClick={() => restoreVersion(s)}>
                    Restore
                  </button>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {toast && (
        <div className="toast" role="status">
          {toast}
        </div>
      )}
    </div>
  )
}