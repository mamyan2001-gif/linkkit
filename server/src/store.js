import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(__dirname, "../..");
export const DATA_DIR = path.join(ROOT, "data");
export const META_FILE = path.join(DATA_DIR, "links.json");

/** Auto-generated nanoid ids and custom slugs share this pattern. */
export const LINK_ID_RE = /^[A-Za-z0-9_-]{3,32}$/;

let writeChain = Promise.resolve();

/** Serialize all metadata reads/writes to avoid lost updates. */
export function withStoreLock(fn) {
  const run = writeChain.then(fn, fn);
  writeChain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

export function isValidLinkId(id) {
  return typeof id === "string" && LINK_ID_RE.test(id);
}

export async function ensureDirs() {
  await fs.mkdir(DATA_DIR, { recursive: true });
  try {
    await fs.access(META_FILE);
  } catch {
    await fs.writeFile(META_FILE, JSON.stringify({ links: {} }, null, 2), "utf8");
  }
}

function normalizeLink(raw) {
  if (!raw || typeof raw !== "object") return null;
  const url = typeof raw.url === "string" ? raw.url.trim() : "";
  if (!url) return null;
  const clicks = Math.max(0, Math.floor(Number(raw.clicks) || 0));
  return {
    url,
    createdAt: typeof raw.createdAt === "string" ? raw.createdAt : new Date().toISOString(),
    clicks,
  };
}

function normalizeLinks(raw) {
  const links = Object.create(null);
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return links;
  for (const [id, link] of Object.entries(raw)) {
    if (!isValidLinkId(id)) continue;
    const normalized = normalizeLink(link);
    if (normalized) links[id] = normalized;
  }
  return links;
}

export async function loadLinks() {
  await ensureDirs();
  let raw;
  try {
    raw = await fs.readFile(META_FILE, "utf8");
  } catch {
    return { links: Object.create(null) };
  }
  try {
    const data = JSON.parse(raw);
    return { links: normalizeLinks(data?.links) };
  } catch (err) {
    console.error("[Linkkit] corrupt links.json, starting empty:", err.message);
    return { links: Object.create(null) };
  }
}

export async function saveLinks(data) {
  await ensureDirs();
  const payload = { links: normalizeLinks(data?.links) };
  const tmp = `${META_FILE}.${process.pid}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(payload, null, 2), "utf8");
  await fs.rename(tmp, META_FILE);
}

export function getLink(data, id) {
  if (!isValidLinkId(id)) return null;
  if (!Object.prototype.hasOwnProperty.call(data.links, id)) return null;
  return data.links[id];
}

export function linkPublicView(id, link, { publicBaseUrl, port } = {}) {
  const shortPath = `/r/${id}`;
  const base = (publicBaseUrl || "").replace(/\/$/, "") || `http://127.0.0.1:${port || 5090}`;
  return {
    id,
    url: link.url,
    createdAt: link.createdAt,
    clicks: link.clicks || 0,
    shortPath,
    shortUrl: `${base}${shortPath}`,
  };
}

export async function deleteLink(id) {
  if (!isValidLinkId(id)) return false;
  return withStoreLock(async () => {
    const data = await loadLinks();
    if (!Object.prototype.hasOwnProperty.call(data.links, id)) return false;
    delete data.links[id];
    await saveLinks(data);
    return true;
  });
}
