// HugoSMP Live – Frontend
// Motion folgt Apples "Designing Fluid Interfaces": Federn statt fester Dauern,
// Start immer vom aktuellen Bildschirmwert, Geschwindigkeit wird übergeben.

const $ = (sel, root = document) => root.querySelector(sel);
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)');
const fmtInt = new Intl.NumberFormat('de-DE');
const TAG_COLORS = ['var(--orange)', 'var(--green)', 'var(--blue)', 'var(--tiktok)', 'var(--twitch)'];
const REASONS = { emote: 'Emote-Only', vod: 'VOD' };
const VIA_TEXT = { bild: 'im Bild erkannt', text: 'laut Bio' };
const VIA_HINT = {
  bild: 'HugoSMP-Scoreboard (HUGOSMP.NET) wurde im Stream-Bild erkannt',
  text: 'HugoSMP steht im Namen oder in der Bio',
};
const PLATFORMS = ['twitch', 'tiktok'];
const PLATFORM_NAME = { twitch: 'Twitch', tiktok: 'TikTok' };

// ---------------------------------------------------------------------------
// Motion primitives
// ---------------------------------------------------------------------------

const clamp = (v, min, max) => Math.min(max, Math.max(min, v));
// Apples Projektion aus der WWDC-Beispielcode – wohin ein Wisch "fliegen" würde.
const project = (velocity, rate = 0.998) => ((velocity / 1000) * rate) / (1 - rate);
// Weicher Widerstand jenseits einer Grenze statt hartem Stopp.
const rubberband = (overshoot, dimension, c = 0.55) => (overshoot * dimension * c) / (dimension + c * Math.abs(overshoot));

/** Feder mit Apples Parametern: damping (1 = kein Überschwingen) und response (Sekunden). */
class Spring {
  constructor(value = 0, { damping = 1, response = 0.35, precision = 0.1 } = {}) {
    this.value = value;
    this.target = value;
    this.velocity = 0;
    this.damping = damping;
    this.response = response;
    this.precision = precision;
    this.listeners = [];
    this.frame = 0;
    this.onRest = null;
  }
  onChange(fn) {
    this.listeners.push(fn);
    fn(this.value);
    return this;
  }
  emit() {
    for (const fn of this.listeners) fn(this.value);
  }
  stop() {
    cancelAnimationFrame(this.frame);
    this.frame = 0;
  }
  /** Sofort setzen (z. B. während eines Drags – 1:1 mit dem Finger). */
  set(value) {
    this.stop();
    this.value = this.target = value;
    this.velocity = 0;
    this.emit();
  }
  /** Neues Ziel – die aktuelle Geschwindigkeit bleibt erhalten (keine "Wand" bei Richtungswechsel). */
  to(target, { velocity, damping, response, onRest, allowReduced = false } = {}) {
    this.target = target;
    if (velocity !== undefined) this.velocity = velocity;
    if (damping !== undefined) this.damping = damping;
    if (response !== undefined) this.response = response;
    this.onRest = onRest || null;
    if (reduceMotion.matches && !allowReduced) {
      this.set(target);
      this.rest();
      return this;
    }
    if (!this.frame) {
      this.last = performance.now();
      this.frame = requestAnimationFrame((t) => this.tick(t));
    }
    return this;
  }
  rest() {
    const cb = this.onRest;
    this.onRest = null;
    cb?.();
  }
  tick(now) {
    const dt = Math.min((now - this.last) / 1000, 1 / 30);
    this.last = now;
    const stiffness = (2 * Math.PI / this.response) ** 2;
    const friction = (4 * Math.PI * this.damping) / this.response;
    const steps = Math.max(1, Math.ceil(dt * 240));
    const h = dt / steps;
    for (let i = 0; i < steps; i++) {
      const accel = -stiffness * (this.value - this.target) - friction * this.velocity;
      this.velocity += accel * h;
      this.value += this.velocity * h;
    }
    if (Math.abs(this.value - this.target) < this.precision && Math.abs(this.velocity) < this.precision * 10) {
      this.value = this.target;
      this.velocity = 0;
      this.frame = 0;
      this.emit();
      this.rest();
      return;
    }
    this.emit();
    this.frame = requestAnimationFrame((t) => this.tick(t));
  }
}

/** Geschwindigkeit aus den letzten ~100 ms Zeigerbewegung (px/s). */
class VelocityTracker {
  constructor() {
    this.samples = [];
  }
  add(value, time = performance.now()) {
    this.samples.push({ value, time });
    while (this.samples.length > 2 && this.samples[0].time < time - 100) this.samples.shift();
  }
  get velocity() {
    if (this.samples.length < 2) return 0;
    const a = this.samples[0];
    const b = this.samples[this.samples.length - 1];
    const dt = (b.time - a.time) / 1000;
    // Begrenzen: sehr kurze Zeitabstände würden sonst absurde Werte liefern.
    return dt > 0 ? clamp((b.value - a.value) / dt, -6000, 6000) : 0;
  }
}

// ---------------------------------------------------------------------------
// DOM helpers
// ---------------------------------------------------------------------------

function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'text') el.textContent = v;
    else if (k === 'style') el.style.cssText = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) if (c != null && c !== false) el.append(c);
  return el;
}

