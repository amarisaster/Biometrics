interface Env {
  BIOMETRICS_API_KEY: string;
  TOKENS: KVNamespace;
  // Google Drive service account
  GOOGLE_SERVICE_ACCOUNT_EMAIL: string;
  GOOGLE_PRIVATE_KEY: string;
  // Drive folder IDs
  DRIVE_FOLDER_HEART_RATE: string;
  DRIVE_FOLDER_SLEEP: string;
  DRIVE_FOLDER_STEPS: string;
  DRIVE_FOLDER_STRESS: string;
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

// ========== Google Drive Integration ==========

// Create JWT for Google Service Account auth
async function createGoogleJwt(email: string, privateKey: string): Promise<string> {
  const header = { alg: 'RS256', typ: 'JWT' };
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    iss: email,
    scope: 'https://www.googleapis.com/auth/drive.readonly',
    aud: 'https://oauth2.googleapis.com/token',
    exp: now + 3600,
    iat: now,
  };

  const encoder = new TextEncoder();
  const headerB64 = btoa(JSON.stringify(header)).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
  const payloadB64 = btoa(JSON.stringify(payload)).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
  const signatureInput = `${headerB64}.${payloadB64}`;

  // Import the private key - handle both actual newlines and literal \n
  const normalizedKey = privateKey.replace(/\\n/g, '\n');
  const pemContents = normalizedKey
    .replace(/-----BEGIN PRIVATE KEY-----/g, '')
    .replace(/-----END PRIVATE KEY-----/g, '')
    .replace(/[\r\n\s]/g, '');
  const binaryKey = Uint8Array.from(atob(pemContents), c => c.charCodeAt(0));

  const cryptoKey = await crypto.subtle.importKey(
    'pkcs8',
    binaryKey,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign']
  );

  const signature = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    cryptoKey,
    encoder.encode(signatureInput)
  );

  const signatureB64 = btoa(String.fromCharCode(...new Uint8Array(signature)))
    .replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');

  return `${signatureInput}.${signatureB64}`;
}

// Get Google access token
async function getGoogleAccessToken(env: Env): Promise<string> {
  const jwt = await createGoogleJwt(env.GOOGLE_SERVICE_ACCOUNT_EMAIL, env.GOOGLE_PRIVATE_KEY);

  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${jwt}`,
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Failed to get access token: ${error}`);
  }

  const data = await response.json() as { access_token: string };
  return data.access_token;
}

// List files in a Drive folder (only get most recent 2 files)
async function listDriveFiles(accessToken: string, folderId: string): Promise<Array<{ id: string; name: string; modifiedTime: string }>> {
  // Filter by .csv extension in name since mimeType detection is unreliable
  const query = encodeURIComponent(`'${folderId}' in parents and name contains '.csv'`);
  const response = await fetch(
    `https://www.googleapis.com/drive/v3/files?q=${query}&fields=files(id,name,modifiedTime)&orderBy=modifiedTime desc&pageSize=2`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Failed to list files: ${error}`);
  }

  const data = await response.json() as { files: Array<{ id: string; name: string; modifiedTime: string }> };
  return data.files || [];
}

// Download file content from Drive
async function downloadDriveFile(accessToken: string, fileId: string): Promise<string> {
  const response = await fetch(
    `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );

  if (!response.ok) {
    throw new Error(`Failed to download file: ${response.status}`);
  }

  return response.text();
}

// Parse Health Sync heart rate CSV
function parseHeartRateCsv(csv: string): HeartRateReading[] {
  const lines = csv.trim().split('\n');
  const readings: HeartRateReading[] = [];

  // Skip header: Date,Time,Heart rate,Source
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(',');
    if (cols.length >= 3) {
      // Date format: 2026.01.24 00:00:00 -> ISO format
      // Already has full time, just need to fix separators
      const dateStr = cols[0].replace(/\./g, '-').replace(' ', 'T') + '.000Z';
      const bpm = parseInt(cols[2], 10);
      if (!isNaN(bpm)) {
        readings.push({ timestamp: dateStr, bpm });
      }
    }
  }

  return readings;
}

// Parse Health Sync sleep CSV
function parseSleepCsv(csv: string): SleepReading | null {
  const lines = csv.trim().split('\n');
  if (lines.length < 2) return null;

  // Aggregate sleep stages
  let totalMinutes = 0;
  let awakeMinutes = 0;
  let lightMinutes = 0;
  let deepMinutes = 0;
  let remMinutes = 0;
  let startTime: string | null = null;
  let endTime: string | null = null;

  // Skip header: Date,Time,Duration in seconds,Sleep stage
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(',');
    if (cols.length >= 4) {
      const dateStr = cols[0].replace(/\./g, '-').replace(' ', 'T') + '.000Z';
      const durationSec = parseInt(cols[2], 10);
      const stage = cols[3].toLowerCase().trim();

      if (!startTime) startTime = dateStr;
      endTime = dateStr;

      const durationMin = durationSec / 60;
      totalMinutes += durationMin;

      switch (stage) {
        case 'awake': awakeMinutes += durationMin; break;
        case 'light': lightMinutes += durationMin; break;
        case 'deep': deepMinutes += durationMin; break;
        case 'rem': remMinutes += durationMin; break;
      }
    }
  }

  if (!startTime || !endTime) return null;

  return {
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
  };
}

