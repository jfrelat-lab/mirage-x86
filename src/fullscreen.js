// fullscreen.js — the screen alone, as large as the display allows, for both pages.
//
// The button or Alt+Enter (DOSBox's key) toggles it. A DOS program needs Escape — Unreal skips parts
// with it, games open their menus — and a browser in fullscreen takes Escape to leave. Where the
// Keyboard Lock API exists (Chromium) Escape is locked to the page, so it reaches the program, and
// the browser's own way out is a long press of Escape; elsewhere Escape leaves fullscreen as usual.
// Alt+Enter never reaches the guest: it is ours.

export function installFullscreen(target, button) {
  const doc = document;
  const active = () => doc.fullscreenElement === target || doc.webkitFullscreenElement === target;
  const enter = () => {
    const req = target.requestFullscreen || target.webkitRequestFullscreen;
    if (!req) return;
    Promise.resolve(req.call(target, { navigationUI: 'hide' }))
      .then(() => { if (navigator.keyboard && navigator.keyboard.lock) return navigator.keyboard.lock(['Escape']); })
      .catch(() => {});
  };
  const leave = () => {
    const exit = doc.exitFullscreen || doc.webkitExitFullscreen;
    if (exit) Promise.resolve(exit.call(doc)).catch(() => {});
  };
  const toggle = () => (active() ? leave() : enter());
  const sync = () => {
    const on = active();
    doc.body.classList.toggle('fullscreen', on);
    if (button) { button.classList.toggle('active', on); button.setAttribute('aria-pressed', String(on)); }
    if (!on && navigator.keyboard && navigator.keyboard.unlock) navigator.keyboard.unlock();
  };
  doc.addEventListener('fullscreenchange', sync);
  doc.addEventListener('webkitfullscreenchange', sync);
  if (button) button.addEventListener('click', () => { button.blur(); toggle(); });
  // Capture phase, before the guest keyboard sees it.
  window.addEventListener('keydown', (e) => {
    if (e.altKey && (e.key === 'Enter' || e.code === 'Enter' || e.code === 'NumpadEnter')) {
      e.preventDefault(); e.stopImmediatePropagation();
      if (!e.repeat) toggle();
    }
  }, { capture: true });
  window.addEventListener('keyup', (e) => {
    if (e.altKey && (e.code === 'Enter' || e.code === 'NumpadEnter')) { e.preventDefault(); e.stopImmediatePropagation(); }
  }, { capture: true });
  return { toggle, get active() { return active(); } };
}
