import express from "express";
import cors from "cors";
import path from "path";
import fs from "fs";
import { nanoid } from "nanoid";
import {
  ROOT,
  ensureDirs,
  loadLinks,
  saveLinks,
  getLink,
  isValidLinkId,
  isExpired,
  linkPublicView,
  deleteLink,
  withStoreLock,
  purgeExpired,
} from "./store.js";

const PORT = Number(process.env.PORT) || 5090;
const HOST = process.env.HOST || "127.0.0.1";
const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || "").replace(/\/$/, "");
const CORS_ORIGIN = process.env.CORS_ORIGIN || "";
const MAX_URL_LENGTH = 2048;

/** Preset TTL in ms. `never` / empty / 0 = no expiry. */
const TTL_PRESETS = {
  never: null,
  "1h": 60 * 60 * 1000,
  "24h": 24 * 60 * 60 * 1000,
  "7d": 7 * 24 * 60 * 60 * 1000,
  "30d": 30 * 24 * 60 * 60 * 1000,
};

const CSP = [
  "default-src 'self'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "object-src 'none'",
  "img-src 'self' data:",
  "font-src 'self' https://fonts.gstatic.com",
  "style-src 'self' https://fonts.googleapis.com 'unsafe-inline'",
  "script-src 'self'",
  "connect-src 'self'",
].join("; ");

await ensureDirs();

const app = express();
app.disable("x-powered-by");

const TRUST_PROXY = /^(1|true|yes)$/i.test(String(process.env.TRUST_PROXY || ""));
if (TRUST_PROXY) app.set("trust proxy", 1);

app.use((_req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Permissions-Policy", "geolocation=(), microphone=(), camera=()");
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Content-Security-Policy", CSP);
  next();
});

if (CORS_ORIGIN) {
  const allowed = CORS_ORIGIN.split(",").map((s) => s.trim()).filter(Boolean);
  app.use(
    cors({
      origin(origin, cb) {
        if (!origin || allowed.includes(origin)) return cb(null, true);
        return cb(null, false);
      },
    }),
  );
}

app.use(express.json({ limit: "16kb" }));

/** Simple sliding-window rate limiter (per key). */
function createRateLimiter({ windowMs, max }) {
  const hits = new Map();
  return function rateLimit(key) {
    const now = Date.now();
    let bucket = hits.get(key);
    if (!bucket || now - bucket.start >= windowMs) {
      bucket = { start: now, count: 0 };
    }
    bucket.count += 1;
    hits.set(key, bucket);
    if (hits.size > 5000) {
      for (const [k, v] of hits) {
        if (now - v.start >= windowMs) hits.delete(k);
      }
    }
    return bucket.count <= max;
  };
}

const createLimiter = createRateLimiter({ windowMs: 15 * 60 * 1000, max: 40 });
const apiLimiter = createRateLimiter({ windowMs: 60 * 1000, max: 120 });

function clientIp(req) {
  if (TRUST_PROXY) {
    const xf = req.headers["x-forwarded-for"];
    if (typeof xf === "string" && xf.trim()) return xf.split(",")[0].trim();
  }
  return req.socket?.remoteAddress || "unknown";
}

function clientError(res, status, message) {
  return res.status(status).json({ error: message });
}

/**
 * Accept only http(s) URLs. Reject javascript:, data:, file:, etc.
 * @returns {{ ok: true, url: string } | { ok: false, error: string }}
 */
function validateTargetUrl(raw) {
  if (typeof raw !== "string") {
    return { ok: false, error: "URL is required" };
  }
  const trimmed = raw.trim();
  if (!trimmed) {
    return { ok: false, error: "URL is required" };
  }
  if (trimmed.length > MAX_URL_LENGTH) {
    return { ok: false, error: `URL too long (max ${MAX_URL_LENGTH} characters)` };
  }
  // Block dangerous schemes before URL parsing edge cases
  const lower = trimmed.toLowerCase();
  if (
    lower.startsWith("javascript:") ||
    lower.startsWith("data:") ||
    lower.startsWith("vbscript:") ||
    lower.startsWith("file:") ||
    lower.startsWith("blob:")
  ) {
    return { ok: false, error: "Only http and https URLs are allowed" };
  }

  let parsed;
  try {
    parsed = new URL(trimmed);
  } catch {
    return { ok: false, error: "Invalid URL" };
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { ok: false, error: "Only http and https URLs are allowed" };
  }
  if (!parsed.hostname) {
    return { ok: false, error: "Invalid URL" };
  }

  return { ok: true, url: parsed.toString() };
}

