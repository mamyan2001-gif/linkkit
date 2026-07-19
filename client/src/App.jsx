import { useCallback, useEffect, useState } from "react";

async function api(path, options = {}) {
  let res;
  try {
    res = await fetch(path, {
      ...options,
      headers: {
        ...(options.body ? { "Content-Type": "application/json" } : {}),
        ...(options.headers || {}),
      },
    });
  } catch {
    throw new Error("Cannot reach API");
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || res.statusText || "Request failed");
  return data;
}

function formatTime(iso) {
  try {
    return new Date(iso).toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return iso || "—";
  }
}

function truncateUrl(url, max = 48) {
  if (!url || url.length <= max) return url;
  return `${url.slice(0, max - 1)}…`;
}

function displayShort(link) {
  if (typeof window !== "undefined") {
    return `${window.location.origin}${link.shortPath}`;
  }
  return link.shortUrl || link.shortPath;
}

export default function App() {
  const [url, setUrl] = useState("");
  const [slug, setSlug] = useState("");
  const [links, setLinks] = useState([]);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [copiedId, setCopiedId] = useState("");
  const [deletingId, setDeletingId] = useState("");

  const refresh = useCallback(async () => {
    const data = await api("/api/links");
    setLinks(data.links || []);
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        await refresh();
      } catch (err) {
        if (!cancelled) setError(err.message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [refresh]);

  async function handleSubmit(e) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      const body = { url: url.trim() };
      const custom = slug.trim();
      if (custom) body.slug = custom;
      await api("/api/links", { method: "POST", body: JSON.stringify(body) });
      setUrl("");
      setSlug("");
      await refresh();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function handleCopy(link) {
    const text = displayShort(link);
    try {
      await navigator.clipboard.writeText(text);
      setCopiedId(link.id);
      window.setTimeout(() => setCopiedId((id) => (id === link.id ? "" : id)), 1600);
    } catch {
      setError("Could not copy to clipboard");
    }
  }

  async function handleDelete(id) {
    if (!window.confirm("Delete this short link?")) return;
    setDeletingId(id);
    setError("");
    try {
      await api(`/api/links/${id}`, { method: "DELETE" });
      await refresh();
    } catch (err) {
      setError(err.message);
    } finally {
      setDeletingId("");
    }
  }

  return (
    <div className="app">
      <header className="hero">
        <h1 className="brand">Linkkit</h1>
        <p className="lead">Shorten links. Track clicks. Host it yourself.</p>
      </header>

      <form className="composer" onSubmit={handleSubmit}>
        <div className="field field--url">
          <label htmlFor="url">Long URL</label>
          <input
            id="url"
            type="url"
            name="url"
            placeholder="https://example.com/very/long/path"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            required
            autoComplete="off"
            spellCheck={false}
          />
        </div>
        <div className="composer__row">
          <div className="field field--slug">
            <label htmlFor="slug">Custom slug (optional)</label>
            <input
              id="slug"
              type="text"
              name="slug"
              placeholder="my-link"
              value={slug}
              onChange={(e) => setSlug(e.target.value)}
              minLength={3}
              maxLength={32}
              pattern="[A-Za-z0-9_-]{3,32}"
              title="3–32 characters: letters, numbers, _ or -"
              autoComplete="off"
              spellCheck={false}
            />
          </div>
          <button className="btn btn-primary" type="submit" disabled={busy || !url.trim()}>
            {busy ? "Shortening…" : "Shorten"}
          </button>
        </div>
        {error && <div className="alert alert--error">{error}</div>}
      </form>

      <section className="links" aria-label="Your short links">
        <div className="links__head">
          <h2 className="links__title">Your links</h2>
          <span className="links__count">
            {loading ? "…" : `${links.length} link${links.length === 1 ? "" : "s"}`}
          </span>
        </div>

        {loading && <p className="muted">Loading…</p>}

        {!loading && links.length === 0 && (
          <p className="empty">No links yet. Paste a URL above to create one.</p>
        )}

        <ul className="link-list">
          {links.map((link, i) => (
            <li
              key={link.id}
              className="link-row"
              style={{ animationDelay: `${Math.min(i, 8) * 0.04}s` }}
            >
              <div className="link-row__main">
                <a className="link-row__short" href={link.shortPath} target="_blank" rel="noreferrer">
                  /r/{link.id}
                </a>
                <p className="link-row__target" title={link.url}>
                  {truncateUrl(link.url)}
                </p>
                <p className="link-row__meta">
                  <span className="clicks">
                    <strong>{link.clicks}</strong> click{link.clicks === 1 ? "" : "s"}
                  </span>
                  <span className="dot" aria-hidden="true">
                    ·
                  </span>
                  <time dateTime={link.createdAt}>{formatTime(link.createdAt)}</time>
                </p>
              </div>
              <div className="link-row__actions">
                <button
                  type="button"
                  className="btn btn-ghost"
                  onClick={() => handleCopy(link)}
                >
                  {copiedId === link.id ? "Copied" : "Copy"}
                </button>
                <button
                  type="button"
                  className="btn btn-danger"
                  onClick={() => handleDelete(link.id)}
                  disabled={deletingId === link.id}
                >
                  {deletingId === link.id ? "…" : "Delete"}
                </button>
              </div>
            </li>
          ))}
        </ul>
      </section>

      <footer className="foot">
        <span>Self-hosted · JSON storage · no database</span>
      </footer>
    </div>
  );
}