const ICONS = {
  person: '<svg viewBox="0 0 16 16"><circle cx="8" cy="5" r="3"/><path d="M2.5 14c.4-3 2.6-4.6 5.5-4.6s5.1 1.6 5.5 4.6z"/></svg>',
  key: '<svg viewBox="0 0 24 24"><circle cx="8" cy="15" r="4"/><path d="m11 12 8-8M16 7l3 3M14 9l2 2"/></svg>',
  warn: '<svg viewBox="0 0 24 24"><path d="M12 4 2.5 20h19z"/><path d="M12 10v4M12 17.2v.1"/></svg>',
  info: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7.6v.1"/></svg>',
  wave: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="2.2"/><path d="M7.8 7.8a6 6 0 0 0 0 8.4M16.2 7.8a6 6 0 0 1 0 8.4M5 5a10 10 0 0 0 0 14M19 5a10 10 0 0 1 0 14"/></svg>',
  search: '<svg viewBox="0 0 24 24"><circle cx="10.5" cy="10.5" r="6.5"/><path d="m15.5 15.5 4.5 4.5"/></svg>',
  offline: '<svg viewBox="0 0 24 24"><path d="M3 3l18 18M8.5 16.5a5 5 0 0 1 7 0M5 13a10 10 0 0 1 5-2.7M14 10.3A10 10 0 0 1 19 13M2 9.5a15 15 0 0 1 4.5-2.7M11 5a15 15 0 0 1 11 4.5"/></svg>',
  minus: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="10" fill="currentColor"/><path d="M7.5 12h9" stroke="#fff" stroke-width="2.4" stroke-linecap="round"/></svg>',
};
function icon(name) {
  const t = document.createElement('template');
  t.innerHTML = ICONS[name];
  return t.content.firstElementChild;
}

function pref(key, fallback) {
  try {
    return localStorage.getItem('hsl.' + key) ?? fallback;
  } catch {
    return fallback;
  }
}
function savePref(key, value) {
  try {
    localStorage.setItem('hsl.' + key, value);
  } catch {}
}

function uptime(startedAt) {
  if (!startedAt) return '';
  const min = Math.max(0, Math.floor((Date.now() - startedAt) / 60000));
  const hh = Math.floor(min / 60);
  return hh ? `${hh}:${String(min % 60).padStart(2, '0')} h` : `${min} min`;
}

function ago(ts) {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 5) return 'gerade eben';
  if (s < 60) return `vor ${s} s`;
  const m = Math.round(s / 60);
  return m < 60 ? `vor ${m} min` : `vor ${Math.round(m / 60)} h`;
}