// Parse Health Sync steps CSV (similar format to heart rate)
function parseStepsCsv(csv: string): StepsReading[] {
  const lines = csv.trim().split('\n');
  const readings: StepsReading[] = [];

  // Skip header
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(',');
    if (cols.length >= 3) {
      const dateStr = cols[0].replace(/\./g, '-').replace(' ', 'T') + '.000Z';
      const count = parseInt(cols[2], 10);
      if (!isNaN(count)) {
        readings.push({ timestamp: dateStr, count });
      }
    }
  }

  return readings;
}

// Sync data from Google Drive
async function syncFromDrive(env: Env, force: boolean = false): Promise<{ heart_rate: number; sleep: number; steps: number; debug?: string }> {
  const accessToken = await getGoogleAccessToken(env);
  let hrCount = 0, sleepCount = 0, stepsCount = 0;

  // Get last sync time (or epoch if force)
  const lastSyncStr = force ? null : await env.TOKENS.get('drive_last_sync');
  const lastSync = lastSyncStr ? new Date(lastSyncStr) : new Date(0);

  // Sync heart rate (limit to most recent 200 readings to avoid rate limits)
  if (env.DRIVE_FOLDER_HEART_RATE) {
    const files = await listDriveFiles(accessToken, env.DRIVE_FOLDER_HEART_RATE);
    for (const file of files) {
      if (new Date(file.modifiedTime) > lastSync) {
        const csv = await downloadDriveFile(accessToken, file.id);
        const readings = parseHeartRateCsv(csv).slice(0, 200);
        for (const reading of readings) {
          await storeReading(env, { type: 'heart_rate', timestamp: reading.timestamp, data: reading });
          hrCount++;
        }
      }
    }
  }

  // Sync sleep
  if (env.DRIVE_FOLDER_SLEEP) {
    const files = await listDriveFiles(accessToken, env.DRIVE_FOLDER_SLEEP);
    for (const file of files) {
      if (new Date(file.modifiedTime) > lastSync) {
        const csv = await downloadDriveFile(accessToken, file.id);
        const reading = parseSleepCsv(csv);
        if (reading) {
          await storeReading(env, { type: 'sleep', timestamp: reading.timestamp, data: reading });
          sleepCount++;
        }
      }
    }
  }

  // Sync steps (limit to most recent 100 readings)
  if (env.DRIVE_FOLDER_STEPS) {
    const files = await listDriveFiles(accessToken, env.DRIVE_FOLDER_STEPS);
    for (const file of files) {
      if (new Date(file.modifiedTime) > lastSync) {
        const csv = await downloadDriveFile(accessToken, file.id);
        const readings = parseStepsCsv(csv).slice(0, 100);
        for (const reading of readings) {
          await storeReading(env, { type: 'steps', timestamp: reading.timestamp, data: reading });
          stepsCount++;
        }
      }
    }
  }

  // Update last sync time
  await env.TOKENS.put('drive_last_sync', new Date().toISOString());

  return { heart_rate: hrCount, sleep: sleepCount, steps: stepsCount };
}

// ========== KV Storage ==========

function getKvKey(type: string, timestamp: string): string {
  return `reading:${type}:${timestamp}`;
}

function getKvPrefix(type: string): string {
  return `reading:${type}:`;
}

async function storeReading(env: Env, payload: PushPayload): Promise<void> {
  const key = getKvKey(payload.type, payload.timestamp);
  const ttl = 30 * 24 * 60 * 60; // 30 days
  await env.TOKENS.put(key, JSON.stringify(payload.data), { expirationTtl: ttl });

  await env.TOKENS.put(`latest:${payload.type}`, JSON.stringify({
    timestamp: payload.timestamp,
    data: payload.data,
  }), { expirationTtl: ttl });
}

async function getReadings(env: Env, type: string, hours: number = 24): Promise<Array<{ timestamp: string; data: unknown }>> {
  const readings: Array<{ timestamp: string; data: unknown }> = [];
  const cutoffTime = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();

  const prefix = getKvPrefix(type);
  let cursor: string | undefined;

  do {
    const result = await env.TOKENS.list({ prefix, cursor });

    for (const key of result.keys) {
      const timestamp = key.name.replace(prefix, '');
      if (timestamp >= cutoffTime) {
        const value = await env.TOKENS.get(key.name);
        if (value) {
          readings.push({ timestamp, data: JSON.parse(value) });
        }
      }
    }

    cursor = result.list_complete ? undefined : result.cursor;
  } while (cursor);

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
    source: 'health_sync_drive',
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
    source: 'health_sync_drive',
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
    source: 'health_sync_drive',
  };
}

