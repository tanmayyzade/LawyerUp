// LawyerUp frontend — a small dependency-free single-page app talking to /api.
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const app = $('#app');

const state = { me: null, meta: null, compare: loadJSON('lu.compare', []), timers: [] };

// ------------------------------------------------------------------ utils
function loadJSON(k, d) { try { return JSON.parse(sessionStorage.getItem(k)) ?? d; } catch { return d; } }
function saveJSON(k, v) { sessionStorage.setItem(k, JSON.stringify(v)); }

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ESC[c]);
/** Tagged template that escapes interpolations unless wrapped with raw(). */
const RAW = Symbol('raw');
const raw = (s) => ({ [RAW]: String(s) });
function h(strings, ...vals) {
  return strings.reduce((out, s, i) => {
    if (i === 0) return s;
    const v = vals[i - 1];
    const str = Array.isArray(v) ? v.map((x) => (x && x[RAW] !== undefined ? x[RAW] : esc(x))).join('')
      : v && v[RAW] !== undefined ? v[RAW] : esc(v);
    return out + str + s;
  }, '');
}

const rupees = (paise) => '₹' + (paise / 100).toLocaleString('en-IN', { maximumFractionDigits: 2 });
const TZ = 'Asia/Kolkata';
const fmt = (d, opts) => new Intl.DateTimeFormat('en-IN', { timeZone: TZ, ...opts }).format(new Date(d));
const fmtDateTime = (d) => fmt(d, { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
const fmtTime = (d) => fmt(d, { hour: 'numeric', minute: '2-digit' });
const istDay = (d) => fmt(d, { year: 'numeric', month: '2-digit', day: '2-digit' }).split('/').reverse().join('-');
const initials = (name) => name.replace(/^Adv\.\s*/, '').split(/\s+/).map((p) => p[0]).slice(0, 2).join('').toUpperCase();
const stars = (r) => '★'.repeat(Math.round(r)) + '☆'.repeat(5 - Math.round(r));
const MODE = { video: 'Video call', phone: 'Phone call', in_person: 'In person' };
const STATUS = {
  pending_payment: ['Awaiting payment', 'warn'], confirmed: ['Confirmed', 'solid'], completed: ['Completed', ''],
  cancelled: ['Cancelled', 'dim'], expired: ['Expired', 'dim'],
};
const statusPill = (s) => h`<span class="pill ${STATUS[s]?.[1] || ''}">${STATUS[s]?.[0] || s}</span>`;
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

class ApiError extends Error { constructor(msg, status, code) { super(msg); this.status = status; this.code = code; } }
async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(`/api${path}`, {
    method, credentials: 'same-origin',
    headers: body !== undefined || method !== 'GET' ? { 'content-type': 'application/json' } : {},
    body: method === 'GET' ? undefined : JSON.stringify(body ?? {}),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(data?.error?.message || `Request failed (${res.status})`, res.status, data?.error?.code);
  return data;
}

let toastTimer;
function toast(msg, isErr = false) {
  const t = $('#toast');
  t.textContent = msg; t.className = `toast glass show${isErr ? ' err' : ''}`;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.className = 'toast glass'; }, 4000);
}
const fail = (e) => toast(e.message || String(e), true);

function go(hash) { if (location.hash === hash) render(); else location.hash = hash; }
function parseHash() {
  const [path, qs] = (location.hash.slice(1) || '/').split('?');
  return { path, params: new URLSearchParams(qs || '') };
}
function every(ms, fn) { const id = setInterval(fn, ms); state.timers.push(id); return id; }
const loading = () => { app.innerHTML = '<div class="spinner" aria-label="Loading"></div>'; };

function requireLogin(role) {
  if (!state.me) { go(`#/login?next=${encodeURIComponent(location.hash)}`); return false; }
  if (role && state.me.role !== role) { app.innerHTML = h`<div class="empty">This page is for ${role} accounts.</div>`; return false; }
  return true;
}

// ------------------------------------------------------------------ chrome: bar, footer, demo chip
const LOGO = '<svg class="mark" viewBox="0 0 32 32" aria-hidden="true"><rect width="32" height="32" rx="9"/><path d="M11.5 8v14.25l10-3.1"/><circle cx="23.4" cy="18.55" r="1.75"/></svg>';
const ICON = {
  check: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>',
  shield: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3 4.5 6v5.5c0 4.6 3.2 8.4 7.5 9.5 4.3-1.1 7.5-4.9 7.5-9.5V6L12 3Z"/><path d="m8.8 12.2 2.2 2.2 4.4-4.6"/></svg>',
  receipt: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 3h12v18l-3-2-3 2-3-2-3 2V3Z"/><path d="M9 8h6M9 12h6M9 16h3"/></svg>',
  lock: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="5" y="10.5" width="14" height="10" rx="2.5"/><path d="M8.5 10.5V8a3.5 3.5 0 0 1 7 0v2.5"/></svg>',
  clock: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/></svg>',
  badge: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 1.2 9.6 2.5l2-.2.6 1.9 1.8 1-.6 1.9.6 1.9-1.8 1-.6 1.9-2-.2L8 14.8l-1.6-1.3-2 .2-.6-1.9-1.8-1 .6-1.9-.6-1.9 1.8-1 .6-1.9 2 .2L8 1.2Z" fill="#000"/><path d="m5.4 8.2 1.7 1.7 3.5-3.6" fill="none" stroke="#fff" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>',
};
const verifiedBadge = () => raw(`<span class="verified">${ICON.badge}Verified advocate</span>`);

function renderNav() {
  const me = state.me;
  const { path } = parseHash();
  const link = (href, label) => {
    const p = href.slice(1);
    const on = p === '/' ? path === '/' : (path === p || path.startsWith(`${p}/`) || (p === '/find' && path.startsWith('/lawyers')));
    return h`<a href="${href}" class="${on ? 'active' : ''}">${label}</a>`;
  };
  const links = [link('#/find', 'Find a lawyer'), link('#/how-it-works', 'How it works'), link('#/for-lawyers', 'For lawyers')];
  if (me?.role === 'client') links.push(link('#/bookings', 'My consultations'));
  if (me?.role === 'lawyer') links.push(link('#/workspace', 'Workspace'), link('#/bookings', 'Consultations'));
  if (me?.role === 'admin') links.push(link('#/admin', 'Admin'));
  $('#nav').innerHTML = links.join('');
  $('#account').innerHTML = me
    ? h`<a class="who" href="${me.role === 'lawyer' ? '#/workspace' : me.role === 'admin' ? '#/admin' : '#/bookings'}" title="${me.name}"><span class="avatar">${initials(me.name)}</span><span>${me.name.replace(/^Adv\.\s*/, '').split(' ')[0]}</span></a>
        <button class="btn ghost sm hide-sm" id="logout">Sign out</button>`
    : h`<a class="btn ghost sm hide-sm" href="#/login">Sign in</a><a class="btn sm" href="#/register">Get started</a>`;
  $('#logout')?.addEventListener('click', async () => {
    await api('/auth/logout', { method: 'POST' }); state.me = null; toast('Signed out.'); go('#/');
  });
  if (me) $('#nav').insertAdjacentHTML('beforeend', '<a href="#" class="mobile-only" id="logout-m">Sign out</a>');
  else $('#nav').insertAdjacentHTML('beforeend', '<a href="#/login" class="mobile-only">Sign in</a>');
  $('#logout-m')?.addEventListener('click', (e) => { e.preventDefault(); $('#logout').click(); });
}
$('.menu-toggle').addEventListener('click', () => {
  const open = $('#nav').classList.toggle('open');
  $('.menu-toggle').setAttribute('aria-expanded', String(open));
});
addEventListener('scroll', () => $('#bar').classList.toggle('scrolled', scrollY > 8), { passive: true });

function renderFooter() {
  $('#footer').innerHTML = h`
    <div class="footer-inner">
      <div class="brand-col">
        <a href="#/" class="brand">${raw(LOGO)}<span class="wordmark">LawyerUp</span></a>
        <p>Verified advocates, fees you can see before you book, and consultations by video, phone or in person. Starting in Mumbai.</p>
      </div>
      <div><h4>Clients</h4><ul>
        <li><a href="#/find">Find a lawyer</a></li><li><a href="#/how-it-works">How it works</a></li>
        <li><a href="#/how-it-works?s=fees">Fees and refunds</a></li><li><a href="#/help">Help</a></li></ul></div>
      <div><h4>Lawyers</h4><ul>
        <li><a href="#/for-lawyers">Join LawyerUp</a></li><li><a href="#/register?role=lawyer">Create a profile</a></li>
        <li><a href="#/workspace">Workspace</a></li></ul></div>
      <div><h4>Company</h4><ul>
        <li><a href="#/about">About</a></li><li><a href="#/privacy">Privacy</a></li><li><a href="#/terms">Terms</a></li></ul></div>
    </div>
    <div class="fine"><span>© ${new Date().getFullYear()} LawyerUp</span>
      <span>LawyerUp connects you with independent advocates. Nothing on this site is legal advice.</span></div>`;
}

function renderDemoChip() {
  const chip = $('#demo-chip');
  if (sessionStorage.getItem('lu.demoChip') === 'hidden') { chip.classList.add('hidden'); return; }
  chip.innerHTML = '<span><b>Development build.</b> Payments, OTP and identity checks are simulated. Please don\'t enter Aadhaar numbers or confidential case details.</span><button aria-label="Dismiss">×</button>';
  chip.classList.remove('hidden');
  chip.querySelector('button').onclick = () => { chip.classList.add('hidden'); sessionStorage.setItem('lu.demoChip', 'hidden'); };
}

// ------------------------------------------------------------------ search
let map, markers = {};
async function viewSearch({ params }) {
  const meta = state.meta;
  const s = {
    area: params.get('area') || '', lat: params.get('lat') || '', lng: params.get('lng') || '',
    radiusKm: params.get('radiusKm') || '10', specialization: params.get('specialization') || '',
    language: params.get('language') || '', mode: params.get('mode') || '', maxFee: params.get('maxFee') || '',
    minRating: params.get('minRating') || '', sort: params.get('sort') || 'distance', q: params.get('q') || '',
  };
  const { places } = await api(`/places?city=${meta.defaultCity}`);
  const city = meta.cities.find((c) => c.slug === meta.defaultCity);
  const opt = (v, label, cur) => h`<option value="${v}" ${String(v) === String(cur) ? 'selected' : ''}>${label}</option>`;

  app.innerHTML = h`
    <section class="page-head">
      <h1>Find a lawyer near you</h1>
      <p class="muted">${state.meta.counts.lawyers} verified advocates in ${city.name}. Fees are shown before you book.</p>
      <form id="search" class="searchbar glass" autocomplete="off">
        <div><label for="area">Area</label>
          <input id="area" name="area" list="places" placeholder="e.g. Bandra West, Andheri, Fort" value="${s.lat ? '' : s.area}" />
          <datalist id="places">${places.map((p) => raw(h`<option value="${p.name}">`))}</datalist></div>
        <div><label for="radiusKm">Within</label>
          <select id="radiusKm" name="radiusKm">${[2, 5, 10, 20, 50].map((r) => raw(opt(r, `${r} km`, s.radiusKm)))}</select></div>
        <div><label for="specialization">Legal issue</label>
          <select id="specialization" name="specialization">${raw(opt('', 'Any area of law', s.specialization))}${meta.specializations.map((x) => raw(opt(x.slug, x.name, s.specialization)))}</select></div>
        <div class="actions">
          <button class="btn" type="submit">Search</button>
          <button class="btn ghost" type="button" id="locate" title="Use my current location">Near me</button>
        </div>
        <input type="hidden" name="lat" value="${s.lat}" /><input type="hidden" name="lng" value="${s.lng}" />
      </form>
      <div class="filters">
        <select name="mode" form="search" aria-label="Consultation mode">${raw(opt('', 'Any mode', s.mode))}${Object.entries(MODE).map(([k, v]) => raw(opt(k, v, s.mode)))}</select>
        <select name="language" form="search" aria-label="Language">${raw(opt('', 'Any language', s.language))}${meta.languages.map((l) => raw(opt(l, l, s.language)))}</select>
        <select name="maxFee" form="search" aria-label="Maximum fee">${raw(opt('', 'Any fee', s.maxFee))}${[500, 1000, 2000, 3000, 5000].map((f) => raw(opt(f, `Up to ₹${f.toLocaleString('en-IN')}`, s.maxFee)))}</select>
        <select name="minRating" form="search" aria-label="Minimum rating">${raw(opt('', 'Any rating', s.minRating))}${[4, 4.5].map((r) => raw(opt(r, `${r}★ & up`, s.minRating)))}</select>
        <input name="q" form="search" placeholder="Name or keyword" value="${s.q}" aria-label="Name or keyword" />
        <select name="sort" form="search" aria-label="Sort by">${[['distance', 'Nearest'], ['fee', 'Lowest fee'], ['rating', 'Top rated'], ['experience', 'Most experienced']].map(([k, v]) => raw(opt(k, `Sort: ${v}`, s.sort)))}</select>
      </div>
    </section>
    <div class="results-head"><div id="summary" class="muted">Searching…</div><div class="small muted">Fees shown per session. LawyerUp adds a ${meta.platformFeePercent}% service fee at checkout.</div></div>
    <div class="results"><div id="list"><div class="spinner"></div></div><div id="map" aria-label="Map of lawyers"></div></div>`;

  const form = $('#search');
  const submit = () => {
    const fd = new FormData(form); const p = new URLSearchParams();
    for (const [k, v] of fd) if (v) p.set(k, v);
    if (p.get('area')) { p.delete('lat'); p.delete('lng'); }
    if (p.get('radiusKm') === '10') p.delete('radiusKm');
    if (p.get('sort') === 'distance') p.delete('sort');
    go(`#/find?${p}`);
  };
  form.addEventListener('submit', (e) => { e.preventDefault(); submit(); });
  $$('.filters select').forEach((el) => el.addEventListener('change', submit));
  $('#area').addEventListener('change', () => { form.lat.value = ''; form.lng.value = ''; });
  $('#locate').addEventListener('click', () => {
    if (!navigator.geolocation) return toast('Location is not available in this browser.', true);
    $('#locate').disabled = true;
    navigator.geolocation.getCurrentPosition(
      (pos) => { form.lat.value = pos.coords.latitude.toFixed(5); form.lng.value = pos.coords.longitude.toFixed(5); form.area.value = ''; submit(); },
      () => { $('#locate').disabled = false; toast('Could not get your location. Type an area instead.', true); },
      { timeout: 8000 });
  });

  const qs = new URLSearchParams(Object.entries(s).filter(([, v]) => v));
  let data;
  try { data = await api(`/lawyers?city=${meta.defaultCity}&${qs}`); }
  catch (e) { $('#list').innerHTML = h`<div class="empty">${e.message}</div>`; $('#summary').textContent = ''; return; }

  $('#summary').innerHTML = h`<b>${data.count}</b> lawyer${data.count === 1 ? '' : 's'} within ${data.radiusKm} km of ${data.centre.label}`;
  $('#list').innerHTML = data.count ? data.lawyers.map(lawyerCard).join('')
    : h`<div class="empty">No verified lawyers match in this radius.<br/><button class="btn ghost sm" id="widen" style="margin-top:12px">Search within 50 km</button></div>`;
  $('#widen')?.addEventListener('click', () => { form.radiusKm.value = '50'; submit(); });
  $$('#list [data-compare]').forEach((cb) => cb.addEventListener('change', () => toggleCompare(data.lawyers.find((l) => l.id === cb.dataset.compare), cb)));
  renderMap(data);
  renderCompareTray();
}

function lawyerCard(l) {
  const inCompare = state.compare.some((c) => c.id === l.id);
  return h`<article class="lawyer-card" data-id="${l.id}">
    <div class="avatar" aria-hidden="true">${initials(l.name)}</div>
    <div>
      <h3><a href="#/lawyers/${l.id}">${l.name}</a></h3>
      <div class="meta"><span>${l.area} · ${l.distance_km} km</span><span>${l.experience_years} yrs experience</span>
        ${raw(l.rating_count ? h`<span><span class="stars">${stars(l.rating_avg)}</span> ${l.rating_avg.toFixed(1)} (${l.rating_count})</span>` : '<span>New</span>')}</div>
      <p class="small" style="margin-bottom:8px">${l.headline || ''}</p>
      <div class="chips">${l.specializations.map((s) => raw(h`<span class="chip">${s.name}</span>`))}</div>
      <div class="meta" style="margin:8px 0 0">${l.languages.join(', ')} · ${l.modes.map((m) => MODE[m]).join(' / ')}</div>
    </div>
    <div class="price">
      <div><b>${rupees(l.fee_paise)}</b><div class="small muted">per ${l.session_minutes} min</div></div>
      <a class="btn sm" href="#/lawyers/${l.id}">View & book</a>
      <label class="check small"><input type="checkbox" data-compare="${l.id}" ${inCompare ? 'checked' : ''}/> Compare</label>
    </div>
  </article>`;
}

function renderMap(data) {
  if (map) { map.remove(); map = null; }
  const el = $('#map');
  if (!window.L) { el.innerHTML = '<div class="empty small">Map unavailable offline — results are listed.</div>'; return; }
  map = L.map(el, { scrollWheelZoom: false }).setView([data.centre.lat, data.centre.lng], 12);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 18, attribution: '© OpenStreetMap contributors' }).addTo(map);
  L.marker([data.centre.lat, data.centre.lng], { icon: L.divIcon({ className: '', html: '<div class="pin-me"></div>', iconSize: [16, 16] }) }).addTo(map);
  L.circle([data.centre.lat, data.centre.lng], { radius: data.radiusKm * 1000, color: '#0a0a0a', weight: 1, fillOpacity: 0.03 }).addTo(map);
  markers = {};
  const bounds = [[data.centre.lat, data.centre.lng]];
  for (const l of data.lawyers) {
    const m = L.marker([l.lat, l.lng], { icon: L.divIcon({ className: '', html: h`<div class="pin">${rupees(l.fee_paise)}</div>`, iconSize: null }) })
      .addTo(map).bindPopup(h`<b>${l.name}</b><br>${l.area} · ${rupees(l.fee_paise)} / ${l.session_minutes} min<br><a href="#/lawyers/${l.id}">View and book</a>`);
    m.on('mouseover', () => highlight(l.id, true)); m.on('mouseout', () => highlight(l.id, false));
    markers[l.id] = m; bounds.push([l.lat, l.lng]);
  }
  if (bounds.length > 1) map.fitBounds(bounds, { padding: [30, 30], maxZoom: 14 });
  $$('.lawyer-card').forEach((c) => {
    c.addEventListener('mouseenter', () => highlight(c.dataset.id, true));
    c.addEventListener('mouseleave', () => highlight(c.dataset.id, false));
  });
}
function highlight(id, on) {
  $(`.lawyer-card[data-id="${id}"]`)?.classList.toggle('hl', on);
  markers[id]?.getElement()?.querySelector('.pin')?.classList.toggle('hl', on);
}

