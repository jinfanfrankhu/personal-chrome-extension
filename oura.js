/**
 * OuraClient — OAuth2 auth + data fetching for the Oura API v2.
 *
 * Oura deprecated Personal Access Tokens (Dec 2025), so this uses the OAuth2
 * Authorization Code flow via chrome.identity.launchWebAuthFlow. The client_id
 * and client_secret live in config.js (gitignored, per-device). Tokens are
 * stored in chrome.storage.local and refreshed silently when they expire.
 */

import { OURA_CLIENT_ID, OURA_CLIENT_SECRET } from './config.js';

const AUTH_URL = 'https://cloud.ouraring.com/oauth/authorize';
const TOKEN_URL = 'https://api.ouraring.com/oauth/token';
const API_BASE = 'https://api.ouraring.com/v2/usercollection';
const SCOPES = 'daily personal';
const TOKENS_KEY = 'oura_tokens';

// Metric registry — maps a widget's `metric` field to an endpoint + response field.
// Exported so the widget UI can build its metric dropdown from the same source.
export const OURA_METRICS = {
    sleep:     { endpoint: 'daily_sleep',     field: 'score', label: 'Sleep Score' },
    readiness: { endpoint: 'daily_readiness', field: 'score', label: 'Readiness' },
    steps:     { endpoint: 'daily_activity',  field: 'steps', label: 'Steps' },
};

const isoDate = d => d.toISOString().slice(0, 10);

export class OuraClient {
    constructor() {
        // https://<extension-id>.chromiumapp.org/ — must match a Redirect URI
        // registered in the Oura developer portal for this device.
        this._redirectUri = chrome.identity.getRedirectURL();
    }

    // True once real credentials are present in config.js.
    isConfigured() {
        return !!OURA_CLIENT_ID && !!OURA_CLIENT_SECRET &&
            !OURA_CLIENT_ID.startsWith('YOUR_') && !OURA_CLIENT_SECRET.startsWith('YOUR_');
    }

    async _loadTokens() {
        const r = await chrome.storage.local.get([TOKENS_KEY]);
        return r[TOKENS_KEY] || null;
    }

    async isConnected() {
        return !!(await this._loadTokens());
    }

    async disconnect() {
        await chrome.storage.local.remove([TOKENS_KEY]);
    }

    // ── OAuth ────────────────────────────────────────────────────────────────

    // Interactive consent — MUST be called from a user gesture (e.g. button click).
    async connect() {
        const state = Math.random().toString(36).slice(2);
        const url = `${AUTH_URL}?response_type=code`
            + `&client_id=${encodeURIComponent(OURA_CLIENT_ID)}`
            + `&redirect_uri=${encodeURIComponent(this._redirectUri)}`
            + `&scope=${encodeURIComponent(SCOPES)}`
            + `&state=${state}`;

        const redirectResponse = await new Promise((resolve, reject) => {
            chrome.identity.launchWebAuthFlow({ url, interactive: true }, resp => {
                if (chrome.runtime.lastError || !resp) {
                    reject(new Error(chrome.runtime.lastError?.message || 'Authorization cancelled'));
                } else resolve(resp);
            });
        });

        const returned = new URL(redirectResponse);
        const code = returned.searchParams.get('code');
        if (returned.searchParams.get('state') !== state) throw new Error('OAuth state mismatch');
        if (!code) throw new Error('No authorization code returned');
        await this._exchangeCode(code);
    }

    async _exchangeCode(code) {
        await this._tokenRequest({
            grant_type: 'authorization_code',
            code,
            redirect_uri: this._redirectUri,
        });
    }

    async _refresh(refreshToken) {
        return this._tokenRequest({
            grant_type: 'refresh_token',
            refresh_token: refreshToken,
        });
    }

    async _tokenRequest(params) {
        const body = new URLSearchParams({
            ...params,
            client_id: OURA_CLIENT_ID,
            client_secret: OURA_CLIENT_SECRET,
        });
        const res = await fetch(TOKEN_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body,
        });
        if (!res.ok) {
            const detail = await res.text().catch(() => '');
            throw new Error(`Oura token request failed: ${res.status} ${detail}`.trim());
        }
        const json = await res.json();
        const tokens = {
            access_token: json.access_token,
            // Oura returns a fresh refresh_token on refresh; keep the old one if omitted.
            refresh_token: json.refresh_token || params.refresh_token,
            expires_at: Date.now() + (json.expires_in || 86400) * 1000,
        };
        await chrome.storage.local.set({ [TOKENS_KEY]: tokens });
        return tokens;
    }

    // Returns a valid access token, refreshing silently if near expiry.
    async _validToken() {
        let tokens = await this._loadTokens();
        if (!tokens) throw new Error('Not connected to Oura');
        if (Date.now() < tokens.expires_at - 60000) return tokens.access_token;
        if (!tokens.refresh_token) throw new Error('Oura session expired — reconnect');
        tokens = await this._refresh(tokens.refresh_token);
        return tokens.access_token;
    }

    // ── Data ─────────────────────────────────────────────────────────────────

    // Returns [{ ts: ISO, value: number }] for the given metric over `days` back.
    async fetchMetric(metric, days) {
        const spec = OURA_METRICS[metric];
        if (!spec) throw new Error(`Unknown Oura metric: ${metric}`);

        const end = new Date();
        const start = new Date();
        start.setDate(start.getDate() - days);
        const qs = `start_date=${isoDate(start)}&end_date=${isoDate(end)}`;
        const doFetch = token => fetch(`${API_BASE}/${spec.endpoint}?${qs}`, {
            headers: { Authorization: `Bearer ${token}` },
        });

        let res = await doFetch(await this._validToken());
        // A 401 despite a fresh-looking token means it was revoked — refresh once and retry.
        if (res.status === 401) {
            const tokens = await this._loadTokens();
            if (tokens?.refresh_token) {
                const refreshed = await this._refresh(tokens.refresh_token);
                res = await doFetch(refreshed.access_token);
            }
        }
        if (!res.ok) throw new Error(`Oura ${spec.endpoint} ${res.status}`);

        const json = await res.json();
        return (json.data || [])
            .filter(d => d[spec.field] != null)
            // Anchor at local noon so the point lands on the correct calendar day.
            .map(d => ({ ts: `${d.day}T12:00:00`, value: d[spec.field] }))
            .sort((a, b) => new Date(a.ts) - new Date(b.ts));
    }
}