function validateSlug(raw) {
  if (raw == null || raw === "") return { ok: true, slug: null };
  if (typeof raw !== "string") {
    return { ok: false, error: "Slug must be a string" };
  }
  const slug = raw.trim();
  if (!slug) return { ok: true, slug: null };
  if (!isValidLinkId(slug)) {
    return {
      ok: false,
      error: "Slug must be 3–32 characters: letters, numbers, _ or -",
    };
  }
  return { ok: true, slug };
}

/**
 * Body field `ttl`: never | 1h | 24h | 7d | 30d
 * Or `expiresIn` seconds (number), or `expiresAt` ISO string.
 */
function resolveExpiry(body) {
  if (body?.expiresAt != null && body.expiresAt !== "") {
    const t = Date.parse(String(body.expiresAt));
    if (Number.isNaN(t)) return { ok: false, error: "Invalid expiresAt" };
    if (t <= Date.now()) return { ok: false, error: "expiresAt must be in the future" };
    return { ok: true, expiresAt: new Date(t).toISOString() };
  }
  if (body?.expiresIn != null && body.expiresIn !== "") {
    const sec = Number(body.expiresIn);
    if (!Number.isFinite(sec) || sec <= 0) {
      return { ok: false, error: "expiresIn must be a positive number of seconds" };
    }
    return { ok: true, expiresAt: new Date(Date.now() + sec * 1000).toISOString() };
  }
  const ttlRaw = body?.ttl == null || body.ttl === "" ? "never" : String(body.ttl).trim();
  if (!(ttlRaw in TTL_PRESETS)) {
    return {
      ok: false,
      error: "ttl must be one of: never, 1h, 24h, 7d, 30d",
    };
  }
  const ms = TTL_PRESETS[ttlRaw];
  if (ms == null) return { ok: true, expiresAt: null };
  return { ok: true, expiresAt: new Date(Date.now() + ms).toISOString() };
}

app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    service: "linkkit",
    version: "1.0.0",
  });
});

app.get("/api/links", async (req, res) => {
  const ip = clientIp(req);
  if (!apiLimiter(`list:${ip}`)) {
    return clientError(res, 429, "Too many requests. Try again later.");
  }

  try {
    const data = await loadLinks();
    const links = Object.entries(data.links)
      .filter(([, link]) => !isExpired(link))
      .map(([id, link]) =>
        linkPublicView(id, link, { publicBaseUrl: PUBLIC_BASE_URL, port: PORT }),
      )
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    res.json({ links });
    // Opportunistic cleanup (don't block response)
    purgeExpired().catch(() => {});
  } catch (err) {
    console.error("[Linkkit] list failed:", err.message);
    clientError(res, 500, "Failed to list links");
  }
});

app.post("/api/links", async (req, res) => {
  const ip = clientIp(req);
  if (!createLimiter(`create:${ip}`)) {
    return clientError(res, 429, "Too many links. Try again later.");
  }

  try {
    const urlResult = validateTargetUrl(req.body?.url);
    if (!urlResult.ok) return clientError(res, 400, urlResult.error);

    const slugResult = validateSlug(req.body?.slug);
    if (!slugResult.ok) return clientError(res, 400, slugResult.error);

    const expiryResult = resolveExpiry(req.body || {});
    if (!expiryResult.ok) return clientError(res, 400, expiryResult.error);

    const result = await withStoreLock(async () => {
      const data = await loadLinks();
      let id = slugResult.slug;
      if (id) {
        const existing = data.links[id];
        if (existing && !isExpired(existing)) {
          return { ok: false, status: 409, error: "Slug already taken" };
        }
        // Reclaim slug if previous link expired
        if (existing && isExpired(existing)) {
          delete data.links[id];
        }
      } else {
        do {
          id = nanoid(8);
        } while (
          Object.prototype.hasOwnProperty.call(data.links, id) &&
          !isExpired(data.links[id])
        );
        if (
          Object.prototype.hasOwnProperty.call(data.links, id) &&
          isExpired(data.links[id])
        ) {
          delete data.links[id];
        }
      }

      const link = {
        url: urlResult.url,
        createdAt: new Date().toISOString(),
        clicks: 0,
        expiresAt: expiryResult.expiresAt,
      };
      data.links[id] = link;
      await saveLinks(data);
      return { ok: true, id, link };
    });

    if (!result.ok) return clientError(res, result.status, result.error);

    res.status(201).json(
      linkPublicView(result.id, result.link, {
        publicBaseUrl: PUBLIC_BASE_URL,
        port: PORT,
      }),
    );
  } catch (err) {
    console.error("[Linkkit] create failed:", err.message);
    clientError(res, 500, "Failed to create link");
  }
});