// ------------------------------------------------------------------ compare
function toggleCompare(l, cb) {
  if (cb.checked) {
    if (state.compare.length >= 3) { cb.checked = false; return toast('You can compare up to 3 lawyers.', true); }
    state.compare.push({ id: l.id, name: l.name });
  } else state.compare = state.compare.filter((c) => c.id !== l.id);
  saveJSON('lu.compare', state.compare); renderCompareTray();
}
function renderCompareTray() {
  $('.compare-tray')?.remove();
  if (!state.compare.length || !parseHash().path.match(/^\/find$/)) return;
  const tray = document.createElement('div');
  tray.className = 'compare-tray';
  tray.innerHTML = h`<span>${state.compare.length} selected</span>
    <button class="btn sm" ${state.compare.length < 2 ? 'disabled' : ''} id="do-compare">Compare fees</button>
    <button class="link small" id="clear-compare">Clear</button>`;
  document.body.append(tray);
  $('#do-compare').onclick = () => go(`#/compare?ids=${state.compare.map((c) => c.id).join(',')}`);
  $('#clear-compare').onclick = () => { state.compare = []; saveJSON('lu.compare', []); $$('[data-compare]').forEach((c) => { c.checked = false; }); renderCompareTray(); };
}

async function viewCompare({ params }) {
  const ids = (params.get('ids') || '').split(',').filter(Boolean).slice(0, 3);
  if (ids.length < 2) { app.innerHTML = '<div class="empty">Pick at least two lawyers to compare.</div>'; return; }
  loading();
  const ls = (await Promise.all(ids.map((id) => api(`/lawyers/${id}`).catch(() => null)))).filter(Boolean).map((r) => r.lawyer);
  const min = (f) => Math.min(...ls.map(f)); const max = (f) => Math.max(...ls.map(f));
  const perMin = (l) => l.fee_paise / l.session_minutes;
  const row = (label, cell, best) => h`<tr><th>${label}</th>${ls.map((l) => raw(h`<td class="${best && best(l) ? 'best' : ''}">${raw(cell(l))}</td>`))}</tr>`;
  app.innerHTML = h`
    <button class="link small muted" data-back>← Back to results</button>
    <h1 style="margin-top:8px">Compare fees</h1>
    <p class="muted">Bold marks the best value in each row. Totals include the LawyerUp ${state.meta.platformFeePercent}% service fee.</p>
    <div class="table-wrap"><table class="compare">
      <tr><th></th>${ls.map((l) => raw(h`<td><div class="avatar" style="margin-bottom:8px">${initials(l.name)}</div><b>${l.name}</b><div class="small muted">${l.area}</div></td>`))}</tr>
      ${raw(row('Consultation fee', (l) => h`${rupees(l.fee_paise)}`, (l) => l.fee_paise === min((x) => x.fee_paise)))}
      ${raw(row('Session length', (l) => h`${l.session_minutes} min`, (l) => l.session_minutes === max((x) => x.session_minutes)))}
      ${raw(row('Effective rate', (l) => h`${rupees(Math.round(perMin(l)))} / min`, (l) => perMin(l) === min(perMin)))}
      ${raw(row('You pay (incl. service fee)', (l) => h`${rupees(l.price.total_paise)}`, (l) => l.price.total_paise === min((x) => x.price.total_paise)))}
      ${raw(row('Experience', (l) => h`${l.experience_years} years`, (l) => l.experience_years === max((x) => x.experience_years)))}
      ${raw(row('Rating', (l) => (l.rating_count ? h`${l.rating_avg.toFixed(1)} ★ (${l.rating_count})` : 'New'), (l) => l.rating_count && l.rating_avg === max((x) => x.rating_avg)))}
      ${raw(row('Modes', (l) => esc(l.modes.map((m) => MODE[m]).join(', '))))}
      ${raw(row('Languages', (l) => esc(l.languages.join(', '))))}
      ${raw(row('Practice areas', (l) => esc(l.specializations.map((s) => s.name).join(', '))))}
      ${raw(row('Enrolment', (l) => h`${l.bar_council}<br><span class="small muted">since ${l.enrollment_year}</span>`))}
      ${raw(row('', (l) => h`<a class="btn sm" href="#/lawyers/${l.id}">Book</a>`))}
    </table></div>`;
}

