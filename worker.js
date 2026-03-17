/**
 * Pilgrims Book House — Google Ads Live Sync Worker
 * Deploy to: https://pbhtrakcer.eliofattal05.workers.dev
 *
 * Setup (Cloudflare Dashboard > Workers > Settings > Variables):
 *   DEVELOPER_TOKEN  — your Google Ads developer token (from ads.google.com/aw/apicenter)
 *   CLIENT_ID        — OAuth2 client ID (from console.cloud.google.com)
 *   CLIENT_SECRET    — OAuth2 client secret
 *   REFRESH_TOKEN    — long-lived refresh token (see OAUTH SETUP below)
 *   CUSTOMER_ID      — your Google Ads customer ID without dashes (e.g. 7844613662)
 *
 * ── OAUTH SETUP ────────────────────────────────────────────────────────
 * 1. Go to console.cloud.google.com → APIs & Services → Credentials
 * 2. Create an OAuth 2.0 Client ID (type: "Desktop app" or "Web app")
 * 3. Enable the "Google Ads API" in the API Library
 * 4. Run this in your browser to get a refresh token:
 *    https://accounts.google.com/o/oauth2/auth?client_id=YOUR_CLIENT_ID&redirect_uri=urn:ietf:wg:oauth:2.0:oob&response_type=code&scope=https://www.googleapis.com/auth/adwords&access_type=offline&prompt=consent
 * 5. Exchange the code: POST to https://oauth2.googleapis.com/token with
 *    { code, client_id, client_secret, redirect_uri: 'urn:ietf:wg:oauth:2.0:oob', grant_type: 'authorization_code' }
 *    Save the returned refresh_token as your REFRESH_TOKEN secret.
 * ───────────────────────────────────────────────────────────────────────
 */

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS });
    }

    try {
      const accessToken = await getAccessToken(env);
      const customerId = (env.CUSTOMER_ID || '').replace(/-/g, '');

      const [campaignData, dailyData] = await Promise.all([
        fetchCampaigns(accessToken, env.DEVELOPER_TOKEN, customerId),
        fetchDailyData(accessToken, env.DEVELOPER_TOKEN, customerId),
      ]);

      const totals = computeTotals(campaignData);

      return json({ success: true, data: { campaigns: campaignData, dailyData, totals } });
    } catch (err) {
      console.error(err);
      return json({ success: false, error: err.message }, 500);
    }
  },
};

// ── OAuth2: exchange refresh token for access token ──────────────────

async function getAccessToken(env) {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: env.CLIENT_ID,
      client_secret: env.CLIENT_SECRET,
      refresh_token: env.REFRESH_TOKEN,
      grant_type: 'refresh_token',
    }),
  });
  const data = await res.json();
  if (!data.access_token) {
    throw new Error('Failed to get access token: ' + (data.error_description || data.error || JSON.stringify(data)));
  }
  return data.access_token;
}

// ── Fetch campaign-level totals (last 30 days) ───────────────────────

async function fetchCampaigns(accessToken, developerToken, customerId) {
  const query = `
    SELECT
      campaign.id,
      campaign.name,
      campaign.status,
      metrics.clicks,
      metrics.impressions,
      metrics.cost_micros,
      metrics.average_cpc
    FROM campaign
    WHERE segments.date DURING LAST_30_DAYS
      AND campaign.status != 'REMOVED'
    ORDER BY metrics.clicks DESC
    LIMIT 10
  `;

  const rows = await runGaqlQuery(accessToken, developerToken, customerId, query);

  return rows.map(function(row) {
    var cpc = row.metrics?.averageCpc ? row.metrics.averageCpc / 1000000 : 0;
    var cost = row.metrics?.costMicros ? row.metrics.costMicros / 1000000 : 0;
    return {
      id: row.campaign?.id || '',
      name: row.campaign?.name || 'Campaign',
      status: row.campaign?.status || 'UNKNOWN',
      clicks: row.metrics?.clicks || 0,
      imp: row.metrics?.impressions || 0,
      cost: Math.round(cost * 100) / 100,
      avgCpc: Math.round(cpc * 100) / 100,
    };
  });
}

// ── Fetch daily breakdown (last 30 days) ─────────────────────────────

async function fetchDailyData(accessToken, developerToken, customerId) {
  const query = `
    SELECT
      segments.date,
      metrics.clicks,
      metrics.impressions,
      metrics.cost_micros,
      metrics.average_cpc
    FROM campaign
    WHERE segments.date DURING LAST_30_DAYS
      AND campaign.status != 'REMOVED'
    ORDER BY segments.date ASC
  `;

  const rows = await runGaqlQuery(accessToken, developerToken, customerId, query);

  // Group by date (multiple campaigns per day)
  var byDate = {};
  rows.forEach(function(row) {
    var d = row.segments?.date;
    if (!d) return;
    if (!byDate[d]) byDate[d] = { date: d, clicks: 0, impressions: 0, costMicros: 0, cpcTotal: 0, cpcCount: 0 };
    byDate[d].clicks += row.metrics?.clicks || 0;
    byDate[d].impressions += row.metrics?.impressions || 0;
    byDate[d].costMicros += row.metrics?.costMicros || 0;
    if (row.metrics?.averageCpc) {
      byDate[d].cpcTotal += row.metrics.averageCpc;
      byDate[d].cpcCount++;
    }
  });

  return Object.values(byDate).map(function(d) {
    var cost = d.costMicros / 1000000;
    var avgCpc = d.cpcCount > 0 ? (d.cpcTotal / d.cpcCount / 1000000) : 0;
    var dateObj = new Date(d.date);
    var dayNames = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
    var monthNames = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    var label = monthNames[dateObj.getMonth()] + ' ' + dateObj.getDate() + ', ' + dateObj.getFullYear();
    return {
      date: label,
      day: dayNames[dateObj.getDay()],
      clicks: d.clicks,
      impressions: d.impressions,
      cpc: Math.round(avgCpc * 100) / 100,
      cost: Math.round(cost * 100) / 100,
      notes: '',
    };
  });
}

// ── Compute overall totals from campaign rows ─────────────────────────

function computeTotals(campaigns) {
  var clicks = 0, impressions = 0, cost = 0;
  campaigns.forEach(function(c) {
    clicks += c.clicks;
    impressions += c.imp;
    cost += c.cost;
  });
  var avgCpc = clicks > 0 ? cost / clicks : 0;
  return {
    clicks,
    impressions,
    cost: Math.round(cost * 100) / 100,
    avgCpc: Math.round(avgCpc * 1000) / 1000,
  };
}

// ── Google Ads API query runner ───────────────────────────────────────

async function runGaqlQuery(accessToken, developerToken, customerId, query) {
  const url = `https://googleads.googleapis.com/v18/customers/${customerId}/googleAds:search`;

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + accessToken,
      'developer-token': developerToken,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ query: query.trim() }),
  });

  if (!res.ok) {
    const errBody = await res.text();
    throw new Error('Google Ads API error ' + res.status + ': ' + errBody);
  }

  const data = await res.json();
  return data.results || [];
}

// ── Helpers ────────────────────────────────────────────────────────────

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });
}
