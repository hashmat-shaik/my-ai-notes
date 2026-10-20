/**
 * Notes live in IndexedDB (origin = this extension, plus the "unlimitedStorage" permission,
 * so the browser won't evict them). Two stores:
 *   notes     — one record per note (markdown text)
 *   snapshots — copies of a note taken before risky changes (used by the merge/undo step)
 */

export type Note = {
  id: string
  title: string
  content: string // markdown
  createdAt: number
  updatedAt: number
}

export type Snapshot = {
  id: string
  noteId: string
  content: string
  createdAt: number
  reason: string
}

const DB_NAME = "ai-notes"
const DB_VERSION = 1

let dbPromise: Promise<IDBDatabase> | null = null

function openDb(): Promise<IDBDatabase> {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION)
      req.onupgradeneeded = () => {
        const db = req.result
        if (!db.objectStoreNames.contains("notes")) db.createObjectStore("notes", { keyPath: "id" })
        if (!db.objectStoreNames.contains("snapshots")) {
          db.createObjectStore("snapshots", { keyPath: "id" }).createIndex("noteId", "noteId")
        }
      }
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => reject(req.error)
    })
  }
  return dbPromise
}

async function run<T>(
  store: string,
  mode: IDBTransactionMode,
  fn: (s: IDBObjectStore) => IDBRequest<T> | void
): Promise<T> {
  const db = await openDb()
  return new Promise<T>((resolve, reject) => {
    const tx = db.transaction(store, mode)
    const req = fn(tx.objectStore(store))
    tx.oncomplete = () => resolve((req ? req.result : undefined) as T)
    tx.onerror = () => reject(tx.error)
    tx.onabort = () => reject(tx.error)
  })
}

const newId = () => crypto.randomUUID()

/** Starting structure: topics become `##` headings, and the merge step files new material under them. */
export const noteTemplate = (title: string) =>
  `# ${title}\n\n## Overview\n\n<!-- Add topics as ## headings. Concepts look like "- **Term**: definition" followed by a "Source:" line. -->\n\n## Open questions\n\n- \n`

export async function listNotes(): Promise<Note[]> {
  const all = await run<Note[]>("notes", "readonly", (s) => s.getAll())
  return all.sort((a, b) => b.updatedAt - a.updatedAt)
}

export async function getNote(id: string): Promise<Note | undefined> {
  return run<Note | undefined>("notes", "readonly", (s) => s.get(id))
}

/** Saves a note, stamping updatedAt. Returns the stored copy. */
export async function saveNote(note: Note): Promise<Note> {
  const stored = { ...note, updatedAt: Date.now() }
  await run("notes", "readwrite", (s) => s.put(stored))
  return stored
}

export async function createNote(title: string, content = noteTemplate(title)): Promise<Note> {
  const now = Date.now()
  const note: Note = { id: newId(), title, content, createdAt: now, updatedAt: now }
  await run("notes", "readwrite", (s) => s.put(note))
  return note
}

export async function deleteNote(id: string): Promise<void> {
  await run("notes", "readwrite", (s) => s.delete(id))
  const snaps = await listSnapshots(id)
  if (snaps.length) await run("snapshots", "readwrite", (s) => void snaps.forEach((x) => s.delete(x.id)))
}

export async function addSnapshot(noteId: string, content: string, reason: string): Promise<Snapshot> {
  const snap: Snapshot = { id: newId(), noteId, content, createdAt: Date.now(), reason }
  await run("snapshots", "readwrite", (s) => s.put(snap))
  return snap
}

export async function listSnapshots(noteId: string): Promise<Snapshot[]> {
  const all = await run<Snapshot[]>("snapshots", "readonly", (s) => s.index("noteId").getAll(noteId))
  return all.sort((a, b) => b.createdAt - a.createdAt)
}