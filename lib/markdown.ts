import DOMPurify from "dompurify"
import katex from "katex"
import "katex/dist/katex.min.css"
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
td.remove(["img", "picture", "source", "video", "audio", "iframe", "canvas", "button", "svg", "style", "script", "textarea"] as any)

/**
 * Math. Claude renders formulas with KaTeX, whose DOM holds the formula three times (a hidden MathML copy,
 * the TeX source in an <annotation>, and the visual HTML), so a plain conversion repeats it:
 * "O(|E|)O(\\vert{}E\\vert{})O(|E|)". Gemini keeps the TeX in a data-math attribute. Either way we emit
 * the TeX once, as $...$ (inline) or $$...$$ (display).
 */
const isEl = (n: any): n is HTMLElement => n && n.nodeType === 1
const hasClass = (n: any, c: string) => isEl(n) && !!n.classList?.contains(c)

function texOf(node: HTMLElement): string {
  const attr = node.getAttribute("data-math")
  if (attr) return attr
  const ann = node.querySelector('annotation[encoding="application/x-tex"]')
  if (ann?.textContent) return ann.textContent
  return (node.querySelector(".katex-html")?.textContent ?? node.textContent ?? "").trim()
}

const mathBlock = (tex: string) => `\n\n$$\n${tex.trim()}\n$$\n\n`
const mathInline = (tex: string) => `$${tex.replace(/\s+/g, " ").trim()}$`

td.addRule("katex", {
  filter: (node) => hasClass(node, "katex") || hasClass(node, "katex-display"),
  replacement: (_c, node) => {
    const el = node as HTMLElement
    const display = hasClass(el, "katex-display") || hasClass(el.parentElement, "katex-display")
    const tex = texOf(hasClass(el, "katex-display") ? ((el.querySelector(".katex") as HTMLElement) ?? el) : el)
    return display ? mathBlock(tex) : mathInline(tex)
  }
})
td.addRule("data-math", {
  filter: (node) => isEl(node) && node.hasAttribute("data-math"),
  replacement: (_c, node) => {
    const el = node as HTMLElement
    const display = el.tagName === "DIV" || hasClass(el, "math-block")
    return display ? mathBlock(texOf(el)) : mathInline(texOf(el))
  }
})

const MAX_MESSAGE_CHARS = 50000

export function htmlToMarkdown(html: string): string {
  try {
    return td
      .turndown(html)
      .replace(/\]\(data:[^)]*\)/g, "]()") // stray base64 links
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

const escapeAttr = (s: string) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;")

// Keep $...$ / $$...$$ TeX verbatim so markdown doesn't mangle underscores, asterisks or backslashes in it.
// The TeX is carried in data-tex and typeset by KaTeX after sanitizing (see renderMath); the visible
// fallback text is the raw TeX, which is what you see if KaTeX can't parse it.
marked.use({
  extensions: [
    {
      name: "mathBlock",
      level: "block",
      start: (src: string) => src.indexOf("$$"),
      tokenizer(src: string) {
        const m = /^\$\$[ \t]*\n?([\s\S]+?)\n?[ \t]*\$\$[ \t]*(?:\n|$)/.exec(src)
        return m ? { type: "mathBlock", raw: m[0], text: m[1].trim() } : undefined
      },
      renderer: (t: any) =>
        `<div class="math-tex" data-display="1" data-tex="${escapeAttr(t.text)}">$$${escapeHtml(t.text)}$$</div>\n`
    },
    {
      name: "mathInline",
      level: "inline",
      start: (src: string) => src.indexOf("$"),
      tokenizer(src: string) {
        // "$5 and $10" is not math: no space just inside the delimiters, and no digit right after the closing "$".
        const m = /^\$(?![\s$])((?:\\.|[^$\\\n])+?)(?<![\s\\])\$(?!\d)/.exec(src)
        return m ? { type: "mathInline", raw: m[0], text: m[1] } : undefined
      },
      renderer: (t: any) => `<span class="math-tex" data-tex="${escapeAttr(t.text)}">$${escapeHtml(t.text)}$</span>`
    }
  ]
} as any)

// Every link opens in a new tab. A side panel can't browse, so a normal click would blank it.
DOMPurify.addHook("afterSanitizeAttributes", (node: Element) => {
  if (node.tagName === "A") {
    node.setAttribute("target", "_blank")
    node.setAttribute("rel", "noopener noreferrer")
  }
})

const escapeHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")

/**
 * Typeset the math placeholders. This runs on already-sanitized HTML, and KaTeX's own output
 * (trust: false, so no \href / \url / \includegraphics) is not passed through the sanitizer,
 * which would strip the SVG KaTeX uses for roots and arrows.
 */
function renderMath(html: string): string {
  if (!html.includes("math-tex")) return html
  const tpl = document.createElement("template")
  tpl.innerHTML = html
  tpl.content.querySelectorAll<HTMLElement>(".math-tex[data-tex]").forEach((el) => {
    try {
      el.innerHTML = katex.renderToString(el.getAttribute("data-tex") || "", {
        displayMode: el.getAttribute("data-display") === "1",
        throwOnError: false,
        output: "html", // no MathML twin, so copying text out of the preview doesn't repeat the formula
        trust: false,
        strict: "ignore"
      })
    } catch {
      /* keep the raw TeX shown by default */
    }
  })
  return tpl.innerHTML
}

export function markdownToSafeHtml(md: string): string {
  try {
    const html = marked.parse(md, { async: false }) as string
    const clean = DOMPurify.sanitize(html, {
      FORBID_TAGS: ["img", "style", "iframe", "form", "input", "svg"],
      ALLOWED_URI_REGEXP: /^(?:https?|mailto):/i
    })
    return renderMath(clean)
  } catch (e) {
    console.error("markdown render failed, showing plain text", e)
    return `<pre>${escapeHtml(md)}</pre>`
  }
}