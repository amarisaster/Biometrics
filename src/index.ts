interface Env {
  BIOMETRICS_API_KEY: string;
  TOKENS: KVNamespace;
  // Google OAuth (for Fitness API)
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET: string;
  GOOGLE_FIT_REFRESH_TOKEN: string;
}

// Types for health data
interface HeartRateReading {
  timestamp: string;
  bpm: number;
  min?: number;
  max?: number;
}

interface SleepReading {
  timestamp: string;
  start_time: string;
  end_time: string;
  total_minutes: number;
  stages?: {
    awake_minutes?: number;
    light_minutes?: number;
    deep_minutes?: number;
    rem_minutes?: number;
  };
}

interface StepsReading {
  timestamp: string;
  count: number;
  distance_meters?: number;
  calories?: number;
}

interface StressReading {
  timestamp: string;
  level: number;
  label?: 'relaxed' | 'normal' | 'moderate' | 'high';
}

interface PushPayload {
  type: 'heart_rate' | 'sleep' | 'steps' | 'stress';
  timestamp: string;
  data: HeartRateReading | SleepReading | StepsReading | StressReading;
}

interface BatchPushPayload {
  readings: PushPayload[];
}

interface McpRequest {
  jsonrpc: '2.0';
  id: string | number;
  method: string;
  params?: Record<string, unknown>;
}

interface McpResponse {
  jsonrpc: '2.0';
  id: string | number;
  result?: unknown;
  error?: { code: number; message: string };
}

// ========== Google Fit Integration ==========