async function api(path, { method = 'GET', body } = {}) {
  const r = await fetch(path, {
    method,
    cache: 'no-store',
    headers: method === 'GET' ? {} : { 'Content-Type': 'application/json' },
    body: method === 'GET' ? undefined : JSON.stringify(body ?? {}),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || 'HTTP ' + r.status);
  return j;
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const ui = {
  platform: PLATFORMS.includes(pref('platform')) ? pref('platform') : 'twitch',
  filter: 'all',
  query: '',
  sort: pref('sort', 'viewers'),
};
let data = null;
let serverDown = false;

const tagColor = (tag) => TAG_COLORS[Math.max(0, (data?.tags || []).indexOf(tag)) % TAG_COLORS.length];

// ---------------------------------------------------------------------------
// Navigation bar – reagiert 1:1 auf Scroll, keine Schwellen-Animation
// ---------------------------------------------------------------------------

const navbar = $('#navbar');
const largeTitle = $('#largeTitle');
let scrollQueued = false;
function updateNavbar() {
  scrollQueued = false;
  const navBottom = navbar.getBoundingClientRect().bottom;
  const t = largeTitle.getBoundingClientRect();
  navbar.style.setProperty('--bar', clamp(scrollY / 14, 0, 1).toFixed(3));
  navbar.style.setProperty('--title', clamp((navBottom - t.top) / t.height, 0, 1).toFixed(3));
}
addEventListener('scroll', () => {
  if (!scrollQueued) {
    scrollQueued = true;
    requestAnimationFrame(updateNavbar);
  }
}, { passive: true });
addEventListener('resize', updateNavbar);

// ---------------------------------------------------------------------------
// Segmented control – antippen oder den Schieber ziehen/werfen
// ---------------------------------------------------------------------------

const segmented = $('#segmented');
const segThumb = $('.seg-thumb', segmented);
const segButtons = [...segmented.querySelectorAll('.seg')];
const PAD = 2;
let segWidth = 0;
let segIndex = PLATFORMS.indexOf(ui.platform);
const thumbX = new Spring(0, { damping: 1, response: 0.32, precision: 0.1 });
const thumbScale = new Spring(1, { damping: 1, response: 0.22, precision: 0.001 });
const paintThumb = () => (segThumb.style.transform = `translate3d(${thumbX.value}px,0,0) scale(${thumbScale.value})`);
thumbX.onChange(paintThumb);
thumbScale.onChange(paintThumb);

function measureSegments() {
  segWidth = segButtons[0].offsetWidth;
  segThumb.style.width = segWidth + 'px';
  thumbX.set(segIndex * segWidth);
}
new ResizeObserver(measureSegments).observe(segmented);

function selectSegment(index, { velocity, fromDrag = false } = {}) {
  const changed = index !== segIndex;
  segIndex = index;
  // Nur wenn der Schieber geworfen wurde, darf er leicht nachschwingen.
  thumbX.to(index * segWidth, { velocity, damping: fromDrag ? 0.8 : 1, response: 0.32 });
  segButtons.forEach((b, i) => {
    b.setAttribute('aria-selected', String(i === index));
    b.tabIndex = i === index ? 0 : -1;
  });
  if (changed) {
    if (fromDrag) navigator.vibrate?.(8);
    setPlatform(PLATFORMS[index]);
  }
}

let segDrag = null;
const segIndexAt = (clientX) => clamp(Math.floor((clientX - segmented.getBoundingClientRect().left - PAD) / segWidth), 0, segButtons.length - 1);

segmented.addEventListener('pointerdown', (e) => {
  if (e.button !== 0) return;
  const local = e.clientX - segmented.getBoundingClientRect().left - PAD;
  const onThumb = local >= thumbX.value && local <= thumbX.value + segWidth;
  segDrag = { id: e.pointerId, startX: e.clientX, from: thumbX.value, onThumb, moved: false, tracker: new VelocityTracker(), pressed: null };
  segDrag.tracker.add(e.clientX, e.timeStamp);
  segmented.setPointerCapture(e.pointerId);
  // Feedback sofort beim Drücken, nicht erst beim Loslassen.
  if (onThumb) thumbScale.to(0.95);
  else {
    segDrag.pressed = segButtons[segIndexAt(e.clientX)];
    segDrag.pressed.classList.add('is-pressed');
  }
});

segmented.addEventListener('pointermove', (e) => {
  if (!segDrag || e.pointerId !== segDrag.id) return;
  segDrag.tracker.add(e.clientX, e.timeStamp);
  const dx = e.clientX - segDrag.startX;
  if (segDrag.onThumb) {
    if (!segDrag.moved && Math.abs(dx) > 3) segDrag.moved = true;
    if (!segDrag.moved) return;
    const max = (segButtons.length - 1) * segWidth;
    let x = segDrag.from + dx;
    if (x < 0) x = -rubberband(-x, segWidth);
    else if (x > max) x = max + rubberband(x - max, segWidth);
    thumbX.set(x);
  } else if (segDrag.pressed) {
    // Wegziehen bricht den Tipp ab, Zurückziehen reaktiviert ihn (10 px Toleranz).
    const r = segmented.getBoundingClientRect();
    const inside = e.clientX > r.left - 10 && e.clientX < r.right + 10 && e.clientY > r.top - 10 && e.clientY < r.bottom + 10;
    segDrag.pressed.classList.toggle('is-pressed', inside);
  }
});

function endSegDrag(e, cancelled) {
  if (!segDrag || e.pointerId !== segDrag.id) return;
  const d = segDrag;
  segDrag = null;
  thumbScale.to(1);
  d.pressed?.classList.remove('is-pressed');
  if (cancelled) return selectSegment(segIndex);
  if (d.onThumb && d.moved) {
    d.tracker.add(e.clientX, e.timeStamp);
    const v = d.tracker.velocity;
    const landing = thumbX.value + project(v, 0.99);
    const index = clamp(Math.round(landing / segWidth), 0, segButtons.length - 1);
    return selectSegment(index, { velocity: v, fromDrag: true });
  }
  if (d.pressed?.isConnected && d.pressed && !d.onThumb) {
    const r = segmented.getBoundingClientRect();
    const inside = e.clientX > r.left - 10 && e.clientX < r.right + 10 && e.clientY > r.top - 10 && e.clientY < r.bottom + 10;
    if (inside) selectSegment(segIndexAt(e.clientX));
  }
}
segmented.addEventListener('pointerup', (e) => endSegDrag(e, false));
segmented.addEventListener('pointercancel', (e) => endSegDrag(e, true));

// Tastatur: Enter/Leertaste (click mit detail 0) und Pfeiltasten.
segButtons.forEach((b, i) => b.addEventListener('click', (e) => e.detail === 0 && selectSegment(i)));
segmented.addEventListener('keydown', (e) => {
  const dir = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
  if (!dir) return;
  e.preventDefault();
  const i = clamp(segIndex + dir, 0, segButtons.length - 1);
  selectSegment(i);
  segButtons[i].focus();
});

// ---------------------------------------------------------------------------
// Plattformwechsel – Inhalt kommt von der Seite des gewählten Segments
// ---------------------------------------------------------------------------

const content = $('#content');
const contentX = new Spring(0, { damping: 1, response: 0.4, precision: 0.1 });
const contentOpacity = new Spring(1, { damping: 1, response: 0.3, precision: 0.002 });
const paintContent = () => {
  content.style.transform = contentX.value ? `translate3d(${contentX.value}px,0,0)` : '';
  content.style.opacity = contentOpacity.value >= 0.999 ? '' : contentOpacity.value.toFixed(3);
};
contentX.onChange(paintContent);
contentOpacity.onChange(paintContent);

function setPlatform(platform) {
  if (platform === ui.platform) return;
  const dir = PLATFORMS.indexOf(platform) > PLATFORMS.indexOf(ui.platform) ? 1 : -1;
  ui.platform = platform;
  savePref('platform', platform);
  document.body.dataset.platform = platform;
  content.setAttribute('aria-labelledby', 'tab-' + platform);
  render();
  contentOpacity.set(0);
  contentOpacity.to(1, { allowReduced: true });
  if (!reduceMotion.matches) {
    contentX.set(dir * 36);
    contentX.to(0);
  }
}

// ---------------------------------------------------------------------------
// Filter, Suche, Sortierung
// ---------------------------------------------------------------------------

const chipsEl = $('#chips');
const chipEls = new Map();

function renderChips() {
  const tags = data?.tags || [];
  const streams = data?.[ui.platform]?.streams || [];
  const items = [{ id: 'all', label: 'Alle', n: streams.length }, ...tags.map((t) => ({ id: t, label: `[${t}]`, n: streams.filter((s) => s.matched.includes(t)).length, color: tagColor(t) }))];
  if (!items.some((i) => i.id === ui.filter)) ui.filter = 'all';
  for (const item of items) {
    let el = chipEls.get(item.id);
    if (!el) {
      el = h('button', { class: 'chip', type: 'button', onclick: () => { ui.filter = item.id; render(); } },
        item.color ? h('span', { class: 'swatch', style: `--c:${item.color}` }) : null,
        h('span', { class: 'l', text: item.label }),
        h('span', { class: 'n' }));
      chipEls.set(item.id, el);
      chipsEl.append(el);
    }
    el.querySelector('.n').textContent = item.n;
    el.setAttribute('aria-pressed', String(ui.filter === item.id));
  }
}

const searchInput = $('#search');
searchInput.addEventListener('input', () => {
  ui.query = searchInput.value.trim().toLowerCase();
  render();
});
searchInput.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && searchInput.value) {
    searchInput.value = '';
    ui.query = '';
    render();
  }
});

