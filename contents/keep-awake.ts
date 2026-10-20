import type { PlasmoCSConfig } from "plasmo"

import { isHelperPage, keepAwakePatch } from "../lib/keep-awake"

// Runs in the page's own JS world, before any of the site's scripts, so the site never
// sees (or caches) the real "this tab is hidden" signals.
export const config: PlasmoCSConfig = {
  matches: ["https://claude.ai/*", "https://gemini.google.com/*"],
  world: "MAIN",
  run_at: "document_start"
}

// Only tabs opened by this extension are patched; your normal Claude/Gemini tabs are untouched.
if (isHelperPage()) keepAwakePatch()
