// Read by app.js before anything else. The web build has no such file and
// falls back to relative URLs; the side panel lives at chrome-extension://...
// and has to name the server outright.
window.SPEAKEASY = {
  api: 'https://aditya-h.com/speakeasy/api/',
  // Invite links point at the web app, so people without the extension can
  // join the same room from any browser.
  invite: 'https://aditya-h.com/speakeasy/',
  // A side panel cannot show Chrome's microphone prompt. A normal extension
  // tab can, and the grant then covers every page of the extension.
  requestMic: async () => {
    try {
      await chrome.tabs.create({ url: chrome.runtime.getURL('permission.html') });
    } catch (err) {
      console.error('SpeakEasy: could not open the permission tab', err);
    }
  },
};