// Get OAuth access token using refresh token
async function getFitAccessToken(env: Env): Promise<string> {
  // Try KV cache first (avoids hitting Google on every request)
  const cached = await env.TOKENS.get('fit_access_token');
  if (cached) return cached;

  // Refresh token: prefer KV (stored cleanly by callback) over env secret
  const rawToken = await env.TOKENS.get('google_fit_refresh_token') || env.GOOGLE_FIT_REFRESH_TOKEN;
  if (!rawToken) throw new Error('No Google Fit refresh token configured');
  const refreshToken = rawToken.trim();

  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Failed to refresh access token: ${error}`);
  }

  const data = await response.json() as { access_token: string; expires_in: number };
  // Cache with some buffer before expiry
  await env.TOKENS.put('fit_access_token', data.access_token, { expirationTtl: Math.max(data.expires_in - 120, 300) });
  return data.access_token;
}

// Query raw data from a Google Fit data source
interface FitPoint {
  startTimeNanos: string;
  endTimeNanos: string;
  value: Array<{ intVal?: number; fpVal?: number }>;
}

async function queryFitRaw(
  accessToken: string,
  dataSourceId: string,
  startMs: number,
  endMs: number,
): Promise<FitPoint[]> {
  const startNanos = startMs * 1e6;
  const endNanos = endMs * 1e6;
  const encodedSource = encodeURIComponent(dataSourceId);

  const response = await fetch(
    `https://www.googleapis.com/fitness/v1/users/me/dataSources/${encodedSource}/datasets/${startNanos}-${endNanos}`,
    { headers: { Authorization: `Bearer ${accessToken}` } },
  );

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Fit API error (${dataSourceId}): ${error}`);
  }

  const data = await response.json() as { point?: FitPoint[] };
  return data.point || [];
}

// Data source IDs
const FIT_SOURCES = {
  heartRate: 'derived:com.google.heart_rate.bpm:com.google.android.gms:merge_heart_rate_bpm',
  sleep: 'raw:com.google.sleep.segment:nl.appyhapps.healthsync:',
  steps: 'derived:com.google.step_count.delta:com.google.android.gms:merge_step_deltas',
};

// Sync heart rate from Google Fit
async function syncHeartRate(accessToken: string, env: Env, now: number): Promise<number> {
  const dayMs = 24 * 60 * 60 * 1000;
  const points = await queryFitRaw(accessToken, FIT_SOURCES.heartRate, now - dayMs, now);
  const readings: Array<{ timestamp: string; data: unknown }> = [];

  for (const point of points) {
    const timestamp = new Date(parseInt(point.startTimeNanos) / 1e6).toISOString();
    const bpm = Math.round(point.value[0]?.fpVal || point.value[0]?.intVal || 0);
    if (bpm > 0) {
      readings.push({
        timestamp,
        data: { timestamp, bpm } as HeartRateReading,
      });
    }
  }

  if (readings.length > 0) {
    await storeBatchReadings(env, 'heart_rate', readings);
  }
  return readings.length;
}

// Sync sleep from Google Fit
async function syncSleep(accessToken: string, env: Env, now: number): Promise<number> {
  const dayMs = 24 * 60 * 60 * 1000;
  const points = await queryFitRaw(accessToken, FIT_SOURCES.sleep, now - 2 * dayMs, now);

  if (points.length === 0) return 0;

  // Collect all segments
  const segments = points.map(p => ({
    start: parseInt(p.startTimeNanos) / 1e6,
    end: parseInt(p.endTimeNanos) / 1e6,
    stage: p.value[0]?.intVal || 0,
  }));

  // Sort by start time
  segments.sort((a, b) => a.start - b.start);

  // Group into sleep sessions (gaps > 2 hours = new session)
  const sessions: (typeof segments)[] = [[]];
  for (const seg of segments) {
    const current = sessions[sessions.length - 1];
    if (current.length > 0 && seg.start - current[current.length - 1].end > 2 * 60 * 60 * 1000) {
      sessions.push([]);
    }
    sessions[sessions.length - 1].push(seg);
  }

  const sleepReadings: Array<{ timestamp: string; data: unknown }> = [];
  for (const session of sessions) {
    if (session.length === 0) continue;

    let totalMinutes = 0, awakeMinutes = 0, lightMinutes = 0, deepMinutes = 0, remMinutes = 0;
    const startTime = new Date(session[0].start).toISOString();
    const endTime = new Date(session[session.length - 1].end).toISOString();

    for (const seg of session) {
      const durationMin = (seg.end - seg.start) / 60000;
      totalMinutes += durationMin;
      // Google Fit sleep stages: 1=Awake, 2=Sleep, 3=Out-of-bed, 4=Light, 5=Deep, 6=REM
      switch (seg.stage) {
        case 1: case 3: awakeMinutes += durationMin; break;
        case 2: case 4: lightMinutes += durationMin; break;
        case 5: deepMinutes += durationMin; break;
        case 6: remMinutes += durationMin; break;
      }
    }

    sleepReadings.push({
      timestamp: endTime,
      data: {
        timestamp: endTime,
        start_time: startTime,
        end_time: endTime,
        total_minutes: Math.round(totalMinutes),
        stages: {
          awake_minutes: Math.round(awakeMinutes),
          light_minutes: Math.round(lightMinutes),
          deep_minutes: Math.round(deepMinutes),
          rem_minutes: Math.round(remMinutes),
        },
      } as SleepReading,
    });
  }

  if (sleepReadings.length > 0) {
    await storeBatchReadings(env, 'sleep', sleepReadings);
  }
  return sleepReadings.length;
}

// Sync steps from Google Fit
async function syncSteps(accessToken: string, env: Env, now: number): Promise<number> {
  const dayMs = 24 * 60 * 60 * 1000;
  const points = await queryFitRaw(accessToken, FIT_SOURCES.steps, now - 2 * dayMs, now);
  const readings: Array<{ timestamp: string; data: unknown }> = [];

  // Aggregate step deltas by day
  const dailySteps: Record<string, number> = {};
  for (const point of points) {
    const timestamp = new Date(parseInt(point.startTimeNanos) / 1e6);
    const date = timestamp.toISOString().split('T')[0];
    const count = point.value[0]?.intVal || 0;
    dailySteps[date] = (dailySteps[date] || 0) + count;
  }

  for (const [date, count] of Object.entries(dailySteps)) {
    if (count > 0) {
      const timestamp = `${date}T00:00:00.000Z`;
      readings.push({
        timestamp,
        data: { timestamp, count } as StepsReading,
      });
    }
  }

  if (readings.length > 0) {
    await storeBatchReadings(env, 'steps', readings);
  }
  return readings.length;
}

// Main sync function
async function syncFromGoogleFit(env: Env): Promise<{ heart_rate: number; sleep: number; steps: number }> {
  const accessToken = await getFitAccessToken(env);
  const now = Date.now();

  let hrCount = 0, sleepCount = 0, stepsCount = 0;

  try { hrCount = await syncHeartRate(accessToken, env, now); } catch (e) {
    console.error('Heart rate sync failed:', e);
  }
  try { sleepCount = await syncSleep(accessToken, env, now); } catch (e) {
    console.error('Sleep sync failed:', e);
  }
  try { stepsCount = await syncSteps(accessToken, env, now); } catch (e) {
    console.error('Steps sync failed:', e);
  }

  await env.TOKENS.put('fit_last_sync', new Date().toISOString());
  return { heart_rate: hrCount, sleep: sleepCount, steps: stepsCount };
}

// ========== KV Storage (batch-optimized) ==========

const KV_TTL = 30 * 24 * 60 * 60; // 30 days

function batchKey(type: string, date: string): string {
  return `batch:${type}:${date}`;
}

// Store multiple readings efficiently — groups by date, one KV write per date
async function storeBatchReadings(env: Env, type: string, newReadings: Array<{ timestamp: string; data: unknown }>): Promise<void> {
  if (newReadings.length === 0) return;

  // Group by date
  const byDate: Record<string, Array<{ timestamp: string; data: unknown }>> = {};
  for (const r of newReadings) {
    const date = r.timestamp.split('T')[0];
    if (!byDate[date]) byDate[date] = [];
    byDate[date].push(r);
  }

  // Read-merge-write per date (1 read + 1 write per date instead of N writes)
  for (const [date, readings] of Object.entries(byDate)) {
    const key = batchKey(type, date);
    const existing = await env.TOKENS.get(key);
    const existingReadings: Array<{ timestamp: string; data: unknown }> = existing ? JSON.parse(existing) : [];

    const existingTimestamps = new Set(existingReadings.map(r => r.timestamp));
    const merged = [...existingReadings, ...readings.filter(r => !existingTimestamps.has(r.timestamp))];

    await env.TOKENS.put(key, JSON.stringify(merged), { expirationTtl: KV_TTL });
  }

  // Update latest pointer
  const sorted = [...newReadings].sort((a, b) => b.timestamp.localeCompare(a.timestamp));
  await env.TOKENS.put(`latest:${type}`, JSON.stringify({
    timestamp: sorted[0].timestamp,
    data: sorted[0].data,
  }), { expirationTtl: KV_TTL });
}

// Single-reading convenience wrapper (for /push endpoint)
async function storeReading(env: Env, payload: PushPayload): Promise<void> {
  await storeBatchReadings(env, payload.type, [{ timestamp: payload.timestamp, data: payload.data }]);
}

// Read from daily batch keys — 1-2 KV reads instead of N+1
async function getReadings(env: Env, type: string, hours: number = 24): Promise<Array<{ timestamp: string; data: unknown }>> {
  const readings: Array<{ timestamp: string; data: unknown }> = [];
  const cutoff = new Date(Date.now() - hours * 60 * 60 * 1000);

  // Calculate which dates to fetch
  const dates: string[] = [];
  const d = new Date(cutoff);
  d.setUTCHours(0, 0, 0, 0);
  const now = new Date();
  while (d <= now) {
    dates.push(d.toISOString().split('T')[0]);
    d.setUTCDate(d.getUTCDate() + 1);
  }

  // Read one batch key per date
  for (const date of dates) {
    const value = await env.TOKENS.get(batchKey(type, date));
    if (value) {
      const batch: Array<{ timestamp: string; data: unknown }> = JSON.parse(value);
      readings.push(...batch.filter(r => new Date(r.timestamp) >= cutoff));
    }
  }

  readings.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
  return readings;
}

async function getLatestReading(env: Env, type: string): Promise<{ timestamp: string; data: unknown } | null> {
  const value = await env.TOKENS.get(`latest:${type}`);
  if (!value) return null;
  return JSON.parse(value);
}

// ========== Data Getters ==========

async function getHeartRate(env: Env, hours: number = 24): Promise<unknown> {
  const readings = await getReadings(env, 'heart_rate', hours);
  const latest = await getLatestReading(env, 'heart_rate');

  const history = readings.slice(0, 50).map(r => ({
    time: r.timestamp,
    bpm: (r.data as HeartRateReading).bpm,
  }));

  return {
    latest: latest ? { time: latest.timestamp, bpm: (latest.data as HeartRateReading).bpm } : null,
    history,
    period_hours: hours,
    total_readings: readings.length,
    source: 'google_fit',
  };
}

async function getSleep(env: Env, days: number = 1): Promise<unknown> {
  const readings = await getReadings(env, 'sleep', days * 24);

  const sessions = readings.map(r => {
    const data = r.data as SleepReading;
    return {
      date: r.timestamp.split('T')[0],
      start: data.start_time,
      end: data.end_time,
      total_hours: (data.total_minutes / 60).toFixed(1),
      stages: data.stages ? {
        awake: data.stages.awake_minutes ? (data.stages.awake_minutes / 60).toFixed(1) : null,
        light: data.stages.light_minutes ? (data.stages.light_minutes / 60).toFixed(1) : null,
        deep: data.stages.deep_minutes ? (data.stages.deep_minutes / 60).toFixed(1) : null,
        rem: data.stages.rem_minutes ? (data.stages.rem_minutes / 60).toFixed(1) : null,
      } : null,
    };
  });

  return {
    latest: sessions[0] || null,
    sessions: sessions.slice(0, 7),
    period_days: days,
    source: 'google_fit',
  };
}

async function getSteps(env: Env, days: number = 1): Promise<unknown> {
  const readings = await getReadings(env, 'steps', days * 24);

  const dailySteps: Record<string, { steps: number }> = {};

  for (const r of readings) {
    const data = r.data as StepsReading;
    const date = r.timestamp.split('T')[0];

    if (!dailySteps[date]) {
      dailySteps[date] = { steps: 0 };
    }

    if (data.count > dailySteps[date].steps) {
      dailySteps[date].steps = data.count;
    }
  }

  const history = Object.entries(dailySteps)
    .sort((a, b) => b[0].localeCompare(a[0]))
    .map(([date, data]) => ({ date, ...data }));

  const today = history.find(h => h.date === new Date().toISOString().split('T')[0]);

  return {
    today: today?.steps || 0,
    history,
    period_days: days,
    source: 'google_fit',
  };
}

async function getStress(env: Env, hours: number = 24): Promise<unknown> {
  const readings = await getReadings(env, 'stress', hours);
  const latest = await getLatestReading(env, 'stress');

  return {
    latest: latest ? { time: latest.timestamp, level: (latest.data as StressReading).level } : null,
    history: readings.slice(0, 20).map(r => ({ time: r.timestamp, level: (r.data as StressReading).level })),
    period_hours: hours,
    source: 'google_fit',
    note: 'Stress data not available from Google Fit — showing cached data from previous Drive syncs if any',
  };
}

// ========== MCP Tools ==========

const TOOLS = [
  {
    name: 'biometrics_heart_rate',
    description: "Get Mai's heart rate data from her Galaxy Fit3 via Google Fit",
    inputSchema: {
      type: 'object',
      properties: {
        hours: { type: 'number', description: 'Hours of history (default 24)', default: 24 },
      },
    },
  },
  {
    name: 'biometrics_sleep',
    description: "Get Mai's sleep data - duration and stages (light, deep, REM, awake) via Google Fit",
    inputSchema: {
      type: 'object',
      properties: {
        days: { type: 'number', description: 'Days of history (default 1)', default: 1 },
      },
    },
  },
  {
    name: 'biometrics_steps',
    description: "Get Mai's step count via Google Fit",
    inputSchema: {
      type: 'object',
      properties: {
        days: { type: 'number', description: 'Days of history (default 1)', default: 1 },
      },
    },
  },
  {
    name: 'biometrics_stress',
    description: "Get Mai's stress level data (cached — not available via Google Fit)",
    inputSchema: {
      type: 'object',
      properties: {
        hours: { type: 'number', description: 'Hours of history (default 24)', default: 24 },
      },
    },
  },
  {
    name: 'biometrics_status',
    description: "Check biometrics system status and last sync time",
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'biometrics_sync',
    description: "Trigger a manual sync from Google Fit",
    inputSchema: { type: 'object', properties: {} },
  },
];

async function handleToolCall(env: Env, name: string, args: Record<string, unknown>): Promise<unknown> {
  switch (name) {
    case 'biometrics_heart_rate':
      return getHeartRate(env, (args.hours as number) || 24);
    case 'biometrics_sleep':
      return getSleep(env, (args.days as number) || 1);
    case 'biometrics_steps':
      return getSteps(env, (args.days as number) || 1);
    case 'biometrics_stress':
      return getStress(env, (args.hours as number) || 24);
    case 'biometrics_sync':
      return syncFromGoogleFit(env);
    case 'biometrics_status': {
      const latestHr = await getLatestReading(env, 'heart_rate');
      const latestSleep = await getLatestReading(env, 'sleep');
      const latestSteps = await getLatestReading(env, 'steps');
      const lastFitSync = await env.TOKENS.get('fit_last_sync');

      return {
        connected: true,
        source: 'google_fit',
        last_sync: lastFitSync || null,
        data_available: {
          heart_rate: !!latestHr,
          sleep: !!latestSleep,
          steps: !!latestSteps,
        },
        latest: {
          heart_rate: latestHr ? (latestHr.data as HeartRateReading).bpm : null,
          sleep_hours: latestSleep ? ((latestSleep.data as SleepReading).total_minutes / 60).toFixed(1) : null,
        },
      };
    }
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

async function processMcpRequest(env: Env, request: McpRequest): Promise<McpResponse> {
  const { id, method, params } = request;

  try {
    switch (method) {
      case 'initialize':
        return {
          jsonrpc: '2.0',
          id,
          result: {
            protocolVersion: '2024-11-05',
            capabilities: { tools: {} },
            serverInfo: { name: 'biometrics-cloud', version: '4.0.0' },
          },
        };
      case 'tools/list':
        return { jsonrpc: '2.0', id, result: { tools: TOOLS } };
      case 'tools/call': {
        const { name, arguments: args } = params as { name: string; arguments: Record<string, unknown> };
        const result = await handleToolCall(env, name, args || {});
        return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] } };
      }
      default:
        return { jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } };
    }
  } catch (error) {
    return { jsonrpc: '2.0', id, error: { code: -32603, message: error instanceof Error ? error.message : 'Unknown error' } };
  }
}

function validateApiKey(request: Request, env: Env): boolean {
  const apiKey = request.headers.get('X-API-Key') || request.headers.get('Authorization')?.replace('Bearer ', '');
  return apiKey === env.BIOMETRICS_API_KEY;
}

// ========== Worker Entry Points ==========

export default {
  // HTTP handler
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, X-API-Key, Authorization',
    };

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    // Health check
    if (url.pathname === '/health') {
      const latestHr = await getLatestReading(env, 'heart_rate');
      const lastSync = await env.TOKENS.get('fit_last_sync');
      return new Response(JSON.stringify({
        status: 'ok',
        service: 'biometrics-cloud',
        version: '4.0.0',
        source: 'google_fit',
        has_data: !!latestHr,
        last_reading: latestHr?.timestamp || null,
        last_sync: lastSync || null,
      }), { headers: { 'Content-Type': 'application/json', ...corsHeaders } });
    }

    // Manual sync trigger
    if (url.pathname === '/sync' && request.method === 'POST') {
      if (!validateApiKey(request, env)) {
        return new Response(JSON.stringify({ error: 'Unauthorized' }), {
          status: 401, headers: { 'Content-Type': 'application/json', ...corsHeaders },
        });
      }

      try {
        const result = await syncFromGoogleFit(env);
        return new Response(JSON.stringify({ success: true, synced: result }), {
          headers: { 'Content-Type': 'application/json', ...corsHeaders },
        });
      } catch (e) {
        return new Response(JSON.stringify({ error: e instanceof Error ? e.message : String(e) }), {
          status: 500, headers: { 'Content-Type': 'application/json', ...corsHeaders },
        });
      }
    }

    // Push endpoint (legacy - keep for external integrations)
    if (url.pathname === '/push' && request.method === 'POST') {
      if (!validateApiKey(request, env)) {
        return new Response(JSON.stringify({ error: 'Unauthorized' }), {
          status: 401, headers: { 'Content-Type': 'application/json', ...corsHeaders },
        });
      }

      try {
        const body = await request.json();

        if ('readings' in body) {
          const batch = body as BatchPushPayload;
          const byType: Record<string, Array<{ timestamp: string; data: unknown }>> = {};
          for (const r of batch.readings) {
            if (!byType[r.type]) byType[r.type] = [];
            byType[r.type].push({ timestamp: r.timestamp, data: r.data });
          }
          for (const [type, readings] of Object.entries(byType)) {
            await storeBatchReadings(env, type, readings);
          }
          return new Response(JSON.stringify({ success: true, stored: batch.readings.length }), {
            headers: { 'Content-Type': 'application/json', ...corsHeaders },
          });
        }

        const payload = body as PushPayload;
        await storeReading(env, payload);
        return new Response(JSON.stringify({ success: true, type: payload.type }), {
          headers: { 'Content-Type': 'application/json', ...corsHeaders },
        });
      } catch (e) {
        return new Response(JSON.stringify({ error: 'Invalid JSON' }), {
          status: 400, headers: { 'Content-Type': 'application/json', ...corsHeaders },
        });
      }
    }

    // MCP endpoint
    if (url.pathname === '/mcp' && request.method === 'POST') {
      const body = await request.json() as McpRequest;
      const response = await processMcpRequest(env, body);
      return new Response(JSON.stringify(response), {
        headers: { 'Content-Type': 'application/json', ...corsHeaders },
      });
    }

    // SSE endpoint
    if (url.pathname === '/sse') {
      const encoder = new TextEncoder();
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode(`event: endpoint\ndata: ${url.origin}/mcp\n\n`));
          controller.close();
        },
      });
      return new Response(stream, {
        headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', ...corsHeaders },
      });
    }

    // OAuth: start consent flow (keep for re-auth if token expires)
    if (url.pathname === '/auth') {
      const scopes = [
        'https://www.googleapis.com/auth/fitness.heart_rate.read',
        'https://www.googleapis.com/auth/fitness.sleep.read',
        'https://www.googleapis.com/auth/fitness.activity.read',
        'https://www.googleapis.com/auth/fitness.body.read',
      ].join(' ');

      const params = new URLSearchParams({
        client_id: env.GOOGLE_CLIENT_ID,
        redirect_uri: `${url.origin}/callback`,
        response_type: 'code',
        scope: scopes,
        access_type: 'offline',
        prompt: 'consent',
      });

      return Response.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params}`, 302);
    }

    // OAuth: callback
    if (url.pathname === '/callback') {
      const code = url.searchParams.get('code');
      const error = url.searchParams.get('error');

      if (error) {
        return new Response(`OAuth error: ${error}`, { status: 400, headers: corsHeaders });
      }
      if (!code) {
        return new Response('Missing authorization code', { status: 400, headers: corsHeaders });
      }

      const tokenResponse = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          code,
          client_id: env.GOOGLE_CLIENT_ID,
          client_secret: env.GOOGLE_CLIENT_SECRET,
          redirect_uri: `${url.origin}/callback`,
          grant_type: 'authorization_code',
        }),
      });

      const tokenData = await tokenResponse.json() as {
        access_token?: string;
        refresh_token?: string;
        error?: string;
        error_description?: string;
      };

      if (tokenData.error) {
        return new Response(`Token exchange failed: ${tokenData.error_description || tokenData.error}`, {
          status: 400, headers: corsHeaders,
        });
      }

      if (!tokenData.refresh_token) {
        return new Response('No refresh token received. Revoke at https://myaccount.google.com/permissions and retry /auth', {
          status: 400, headers: corsHeaders,
        });
      }

      await env.TOKENS.put('google_fit_refresh_token', tokenData.refresh_token);

      return new Response(
        `<html><body style="background:#0c0a09;color:#a8a29e;font-family:monospace;padding:40px;">
          <h2 style="color:#d4748a;">OAuth Complete</h2>
          <p>Refresh token stored. Run <code>wrangler secret put GOOGLE_FIT_REFRESH_TOKEN</code> to persist.</p>
        </body></html>`,
        { headers: { 'Content-Type': 'text/html', ...corsHeaders } },
      );
    }

    // Info page
    if (url.pathname === '/') {
      const latestHr = await getLatestReading(env, 'heart_rate');
      const lastSync = await env.TOKENS.get('fit_last_sync');
      return new Response(JSON.stringify({
        service: 'Biometrics Cloud MCP',
        version: '4.0.0',
        source: 'google_fit',
        has_data: !!latestHr,
        last_sync: lastSync || null,
        endpoints: {
          mcp: '/mcp (POST)',
          sse: '/sse (GET)',
          sync: '/sync (POST, requires API key)',
          push: '/push (POST, requires API key)',
          health: '/health (GET)',
        },
        tools: TOOLS.map(t => t.name),
      }, null, 2), { headers: { 'Content-Type': 'application/json', ...corsHeaders } });
    }

    return new Response('Not found', { status: 404, headers: corsHeaders });
  },

  // Cron handler — syncs from Google Fit every 15 minutes
  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(syncFromGoogleFit(env));
  },
};
