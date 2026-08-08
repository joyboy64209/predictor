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
  CACHE_TTL: 5 * 60 * 1000, // 5 minutes
  THRESHOLD: 75,
  DEFAULT_LEAGUE: 'PL',
  COMPETITIONS: [
    { code: 'PL', name: 'Premier League', tier: 1 },
    { code: 'PD', name: 'La Liga', tier: 1 },
    { code: 'SA', name: 'Serie A', tier: 1 },
    { code: 'BL1', name: 'Bundesliga', tier: 1 },
    { code: 'FL1', name: 'Ligue 1', tier: 1 },
    { code: 'DED', name: 'Eredivisie', tier: 2 },
    { code: 'PPL', name: 'Primeira Liga', tier: 2 },
    { code: 'JPL', name: 'Belgian Pro League', tier: 2 },
    { code: 'CL', name: 'Champions League', tier: 0 },
    { code: 'EL', name: 'Europa League', tier: 0 }
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

function fmtDate(iso) {
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
}

function fmtTime(iso) {
  const d = new Date(iso);
  return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

function fmtDateKey(iso) {
  const d = new Date(iso);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function clampPct(n) {
  return Math.max(0, Math.min(100, Math.round(n)));
}

function isFileProtocol() {
  return window.location.protocol === 'file:';
}

/* =========================================================
   LAYER 1 — DataFetcher
   ========================================================= */
class DataFetcher {
  constructor(proxy) {
    this.proxy = proxy;
  }

  async getMatchesForLeague(leagueCode) {
    const key = `vs_matches_${leagueCode}`;
    const cached = this._readCache(key);
    if (cached) return cached;

    const today = new Date();
    const from = today.toISOString().split('T')[0];
    const to = new Date(today.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];

    const data = await this._fetch(`/matches?competitions=${leagueCode}&dateFrom=${from}&dateTo=${to}&limit=100`);
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
      if (isFileProtocol()) {
        throw new Error('You are opening this page directly from a file. Please run "npx vercel dev" or use a local server so the API proxy can work.');
      }
      throw new Error(`Cannot reach proxy at ${url}. Are you running "npx vercel dev"?`);
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
    this.updatedLabel = $('#updatedLabel');
    this.fileWarning = $('#fileWarning');
  }

  showFileWarning() {
    if (this.fileWarning) this.fileWarning.hidden = false;
  }

  hideFileWarning() {
    if (this.fileWarning) this.fileWarning.hidden = true;
  }

  showLoading() {
    this.loading.hidden = false;
    this.error.hidden = true;
    this.matchList.innerHTML = '';
  }

  showError(msg) {
    this.loading.hidden = true;
    this.error.hidden = false;
    this.errorMsg.textContent = msg;
    this.matchList.innerHTML = '';
  }

  hideStatus() {
    this.loading.hidden = true;
    this.error.hidden = true;
  }

  renderGrouped(grouped) {
    this.matchList.innerHTML = '';
    this.hideStatus();
    this.hideFileWarning();
    this.updatedLabel.textContent = `Updated ${new Date().toLocaleTimeString()}`;

    const dates = Object.keys(grouped).sort();
    if (!dates.length) {
      this.matchList.appendChild(el('p', 'no-pick', 'No upcoming fixtures found for the next 7 days.'));
      return;
    }

    const frag = document.createDocumentFragment();
    dates.forEach((date) => {
      frag.appendChild(this._dateHeader(date));
      const leagues = grouped[date];
      const sortedLeagues = Object.keys(leagues).sort((a, b) => {
        const aComp = CONFIG.COMPETITIONS.find((c) => c.code === a);
        const bComp = CONFIG.COMPETITIONS.find((c) => c.code === b);
        const aTier = aComp ? aComp.tier : 99;
        const bTier = bComp ? bComp.tier : 99;
        if (aTier !== bTier) return aTier - bTier;
        return (leagues[a][0]?.leagueName || a).localeCompare(leagues[b][0]?.leagueName || b);
      });
      sortedLeagues.forEach((code) => {
        const matches = leagues[code];
        if (!matches || !matches.length) return;
        const comp = CONFIG.COMPETITIONS.find((c) => c.code === code);
        frag.appendChild(this._leagueHeader(comp ? comp.name : code));
        const list = el('div', 'league-matches');
        matches.forEach((m) => list.appendChild(this._card(m)));
        frag.appendChild(list);
      });
    });
    this.matchList.appendChild(frag);
  }

  _dateHeader(dateStr) {
    const d = new Date(dateStr + 'T00:00:00');
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);
    let label = d.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
    if (d.getTime() === today.getTime()) label = 'Today — ' + label;
    else if (d.getTime() === tomorrow.getTime()) label = 'Tomorrow — ' + label;

    const header = el('div', 'date-header');
    header.textContent = label;
    return header;
  }

  _leagueHeader(name) {
    const header = el('div', 'league-header');
    header.textContent = name;
    return header;
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
      this._team(match.awayTeam, true)
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
    center.append(
      el('span', 'match-time', fmtTime(match.utcDate)),
      el('span', 'vs', 'VS'),
      el('span', 'match-date', fmtDate(match.utcDate))
    );
    return center;
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

    wrapper.appendChild(this._toggle(match));
    wrapper.appendChild(body);
    wrapper.addEventListener('click', () => {
      const open = wrapper.classList.toggle('open');
      wrapper.querySelector('.predict-toggle').setAttribute('aria-expanded', String(open));
    });
    return wrapper;
  }

  _toggle(match) {
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
    this._loadErrors = [];
    this._bind();
  }

  _bind() {
    $('#retryBtn').addEventListener('click', () => this.load());
    $('#searchInput').addEventListener('input', (e) => this._filter(e.target.value));
  }

  async load() {
    this.ui.showLoading();
    this._loadErrors = [];
    try {
      if (isFileProtocol()) {
        this.ui.showFileWarning();
        throw new Error('You are opening this page directly from a file. Please run "npx vercel dev" or use a local server so the API proxy can work.');
      }

      console.log('[App] Loading upcoming fixtures for next 7 days...');
      const allMatches = [];
      const standingsPromises = [];

      for (const comp of CONFIG.COMPETITIONS) {
        try {
          const data = await this.fetcher.getMatchesForLeague(comp.code);
          const matches = (data.matches || []).map((m) => ({ ...m, leagueCode: comp.code, leagueName: comp.name }));
          allMatches.push(...matches);
          standingsPromises.push(this.fetcher.getStandings(comp.code).catch(() => ({ standings: null })));
        } catch (err) {
          const msg = err.message || 'Unknown error';
          console.warn(`[App] Failed to load ${comp.name}:`, msg);
          this._loadErrors.push(`${comp.name}: ${msg}`);
        }
      }

      console.log(`[App] Found ${allMatches.length} total matches`);

      if (!allMatches.length) {
        this._allMatches = [];
        this.ui.hideStatus();
        if (this._loadErrors.length > 0) {
          this.ui.showError(`Failed to load fixtures.\n\n${this._loadErrors.join('\n')}\n\nNote: The free tier of football-data.org may not have fixtures available for all leagues.`);
        } else {
          this.ui.renderGrouped({});
        }
        return;
      }

      const standingsResults = await Promise.all(standingsPromises);
      const standingsMap = {};
      standingsResults.forEach((s, idx) => {
        const code = CONFIG.COMPETITIONS[idx]?.code;
        if (code && s.standings) standingsMap[code] = s.standings;
      });

      const enriched = await this.enricher.enrich(allMatches, standingsMap[this.league] || null);
      this._allMatches = enriched;

      const grouped = this._groupByDateAndLeague(enriched);
      this.ui.hideStatus();
      this.ui.renderGrouped(grouped);
    } catch (err) {
      console.error('[App] Load error:', err);
      const msg = err.message || 'Unknown error';
      if (msg.includes('Cannot reach proxy') || msg.includes('opening this page directly')) {
        this.ui.showError(msg);
      } else if (msg.includes('500')) {
        this.ui.showError('Server error: FOOTBALL_DATA_API_KEY may not be configured on Vercel. Check Vercel → Settings → Environment Variables.');
      } else {
        this.ui.showError(`Failed to load predictions: ${msg}`);
      }
    }
  }

  _groupByDateAndLeague(matches) {
    const grouped = {};
    matches.forEach((m) => {
      const dateKey = fmtDateKey(m.utcDate);
      const leagueCode = m.leagueCode || 'UNKNOWN';
      if (!grouped[dateKey]) grouped[dateKey] = {};
      if (!grouped[dateKey][leagueCode]) grouped[dateKey][leagueCode] = [];
      grouped[dateKey][leagueCode].push(m);
    });
    return grouped;
  }

  _filter(query) {
    if (!this._allMatches.length) return;
    const q = query.trim().toLowerCase();
    if (!q) {
      const grouped = this._groupByDateAndLeague(this._allMatches);
      this.ui.renderGrouped(grouped);
      return;
    }
    const filtered = this._allMatches.filter(
      (m) =>
        m.homeTeam.name.toLowerCase().includes(q) ||
        m.awayTeam.name.toLowerCase().includes(q)
    );
    const grouped = this._groupByDateAndLeague(filtered);
    this.ui.renderGrouped(grouped);
  }
}

/* ---------------- Boot ---------------- */
document.addEventListener('DOMContentLoaded', () => {
  console.log('[App] Initializing...');
  console.log('[App] Proxy URL:', CONFIG.PROXY);
  console.log('[App] Protocol:', window.location.protocol);

  window.app = new AppController();
  window.app.load();
});