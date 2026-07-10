/**
 * Widget Manager - Handles customizable widget boxes with Graph and Heatmap types
 */

import { DriveSync } from './sync.js';
import { OuraClient, OURA_METRICS } from './oura.js';
import { GITHUB_PAT, GITHUB_USERNAME } from './config.js';

const COLORS = {
    blue:  { hex: '#286DC0', dark: '#1a5ca0' },
    green: { hex: '#2d7a4f', dark: '#1e5c3a' },
    red:   { hex: '#c0392b', dark: '#96281b' },
};

const WIDGET_IDS_KEY = 'widget_ids';

export class WidgetManager {
    constructor() {
        this.WIDGET_KEY_PREFIX = 'widget_';
        this.panel = null;
        this.addBtn = null;
        this.boxMap = {}; // id -> DOM element
        this.driveSync = new DriveSync();
        this.oura = new OuraClient();
        // Pushes to Drive are suppressed until the initial pull has reconciled, so a
        // load-time render can't overwrite newer remote data with stale local data.
        this._initialSyncDone = false;
    }

    async init() {
        this.panel = document.getElementById('progressTrackerPanel');

        // Pull remote state BEFORE rendering or allowing any local write. The widget
        // panel is hidden by default, so this brief wait is invisible — and it guarantees
        // a cross-device edit is applied before a local render can push stale data over it.
        await this._pullAndReconcile();
        this._initialSyncDone = true;

        let ids = await this.loadIds();

        // On first load after upgrade, existing users may have empty slots — skip those
        const validIds = [];
        for (const id of ids) {
            const data = await this.loadWidget(id);
            if (data) {
                validIds.push(id);
                const box = this.createBoxElement();
                this.panel.appendChild(box);
                this.boxMap[id] = box;
            }
        }
        if (validIds.length !== ids.length) {
            await this.saveIds(validIds);
            ids = validIds;
        }

        // "Add Widget" button — always last in the grid
        this.addBtn = document.createElement('button');
        this.addBtn.className = 'tracker-add-btn';
        this.addBtn.textContent = '+ Add Widget';
        this.addBtn.addEventListener('click', () => this.showAddWidgetModal());
        this.panel.appendChild(this.addBtn);

        // Render all widgets
        for (const id of ids) {
            const data = await this.loadWidget(id);
            this.renderBox(this.boxMap[id], id, data);
        }

        document.addEventListener('trackerShown', () => this.scrollHeatmapsToToday());
        this.scrollHeatmapsToToday();
    }

    createBoxElement() {
        const box = document.createElement('div');
        box.className = 'tracker-box';
        return box;
    }

    // ── Storage ───────────────────────────────────────────────────────────────

    async loadIds() {
        const result = await chrome.storage.local.get([WIDGET_IDS_KEY]);
        // Default [0,1,2,3] for existing users who don't have widget_ids yet
        return result[WIDGET_IDS_KEY] ?? [0, 1, 2, 3];
    }

    async saveIds(ids) {
        await chrome.storage.local.set({ [WIDGET_IDS_KEY]: ids });
    }

    async loadWidget(index) {
        const key = this.WIDGET_KEY_PREFIX + index;
        const result = await chrome.storage.local.get([key]);
        return result[key] || null;
    }

    async saveWidget(index, data) {
        await chrome.storage.local.set({ [this.WIDGET_KEY_PREFIX + index]: data });
        this._gatherAndSync();
    }

    async deleteWidget(index) {
        await chrome.storage.local.remove([this.WIDGET_KEY_PREFIX + index]);
    }

    async removeSlot(id) {
        const ids = await this.loadIds();
        await this.saveIds(ids.filter(i => i !== id));
        await this.deleteWidget(id);
        const box = this.boxMap[id];
        if (box && box.parentNode) box.parentNode.removeChild(box);
        delete this.boxMap[id];
        this._gatherAndSync();
    }

    // ── Drive Sync ────────────────────────────────────────────────────────────

    // Pulls the remote bundle and, if it is newer than local, writes it into local
    // storage. Runs once at init before any rendering. Falls back to local state on
    // timeout/offline so the panel never hangs waiting on Drive.
    async _pullAndReconcile() {
        try {
            const remote = await this._withTimeout(this.driveSync.pull(), 4000);
            if (!remote?.lastModified) return;
            const { widget_sync_ts: localTs } = await chrome.storage.local.get(['widget_sync_ts']);
            if (remote.lastModified <= (localTs || 0)) return;
            await this._applyRemoteData(remote);
        } catch { /* offline or slow — fall back to whatever is in local storage */ }
    }

    _withTimeout(promise, ms) {
        return Promise.race([
            promise,
            new Promise(resolve => setTimeout(() => resolve(null), ms)),
        ]);
    }

    // Reads all current widget state from local storage and pushes to Drive.
    // Called fire-and-forget after every local write.
    async _gatherAndSync() {
        // Suppress pushes until the initial pull has reconciled, otherwise a load-time
        // render could push stale local data over newer remote data.
        if (!this._initialSyncDone) return;
        try {
            const ids = await this.loadIds();
            const widgets = {};
            for (const id of ids) {
                const data = await this.loadWidget(id);
                if (data) widgets[id] = data;
            }
            const bundle = { lastModified: Date.now(), ids, widgets };
            await chrome.storage.local.set({ widget_sync_ts: bundle.lastModified });
            this.driveSync.push(bundle);
        } catch { /* silent */ }
    }

    // Writes a remote bundle into local storage.
    async _applyRemoteData(remote) {
        const toSet = { widget_sync_ts: remote.lastModified };
        if (Array.isArray(remote.ids)) toSet[WIDGET_IDS_KEY] = remote.ids;
        for (const [id, data] of Object.entries(remote.widgets || {})) {
            toSet[this.WIDGET_KEY_PREFIX + id] = data;
        }
        await chrome.storage.local.set(toSet);
    }

    // ── Rendering ─────────────────────────────────────────────────────────────

    renderBox(box, index, data) {
        box.innerHTML = '';
        box.className = 'tracker-box';
        if (!data || !data.type) return;
        const c = COLORS[data.color] || COLORS.blue;
        box.style.setProperty('--widget-accent', c.hex);
        box.style.setProperty('--widget-accent-dark', c.dark);
        if (data.type === 'graph') {
            this.renderGraph(box, index, data);
        } else if (data.type === 'oura') {
            this.renderOuraGraph(box, index, data);
        } else if (data.type === 'heatmap') {
            this.renderHeatmap(box, index, data);
        } else if (data.type === 'github-heatmap') {
            this.renderGithubHeatmap(box, index, data);
        }
    }

