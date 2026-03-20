// ============================================================
// Cloudflare Worker — Google Ads API Proxy for PBH Tracker
// Deploy this at: dash.cloudflare.com → Workers → Create
// ============================================================

// ── CREDENTIALS (set these as Worker Environment Variables) ──
// In Cloudflare Dashboard → Worker → Settings → Variables:
//   GOOGLE_CLIENT_ID
//   GOOGLE_CLIENT_SECRET
//   GOOGLE_REFRESH_TOKEN
//   GOOGLE_DEVELOPER_TOKEN
//   GOOGLE_CUSTOMER_ID

const ALLOWED_ORIGIN = '*'; // Replace with your Cloudflare Pages domain e.g. 'https://pbh-tracker.pages.dev'

async function getAccessToken(env) {
  const resp = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      refresh_token: env.GOOGLE_REFRESH_TOKEN,
      grant_type: 'refresh_token'
    })
  });
  const data = await resp.json();
  if (!data.access_token) throw new Error('Failed to get access token: ' + JSON.stringify(data));
  return data.access_token;
}

async function fetchAdsData(env, accessToken) {
  // Use manager account ID for API calls
  const customerId = '9900177864';

  // Query last 30 days of campaign performance
  const query = `
    SELECT
      campaign.name,
      campaign.status,
      metrics.clicks,
      metrics.impressions,
      metrics.cost_micros,
      metrics.ctr,
      metrics.average_cpc,
      segments.date
    FROM campaign
    WHERE segments.date DURING LAST_30_DAYS
      AND campaign.status != 'REMOVED'
    ORDER BY segments.date DESC
  `;

  const resp = await fetch(
    `https://googleads.googleapis.com/v19/customers/${customerId}/googleAds:search`,
    {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'developer-token': env.GOOGLE_DEVELOPER_TOKEN,
        'Content-Type': 'application/json',
        'login-customer-id': '9900177864'
      },
      body: JSON.stringify({ query: query.trim() })
    }
  );

  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`Google Ads API error ${resp.status}: ${err}`);
  }

  const raw = await resp.json();
  return processAdsData(raw);
}

function processAdsData(raw) {
  if (!raw.results || raw.results.length === 0) {
    return { campaigns: [], dailyData: [], totals: { clicks: 0, impressions: 0, cost: 0, ctr: 0, avgCpc: 0 } };
  }

  // Group by date
  const byDate = {};
  const byCampaign = {};

  for (const row of raw.results) {
    const date = row.segments?.date || 'unknown';
    const campaignName = row.campaign?.name || 'Unknown';
    const clicks = parseInt(row.metrics?.clicks || 0);
    const impressions = parseInt(row.metrics?.impressions || 0);
    const costMicros = parseInt(row.metrics?.costMicros || 0);
    const cost = costMicros / 1_000_000;

    // Daily totals
    if (!byDate[date]) byDate[date] = { date, clicks: 0, impressions: 0, cost: 0 };
    byDate[date].clicks += clicks;
    byDate[date].impressions += impressions;
    byDate[date].cost += cost;

    // Per campaign totals
    if (!byCampaign[campaignName]) byCampaign[campaignName] = { name: campaignName, status: row.campaign?.status, clicks: 0, impressions: 0, cost: 0 };
    byCampaign[campaignName].clicks += clicks;
    byCampaign[campaignName].impressions += impressions;
    byCampaign[campaignName].cost += cost;
  }

  // Sort dates ascending
  const dailyData = Object.values(byDate)
    .sort((a, b) => a.date.localeCompare(b.date))
    .map(d => ({
      date: formatDate(d.date),
      day: getDayName(d.date),
      clicks: d.clicks,
      impressions: d.impressions,
      cost: parseFloat(d.cost.toFixed(2)),
      cpc: d.clicks > 0 ? parseFloat((d.cost / d.clicks).toFixed(2)) : 0
    }));

  const campaigns = Object.values(byCampaign).map(c => ({
    name: c.name,
    status: c.status,
    clicks: c.clicks,
    impressions: c.impressions,
    cost: parseFloat(c.cost.toFixed(2))
  }));

  const totals = dailyData.reduce((acc, d) => ({
    clicks: acc.clicks + d.clicks,
    impressions: acc.impressions + d.impressions,
    cost: parseFloat((acc.cost + d.cost).toFixed(2))
  }), { clicks: 0, impressions: 0, cost: 0 });

  totals.ctr = totals.impressions > 0 ? parseFloat(((totals.clicks / totals.impressions) * 100).toFixed(2)) : 0;
  totals.avgCpc = totals.clicks > 0 ? parseFloat((totals.cost / totals.clicks).toFixed(2)) : 0;

  return { campaigns, dailyData, totals };
}

function formatDate(dateStr) {
  // dateStr is YYYY-MM-DD
  const d = new Date(dateStr + 'T00:00:00Z');
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  return `${d.getUTCDate()} ${months[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

function getDayName(dateStr) {
  const days = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
  const d = new Date(dateStr + 'T00:00:00Z');
  return days[d.getUTCDay()];
}

// ── MAIN HANDLER ──
export default {
  async fetch(request, env, ctx) {
    // CORS headers
    const corsHeaders = {
      'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    };

    // Handle preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    // Only allow GET
    if (request.method !== 'GET') {
      return new Response('Method not allowed', { status: 405, headers: corsHeaders });
    }

    try {
      // Check cache first (cache for 1 hour)
      const cacheKey = new Request('https://pbh-ads-cache/data', request);
      const cache = caches.default;
      let response = await cache.match(cacheKey);

      if (!response) {
        // Fetch fresh data
        const accessToken = await getAccessToken(env);
        const adsData = await fetchAdsData(env, accessToken);

        const body = JSON.stringify({
          success: true,
          lastUpdated: new Date().toISOString(),
          data: adsData
        });

        response = new Response(body, {
          headers: {
            ...corsHeaders,
            'Content-Type': 'application/json',
            'Cache-Control': 'public, max-age=3600' // Cache 1 hour
          }
        });

        ctx.waitUntil(cache.put(cacheKey, response.clone()));
      }

      return response;

    } catch (err) {
      console.error('Worker error:', err);
      return new Response(JSON.stringify({
        success: false,
        error: err.message
      }), {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }
  }
};