// ------------------------------------------------------------------ profile + booking
async function viewLawyer({ path }) {
  const id = path.split('/')[2];
  loading();
  let data;
  try { data = await api(`/lawyers/${id}`); } catch (e) { app.innerHTML = h`<div class="empty">${e.message}</div>`; return; }
  const l = data.lawyer;
  const pending = loadJSON('lu.pending', null);
  const sel = { day: null, slot: null, mode: l.modes[0], topic: '' };
  if (pending?.lawyerId === l.id) Object.assign(sel, pending.sel);

  const byDay = {};
  for (const a of data.availability) (byDay[a.weekday] ||= []).push(`${a.start}–${a.end}`);
  app.innerHTML = h`
    <button class="link small muted" data-back>← Back</button>
    <div class="grid-2" style="margin-top:12px">
      <div>
        <div class="profile-head">
          <div class="avatar lg">${initials(l.name)}</div>
          <div><h1 style="margin:0">${l.name}</h1>
            <div class="muted">${l.headline || ''}</div>
            <div class="meta" style="margin-top:6px"><span>${l.area}, ${l.city}</span><span>${l.experience_years} yrs experience</span>
              ${raw(l.rating_count ? h`<span>${stars(l.rating_avg)} ${l.rating_avg.toFixed(1)} · ${l.rating_count} reviews</span>` : '')}</div></div>
        </div>
        <div class="card">
          ${verifiedBadge()}
          <span class="small muted" style="margin-left:10px">${l.bar_council}, enrolment ${l.enrollment_number}</span>
          <div class="divider"></div>
          <p>${l.bio || ''}</p>
          <div class="chips" style="margin:10px 0">${l.specializations.map((s) => raw(h`<span class="chip">${s.name}</span>`))}</div>
          <div class="row small" style="margin-top:12px">
            <div><b>Languages</b><br>${l.languages.join(', ')}</div>
            <div><b>Consultation</b><br>${l.modes.map((m) => MODE[m]).join(', ')}</div>
            <div><b>Office</b><br>${l.office_address || l.area}</div>
          </div>
        </div>
        <div class="card"><h3>Weekly hours (IST)</h3>
          <table class="breakdown">${[1, 2, 3, 4, 5, 6, 0].map((d) => raw(h`<tr><td>${WEEKDAYS[d]}</td><td class="muted">${(byDay[d] || ['Closed']).join(', ')}</td></tr>`))}</table>
        </div>
        <div class="card"><h3>Reviews</h3>
          ${raw(data.reviews.length ? data.reviews.map((r) => h`<div class="review"><span class="stars">${stars(r.rating)}</span> <b>${r.client_first_name}</b> <span class="small muted">· ${fmt(r.created_at, { month: 'short', year: 'numeric' })}</span><div>${r.comment || ''}</div></div>`).join('') : '<p class="muted">No reviews yet.</p>')}
        </div>
      </div>
      <aside class="card glass sticky" id="book">
        <h2 style="margin-bottom:2px">${rupees(l.fee_paise)} <span class="small muted" style="font-weight:400">/ ${l.session_minutes} min session</span></h2>
        <p class="small muted">Book a consultation</p>
        <label>Mode</label>
        <div class="seg" id="modes">${l.modes.map((m) => raw(h`<button type="button" data-mode="${m}">${MODE[m]}</button>`))}</div>
        <label style="margin-top:14px">Date</label>
        <div class="days" id="days"></div>
        <div id="slots"><div class="spinner"></div></div>
        <div class="field" style="margin-top:14px"><label for="topic">What do you need help with? <span class="muted">(optional)</span></label>
          <textarea id="topic" maxlength="500" placeholder="A short, general description — e.g. 'Builder has delayed possession by 2 years'">${sel.topic}</textarea>
          <div class="hint">Keep it general. Share confidential details only with your lawyer during the consultation.</div></div>
        <table class="breakdown">
          <tr><td>Consultation fee</td><td>${rupees(l.price.fee_paise)}</td></tr>
          <tr><td>LawyerUp service fee (${state.meta.platformFeePercent}%)</td><td>${rupees(l.price.platform_fee_paise)}</td></tr>
          <tr class="total"><td>Total</td><td>${rupees(l.price.total_paise)}</td></tr>
        </table>
        <button class="btn block" id="continue" style="margin-top:14px" disabled>Choose a time</button>
        <p class="small muted" style="margin-top:10px">Free cancellation up to ${state.meta.freeCancelHours} hours before. Your slot is held for ${state.meta.bookingHoldMinutes} minutes while you pay.</p>
      </aside>
    </div>`;

  const setMode = (m) => { sel.mode = m; $$('#modes button').forEach((b) => b.classList.toggle('on', b.dataset.mode === m)); };
  $$('#modes button').forEach((b) => b.addEventListener('click', () => setMode(b.dataset.mode)));
  setMode(l.modes.includes(sel.mode) ? sel.mode : l.modes[0]);

  const days = [...Array(14)].map((_, i) => istDay(Date.now() + i * 86_400_000));
  $('#days').innerHTML = days.map((d) => {
    const dt = new Date(`${d}T12:00:00+05:30`);
    return h`<button type="button" class="day" data-day="${d}"><small>${fmt(dt, { weekday: 'short' })}</small><b>${fmt(dt, { day: 'numeric' })}</b><small>${fmt(dt, { month: 'short' })}</small></button>`;
  }).join('');

  const updateCta = () => {
    const btn = $('#continue');
    btn.disabled = !sel.slot;
    btn.textContent = sel.slot ? `Continue · ${fmtDateTime(sel.slot.startsAt)}` : 'Choose a time';
  };
  async function loadDay(day) {
    sel.day = day;
    $$('#days .day').forEach((b) => b.classList.toggle('on', b.dataset.day === day));
    $('#slots').innerHTML = '<div class="spinner"></div>';
    const { slots } = await api(`/lawyers/${l.id}/slots?date=${day}`);
    if (!slots.length) { $('#slots').innerHTML = '<p class="small muted" style="margin-top:12px">Not available on this day.</p>'; }
    else {
      const any = slots.some((x) => x.available);
      $('#slots').innerHTML = h`<div class="slots">${slots.map((x) => raw(h`<button type="button" class="slot ${sel.slot?.startsAt === x.startsAt ? 'on' : ''}" data-start="${x.startsAt}" ${x.available ? '' : 'disabled'}>${fmtTime(x.startsAt)}</button>`))}</div>
        ${raw(any ? '' : '<p class="small muted" style="margin-top:8px">Fully booked — try another day.</p>')}`;
      $$('#slots .slot').forEach((b) => b.addEventListener('click', () => {
        sel.slot = slots.find((x) => x.startsAt === b.dataset.start);
        $$('#slots .slot').forEach((x) => x.classList.toggle('on', x === b)); updateCta();
      }));
    }
    updateCta();
  }
  $$('#days .day').forEach((b) => b.addEventListener('click', () => { sel.slot = null; loadDay(b.dataset.day); }));

  // Open the first day that has a free slot (or the remembered one)
  let start = sel.day && days.includes(sel.day) ? sel.day : null;
  if (!start) {
    for (const d of days) {
      const { slots } = await api(`/lawyers/${l.id}/slots?date=${d}`);
      if (slots.some((x) => x.available)) { start = d; break; }
    }
  }
  await loadDay(start || days[0]);

  $('#continue').addEventListener('click', async () => {
    sel.topic = $('#topic').value.trim();
    if (!state.me) {
      saveJSON('lu.pending', { lawyerId: l.id, sel });
      toast('Sign in or create an account to book.');
      return go(`#/login?next=${encodeURIComponent(`#/lawyers/${l.id}`)}`);
    }
    if (state.me.role !== 'client') return toast('Sign in with a client account to book.', true);
    const btn = $('#continue'); btn.disabled = true; btn.textContent = 'Holding your slot…';
    try {
      const res = await api('/bookings', { method: 'POST', body: { lawyerId: l.id, startsAt: sel.slot.startsAt, mode: sel.mode, issueSummary: sel.topic || undefined } });
      sessionStorage.removeItem('lu.pending');
      go(`#/checkout/${res.booking.id}`);
    } catch (e) {
      if (e.code === 'kyc_required') { saveJSON('lu.pending', { lawyerId: l.id, sel }); return showKycPrompt(() => $('#continue').click()); }
      fail(e); if (e.code === 'slot_taken') { sel.slot = null; loadDay(sel.day); } else updateCta();
    }
  });
}

function showKycPrompt(onDone) {
  const box = document.createElement('div');
  box.className = 'notice strong';
  box.style.marginTop = '12px';
  box.innerHTML = h`<b>Verify your identity to book</b>
    <p class="small" style="margin:6px 0 10px">In production this uses an Aadhaar e-KYC partner or DigiLocker, and LawyerUp keeps only a verification reference.
    In this build it's a sandbox check — nothing is collected.</p>
    <button class="btn sm" id="kyc-go">Verify (sandbox)</button>`;
  $('#continue').after(box);
  $('#kyc-go').onclick = async () => {
    try { await api('/auth/kyc/start', { method: 'POST' }); state.me.kycStatus = 'verified'; box.remove(); toast('Identity verified.'); onDone(); }
    catch (e) { fail(e); }
  };
}

// ------------------------------------------------------------------ checkout
async function viewCheckout({ path }) {
  if (!requireLogin('client')) return;
  const id = path.split('/')[2];
  loading();
  let { booking: b } = await api(`/bookings/${id}`);
  if (b.status !== 'pending_payment') return go(`#/bookings/${b.id}`);

  const render = () => {
    const p = b.payment;
    app.innerHTML = h`
      <div style="max-width:640px;margin:0 auto">
        <h1>Confirm & pay</h1>
        <div class="notice strong" id="hold">Slot held for <b id="countdown">—</b>. Complete payment to confirm.</div>
        <div class="card" style="margin-top:14px">
          <div class="profile-head" style="margin-bottom:10px"><div class="avatar">${initials(b.lawyer_name)}</div>
            <div><h3 style="margin:0">${b.lawyer_name}</h3><div class="muted small">${MODE[b.mode]} · ${fmtDateTime(b.starts_at)} – ${fmtTime(b.ends_at)} IST</div></div></div>
          ${raw(b.issue_summary ? h`<p class="small"><b>Topic:</b> ${b.issue_summary}</p>` : '')}
          <table class="breakdown">
            <tr><td>Consultation fee</td><td>${rupees(b.fee_paise)}</td></tr>
            <tr><td>LawyerUp service fee</td><td>${rupees(b.platform_fee_paise)}</td></tr>
            <tr class="total"><td>Total payable</td><td>${rupees(b.total_paise)}</td></tr>
          </table>
        </div>
        ${raw(p?.status === 'failed' ? h`<div class="notice" style="margin-top:14px">Last attempt failed: ${p.failure_reason || 'payment failed'}. You can try again.</div>` : '')}
        <div class="card" style="margin-top:14px">
          ${raw(state.meta.payments.provider === 'razorpay'
            ? h`<button class="btn block" id="pay">Pay ${rupees(b.total_paise)} with Razorpay</button>`
            : h`<p class="small muted" style="margin-top:0">Test payment gateway — no money moves. Choose an outcome:</p>
               <div class="row"><button class="btn" id="pay">Pay ${rupees(b.total_paise)} (test success)</button>
               <button class="btn ghost" id="pay-fail">Simulate a failed payment</button></div>`)}
          <div class="row" style="margin-top:12px"><button class="link small muted" id="cancel">Cancel and release this slot</button></div>
        </div>
      </div>`;

    const left = () => Math.max(0, new Date(b.hold_expires_at) - Date.now());
    const tick = () => {
      const ms = left();
      const el = $('#countdown'); if (!el) return;
      el.textContent = `${Math.floor(ms / 60000)}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')}`;
      if (!ms) { $('#hold').innerHTML = 'Your hold has expired. If you still pay, we confirm the slot if it is free — otherwise you get an automatic full refund.'; }
    };
    tick(); every(1000, tick);

    const orderFor = async () => {
      if (b.payment?.status === 'created') return { orderId: b.payment.provider_order_id, amount: b.total_paise };
      const { checkout } = await api(`/bookings/${b.id}/payment-order`, { method: 'POST' });
      return checkout;
    };
    const finish = async (r) => {
      const res = await api('/payments/verify', { method: 'POST', body: r });
      toast(res.message, res.outcome !== 'confirmed' && res.outcome !== 'already');
      go(`#/bookings/${b.id}`);
    };
    const reportFail = async (orderId, reason) => {
      const res = await api('/payments/failed', { method: 'POST', body: { orderId, reason } });
      b = res.booking; toast(res.message, true); render();
    };

    $('#pay').onclick = async () => {
      $('#pay').disabled = true;
      try {
        const order = await orderFor();
        if (state.meta.payments.provider === 'razorpay') {
          await loadScript('https://checkout.razorpay.com/v1/checkout.js');
          const rzp = new window.Razorpay({
            key: state.meta.payments.razorpayKeyId, order_id: order.orderId, amount: order.amount, currency: 'INR',
            name: 'LawyerUp', description: `Consultation with ${b.lawyer_name}`,
            prefill: { name: state.me.name, email: state.me.email, contact: state.me.phone }, theme: { color: '#0a0a0a' },
            handler: (r) => finish({ orderId: r.razorpay_order_id, paymentId: r.razorpay_payment_id, signature: r.razorpay_signature }).catch(fail),
            modal: { ondismiss: () => { $('#pay').disabled = false; } },
          });
          rzp.on('payment.failed', (r) => reportFail(order.orderId, r.error?.description).catch(fail));
          rzp.open();
        } else {
          const r = await api('/payments/mock/checkout', { method: 'POST', body: { orderId: order.orderId, outcome: 'success' } });
          await finish(r);
        }
      } catch (e) { fail(e); $('#pay').disabled = false; if (e.code === 'not_payable') go(`#/bookings/${b.id}`); }
    };
    $('#pay-fail')?.addEventListener('click', async () => {
      try {
        const order = await orderFor();
        const r = await api('/payments/mock/checkout', { method: 'POST', body: { orderId: order.orderId, outcome: 'failure' } });
        await reportFail(order.orderId, r.reason);
      } catch (e) { fail(e); }
    });
    $('#cancel').onclick = async () => {
      try { await api(`/bookings/${b.id}/cancel`, { method: 'POST', body: { reason: 'Abandoned at checkout' } }); toast('Slot released.'); go(`#/lawyers/${b.lawyer_id}`); }
      catch (e) { fail(e); }
    };
  };
  render();
}

function loadScript(src) {
  return new Promise((resolve, reject) => {
    if ($(`script[src="${src}"]`)) return resolve();
    const s = document.createElement('script'); s.src = src; s.onload = resolve; s.onerror = () => reject(new Error('Could not load the payment window.'));
    document.head.append(s);
  });
}

// ------------------------------------------------------------------ bookings
async function viewBookings({ params }) {
  if (!requireLogin()) return;
  const scope = params.get('scope') || 'upcoming';
  loading();
  const { bookings } = await api(`/bookings?scope=${scope}`);
  const isLawyer = state.me.role === 'lawyer';
  app.innerHTML = h`
    <h1>${isLawyer ? 'Consultations' : 'My consultations'}</h1>
    ${raw(state.me.role === 'client' && state.me.kycStatus !== 'verified' ? '<div class="notice" style="margin-bottom:14px">Verify your identity before your first booking — you\'ll be prompted when you book.</div>' : '')}
    <div class="tabs"><button data-s="upcoming" class="${scope === 'upcoming' ? 'on' : ''}">Upcoming</button><button data-s="past" class="${scope === 'past' ? 'on' : ''}">Past & cancelled</button></div>
    ${raw(bookings.length ? bookings.map((b) => bookingRow(b, isLawyer)).join('')
      : h`<div class="empty">No ${scope} consultations.${raw(isLawyer ? '' : '<br><a class="btn sm" href="#/find" style="margin-top:12px">Find a lawyer</a>')}</div>`)}`;
  $$('.tabs button').forEach((b) => b.addEventListener('click', () => go(`#/bookings?scope=${b.dataset.s}`)));
}
function bookingRow(b, isLawyer) {
  return h`<a class="booking-row" href="#/bookings/${b.id}">
    <div class="datebox"><small>${fmt(b.starts_at, { month: 'short' })}</small><b>${fmt(b.starts_at, { day: 'numeric' })}</b><small>${fmt(b.starts_at, { weekday: 'short' })}</small></div>
    <div><b>${isLawyer ? b.client_name : b.lawyer_name}</b>
      <div class="small muted">${fmtTime(b.starts_at)} – ${fmtTime(b.ends_at)} · ${MODE[b.mode]} · ${rupees(isLawyer ? b.fee_paise : b.total_paise)}</div>
      ${raw(b.issue_summary ? h`<div class="small" style="margin-top:2px">${b.issue_summary}</div>` : '')}</div>
    <div>${raw(statusPill(b.status))}</div></a>`;
}

async function viewBooking({ path }) {
  if (!requireLogin()) return;
  const id = path.split('/')[2];
  loading();
  let b;
  try { ({ booking: b } = await api(`/bookings/${id}`)); } catch (e) { app.innerHTML = h`<div class="empty">${e.message}</div>`; return; }
  const me = state.me; const isLawyer = b.lawyer_id === me.id; const isClient = b.client_id === me.id;
  const started = new Date(b.starts_at) <= new Date();
  const canCancel = ['pending_payment', 'confirmed'].includes(b.status) && !started && me.role !== 'admin';
  const lateCancel = isClient && (new Date(b.starts_at) - Date.now()) / 3_600_000 < state.meta.freeCancelHours;
  const chatOpen = ['confirmed', 'completed'].includes(b.status) && me.role !== 'admin';

  const how = {
    video: b.meeting_url ? h`<a class="btn" href="${b.meeting_url}" target="_blank" rel="noopener">Join video call</a><div class="small muted" style="margin-top:6px">The link works from 10 minutes before the start.</div>` : '',
    phone: h`<p class="small">${isLawyer ? 'Call the client on their registered number at the scheduled time.' : 'Your lawyer will call your registered mobile number at the scheduled time.'}</p>`,
    in_person: h`<p class="small"><b>Office:</b> ${b.office_address || b.lawyer_area}</p>`,
  }[b.mode];

  app.innerHTML = h`
    <a href="#/bookings" class="small muted">← All consultations</a>
    <div class="grid-2" style="margin-top:12px">
      <div>
        <div class="card">
          <div style="display:flex;justify-content:space-between;gap:10px;align-items:flex-start">
            <div><h1 style="margin-bottom:4px">${isLawyer ? b.client_name : b.lawyer_name}</h1>
              <div class="muted">${fmtDateTime(b.starts_at)} – ${fmtTime(b.ends_at)} IST · ${MODE[b.mode]}</div></div>
            ${raw(statusPill(b.status))}
          </div>
          ${raw(b.issue_summary ? h`<p style="margin-top:12px"><b>Topic:</b> ${b.issue_summary}</p>` : '')}
          ${raw(b.status === 'confirmed' ? h`<div class="divider"></div>${raw(how)}` : '')}
          ${raw(b.status === 'pending_payment' && isClient ? h`<div class="divider"></div><a class="btn" href="#/checkout/${b.id}">Complete payment</a>` : '')}
          ${raw(b.status === 'cancelled' ? h`<p class="small muted" style="margin-top:12px">Cancelled ${fmtDateTime(b.cancelled_at)}${b.cancel_reason ? ` — ${b.cancel_reason}` : ''}</p>` : '')}
        </div>
        ${raw(chatOpen ? `<div class="card"><h3>Messages</h3><p class="small muted">Use this for scheduling and quick questions. Share sensitive documents only through channels your lawyer confirms.</p>
          <div class="chat"><div class="chat-log" id="log"></div>
          <form class="chat-form" id="chat"><textarea name="body" placeholder="Write a message…" maxlength="2000" required></textarea><button class="btn">Send</button></form></div></div>` : '')}
        ${raw(isClient && b.status === 'completed' && !b.reviewed ? `<div class="card"><h3>Rate your consultation</h3>
          <form id="review"><div class="field"><select name="rating" required><option value="">Rating…</option>${[5, 4, 3, 2, 1].map((r) => `<option value="${r}">${'★'.repeat(r)} ${r}</option>`).join('')}</select></div>
          <div class="field"><textarea name="comment" maxlength="1000" placeholder="What was helpful? (optional)"></textarea></div><button class="btn">Submit review</button></form></div>` : '')}
      </div>
      <aside class="card glass sticky">
        <h3>Payment</h3>
        <table class="breakdown">
          ${raw(isLawyer ? h`<tr class="total"><td>Your fee</td><td>${rupees(b.fee_paise)}</td></tr>` : h`
          <tr><td>Consultation fee</td><td>${rupees(b.fee_paise)}</td></tr>
          <tr><td>Service fee</td><td>${rupees(b.platform_fee_paise)}</td></tr>
          <tr class="total"><td>Total</td><td>${rupees(b.total_paise)}</td></tr>`)}
        </table>
        ${raw(b.payment ? h`<p class="small muted" style="margin-top:8px">Status: <b>${b.payment.status}</b>${b.payment.refunded_paise ? ` · refunded ${rupees(b.payment.refunded_paise)}` : ''}</p>` : '')}
        ${raw(canCancel ? h`<div class="divider"></div>
          <p class="small muted">${isLawyer ? 'Cancelling refunds the client in full.' : lateCancel ? `Less than ${state.meta.freeCancelHours} hours to go: cancelling now refunds 50%.` : 'Free cancellation — you\'ll get a full refund.'}</p>
          <button class="btn danger block" id="cancel">Cancel consultation</button>` : '')}
        ${raw(isLawyer && b.status === 'confirmed' && started ? '<div class="divider"></div><button class="btn block" id="complete">Mark as completed</button>' : '')}
      </aside>
    </div>`;

  $('#cancel')?.addEventListener('click', async () => {
    const reason = prompt('Reason for cancelling (optional):');
    if (reason === null) return;
    try {
      const r = await api(`/bookings/${b.id}/cancel`, { method: 'POST', body: { reason: reason || undefined } });
      toast(r.refund ? `Cancelled. Refund of ${rupees(r.refund.amount_paise)} initiated.` : 'Cancelled.'); render();
    } catch (e) { fail(e); }
  });
  $('#complete')?.addEventListener('click', async () => {
    try { await api(`/bookings/${b.id}/complete`, { method: 'POST' }); toast('Marked as completed.'); render(); } catch (e) { fail(e); }
  });
  $('#review')?.addEventListener('submit', async (e) => {
    e.preventDefault(); const f = e.target;
    try { await api(`/bookings/${b.id}/review`, { method: 'POST', body: { rating: Number(f.rating.value), comment: f.comment.value.trim() || undefined } }); toast('Thanks for your review!'); render(); }
    catch (err) { fail(err); }
  });

  if (chatOpen) {
    let last = 0;
    const log = $('#log');
    const pull = async () => {
      try {
        const { messages } = await api(`/bookings/${b.id}/messages?after=${last}`);
        if (!messages.length) { if (!last && !log.children.length) log.innerHTML = '<div class="muted small" id="nomsg" style="margin:auto">No messages yet.</div>'; return; }
        $('#nomsg')?.remove();
        for (const m of messages) {
          log.insertAdjacentHTML('beforeend', h`<div class="msg ${m.sender_id === me.id ? 'me' : ''}">${m.body}<small>${m.sender_id === me.id ? 'You' : m.sender_name} · ${fmtTime(m.created_at)}</small></div>`);
          last = m.id;
        }
        log.scrollTop = log.scrollHeight;
      } catch { /* transient */ }
    };
    await pull(); every(4000, pull);
    $('#chat').addEventListener('submit', async (e) => {
      e.preventDefault(); const f = e.target; const body = f.body.value.trim(); if (!body) return;
      f.body.disabled = true;
      try { await api(`/bookings/${b.id}/messages`, { method: 'POST', body: { body } }); f.body.value = ''; await pull(); }
      catch (err) { fail(err); } finally { f.body.disabled = false; f.body.focus(); }
    });
    $('#chat textarea').addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); $('#chat').requestSubmit(); } });
  }
}

