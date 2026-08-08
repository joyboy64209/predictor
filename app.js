/* =========================================================
   VELOCITY SPORTS — Application Logic
   Three-Layer Architecture:
   1. DataFetcher    -> API proxy + localStorage caching
   2. PredictionEngine -> Client-side heuristic models
   3. UIRenderer     -> DOM rendering & interactions
   ========================================================= */

'use strict';

/* ---------------- Config ---------------- */
const CONFIG = {
  PROXY: '/api/football',
  CACHE_TTL: 2 * 60 * 1000, // 2 minutes for live data
  THRESHOLD: 75,
  DEFAULT_LEAGUE: 'PL',
  COMPETITIONS: [
    { code: 'PL', name: 'Premier League' },
    { code: 'PD', name: 'La Liga' },
    { code: 'SA', name: 'Serie A' },
    { code: 'BL1', name: 'Bundesliga' },
    { code: 'FL1', name: 'Ligue 1' },
    { code: 'CL', name: 'Champions League' }
  ]
};

/* ---------------- Utilities ---------------- */
function $(sel) {
  return document.querySelector(sel);
}

function el(tag, cls, text) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text) node.textContent = text;
  return node;
}

function fmtTime(iso) {
  if (!iso) return '--:--';
  const d = new Date(iso);
  if (isNaN(d)) return '--:--';
  return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

function clampPct(n) {
  return Math.max(0, Math.min(100, Math.round(n)));
}

/* =========================================================
   LAYER 1 — DataFetcher
   ========================================================= */
class DataFetcher {
  constructor(proxy) {
    this.proxy = proxy;
  }

  async getLiveMatches() {
    const key = 'vs_live_matches';
    const cached = this._readCache(key);
    if (cached) return cached;

    const data = await this._fetch('/matches?status=LIVE&limit=50');
    this._writeCache(key, data);
    return data;
  }

  async getStandings(leagueCode) {
    const key = `vs_standings_${leagueCode}`;
    const cached = this._readCache(key);
    if (cached) return cached;

    const data = await this._fetch(`/competitions/${leagueCode}/standings`);
    this._writeCache(key, data);
    return data;
  }

  async getTeamForm(teamId) {
    const key = `vs_form_${teamId}`;
    const cached = this._readCache(key);
    if (cached) return cached;

    const data = await this._fetch(`/teams/${teamId}/matches?status=FINISHED&limit=10`);
    this._writeCache(key, data);
    return data;
  }

  async _fetch(path) {
    const url = this.proxy + path;
    console.log(`[DataFetcher] Fetching: ${url}`);
    
    let res;
    try {
      res = await fetch(url, {
        method: 'GET',
        headers: { 'Accept': 'application/json' }
      });
    } catch (networkErr) {
      console.error('[DataFetcher] Network error:', networkErr);
      throw new Error(`Cannot reach proxy at ${url}. Are you running "npx vercel dev"? If opening index.html directly, the proxy won't work — use a local server.`);
    }

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`HTTP ${res.status} ${res.statusText}${text ? ': ' + text.slice(0, 200) : ''}`);
    }

    return res.json();
  }

  _readCache(key) {
    try {
      const raw = localStorage.getItem(key);
      if (!raw) return null;
      const { ts, data } = JSON.parse(raw);
      if (Date.now() - ts > CONFIG.CACHE_TTL) {
        localStorage.removeItem(key);
        return null;
      }
      return data;
    } catch {
      return null;
    }
  }

  _writeCache(key, data) {
    try {
      localStorage.setItem(key, JSON.stringify({ ts: Date.now(), data }));
    } catch {
      // Storage full or unavailable
    }
  }
}

/* =========================================================
   LAYER 2 — PredictionEngine
   ========================================================= */
class PredictionEngine {
  constructor(threshold) {
    this.threshold = threshold;
  }

  analyze(match, standings, teamForms) {
    const home = this._teamStat(match.homeTeam.id, standings);
    const away = this._teamStat(match.awayTeam.id, standings);
    const hForm = this._formScore(teamForms[match.homeTeam.id]);
    const aForm = this._formScore(teamForms[match.awayTeam.id]);

    const strength = this._strength(home, away, hForm, aForm);
    const markets = this._markets(strength);
    const qualified = [];
    markets.forEach((mkt) => {
      mkt.picks.forEach((pick) => {
        if (pick.prob >= this.threshold) {
          qualified.push({ market: mkt, pick });
        }
      });
    });

    return {
      markets,
      qualified,
      strength,
      stats: { home, away }
    };
  }