    // ── Add Widget Modal ──────────────────────────────────────────────────────

    showAddWidgetModal() {
        let selectedColor = 'blue';

        const modal = document.createElement('div');
        modal.className = 'modal-overlay';
        modal.innerHTML = `
            <div class="modal-content widget-type-modal">
                <h3>Choose Widget Type</h3>
                <div class="widget-type-options">
                    <button class="widget-type-btn" data-type="graph">
                        <span class="widget-type-icon">📈</span>
                        <span class="widget-type-name">Graph</span>
                        <span class="widget-type-desc">Track a number over time</span>
                    </button>
                    <button class="widget-type-btn" data-type="heatmap">
                        <span class="widget-type-icon">🟦</span>
                        <span class="widget-type-name">Heatmap</span>
                        <span class="widget-type-desc">Daily activity grid</span>
                    </button>
                    <button class="widget-type-btn" data-type="github-heatmap">
                        <span class="widget-type-icon">🐙</span>
                        <span class="widget-type-name">GitHub</span>
                        <span class="widget-type-desc">GitHub contribution heatmap</span>
                    </button>
                    <button class="widget-type-btn" data-type="oura">
                        <span class="widget-type-icon">💍</span>
                        <span class="widget-type-name">Oura</span>
                        <span class="widget-type-desc">Sleep, readiness & steps</span>
                    </button>
                </div>
                <div class="widget-type-color-row">
                    <span class="widget-type-color-label">Color:</span>
                    <button class="widget-color-swatch widget-color-swatch--selected" data-color="blue" style="background:#286DC0" title="Blue"></button>
                    <button class="widget-color-swatch" data-color="green" style="background:#2d7a4f" title="Green"></button>
                    <button class="widget-color-swatch" data-color="red" style="background:#c0392b" title="Red"></button>
                </div>
                <button class="modal-btn secondary" id="widgetCancelBtn">Cancel</button>
            </div>
        `;
        document.body.appendChild(modal);

        modal.querySelectorAll('.widget-color-swatch').forEach(swatch => {
            swatch.addEventListener('click', (e) => {
                e.stopPropagation();
                selectedColor = swatch.dataset.color;
                modal.querySelectorAll('.widget-color-swatch').forEach(s => s.classList.remove('widget-color-swatch--selected'));
                swatch.classList.add('widget-color-swatch--selected');
            });
        });

        modal.querySelectorAll('.widget-type-btn').forEach(btn => {
            btn.addEventListener('click', async () => {
                const type = btn.dataset.type;
                const ids = await this.loadIds();
                const newId = ids.length === 0 ? 0 : Math.max(...ids) + 1;
                ids.push(newId);
                await this.saveIds(ids);

                const box = this.createBoxElement();
                this.panel.insertBefore(box, this.addBtn);
                this.boxMap[newId] = box;

                let data;
                if (type === 'graph') {
                    data = { type: 'graph', title: 'Metric', range: 30, entries: [], color: selectedColor };
                } else if (type === 'oura') {
                    data = { type: 'oura', metric: 'sleep', title: OURA_METRICS.sleep.label, range: 30, color: selectedColor, showMovingAvg: false, showPoints: true };
                } else if (type === 'github-heatmap') {
                    data = { type: 'github-heatmap', title: 'GitHub', activeDays: [], color: selectedColor };
                } else {
                    data = { type: 'heatmap', title: 'Activity', activeDays: [], color: selectedColor };
                }
                await this.saveWidget(newId, data);
                document.body.removeChild(modal);
                this.renderBox(box, newId, data);
                if (type === 'heatmap' || type === 'github-heatmap') this.scrollHeatmapsToToday();
            });
        });

        modal.querySelector('#widgetCancelBtn').addEventListener('click', () => {
            document.body.removeChild(modal);
        });

        modal.addEventListener('click', (e) => {
            if (e.target === modal) document.body.removeChild(modal);
        });
    }

    // ── Color Picker (inline, post-creation) ─────────────────────────────────

    showColorPicker(inner, index, data, box) {
        const existing = inner.querySelector('.widget-color-picker');
        if (existing) { existing.remove(); return; }

        const picker = document.createElement('div');
        picker.className = 'widget-color-picker';

        Object.entries(COLORS).forEach(([key, { hex }]) => {
            const swatch = document.createElement('button');
            swatch.className = 'widget-color-picker-swatch' +
                ((data.color || 'blue') === key ? ' widget-color-picker-swatch--active' : '');
            swatch.style.background = hex;
            swatch.title = key.charAt(0).toUpperCase() + key.slice(1);
            swatch.addEventListener('click', async (e) => {
                e.stopPropagation();
                const fresh = await this.loadWidget(index);
                fresh.color = key;
                await this.saveWidget(index, fresh);
                this.renderBox(box, index, fresh);
                if (fresh.type === 'heatmap') this.scrollHeatmapsToToday();
            });
            picker.appendChild(swatch);
        });

        // Insert after header (first child of inner)
        inner.insertBefore(picker, inner.children[1] || null);
    }

    // ── Graph Widget ──────────────────────────────────────────────────────────

