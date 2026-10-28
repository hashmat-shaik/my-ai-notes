# My AI Notes

A Chrome extension that turns any web page or YouTube video into a study session with **Claude** or **Gemini**, then lets you pin the best answers and merge them into clean, organized Markdown notes.

> No API keys. The extension drives your own logged-in Claude / Gemini tabs, so it uses the subscription you already have.

## Features

### Research side panel
- Opens from the toolbar icon, next to whatever page you're reading.
- Ask Claude or Gemini questions about the current page; switch provider with one click.
- **Selection first or whole page**: send only the text you highlighted, or the page's full main content.
- **YouTube support**: grabs the video's transcript (opens it automatically if needed) and warns you instead of letting the AI guess when none is available.
- Sessions stick to a site (or a single video on YouTube), so navigating around keeps the same chat. Full session history, and chats can be resumed.
- Stop a long answer at any time (`Esc`), copy answers, and see what context was sent to the AI.

### Pin and build notes
- Bookmark any Q&A to **pin it for your notes**; a badge shows how many pins are waiting.
- A full **Notes page** (own browser tab) with one note per subject, a Markdown editor, and version history.
- Answers are converted from rendered HTML to clean Markdown, including tables, code blocks and **KaTeX math** (`$...$` / `$$...$$`).

### AI merge
- Select pinned answers and let the AI merge them into the right section of an existing note.
- You **review every proposed change** before anything is written, and the result is validated against the real note.
- One-click **undo** after a merge; a snapshot is taken first.

### Your data stays yours
- Notes live in the browser's IndexedDB (with `unlimitedStorage`); sessions live in `chrome.storage.local`.
- Export a single note as `.md`, or back up everything as JSON. Import `.md`, `.txt` or a backup file.
- "Keep awake" tweaks only apply to helper tabs the extension opens itself; your normal Claude and Gemini tabs are never touched.

## Tech stack

- [Plasmo](https://docs.plasmo.com/) (Manifest V3), React 18, TypeScript
- `marked` + `DOMPurify` for safe rendering, `turndown` (+ GFM plugin) for HTML to Markdown, `katex` for math

## Getting started

Requires Node.js 20+.

```bash
git clone https://github.com/<your-username>/my-ai-notes.git
cd my-ai-notes
npm install
npm run dev
```

Then load the extension in Chrome:

1. Go to `chrome://extensions` and enable **Developer mode**.
2. Click **Load unpacked** and select `build/chrome-mv3-dev`.
3. Make sure you're logged in to [claude.ai](https://claude.ai) and/or [gemini.google.com](https://gemini.google.com).
4. Click the extension icon on any page to open the side panel.

### Production build

```bash
npm run build      # outputs build/chrome-mv3-prod
npm run package    # creates a .zip for the Chrome Web Store
```

## Project structure

```
├── background.ts          # Binds the side panel to the toolbar icon
├── sidepanel.tsx          # Research chat UI and page/transcript extraction
├── tabs/notes.tsx         # Notes page: editor, import/export, AI merge
├── contents/keep-awake.ts # Keeps helper tabs rendering in the background
├── components/            # Icon, MergeReview
├── lib/
│   ├── remote-chat.ts     # Drives Claude/Gemini tabs (provider selectors)
│   ├── merge.ts           # Merge prompt building, parsing, validation
│   ├── markdown.ts        # HTML <-> Markdown, math, sanitizing
│   ├── notes-db.ts        # IndexedDB storage for notes and snapshots
│   ├── sessions.ts        # Chat session storage
│   └── keep-awake.ts      # Visibility patch for helper tabs
└── styles/                # Panel and notes CSS
```

## Troubleshooting

This extension automates the Claude and Gemini web UIs, so it depends on their page markup. If a step times out after a site update, the error names the failing element. Open DevTools on the provider tab, inspect it, and update the selector list in [`lib/remote-chat.ts`](lib/remote-chat.ts).

## Permissions

| Permission | Why |
| --- | --- |
| `sidePanel` | Show the research panel |
| `activeTab`, `tabs`, `scripting` | Read the current page and manage helper tabs |
| `storage`, `unlimitedStorage` | Save sessions and notes locally |
| `https://*/*` host access | Read page content on any site you study |

## Disclaimer

This project is not affiliated with or endorsed by Anthropic or Google. It automates the web interfaces of services you're already signed in to; make sure your use complies with their terms.

## Author

**Hashmat Shaik**
