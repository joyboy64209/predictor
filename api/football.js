// =========================================================
// VELOCITY SPORTS — Vercel Serverless Proxy
// Routes: /api/football
// Keeps FOOTBALL_DATA_API_KEY server-side (never in frontend)
// =========================================================

const API_BASE = 'https://api.football-data.org/v4';
const ALLOWED = [
  '/matches',
  '/competitions/',
  '/teams/'
];

function isAllowed(path) {
  return ALLOWED.some((prefix) => path.startsWith(prefix));
}

function pick(supported, wanted) {
  const params = new URLSearchParams(wanted);
  const out = new URLSearchParams();
  supported.forEach((k) => {
    if (params.has(k)) out.set(k, params.get(k));
  });
  return out.toString();
}

const ROUTE_PARAMS = {
  '/matches': ['competitions', 'status', 'limit', 'dateFrom', 'dateTo'],
  '/competitions': ['dateFrom', 'dateTo', 'status', 'limit'],
  '/teams': ['status', 'limit', 'dateFrom', 'dateTo']
};

function allowedParams(path) {
  if (path.startsWith('/matches')) return ROUTE_PARAMS['/matches'];
  if (path.startsWith('/competitions/')) return ROUTE_PARAMS['/competitions'];
  if (path.startsWith('/teams/')) return ROUTE_PARAMS['/teams'];
  return [];
}

export default async function handler(req, res) {
  // Only GET
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { pathname, searchParams } = new URL(req.url, `http://${req.headers.host}`);
  const apiPath = pathname.replace(/^\/api\/football/, '') || '/matches';

  // Whitelist guard
  if (!isAllowed(apiPath)) {
    return res.status(400).json({ error: 'Invalid path' });
  }

  const key = process.env.FOOTBALL_DATA_API_KEY;
  if (!key) {
    return res.status(500).json({
      error: 'FOOTBALL_DATA_API_KEY is not configured. Add it in Vercel project settings.'
    });
  }

  const query = pick(allowedParams(apiPath), searchParams);
  const url = API_BASE + apiPath + (query ? '?' + query : '');

  try {
    const upstream = await fetch(url, {
      headers: {
        'X-Auth-Token': key,
        'X-Response-Control': 'minified'
      }
    });

    const body = await upstream.json();

    // Map upstream rate-limit headers for client awareness
    const remaining = upstream.headers.get('x-requests-remaining') || null;
    if (remaining && typeof body === 'object' && body !== null) {
      body.meta = { ...(body.meta || {}), requestsRemaining: remaining };
    }

    res.setHeader('Cache-Control', `s-maxage=300, public, stale-while-revalidate=900`);
    res.status(upstream.status).json(body);
  } catch (err) {
    res.status(502).json({ error: `Upstream request failed: ${err.message}` });
  }
}