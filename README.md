# TASKZ — KPLC Token Tracker & Blackout Alerter

> ⚡ **Live Web App:** [https://kplc.surge.sh](https://kplc.surge.sh)  
> Track your prepaid KPLC tokens instantly in your browser — zero backend required, 100% private.

Automatic prepaid electricity token tracking for Kenya Power (KPLC) customers.
Add a meter number once. The system does everything else — no manual data
entry, no checking the portal yourself.

## The problem

KPLC's self-service portal (and prepaid tokens generally) only show the last
handful of purchases per meter, with no full history and no API. Users have
no way to see their real consumption trend over time, and no warning before
they run out of units and lose power — especially painful for students and
anyone on a tight budget who tops up in small amounts.

## What this does

1. User registers and adds **one meter number**.
2. From that point on, the system automatically:
   - Polls KPLC's public self-service search for that meter on a schedule
   - Detects new token purchases the moment they appear
   - Stores every token permanently (building the full history KPLC never
     kept)
   - Recalculates usage rate, units remaining, and estimated blackout date
   - Sends a notification before the user runs out
3. User never touches the portal, never pastes anything, never manually logs
   usage. The meter number is the only input required.

Adding a **second, different meter number** creates a **separate user
account** scoped to that meter — each meter is tracked independently, with
its own history, usage rate, and notification schedule. This keeps shared
households (e.g. one user tracking a personal meter, another tracking a
family meter) cleanly separated instead of merging usage data that doesn't
belong together.

## How it works (architecture)

```
┌─────────────┐      ┌────────────────────────┐      ┌───────────────────┐
│   Frontend  │─────>│  API + Backend       . │─────>│    Database       │
│ (add meter, │      │  - user & meter mgmt   │      │  users, meters,   │
│  view usage)│      │  - usage engine        │      │  tokens           │
└─────────────┘      └─────────┬──────────────┘      └───────────────────┘
                               |
                               ▼
                      ┌──────────────────────┐
                      │  Background Worker   │
                      │  (scheduled poller)  │
                      │  - fetch KPLC portal │
                      │    per meter         │
                      │  - diff vs stored    │
                      │    tokens            │
                      │  - insert new ones   │
                      │  - recompute rate,   │
                      │    days-left         │
                      │  - trigger alerts    │
                      └─────────┬────────────┘
                                │
                                ▼
                      ┌──────────────────────┐
                      │ Notification Layer   │
                      │  (Telegram bot /     │
                      │   push / SMS)        │
                      └──────────────────────┘
```

### 1. Onboarding
- User signs up, submits a meter number (and account number if required).
- On save, the backend immediately does a **one-time backfill scrape** to
  seed whatever history is currently visible on the portal.

### 2. Background poller (the "code does the work" part)
- A scheduled job (cron / task queue — e.g. one run per meter per day,
  staggered to avoid hammering KPLC's portal) fetches the self-service
  search result for each registered meter number automatically.
- Every fetched token is compared against what's already stored, keyed by
  **token number** (unique per purchase). New ones are inserted; nothing
  else changes.
- This is what lets the app retain full history from the day a user
  registered onward, even though KPLC's portal only ever shows the last
  handful of entries.
- No user interaction required at any point after signup.

### 3. Usage engine
- `usage_rate` = rolling average of units/day across recent tokens (or a
  manually-set override, toggle back to `AUTO` any time).
- `units_left` = last known token's units − (days elapsed × usage_rate).
  This is an **estimate**, not a live meter reading — there's no API, so the
  app cannot know the exact real-time balance, only project it from
  purchase history.
- `days_left` = units_left / usage_rate
- `pay_before` = now + days_left

### 4. Notifications
- When `days_left` drops below a configurable threshold, the worker fires
  an alert automatically — no polling or checking from the user side.
- Telegram is the primary delivery channel (fastest to ship, no app-store
  friction, and can double as an *optional* manual input path — forwarding
  a KPLC SMS to the bot — for users on a meter the scraper can't reach).

## Design principles

- **Meter number in, everything else automatic.** The only manual step is
  registration. If a feature requires the user to check something or paste
  something as its primary flow, it's built wrong.
- **One meter = one account scope.** Adding another meter never merges into
  an existing account's data; it's a new, independently-tracked account.
- **Degrade gracefully if scraping breaks.** KPLC's portal has no contract
  with this project — if its structure changes or access is restricted, the
  app should keep working off previously stored data and (optionally) fall
  back to manual/SMS-forward entry rather than failing silently.
- **Estimates are labeled as estimates.** `units_left` and `pay_before` are
  projections from purchase history and usage rate, not live meter reads.
  The UI should never imply more precision than the data supports.

## Tech stack (suggested)

- **Backend**: Python (FastAPI) or Node — background worker as a scheduled
  task (APScheduler / cron / BullMQ)
- **Database**: SQLite/Postgres — simple relational schema (`users`,
  `meters`, `tokens`)
- **Scraper**: `requests`/`httpx` + HTML parsing against the self-service
  search endpoint, isolated in its own module so it can be swapped or
  patched independently of the rest of the app
- **Notifications**: Telegram Bot API (aligns with existing bot
  infrastructure), optional push/SMS later

## Roadmap

- [ ] Meter registration + one-time backfill scrape
- [ ] Scheduled per-meter poller with token deduplication
- [ ] Usage rate calculation (auto + manual override)
- [ ] Days-left / pay-before projection
- [ ] Telegram bot for alerts
- [ ] Optional SMS-forward ingestion as a scraper fallback
- [ ] Multi-payer split view (for shared meters — "Anonymous-V73X" vs
      "OTHER" style breakdown)

## Disclaimer

This project reads from KPLC's public self-service search feature, which is
not an official API and has no publicly documented terms for programmatic
access. Polling frequency is kept low and per-meter to minimize load, and
the scraping module is isolated so it can be disabled without breaking the
rest of the app (manual/SMS entry remains available as a fallback).