    renderGraph(box, index, data) {
        box.classList.add('tracker-box--graph');
        box.innerHTML = '';

        const inner = document.createElement('div');
        inner.className = 'widget-inner';

        // Header
        const header = document.createElement('div');
        header.className = 'widget-header';

        const title = document.createElement('span');
        title.className = 'widget-title';
        title.textContent = data.title;
        title.title = 'Click to rename';
        title.addEventListener('click', () => this.makeEditableTitle(title, index, data));

        const actions = document.createElement('div');
        actions.className = 'widget-header-actions';

        const colorBtn = document.createElement('button');
        colorBtn.className = 'widget-color-btn';
        colorBtn.style.background = (COLORS[data.color] || COLORS.blue).hex;
        colorBtn.title = 'Change color';
        colorBtn.addEventListener('click', (e) => { e.stopPropagation(); this.showColorPicker(inner, index, data, box); });

        const resetBtn = document.createElement('button');
        resetBtn.className = 'widget-reset-btn';
        resetBtn.textContent = '×';
        resetBtn.title = 'Remove widget';
        resetBtn.addEventListener('click', (e) => { e.stopPropagation(); this.confirmReset(box, index); });

        actions.appendChild(colorBtn);
        actions.appendChild(resetBtn);
        header.appendChild(title);
        header.appendChild(actions);

        // Range input row
        const rangeRow = document.createElement('div');
        rangeRow.className = 'graph-range-row';

        const rangeLabel = document.createElement('label');
        rangeLabel.className = 'graph-range-label';
        rangeLabel.textContent = 'Last';

        const rangeInput = document.createElement('input');
        rangeInput.type = 'number';
        rangeInput.className = 'graph-range-input';
        rangeInput.value = data.range || 30;
        rangeInput.min = 1;
        rangeInput.max = 3650;

        const rangeSuffix = document.createElement('span');
        rangeSuffix.className = 'graph-range-suffix';
        rangeSuffix.textContent = 'days';

        const commitRange = async () => {
            const val = parseInt(rangeInput.value, 10);
            if (isNaN(val) || val < 1) { rangeInput.value = data.range || 30; return; }
            const fresh = await this.loadWidget(index);
            fresh.range = val;
            await this.saveWidget(index, fresh);
            this.renderGraph(box, index, fresh);
        };
        rangeInput.addEventListener('blur', commitRange);
        rangeInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') rangeInput.blur(); });

        const maBtn = document.createElement('button');
        maBtn.className = 'graph-ma-btn' + (data.showMovingAvg ? ' graph-ma-btn--active' : '');
        maBtn.textContent = '7D';
        maBtn.title = 'Toggle 7-day moving average';
        maBtn.addEventListener('click', async () => {
            const fresh = await this.loadWidget(index);
            fresh.showMovingAvg = !fresh.showMovingAvg;
            await this.saveWidget(index, fresh);
            this.renderGraph(box, index, fresh);
        });

        const ptsBtn = document.createElement('button');
        const showPoints = data.showPoints !== false; // default on
        ptsBtn.className = 'graph-ma-btn' + (showPoints ? ' graph-ma-btn--active' : '');
        ptsBtn.textContent = 'Pts';
        ptsBtn.title = 'Toggle data points';
        ptsBtn.addEventListener('click', async () => {
            const fresh = await this.loadWidget(index);
            fresh.showPoints = fresh.showPoints === false ? true : false;
            await this.saveWidget(index, fresh);
            this.renderGraph(box, index, fresh);
        });

        const toggleGroup = document.createElement('div');
        toggleGroup.className = 'graph-toggle-group';
        toggleGroup.appendChild(maBtn);
        toggleGroup.appendChild(ptsBtn);

        rangeRow.appendChild(rangeLabel);
        rangeRow.appendChild(rangeInput);
        rangeRow.appendChild(rangeSuffix);
        rangeRow.appendChild(toggleGroup);

        // Chart
        const chartArea = document.createElement('div');
        chartArea.className = 'graph-chart-area';
        chartArea.appendChild(this.buildSVGChart(data.entries || [], data.range, index, box, data.color, data.showMovingAvg, data.showPoints !== false));

        // Add entry button
        const addBtn = document.createElement('button');
        addBtn.className = 'graph-add-btn';
        addBtn.textContent = '+ Add Entry';
        addBtn.addEventListener('click', () => this.showAddEntryModal(index, box));

        inner.appendChild(header);
        inner.appendChild(rangeRow);
        inner.appendChild(chartArea);
        inner.appendChild(addBtn);
        box.appendChild(inner);
    }

