// Opened by the side panel when it is refused the microphone. Asking here,
// in an ordinary tab, shows Chrome's prompt; once granted, it holds for the
// extension's origin, so the side panel's next attempt succeeds. The stream is
// stopped at once: this page only exists to collect the yes.

const $ = (id) => document.getElementById(id);

async function ask() {
  $('retry').hidden = true;
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    stream.getTracks().forEach((t) => t.stop());
    $('title').textContent = 'Microphone allowed';
    $('msg').textContent = 'Go back to the SpeakEasy panel and press "Turn on microphone". This tab will close.';
    setTimeout(() => window.close(), 2500);
  } catch (err) {
    $('title').textContent = 'Microphone blocked';
    $('msg').textContent =
      'Chrome did not allow it. Click the icon at the right of the address bar to allow the microphone, then ask again.';
    $('retry').hidden = false;
  }
}

$('retry').addEventListener('click', ask);
ask();