const sortSelect = $('#sort');
sortSelect.value = ui.sort;
sortSelect.addEventListener('change', () => {
  ui.sort = sortSelect.value;
  savePref('sort', ui.sort);
  render();
});

function visibleStreams() {
  let list = data?.[ui.platform]?.streams || [];
  if (ui.filter !== 'all') list = list.filter((s) => s.matched.includes(ui.filter));
  if (ui.query) list = list.filter((s) => `${s.name} ${s.login} ${s.title} ${s.game || ''}`.toLowerCase().includes(ui.query));
  const sorted = [...list];
  if (ui.sort === 'recent') sorted.sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0));
  else if (ui.sort === 'name') sorted.sort((a, b) => a.name.localeCompare(b.name, 'de', { sensitivity: 'base' }));
  else sorted.sort((a, b) => b.viewers - a.viewers);
  return sorted;
}

// ---------------------------------------------------------------------------
// Karten
// ---------------------------------------------------------------------------

function swapImage(img, src) {
  if (!src) {
    img.removeAttribute('src');
    delete img.dataset.src;
    return;
  }
  if (img.dataset.src === src) return;
  img.dataset.src = src;
  if (!img.getAttribute('src')) {
    img.src = src;
    return;
  }
  // Neues Vorschaubild erst vorladen, dann tauschen – kein Flackern.
  const pre = new Image();
  pre.referrerPolicy = 'no-referrer';
  pre.onload = () => {
    if (img.dataset.src === src) img.src = src;
  };
  pre.src = src;
}

function createCard(s) {
  const thumbImg = h('img', { alt: '', decoding: 'async', loading: 'lazy', referrerpolicy: 'no-referrer' });
  thumbImg.addEventListener('load', () => thumbImg.classList.add('loaded'));
  thumbImg.addEventListener('error', () => thumbImg.classList.add('failed'));
  const refs = {
    thumb: thumbImg,
    viewers: h('span'),
    uptime: h('span', { class: 'badge badge-uptime' }),
    avatar: h('img', { class: 'avatar', alt: '', decoding: 'async', loading: 'lazy', referrerpolicy: 'no-referrer' }),
    name: h('div', { class: 'name' }),
    title: h('div', { class: 'stream-title' }),
    sub: h('div', { class: 'sub' }),
  };
  const el = h('a', { class: 'card', target: '_blank', rel: 'noopener noreferrer' },
    h('div', { class: 'thumb' },
      thumbImg,
      h('span', { class: 'badge badge-live', text: 'LIVE' }),
      h('span', { class: 'badge badge-viewers' }, icon('person'), refs.viewers),
      refs.uptime),
    h('div', { class: 'meta' }, refs.avatar, h('div', { class: 'text' }, refs.name, refs.title, refs.sub)));
  el._refs = refs;
  el._sig = '';
  updateCard(el, s);
  return el;
}

function updateCard(el, s) {
  const r = el._refs;
  el.href = s.url;
  el.setAttribute('aria-label', `${s.name} – ${s.title || 'ohne Titel'} – ${fmtInt.format(s.viewers)} Zuschauer`);
  r.viewers.textContent = fmtInt.format(s.viewers);
  r.uptime.dataset.start = s.startedAt || '';
  r.uptime.textContent = uptime(s.startedAt);
  r.uptime.hidden = !s.startedAt;
  r.name.textContent = s.name;
  r.title.textContent = s.title || 'Ohne Titel';
  r.title.title = s.title || '';
  const sig = s.matched.join('|') + '#' + (s.game || '') + '#' + (s.via || '');
  if (sig !== el._sig) {
    el._sig = sig;
    r.sub.replaceChildren(
      ...s.matched.map((t) => h('span', { class: 'tag', style: `--c:${tagColor(t)}`, text: t })),
      s.via ? h('span', { class: 'via', title: VIA_HINT[s.via], text: VIA_TEXT[s.via] || '' }) : '',
      s.game ? h('span', { class: 'game', text: s.game }) : '',
    );
  }
  swapImage(r.thumb, s.thumbnail);
  swapImage(r.avatar, s.avatar);
}

function skeletonCard() {
  return h('div', { class: 'card skeleton', 'aria-hidden': 'true' },
    h('div', { class: 'thumb' }),
    h('div', { class: 'meta' }, h('div', { class: 'avatar' }), h('div', {}, h('div', { class: 'line' }), h('div', { class: 'line' }))));
}

const grid = $('#grid');
const cards = new Map();
let gridPlatform = null;

