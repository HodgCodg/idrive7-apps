'use strict';
/**
 * Sends every saved report (<dataDir>/reports/*.json) to the owner's server over Tailscale, so runs on the car
 * arrive without copying files off the head unit. Each file is sent once: a 2xx answer moves it to
 * reports/sent/. Anything else (no route, server down, timeout) leaves it in reports/ and it is tried again
 * on the next pass (every RETRY_MS, and right after each new report). Plain HTTP is fine here: Tailscale's
 * WireGuard tunnel encrypts it, and the address is only reachable inside the tailnet.
 *
 *   const up = new Uploader({ dataDir, log, enabled: () => true });
 *   up.start();   up.kick();   up.view() -> { pending, sent, last, error }
 */
const fs = require('fs');
const path = require('path');
const http = require('http');

const URL = 'http://100.73.22.59:8771/hba/upload';   // hhatx-ai on the tailnet
const RETRY_MS = 60000;
const TIMEOUT_MS = 15000;

class Uploader {
    constructor(opts) {
        this.dir = path.join(opts.dataDir, 'reports');
        this.sentDir = path.join(this.dir, 'sent');
        this.log = opts.log;
        this.enabled = opts.enabled || (() => true);
        this.url = new (require('url').URL)(opts.url || process.env.HBA_UPLOAD_URL || URL);
        this.busy = false;
        this.timer = null;
        this.sent = 0;
        this.last = null;
        this.error = null;
        this.onChange = opts.onChange || (() => {});
    }

    start() {
        if (!this.timer) this.timer = setInterval(() => this.kick(), RETRY_MS);
        if (this.timer.unref) this.timer.unref();
        return this.kick();
    }

    pending() {
        try { return fs.readdirSync(this.dir).filter((f) => f.endsWith('.json')).sort(); } catch (e) { return []; }
    }

    view() { return { enabled: !!this.enabled(), pending: this.pending().length, sent: this.sent, last: this.last, error: this.error }; }

    /** one pass over the queue; never throws, never runs twice at once */
    async kick() {
        if (this.busy || !this.enabled() || process.env.HBA_NO_UPLOAD) return;   // simulator / tests never upload
        this.busy = true;
        try {
            for (const f of this.pending()) {
                const file = path.join(this.dir, f);
                let body;
                try { body = fs.readFileSync(file); } catch (e) { continue; }
                try {
                    await this._post(f, body);
                } catch (e) {
                    this.error = String(e.message || e);
                    this.log.warn('upload ' + f + ': ' + this.error + ' (retry in ' + RETRY_MS / 1000 + ' s)');
                    break;   // the server is unreachable: stop this pass, try again later
                }
                if (!fs.existsSync(this.sentDir)) fs.mkdirSync(this.sentDir);
                fs.renameSync(file, path.join(this.sentDir, f));
                this.sent++;
                this.last = f;
                this.error = null;
                this.log.info('uploaded ' + f + ' (' + body.length + ' bytes)');
            }
        } catch (e) {
            this.error = String(e.message || e);
            this.log.warn('upload: ' + this.error);
        } finally {
            this.busy = false;
            this.onChange();
        }
    }

    _post(name, body) {
        return new Promise((resolve, reject) => {
            const req = http.request({
                hostname: this.url.hostname, port: this.url.port || 80, method: 'POST',
                path: this.url.pathname + '?name=' + encodeURIComponent(name),
                headers: { 'Content-Type': 'application/json', 'Content-Length': body.length },
                timeout: TIMEOUT_MS,
            }, (res) => {
                res.resume();
                res.on('end', () => (res.statusCode >= 200 && res.statusCode < 300 ? resolve() : reject(new Error('HTTP ' + res.statusCode))));
            });
            req.on('timeout', () => req.destroy(new Error('timeout')));
            req.on('error', reject);
            req.end(body);
        });
    }
}

module.exports = { Uploader, URL };
