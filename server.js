const http = require("http");
const fs = require("fs");
const path = require("path");

const HOST = process.env.HOST || "0.0.0.0";
const PORT = Number(process.env.PORT || 8080);
const ROOT = process.cwd();

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml",
};

loadDotEnvIfExists();

function loadDotEnvIfExists() {
  const envPath = path.join(ROOT, ".env");
  if (!fs.existsSync(envPath)) return;

  const lines = fs.readFileSync(envPath, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const idx = trimmed.indexOf("=");
    if (idx <= 0) continue;

    const key = trimmed.slice(0, idx).trim();
    const value = trimmed.slice(idx + 1).trim().replace(/^['"]|['"]$/g, "");
    if (!process.env[key]) process.env[key] = value;
  }
}

function sendJson(res, status, data) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 1_000_000) {
        reject(new Error("Request body too large"));
        req.destroy();
      }
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

async function handleTokenGrant(req, res) {
  const apiKey = process.env.DEEPGRAM_API_KEY;
  const allowBrowserKeyFallback = String(process.env.ALLOW_BROWSER_API_KEY_FALLBACK || "").toLowerCase() === "true";
  if (!apiKey) {
    sendJson(res, 500, {
      error: "DEEPGRAM_API_KEY is not configured",
      message: "환경변수 DEEPGRAM_API_KEY를 설정해 주세요.",
    });
    return;
  }

  try {
    const rawBody = await readBody(req);
    const parsed = rawBody ? JSON.parse(rawBody) : {};
    const ttlSeconds = Math.max(1, Math.min(3600, Number(parsed.ttl_seconds || 300)));

    const dgRes = await fetch("https://api.deepgram.com/v1/auth/grant", {
      method: "POST",
      headers: {
        Authorization: `Token ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ ttl_seconds: ttlSeconds }),
    });

    const text = await dgRes.text();
    let payload;
    try {
      payload = JSON.parse(text);
    } catch {
      payload = { raw: text };
    }

    if (!dgRes.ok) {
      const isPermissionDenied = payload?.err_code === "FORBIDDEN";
      if (isPermissionDenied && allowBrowserKeyFallback) {
        sendJson(res, 200, {
          auth_type: "api_key",
          access_token: apiKey,
          warning: "token grant 권한 부족으로 브라우저 API key 인증으로 대체됨",
        });
        return;
      }

      sendJson(res, dgRes.status, {
        error: "deepgram_grant_failed",
        detail: payload,
        hint:
          isPermissionDenied && !allowBrowserKeyFallback
            ? "키 권한이 부족합니다. 관리자 권한 키를 쓰거나 ALLOW_BROWSER_API_KEY_FALLBACK=true 설정 후 재시도하세요."
            : undefined,
      });
      return;
    }

    sendJson(res, 200, {
      auth_type: "token",
      access_token: payload.access_token,
      expires_in: payload.expires_in,
    });
  } catch (error) {
    sendJson(res, 500, {
      error: "token_grant_internal_error",
      message: error instanceof Error ? error.message : "unknown",
    });
  }
}

function resolveStaticPath(urlPath) {
  const cleanPath = decodeURIComponent(urlPath.split("?")[0]);
  const target = cleanPath === "/" ? "/index.html" : cleanPath;
  const absPath = path.resolve(path.join(ROOT, `.${target}`));
  if (!absPath.startsWith(ROOT)) return null;
  return absPath;
}

function serveStatic(req, res) {
  const absPath = resolveStaticPath(req.url || "/");
  if (!absPath) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }

  fs.stat(absPath, (err, stat) => {
    if (err || !stat.isFile()) {
      res.writeHead(404);
      res.end("Not Found");
      return;
    }

    const ext = path.extname(absPath).toLowerCase();
    const contentType = MIME_TYPES[ext] || "application/octet-stream";

    res.writeHead(200, { "Content-Type": contentType });
    fs.createReadStream(absPath).pipe(res);
  });
}

const server = http.createServer(async (req, res) => {
  if (!req.url) {
    res.writeHead(400);
    res.end("Bad Request");
    return;
  }

  if (req.method === "GET" && req.url === "/api/health") {
    sendJson(res, 200, {
      ok: true,
      deepgramConfigured: Boolean(process.env.DEEPGRAM_API_KEY),
    });
    return;
  }

  if (req.method === "POST" && req.url === "/api/deepgram/token") {
    await handleTokenGrant(req, res);
    return;
  }

  if (req.method === "GET" || req.method === "HEAD") {
    serveStatic(req, res);
    return;
  }

  res.writeHead(405);
  res.end("Method Not Allowed");
});

server.listen(PORT, HOST, () => {
  console.log(`MeetingReferee server running: http://${HOST}:${PORT}`);
  console.log("Deepgram token endpoint: POST /api/deepgram/token");
});