function renderGrid(list, showSkeleton) {
  const platformChanged = gridPlatform !== ui.platform;
  if (platformChanged || showSkeleton || grid.querySelector('.skeleton')) {
    grid.replaceChildren();
    cards.clear();
    gridPlatform = ui.platform;
  }
  if (showSkeleton) {
    grid.append(...Array.from({ length: 6 }, skeletonCard));
    return;
  }
  const animate = !platformChanged;
  const flip = animate && !reduceMotion.matches;

  // FLIP: Positionen vorher merken (inklusive laufender Animationen = Bildschirmwert).
  const before = new Map();
  if (flip) for (const [k, el] of cards) before.set(k, el.getBoundingClientRect());

  const keep = new Set(list.map((s) => s.key));
  for (const [k, el] of cards) {
    if (!keep.has(k)) {
      el.remove();
      cards.delete(k);
    }
  }
  const fresh = [];
  for (const s of list) {
    let el = cards.get(s.key);
    if (el) updateCard(el, s);
    else {
      el = createCard(s);
      cards.set(s.key, el);
      fresh.push(el);
    }
  }
  list.forEach((s, i) => {
    const el = cards.get(s.key);
    if (grid.children[i] !== el) grid.insertBefore(el, grid.children[i] || null);
  });

  if (!animate) return;
  if (flip) {
    for (const el of cards.values()) el.getAnimations().forEach((a) => a.cancel());
    for (const [k, el] of cards) {
      const a = before.get(k);
      if (!a) continue;
      const b = el.getBoundingClientRect();
      const dx = a.left - b.left;
      const dy = a.top - b.top;
      if (Math.abs(dx) < 1 && Math.abs(dy) < 1) continue;
      el.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'none' }], { duration: 480, easing: 'cubic-bezier(0.2, 0.8, 0.2, 1)' });
    }
  }
  fresh.forEach((el, i) => {
    el.animate(
      reduceMotion.matches
        ? [{ opacity: 0 }, { opacity: 1 }]
        : [{ opacity: 0, transform: 'scale(0.96)' }, { opacity: 1, transform: 'none' }],
      { duration: reduceMotion.matches ? 200 : 420, delay: Math.min(i, 8) * 35, easing: 'cubic-bezier(0.2, 0.8, 0.2, 1)', fill: 'backwards' },
    );
  });
}

setInterval(() => {
  for (const el of cards.values()) {
    const u = el._refs.uptime;
    if (u.dataset.start) u.textContent = uptime(Number(u.dataset.start));
  }
}, 30_000);

// ---------------------------------------------------------------------------
// Hinweise, leere Zustände, Ausgeblendete
// ---------------------------------------------------------------------------

const noticeEl = $('#notice');
let noticeSig = '';

function notice({ glyph, color, title, body, action }) {
  return h('div', { class: 'notice', style: color ? `--c:${color}` : null },
    h('div', { class: 'glyph' }, icon(glyph)),
    h('div', {}, h('h3', { text: title }), body),
    action ? h('div', { class: 'actions' }, action) : null);
}

function renderNotice() {
  const p = data?.[ui.platform];
  let sig = 'none';
  let node = null;

  if (serverDown) {
    sig = 'down';
    const local = ['localhost', '127.0.0.1'].includes(location.hostname);
    node = notice({
      glyph: 'offline', color: 'var(--orange)', title: local ? 'Server nicht erreichbar' : 'Daten nicht erreichbar',
      body: local
        ? h('p', {}, 'Läuft ', h('code', { text: 'node server.js' }), ' noch? Die Seite versucht es automatisch weiter.')
        : h('p', { text: 'Gerade kommen keine Daten an. Die Seite versucht es automatisch weiter.' }),
    });
  } else if (ui.platform === 'twitch' && data && !data.twitch.configured) {
    sig = 'setup';
    node = notice({
      glyph: 'key', color: 'var(--twitch)', title: 'Twitch-Zugang einrichten',
      body: [
        h('p', { text: 'Für die offizielle Twitch-API braucht der Server einmalig eine kostenlose App-ID.' }),
        h('ol', {},
          h('li', {}, h('a', { href: 'https://dev.twitch.tv/console/apps/create', target: '_blank', rel: 'noopener', text: 'dev.twitch.tv/console' }), ' öffnen → Anwendung registrieren'),
          h('li', {}, 'Redirect-URL ', h('code', { text: 'http://localhost' }), ', Kategorie „Website Integration“, Client-Typ „Vertraulich“'),
          data.static
            ? h('li', {}, 'Client-ID und Secret als GitHub-Secrets ', h('code', { text: 'TWITCH_CLIENT_ID' }), ' / ', h('code', { text: 'TWITCH_CLIENT_SECRET' }), ' eintragen')
            : h('li', {}, 'Client-ID und Secret in ', h('code', { text: '.env' }), ' eintragen und den Server neu starten')),
      ],
    });
  } else if (p?.error) {
    sig = 'err:' + p.error;
    node = notice({ glyph: 'warn', color: 'var(--orange)', title: `${PLATFORM_NAME[ui.platform]}-Abfrage fehlgeschlagen`, body: h('p', { text: p.error }) });
  } else if (ui.platform === 'tiktok' && data) {
    const n = data.tiktok.checked || 0;
    const feed = data.tiktok.feedRooms || 0;
    const vision = data.tiktok.vision;
    sig = `tt:${n}:${feed}:${vision}:${data.canEdit}`;
    node = notice({
      glyph: 'info', color: 'var(--tiktok)',
      title: vision ? 'HugoSMP wird im Stream-Bild erkannt' : `${n} TikTok-Accounts werden geprüft`,
      body: h('p', {
        text: vision
          ? `Durchsucht werden ${feed} deutsche Minecraft-Lives aus TikToks Feed und ${n} gemerkte Accounts. Wer auf hugosmp.net spielt, wird am Scoreboard (HUGOSMP.NET) erkannt – auch ohne Tags. Ist das Spielbild im Hochformat stark verkleinert, klappt das nicht immer.`
          : data.canEdit
            ? 'TikTok hat keine öffentliche Live-Suche. Geprüft werden deine Accounts plus alle Twitch-Streamer, die mit den Tags gefunden wurden.'
            : 'TikTok hat keine öffentliche Live-Suche. Geprüft werden ausgewählte Accounts und alle Twitch-Streamer, die mit den Tags gefunden wurden.',
      }),
      action: data.canEdit
        ? h('button', { class: 'pill-btn secondary', type: 'button', text: 'Accounts verwalten', onclick: (e) => openSheet(e.currentTarget) })
        : null,
    });
  }
  if (sig === noticeSig) return;
  noticeSig = sig;
  noticeEl.replaceChildren(...(node ? [node] : []));
}