async function getStress(env: Env, hours: number = 24): Promise<unknown> {
  const readings = await getReadings(env, 'stress', hours);
  const latest = await getLatestReading(env, 'stress');

  return {
    latest: latest ? { time: latest.timestamp, level: (latest.data as StressReading).level } : null,
    history: readings.slice(0, 20).map(r => ({ time: r.timestamp, level: (r.data as StressReading).level })),
    period_hours: hours,
    source: 'health_sync_drive',
  };
}

// ========== MCP Tools ==========

const TOOLS = [
  {
    name: 'biometrics_heart_rate',
    description: "Get Mai's heart rate data from her Galaxy Fit3 via Health Sync",
    inputSchema: {
      type: 'object',
      properties: {
        hours: { type: 'number', description: 'Hours of history (default 24)', default: 24 },
      },
    },
  },
  {
    name: 'biometrics_sleep',
    description: "Get Mai's sleep data - duration and stages (light, deep, REM, awake)",
    inputSchema: {
      type: 'object',
      properties: {
        days: { type: 'number', description: 'Days of history (default 1)', default: 1 },
      },
    },
  },
  {
    name: 'biometrics_steps',
    description: "Get Mai's step count",
    inputSchema: {
      type: 'object',
      properties: {
        days: { type: 'number', description: 'Days of history (default 1)', default: 1 },
      },
    },
  },
  {
    name: 'biometrics_stress',
    description: "Get Mai's stress level data",
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
    description: "Trigger a manual sync from Google Drive",
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
      return syncFromDrive(env);
    case 'biometrics_status': {
      const latestHr = await getLatestReading(env, 'heart_rate');
      const latestSleep = await getLatestReading(env, 'sleep');
      const latestSteps = await getLatestReading(env, 'steps');
      const lastDriveSync = await env.TOKENS.get('drive_last_sync');

      return {
        connected: true,
        source: 'health_sync_drive',
        last_drive_sync: lastDriveSync || null,
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
            serverInfo: { name: 'biometrics-cloud', version: '3.0.0' },
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
      const lastSync = await env.TOKENS.get('drive_last_sync');
      return new Response(JSON.stringify({
        status: 'ok',
        service: 'biometrics-cloud',
        version: '3.0.0',
        source: 'health_sync_drive',
        has_data: !!latestHr,
        last_reading: latestHr?.timestamp || null,
        last_drive_sync: lastSync || null,
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
        const force = url.searchParams.get('force') === 'true';
        const result = await syncFromDrive(env, force);
        return new Response(JSON.stringify({ success: true, synced: result }), {
          headers: { 'Content-Type': 'application/json', ...corsHeaders },
        });
      } catch (e) {
        return new Response(JSON.stringify({ error: e instanceof Error ? e.message : String(e) }), {
          status: 500, headers: { 'Content-Type': 'application/json', ...corsHeaders },
        });
      }
    }

    // Push endpoint (legacy - keep for Android app if needed)
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
          for (const reading of batch.readings) {
            await storeReading(env, reading);
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

    // Debug: list files in a folder
    if (url.pathname === '/debug/files' && request.method === 'GET') {
      if (!validateApiKey(request, env)) {
        return new Response(JSON.stringify({ error: 'Unauthorized' }), {
          status: 401, headers: { 'Content-Type': 'application/json', ...corsHeaders },
        });
      }

      try {
        const accessToken = await getGoogleAccessToken(env);
        const folderId = url.searchParams.get('folder') || env.DRIVE_FOLDER_HEART_RATE;

        // List ALL files, not just CSVs
        const query = encodeURIComponent(`'${folderId}' in parents`);
        const response = await fetch(
          `https://www.googleapis.com/drive/v3/files?q=${query}&fields=files(id,name,mimeType,modifiedTime)&orderBy=modifiedTime desc&pageSize=20`,
          { headers: { Authorization: `Bearer ${accessToken}` } }
        );

        const data = await response.json();
        return new Response(JSON.stringify({ folderId, ...data }, null, 2), {
          headers: { 'Content-Type': 'application/json', ...corsHeaders },
        });
      } catch (e) {
        return new Response(JSON.stringify({ error: e instanceof Error ? e.message : String(e) }), {
          status: 500, headers: { 'Content-Type': 'application/json', ...corsHeaders },
        });
      }
    }

    // Info page
    if (url.pathname === '/') {
      const latestHr = await getLatestReading(env, 'heart_rate');
      const lastSync = await env.TOKENS.get('drive_last_sync');
      return new Response(JSON.stringify({
        service: 'Biometrics Cloud MCP',
        version: '3.0.0',
        source: 'health_sync_drive',
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

  // Cron handler - runs every 15 minutes
  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(syncFromDrive(env));
  },
};
