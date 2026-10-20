/**
 * AI merge: pure functions only (no browser APIs), so they're easy to test.
 *
 *   buildNoteContext -> buildMergePrompt   (what we send)
 *   parseMergeResponse -> validateItems    (what we get back, checked against the real note)
 *   applyItems                              (writing approved items into the note)
 */

/* ---------------- headings ---------------- */

export type Heading = { level: number; text: string; offset: number; length: number; idx: number }

/** Headings of the markdown, ignoring anything inside ``` fences. */
export function parseHeadings(md: string): Heading[] {
  const out: Heading[] = []
  let inFence = false
  let offset = 0
  md.split("\n").forEach((line) => {
    if (/^\s{0,3}(```|~~~)/.test(line)) {
      inFence = !inFence
    } else if (!inFence) {
      const m = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line)
      if (m) {
        out.push({ level: m[1].length, text: m[2].replace(/[*_`]/g, ""), offset, length: line.length, idx: out.length })
      }
    }
    offset += line.length + 1
  })
  return out
}

const norm = (s: string) => s.replace(/[#*_`]/g, "").replace(/\s+/g, " ").trim().toLowerCase()

export function findHeading(headings: Heading[], name: string): Heading | undefined {
  const n = norm(name)
  if (!n) return undefined
  return (
    headings.find((h) => norm(h.text) === n) ??
    headings.find((h) => {
      const t = norm(h.text)
      return t.includes(n) || (t.length >= 4 && n.includes(t))
    })
  )
}

function sectionAt(headings: Heading[], offset: number): Heading | undefined {
  let found: Heading | undefined
  for (const h of headings) {
    if (h.offset <= offset) found = h
    else break
  }
  return found
}

/* ---------------- types ---------------- */

export type PinInput = { n: number; question: string; answer: string; title: string; url: string; date: string }
export type PinMeta = { n: number; title: string; url: string; date: string }

export type MergeItem = {
  id: string
  action: "NEW" | "REFINE" | "SKIP"
  pins: number[]
  section: string // target heading text (NEW) / where it already lives (SKIP)
  newSection?: { level: number; title: string }
  old?: string // REFINE: passage to replace
  text: string // NEW / REFINE markdown (no Source line — added on apply)
  why: string
  // ---- filled in by validateItems ----
  status: "ok" | "old-not-found" | "new-section"
  targetIdx?: number // heading to insert under (undefined => create a new section)
  foundIn?: string // REFINE / SKIP: heading where the existing content lives
  foundIdx?: number
  similar?: { score: number; snippet: string } // local check: NEW text resembles existing text
}

/* ---------------- what we send ---------------- */

const STOP = new Set([
  "the", "and", "for", "that", "with", "this", "from", "are", "was", "were", "have", "has", "its", "can",
  "which", "into", "than", "then", "also", "such", "not", "but", "you", "your", "they", "their", "there",
  "about", "would", "could", "should", "what", "when", "where", "while", "these", "those", "each", "other"
])

function keywords(text: string): Set<string> {
  return new Set((text.toLowerCase().match(/[a-z]{5,}/g) ?? []).filter((w) => !STOP.has(w)))
}

/**
 * Sends the whole note when it fits. For very large notes: the full outline plus the sections that
 * share the most vocabulary with the new material.
 */
export function buildNoteContext(content: string, pins: PinInput[], budget = 60000) {
  if (content.length <= budget) return { text: content, trimmed: false, shown: 0, total: 0 }

  const headings = parseHeadings(content)
  const cuts = headings.filter((h) => h.level <= 2)
  const sections: { start: number; end: number }[] = []
  const firstStart = cuts.length ? cuts[0].offset : content.length
  if (firstStart > 0) sections.push({ start: 0, end: firstStart })
  cuts.forEach((h, i) => sections.push({ start: h.offset, end: cuts[i + 1]?.offset ?? content.length }))

  const outline = headings.map((h) => `${"#".repeat(h.level)} ${h.text}`).join("\n")
  const kw = keywords(pins.map((p) => `${p.question} ${p.answer}`).join(" "))

  const scored = sections
    .map((s, i) => {
      const t = content.slice(s.start, s.end).toLowerCase()
      let hits = 0
      kw.forEach((w) => {
        if (t.includes(w)) hits++
      })
      return { i, s, score: hits / Math.log(t.length + 10) }
    })
    .sort((a, b) => b.score - a.score)

  let used = outline.length + 400
  const chosen = new Set<number>()
  for (const x of scored) {
    const len = x.s.end - x.s.start
    if (used + len > budget) continue
    chosen.add(x.i)
    used += len
  }

  const body = sections
    .filter((_, i) => chosen.has(i))
    .map((s) => content.slice(s.start, s.end).trimEnd())
    .join("\n\n")

  return {
    text: `FULL OUTLINE OF THE NOTES:\n${outline}\n\nSECTIONS MOST RELEVANT TO THE NEW MATERIAL (others omitted):\n\n${body}`,
    trimmed: true,
    shown: chosen.size,
    total: sections.length
  }
}

export function buildMergePrompt(notes: string, pins: PinInput[], trimmed: boolean): string {
  const material = pins
    .map((p) => `[${p.n}] Source: ${p.title || "page"} (${p.url || "no url"}), ${p.date}\nQ: ${p.question}\nA: ${p.answer}`)
    .join("\n\n---\n\n")

  return `You are merging new study material into my existing notes. The goal: add ONLY what the notes do not already contain, and never repeat existing content.

${trimmed ? "NOTE: the notes below are shortened (a full outline plus the most relevant sections). Treat omitted sections as unknown.\n\n" : ""}EXISTING NOTES (markdown):
<notes>
${notes}
</notes>

NEW MATERIAL (numbered Q&As from my study sessions):
<material>
${material}
</material>

TASK
1. Split the material into atomic concepts or facts.
2. Compare each against the WHOLE notes and choose one action:
   - NEW: the notes don't cover it.
   - REFINE: the notes cover it, but incompletely or imprecisely; replace that passage with an improved version.
   - SKIP: already fully covered (the same idea in different words counts as covered).
3. Be strict about duplicates. When unsure between SKIP and NEW, choose SKIP.
4. Write NEW/REFINE text as concise note-style markdown that matches the notes' existing conventions (for example "- **Term**: one-line definition"). Use only facts from the material. Do NOT write "Source:" lines; they are added automatically.
5. "section" is the exact text of the existing heading (without the # signs) where the item belongs. For SKIP, it is where the content already lives. If no heading fits, write: NEW_SECTION | <level 2 or 3> | <new heading title>
6. REFINE needs an @@OLD block: copy the passage to replace verbatim from the notes (1-4 contiguous lines, never "Source:" lines).

OUTPUT FORMAT: reply with ONE code block and nothing else, in exactly this layout (one block per item):

\`\`\`text
@@ITEM
action: NEW
pins: 1, 3
section: Hypothesis Space
@@NEW
- **Term**: definition
@@WHY
one short line: why this is new
@@END
@@ITEM
action: REFINE
pins: 2
section: Empirical Risk Minimization
@@OLD
- **ERM**: Find a hypothesis that minimizes loss.
@@NEW
- **ERM**: Find the hypothesis h in H that minimizes the average loss on the training set.
@@WHY
adds the training-set detail
@@END
@@ITEM
action: SKIP
pins: 4
section: Inductive Bias
@@WHY
already defined under "Inductive Bias"
@@END
\`\`\`

Rules for the block: no JSON, no triple backticks inside the text, and every item ends with @@END.`
}

/* ---------------- what we get back ---------------- */

export function parseMergeResponse(md: string): Omit<MergeItem, "status">[] {
  let text = md
  // If it wasn't rendered as a code block, markdown escaping may have crept in; undo it.
  if (!/^```/m.test(md)) text = text.replace(/\\([\\`*_{}\[\]()#+\-.!|>~@])/g, "$1")

  const start = text.indexOf("@@ITEM")
  if (start < 0) return []
  const end = text.lastIndexOf("@@END")
  text = text.slice(start, end >= 0 ? end + 5 : undefined)

  const items: Omit<MergeItem, "status">[] = []
  text
    .split(/^@@ITEM[ \t]*$/m)
    .slice(1)
    .forEach((chunk, i) => {
      const parts = chunk.split(/^@@(OLD|NEW|WHY|END)[ \t]*$/m)
      const header = parts[0]
      const sec: Record<string, string> = {}
      for (let k = 1; k < parts.length; k += 2) {
        if (parts[k] !== "END") sec[parts[k]] = (parts[k + 1] || "").replace(/^\n+/, "").trimEnd()
      }

      const get = (key: string) => new RegExp(`^${key}:[ \\t]*(.*)$`, "im").exec(header)?.[1].trim() ?? ""
      const action = get("action").toUpperCase().replace(/[^A-Z]/g, "") as MergeItem["action"]
      if (!["NEW", "REFINE", "SKIP"].includes(action)) return

      let section = get("section")
      let newSection: MergeItem["newSection"]
      const ns = /NEW[_ ]SECTION\s*\|\s*(\d)\s*\|\s*(.+)$/im.exec(header)
      if (ns) {
        newSection = { level: Math.min(4, Math.max(2, Number(ns[1]))), title: ns[2].trim() }
        section = ""
      }

      const body = (sec.NEW || "")
        .split("\n")
        .filter((l) => !/^\s*Source:/i.test(l)) // we add sources ourselves
        .join("\n")
        .trimEnd()
      if (action !== "SKIP" && !body.trim()) return

      items.push({
        id: `m${i}`,
        action,
        pins: (get("pins").match(/\d+/g) || []).map(Number),
        section,
        newSection,
        old: sec.OLD,
        text: body,
        why: (sec.WHY || "").trim()
      })
    })
  return items
}

/* ---------------- checking against the real note ---------------- */

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

/** Finds `old` in the note: exact first, then tolerant of whitespace differences. */
export function locate(content: string, old: string): { start: number; end: number } | null {
  const o = old.trim()
  if (!o) return null
  const i = content.indexOf(o)
  if (i >= 0) return { start: i, end: i + o.length }
  const m = new RegExp(o.split(/\s+/).map(escapeRe).join("\\s+")).exec(content)
  return m ? { start: m.index, end: m.index + m[0].length } : null
}

function tokens(s: string): Set<string> {
  return new Set(
    s
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length > 2 && !STOP.has(w))
  )
}

/** Local second opinion on "NEW": does this text closely resemble a line already in the note? */
export function findSimilar(content: string, text: string): { score: number; snippet: string } | undefined {
  const a = tokens(text)
  if (a.size < 3) return undefined
  let best = { score: 0, snippet: "" }
  for (const line of content.split("\n")) {
    const t = line.trim()
    if (!t || t.startsWith("#") || t.startsWith("<!--") || /^source:/i.test(t)) continue
    const b = tokens(t)
    if (b.size < 3) continue
    let inter = 0
    a.forEach((w) => {
      if (b.has(w)) inter++
    })
    const jaccard = inter / (a.size + b.size - inter)
    const small = Math.min(a.size, b.size)
    const containment = small >= 5 ? inter / small : 0
    const score = Math.max(jaccard, containment >= 0.8 ? containment : 0)
    if (score > best.score) best = { score, snippet: t.length > 140 ? t.slice(0, 140) + "…" : t }
  }
  return best.score >= 0.5 ? best : undefined
}

export function validateItems(content: string, items: Omit<MergeItem, "status">[]): MergeItem[] {
  const headings = parseHeadings(content)
  return items.map((it) => {
    const out: MergeItem = { ...it, status: "ok" }
    const h = it.section ? findHeading(headings, it.section) : undefined

    const placeNew = () => {
      if (h) {
        out.targetIdx = h.idx
        out.section = h.text
      } else {
        out.targetIdx = undefined
        out.newSection = it.newSection ?? { level: 2, title: it.section || "New topic" }
        out.status = "new-section"
      }
    }

    if (it.action === "NEW") {
      placeNew()
      out.similar = findSimilar(content, it.text)
    } else if (it.action === "REFINE") {
      const loc = it.old ? locate(content, it.old) : null
      if (loc) {
        const s = sectionAt(headings, loc.start)
        out.foundIn = s?.text
        out.foundIdx = s?.idx
      } else {
        placeNew()
        out.status = "old-not-found" // will be inserted as new text instead
      }
    } else if (h) {
      out.foundIn = h.text
      out.foundIdx = h.idx
    }
    return out
  })
}

/* ---------------- writing it into the note ---------------- */

function sourceLine(it: MergeItem, pinMeta: Map<number, PinMeta>): string {
  const pm = it.pins.map((n) => pinMeta.get(n)).find(Boolean)
  if (!pm) return ""
  const title = (pm.title || "source").replace(/[\[\]]/g, "").trim()
  return pm.url ? `Source: [${title}](${pm.url}), ${pm.date}` : `Source: ${title}, ${pm.date}`
}

/** The exact text that will be inserted for a NEW item (also used to preview it). */
export function blockFor(it: MergeItem, pinMeta: Map<number, PinMeta>): string {
  const text = it.text.replace(/\s+$/, "")
  const src = sourceLine(it, pinMeta)
  if (!src) return text
  const indent = /^\s*([-*+]|\d+\.)\s/.test(text) ? "  " : ""
  return `${text}\n${indent}${src}`
}

const LISTY = /^\s*([-*+]|\d+\.)\s/

function insertUnder(doc: string, headings: Heading[], h: Heading, block: string): string {
  const next = headings[h.idx + 1]
  let cut = next ? next.offset : doc.length
  while (cut > h.offset + h.length && /\s/.test(doc[cut - 1])) cut--
  const before = doc.slice(0, cut)
  const rest = doc.slice(cut)
  const lastLine = before.slice(before.lastIndexOf("\n") + 1)
  // Keep bullet lists tight; otherwise separate with a blank line.
  const sep = (LISTY.test(lastLine) || /^\s{2,}\S/.test(lastLine)) && LISTY.test(block) ? "\n" : "\n\n"
  return before + sep + block + (rest.length ? "" : "\n") + rest
}

function insertNewSection(doc: string, headings: Heading[], ns: { level: number; title: string }, block: string): string {
  const md = `${"#".repeat(ns.level)} ${ns.title}\n\n${block}\n`
  const open = headings.find((h) => norm(h.text) === "open questions" && h.level <= 2)
  if (open) return doc.slice(0, open.offset).replace(/\s+$/, "") + "\n\n" + md + "\n" + doc.slice(open.offset)
  return doc.replace(/\s+$/, "") + "\n\n" + md
}

export function applyItems(
  content: string,
  items: MergeItem[],
  pinMeta: Map<number, PinMeta>
): { content: string; applied: string[]; failed: { id: string; reason: string }[] } {
  let doc = content
  const applied: string[] = []
  const failed: { id: string; reason: string }[] = []

  // 1. In-place refinements.
  for (const it of items.filter((i) => i.action === "REFINE" && i.status === "ok")) {
    const loc = it.old ? locate(doc, it.old) : null
    if (!loc) {
      failed.push({ id: it.id, reason: "the original text is no longer in the note" })
      continue
    }
    doc = doc.slice(0, loc.start) + it.text.trim() + doc.slice(loc.end)
    applied.push(it.id)
  }

  // 2. Insertions (NEW, plus REFINE items whose original text couldn't be found).
  for (const it of items.filter((i) => i.action === "NEW" || (i.action === "REFINE" && i.status !== "ok"))) {
    const headings = parseHeadings(doc)
    let h = it.targetIdx != null ? headings[it.targetIdx] : undefined
    if (h && it.section && norm(h.text) !== norm(it.section)) h = findHeading(headings, it.section) // note changed meanwhile
    const block = blockFor(it, pinMeta)
    doc = h
      ? insertUnder(doc, headings, h, block)
      : insertNewSection(doc, headings, it.newSection ?? { level: 2, title: it.section || "New topic" }, block)
    applied.push(it.id)
  }

  return { content: doc, applied, failed }
}