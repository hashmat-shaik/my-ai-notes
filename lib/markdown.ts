import DOMPurify from "dompurify"
import { marked } from "marked"
import TurndownService from "turndown"
import { gfm } from "turndown-plugin-gfm"

/* ---------- HTML (from Claude/Gemini) -> Markdown ---------- */

const td = new TurndownService({
  headingStyle: "atx",
  codeBlockStyle: "fenced",
  bulletListMarker: "-"
})
td.use(gfm)
// Media and UI chrome never belong in notes (and thumbnails can be megabytes of base64).
td.remove(["img", "picture", "source", "video", "audio", "iframe", "canvas", "button", "svg", "style", "script", "textarea"])

const MAX_MESSAGE_CHARS = 50000

export function htmlToMarkdown(html: string): string {
  try {
    return td
      .turndown(html)
      .replace(/\(data:[^)]*\)/g, "()") // stray base64 links
      .replace(/\n{3,}/g, "\n\n")
      .trim()
      .slice(0, MAX_MESSAGE_CHARS)
  } catch (e) {
    console.error("turndown failed, falling back to plain text", e)
    const div = document.createElement("div")
    div.innerHTML = html
    return (div.innerText || div.textContent || "").trim().slice(0, MAX_MESSAGE_CHARS)
  }
}

/* ---------- Markdown -> safe HTML (for display) ---------- */

marked.setOptions({ gfm: true, breaks: false })

// Every link opens in a new tab. A side panel can't browse, so a normal click would blank it.
DOMPurify.addHook("afterSanitizeAttributes", (node: Element) => {
  if (node.tagName === "A") {
    node.setAttribute("target", "_blank")
    node.setAttribute("rel", "noopener noreferrer")
  }
})

const escapeHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")

export function markdownToSafeHtml(md: string): string {
  try {
    const html = marked.parse(md, { async: false }) as string
    return DOMPurify.sanitize(html, {
      FORBID_TAGS: ["img", "style", "iframe", "form", "input", "svg"],
      ALLOWED_URI_REGEXP: /^(?:https?|mailto):/i
    })
  } catch (e) {
    console.error("markdown render failed, showing plain text", e)
    return `<pre>${escapeHtml(md)}</pre>`
  }
}