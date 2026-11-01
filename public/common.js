// Shared helpers for player, board and host pages.

const Game = {
  offset: 0, // serverNow - clientNow
  state: null,

  now() {
    return Date.now() + this.offset;
  },

  // True when `s` differs from the last state seen (ignoring the server clock),
  // so pages only redraw when something actually changed.
  lastSig: null,
  isNew(s) {
    const { serverNow, ...rest } = s;
    const sig = JSON.stringify(rest);
    if (sig === this.lastSig) return false;
    this.lastSig = sig;
    return true;
  },

  async api(path, { method = 'GET', body, headers = {} } = {}) {
    const res = await fetch(path, {
      method,
      headers: { 'Content-Type': 'application/json', ...headers },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(data.error || `Request failed (${res.status})`), { status: res.status });
    return data;
  },

  // Polls the server every 2 s, and right away when the tab becomes visible
  // (browsers slow timers down in hidden tabs). Short requests (instead of a held-open push
  // connection) matter: browsers allow only ~6 open connections per server, so
  // a few open game tabs would otherwise starve the TV board. `apply` runs only
  // for the newest response, so a slow, older answer never overwrites a newer one.
  live(fetchState, apply = () => {}) {
    let latest = 0;
    let inFlight = false;
    const run = async () => {
      if (inFlight) return;
      inFlight = true;
      const mine = ++latest;
      try {
        const s = await fetchState();
        if (mine !== latest || !s) return;
        if (s.serverNow) this.offset = s.serverNow - Date.now();
        if (!this.isNew(s)) return;
        this.state = s;
        apply(s);
      } catch (err) {
        console.error(err);
      } finally {
        inFlight = false;
      }
    };
    document.addEventListener('visibilitychange', () => !document.hidden && run());
    setInterval(run, 2000);
    run();
    return run;
  },
};

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

function fmtCountdown(ms) {
  if (ms == null) return '—';
  const total = Math.max(0, Math.ceil(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function fmtTime(ts) {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

// Describes the update clock in one short line, e.g. "New evidence in 4:12".
function updateClock(c, phase) {
  if (!c) return '';
  if (phase === 'lastcall') return `Last call! Reveal in ${fmtCountdown(c.lastCallEndsAt - Game.now())}`;
  if (phase === 'revealed' || phase === 'finished') return 'Case closed';
  if (c.paused) return `Paused${c.pausedRemaining != null ? ` · evidence in ${fmtCountdown(c.pausedRemaining)}` : ''}`;
  if (c.nextUpdateAt) return `New evidence in ${fmtCountdown(c.nextUpdateAt - Game.now())}`;
  return 'All evidence is out. Solve it!';
}

function traitValue(v) {
  if (v === true) return '✓';
  if (v === false || v == null) return '–';
  return esc(v);
}

// Murdle-style dossier: one table per category listing every option's traits.
function dossierHtml(categories) {
  return categories
    .map((cat) => {
      const traits = (cat.traits || []).filter((t) => !t.visual);
      return `<table class="dossier"><thead><tr><th>${esc(cat.label)}</th>${traits.map((t) => `<th>${esc(t.label)}</th>`).join('')}</tr></thead>
        <tbody>${cat.options
          .map((o) => `<tr><td class="who-cell">${o.image ? `<img class="thumb" src="${esc(o.image)}" alt="" data-zoom="${esc(o.image)}">` : ''}
            <div><b>${esc(o.name)}</b>${o.desc ? `<br><small>${esc(o.desc)}</small>` : ''}</div></td>
            ${traits.map((t) => `<td>${traitValue((o.traits || {})[t.key])}</td>`).join('')}</tr>`)
          .join('')}</tbody></table>`;
    })
    .join('');
}

function hue(text) {
  let h = 0;
  for (const ch of text) h = (h * 31 + ch.codePointAt(0)) % 360;
  return h;
}

// Card picture: the option's own `image` if it has one, otherwise a generated
// cameo (a silhouette for suspects, a big icon for everything else).
function portraitHtml(o, isSuspect, uid) {
  if (o.image) {
    const focus = o.focus ? ` style="object-position:${esc(o.focus)}"` : '';
    return `<img class="portrait" src="${esc(o.image)}" alt=""${focus}>`;
  }
  const h = hue(o.id + o.name);
  const bg = `<defs><radialGradient id="bg-${uid}" cx="50%" cy="40%" r="70%">
      <stop offset="0" stop-color="hsl(${h} 45% 30%)"/><stop offset="1" stop-color="hsl(${h} 45% 9%)"/></radialGradient></defs>
    <rect width="100" height="120" fill="url(#bg-${uid})"/>
    <ellipse cx="50" cy="58" rx="40" ry="49" fill="none" stroke="#c9a24a" stroke-width="1.5" opacity=".8"/>`;
  const figure = isSuspect
    ? `<path d="M16 120 C18 94 32 86 50 86 C68 86 82 94 84 120 Z" fill="#0b0710"/>
       <rect x="44" y="70" width="12" height="18" fill="#0b0710"/>
       <ellipse cx="50" cy="58" rx="15" ry="18" fill="#0b0710"/>`
    : '';
  return `<div class="portrait">
    <svg viewBox="0 0 100 120" preserveAspectRatio="xMidYMid slice" aria-hidden="true">${bg}${figure}</svg>
    ${o.icon ? `<span class="${isSuspect ? 'badge' : 'emblem'}">${esc(o.icon)}</span>` : ''}
  </div>`;
}

// Flip cards: picture and name on the front, traits and backstory on the back.
// `flipped` is a Set of card keys so flips survive redraws.
function characterCardsHtml(categories, flipped, prefix) {
  return categories
    .map((cat, ci) => `<h3 class="cards-title">${esc(cat.label)}</h3><div class="cards ${ci === 0 ? 'suspects' : ''}">${cat.options
      .map((o) => {
        const key = `${prefix}:${cat.key}:${o.id}`;
        const hasVisual = (cat.traits || []).some((t) => t.visual);
        const traits = (cat.traits || []).filter((t) => !t.visual).map((t) => `<li><span>${esc(t.label)}</span><b>${traitValue((o.traits || {})[t.key])}</b></li>`).join('');
        return `<button class="flip ${flipped.has(key) ? 'flipped' : ''}" data-flip="${esc(key)}" aria-label="${esc(o.name)}: show ${flipped.has(key) ? 'picture' : 'details'}">
          <div class="flip-inner">
            <div class="face front">
              ${portraitHtml(o, ci === 0, key.replace(/[^a-z0-9]/gi, '-'))}
              <div class="caption"><b>${esc(o.name)}</b>${o.desc ? `<small>${esc(o.desc)}</small>` : ''}</div>
              <span class="turn" aria-hidden="true">↻</span>
              ${o.image ? `<span class="zoom" data-zoom="${esc(o.image)}" title="Look closer">🔍</span>` : ''}
            </div>
            <div class="face back">
              <b class="back-name">${esc(o.name)}</b>
              ${traits ? `<ul class="traits">${traits}</ul>` : ''}
              ${o.horoscope ? `<p class="horoscope"><span>✨ Tonight's horoscope</span>${esc(o.horoscope)}</p>` : ''}
              ${o.bio ? `<p class="bio">${esc(o.bio)}</p>` : ''}
              ${hasVisual ? '<p class="look">🔍 Some clues describe what you can see in the portrait. Look closely.</p>' : ''}
            </div>
          </div>
        </button>`;
      })
      .join('')}</div>`)
    .join('');
}

// One update: its public clues plus who received secret evidence.
// The public clues of an update (everyone sees them) and who got secret evidence with it.
// The secret texts themselves are never shown here, only the names. Pass `me` (the
// player's name) on a phone so their own share reads "you".
function updateHtml(u, me) {
  const others = u.receivers.filter((n) => n !== me);
  const mine = me && u.receivers.includes(me);
  const names = others.map((n) => `<b>${esc(n)}</b>`).join(', ');
  let note = '';
  if (mine && others.length) note = `<b>You</b> and ${names} received secret evidence – yours is in your Clues tab, ask them about theirs!`;
  else if (mine) note = '<b>You</b> received secret evidence. Check your Clues tab.';
  else if (others.length) note = `${names} received secret evidence – ask them about it!`;
  return `<li><span class="n">Update ${u.number}</span>
    ${u.clues.length ? `<div class="label">📢 For everyone</div>` : ''}
    ${u.clues.map((t) => `<div>${esc(t)}</div>`).join('')}
    ${note ? `<div class="secret-note">${note}</div>` : ''}</li>`;
}

function leaderboardHtml(rows, { meId, limit } = {}) {
  if (!rows.length) return '<p class="muted">No players yet.</p>';
  const medals = ['🥇', '🥈', '🥉'];
  return `<ol class="leaderboard">${rows
    .slice(0, limit || rows.length)
    .map(
      (p, i) => `<li class="${p.id === meId ? 'me' : ''}">
        <span class="rank">${medals[i] || i + 1}</span>
        <span class="who"><b>${esc(p.name)}</b>${p.costume ? `<small>${esc(p.costume)}</small>` : ''}</span>
        <span class="score">${p.score}</span>
      </li>`
    )
    .join('')}</ol>`;
}

function toast(text, kind = '') {
  let box = document.getElementById('toasts');
  if (!box) {
    box = document.createElement('div');
    box.id = 'toasts';
    document.body.appendChild(box);
  }
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = text;
  box.appendChild(el);
  setTimeout(() => el.classList.add('out'), 5000);
  setTimeout(() => el.remove(), 5600);
}