  _teamStat(teamId, standings) {
    if (!standings || !standings.length) return null;
    return standings.find((s) => s.team.id === teamId) || null;
  }

  _formScore(matches) {
    if (!matches || !matches.length) return 0.5;
    const recent = matches.slice(0, 5);
    let pts = 0;
    recent.forEach((m) => {
      const home = m.homeTeam && m.homeTeam.id;
      if (m.score && m.score.fullTime) {
        const hg = m.score.fullTime.home;
        const ag = m.score.fullTime.away;
        if (home) pts += hg > ag ? 3 : hg === ag ? 1 : 0;
        else pts += ag > hg ? 3 : ag === hg ? 1 : 0;
      }
    });
    return pts / (recent.length * 3);
  }

  _strength(home, away, hForm, aForm) {
    const hStat = (home && home.points) || 0;
    const aStat = (away && away.points) || 0;
    const hPos = home ? this._normPosition(home.position) : 0.5;
    const aPos = away ? this._normPosition(away.position) : 0.5;

    const homeFactor = 0.35 * hStat + 0.35 * hForm * 30 + 0.3 * hPos;
    const awayFactor = 0.35 * aStat + 0.35 * aForm * 30 + 0.3 * aPos;
    const total = homeFactor + awayFactor || 1;

    return {
      home: homeFactor / total,
      away: awayFactor / total,
      draw: (0.5 - Math.abs(homeFactor - awayFactor) * 0.42 + 0.5) / 2
    };
  }

  _normPosition(pos) {
    if (!pos) return 0.5;
    return Math.max(0, 1 - (pos - 1) / 19);
  }

  _markets(s) {
    const home = s.home;
    const away = s.away;
    const draw = clampPct(s.draw * 100);
    const h = clampPct(home * 100);
    const a = clampPct(away * 100);

    const overUnder = this._overUnderMarkets(h, a);
    return [
      { key: '1X2', name: 'Match Result', picks: [
        { label: 'Home Win', prob: h },
        { label: 'Draw', prob: draw },
        { label: 'Away Win', prob: a }
      ]},
      ...overUnder,
      { key: 'DC', name: 'Double Chance', picks: [
        { label: '1X (Home/Draw)', prob: clampPct(h + draw) },
        { label: 'X2 (Draw/Away)', prob: clampPct(draw + a) },
        { label: '12 (Home/Away)', prob: clampPct(h + a) }
      ]}
    ];
  }

  _overUnderMarkets(h, a) {
    const ratio = Math.abs(h - a);
    const total = 100 - ratio;
    return [
      { key: 'OU1.5', name: 'Over/Under 1.5', picks: [
        { label: 'Over 1.5', prob: clampPct(total + 18) },
        { label: 'Under 1.5', prob: clampPct(100 - total - 18) }
      ]},
      { key: 'OU2.5', name: 'Over/Under 2.5', picks: [
        { label: 'Over 2.5', prob: clampPct(total - 8) },
        { label: 'Under 2.5', prob: clampPct(100 - total + 8) }
      ]},
      { key: 'OU3.5', name: 'Over/Under 3.5', picks: [
        { label: 'Over 3.5', prob: clampPct(total - 30) },
        { label: 'Under 3.5', prob: clampPct(100 - total + 30) }
      ]}
    ];
  }
}

/* =========================================================
   LAYER 3 — UIRenderer
   ========================================================= */
class UIRenderer {
  constructor() {
    this.matchList = $('#matchList');
    this.loading = $('#loading');
    this.error = $('#error');
    this.errorMsg = $('#errorMessage');
    this.actions = $('#actions');
  }

  showLoading() {
    this.loading.hidden = false;
    this.error.hidden = true;
    this.actions.hidden = true;
    this.matchList.innerHTML = '';
  }

  showError(msg) {
    this.loading.hidden = true;
    this.error.hidden = false;
    this.actions.hidden = true;
    this.errorMsg.textContent = msg;
    this.matchList.innerHTML = '';
  }

  hideStatus() {
    this.loading.hidden = true;
    this.error.hidden = true;
  }

  showActions() {
    this.actions.hidden = false;
  }

  render(matches) {
    this.matchList.innerHTML = '';
    this.hideStatus();
    this.showActions();

    if (!matches.length) {
      this.matchList.appendChild(el('p', 'no-pick', 'No live matches at the moment.'));
      return;
    }

    const frag = document.createDocumentFragment();
    matches.forEach((m) => frag.appendChild(this._card(m)));
    this.matchList.appendChild(frag);
  }