    buildSVGChart(entries, range, index, box, colorKey, showMovingAvg, showPoints = true, readOnly = false) {
        const accent = (COLORS[colorKey] || COLORS.blue).hex;
        const accentDark = (COLORS[colorKey] || COLORS.blue).dark;

        const cutoff = Date.now() - range * 86400000;
        const allSorted = (entries || []).sort((a, b) => new Date(a.ts) - new Date(b.ts));
        const filtered = allSorted.filter(e => new Date(e.ts).getTime() >= cutoff);

        if (filtered.length === 0) {
            const p = document.createElement('p');
            p.className = 'graph-no-data';
            p.textContent = 'No data — click "+ Add Entry"';
            return p;
        }

        const PAD_L = 32, PAD_R = 10, PAD_T = 8, PAD_B = 18;
        const W = 280, H = 80;
        const chartW = W - PAD_L - PAD_R;
        const chartH = H - PAD_T - PAD_B;

        const ns = 'http://www.w3.org/2000/svg';
        const svg = document.createElementNS(ns, 'svg');
        svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
        svg.setAttribute('class', 'graph-svg');
        svg.setAttribute('width', '100%');
        svg.setAttribute('height', '100%');

        const timestamps = filtered.map(e => new Date(e.ts).getTime());
        const values = filtered.map(e => e.value);
        const minTs = Math.min(...timestamps);
        const maxTs = Math.max(...timestamps);
        const minVal = Math.min(...values);
        const maxVal = Math.max(...values);
        const rawRange = maxVal - minVal;
        const effectiveMin = rawRange === 0 ? minVal - 1 : minVal;
        const effectiveRange = rawRange === 0 ? 2 : rawRange;

        const toX = ts => filtered.length === 1
            ? PAD_L + chartW / 2
            : PAD_L + ((ts - minTs) / (maxTs - minTs)) * chartW;
        const toY = val => PAD_T + chartH - ((val - effectiveMin) / effectiveRange) * chartH;

        const mk = (tag, attrs) => {
            const el = document.createElementNS(ns, tag);
            Object.entries(attrs).forEach(([k, v]) => el.setAttribute(k, v));
            return el;
        };

        svg.appendChild(mk('line', { x1: PAD_L, y1: PAD_T, x2: PAD_L, y2: PAD_T + chartH, stroke: '#ddd', 'stroke-width': '1' }));
        svg.appendChild(mk('line', { x1: PAD_L, y1: PAD_T + chartH, x2: PAD_L + chartW, y2: PAD_T + chartH, stroke: '#ddd', 'stroke-width': '1' }));

        for (let i = 0; i <= 2; i++) {
            const frac = i / 2;
            const val = effectiveMin + frac * effectiveRange;
            const y = PAD_T + chartH - frac * chartH;
            if (i > 0) {
                svg.appendChild(mk('line', { x1: PAD_L, y1: y, x2: PAD_L + chartW, y2: y, stroke: '#f0f0f0', 'stroke-width': '1' }));
            }
            const lbl = mk('text', { x: PAD_L - 3, y: y + 3, 'text-anchor': 'end', 'font-size': '7', fill: '#999' });
            lbl.textContent = Number.isInteger(val) ? String(val) : val.toFixed(1);
            svg.appendChild(lbl);
        }

        const showDates = filtered.length > 1 ? [filtered[0], filtered[filtered.length - 1]] : [filtered[0]];
        showDates.forEach((entry, i) => {
            const x = toX(new Date(entry.ts).getTime());
            const d = new Date(entry.ts);
            const lbl = mk('text', {
                x, y: H - 3,
                'text-anchor': i === 0 && filtered.length > 1 ? 'start' : 'end',
                'font-size': '7', fill: '#999'
            });
            lbl.textContent = `${d.getMonth() + 1}/${d.getDate()}`;
            svg.appendChild(lbl);
        });

        if (showPoints && filtered.length > 1) {
            const pts = filtered.map(e => `${toX(new Date(e.ts).getTime())},${toY(e.value)}`).join(' ');
            svg.appendChild(mk('polyline', { points: pts, stroke: accent, 'stroke-width': '1.5', fill: 'none', 'stroke-linejoin': 'round' }));
        }

        if (showMovingAvg && filtered.length > 1) {
            const MA_WINDOW = 7 * 86400000;
            const maData = filtered.map(e => {
                const ets = new Date(e.ts).getTime();
                const win = allSorted.filter(x => {
                    const xts = new Date(x.ts).getTime();
                    return xts >= ets - MA_WINDOW && xts <= ets;
                });
                const avg = win.reduce((s, x) => s + x.value, 0) / win.length;
                return { x: toX(ets), y: toY(avg), avg };
            });

            const maLine = mk('polyline', {
                points: maData.map(p => `${p.x},${p.y}`).join(' '),
                stroke: accent,
                'stroke-width': '2',
                'stroke-opacity': '0.45',
                fill: 'none',
                'stroke-linejoin': 'round',
            });
            svg.appendChild(maLine);

            // Invisible wide hit area for hover
            const maHit = mk('polyline', {
                points: maData.map(p => `${p.x},${p.y}`).join(' '),
                stroke: 'transparent',
                'stroke-width': '10',
                fill: 'none',
                'stroke-linejoin': 'round',
                style: 'cursor: crosshair',
            });

            // Tooltip elements
            const tipGroup = document.createElementNS(ns, 'g');
            tipGroup.style.display = 'none';
            const tipRect = mk('rect', { rx: '3', ry: '3', fill: 'rgba(30,30,30,0.78)', height: '14' });
            const tipText = mk('text', { 'font-size': '8', fill: 'white', 'dominant-baseline': 'middle' });
            tipGroup.appendChild(tipRect);
            tipGroup.appendChild(tipText);
            svg.appendChild(tipGroup);

            maHit.addEventListener('mousemove', (e) => {
                const rect = svg.getBoundingClientRect();
                const scaleX = W / rect.width;
                const mouseX = (e.clientX - rect.left) * scaleX;

                // Find nearest MA point by x
                let nearest = maData[0];
                let minDist = Math.abs(mouseX - maData[0].x);
                for (const p of maData) {
                    const d = Math.abs(mouseX - p.x);
                    if (d < minDist) { minDist = d; nearest = p; }
                }

                const label = nearest.avg % 1 === 0 ? String(nearest.avg) : nearest.avg.toFixed(1);
                tipText.textContent = label;

                // Measure text and position
                const textW = label.length * 5 + 6;
                const tipX = Math.min(nearest.x - textW / 2, W - textW - 2);
                const tipY = nearest.y - 18;

                tipRect.setAttribute('x', tipX);
                tipRect.setAttribute('y', tipY);
                tipRect.setAttribute('width', textW);
                tipText.setAttribute('x', tipX + textW / 2);
                tipText.setAttribute('y', tipY + 7);
                tipText.setAttribute('text-anchor', 'middle');
                tipGroup.style.display = '';
            });

            maHit.addEventListener('mouseleave', () => { tipGroup.style.display = 'none'; });

            svg.appendChild(maHit);
        }

        if (showPoints) filtered.forEach(entry => {
            const circle = mk('circle', {
                cx: toX(new Date(entry.ts).getTime()),
                cy: toY(entry.value),
                r: '3', fill: accent, stroke: 'white', 'stroke-width': '1.5'
            });
            circle.style.cursor = readOnly ? 'default' : 'pointer';
            const titleEl = document.createElementNS(ns, 'title');
            titleEl.textContent = readOnly
                ? `${entry.value} — ${new Date(entry.ts).toLocaleDateString()}`
                : `${entry.value} — ${new Date(entry.ts).toLocaleDateString()} (right-click to delete)`;
            circle.appendChild(titleEl);
            if (!readOnly) circle.addEventListener('contextmenu', (e) => {
                e.preventDefault();
                this.deleteEntry(index, entry.ts, box);
            });
            svg.appendChild(circle);
        });

        return svg;
    }

