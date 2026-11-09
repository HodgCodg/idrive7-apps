'use strict';
/**
 * hba_link.js - the head unit's diagnostic link (kit/diag.js, InternalTasu) restricted to what the
 * High Beam Assistant probe needs, which is READING:
 *
 *   22 <DID> [<DID> ...]   ReadDataByIdentifier, 1-8 identifiers, physical request
 *   19 02 <mask>           ReadDTCInformation by status mask, physical request
 *
 * to the BDC (0x40), KAFAS (0x5D), a headlight module (0x43 / 0x44) or the cluster (0x60) only. Anything else - sessions,
 * writes (2E), I/O control (2F), routines (31), clearing faults (14), security access (27), functional
 * requests - throws before it reaches the transport. The Diag is kept out of reach of the rest of the app.
 *
 * opts.allow(target, sid, data) -> true lets one more request through: experiments.js passes its list of
 * exact frames (the only writes the app can send, each named there), nothing else.
 *
 * One request at a time, gapMs between two, each with its own timeout. Every request and its reply
 * (or "no answer") is logged in hex, with the time it took.
 */
const { Diag, replyTo } = require('./kit/diag');
const { hex, hexs } = require('./hba_dids');

const TARGETS = Object.freeze([0x40, 0x5D, 0x43, 0x44, 0x60]);
const MAX_DIDS = 8;
const PRIVATE = new WeakMap();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const isByte = (b) => Number.isInteger(b) && b >= 0 && b <= 0xFF;

/** throws unless (target, sid, data) only reads (see the top of this file); exported for the tests */
function check(target, sid, data) {
    if (TARGETS.indexOf(target) < 0) throw new Error('hba_link: address ' + String(target) + ' is not allowed');
    if (!Array.isArray(data) || !data.every(isByte)) throw new Error('hba_link: bad request bytes');
    if (sid === 0x22) {
        if (data.length < 2 || data.length > 2 * MAX_DIDS || data.length % 2) throw new Error('hba_link: 22 takes 1-' + MAX_DIDS + ' identifiers');
        return;
    }
    if (sid === 0x19) {
        if (data.length !== 2 || data[0] !== 0x02) throw new Error('hba_link: only 19 02 <mask> is allowed');
        return;
    }
    throw new Error('hba_link: service ' + (isByte(sid) ? hex(sid) : String(sid)) + ' is not allowed');
}

class HbaLink {
    constructor(signals, log, opts) {
        const diag = new Diag(signals, log);
        diag.quiet = true;            // logged here instead, with the reply
        diag.busyMs = 200;
        diag.busyLog = false;
        PRIVATE.set(this, diag);
        this.log = log;
        this.gapMs = (opts && opts.gapMs) || 30;
        this.timeoutMs = (opts && opts.timeoutMs) || 2000;
        this.dtcTimeoutMs = (opts && opts.dtcTimeoutMs) || 6000;   // a full fault memory can take seconds
        this.verbose = !(opts && opts.verbose === false);
        this.allow = (opts && opts.allow) || null;
        this.chain = Promise.resolve();
        this.stats = { sent: 0, replies: 0, missed: 0, refused: 0, blocked: 0 };
        this.trace = [];              // last 200 exchanges, for the saved report
    }

    async init() { await PRIVATE.get(this).init(); return this; }
    get ready() { return !!PRIVATE.get(this).p; }
    get available() { return PRIVATE.get(this).available; }
    get error() { return PRIVATE.get(this).error; }
    onAvailable(fn) { PRIVATE.get(this).on('available', fn); }

    /** one request -> the unit's reply bytes, or null (no answer in time). Rejects when not allowed. */
    request(target, sid, data, timeoutMs) {
        const d = Array.isArray(data) ? data.slice() : data;   // checked = sent
        try { check(target, sid, d); } catch (e) {
            if (this.allow && Array.isArray(d) && d.every(isByte) && this.allow(target, sid, d)) return this._queue(target, sid, d, timeoutMs);
            this.stats.blocked++;
            this.log.error('blocked: ' + e.message);
            return Promise.reject(e);
        }
        return this._queue(target, sid, d, timeoutMs);
    }

    _queue(target, sid, d, timeoutMs) {
        const run = async () => {
            const t0 = Date.now();
            this.stats.sent++;
            let uds = null, err = null;
            try {
                uds = await PRIVATE.get(this).physical(target, sid, d, timeoutMs || this.timeoutMs, replyTo(sid, d), { hardTimeoutMs: (timeoutMs || this.timeoutMs) + 10000 });
            } catch (e) { err = e; }
            const ms = Date.now() - t0;
            const req = hex(target) + ' ' + hex(sid) + ' ' + hexs(d);
            const res = err ? 'error ' + err.message : uds ? hexs(uds) : 'no answer';
            if (uds && uds[0] === 0x7F) this.stats.refused++;
            if (uds) this.stats.replies++; else if (!err) this.stats.missed++;
            this.trace.push({ t: new Date(t0).toISOString(), req, res, ms });
            if (this.trace.length > 200) this.trace.shift();
            if (this.verbose) this.log.info('UDS ' + req + ' -> ' + res + ' (' + ms + ' ms)');
            await sleep(this.gapMs);
            if (err) throw err;
            return uds;
        };
        const p = this.chain.then(run, run);
        this.chain = p.catch(() => {});
        return p;
    }

    read(target, did, timeoutMs) { return this.request(target, 0x22, [(did >> 8) & 0xFF, did & 0xFF], timeoutMs); }
    dtcs(target, mask, timeoutMs) { return this.request(target, 0x19, [0x02, mask], timeoutMs || this.dtcTimeoutMs); }
}

module.exports = { HbaLink, check, TARGETS };