  _card(match) {
    const card = el('article', 'match-card');
    card.dataset.id = match.id;
    card.append(this._main(match), this._predictions(match));
    return card;
  }

  _main(match) {
    const main = el('div', 'match-main');
    main.append(
      this._team(match.homeTeam),
      this._center(match),
      this._team(match.awayTeam, true),
      this._toggle(match)
    );
    return main;
  }

  _team(team, isAway) {
    const wrap = el('div', isAway ? 'team away' : 'team');
    const img = el('img', 'crest');
    img.src = team.crest || '';
    img.alt = team.name;
    img.loading = 'lazy';
    img.onerror = () => {
      img.outerHTML = `<div class="crest placeholder">${(team.shortName || team.name || '?')[0]}</div>`;
    };
    wrap.append(img, el('span', 'team-name', team.shortName || team.name));
    return wrap;
  }

  _center(match) {
    const center = el('div', 'match-center');
    const time = fmtTime(match.utcDate);
    center.append(
      el('span', 'match-time', time),
      el('span', 'vs', 'VS')
    );
    return center;
  }

  _toggle(match) {
    const wrap = el('label', 'toggle-switch');
    const input = el('input', '');
    input.type = 'checkbox';
    input.dataset.matchId = match.id;
    wrap.append(input, el('span', 'toggle-slider'));
    return wrap;
  }

  _predictions(match) {
    const wrapper = el('div', 'predict-wrap');
    const { analysis } = match;
    const body = el('div', 'predict-body');

    if (analysis.qualified.length) {
      body.appendChild(this._banner(analysis.qualified));
    } else {
      body.appendChild(el('p', 'no-pick', `No outcome reached ${CONFIG.THRESHOLD}% confidence.`));
    }

    analysis.markets.forEach((mkt) => {
      body.appendChild(el('h4', 'market-name', mkt.name));
      mkt.picks.forEach((p) => body.appendChild(this._probRow(p)));
    });

    wrapper.appendChild(this._togglePredictions(match));
    wrapper.appendChild(body);
    wrapper.addEventListener('click', (e) => {
      if (e.target.closest('.toggle-switch')) return;
      const open = wrapper.classList.toggle('open');
      wrapper.querySelector('.predict-toggle').setAttribute('aria-expanded', String(open));
    });
    return wrapper;
  }

  _togglePredictions(match) {
    const { qualified } = match.analysis;
    const label = el('span', 'label');
    label.textContent = qualified.length
      ? `🎯 ${qualified.map((q) => q.pick.label).join(' + ')}`
      : 'Predictions';

    const toggle = el('button', 'predict-toggle');
    toggle.append(label, this._arrow());
    toggle.setAttribute('aria-expanded', 'false');
    return toggle;
  }

  _arrow() {
    const span = el('span', 'toggle-arrow');
    span.innerHTML = '&#9660;';
    return span;
  }

  _banner(qualified) {
    const banner = el('div', 'rec-banner');
    const picks = qualified.map((q) => `${q.pick.label} ${q.pick.prob}%`).join('  •  ');
    banner.append(
      el('span', 'rec-icon', '⚡'),
      el('span', 'rec-title', `HIGH CONFIDENCE — ${picks}`)
    );
    return banner;
  }

  _probRow(pick) {
    const row = el('div', 'prob-row');
    const pct = pick.prob;
    const isHigh = pct >= CONFIG.THRESHOLD;

    const track = el('div', 'prob-track');
    const fill = el('div', isHigh ? 'prob-fill gold-fill' : 'prob-fill');
    fill.style.width = pct + '%';
    track.appendChild(fill);

    const value = el('span', isHigh ? 'prob-value high' : 'prob-value', pct + '%');
    row.append(
      el('span', 'prob-label', pick.label),
      track,
      value
    );
    return row;
  }
}

/* =========================================================
   Deserializer — attach engine output to match objects
   ========================================================= */
class MatchEnricher {
  constructor(engine, fetcher) {
    this.engine = engine;
    this.fetcher = fetcher;
  }

  async enrich(matches, standings) {
    const teamForms = {};
    const uniq = new Set();
    matches.forEach((m) => {
      uniq.add(m.homeTeam.id);
      uniq.add(m.awayTeam.id);
    });

    await Promise.all([...uniq].map(async (id) => {
      try {
        teamForms[id] = (await this.fetcher.getTeamForm(id)).matches;
      } catch {
        teamForms[id] = [];
      }
    }));

    const table = this._table(standings);
    matches.forEach((m) => {
      m.analysis = this.engine.analyze(m, table, teamForms);
    });
    return matches;
  }