// ------------------------------------------------------------------ auth
async function afterAuth(user, params) {
  state.me = user;
  const next = params.get('next');
  toast(`Welcome, ${user.name.replace(/^Adv\.\s*/, '').split(' ')[0]}.`);
  go(next || (user.role === 'lawyer' ? '#/workspace' : user.role === 'admin' ? '#/admin' : '#/'));
}

function viewLogin({ params }) {
  if (state.me) return go('#/');
  app.innerHTML = h`
    <div class="auth"><div class="card glass">
      <h1>Sign in</h1>
      <form id="login" class="stack" style="margin-top:16px">
        <div><label for="email">Email</label><input id="email" name="email" type="email" autocomplete="email" required /></div>
        <div><label for="password">Password</label><input id="password" name="password" type="password" autocomplete="current-password" required /></div>
        <button class="btn block">Sign in</button>
      </form>
      <p class="small" style="margin-top:14px">New to LawyerUp? <a href="#/register${params.get('next') ? `?next=${encodeURIComponent(params.get('next'))}` : ''}">Create an account</a></p>
      <div class="divider"></div>
      <div class="demo-logins muted">Demo accounts (password <span class="mono">Demo@1234</span>):<br>
        <button class="btn ghost sm" data-demo="client@lawyerup.dev">Client</button>
        <button class="btn ghost sm" data-demo="lawyer@lawyerup.dev">Lawyer</button>
        <button class="btn ghost sm" data-demo="admin@lawyerup.dev">Admin</button></div>
    </div></div>`;
  const f = $('#login');
  f.addEventListener('submit', async (e) => {
    e.preventDefault();
    try { const { user } = await api('/auth/login', { method: 'POST', body: { email: f.email.value, password: f.password.value } }); afterAuth(user, params); }
    catch (err) { fail(err); }
  });
  $$('[data-demo]').forEach((b) => b.addEventListener('click', () => { f.email.value = b.dataset.demo; f.password.value = 'Demo@1234'; f.requestSubmit(); }));
}

