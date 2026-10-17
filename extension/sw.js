// The toolbar button opens the side panel. That is the service worker's whole
// job: the room, the mic and the counting all live in the panel itself, which
// stays open beside the meeting tab as you switch tabs in the window.
//
// Set on every start, not only on install, because the behaviour is not
// guaranteed to survive a browser update.
const openOnClick = async () => {
  try {
    await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
  } catch (err) {
    console.error('SpeakEasy: could not set side panel behaviour', err);
  }
};
chrome.runtime.onInstalled.addListener(openOnClick);
chrome.runtime.onStartup.addListener(openOnClick);
