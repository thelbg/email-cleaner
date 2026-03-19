# Email Spring Cleaner

A TypeScript CLI agent that bulk-archives unread Gmail clutter using Claude as a smart filter. It fetches your unread emails, asks Claude to group the obviously disposable ones by specific sender and pattern, then walks you through each group so you decide what to archive — one group at a time, with full control.

**Safety guarantee:** emails are never deleted. Archiving removes the `INBOX` and `UNREAD` labels only. Skipped emails are untouched.

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                          index.ts                               │
│                        (orchestrator)                           │
└──────┬──────────────┬───────────────┬───────────────────────────┘
       │              │               │
       ▼              ▼               ▼
 ┌──────────┐  ┌────────────┐  ┌─────────────┐  ┌──────────────┐
 │  auth.ts │  │  gmail.ts  │  │categorizer  │  │interactive   │
 │          │  │            │  │    .ts      │  │    .ts       │
 │ OAuth2   │  │ Gmail API  │  │ Claude API  │  │ readline CLI │
 │ browser  │  │ v1 client  │  │ (Opus 4.6)  │  │ y/n/q prompt │
 │  flow    │  │            │  │             │  │              │
 └────┬─────┘  └─────┬──────┘  └──────┬──────┘  └──────────────┘
      │               │                │
      ▼               │                ▼
 .token.json    ┌─────┴──────┐   Zod schema
 (persisted)    │ Gmail API  │   validation +
                │            │   ID dedup
                │ • list     │
                │ • get      │
                │ • batchMod │
                │ • labels   │
                └────────────┘
```

### Data flow

```
  ┌──────────────────────────────────────────────────────────────┐
  │  1. AUTHENTICATE                                             │
  │     Load .token.json  ──exists?──▶  use token (refresh if   │
  │           │                         expired)                 │
  │           │ no                                               │
  │           ▼                                                  │
  │     Open browser → Google consent → localhost:3000 captures  │
  │     auth code → exchange for token → save .token.json        │
  └──────────────────────────────────────────────────────────────┘
                            │
                            ▼
  ┌──────────────────────────────────────────────────────────────┐
  │  2. FETCH  (gmail.ts · fetchUnreadEmails)                    │
  │     messages.list(q:"is:unread") ──paginate──▶ up to 500 IDs│
  │     messages.get ×50 concurrent ──chunks──▶ EmailMetadata[]  │
  │     fields: id, from, subject, date, snippet                 │
  └──────────────────────────────────────────────────────────────┘
                            │
                            ▼
  ┌──────────────────────────────────────────────────────────────┐
  │  3. CATEGORIZE  (categorizer.ts · categorizeEmails)          │
  │     Send all metadata as JSON to claude-opus-4-6             │
  │     Extended thinking (8 000 token budget)                   │
  │     Claude groups by specific sender × pattern               │
  │     Ordered: most disposable + largest count first           │
  │     Response parsed + validated with Zod                     │
  │     IDs cross-checked against fetched set; duplicates pruned │
  └──────────────────────────────────────────────────────────────┘
                            │
                            ▼
  ┌──────────────────────────────────────────────────────────────┐
  │  4. INTERACTIVE LOOP  (interactive.ts · presentGroup)        │
  │     For each group:                                          │
  │       • Show name, description, count, 5 examples            │
  │       • Show unread count before → after                     │
  │       • Prompt: (y)es / (n)o / (q)uit                       │
  │       y → archiveEmails (batchModify removes INBOX+UNREAD)   │
  │       n → skip, touch nothing                                │
  │       q → stop loop                                          │
  └──────────────────────────────────────────────────────────────┘
                            │
                            ▼
  ┌──────────────────────────────────────────────────────────────┐
  │  5. SUMMARY                                                  │
  │     Total archived · Remaining unread                        │
  └──────────────────────────────────────────────────────────────┘
