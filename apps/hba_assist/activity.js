'use strict';
/**
 * Records EVERYTHING the app sees and does, for the owner's server: every diagnostic request / reply with
 * full bytes, every log line, every button press, page / tab / setting change, the car's speed / gear /
 * condition signals whenever they change, the app's own screen state whenever it changes, and the
 * uploader's state. Events go to <dataDir>/activity/current.jsonl as they happen (one JSON line each, so a
 * crash loses nothing), and flush() turns that into reports/activity-<time>.json for uploader.js to send:
 * every FLUSH_MS, when it grows past MAX_BYTES, and when the Upload button is pressed.
 *
 *   const act = new Activity({ dataDir, session });
 *   act.event('click', { id: 'BTN_RUN' });   act.flush('button') -> file or null
 */
const fs = require('fs');
const path = require('path');

const FLUSH_MS = 60000;
const MAX_BYTES = 2 * 1024 * 1024;

class Activity {
    constructor(opts) {
        this.dir = path.join(opts.dataDir, 'activity');
        this.reports = path.join(opts.dataDir, 'reports');
        this.file = path.join(this.dir, 'current.jsonl');
        this.session = opts.session;
        this.seq = 0;
        this.count = 0;
        this.started = new Date().toISOString();
        this.onFlush = opts.onFlush || (() => {});
        try { if (!fs.existsSync(this.dir)) fs.mkdirSync(this.dir); } catch (e) {}
        // a previous run's unflushed events (crash, app killed) go out first
        try { if (fs.existsSync(this.file) && fs.statSync(this.file).size) this.flush('previous run'); } catch (e) {}
        this.timer = setInterval(() => this.flush('timer'), FLUSH_MS);
        if (this.timer.unref) this.timer.unref();
    }

    event(kind, data) {
        const e = { t: new Date().toISOString(), seq: ++this.seq, session: this.session, kind: kind, data: data === undefined ? null : data };
        let line;
        try { line = JSON.stringify(e); } catch (err) { line = JSON.stringify({ t: e.t, seq: e.seq, session: e.session, kind: kind, data: String(data) }); }
        try {
            fs.appendFileSync(this.file, line + '\n');
            this.count++;
            if (fs.statSync(this.file).size > MAX_BYTES) this.flush('size');
        } catch (err) { /* data dir not writable (host preview) */ }
    }

    /** current.jsonl -> reports/activity-<time>.json ; returns the file, or null when there was nothing */
    flush(reason) {
        try {
            if (!fs.existsSync(this.file)) return null;
            const raw = fs.readFileSync(this.file, 'utf8');
            if (!raw.trim()) return null;
            fs.unlinkSync(this.file);
            const events = [];
            raw.split('\n').forEach((l) => { if (l.trim()) { try { events.push(JSON.parse(l)); } catch (e) { events.push({ kind: 'unparsed', data: l }); } } });
            if (!fs.existsSync(this.reports)) fs.mkdirSync(this.reports);
            const out = path.join(this.reports, 'activity-' + new Date().toISOString().replace(/[:.]/g, '-') + '.json');
            // written to .part then renamed: a head unit shutting down mid-write leaves no half file in the queue
            fs.writeFileSync(out + '.part', JSON.stringify({ type: 'activity', session: this.session, reason: reason, flushed: new Date().toISOString(), events: events }));
            fs.renameSync(out + '.part', out);
            this.onFlush(out);
            return out;
        } catch (e) { return null; }
    }
}

module.exports = { Activity };