const BAR_COUNCILS = ['Bar Council of Maharashtra & Goa', 'Bar Council of Delhi', 'Karnataka State Bar Council', 'Bar Council of Tamil Nadu & Puducherry',
  'Bar Council of Telangana', 'Bar Council of West Bengal', 'Bar Council of Gujarat', 'Bar Council of Uttar Pradesh', 'Other State Bar Council'];

async function viewRegister({ params }) {
  if (state.me) return go('#/');
  const { places } = await api(`/places?city=${state.meta.defaultCity}`);
  const role = params.get('role') === 'lawyer' ? 'lawyer' : 'client';
  app.innerHTML = h`
    <div class="auth" style="max-width:640px"><div class="card glass">
      <h1>Create your account</h1>
      <div class="seg" id="role" style="margin:14px 0 18px"><button type="button" data-role="client" class="${role === 'client' ? 'on' : ''}">I need a lawyer</button><button type="button" data-role="lawyer" class="${role === 'lawyer' ? 'on' : ''}">I'm a lawyer</button></div>
      <form id="reg" autocomplete="on">
        <div class="field"><label>Full name</label><input name="name" required maxlength="120" autocomplete="name" placeholder="${role === 'lawyer' ? 'Adv. Firstname Lastname' : ''}" /></div>
        <div class="row"><div class="field"><label>Email</label><input name="email" type="email" required autocomplete="email" /></div>
          <div class="field"><label>Mobile number</label><input name="phone" inputmode="numeric" required placeholder="10-digit mobile" autocomplete="tel-national" /></div></div>
        <div class="field"><label>Password</label><input name="password" type="password" required minlength="8" autocomplete="new-password" /><div class="hint">At least 8 characters, with a letter and a number.</div></div>
        <div id="lawyer-fields" class="${role === 'lawyer' ? '' : 'hidden'}">
          <div class="divider"></div><h3>Professional details</h3>
          <p class="small muted">Your profile goes live after our team checks your enrolment with the Bar Council.</p>
          <div class="row"><div class="field"><label>Bar Council</label><select name="barCouncil">${BAR_COUNCILS.map((b) => raw(h`<option>${b}</option>`))}</select></div>
            <div class="field"><label>Enrolment number</label><input name="enrollmentNumber" placeholder="MAH/1234/2015" /></div></div>
          <div class="row"><div class="field"><label>Year of enrolment</label><input name="enrollmentYear" type="number" min="1950" max="${new Date().getFullYear()}" /></div>
            <div class="field"><label>Years of practice</label><input name="experienceYears" type="number" min="0" max="70" value="0" /></div></div>
          <div class="row"><div class="field"><label>Consultation fee (₹)</label><input name="feeRupees" type="number" min="100" max="100000" value="1000" /></div>
            <div class="field"><label>Session length</label><select name="sessionMinutes">${[15, 20, 30, 45, 60].map((m) => raw(`<option ${m === 30 ? 'selected' : ''} value="${m}">${m} min</option>`))}</select></div></div>
          <div class="row"><div class="field"><label>Office area (Mumbai)</label><select name="area">${places.map((p) => raw(h`<option>${p.name}</option>`))}</select></div>
            <div class="field"><label>Languages</label><input name="languages" value="English, Hindi" /><div class="hint">Comma separated</div></div></div>
          <div class="field"><label>Practice areas (up to 6)</label><div class="chips">${state.meta.specializations.map((s) => raw(h`<label class="check chip"><input type="checkbox" name="spec" value="${s.slug}" /> ${s.name}</label>`))}</div></div>
        </div>
        <div class="divider"></div>
        <div id="otp-step" class="hidden"><div class="field"><label>Verification code sent to your mobile</label><input name="otpCode" inputmode="numeric" maxlength="6" placeholder="6-digit code" /><div class="hint" id="otp-hint"></div></div></div>
        <button class="btn block" id="reg-btn">Send verification code</button>
        <p class="small muted" style="margin-top:10px">By continuing you agree to the Terms and Privacy Policy. We never ask for your Aadhaar number here.</p>
      </form>
      <p class="small">Already have an account? <a href="#/login">Sign in</a></p>
    </div></div>`;

  let curRole = role; let otpSent = false;
  $$('#role button').forEach((b) => b.addEventListener('click', () => {
    curRole = b.dataset.role; $$('#role button').forEach((x) => x.classList.toggle('on', x === b));
    $('#lawyer-fields').classList.toggle('hidden', curRole !== 'lawyer');
  }));
  const f = $('#reg');
  f.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = $('#reg-btn'); btn.disabled = true;
    try {
      if (!otpSent) {
        const r = await api('/auth/otp/request', { method: 'POST', body: { phone: f.phone.value } });
        otpSent = true; $('#otp-step').classList.remove('hidden'); btn.textContent = 'Verify & create account';
        if (r.devCode) { f.otpCode.value = r.devCode; $('#otp-hint').textContent = `Development mode: SMS isn't sent — your code is ${r.devCode} (also printed in the server log).`; }
        f.otpCode.focus(); return;
      }
      const body = { role: curRole, name: f.name.value, email: f.email.value, phone: f.phone.value, password: f.password.value, otpCode: f.otpCode.value };
      if (curRole === 'lawyer') Object.assign(body, {
        barCouncil: f.barCouncil.value, enrollmentNumber: f.enrollmentNumber.value, enrollmentYear: f.enrollmentYear.value || undefined,
        experienceYears: f.experienceYears.value, feeRupees: f.feeRupees.value, sessionMinutes: f.sessionMinutes.value, area: f.area.value,
        languages: f.languages.value.split(',').map((s) => s.trim()).filter(Boolean), specializations: $$('input[name=spec]:checked').map((c) => c.value),
      });
      const { user } = await api('/auth/register', { method: 'POST', body });
      afterAuth(user, params);
    } catch (err) { fail(err); } finally { btn.disabled = false; }
  });
}