  _table(standings) {
    if (!standings) return [];
    for (const group of standings) {
      if (group.table) return group.table;
    }
    return [];
  }
}

/* =========================================================
   App Controller — glue & event wiring
   ========================================================= */
class AppController {
  constructor() {
    this.fetcher = new DataFetcher(CONFIG.PROXY);
    this.engine = new PredictionEngine(CONFIG.THRESHOLD);
    this.enricher = new MatchEnricher(this.engine, this.fetcher);
    this.ui = new UIRenderer();
    this.league = CONFIG.DEFAULT_LEAGUE;
    this._allMatches = [];
    this._bind();
  }

  _bind() {
    $('#retryBtn').addEventListener('click', () => this.load());
    $('#searchInput').addEventListener('input', (e) => this._filter(e.target.value));
    $('#toggleAllBtn').addEventListener('click', () => this._toggleAll());
    $('#runPredictionBtn').addEventListener('click', () => this._runPrediction());
    $('#allEventsBtn').addEventListener('click', () => {
      this.league = null;
      this._clearFilterTabs();
      this.load();
    });
  }

  _clearFilterTabs() {
    document.querySelectorAll('.tab').forEach((t) => t.classList.remove('active'));
  }

  async load() {
    this.ui.showLoading();
    try {
      console.log('[App] Loading live matches...');
      const [liveData, standings] = await Promise.all([
        this.fetcher.getLiveMatches(),
        this.fetcher.getStandings(this.league)
      ]);

      const matches = liveData.matches || [];
      console.log(`[App] Found ${matches.length} live matches`);

      if (matches.length) {
        const enriched = await this.enricher.enrich(matches, standings.standings || null);
        this._allMatches = enriched;
        this.ui.render(enriched);
      } else {
        this._allMatches = [];
        this.ui.hideStatus();
        this.ui.showActions();
        this.ui.matchList.appendChild(el('p', 'no-pick', 'No live matches right now. Check back later!'));
      }
    } catch (err) {
      console.error('[App] Load error:', err);
      const msg = err.message || 'Unknown error';
      if (msg.includes('Cannot reach proxy')) {
        this.ui.showError(msg);
      } else if (msg.includes('500')) {
        this.ui.showError('Server error: FOOTBALL_DATA_API_KEY may not be configured on Vercel. Check Vercel → Settings → Environment Variables.');
      } else {
        this.ui.showError(`Failed to load predictions: ${msg}`);
      }
    }
  }

  _filter(query) {
    if (!this._allMatches.length) return;
    const q = query.trim().toLowerCase();
    if (!q) {
      this.ui.render(this._allMatches);
      return;
    }
    const filtered = this._allMatches.filter(
      (m) =>
        m.homeTeam.name.toLowerCase().includes(q) ||
        m.awayTeam.name.toLowerCase().includes(q)
    );
    this.ui.render(filtered);
  }

  _toggleAll() {
    const toggles = document.querySelectorAll('.toggle-switch input');
    const allChecked = [...toggles].every((cb) => cb.checked);
    toggles.forEach((cb) => (cb.checked = !allChecked));
  }

  _runPrediction() {
    const checked = document.querySelectorAll('.toggle-switch input:checked');
    if (!checked.length) {
      alert('Please select at least one match to run predictions.');
      return;
    }

    const ids = [...checked].map((cb) => cb.dataset.matchId);
    const selected = this._allMatches.filter((m) => ids.includes(m.id));
    
    // Re-run analysis for selected matches
    selected.forEach((m) => {
      const home = this.engine._teamStat(m.homeTeam.id, []);
      const away = this.engine._teamStat(m.awayTeam.id, []);
      const hForm = this.engine._formScore([]);
      const aForm = this.engine._formScore([]);
      const strength = this.engine._strength(home, away, hForm, aForm);
      m.analysis = this.engine.analyze(m, [], {});
    });

    this.ui.render(selected);
    
    // Scroll to first selected match
    const first = document.querySelector(`.match-card[data-id="${ids[0]}"]`);
    if (first) first.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
}

/* ---------------- Boot ---------------- */
document.addEventListener('DOMContentLoaded', () => {
  console.log('[App] Initializing...');
  console.log('[App] Proxy URL:', CONFIG.PROXY);
  console.log('[App] API Key present:', !!process.env?.FOOTBALL_DATA_API_KEY);
  
  window.app = new AppController();
  window.app.load();
});