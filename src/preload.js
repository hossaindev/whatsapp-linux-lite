'use strict';
const { ipcRenderer } = require('electron');

let activeId = null;
let sequence = 0;
let timer;

function controls() {
  const buttons = [...document.querySelectorAll('button,[role="button"]')].filter(
    el => el.getClientRects().length && !el.disabled && el.getAttribute('aria-disabled') !== 'true'
  );
  const label = el => (el.getAttribute('aria-label') || el.getAttribute('title') || el.textContent || '').trim();
  return {
    accept: buttons.find(el => /^(accept|answer)( (voice |video )?call)?$/i.test(label(el))),
    decline: buttons.find(el => /^(decline|reject)( call)?$/i.test(label(el)))
  };
}

function update() {
  const found = controls();
  const active = Boolean(found.accept && found.decline);
  if (active && !activeId) {
    activeId = `${Date.now()}-${++sequence}`;
    ipcRenderer.send('call-state', { active: true, id: activeId });
  } else if (!active && activeId) {
    activeId = null;
    ipcRenderer.send('call-state', { active: false });
  }
  const match = document.title.match(/^\((\d+)\)/);
  ipcRenderer.send('unread-count', match ? Number(match[1]) : 0);
  ipcRenderer.send('wa-title', document.title || 'WhatsApp');
}

ipcRenderer.on('call-action', (_, data) => {
  if (!data || data.id !== activeId || !['accept','decline'].includes(data.action)) {
    ipcRenderer.send('call-result', { ok: false }); return;
  }
  const found = controls();
  if (!found.accept || !found.decline) { ipcRenderer.send('call-result', { ok: false }); return; }
  found[data.action].click();
  setTimeout(() => {
    const next = controls();
    ipcRenderer.send('call-result', { ok: !(next.accept && next.decline) });
    update();
  }, 1500);
});

// Pseudo-sleep background RAM optimization
ipcRenderer.on('enter-pseudo-sleep', () => {
  try {
    document.querySelectorAll('video, audio').forEach(media => {
      if (!media.closest?.('[data-testid="call-modal"], [data-testid="incoming-call"]')) {
        media.pause?.();
      }
    });
    if (typeof window.gc === 'function') window.gc();
  } catch (_) {}
});

ipcRenderer.on('wake-pseudo-sleep', () => {
  update();
});

window.addEventListener('DOMContentLoaded', () => {
  const observer = new MutationObserver(() => {
    if (timer) return;
    timer = setTimeout(() => { timer = null; update(); }, 300);
  });
  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['aria-label','title','disabled']
  });
  update();
  window.addEventListener('pagehide', () => { observer.disconnect(); clearTimeout(timer); }, { once: true });
});
