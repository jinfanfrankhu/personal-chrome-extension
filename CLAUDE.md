# CLAUDE.md — AI & Tech News Homepage (Chrome Extension)

## Project Overview

A Chrome Extension (Manifest V3) that replaces the new tab page with a personal dashboard. Features: AI/tech news aggregation, Google Calendar events, Google Tasks, a countdown timer, a progress bar, and a slide-out widget panel with graphs and heatmaps. All widget data syncs to Google Drive for cross-device persistence.

**Entry point:** `newtab.html` (overrides Chrome's new tab)

---

## Architecture

Vanilla JavaScript with ES6 modules — no framework, no bundler, no build step. Single-page app loaded via `<script type="module" src="script.js">`.

```
newtab.html             UI skeleton (single page)
script.js               Orchestrator — creates all managers, inits them in parallel via Promise.all
styles.css              All styling (~1478 lines, sectioned with comment headers)
news.js                 NewsManager — RSS aggregation from 8 sources
calendar.js             CalendarManager — Google Calendar OAuth + event display
countdown.js            CountdownManager + ProgressBarManager (both exported)
tasks.js                TasksManager — Google Tasks CRUD
progress-tracker.js     ProgressTrackerManager — toggles panel vs. countdown/calendar view
widgets.js              WidgetManager — graph + heatmap widgets with dynamic slots
sync.js                 DriveSync — silent Google Drive appDataFolder read/write
oura.js                 OuraClient — Oura API v2 OAuth2 + metric fetching
config.js               Per-device secrets (GITHUB_PAT, GITHUB_USERNAME, OURA_CLIENT_ID/SECRET) — .gitignored
manifest.json           Extension config, permissions, OAuth client ID — skip-worktree (see below)
```

### Module dependency graph

```
script.js
  ├── NewsManager            (standalone)
  ├── CountdownManager       (standalone)
  ├── ProgressBarManager     (standalone)
  ├── CalendarManager        (standalone, provides OAuth tokens to others)
  ├── TasksManager(calendar) (receives CalendarManager for shared token access)
  ├── ProgressTrackerManager (standalone, toggles DOM visibility)
  └── WidgetManager          (uses DriveSync + OuraClient internally)
        ├── DriveSync
        └── OuraClient
```

`TasksManager` depends on `CalendarManager` — it calls `calendarManager.getTokenSilently()` and `calendarManager.isCalendarConnected()` for OAuth. The `calendarConnected` custom DOM event bridges the two when first connecting.

### UI layout (calendar-bar)

The `.calendar-bar` is a 2-column grid containing:
- **Left:** Countdown section (timer + progress bar)
- **Right:** Next Calendar Events section
- **Full-width (hidden by default):** Progress Tracker Panel (widget grid)

The `ProgressTrackerManager` toggle (`trackerToggleBtn`) swaps visibility: showing the panel hides the countdown and calendar sections, and vice versa. They occupy the same `.calendar-bar` container.

---

## Key Patterns

### Manager class pattern
Every feature is a self-contained ES6 class with an `async init()` method. `script.js` constructs all managers and calls `Promise.all([...init()])`. New features: create a manager class, import and init in `script.js`.

### Caching pattern (15-min TTL)
All API-backed features use the same cache flow:
1. Check `chrome.storage.local` for cached data with timestamp
2. If cache age < threshold (usually 5 min for display, 15 min hard expiry), use cached
3. Otherwise fetch fresh data, store with `{ data/tasks/event, timestamp: Date.now() }`

### OAuth flow
Uses `chrome.identity.getAuthToken()` — `interactive: false` for silent refresh, `interactive: true` for first-time consent. CalendarManager owns the token; TasksManager borrows it.

### Modal pattern
Modals are created as a `div.modal-overlay` appended to `document.body`, with click-outside-to-close and Escape key support. Used by: countdown date picker, widget type selector, graph entry modal.

### Widget color system
Three color themes (blue/green/red) stored in widget data. Applied via CSS custom properties `--widget-accent` and `--widget-accent-dark` on each `.tracker-box`, which cascade to heatmap cells, graph lines, and toggle buttons.

---

## Widget System (widgets.js)

### Dynamic slot model
Widget slots are **not** fixed. A `widget_ids` array in storage tracks active widget IDs (integers). Adding a widget picks `max(ids) + 1`; removing splices the ID out and deletes its storage key. The "+ Add Widget" button is always the last element in the panel.

### Widget data shapes

**Graph widget:**
```json
{ "type": "graph", "title": "Metric", "range": 30, "entries": [{ "ts": "ISO", "value": 42 }], "color": "blue", "showMovingAvg": false, "showPoints": true }
```

**Heatmap widget:**
```json
{ "type": "heatmap", "title": "Activity", "activeDays": ["2025-06-15", "2025-06-16"], "color": "green" }
```

**Oura widget:**
```json
{ "type": "oura", "metric": "sleep", "title": "Sleep Score", "range": 30, "color": "blue", "showMovingAvg": false, "showPoints": true }
```
Stores config only — no `entries`. Data is fetched live from the Oura API and cached per metric (`oura_{metric}_cache`, 15-min TTL), so the Drive bundle stays small.

### Heatmap grid
27 weeks (current week + 26 prior), 7 rows (Sun-Sat). Cells are clickable to toggle `activeDays`. The grid scrolls horizontally; `scrollHeatmapsToToday()` auto-scrolls to the right edge on load.

### GitHub heatmap widget
A read-only heatmap populated from the GitHub GraphQL API (`contributionsCollection`). Uses a fine-grained PAT from `config.js`. Contributions are cached for 15 minutes (`github_contributions_cache`). Cells show 4 intensity levels based on contribution count relative to the max. Has a refresh button (↻) to force re-fetch.

### Graph chart
Pure SVG built in `buildSVGChart()`. Supports configurable day range, 7-day moving average overlay, data point toggles, and right-click-to-delete entries. A `readOnly` flag disables entry deletion (used by the Oura widget).

### Oura widget (oura.js)
A graph widget whose data auto-populates from the Oura API. Reuses `buildSVGChart()` (with `readOnly: true`), so it shares the same day-range / 7-day MA / points / color controls as the manual graph. A metric dropdown switches between Sleep Score (`daily_sleep.score`), Readiness (`daily_readiness.score`), and Steps (`daily_activity.steps`). First render shows a **Connect Oura** button that triggers interactive OAuth (must be a user gesture); afterward tokens refresh silently. A refresh (↻) button force-refetches. Widget storage holds config only — metric data is fetched live and cached in `oura_{metric}_cache` (15-min TTL), so it never enters the Drive sync bundle. Adding a metric later is a one-line addition to `OURA_METRICS` in `oura.js`.

### Google Drive sync (sync.js)
`DriveSync` stores a `widgets.json` file in the hidden `appDataFolder` (invisible to user, scoped to this app). On init, `WidgetManager` does a background pull — if the remote `lastModified` timestamp is newer than local `widget_sync_ts`, it overwrites local data and re-renders. Every local write triggers a fire-and-forget push.

---

## Storage Keys

| Key | Contents |
|-----|----------|
| `tech_content_cache` | `{ data: [...articles], timestamp }` |
| `calendar_cache` | `{ event: [...events], timestamp }` |
| `calendar_connected` | `boolean` — whether OAuth has been completed |
| `tasks_cache` | `{ tasks: [...], listId, timestamp }` |
| `target_date` | ISO string — countdown target |
| `target_title` | string — countdown label |
| `progress_bar_value` | number 0-100 |
| `tracker_panel_open` | boolean — panel open/closed (saved but not currently restored on load) |
| `widget_ids` | `number[]` — ordered list of active widget IDs |
| `widget_{id}` | Widget data object (graph or heatmap shape above) |
| `widget_sync_ts` | `number` — last Drive sync timestamp |
| `github_contributions_cache` | `{ data: { "YYYY-MM-DD": count, ... }, timestamp }` |
| `oura_tokens` | `{ access_token, refresh_token, expires_at }` — Oura OAuth2 tokens |
| `oura_{metric}_cache` | `{ entries: [{ts, value}], days, timestamp }` — per-metric API cache |

---

## APIs & Permissions

| API | Used by | Purpose |
|-----|---------|---------|
| `chrome.storage.local` | All modules | Persistence for cache, settings, widget data |
| `chrome.identity` | CalendarManager, TasksManager, DriveSync | OAuth2 token acquisition |
| Google Calendar API v3 | CalendarManager | Fetch next 2 upcoming events |
| Google Tasks API v1 | TasksManager | Fetch, add, and complete tasks |
| Google Drive API v3 | DriveSync | Cross-device widget sync via appDataFolder |
| RSS/XML (fetch + DOMParser) | NewsManager | News aggregation from 8 sources |

**Manifest permissions:** `storage`, `identity`

**Host permissions:** venturebeat.com, huggingface.co, alignmentforum.org, openai.com, deepmind.google, deepmind.com, arstechnica.com, thegradient.pub, quantocracy.com, googleapis.com, api.github.com, api.ouraring.com, cloud.ouraring.com

**Google OAuth scopes:** `calendar.readonly`, `tasks`, `drive.appdata`
**Oura OAuth scopes:** `daily`, `personal`

| GitHub GraphQL API | WidgetManager | Fetch contribution data for GitHub heatmap |
| Oura API v2 | OuraClient (via WidgetManager) | Fetch daily sleep / readiness / activity metrics |

**GitHub PAT:** Stored in `config.js` (gitignored). Uses a fine-grained PAT with no special permissions — default read-only access is sufficient to query your own `contributionsCollection` (includes private contributions).

**Oura OAuth2:** `OURA_CLIENT_ID` / `OURA_CLIENT_SECRET` in `config.js` (gitignored). Personal Access Tokens were deprecated (Dec 2025), so this uses the OAuth2 Authorization Code flow via `chrome.identity.launchWebAuthFlow`. Each device registers its own Redirect URI (`https://<extension-id>.chromiumapp.org/`) in the Oura developer portal; the client ID/secret are shared across devices. Tokens are stored in `oura_tokens` and refreshed silently.

---

## RSS Sources

VentureBeat AI, Hugging Face, AI Alignment Forum, OpenAI, Google DeepMind, Ars Technica AI, The Gradient, Quantocracy. Each source has fallback URLs. Up to 8 articles per source, top 20 overall by date. Hardcoded fallback articles if all feeds fail.

---

## Styling Notes

- **Color scheme:** Yale Blue (`#00356B` primary, `#286DC0` accent)
- **Background:** White body, warm beige cards (`rgba(245, 240, 232, 0.95)`)
- `styles.css` is organized by clear comment-header sections: base, calendar-bar, countdown, modals, news, tasks, progress bar, widget system, graph widget, heatmap widget, widget modal, widget colors
- Responsive breakpoint at 768px: calendar-bar collapses to single column, widget panel to 2-column grid

---

## Per-Device Files

Two files have per-device values and are excluded from normal git tracking:

- **`manifest.json`** — has `skip-worktree` set because `oauth2.client_id` differs per device. The repo version is a template; each device keeps its own local copy.
- **`config.js`** — `.gitignore`d. Contains `GITHUB_PAT` and `GITHUB_USERNAME`.

### Setting up a new device after `git pull`

```bash
# 1. manifest.json arrives from the repo — edit the oauth2.client_id to this device's value, then:
git update-index --skip-worktree manifest.json

# 2. Create config.js (gitignored, won't exist after clone):
# Export GITHUB_PAT and GITHUB_USERNAME with this device's values.
```

### Pulling updates when skip-worktree is active

```bash
git update-index --no-skip-worktree manifest.json
git stash push -m "local manifest" -- manifest.json
git pull --rebase origin main
git stash pop                       # resolve conflicts if any
git add manifest.json && git reset HEAD -- manifest.json
git update-index --skip-worktree manifest.json
```

---

## Development

No build step required.

1. `chrome://extensions/` -> Enable Developer mode -> Load unpacked -> select this folder
2. After code changes: click the refresh icon on the extension card (or Ctrl+R on the extensions page)
3. Open a new tab to see changes

### Adding a new widget type
1. Define the data shape (add to `showAddWidgetModal()` button list)
2. Add a `renderNewType(box, index, data)` method in `WidgetManager`
3. Add the type branch in `renderBox()`
4. Add CSS in the appropriate section of `styles.css`

### Adding a new feature module
1. Create `feature.js` with an exported manager class and `async init()`
2. Import in `script.js`, construct, and add to the `Promise.all` init array
3. Add any needed HTML containers in `newtab.html`
