import http from 'node:http';

const PORT = Number(process.env.PORT || 3000);
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type, X-Requested-With',
  'Access-Control-Max-Age': '86400',
};

function send(res, status, data, headers = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', ...corsHeaders, ...headers });
  res.end(typeof data === 'string' ? data : JSON.stringify(data));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => {
      body += chunk;
      if (body.length > 2_000_000) {
        reject(new Error('El cuerpo supera el límite de 2 MB'));
        req.destroy();
      }
    });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

function cleanBase(value) {
  return (value || 'https://integrate.api.nvidia.com/v1').trim().replace(/\/+$/, '');
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  if (req.method === 'OPTIONS') {
    res.writeHead(204, corsHeaders);
    return res.end();
  }
  if (url.pathname === '/' || url.pathname === '/health') {
    return send(res, 200, { ok: true, service: 'Subtom API bridge', platform: 'Railway' });
  }
  if (url.pathname === '/config') {
    const missing = [
      !process.env.AI_API_KEY_1 && 'AI_API_KEY_1',
      !process.env.AI_MODEL_1 && 'AI_MODEL_1',
      !process.env.AI_API_BASE_URL_1 && 'AI_API_BASE_URL_1',
    ].filter(Boolean);
    return send(res, missing.length ? 503 : 200, {
      ok: missing.length === 0,
      features: { chat: missing.length === 0 },
      model: process.env.AI_MODEL_1 || null,
      provider: process.env.AI_PROVIDER || null,
      missing,
    });
  }
  if (!url.pathname.startsWith('/v1/')) {
    return send(res, 404, { error: { message: 'Ruta no encontrada' } });
  }
  if (req.method !== 'POST') {
    return send(res, 405, { error: { message: 'Método no permitido; usa POST' } }, { Allow: 'POST, OPTIONS' });
  }
  const missing = [!process.env.AI_API_KEY_1 && 'AI_API_KEY_1', !process.env.AI_MODEL_1 && 'AI_MODEL_1'].filter(Boolean);
  if (missing.length) return send(res, 503, { error: { message: `Faltan variables: ${missing.join(', ')}` } });

  let body;
  try {
    body = JSON.parse(await readBody(req));
  } catch (error) {
    return send(res, 400, { error: { message: error.message === 'El cuerpo supera el límite de 2 MB' ? error.message : 'El cuerpo debe ser JSON válido' } });
  }
  if (!body || !Array.isArray(body.messages)) {
    return send(res, 400, { error: { message: "Se requiere un array 'messages' compatible con Chat Completions" } });
  }

  body.model = process.env.AI_MODEL_1;
  const endpoint = `${cleanBase(process.env.AI_API_BASE_URL_1)}/chat/completions`;
  let upstream;
  try {
    const timeoutSeconds = Math.max(1, Number(process.env.AI_TIMEOUT_SECONDS || 90));
    upstream = await fetch(endpoint, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.AI_API_KEY_1}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutSeconds * 1000),
    });
  } catch (error) {
    return send(res, 502, { error: { message: 'No se pudo conectar con el proveedor de IA', detail: String(error?.message || error) } });
  }

  const responseBody = await upstream.text();
  res.writeHead(upstream.status, {
    ...corsHeaders,
    'Content-Type': upstream.headers.get('content-type') || 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(responseBody);
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Subtom API bridge listening on port ${PORT}`);
});