const emptyEl = $('#empty');
let emptySig = '';

function renderEmpty(list, p) {
  let sig = '';
  let node = null;
  const tagText = (data?.tags || []).map((t) => `[${t}]`).join(' oder ');
  if (list.length || !p || (ui.platform === 'twitch' && !data.twitch.configured) || serverDown) {
    sig = '';
  } else if (!p.updatedAt) {
    sig = 'first';
  } else if (p.streams.length && (ui.query || ui.filter !== 'all')) {
    sig = 'nomatch:' + ui.query + ui.filter;
    node = h('div', { class: 'empty' },
      h('div', { class: 'glyph' }, icon('search')),
      h('h2', { text: 'Keine Treffer' }),
      h('p', { text: ui.query ? `Kein Stream passt zu „${searchInput.value.trim()}“.` : 'Mit diesem Tag ist gerade niemand live.' }),
      h('button', { class: 'pill-btn secondary', type: 'button', text: 'Filter zurücksetzen', onclick: resetFilters }));
  } else {
    sig = 'none:' + ui.platform;
    node = h('div', { class: 'empty' },
      h('div', { class: 'glyph' }, icon('wave')),
      h('h2', { text: 'Gerade ist niemand live' }),
      h('p', { text: `Sobald jemand mit ${tagText} streamt, erscheint er hier automatisch.` }));
  }
  if (sig === emptySig) return;
  emptySig = sig;
  emptyEl.replaceChildren(...(node ? [node] : []));
}

function resetFilters() {
  ui.filter = 'all';
  ui.query = '';
  searchInput.value = '';
  render();
}

const excludedEl = $('#excluded');
const excludedList = $('#excludedList');
let excludedSig = '';

function renderExcluded(p) {
  const list = p?.excluded || [];
  excludedEl.hidden = !list.length;
  const sig = ui.platform + JSON.stringify(list.map((s) => [s.key, s.reasons, s.title, s.avatar]));
  if (sig === excludedSig) return;
  excludedSig = sig;
  const counts = {};
  for (const s of list) for (const r of s.reasons) counts[r] = (counts[r] || 0) + 1;
  $('#excludedSummary').textContent =
    `${list.length} ausgeblendet · ` + Object.entries(counts).map(([r, n]) => `${n} ${REASONS[r] || r}`).join(' · ');
  excludedList.replaceChildren(...list.map((s) =>
    h('li', {}, h('a', { href: s.url, target: '_blank', rel: 'noopener noreferrer' },
      s.avatar ? h('img', { class: 'avatar', src: s.avatar, alt: '', loading: 'lazy', referrerpolicy: 'no-referrer' }) : h('span', { class: 'avatar' }),
      h('div', { style: 'min-width:0' }, h('div', { class: 'ex-name', text: s.name }), h('div', { class: 'ex-title', text: s.title, title: s.title })),
      h('div', { class: 'reasons' }, s.reasons.map((r) => h('span', { class: 'reason', text: REASONS[r] || r })))))));
}

// ---------------------------------------------------------------------------
// Status & Render
// ---------------------------------------------------------------------------

const statusEl = $('#status');
const refreshBtn = $('#refreshBtn');

function renderStatus() {
  const p = data?.[ui.platform];
  let text;
  if (serverDown) text = 'Server nicht erreichbar';
  else if (!data) text = 'Verbinde …';
  else if (ui.platform === 'twitch' && !data.twitch.configured) text = 'Twitch-Zugang fehlt';
  else if (!p.updatedAt) text = p.scanning ? 'Suche läuft …' : 'Warte auf erste Abfrage …';
  else {
    const what = ui.platform === 'twitch'
      ? `${fmtInt.format(p.scanned)} Streams durchsucht`
      : `${fmtInt.format(p.feedRooms || 0)} Minecraft-Lives + ${fmtInt.format(p.checked)} Accounts geprüft`;
    text = `${what} · ${p.scanning ? 'aktualisiere …' : 'aktualisiert ' + ago(p.updatedAt)}`;
  }
  if (statusEl.textContent !== text) statusEl.textContent = text;
  const scanning = Boolean(data && (data.twitch.scanning || data.tiktok.scanning));
  refreshBtn.classList.toggle('is-spinning', scanning);
}
setInterval(renderStatus, 1000);

