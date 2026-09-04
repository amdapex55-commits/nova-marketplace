/* Small rendering helpers. No framework: the app is a handful of screens that
   each build a DOM subtree and hand it back, which keeps the shipped JavaScript
   under ~30 KB and the first swipe instant on a mid-range phone. */

export const el = (html) => {
  const t = document.createElement('template');
  t.innerHTML = html.trim();
  return t.content.firstElementChild;
};

/* Everything rendered from data goes through this. Seller-written titles and
   descriptions are untrusted text. */
export const esc = (s) => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

export const ICON = {
  back:   '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 19 8 12l7-7"/></svg>',
  heart:  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20.8 5.6a5 5 0 0 0-7.1 0L12 7.3l-1.7-1.7a5 5 0 1 0-7.1 7.1L12 21l8.8-8.3a5 5 0 0 0 0-7.1Z"/></svg>',
  heartOn:'<svg viewBox="0 0 24 24" fill="currentColor"><path d="M20.8 5.6a5 5 0 0 0-7.1 0L12 7.3l-1.7-1.7a5 5 0 1 0-7.1 7.1L12 21l8.8-8.3a5 5 0 0 0 0-7.1Z"/></svg>',
  x:      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.3" stroke-linecap="round"><path d="M6 6l12 12M18 6 6 18"/></svg>',
  undo:   '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 8h11a6 6 0 0 1 0 12h-4"/><path d="m7 4-4 4 4 4"/></svg>',
  cards:  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linejoin="round"><rect x="7" y="4" width="12" height="16" rx="2.5"/><path d="M4 7v11a2.5 2.5 0 0 0 2.5 2.5"/></svg>',
  grid:   '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9"><rect x="3.5" y="3.5" width="7" height="7" rx="1.6"/><rect x="13.5" y="3.5" width="7" height="7" rx="1.6"/><rect x="3.5" y="13.5" width="7" height="7" rx="1.6"/><rect x="13.5" y="13.5" width="7" height="7" rx="1.6"/></svg>',
  search: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.6-3.6"/></svg>',
  bag:    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linejoin="round"><path d="M4 8h16l-1.2 12H5.2Z"/><path d="M8.5 8V6a3.5 3.5 0 0 1 7 0v2"/></svg>',
  tick:   '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="m4 12.5 5.2 5.2L20 7"/></svg>',
  tag:    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linejoin="round"><path d="M3 12.5V4.5A1.5 1.5 0 0 1 4.5 3h8l8.5 8.5-9 9L3 12.5Z"/><circle cx="7.8" cy="7.8" r="1.4" fill="currentColor" stroke="none"/></svg>',
  chat:   '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linejoin="round"><path d="M20.5 12c0 4.1-3.8 7.4-8.5 7.4a10 10 0 0 1-2.6-.34L4 21l1.3-3.7A7 7 0 0 1 3.5 12C3.5 7.9 7.3 4.6 12 4.6s8.5 3.3 8.5 7.4Z"/></svg>',
  user:   '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"><circle cx="12" cy="8.2" r="3.6"/><path d="M4.6 20a7.4 7.4 0 0 1 14.8 0"/></svg>',
  truck:  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linejoin="round"><path d="M1.5 6.5h12v10h-12z"/><path d="M13.5 10h4l3 3v3.5h-7z"/><circle cx="6" cy="18.5" r="1.8"/><circle cx="17" cy="18.5" r="1.8"/></svg>'
};

let toastTimer;
export function toast(message) {
  const t = document.getElementById('toast');
  t.textContent = message;
  t.classList.add('on');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('on'), 1900);
}

export const money = n => 'Rs ' + Math.round(n).toLocaleString('en-PK');
