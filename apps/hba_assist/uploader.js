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
 *
 * PULL: Tailscale on the head unit runs in userspace mode, so the app has no route OUT to the tailnet
 * (connect ENETUNREACH). Connections IN still work: tailscaled hands them to 127.0.0.1. So the uploader
 * also serves the queue on 127.0.0.1:PULL_PORT, and the server pulls it (deploy/hba-receiver):
 *   GET  /hba/flush            the activity so far becomes a report now (opts.onFlush)
 *   GET  /hba/list             [{ name, size }] of everything waiting
 *   GET  /hba/file?name=x      one report
 *   POST /hba/ack?name=x       the server has it: moved to reports/sent/
 * Localhost only: nothing on the car's own networks can reach it.
 */
const fs = require('fs');
const path = require('path');
const http = require('http');

const URL = 'http://100.73.22.59:8771/hba/upload';   // hhatx-ai on the tailnet
const RETRY_MS = 60000;
const TIMEOUT_MS = 15000;
const PULL_PORT = 8772;
const CONTACT_MS = 5 * 60000;   // a pull this recent = the server is reached; pushing is skipped meanwhile

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
        this.onFlush = opts.onFlush || (() => {});
        this.contact = 0;          // last time the server was reached (push or pull)
        this.via = null;
        this.server = null;
    }

    /** the pull endpoint on 127.0.0.1 (see top) */
    serve(port) {
        if (this.server || process.env.HBA_NO_UPLOAD) return;
        const send = (res, code, type, body) => { res.writeHead(code, { 'Content-Type': type, 'Content-Length': Buffer.byteLength(body) }); res.end(body); };
        this.server = http.createServer((req, res) => {
            try {
                const u = new (require('url').URL)(req.url, 'http://x');
                const name = path.basename(u.searchParams.get('name') || '');
                const file = path.join(this.dir, name);
                if (!this.enabled()) return send(res, 403, 'text/plain', 'upload is off');
                this._contact('pull');
                if (u.pathname === '/hba/catalog') {   // the head unit's SOME/IP catalog, streamed from /etc (never copied: quota)
                    const cat = require('./catalog').FILE;
                    if (!fs.existsSync(cat)) return send(res, 404, 'text/plain', 'no catalog');
                    res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': fs.statSync(cat).size });
                    return fs.createReadStream(cat).pipe(res);
                }
                if (u.pathname === '/hba/flush') { this.onFlush(); return send(res, 200, 'application/json', '{"ok":true}'); }
                if (u.pathname === '/hba/list') {
                    return send(res, 200, 'application/json', JSON.stringify(this.pending().map((f) => {
                        let size = 0; try { size = fs.statSync(path.join(this.dir, f)).size; } catch (e) {}
                        return { name: f, size };
                    })));
                }
                if (!/\.json$/.test(name) || !fs.existsSync(file)) return send(res, 404, 'text/plain', 'no such report');
                if (u.pathname === '/hba/file' && req.method === 'GET') {
                    res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': fs.statSync(file).size });
                    return fs.createReadStream(file).pipe(res);
                }
                if (u.pathname === '/hba/ack' && req.method === 'POST') {
                    this._sent(name, 'pulled');
                    this.onChange();
                    return send(res, 200, 'application/json', '{"ok":true}');
                }
                return send(res, 404, 'text/plain', 'not found');
            } catch (e) { return send(res, 500, 'text/plain', String(e)); }
        });
        this.server.on('error', (e) => { this.log.warn('pull endpoint: ' + e.message); this.server = null; });
        this.server.listen(port || PULL_PORT, '127.0.0.1', () => this.log.info('pull endpoint on 127.0.0.1:' + (port || PULL_PORT)));
    }

    _contact(via) {
        const was = this.contact && Date.now() - this.contact < CONTACT_MS;
        this.contact = Date.now(); this.via = via; this.error = null;
        if (!was) { this.log.info('server reached (' + via + ')'); this.onChange(); }
    }

    // the server has it: deleted here. The app's data folder has a small quota (EDQUOT, errno -122): keeping
    // sent copies filled it and cut every later file short at a 4 KB block.
    _sent(f, how) {
        try { fs.unlinkSync(path.join(this.dir, f)); } catch (e) { if (e.code !== 'ENOENT') throw e; return; }
        this.sent++;
        this.last = f;
        if (how !== 'pulled') this.log.info(how + ' ' + f);   // pulls are logged by the server (a log line here would be news to pull again)
    }

    start() {
        // sent copies kept by 0.5-0.9.2 (and half-written .part files): free the quota
        try { fs.readdirSync(this.sentDir).forEach((f) => { try { fs.unlinkSync(path.join(this.sentDir, f)); } catch (e) {} }); fs.rmdirSync(this.sentDir); } catch (e) {}
        try { fs.readdirSync(this.dir).filter((f) => /\.part$/.test(f)).forEach((f) => { try { fs.unlinkSync(path.join(this.dir, f)); } catch (e) {} }); } catch (e) {}
        if (!this.timer) this.timer = setInterval(() => this.kick(), RETRY_MS);
        if (this.timer.unref) this.timer.unref();
        this.serve();
        return this.kick();
    }

    pending() {
        try { return fs.readdirSync(this.dir).filter((f) => f.endsWith('.json')).sort(); } catch (e) { return []; }
    }

    view() {
        return { enabled: !!this.enabled(), pending: this.pending().length, sent: this.sent, last: this.last, error: this.error,
            reached: !!this.contact && Date.now() - this.contact < CONTACT_MS, via: this.via, contact: this.contact ? new Date(this.contact).toISOString() : null };
    }

    /** one pass over the queue; never throws, never runs twice at once */
    async kick() {
        if (this.busy || !this.enabled() || process.env.HBA_NO_UPLOAD) return;   // simulator / tests never upload
        if (this.via === 'pull' && Date.now() - this.contact < CONTACT_MS) return;   // the server is pulling: nothing to push
        this.busy = true;
        try {
            for (const f of this.pending()) {
                const file = path.join(this.dir, f);
                let body;
                try { body = fs.readFileSync(file); } catch (e) { continue; }
                try {
                    await this._post(f, body);
                } catch (e) {
                    const msg = String(e.message || e);
                    if (msg !== this.error) this.log.warn('push ' + f + ': ' + msg + ' (retried every ' + RETRY_MS / 1000 + ' s; the server can also pull)');
                    this.error = msg;
                    break;   // the server is unreachable: stop this pass, try again later
                }
                this._contact('push');
                this._sent(f, 'pushed');
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

module.exports = { Uploader, URL, PULL_PORT };
