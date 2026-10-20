// Background only binds the side panel to the toolbar icon.
// All AI work now happens via Claude/Gemini tabs, driven from the side panel.
chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(console.error)
})