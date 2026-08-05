# AI & Tech News Homepage

A Chrome Extension (Manifest V3) that replaces the new tab page with a personal
dashboard: AI/tech news aggregation, Google Calendar and Tasks, a countdown timer
with progress bar, and a slide-out widget panel with graphs, heatmaps, and live
health/activity data. All widget data syncs to Google Drive for cross-device
persistence.

## Features

- **News feed**: aggregates the latest AI/tech articles from 8 sources (VentureBeat AI, Hugging Face, AI Alignment Forum, OpenAI, Google DeepMind, Ars Technica AI, The Gradient, Quantocracy)
- **Google Calendar**: shows your next upcoming events
- **Google Tasks**: view, add, and complete tasks
- **Countdown timer + progress bar**: track a target date and manual progress
- **Widget panel**: a slide-out grid of configurable graph and heatmap widgets, including:
  - Manual metric graphs and activity heatmaps
    - **Oura ring** integration (sleep score, readiness, steps)
      - **GitHub contributions** heatmap (via GraphQL API)
      - **Cross-device sync**: widget data persists to your Google Drive `appDataFolder`, invisible to you and scoped to this extension

      ## Setup

      1. Clone this repo
      2. Go to `chrome://extensions/`, enable **Developer mode**, click **Load unpacked**, and select this folder
      3. `manifest.json`'s `oauth2.client_id` is per-device: replace it with your own Google OAuth client ID, then run:
         ```
            git update-index --skip-worktree manifest.json
               ```
                  so your local value doesn't get committed
                  4. Create a `config.js` (gitignored) exporting your `GITHUB_PAT`, `GITHUB_USERNAME`, and Oura `OURA_CLIENT_ID` / `OURA_CLIENT_SECRET`
                  5. Open a new tab to see it in action; after code changes, click the refresh icon on the extension card in `chrome://extensions/`

                  No build step: vanilla JavaScript with ES6 modules.

                  ## Architecture

                  Each feature is a self-contained manager class with an `async init()`, constructed
                  and initialized in parallel from `script.js`. See `CLAUDE.md` for full architecture
                  notes, storage key reference, and instructions for adding new widgets or features.

                  ## APIs used

                  Google Calendar API v3, Google Tasks API v1, Google Drive API v3, GitHub GraphQL
                  API, Oura API v2, and RSS/XML feed parsing.
                  