// ------------------------------------------------------------------ lawyer workspace
async function viewWorkspace() {
  if (!requireLogin('lawyer')) return;
  loading();
  const [{ profile: p, stats }, { rules, blocks }, { bookings }] = await Promise.all([
    api('/lawyer/profile'), api('/lawyer/availability'), api('/bookings?scope=upcoming')]);
  const vs = p.verification_status;
  app.innerHTML = h`
    <h1>Workspace</h1>
    ${raw(vs !== 'verified' ? h`<div class="notice strong" style="margin-bottom:16px"><b>${vs === 'pending' ? 'Verification in progress.' : 'Verification was not approved.'}</b>
      ${vs === 'pending' ? 'Your profile is hidden from search until we confirm your Bar Council enrolment.' : (p.verification_note || '')}</div>` : '')}
    <div class="kpis">
      <div class="kpi glass"><b>${stats.upcoming}</b><span>Upcoming confirmed</span></div>
      <div class="kpi glass"><b>${stats.completed}</b><span>Completed</span></div>
      <div class="kpi glass"><b>${rupees(stats.earned_paise)}</b><span>Fees earned</span></div>
      <div class="kpi glass"><b>${p.rating_count ? p.rating_avg.toFixed(1) + ' ★' : '—'}</b><span>${p.rating_count} reviews</span></div>
    </div>
    <div class="grid-2">
      <div>
        <div class="card"><h2>Upcoming consultations</h2>
          ${raw(bookings.length ? bookings.slice(0, 8).map((b) => bookingRow(b, true)).join('') : '<p class="muted">No upcoming consultations.</p>')}
          ${raw(bookings.length > 8 ? '<a href="#/bookings" class="small">See all</a>' : '')}
        </div>
        <div class="card"><h2>Weekly hours</h2><p class="small muted">Clients can book ${p.session_minutes}-minute slots inside these windows (IST). Existing bookings aren't affected by changes.</p>
          <table class="week" id="week">${[1, 2, 3, 4, 5, 6, 0].map((d) => raw(h`<tr data-day="${d}"><td>${WEEKDAYS[d]}</td><td><div class="wins">${rules.filter((r) => r.weekday === d).map((r) => raw(winRow(r.start, r.end)))}</div>
            <button class="link small" data-add="${d}">+ Add hours</button></td></tr>`))}</table>
          <button class="btn" id="save-hours" style="margin-top:12px">Save hours</button>
        </div>
        <div class="card"><h2>Days off</h2>
          <form id="block" class="row" style="align-items:end"><div><label>Date</label><input type="date" name="day" required min="${istDay(Date.now())}" /></div>
            <div><label>Reason (private)</label><input name="reason" maxlength="120" placeholder="e.g. High Court hearing" /></div><div style="flex:0"><button class="btn">Block day</button></div></form>
          <div style="margin-top:10px">${raw(blocks.map((b) => h`<span class="chip" style="margin-right:6px">${b.day}${b.reason ? ` · ${b.reason}` : ''} <button class="link" data-unblock="${b.day}" aria-label="Remove">×</button></span>`).join('') || '<span class="small muted">No days blocked.</span>')}</div>
        </div>
      </div>
      <aside class="card glass"><h2>Public profile</h2>
        <form id="profile">
          <div class="field"><label>Headline</label><input name="headline" maxlength="140" value="${p.headline || ''}" /></div>
          <div class="field"><label>About</label><textarea name="bio" maxlength="3000" rows="6">${p.bio || ''}</textarea></div>
          <div class="row"><div class="field"><label>Fee (₹)</label><input name="feeRupees" type="number" min="100" max="100000" value="${p.fee_paise / 100}" /></div>
            <div class="field"><label>Session</label><select name="sessionMinutes">${[15, 20, 30, 45, 60].map((m) => raw(`<option value="${m}" ${m === p.session_minutes ? 'selected' : ''}>${m} min</option>`))}</select></div></div>
          <div class="field"><label>Years of practice</label><input name="experienceYears" type="number" min="0" max="70" value="${p.experience_years}" /></div>
          <div class="field"><label>Languages</label><input name="languages" value="${p.languages.join(', ')}" /></div>
          <div class="field"><label>Modes</label><div class="row">${Object.entries(MODE).map(([k, v]) => raw(h`<label class="check"><input type="checkbox" name="mode" value="${k}" ${p.modes.includes(k) ? 'checked' : ''}/> ${v}</label>`))}</div></div>
          <div class="field"><label>Office address</label><input name="officeAddress" maxlength="300" value="${p.office_address || ''}" /></div>
          <div class="field"><label>Practice areas</label><div class="chips">${state.meta.specializations.map((s) => raw(h`<label class="check chip"><input type="checkbox" name="spec" value="${s.slug}" ${p.specializations.includes(s.slug) ? 'checked' : ''}/> ${s.name}</label>`))}</div></div>
          <button class="btn block">Save profile</button>
          ${raw(vs === 'verified' ? h`<a class="small" href="#/lawyers/${p.user_id}" style="display:block;margin-top:10px;text-align:center">View public profile</a>` : '')}
        </form>
      </aside>
    </div>`;

  $$('[data-add]').forEach((b) => b.addEventListener('click', () => { $(`tr[data-day="${b.dataset.add}"] .wins`).insertAdjacentHTML('beforeend', winRow('10:00', '13:00')); bindWinRemove(); }));
  const bindWinRemove = () => $$('[data-rm]').forEach((b) => { b.onclick = () => b.closest('.window').remove(); });
  bindWinRemove();
  $('#save-hours').addEventListener('click', async () => {
    const out = [];
    $$('#week tr').forEach((tr) => $$('.window', tr).forEach((w) => { const [s, e] = $$('input', w); out.push({ weekday: Number(tr.dataset.day), start: s.value, end: e.value }); }));
    try { await api('/lawyer/availability', { method: 'PUT', body: { rules: out } }); toast('Hours saved.'); } catch (e) { fail(e); }
  });
  $('#block').addEventListener('submit', async (e) => {
    e.preventDefault(); const f = e.target;
    try { await api('/lawyer/blocks', { method: 'POST', body: { day: f.day.value, reason: f.reason.value || undefined } }); toast('Day blocked.'); render(); } catch (err) { fail(err); }
  });
  $$('[data-unblock]').forEach((b) => b.addEventListener('click', async () => { await api(`/lawyer/blocks/${b.dataset.unblock}`, { method: 'DELETE' }); render(); }));
  $('#profile').addEventListener('submit', async (e) => {
    e.preventDefault(); const f = e.target;
    try {
      await api('/lawyer/profile', { method: 'PUT', body: {
        headline: f.headline.value, bio: f.bio.value, feeRupees: f.feeRupees.value, sessionMinutes: f.sessionMinutes.value,
        experienceYears: f.experienceYears.value, officeAddress: f.officeAddress.value,
        languages: f.languages.value.split(',').map((s) => s.trim()).filter(Boolean),
        modes: $$('input[name=mode]:checked', f).map((c) => c.value), specializations: $$('input[name=spec]:checked', f).map((c) => c.value),
      } });
      toast('Profile saved.');
    } catch (err) { fail(err); }
  });
}
const winRow = (s, e) => h`<div class="window"><input type="time" value="${s}" step="900" /> to <input type="time" value="${e}" step="900" /><button class="link small" data-rm>Remove</button></div>`;

// ------------------------------------------------------------------ admin
async function viewAdmin({ params }) {
  if (!requireLogin('admin')) return;
  const status = params.get('status') || 'pending';
  loading();
  const [{ stats }, { lawyers }] = await Promise.all([api('/admin/stats'), api(`/admin/lawyers?status=${status}`)]);
  app.innerHTML = h`
    <h1>Admin</h1>
    <div class="kpis">
      <div class="kpi glass"><b>${stats.verified_lawyers}</b><span>Verified lawyers</span></div>
      <div class="kpi glass"><b>${stats.pending_lawyers}</b><span>Awaiting verification</span></div>
      <div class="kpi glass"><b>${stats.clients}</b><span>Clients</span></div>
      <div class="kpi glass"><b>${stats.confirmed_bookings}</b><span>Confirmed bookings</span></div>
      <div class="kpi glass"><b>${rupees(stats.gmv_paise)}</b><span>Net payments</span></div>
    </div>
    <h2>Lawyer verification</h2>
    <p class="small muted">Check each enrolment number against the State Bar Council roll before approving. Decisions are recorded in the audit log.</p>
    <div class="tabs">${['pending', 'verified', 'rejected'].map((s) => raw(h`<button data-s="${s}" class="${s === status ? 'on' : ''}">${s[0].toUpperCase() + s.slice(1)}</button>`))}</div>
    ${raw(lawyers.length ? h`<div class="table-wrap"><table class="compare"><tr><th style="width:auto">Lawyer</th><th style="width:auto">Enrolment</th><th style="width:auto">Contact</th><th style="width:auto">Identity</th><th style="width:auto"></th></tr>
      ${lawyers.map((l) => raw(h`<tr><td><b>${l.name}</b><div class="small muted">${l.area || ''}, ${l.city} · ${l.experience_years} yrs</div></td>
        <td><span class="mono">${l.enrollment_number}</span><div class="small muted">${l.bar_council}${l.enrollment_year ? ` · ${l.enrollment_year}` : ''}</div></td>
        <td class="small">${l.email}<br>${l.phone}</td><td><span class="pill ${l.kyc_status === 'verified' ? 'solid' : 'dim'}">${l.kyc_status.replace('_', ' ')}</span></td>
        <td>${raw(status === 'pending' ? h`<div class="row" style="flex-wrap:nowrap"><button class="btn sm" data-v="${l.id}" data-d="verified">Approve</button><button class="btn ghost sm" data-v="${l.id}" data-d="rejected">Reject</button></div>` : h`<span class="small muted">${l.verification_note || ''}</span>`)}</td></tr>`))}
      </table></div>` : '<div class="empty">Nothing here.</div>')}`;
  $$('.tabs button').forEach((b) => b.addEventListener('click', () => go(`#/admin?status=${b.dataset.s}`)));
  $$('[data-v]').forEach((b) => b.addEventListener('click', async () => {
    const note = b.dataset.d === 'rejected' ? prompt('Reason shown to the lawyer:') : '';
    if (note === null) return;
    try { await api(`/admin/lawyers/${b.dataset.v}/verification`, { method: 'POST', body: { decision: b.dataset.d, note: note || undefined } }); toast(`Lawyer ${b.dataset.d}.`); render(); }
    catch (e) { fail(e); }
  }));
}