```

---

## File structure

```
email-cleaner/
├── index.ts              — orchestrator (steps 1–5 above)
├── package.json
├── tsconfig.json
├── .env.example          — environment variable template
├── .gitignore
└── src/
    ├── types.ts          — EmailMetadata, EmailGroup, CategorizationResult
    ├── auth.ts           — Gmail OAuth2 (browser flow, .token.json cache)
    ├── gmail.ts          — fetch unread emails, archive, get unread count
    ├── categorizer.ts    — Claude categorization with Zod schema validation
    └── interactive.ts    — readline CLI prompt per group
```

---

## Setup

### 1. Google Cloud credentials

1. Go to [Google Cloud Console](https://console.cloud.google.com/) and create a project.
2. Enable the **Gmail API** (`APIs & Services → Library → Gmail API → Enable`).
3. Create OAuth credentials: `APIs & Services → Credentials → Create Credentials → OAuth client ID`.
   - Application type: **Desktop app**
4. Download the client ID and secret.

### 2. Environment variables

```bash
cp .env.example .env
```

Edit `.env`:

```
GMAIL_CLIENT_ID=your_client_id_here
GMAIL_CLIENT_SECRET=your_client_secret_here
ANTHROPIC_API_KEY=your_anthropic_api_key_here
```

Get your Anthropic API key at [console.anthropic.com](https://console.anthropic.com/).

### 3. Install and run

```bash
npm install
npm start
```

On first run, your browser opens for Gmail authorization. After you approve, a token is saved to `.token.json` and reused on subsequent runs (auto-refreshed when expired).

---

## How it works in practice

### What Claude groups — and what it leaves alone

Claude is instructed to group by **specific sender + pattern**, not broad buckets:

| Grouped (safe to archive)               | Left alone (excluded)              |
|-----------------------------------------|------------------------------------|
| New York Times Morning Briefing         | Personal emails                    |
| ParkWhiz parking receipts               | Work correspondence                |
| GitHub Actions build notifications      | Receipts you might need            |
| Duolingo streak reminders               | Financial statements               |
| LinkedIn weekly digest                  | Anything ambiguous                 |

Groups are ordered so the most obviously disposable and largest wins come first.

### Interactive prompt

```
────────────────────────────────────────────────────────────
📁  New York Times Morning Briefing
    Daily newsletter, no action required
    47 emails  |  Unread: 312 → 265

  Examples:
    • The New York Times <nytdirect@nytimes.com>
      Your Morning Briefing: What to know today
    • The New York Times <nytdirect@nytimes.com>
      Your Morning Briefing: The latest on the economy

  (y)es archive / (n)o skip / (q)uit:
```

---

## Key implementation details

### Auth (`src/auth.ts`)

- Scope: `gmail.modify` (read + label modification, no delete)
- First run: spins up `http.createServer` on port 3000 to capture the OAuth redirect code
- Token stored in `.token.json` (gitignored), refreshed automatically on expiry

### Gmail fetch (`src/gmail.ts`)

- `fetchUnreadEmails(maxResults=500)`: paginates `messages.list` then fetches metadata in **chunks of 50 concurrent requests** — fast without hitting rate limits
- `archiveEmails(ids)`: `messages.batchModify` removing `INBOX` + `UNREAD` labels, in chunks of 1000
- `getUnreadCount()`: reads `labels.get('INBOX').messagesUnread`

### Categorizer (`src/categorizer.ts`)

- Model: `claude-opus-4-6` with **extended thinking** (8 000 token budget)
- Output validated with **Zod** — if Claude returns an invalid schema, it throws rather than silently corrupting data
- All returned IDs are cross-checked against the fetched set; any hallucinated or duplicate IDs are dropped before archiving

### Interactive loop (`src/interactive.ts`)

- Pure Node.js `readline` — no extra dependencies
- Each group prompt is a fresh interface so stdin is properly released between groups

---

## Safety

- **No deletions** — `batchModify` removes labels only; emails remain in Gmail and are fully recoverable from All Mail
- **Skipped = untouched** — the code never touches an email you say no to
- **ID validation** — IDs from Claude are validated against the fetched set before any archive call, so a hallucinated ID can never affect a real email
- **`.token.json` is gitignored** — your OAuth token is never committed
