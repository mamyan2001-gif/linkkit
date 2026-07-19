# Linkkit

![Stars](https://img.shields.io/github/stars/mamyan2001-gif/linkkit?style=social)
![Forks](https://img.shields.io/github/forks/mamyan2001-gif/linkkit?style=social)

![Node](https://img.shields.io/badge/Node-18+-339933)
![License](https://img.shields.io/badge/License-MIT-green)
![Docker](https://img.shields.io/badge/Docker-Compose-2496ED)

**Self-hosted URL shortener** — paste a long URL, get a short `/r/{id}` link, track click counts. Optional custom slugs. Inspired by YOURLS / Shlink, built as a tiny JSON-backed MVP.

## Features

- Shorten any **http(s)** URL (rejects `javascript:`, `data:`, and other schemes)
- Optional **custom slug** (`[a-zA-Z0-9_-]{3,32}`)
- **Click counts** incremented on every redirect
- Shareable short path: `/r/{id}`
- In-memory **rate limits** by IP on create and API reads
- Security headers (CSP, nosniff, frame deny, etc.)
- Docker Compose one-command deploy
- No database — `data/links.json` on disk

## Quick start (Docker)

```bash
cd Linkkit
docker compose up --build
# → http://localhost:5090
```

Production without Docker:

```bash
HOST=0.0.0.0 PORT=5090 \
  PUBLIC_BASE_URL=https://links.example.com \
  npm start
```

## Local development

```bash
npm run setup   # or: npm run install:all

# Terminal 1 — API
npm run dev:server   # :5090 (127.0.0.1)

# Terminal 2 — UI
npm run dev:client   # :5178 (proxies /api and /r)
```

Open **http://127.0.0.1:5178**.

## Configuration

| Env var | Default | Meaning |
|---------|---------|---------|
| `PORT` | `5090` | API / production UI port |
| `HOST` | `127.0.0.1` (Docker: `0.0.0.0`) | Listen address |
| `PUBLIC_BASE_URL` | (derived) | Base URL for absolute short links in API responses |
| `CORS_ORIGIN` | (off) | Comma-separated allowed origins if UI is on another host |
| `TRUST_PROXY` | (off) | Set `true` behind a reverse proxy so rate limits use `X-Forwarded-For` |

## API

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/health` | Health check → `{ ok, service: "linkkit" }` |
| GET | `/api/links` | List links → `{ links: [{ id, url, createdAt, clicks, shortPath, shortUrl }] }` |
| POST | `/api/links` | Create `{ url, slug? }` → link object |
| GET | `/api/links/:id` | Link detail + click count |
| DELETE | `/api/links/:id` | Delete link |
| GET | `/r/:id` | **302** redirect to target; increments `clicks` |

## Project layout

```
Linkkit/
├── client/          React + Vite UI
├── server/          Express API
├── data/            links.json (gitignored)
└── docker-compose.yml
```

## Security notes

- Run behind HTTPS; set rate limits on the reverse proxy as well
- Default bind is loopback (`127.0.0.1`); Docker sets `HOST=0.0.0.0`
- Only `http:` / `https:` targets are accepted
- Link IDs / slugs are validated before store access
- Do not enable `TRUST_PROXY` unless the proxy strips client-supplied `X-Forwarded-For`
- Security headers: `Content-Security-Policy`, `X-Content-Type-Options`, `Referrer-Policy`, `X-Frame-Options`, `Cache-Control: no-store`

## License

[MIT](LICENSE) © 2026 Artyom Mamyan