// ------------------------------------------------------------------ marketing pages
const FAQ = [
  ['How much does a consultation cost?', 'Each advocate sets their own fee for a fixed session length, shown on their profile and in search results. LawyerUp adds a 10% service fee, and the total is shown before you pay. There is nothing else to pay for the consultation itself.'],
  ['How do I know a lawyer is genuine?', 'Before a profile goes live, our team checks the advocate\'s enrolment number with their State Bar Council. Only verified advocates appear in search.'],
  ['What happens after I book?', 'You get a confirmation straight away. For video consultations a private meeting link appears in your booking; for phone consultations the lawyer calls your registered number; for in-person meetings you\'ll see the office address. You can message your lawyer once the booking is confirmed.'],
  ['Can I cancel?', 'Yes. Cancel at least 4 hours before the start for a full refund, or later for a 50% refund. If your lawyer cancels, you always get a full refund.'],
  ['Should I share documents or ID?', 'Not on LawyerUp at this stage. Keep the topic you enter general, and share confidential documents only through a channel your lawyer confirms. We never ask for your Aadhaar number.'],
  ['Is a consultation the same as hiring a lawyer?', 'No. A consultation is a paid session to understand your situation and options. If you decide to engage the advocate further, you agree terms with them directly.'],
];
const faqList = (items = FAQ) => h`<div class="faq">${items.map(([q, a]) => raw(h`<details><summary>${q}</summary><p>${a}</p></details>`))}</div>`;

function policyList() {
  const m = state.meta;
  return h`<ul class="policy">
    <li><b>${m.freeCancelHours}+ hours before</b><span>Cancel for a full refund.</span></li>
    <li><b>Within ${m.freeCancelHours} hours</b><span>Cancel for a 50% refund.</span></li>
    <li><b>Lawyer cancels</b><span>Full refund, always.</span></li>
    <li><b>While you pay</b><span>Your time slot is held for ${m.bookingHoldMinutes} minutes so nobody else can take it.</span></li>
  </ul>`;
}

function receipt(l) {
  return h`<div class="receipt" aria-label="Example fee breakdown">
    <div class="small muted" style="margin-bottom:6px">${l ? `${l.name}, ${l.session_minutes}-minute consultation` : 'Example consultation'}</div>
    <div class="line"><span>Consultation fee</span><span class="num">${rupees(l?.price.fee_paise ?? 150000)}</span></div>
    <div class="line"><span>LawyerUp service fee (${state.meta.platformFeePercent}%)</span><span class="num">${rupees(l?.price.platform_fee_paise ?? 15000)}</span></div>
    <div class="total"><span>You pay</span><b class="num">${rupees(l?.price.total_paise ?? 165000)}</b></div>
  </div>`;
}

function stepsBlock(steps) {
  return h`<div class="steps">${steps.map(([t, d]) => raw(h`<div class="step glass"><h3>${t}</h3><p>${d}</p></div>`))}</div>`;
}
const CLIENT_STEPS = [
  ['Search near you', 'Enter your area and what the problem is about. You\'ll see verified advocates nearby with their fee, experience and languages.'],
  ['Compare and choose a time', 'Put up to three lawyers side by side, then pick an open slot for a video call, phone call or office visit.'],
  ['Pay and talk', 'Pay the fee shown and your booking is confirmed. Message your lawyer before the session if you need to.'],
];

async function viewHome() {
  const m = state.meta;
  const [{ places }, top] = await Promise.all([
    api(`/places?city=${m.defaultCity}`),
    api(`/lawyers?city=${m.defaultCity}&radiusKm=50&sort=rating`).catch(() => ({ lawyers: [] })),
  ]);
  const featured = top.lawyers.slice(0, 3);
  const hero = top.lawyers.find((l) => l.modes.includes('video') && l.fee_paise <= 200000) || featured[0];
  const specs = m.specializations.filter((s) => s.lawyer_count > 0);

  app.innerHTML = h`
    <section class="hero"><div class="wrap hero-grid">
      <div>
        <h1 class="display">Talk to the right lawyer. Know the fee first.</h1>
        <p class="lede">LawyerUp lists verified advocates across Mumbai with their fee, session length and open times, so you can book a consultation in a few minutes.</p>
        <form class="hero-search glass" id="hero-search" autocomplete="off">
          <label class="field-inline"><span>Area</span><input name="area" list="hero-places" placeholder="e.g. Bandra West" /></label>
          <datalist id="hero-places">${places.map((p) => raw(h`<option value="${p.name}">`))}</datalist>
          <label class="field-inline"><span>Your issue</span><select name="specialization"><option value="">Any area of law</option>${specs.map((s) => raw(h`<option value="${s.slug}">${s.name}</option>`))}</select></label>
          <button class="btn">Find lawyers</button>
        </form>
        <div class="hero-note">
          <span>${raw(ICON.shield)}Bar Council enrolment checked</span>
          <span>${raw(ICON.receipt)}Fee shown before you pay</span>
          <span>${raw(ICON.clock)}Free cancellation up to ${m.freeCancelHours} hours before</span>
        </div>
      </div>
      ${raw(hero ? h`<div class="fee-stack">
        <div class="ghost-card glass" aria-hidden="true"></div>
        <a class="fee-card glass" href="#/lawyers/${hero.id}" style="display:block;text-decoration:none" aria-label="View ${hero.name}">
          <div class="who"><div class="avatar">${initials(hero.name)}</div>
            <div><b>${hero.name}</b><span class="small muted">${hero.area}, ${hero.experience_years} years in practice</span></div></div>
          ${verifiedBadge()}
          <div class="slot-preview" id="hero-slots"><span>&nbsp;</span><span>&nbsp;</span><span>&nbsp;</span></div>
          <div class="small muted">${hero.session_minutes}-minute ${MODE.video.toLowerCase()}</div>
          <div class="fee-figure">${rupees(hero.price.total_paise)}</div>
          <div class="caption">${rupees(hero.price.fee_paise)} consultation fee plus ${rupees(hero.price.platform_fee_paise)} service fee. Nothing added at checkout.</div>
        </a></div>` : '')}
    </div></section>

    <section class="section"><div class="wrap">
      <div class="section-head"><h2>What do you need help with?</h2>
        <p>Choose an area of law to see the advocates who practise it, nearest first.</p></div>
      <nav class="areas" aria-label="Areas of law">${specs.map((s) => raw(h`<a href="#/find?specialization=${s.slug}">${s.name}<span>${s.lawyer_count} ${s.lawyer_count === 1 ? 'lawyer' : 'lawyers'}</span></a>`))}</nav>
    </div></section>

    <section class="section" style="padding-top:0"><div class="wrap">
      <div class="section-head"><h2>Three steps to a consultation</h2><p>No calls to an office to ask about fees, and no waiting for someone to get back to you.</p></div>
      ${raw(stepsBlock(CLIENT_STEPS))}
    </div></section>

    <section class="section" style="padding-top:0"><div class="wrap">
      <div class="fees-panel glass">
        <div><h2>The fee you see is the fee you pay.</h2>
          <p class="lede" style="font-size:17px">Every advocate sets their own price for a fixed session. We add a ${m.platformFeePercent}% service fee and show the total before you pay.</p>
          ${raw(policyList())}</div>
        ${raw(receipt(hero))}
      </div>
    </div></section>

    ${raw(featured.length ? h`<section class="section" style="padding-top:0"><div class="wrap">
      <div class="section-link"><h2>Highly rated in Mumbai</h2><a class="text-link" href="#/find?sort=rating">See all ${m.counts.lawyers} lawyers</a></div>
      <div class="featured">${featured.map((l) => raw(h`<a class="feature glass" href="#/lawyers/${l.id}">
        <div class="top"><div class="avatar">${initials(l.name)}</div><div><b>${l.name}</b><span class="small muted">${l.area}</span></div></div>
        <p class="small" style="margin:0">${l.headline || ''}</p>
        <div class="chips">${l.specializations.slice(0, 2).map((s) => raw(h`<span class="chip">${s.name}</span>`))}</div>
        <div class="foot"><span class="small">${l.rating_count ? `${l.rating_avg.toFixed(1)} ★  ${l.rating_count} reviews` : 'New'}</span><span><b>${rupees(l.fee_paise)}</b> <span class="small muted">/ ${l.session_minutes} min</span></span></div>
      </a>`))}</div>
    </div></section>` : '')}

    <section class="section" style="padding-top:0"><div class="wrap trust">
      <div>${raw(ICON.shield)}<h3>Checked advocates</h3><p>Before a profile goes live, we confirm the advocate's enrolment with their State Bar Council.</p></div>
      <div>${raw(ICON.lock)}<h3>Private by default</h3><p>We never ask for your Aadhaar number. Messages are visible only to you and your lawyer.</p></div>
      <div>${raw(ICON.receipt)}<h3>No surprises</h3><p>The total is shown before you pay, refunds follow a clear policy, and lawyer cancellations are always refunded in full.</p></div>
    </div></section>

    <section class="section" style="padding-top:0"><div class="wrap">
      <div class="band dark"><div><h2>Are you an advocate?</h2>
        <p style="font-size:17px;max-width:32em;margin:0">Set your fee, your hours and how you consult. Clients book and pay upfront, and you keep your full consultation fee.</p></div>
        <div class="row" style="flex:0 0 auto"><a class="btn lg" href="#/register?role=lawyer">Create a lawyer profile</a><a class="btn lg ghost" href="#/for-lawyers">Learn more</a></div>
      </div>
    </div></section>

    <section class="section" style="padding-top:0"><div class="wrap">
      <div class="section-head"><h2>Questions people ask</h2><p>More answers in <a href="#/help">Help</a>.</p></div>
      ${raw(faqList(FAQ.slice(0, 4)))}
    </div></section>`;

  $('#hero-search').addEventListener('submit', (e) => {
    e.preventDefault();
    const p = new URLSearchParams();
    for (const [k, v] of new FormData(e.target)) if (v) p.set(k, v);
    go(`#/find${p.toString() ? `?${p}` : ''}`);
  });

  if (hero) {
    // Fill the hero card with the lawyer's next real open times.
    for (let i = 0; i < 7; i++) {
      const { slots } = await api(`/lawyers/${hero.id}/slots?date=${istDay(Date.now() + i * 86_400_000)}`);
      const open = slots.filter((x) => x.available).slice(0, 3);
      if (open.length) {
        const el = $('#hero-slots'); if (!el) return;
        el.innerHTML = open.map((x, j) => h`<span class="${j === 0 ? 'on' : ''}">${fmt(x.startsAt, { weekday: 'short' })} ${fmtTime(x.startsAt)}</span>`).join('');
        break;
      }
    }
  }
}