function render() {
  const p = data?.[ui.platform];
  for (const platform of PLATFORMS) {
    const el = segmented.querySelector(`[data-count="${platform}"]`);
    const d = data?.[platform];
    const n = d && (platform !== 'twitch' || d.configured) && d.updatedAt ? d.streams.length : null;
    el.textContent = n == null ? '–' : n;
    el.classList.toggle('has-live', Boolean(n));
  }
  if (data?.tags) $('#tagLine').textContent = data.tags.map((t) => `[${t}]`).join(' · ');

  renderStatus();
  renderNotice();
  renderChips();
  const list = visibleStreams();
  const waiting = !serverDown && (!data || (p && !p.updatedAt && !(ui.platform === 'twitch' && !data.twitch.configured)));
  renderGrid(list, waiting);
  renderEmpty(list, p);
  renderExcluded(p);
}

// ---------------------------------------------------------------------------
// Laden
// ---------------------------------------------------------------------------

// Zwei Betriebsarten: mit eigenem Server (/api/streams) oder als statische Seite
// (GitHub Pages), deren Daten ein geplanter Lauf nach data/streams.json schreibt.
let mode = location.hostname.endsWith('.github.io') ? 'static' : null; // 'live' | 'static'

async function fetchData() {
  if (mode !== 'static') {
    try {
      const d = await api('/api/streams');
      mode = 'live';
      return d;
    } catch (e) {
      if (mode === 'live') throw e;
    }
  }
  const d = await api('data/streams.json?t=' + Date.now());
  mode = 'static';
  return d;
}

let pollTimer = 0;
async function load() {
  clearTimeout(pollTimer);
  try {
    data = await fetchData();
    serverDown = false;
  } catch {
    serverDown = true;
  }
  render();
  const busy = data && (data.twitch.scanning || data.tiktok.scanning);
  const wait = serverDown ? 5000 : mode === 'static' ? 60_000 : busy ? 2000 : 10_000;
  if (!document.hidden) pollTimer = setTimeout(load, wait);
}

document.addEventListener('visibilitychange', () => {
  if (!document.hidden) load();
  else clearTimeout(pollTimer);
});

refreshBtn.addEventListener('click', async () => {
  if (mode === 'static') return load(); // statisch: neuesten Stand holen, abfragen tut GitHub
  try {
    await api('/api/refresh', { method: 'POST' });
  } catch {}
  if (data) data[ui.platform].scanning = true;
  renderStatus();
  setTimeout(load, 600);
});

// ---------------------------------------------------------------------------
// Sheet: TikTok-Accounts – ziehen zum Schließen, jederzeit wieder greifbar
// ---------------------------------------------------------------------------

const sheet = $('#sheet');
const scrim = $('#scrim');
const sheetHandle = $('#sheetHandle');
const addForm = $('#addForm');
const addInput = $('#addInput');
const addBtn = $('#addBtn');
const addError = $('#addError');
const accList = $('#accList');
let sheetOpen = false;
let sheetDrag = null;
let sheetHeight = 0;
let sheetReturnFocus = null;

const sheetY = new Spring(0, { damping: 1, response: 0.35, precision: 0.1 });
sheetY.onChange((y) => {
  sheet.style.transform = `translate3d(0, ${y}px, 0)`;
  // Abdunklung folgt der Position kontinuierlich.
  scrim.style.opacity = sheetHeight ? clamp(1 - y / sheetHeight, 0, 1).toFixed(3) : 0;
  // Beim Schließen fertig, sobald der Sheet ganz aus dem Bild ist – nicht erst wenn die Feder ruht.
  if (!sheetOpen && !sheetDrag && !sheet.hidden && y >= sheetHeight + 1) {
    sheetY.stop();
    sheet.hidden = true;
    scrim.hidden = true;
  }
});
const sheetFade = new Spring(1, { damping: 1, response: 0.25, precision: 0.002 });
sheetFade.onChange((o) => (sheet.style.opacity = o >= 0.999 ? '' : o.toFixed(3)));

function setBackgroundInert(inert) {
  $('#main').inert = inert;
  navbar.inert = inert;
  document.documentElement.style.overflow = inert ? 'hidden' : '';
}

function openSheet(trigger) {
  sheetReturnFocus = trigger || document.activeElement;
  const wasHidden = sheet.hidden;
  sheet.hidden = false;
  scrim.hidden = false;
  sheetOpen = true;
  sheetHeight = sheet.offsetHeight;
  setBackgroundInert(true);
  if (wasHidden) {
    if (reduceMotion.matches) {
      sheetY.set(0);
      scrim.style.opacity = 1;
      sheetFade.set(0);
      sheetFade.to(1, { allowReduced: true });
    } else sheetY.set(sheetHeight);
  }
  sheetY.to(0, { damping: 1, response: 0.35 });
  addError.textContent = '';
  loadAccounts();
  setTimeout(() => addInput.focus({ preventScroll: true }), 60);
}

function closeSheet(velocity = 0) {
  if (!sheetOpen) return;
  sheetOpen = false;
  setBackgroundInert(false);
  const finish = () => {
    if (sheetOpen) return; // wieder gegriffen
    sheet.hidden = true;
    scrim.hidden = true;
  };
  if (reduceMotion.matches) {
    sheetFade.to(0, { allowReduced: true, onRest: () => { finish(); sheetFade.set(1); } });
  } else {
    sheetY.to(sheetHeight + 24, { velocity, damping: 1, response: 0.32, onRest: finish });
  }
  sheetReturnFocus?.focus?.({ preventScroll: true });
}

