/**
 * DriveSync — stores all widget data in Google Drive's hidden appDataFolder.
 * Sync is silent (non-interactive): if no token is available, operations are skipped.
 */

const DRIVE_FILE_NAME = 'widgets.json';
const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.appdata';

export class DriveSync {
    constructor() {
        this._fileId = null;
    }

    async _getToken() {
        return new Promise(resolve => {
            chrome.identity.getAuthToken({ interactive: false, scopes: [DRIVE_SCOPE] }, token => {
                if (chrome.runtime.lastError || !token) resolve(null);
                else resolve(token);
            });
        });
    }

    async _getFileId(token) {
        if (this._fileId) return this._fileId;
        try {
            const res = await fetch(
                'https://www.googleapis.com/drive/v3/files?spaces=appDataFolder&fields=files(id,name)',
                { headers: { Authorization: `Bearer ${token}` } }
            );
            if (!res.ok) return null;
            const { files } = await res.json();
            const file = (files || []).find(f => f.name === DRIVE_FILE_NAME);
            this._fileId = file?.id ?? null;
            return this._fileId;
        } catch { return null; }
    }

    // Returns parsed bundle { lastModified, ids, widgets } or null on failure.
    async pull() {
        try {
            const token = await this._getToken();
            if (!token) return null;
            const fileId = await this._getFileId(token);
            if (!fileId) return null;
            const res = await fetch(
                `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`,
                { headers: { Authorization: `Bearer ${token}` } }
            );
            if (!res.ok) return null;
            return await res.json();
        } catch { return null; }
    }

    // Writes bundle to Drive. Creates the file on first push, updates it thereafter.
    async push(bundle) {
        try {
            const token = await this._getToken();
            if (!token) return;
            const body = JSON.stringify(bundle);
            const fileId = await this._getFileId(token);

            if (fileId) {
                await fetch(
                    `https://www.googleapis.com/upload/drive/v3/files/${fileId}?uploadType=media`,
                    {
                        method: 'PATCH',
                        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
                        body,
                    }
                );
            } else {
                const metadata = JSON.stringify({ name: DRIVE_FILE_NAME, parents: ['appDataFolder'] });
                const form = new FormData();
                form.append('metadata', new Blob([metadata], { type: 'application/json' }));
                form.append('file', new Blob([body], { type: 'application/json' }));
                const res = await fetch(
                    'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id',
                    { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: form }
                );
                if (res.ok) {
                    const { id } = await res.json();
                    this._fileId = id;
                }
            }
        } catch { /* sync failures are silent */ }
    }
}