function viewHow({ params }) {
  app.innerHTML = h`
    <div class="wrap">
      <section class="page-hero" style="padding-top:140px"><h1 class="display">How LawyerUp works</h1>
        <p class="lede">From a search to a confirmed consultation in a few minutes, with the price clear at every step.</p></section>
      ${raw(stepsBlock(CLIENT_STEPS))}
      <section class="section" id="fees"><div class="fees-panel glass">
        <div><h2>Fees and refunds</h2>
          <p class="lede" style="font-size:17px">Advocates set their own fee for a fixed session length. LawyerUp adds a ${state.meta.platformFeePercent}% service fee, and you see the total before you pay.</p>
          ${raw(policyList())}</div>
        ${raw(receipt(null))}
      </div></section>
      <section class="section" style="padding-top:0">
        <div class="section-head"><h2>During your consultation</h2><p>What to expect for each way of meeting.</p></div>
        <div class="trust">
          <div><h3>Video call</h3><p>A private meeting link appears in your booking once it's confirmed. Join from your phone or computer at the scheduled time.</p></div>
          <div><h3>Phone call</h3><p>Your lawyer calls the mobile number you registered with, at the time you booked.</p></div>
          <div><h3>In person</h3><p>The office address is in your booking. Arrive a few minutes early with any papers your lawyer asked for.</p></div>
        </div>
      </section>
      <section class="section" style="padding-top:0"><div class="section-head"><h2>Common questions</h2><p></p></div>${raw(faqList())}</section>
      <div class="band glass" style="margin-bottom:40px"><div><h2>Ready when you are</h2><p class="muted" style="margin:0">Search verified advocates near you.</p></div><a class="btn lg" href="#/find">Find a lawyer</a></div>
    </div>`;
  if (params.get('s')) setTimeout(() => document.getElementById(params.get('s'))?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 60);
}

function viewForLawyers() {
  const m = state.meta;
  app.innerHTML = h`
    <div class="wrap">
      <section class="page-hero" style="padding-top:140px"><h1 class="display">Practise on your own terms.</h1>
        <p class="lede">Reach clients in your city who are ready to book. You set the fee, the hours and how you consult. They pay before the session.</p>
        <div class="row" style="max-width:460px;margin-top:8px"><a class="btn lg" href="#/register?role=lawyer">Create a lawyer profile</a><a class="btn lg ghost" href="#/login">Sign in</a></div></section>
      <section class="section" style="padding-top:20px"><div class="trust">
        <div>${raw(ICON.receipt)}<h3>Keep your full fee</h3><p>Clients pay a ${m.platformFeePercent}% service fee on top of your price. Your consultation fee is yours.</p></div>
        <div>${raw(ICON.clock)}<h3>Your calendar</h3><p>Publish weekly hours, block court days, and choose 15 to 60-minute sessions. Double bookings can't happen.</p></div>
        <div>${raw(ICON.shield)}<h3>Paid before you start</h3><p>Every booking is paid upfront. If a client cancels late, you're still compensated under the refund policy.</p></div>
      </div></section>
      <section class="section" style="padding-top:0">
        <div class="section-head"><h2>Going live</h2><p>Most profiles are reviewed within two working days.</p></div>
        ${raw(stepsBlock([
          ['Create your profile', 'Add your enrolment details, practice areas, languages, fee and office area.'],
          ['We verify your enrolment', 'Our team checks your enrolment number against your State Bar Council roll.'],
          ['Start taking bookings', 'Your profile appears in search. Manage consultations, hours and messages from your workspace.'],
        ]))}
      </section>
      <div class="band dark" style="margin-bottom:40px"><div><h2>Join the first advocates in Mumbai</h2><p style="font-size:17px;margin:0">It takes about five minutes to set up.</p></div><a class="btn lg" href="#/register?role=lawyer">Create a lawyer profile</a></div>
    </div>`;
}

function prosePage(title, lede, body, draft = false) {
  app.innerHTML = h`<div class="wrap">
    <section class="page-hero" style="padding-top:140px;padding-bottom:24px"><h1 class="display">${title}</h1>${raw(lede ? h`<p class="lede">${lede}</p>` : '')}</section>
    ${raw(draft ? '<div class="notice draft-note prose">Draft for the development build. This text must be reviewed by counsel before launch.</div>' : '')}
    <article class="prose" style="padding-bottom:80px">${raw(body)}</article></div>`;
}

const viewAbout = () => prosePage('Legal help should be easy to find.', 'LawyerUp started with a simple frustration: finding a good lawyer usually means asking around, calling offices and never quite knowing what a first conversation will cost.', `
  <p>We list verified advocates with the things you need to decide: what they practise, where they are, which languages they speak and exactly what a consultation costs. You can compare them side by side and book an open time straight away.</p>
  <h2>Starting in Mumbai</h2><p>We're launching with advocates across Mumbai, Thane and Navi Mumbai, and expanding to other Indian cities next.</p>
  <h2>What we don't do</h2><p>LawyerUp is not a law firm and doesn't give legal advice. Advocates on LawyerUp are independent professionals, and the advice you receive comes from them.</p>`);

const viewHelp = () => {
  app.innerHTML = h`<div class="wrap"><section class="page-hero" style="padding-top:140px"><h1 class="display">Help</h1><p class="lede">Answers to common questions about booking, fees and privacy.</p></section>${raw(faqList())}
    <div class="notice" style="margin:40px 0 80px;max-width:860px">Can't find what you need? Write to support@lawyerup.dev and include your booking date if it's about a consultation.</div></div>`;
};

const viewPrivacy = () => prosePage('Privacy', 'How LawyerUp handles your information.', `
  <h2>What we collect</h2><ul><li>Your name, email address and mobile number, to create your account.</li><li>Your bookings, payments and the messages you exchange with your lawyer.</li><li>For advocates: enrolment details and profile information you choose to publish.</li></ul>
  <h2>What we don't collect</h2><p>We never ask for your Aadhaar number, and we don't store card details. Identity checks and payments are handled by licensed partners who give us only a confirmation.</p>
  <h2>Who can see your messages</h2><p>Only you and the lawyer you booked. LawyerUp staff can't read consultation messages.</p>
  <h2>Your choices</h2><p>You can ask us to export or delete your account data at any time by writing to privacy@lawyerup.dev.</p>`, true);

const viewTerms = () => prosePage('Terms', 'The basics of using LawyerUp.', `
  <h2>Consultations</h2><p>A consultation is a paid session with an independent advocate. LawyerUp provides the booking service and doesn't give legal advice.</p>
  <h2>Fees and refunds</h2><p>You pay the advocate's fee plus a ${state.meta.platformFeePercent}% service fee when you book. Cancel at least ${state.meta.freeCancelHours} hours before the start for a full refund, or later for a 50% refund. If the advocate cancels, you get a full refund.</p>
  <h2>Advocates</h2><p>Advocates must hold a valid enrolment with a State Bar Council and keep their profile accurate. Profiles are verified before they appear in search.</p>
  <h2>Acceptable use</h2><p>Don't misuse the service, impersonate others, or share content that is unlawful or harmful.</p>`, true);

// ------------------------------------------------------------------ router
const MARKETING = new Set(['/', '/how-it-works', '/for-lawyers', '/about', '/help', '/privacy', '/terms']);
const routes = [
  [/^\/$/, viewHome], [/^\/find$/, viewSearch], [/^\/how-it-works$/, viewHow], [/^\/for-lawyers$/, viewForLawyers],
  [/^\/about$/, viewAbout], [/^\/help$/, viewHelp], [/^\/privacy$/, viewPrivacy], [/^\/terms$/, viewTerms], [/^\/compare$/, viewCompare], [/^\/lawyers\/[\w-]+$/, viewLawyer], [/^\/checkout\/[\w-]+$/, viewCheckout],
  [/^\/bookings$/, viewBookings], [/^\/bookings\/[\w-]+$/, viewBooking], [/^\/login$/, viewLogin], [/^\/register$/, viewRegister],
  [/^\/workspace$/, viewWorkspace], [/^\/admin$/, viewAdmin],
];

async function render() {
  state.timers.forEach(clearInterval); state.timers = [];
  $('#nav').classList.remove('open'); $('.menu-toggle').setAttribute('aria-expanded', 'false');
  const route = parseHash();
  const marketing = MARKETING.has(route.path);
  app.className = marketing ? 'wide' : '';
  document.body.classList.toggle('app-page', !marketing);
  renderNav();
  if (!route.path.match(/^\/find$/)) $('.compare-tray')?.remove();
  const view = routes.find(([re]) => re.test(route.path))?.[1];
  if (!view) { app.innerHTML = '<div class="empty">Page not found. <a href="#/">Go home</a></div>'; return; }
  try { await view(route); } catch (e) {
    if (e.status === 401) { state.me = null; return go(`#/login?next=${encodeURIComponent(location.hash)}`); }
    app.innerHTML = h`<div class="empty">${e.message}</div>`;
  }
  window.scrollTo(0, 0);
}

(async function boot() {
  try {
    const [meta, me] = await Promise.all([api('/meta'), api('/auth/me')]);
    state.meta = meta; state.me = me.user;
  } catch {
    app.innerHTML = '<div class="empty">Can\'t reach the LawyerUp server. Is it running? (<span class="mono">npm run dev</span>)</div>';
    return;
  }
  renderFooter(); renderDemoChip();
  window.addEventListener('hashchange', render);
  document.addEventListener('click', (e) => { if (e.target.closest('[data-back]')) { e.preventDefault(); history.length > 1 ? history.back() : go('#/find'); } });
  render();
})();
