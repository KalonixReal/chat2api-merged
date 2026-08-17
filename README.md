# chat2api-merged

> **Windows. One double-click.** `start.bat` — installs everything, boots 4 daemons, launches the dashboard.
> Add your accounts → everything works. Multi-account + custom model names built in.

A fork of [xiaoY233/Chat2API](https://github.com/xiaoY233/Chat2API) with its built-in
reverse-engineering code for **Qwen, DeepSeek, Z.ai (GLM), and Kimi** replaced by
thin proxies to four actively-maintained standalone daemons, vendored under `vendor/`.

## What you get

- **One double-click**: `start.bat` auto-installs deps, boots daemons, launches Electron dashboard
- **Multi-account per provider**: add multiple Qwen/DeepSeek/Z.ai/Kimi accounts → automatic round-robin + failover
- **Custom model names**: rename any model (e.g. `qwen3-max` → `my-coder`) via the Models page
- **Smart account switching**: mid-request failover on throttle, recovery sequence (token refresh → stored creds → browser profile)
- **Session affinity**: same Qwen Code session reuses the same upstream chat (no context re-send)
- **CAPTCHA human-in-loop**: dashboard banner + "Solve Now" button when automation can't proceed
- **Notifications**: bell icon + toast popups for throttle/captcha/recovery events

## Prerequisites (only two)

1. **Bun** ≥ 1.3 — install: `powershell -c "irm bun.sh/install.ps1 | iex"` or from https://bun.sh
2. **Python 3.9+** — for the DeepSeek daemon (most systems have it)

That's it. No Go, no git, no WSL. The GLM binary is pre-compiled for Windows.

## Quick start

```bat
:: Double-click start.bat, OR in a terminal:
git clone <repo> chat2api-merged
cd chat2api-merged
start.bat
```

**First run** (~2-3 min): auto-installs all deps → boots 4 daemons → launches dashboard.
**Subsequent runs** (~5 sec): boots daemons + launches dashboard.

## The dashboard

The Electron app opens to a dashboard with these pages:

| Page | What it does |
|---|---|
| **Provider Setup** | Add credentials for each provider (email/password, JWT token, or browser login). Shows CAPTCHA banner when needed. |
| **Models** | Rename models, add custom model names, map model IDs |
| **Dashboard** | Overview of daemon health, request stats, account status |
| **Notifications** | Bell icon in header — recent alerts (throttle, captcha, recovery) |
| **Proxy Settings** | Configure the unified `/v1` endpoint port |
| **Session Management** | View active sessions, context management |

## Multi-account support

Each provider supports multiple accounts:

- **Qwen**: Add multiple email/password pairs via the Provider Setup page → qwengate round-robins between them, auto-fails-over on throttle
- **DeepSeek**: One browser login session at a time (Playwright profile-based)
- **Z.ai/GLM**: One JWT token (guest mode works without it for `glm-4.7`)
- **Kimi**: Multiple JWT/refresh tokens (comma-separated, daemon picks randomly per request)

The **Smart Account Switcher** in the proxy layer:
1. Detects throttle (HTTP 429/403/401) mid-request
2. Marks the account throttled (with cooldown)
3. Picks the next healthy account (same provider first, cross-provider fallback)
4. Re-forwards the request with full message history (context.txt mode)
5. Runs recovery on the failed account (token refresh → stored creds → browser profile)
6. If all recovery fails → emits CAPTCHA alert → dashboard banner appears

## Custom model names

The **Models** page lets you:
- Rename any model's display name (e.g. `qwen3-max` → `my-coder`)
- The proxy maps incoming `model: "my-coder"` → actual model ID
- Add custom model entries that map to any provider's model
- Remove/disable models you don't want exposed

## Point Qwen Code at it

```jsonc
// ~/.qwen/settings.json
{
  "modelProviders": {
    "chat2api-merged": [
      { "id": "qwen3-max",      "envKey": "C2A_KEY", "baseUrl": "http://localhost:8080/v1" },
      { "id": "deepseek-chat",  "envKey": "C2A_KEY", "baseUrl": "http://localhost:8080/v1" },
      { "id": "glm-4.7",        "envKey": "C2A_KEY", "baseUrl": "http://localhost:8080/v1" },
      { "id": "kimi-k2.6",      "envKey": "C2A_KEY", "baseUrl": "http://localhost:8080/v1" }
    ]
  },
  "providerProtocol": { "chat2api-merged": "openai" }
}
```
```bat
set C2A_KEY=anything
qwen
```

## Architecture

```
Qwen Code / Cursor / Claude Code / curl
            │
            ▼
┌──────────────────────────────────────────────────┐
│  Chat2API Electron app (:8080)                    │
│  ├─ Dashboard UI (Provider Setup, Models, etc.)  │
│  ├─ Proxy server (Koa, OpenAI /v1/...)            │
│  ├─ SmartSwitcher (session affinity + failover)   │
│  ├─ NotificationManager (bell + toasts + CAPTCHA)  │
│  ├─ forwarder.ts → routes by provider id          │
│  ├─ adapters/*.ts → thin ProxyAdapter subclasses  │
│  └─ supervisor/ → spawns + health-checks daemons  │
└──────────────────────────────────────────────────┘
            │  HTTP forward (OpenAI format, passthrough SSE)
            ▼
┌────────────┬────────────┬────────────┬────────────┐
│ qwen-gate  │ deepseek-  │ glm-free-  │ kimi-free- │
│  :26405    │ api :8000  │ api :3001  │ api :5566  │
│  (Bun)     │ (Python    │ (Go .exe,  │ (Bun)      │
│            │  venv)     │  pre-built)│            │
└────────────┴────────────┴────────────┴────────────┘
```

## File map

```
src/main/proxy/
├── adapters/
│   ├── proxyAdapter.ts          ← generic HTTP forwarder (~220 LOC)
│   ├── proxyStreamHandler.ts    ← passthrough SSE handler (~80 LOC)
│   ├── qwen.ts, qwen-ai.ts     ← thin configs (extend ProxyAdapter)
│   ├── deepseek.ts, glm.ts, zai.ts, kimi.ts
│   └── (mimo, minimax, perplexity — unchanged from upstream)
├── forwarder.ts                  ← dispatch + smart switching integration
├── smartSwitcher.ts              ← session affinity + failover + recovery (1170 LOC)
├── modelMapper.ts                ← custom model name mapping
└── loadbalancer.ts               ← multi-account round-robin

src/main/supervisor/
├── DaemonSupervisor.ts           ← spawns + health-checks 4 daemons (Windows paths)
├── autoBootstrap.ts              ← runs `bun run.ts install` if deps missing
└── index.ts

src/main/notifications/
└── NotificationManager.ts        ← bell + toast + desktop notifications (552 LOC)

src/main/ipc/
├── providerSetup.ts              ← credential entry IPC (Qwen/DeepSeek/Z.ai/Kimi)
├── notifications.ts              ← notification + CAPTCHA solve IPC
├── supervisor.ts                 ← daemon status IPC
└── handlers.ts                   ← wires everything on app boot

src/renderer/src/
├── components/notifications/
│   ├── NotificationToast.tsx     ← bottom-right toasts
│   ├── CaptchaBanner.tsx         ← top-of-page CAPTCHA alert
│   └── NotificationBell.tsx      ← header bell with count badge
├── pages/
│   ├── ProviderSetup.tsx         ← 4 provider cards + credential forms
│   ├── Models.tsx                ← custom model name editor
│   └── SessionManagement.tsx     ← session/context management
└── components/models/
    └── ModelEditor.tsx           ← rename/add/remove models

vendor/                           ← 4 standalone daemons (pre-built for Windows)
├── qwen-gate/                    (TS, bun install on first run)
├── deepseek-api/                 (Python, venv created on first run)
├── glm-free-api/                 (Go .exe pre-built — no Go needed)
│   ├── zai-api-windows-amd64.exe (committed)
│   ├── captcha-collector-windows-amd64.exe (committed)
│   └── zai-api.exe               (copied by run.ts)
└── kimi-free-api/                (TS, bun install on first run)

start.bat                         ← Windows double-click launcher
run.ts                            ← cross-platform installer + daemon booter
```

## Operations

| Action | Command |
|---|---|
| Start everything | Double-click `start.bat` |
| Start daemons only | `bun run.ts daemons` |
| Check daemon health | `bun run.ts check` |
| Re-run install | `bun run.ts install` |
| Update a daemon | `cd vendor\qwen-gate && git pull && cd ..\.. && bun run.ts install` |
| View logs | `logs\` folder (qwen-gate.log, deepseek-api.log, etc.) |

## Honest caveats

1. **You need accounts** for each provider's web chat. Daemons reverse-engineer the web session, not bypass auth. Use throwaway accounts.
2. **CAPTCHA is the failure point.** Each daemon handles it differently. If a daemon breaks, it breaks at the upstream level — fix it in the vendored repo.
3. **First-run download**: Playwright Chromium (~150MB) + pre-built GLM binary (~34MB) + Python deps (~80MB) + node_modules (~200MB) = ~500MB total. Subsequent runs are instant.
4. **Mimo / MiniMax / Perplexity** providers in Chat2API are untouched (use original adapters). Not part of this merge.

## License

Chat2API is GPL-3.0. This fork inherits GPL-3.0. Vendored daemons retain their own licenses.