    showAddEntryModal(index, box) {
        const modal = document.createElement('div');
        modal.className = 'modal-overlay';
        modal.innerHTML = `
            <div class="modal-content">
                <h3>Add Data Point</h3>
                <input type="number" class="widget-entry-input" id="widgetEntryVal" placeholder="Enter a number" step="any">
                <div class="modal-buttons">
                    <button class="modal-btn secondary" id="entryCancel">Cancel</button>
                    <button class="modal-btn primary" id="entryAdd">Add</button>
                </div>
            </div>
        `;
        document.body.appendChild(modal);

        const input = modal.querySelector('#widgetEntryVal');
        input.focus();

        const doAdd = async () => {
            const val = parseFloat(input.value);
            if (isNaN(val)) { input.style.borderColor = '#d32f2f'; return; }
            const data = await this.loadWidget(index);
            data.entries = [...(data.entries || []), { ts: new Date().toISOString(), value: val }]
                .sort((a, b) => new Date(a.ts) - new Date(b.ts));
            await this.saveWidget(index, data);
            document.body.removeChild(modal);
            this.renderGraph(box, index, data);
        };

        modal.querySelector('#entryAdd').addEventListener('click', doAdd);
        modal.querySelector('#entryCancel').addEventListener('click', () => document.body.removeChild(modal));
        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') doAdd();
            if (e.key === 'Escape') document.body.removeChild(modal);
        });
        modal.addEventListener('click', (e) => { if (e.target === modal) document.body.removeChild(modal); });
    }

    async deleteEntry(index, ts, box) {
        const data = await this.loadWidget(index);
        data.entries = (data.entries || []).filter(e => e.ts !== ts);
        await this.saveWidget(index, data);
        this.renderGraph(box, index, data);
    }

    // ── Oura Graph Widget ─────────────────────────────────────────────────────
    // A graph whose data auto-populates from the Oura API. Reuses buildSVGChart
    // so it shares the exact 7-day MA / points / color / range behaviour of the
    // manual graph. Widget storage holds config only (no entries) — the API data
    // is fetched live and cached per metric, so it never bloats the Drive bundle.

    renderOuraGraph(box, index, data) {
        box.classList.add('tracker-box--graph');
        box.innerHTML = '';

        const inner = document.createElement('div');
        inner.className = 'widget-inner';

        // Header
        const header = document.createElement('div');
        header.className = 'widget-header';

        const title = document.createElement('span');
        title.className = 'widget-title';
        title.textContent = data.title;
        title.title = 'Click to rename';
        title.addEventListener('click', () => this.makeEditableTitle(title, index, data));

        const actions = document.createElement('div');
        actions.className = 'widget-header-actions';

        const colorBtn = document.createElement('button');
        colorBtn.className = 'widget-color-btn';
        colorBtn.style.background = (COLORS[data.color] || COLORS.blue).hex;
        colorBtn.title = 'Change color';
        colorBtn.addEventListener('click', (e) => { e.stopPropagation(); this.showColorPicker(inner, index, data, box); });

        const refreshBtn = document.createElement('button');
        refreshBtn.className = 'widget-reset-btn';
        refreshBtn.textContent = '↻';
        refreshBtn.title = 'Refresh from Oura';
        refreshBtn.addEventListener('click', async (e) => {
            e.stopPropagation();
            await chrome.storage.local.remove([`oura_${data.metric}_cache`]);
            const fresh = await this.loadWidget(index);
            if (fresh) this.renderOuraGraph(box, index, fresh);
        });

        const resetBtn = document.createElement('button');
        resetBtn.className = 'widget-reset-btn';
        resetBtn.textContent = '×';
        resetBtn.title = 'Remove widget';
        resetBtn.addEventListener('click', (e) => { e.stopPropagation(); this.confirmReset(box, index); });

        actions.appendChild(colorBtn);
        actions.appendChild(refreshBtn);
        actions.appendChild(resetBtn);
        header.appendChild(title);
        header.appendChild(actions);

        // Metric selector row
        const metricRow = document.createElement('div');
        metricRow.className = 'oura-metric-row';

        const metricSelect = document.createElement('select');
        metricSelect.className = 'oura-metric-select';
        Object.entries(OURA_METRICS).forEach(([key, m]) => {
            const opt = document.createElement('option');
            opt.value = key;
            opt.textContent = m.label;
            if (key === data.metric) opt.selected = true;
            metricSelect.appendChild(opt);
        });
        metricSelect.addEventListener('change', async () => {
            const fresh = await this.loadWidget(index);
            // Only auto-rename if the title still matches a metric label (i.e. not user-renamed).
            const wasDefault = Object.values(OURA_METRICS).some(m => m.label === fresh.title);
            fresh.metric = metricSelect.value;
            if (wasDefault) fresh.title = OURA_METRICS[metricSelect.value].label;
            await this.saveWidget(index, fresh);
            this.renderOuraGraph(box, index, fresh);
        });
        metricRow.appendChild(metricSelect);

        // Range + toggles row (same controls as the manual graph)
        const rangeRow = document.createElement('div');
        rangeRow.className = 'graph-range-row';

        const rangeLabel = document.createElement('label');
        rangeLabel.className = 'graph-range-label';
        rangeLabel.textContent = 'Last';

        const rangeInput = document.createElement('input');
        rangeInput.type = 'number';
        rangeInput.className = 'graph-range-input';
        rangeInput.value = data.range || 30;
        rangeInput.min = 1;
        rangeInput.max = 3650;

        const rangeSuffix = document.createElement('span');
        rangeSuffix.className = 'graph-range-suffix';
        rangeSuffix.textContent = 'days';

        const commitRange = async () => {
            const val = parseInt(rangeInput.value, 10);
            if (isNaN(val) || val < 1) { rangeInput.value = data.range || 30; return; }
            const fresh = await this.loadWidget(index);
            fresh.range = val;
            await this.saveWidget(index, fresh);
            this.renderOuraGraph(box, index, fresh);
        };
        rangeInput.addEventListener('blur', commitRange);
        rangeInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') rangeInput.blur(); });

        const maBtn = document.createElement('button');
        maBtn.className = 'graph-ma-btn' + (data.showMovingAvg ? ' graph-ma-btn--active' : '');
        maBtn.textContent = '7D';
        maBtn.title = 'Toggle 7-day moving average';
        maBtn.addEventListener('click', async () => {
            const fresh = await this.loadWidget(index);
            fresh.showMovingAvg = !fresh.showMovingAvg;
            await this.saveWidget(index, fresh);
            this.renderOuraGraph(box, index, fresh);
        });

        const ptsBtn = document.createElement('button');
        const showPoints = data.showPoints !== false;
        ptsBtn.className = 'graph-ma-btn' + (showPoints ? ' graph-ma-btn--active' : '');
        ptsBtn.textContent = 'Pts';
        ptsBtn.title = 'Toggle data points';
        ptsBtn.addEventListener('click', async () => {
            const fresh = await this.loadWidget(index);
            fresh.showPoints = fresh.showPoints === false ? true : false;
            await this.saveWidget(index, fresh);
            this.renderOuraGraph(box, index, fresh);
        });

        const toggleGroup = document.createElement('div');
        toggleGroup.className = 'graph-toggle-group';
        toggleGroup.appendChild(maBtn);
        toggleGroup.appendChild(ptsBtn);

        rangeRow.appendChild(rangeLabel);
        rangeRow.appendChild(rangeInput);
        rangeRow.appendChild(rangeSuffix);
        rangeRow.appendChild(toggleGroup);

        // Chart
        const chartArea = document.createElement('div');
        chartArea.className = 'graph-chart-area';

        inner.appendChild(header);
        inner.appendChild(metricRow);
        inner.appendChild(rangeRow);
        inner.appendChild(chartArea);
        box.appendChild(inner);

        this._populateOuraChart(chartArea, box, index, data);
    }

    // Fills the chart area based on auth state: config → connect → loading → chart.
    async _populateOuraChart(chartArea, box, index, data) {
        chartArea.innerHTML = '';

        if (!this.oura.isConfigured()) {
            const p = document.createElement('p');
            p.className = 'graph-no-data';
            p.textContent = 'Add Oura credentials to config.js';
            chartArea.appendChild(p);
            return;
        }

        if (!(await this.oura.isConnected())) {
            const btn = document.createElement('button');
            btn.className = 'oura-connect-btn';
            btn.textContent = 'Connect Oura';
            btn.addEventListener('click', async () => {
                btn.disabled = true;
                btn.textContent = 'Connecting…';
                try {
                    await this.oura.connect();
                    const fresh = await this.loadWidget(index);
                    this.renderOuraGraph(box, index, fresh || data);
                } catch (err) {
                    console.error('Oura connect failed:', err);
                    btn.disabled = false;
                    btn.textContent = 'Connect Oura — retry';
                    const msg = document.createElement('p');
                    msg.className = 'graph-no-data';
                    msg.style.color = '#c0392b';
                    msg.style.wordBreak = 'break-word';
                    msg.textContent = String(err.message || err);
                    chartArea.appendChild(msg);
                }
            });
            chartArea.appendChild(btn);
            return;
        }

        const loading = document.createElement('p');
        loading.className = 'graph-no-data';
        loading.textContent = 'Loading…';
        chartArea.appendChild(loading);

        try {
            const range = data.range || 30;
            const entries = await this.fetchOuraMetric(data.metric, range);
            chartArea.innerHTML = '';
            chartArea.appendChild(
                this.buildSVGChart(entries, range, index, box, data.color, data.showMovingAvg, data.showPoints !== false, true)
            );
        } catch (err) {
            console.error('Oura fetch failed:', err);
            chartArea.innerHTML = '';
            const p = document.createElement('p');
            p.className = 'graph-no-data';
            p.textContent = 'Failed to load — click ↻ or reconnect';
            chartArea.appendChild(p);
        }
    }

    // Fetches a metric with a 15-min cache. Cache is reused only when it already
    // spans at least the requested number of days.
    async fetchOuraMetric(metric, days) {
        const cacheKey = `oura_${metric}_cache`;
        const cached = (await chrome.storage.local.get([cacheKey]))[cacheKey];
        if (cached && (Date.now() - cached.timestamp) < 15 * 60 * 1000 && cached.days >= days) {
            return cached.entries;
        }
        const entries = await this.oura.fetchMetric(metric, days);
        await chrome.storage.local.set({ [cacheKey]: { entries, days, timestamp: Date.now() } });
        return entries;
    }

    // ── Heatmap Percentage Indicator ─────────────────────────────────────────

    buildPercentageIndicator(activeDays) {
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        const activeSet = new Set(activeDays);
        let count = 0;
        for (let i = 0; i < 30; i++) {
            const d = new Date(today);
            d.setDate(d.getDate() - i);
            if (activeSet.has(this.dateToStr(d))) count++;
        }
        const pct = Math.round((count / 30) * 100);

        const span = document.createElement('span');
        span.className = 'heatmap-pct';
        span.textContent = `${pct}%`;

        if (pct >= 90) {
            span.style.background = 'linear-gradient(90deg, #e74c3c, #e67e22, #f1c40f, #2ecc71, #3498db, #9b59b6)';
            span.style.webkitBackgroundClip = 'text';
            span.style.webkitTextFillColor = 'transparent';
        } else if (pct >= 70) {
            span.style.color = '#2ecc71';
        } else if (pct >= 50) {
            span.style.color = '#daa520';
        } else {
            span.style.color = '#e74c3c';
        }

        return span;
    }

    // ── Heatmap Widget ────────────────────────────────────────────────────────

    renderHeatmap(box, index, data) {
        box.classList.add('tracker-box--heatmap');
        box.innerHTML = '';

        const inner = document.createElement('div');
        inner.className = 'widget-inner';

        const header = document.createElement('div');
        header.className = 'widget-header';

        const title = document.createElement('span');
        title.className = 'widget-title';
        title.textContent = data.title;
        title.title = 'Click to rename';
        title.addEventListener('click', () => this.makeEditableTitle(title, index, data));

        const actions = document.createElement('div');
        actions.className = 'widget-header-actions';

        const colorBtn = document.createElement('button');
        colorBtn.className = 'widget-color-btn';
        colorBtn.style.background = (COLORS[data.color] || COLORS.blue).hex;
        colorBtn.title = 'Change color';
        colorBtn.addEventListener('click', (e) => { e.stopPropagation(); this.showColorPicker(inner, index, data, box); });

        const resetBtn = document.createElement('button');
        resetBtn.className = 'widget-reset-btn';
        resetBtn.textContent = '×';
        resetBtn.title = 'Remove widget';
        resetBtn.addEventListener('click', (e) => { e.stopPropagation(); this.confirmReset(box, index); });

        actions.appendChild(this.buildPercentageIndicator(data.activeDays || []));
        actions.appendChild(colorBtn);
        actions.appendChild(resetBtn);
        header.appendChild(title);
        header.appendChild(actions);

        inner.appendChild(header);
        inner.appendChild(this.buildHeatmapGrid(data.activeDays || [], index));
        box.appendChild(inner);
    }

    buildHeatmapGrid(activeDays, index) {
        const activeSet = new Set(activeDays);
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        const todayStr = this.dateToStr(today);

        const dayOfWeek = today.getDay();
        const currentSunday = new Date(today);
        currentSunday.setDate(today.getDate() - dayOfWeek);

        const startSunday = new Date(currentSunday);
        startSunday.setDate(currentSunday.getDate() - 26 * 7);

        const weeks = [];
        const cursor = new Date(startSunday);
        while (cursor <= currentSunday) {
            const week = [];
            for (let i = 0; i < 7; i++) {
                week.push(this.dateToStr(new Date(cursor)));
                cursor.setDate(cursor.getDate() + 1);
            }
            weeks.push(week);
        }

        const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
        const CELL = 11, GAP = 2, COL = CELL + GAP;

        const outer = document.createElement('div');
        outer.className = 'heatmap-outer';

        // Fixed day labels
        const dayLabels = document.createElement('div');
        dayLabels.className = 'heatmap-day-labels';
        ['S','M','T','W','T','F','S'].forEach(l => {
            const s = document.createElement('span');
            s.textContent = l;
            dayLabels.appendChild(s);
        });

        // Scrollable area
        const scrollWrapper = document.createElement('div');
        scrollWrapper.className = 'heatmap-scroll-wrapper';

        const scrollInner = document.createElement('div');
        scrollInner.className = 'heatmap-scroll-inner';

        // Month labels
        const monthRow = document.createElement('div');
        monthRow.className = 'heatmap-month-labels-row';

        let prevMonth = -1, colCount = 0;
        const monthSpans = [];
        weeks.forEach(week => {
            const m = new Date(week[0] + 'T00:00:00').getMonth();
            if (m !== prevMonth) {
                if (prevMonth !== -1) monthSpans.push({ label: MONTHS[prevMonth], cols: colCount });
                prevMonth = m; colCount = 1;
            } else {
                colCount++;
            }
        });
        if (prevMonth !== -1) monthSpans.push({ label: MONTHS[prevMonth], cols: colCount });

        monthSpans.forEach(({ label, cols }) => {
            const span = document.createElement('span');
            span.className = 'heatmap-month-label';
            span.textContent = label;
            span.style.width = (cols * COL - GAP) + 'px';
            monthRow.appendChild(span);
        });

        // Weeks + event delegation
        const weeksRow = document.createElement('div');
        weeksRow.className = 'heatmap-weeks-row';

        weeksRow.addEventListener('click', async (e) => {
            const cell = e.target.closest('.heatmap-cell');
            if (!cell || !cell.dataset.date) return;
            const dateStr = cell.dataset.date;
            const data = await this.loadWidget(index);
            const set = new Set(data.activeDays || []);
            if (set.has(dateStr)) set.delete(dateStr); else set.add(dateStr);
            data.activeDays = Array.from(set);
            await this.saveWidget(index, data);
            cell.classList.toggle('heatmap-cell--active');
            const widgetInner = cell.closest('.widget-inner');
            const oldPct = widgetInner.querySelector('.heatmap-pct');
            const newPct = this.buildPercentageIndicator(data.activeDays);
            if (oldPct) oldPct.replaceWith(newPct);
        });

        weeks.forEach(week => {
            const weekCol = document.createElement('div');
            weekCol.className = 'heatmap-week';
            week.forEach(dateStr => {
                const cell = document.createElement('div');
                cell.className = 'heatmap-cell';
                cell.dataset.date = dateStr;
                if (activeSet.has(dateStr)) cell.classList.add('heatmap-cell--active');
                if (dateStr === todayStr) cell.classList.add('heatmap-cell--today');
                weekCol.appendChild(cell);
            });
            weeksRow.appendChild(weekCol);
        });

        scrollInner.appendChild(monthRow);
        scrollInner.appendChild(weeksRow);
        scrollWrapper.appendChild(scrollInner);
        outer.appendChild(dayLabels);
        outer.appendChild(scrollWrapper);

        return outer;
    }

    // ── GitHub Heatmap Widget ──────────────────────────────────────────────

    async fetchGithubContributions() {
        const cacheKey = 'github_contributions_cache';
        const cached = await chrome.storage.local.get([cacheKey]);
        if (cached[cacheKey]) {
            const age = Date.now() - cached[cacheKey].timestamp;
            if (age < 15 * 60 * 1000) return cached[cacheKey].data;
        }

        const today = new Date();
        const from = new Date(today);
        from.setDate(from.getDate() - 26 * 7 - today.getDay());
        from.setHours(0, 0, 0, 0);

        const query = `query {
            user(login: "${GITHUB_USERNAME}") {
                contributionsCollection(from: "${from.toISOString()}", to: "${today.toISOString()}") {
                    contributionCalendar {
                        weeks {
                            contributionDays {
                                date
                                contributionCount
                            }
                        }
                    }
                }
            }
        }`;

        const resp = await fetch('https://api.github.com/graphql', {
            method: 'POST',
            headers: {
                'Authorization': `bearer ${GITHUB_PAT}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({ query }),
        });

        if (!resp.ok) throw new Error(`GitHub API ${resp.status}`);
        const json = await resp.json();
        const weeks = json.data.user.contributionsCollection.contributionCalendar.weeks;
        const contributions = {};
        for (const week of weeks) {
            for (const day of week.contributionDays) {
                if (day.contributionCount > 0) {
                    contributions[day.date] = day.contributionCount;
                }
            }
        }

        await chrome.storage.local.set({
            [cacheKey]: { data: contributions, timestamp: Date.now() }
        });
        return contributions;
    }

    renderGithubHeatmap(box, index, data) {
        box.classList.add('tracker-box--heatmap');
        box.innerHTML = '';

        const inner = document.createElement('div');
        inner.className = 'widget-inner';

        const header = document.createElement('div');
        header.className = 'widget-header';

        const title = document.createElement('span');
        title.className = 'widget-title';
        title.textContent = data.title;
        title.title = 'Click to rename';
        title.addEventListener('click', () => this.makeEditableTitle(title, index, data));

        const actions = document.createElement('div');
        actions.className = 'widget-header-actions';

        const colorBtn = document.createElement('button');
        colorBtn.className = 'widget-color-btn';
        colorBtn.style.background = (COLORS[data.color] || COLORS.green).hex;
        colorBtn.title = 'Change color';
        colorBtn.addEventListener('click', (e) => { e.stopPropagation(); this.showColorPicker(inner, index, data, box); });

        const refreshBtn = document.createElement('button');
        refreshBtn.className = 'widget-reset-btn';
        refreshBtn.textContent = '↻';
        refreshBtn.title = 'Refresh contributions';
        refreshBtn.addEventListener('click', async (e) => {
            e.stopPropagation();
            await chrome.storage.local.remove(['github_contributions_cache']);
            const fresh = await this.loadWidget(index);
            if (fresh) this.renderGithubHeatmap(box, index, fresh);
        });

        const resetBtn = document.createElement('button');
        resetBtn.className = 'widget-reset-btn';
        resetBtn.textContent = '×';
        resetBtn.title = 'Remove widget';
        resetBtn.addEventListener('click', (e) => { e.stopPropagation(); this.confirmReset(box, index); });

        actions.appendChild(colorBtn);
        actions.appendChild(refreshBtn);
        actions.appendChild(resetBtn);
        header.appendChild(title);
        header.appendChild(actions);

        inner.appendChild(header);

        const loading = document.createElement('div');
        loading.className = 'github-heatmap-loading';
        loading.textContent = 'Loading contributions…';
        inner.appendChild(loading);
        box.appendChild(inner);

        this.fetchGithubContributions().then(contributions => {
            loading.remove();
            const activeDays = Object.keys(contributions);
            data.activeDays = activeDays;
            data._counts = contributions;
            // NOTE: do NOT saveWidget/sync here — GitHub contributions are re-fetched on
            // every load and are not user data. Persisting them would bump widget_sync_ts
            // and push on every new tab, clobbering real cross-device edits.
            const pctEl = this.buildPercentageIndicator(activeDays);
            actions.insertBefore(pctEl, colorBtn);
            inner.appendChild(this.buildGithubHeatmapGrid(contributions, index));
            this.scrollHeatmapsToToday();
        }).catch(err => {
            loading.textContent = 'Failed to load — check PAT in config.js';
            console.error('GitHub contributions fetch failed:', err);
        });
    }

    buildGithubHeatmapGrid(contributions, index) {
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        const todayStr = this.dateToStr(today);

        const dayOfWeek = today.getDay();
        const currentSunday = new Date(today);
        currentSunday.setDate(today.getDate() - dayOfWeek);

        const startSunday = new Date(currentSunday);
        startSunday.setDate(currentSunday.getDate() - 26 * 7);

        const weeks = [];
        const cursor = new Date(startSunday);
        while (cursor <= currentSunday) {
            const week = [];
            for (let i = 0; i < 7; i++) {
                week.push(this.dateToStr(new Date(cursor)));
                cursor.setDate(cursor.getDate() + 1);
            }
            weeks.push(week);
        }

        const counts = Object.values(contributions);
        const maxCount = Math.max(1, ...counts);

        const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
        const CELL = 11, GAP = 2, COL = CELL + GAP;

        const outer = document.createElement('div');
        outer.className = 'heatmap-outer';

        const dayLabels = document.createElement('div');
        dayLabels.className = 'heatmap-day-labels';
        ['S','M','T','W','T','F','S'].forEach(l => {
            const s = document.createElement('span');
            s.textContent = l;
            dayLabels.appendChild(s);
        });

        const scrollWrapper = document.createElement('div');
        scrollWrapper.className = 'heatmap-scroll-wrapper';

        const scrollInner = document.createElement('div');
        scrollInner.className = 'heatmap-scroll-inner';

        const monthRow = document.createElement('div');
        monthRow.className = 'heatmap-month-labels-row';

        let prevMonth = -1, colCount = 0;
        const monthSpans = [];
        weeks.forEach(week => {
            const m = new Date(week[0] + 'T00:00:00').getMonth();
            if (m !== prevMonth) {
                if (prevMonth !== -1) monthSpans.push({ label: MONTHS[prevMonth], cols: colCount });
                prevMonth = m; colCount = 1;
            } else {
                colCount++;
            }
        });
        if (prevMonth !== -1) monthSpans.push({ label: MONTHS[prevMonth], cols: colCount });

        monthSpans.forEach(({ label, cols }) => {
            const span = document.createElement('span');
            span.className = 'heatmap-month-label';
            span.textContent = label;
            span.style.width = (cols * COL - GAP) + 'px';
            monthRow.appendChild(span);
        });

        const weeksRow = document.createElement('div');
        weeksRow.className = 'heatmap-weeks-row';

        weeks.forEach(week => {
            const weekCol = document.createElement('div');
            weekCol.className = 'heatmap-week';
            week.forEach(dateStr => {
                const cell = document.createElement('div');
                cell.className = 'heatmap-cell github-heatmap-cell';
                cell.dataset.date = dateStr;
                const count = contributions[dateStr] || 0;
                if (count > 0) {
                    const intensity = Math.min(count / maxCount, 1);
                    const level = intensity < 0.25 ? 1 : intensity < 0.5 ? 2 : intensity < 0.75 ? 3 : 4;
                    cell.classList.add(`github-level-${level}`);
                    cell.title = `${dateStr}: ${count} contribution${count !== 1 ? 's' : ''}`;
                } else {
                    cell.title = `${dateStr}: no contributions`;
                }
                if (dateStr === todayStr) cell.classList.add('heatmap-cell--today');
                weekCol.appendChild(cell);
            });
            weeksRow.appendChild(weekCol);
        });

        scrollInner.appendChild(monthRow);
        scrollInner.appendChild(weeksRow);
        scrollWrapper.appendChild(scrollInner);
        outer.appendChild(dayLabels);
        outer.appendChild(scrollWrapper);

        return outer;
    }

    scrollHeatmapsToToday() {
        document.querySelectorAll('.heatmap-scroll-wrapper').forEach(w => {
            w.scrollLeft = w.scrollWidth;
        });
    }

    // ── Shared ────────────────────────────────────────────────────────────────

    makeEditableTitle(titleEl, index, data) {
        const input = document.createElement('input');
        input.type = 'text';
        input.className = 'widget-title-input';
        input.value = data.title;
        input.maxLength = 30;
        titleEl.replaceWith(input);
        input.focus();
        input.select();

        const commit = async () => {
            const newTitle = input.value.trim() || data.title;
            const fresh = await this.loadWidget(index);
            fresh.title = newTitle;
            data.title = newTitle;
            await this.saveWidget(index, fresh);
            const span = document.createElement('span');
            span.className = 'widget-title';
            span.textContent = newTitle;
            span.title = 'Click to rename';
            span.addEventListener('click', () => this.makeEditableTitle(span, index, data));
            input.replaceWith(span);
        };

        input.addEventListener('blur', commit);
        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') { e.preventDefault(); input.blur(); }
            if (e.key === 'Escape') { input.value = data.title; input.blur(); }
        });
    }

    confirmReset(box, index) {
        const actions = box.querySelector('.widget-header-actions');
        if (!actions) return;
        actions.innerHTML = '';

        const wrap = document.createElement('span');
        wrap.className = 'widget-reset-confirm';
        wrap.textContent = 'Remove? ';

        const yesBtn = document.createElement('button');
        yesBtn.className = 'widget-reset-confirm-btn';
        yesBtn.textContent = '✓';
        yesBtn.addEventListener('click', () => this.removeSlot(index));

        const noBtn = document.createElement('button');
        noBtn.className = 'widget-reset-confirm-btn';
        noBtn.textContent = '✗';
        noBtn.addEventListener('click', () => {
            this.loadWidget(index).then(fresh => {
                if (fresh) this.renderBox(box, index, fresh);
            });
        });

        wrap.appendChild(yesBtn);
        wrap.appendChild(noBtn);
        actions.appendChild(wrap);
    }

    dateToStr(date) {
        const y = date.getFullYear();
        const m = String(date.getMonth() + 1).padStart(2, '0');
        const d = String(date.getDate()).padStart(2, '0');
        return `${y}-${m}-${d}`;
    }
}