$('#sheetDone').addEventListener('click', () => closeSheet());
scrim.addEventListener('click', () => closeSheet());
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && sheetOpen) closeSheet();
});

sheetHandle.addEventListener('pointerdown', (e) => {
  if (e.button !== 0 || e.target.closest('button')) return;
  sheetHandle.setPointerCapture(e.pointerId);
  sheetY.stop(); // greifen mitten in der Bewegung – vom aktuellen Wert aus weiter
  sheetHeight = sheet.offsetHeight; // Inhalt kann sich seit dem Öffnen geändert haben
  if (!sheetOpen) {
    sheetOpen = true;
    setBackgroundInert(true);
  }
  sheetDrag = { id: e.pointerId, startY: e.clientY, from: sheetY.value, tracker: new VelocityTracker() };
  sheetDrag.tracker.add(e.clientY, e.timeStamp);
});
sheetHandle.addEventListener('pointermove', (e) => {
  if (!sheetDrag || e.pointerId !== sheetDrag.id) return;
  sheetDrag.tracker.add(e.clientY, e.timeStamp);
  let y = sheetDrag.from + (e.clientY - sheetDrag.startY);
  if (y < 0) y = -rubberband(-y, sheetHeight);
  sheetY.set(y);
});
function endSheetDrag(e) {
  if (!sheetDrag || e.pointerId !== sheetDrag.id) return;
  sheetDrag.tracker.add(e.clientY, e.timeStamp);
  const v = sheetDrag.tracker.velocity;
  sheetDrag = null;
  const landing = sheetY.value + project(v);
  if (landing > sheetHeight * 0.5) closeSheet(v);
  else sheetY.to(0, { velocity: v, damping: 0.8, response: 0.3 });
}
sheetHandle.addEventListener('pointerup', endSheetDrag);
sheetHandle.addEventListener('pointercancel', endSheetDrag);

// --- Accountliste ---

const STATUS_TEXT = { live: 'Live', offline: 'Offline', notfound: 'Nicht gefunden', error: 'Fehler', pending: 'Wird geprüft' };
const SOURCE_TEXT = { twitch: 'über Twitch gefunden', erkannt: 'auf HugoSMP erkannt' };

function accountRow(a) {
  const status = a.status === 'live' && !a.matched.length ? 'Live, ohne Tag' : STATUS_TEXT[a.status] || a.status;
  const row = h('li', { class: 'acc', 'data-name': a.name },
    a.avatar ? h('img', { class: 'avatar', src: a.avatar, alt: '', loading: 'lazy', referrerpolicy: 'no-referrer' }) : h('span', { class: 'avatar' }),
    h('div', { style: 'min-width:0' },
      h('div', { class: 'acc-name', text: a.nickname || a.name }),
      h('div', { class: 'acc-handle', text: '@' + a.name + (SOURCE_TEXT[a.source] ? ' · ' + SOURCE_TEXT[a.source] : '') })),
    h('span', { class: 'acc-status', 'data-s': a.status, title: a.error || '', text: status }),
    h('button', { class: 'remove-btn', type: 'button', 'aria-label': `@${a.name} entfernen`, title: 'Entfernen', onclick: () => removeAccount(a.name, row) }, icon('minus')));
  return row;
}

async function loadAccounts() {
  try {
    const { accounts } = await api('/api/tiktok/accounts');
    accList.replaceChildren(...accounts.map(accountRow));
  } catch (e) {
    addError.textContent = 'Liste konnte nicht geladen werden: ' + e.message;
  }
}

const NAME_RE = /^[a-z0-9._]{2,24}$/;
const cleanName = (v) => v.trim().replace(/^@/, '').toLowerCase();

addInput.addEventListener('input', () => {
  const name = cleanName(addInput.value);
  addBtn.disabled = !name;
  // Inline prüfen, nicht erst beim Absenden.
  addError.textContent = name && !NAME_RE.test(name) ? 'Nur a–z, 0–9, Punkt und Unterstrich (2–24 Zeichen).' : '';
});

addForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const name = cleanName(addInput.value);
  if (!NAME_RE.test(name)) return;
  addBtn.disabled = true;
  addBtn.textContent = 'Prüfe …';
  addError.textContent = '';
  try {
    const { account } = await api('/api/tiktok/accounts', { method: 'POST', body: { name } });
    const row = accountRow(account);
    accList.prepend(row);
    row.animate([{ opacity: 0, transform: 'translateY(-6px)' }, { opacity: 1, transform: 'none' }], { duration: reduceMotion.matches ? 1 : 320, easing: 'cubic-bezier(0.2, 0.8, 0.2, 1)' });
    addInput.value = '';
    load();
  } catch (err) {
    addError.textContent = err.message;
  } finally {
    addBtn.textContent = 'Hinzufügen';
    addBtn.disabled = !cleanName(addInput.value);
  }
});

async function removeAccount(name, row) {
  const next = row.nextElementSibling;
  row.remove();
  try {
    await api('/api/tiktok/accounts/' + encodeURIComponent(name), { method: 'DELETE' });
    load();
  } catch (err) {
    accList.insertBefore(row, next);
    addError.textContent = err.message;
  }
}

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

document.body.dataset.platform = ui.platform;
content.setAttribute('aria-labelledby', 'tab-' + ui.platform);
segButtons.forEach((b, i) => {
  b.setAttribute('aria-selected', String(i === segIndex));
  b.tabIndex = i === segIndex ? 0 : -1;
});
measureSegments();
updateNavbar();
render();
load();
