/** Opens the Notes page in a tab, or focuses it if it's already open. */
export async function openNotesTab() {
  const url = chrome.runtime.getURL("tabs/notes.html")
  const [existing] = await chrome.tabs.query({ url })
  if (existing?.id) {
    await chrome.tabs.update(existing.id, { active: true })
    if (existing.windowId) await chrome.windows.update(existing.windowId, { focused: true })
  } else {
    await chrome.tabs.create({ url })
  }
}