app.get("/api/links/:id", async (req, res) => {
  const ip = clientIp(req);
  if (!apiLimiter(`get:${ip}`)) {
    return clientError(res, 429, "Too many requests. Try again later.");
  }

  try {
    const id = req.params.id;
    if (!isValidLinkId(id)) return clientError(res, 404, "Link not found");

    const data = await loadLinks();
    const link = getLink(data, id);
    if (!link) return clientError(res, 404, "Link not found");
    if (isExpired(link)) {
      await deleteLink(id);
      return clientError(res, 410, "Link expired");
    }

    res.json(
      linkPublicView(id, link, { publicBaseUrl: PUBLIC_BASE_URL, port: PORT }),
    );
  } catch (err) {
    console.error("[Linkkit] get failed:", err.message);
    clientError(res, 500, "Failed to load link");
  }
});

app.delete("/api/links/:id", async (req, res) => {
  const ip = clientIp(req);
  if (!apiLimiter(`delete:${ip}`)) {
    return clientError(res, 429, "Too many requests. Try again later.");
  }

  try {
    const id = req.params.id;
    if (!isValidLinkId(id)) return clientError(res, 404, "Link not found");

    const deleted = await deleteLink(id);
    if (!deleted) return clientError(res, 404, "Link not found");

    res.json({ ok: true, id });
  } catch (err) {
    console.error("[Linkkit] delete failed:", err.message);
    clientError(res, 500, "Failed to delete link");
  }
});

app.get("/r/:id", async (req, res) => {
  try {
    const id = req.params.id;
    if (!isValidLinkId(id)) {
      return res.status(404).type("text").send("Link not found");
    }

    const target = await withStoreLock(async () => {
      const data = await loadLinks();
      const link = getLink(data, id);
      if (!link) return { kind: "missing" };
      if (isExpired(link)) {
        delete data.links[id];
        await saveLinks(data);
        return { kind: "expired" };
      }
      link.clicks = (link.clicks || 0) + 1;
      data.links[id] = link;
      await saveLinks(data);
      return { kind: "ok", url: link.url };
    });

    if (target.kind === "missing") {
      return res.status(404).type("text").send("Link not found");
    }
    if (target.kind === "expired") {
      return res.status(410).type("text").send("Link expired");
    }

    res.redirect(302, target.url);
  } catch (err) {
    console.error("[Linkkit] redirect failed:", err.message);
    if (!res.headersSent) {
      res.status(500).type("text").send("Redirect failed");
    }
  }
});

const dist = path.join(ROOT, "client", "dist");
if (fs.existsSync(dist)) {
  app.use(express.static(dist));
  app.get(/^(?!\/api)(?!\/r).*/, (_req, res) => {
    res.sendFile(path.join(dist, "index.html"));
  });
}

app.listen(PORT, HOST, () => {
  console.log(`Linkkit listening on http://${HOST}:${PORT}`);
  if (PUBLIC_BASE_URL) {
    console.log(`  short links: ${PUBLIC_BASE_URL}/r/{id}`);
  }
  purgeExpired()
    .then((n) => {
      if (n) console.log(`[Linkkit] purged ${n} expired link(s)`);
    })
    .catch((err) => console.error("[Linkkit] purge failed:", err.message));
  setInterval(() => {
    purgeExpired().catch((err) =>
      console.error("[Linkkit] purge failed:", err.message),
    );
  }, 15 * 60 * 1000).unref?.();
});
