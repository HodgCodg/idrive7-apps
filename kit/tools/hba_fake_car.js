'use strict';
/**
 * hba_fake_car.js - a fake InternalTasu with a BDC_G05, KAFAS04 and FLM02 pair behind it, answering as
 * BMW's SGBD tables describe, for test_hba_assist.js and preview_hba.js. Replies come back the way the
 * head unit delivers them (sendTasuResponse, 9-byte TASU header, answering unit in byte 6), so kit/diag.js
 * parses them exactly as on the car.
 *
 *   const car = fakeSignals({ 0x40: bdcG05(state), 0x5D: kafas04(state) });
 *   new HbaLink(car.signals, log); car.sent -> [[target, sid, ...data], ...]
 *   state = { ec, opTime, kafasDtc: [b0, b1, b2, status, ...], bdcDtc, stalk: () => ({ zero, fla, hb, flash }),
 *             kafasWrite: 'ok' | 'session' (7F until 10 03) | 'nrc33' | 'nrc22' | 'silent',
 *             bdcRoutine: 'ok' | 'session' | 'nrc33' | 'nrc31', bdcStop: 'ok' | 'nrc12',
 *             lampFollows: 'kafas' | 'bdc' | 'none' (which demo lights the cluster's HBA indicator) }
 *   state.kafasDemo / state.bdcDemo / state.ext[addr] show what the fake units were left in.
 */

function fakeSignals(units, opts) {
    const sent = [];
    let onResponse = null;
    const delayMs = (opts && opts.delayMs) || 2;
    const signals = {
        proxy: async () => ({ fake: true }),
        watch: async (iface) => ({ iface, error: 'fake car: no vehicle signals' }),   // as hu-stub's preview: Car sees no live data
        on: async (p, ev, fn) => { if (ev === 'sendTasuResponse') onResponse = fn; },
        onAvailable: async (p, fn) => fn(true),
        call: async (p, method, a) => {
            const data = Array.from(a.udsData);
            sent.push([a.targetAddress, a.serviceID].concat(data));
            const u = units[a.targetAddress];
            const reply = u && u(a.serviceID, data);
            if (reply && onResponse) {
                const frame = [0, 0, 0, 0, 0, 0, a.targetAddress, 0, 0].concat(reply);
                setTimeout(() => onResponse({ udsResponse: Buffer.from(frame), errorCode: 'NO_ERROR' }), delayMs);
            }
            return 'NO_ERROR';
        },
    };
    return { signals, sent };
}

const pos = (did, bytes) => [0x62, did >> 8, did & 0xFF].concat(bytes);
const u32 = (n) => [(n >>> 24) & 0xFF, (n >>> 16) & 0xFF, (n >>> 8) & 0xFF, n & 0xFF];

function session(state, addr, sid, d) {
    state.ext = state.ext || {};
    if (sid === 0x10) { state.ext[addr] = d[0] === 0x03; return [0x50, d[0], 0x00, 0x32, 0x01, 0xF4]; }
    if (sid === 0x3E) return [0x7E, 0x00];
    return null;
}
function writeMode(mode, ext, sid) {
    if (mode === 'silent') return 'silent';
    if (mode === 'nrc33') return [0x7F, sid, 0x33];
    if (mode === 'nrc22') return [0x7F, sid, 0x22];
    if (mode === 'nrc31') return [0x7F, sid, 0x31];
    if (mode === 'session' && !ext) return [0x7F, sid, 0x7F];
    return null;
}

function kafas04(state) {
    return (sid, d) => {
        if (sid === 0x19) return [0x59, 0x02, 0xFF].concat(state.kafasDtc || []);
        const ses = session(state, 0x5D, sid, d);
        if (ses) return ses;
        if (sid === 0x2E && d[0] === 0xD3 && d[1] === 0xA6) {
            const m = writeMode(state.kafasWrite || 'ok', state.ext && state.ext[0x5D], 0x2E);
            if (m === 'silent') return null;
            if (m) return m;
            state.kafasDemo = d[2] === 1;
            return [0x6E, 0xD3, 0xA6];
        }
        if (sid !== 0x22) return [0x7F, sid, 0x11];
        const did = (d[0] << 8) | d[1];
        switch (did) {
            case 0xF150: return pos(did, [0x0F, 0x24, 0xF0]);
            case 0xD807: return pos(did, [0x00]);
            case 0xE482: return pos(did, [state.ec]);
            case 0xD6BC: return pos(did, [0x01, 100]);
            case 0xD3AD: return pos(did, [0x01, 0, 0, 0, 0]);
            case 0xD341: return pos(did, [0, 0, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0]);
            case 0xE474: {
                const f = [state.opTime, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];
                return pos(did, [].concat.apply([], f.map(u32)));
            }
            default: return [0x7F, 0x22, 0x31];
        }
    };
}

function bdcG05(state) {
    return (sid, d) => {
        if (sid === 0x19) return [0x59, 0x02, 0xFF].concat(state.bdcDtc || []);
        const ses = session(state, 0x40, sid, d);
        if (ses) return ses;
        if (sid === 0x31 && d[1] === 0xA5 && d[2] === 0x39) {
            if (d[0] === 0x01) {
                const m = writeMode(state.bdcRoutine || 'ok', state.ext && state.ext[0x40], 0x31);
                if (m === 'silent') return null;
                if (m) return m;
                state.bdcDemo = true;
                return [0x71, 0x01, 0xA5, 0x39];
            }
            if (d[0] === 0x02) {
                if (state.bdcStop === 'nrc12') return [0x7F, 0x31, 0x12];
                state.bdcDemo = false;
                return [0x71, 0x02, 0xA5, 0x39];
            }
            return [0x71, 0x03, 0xA5, 0x39, 0x00];
        }
        if (sid !== 0x22) return [0x7F, sid, 0x11];
        const did = (d[0] << 8) | d[1];
        if (did === 0xF150) return pos(did, [0x0F, 0x26, 0x80]);
        if (did === 0xE3B8) {
            const b = state.stalk();
            return pos(did, [b.zero, 0, 0, 0, 0, 0, b.fla, b.hb, b.flash, 0xFD, 0xFD]);
        }
        return [0x7F, 0x22, 0x31];
    };
}

/** KOMB_G11-family cluster: 2520 byte 21 low nibble = HBA indicator (green when the chosen demo is on) */
function kombi(state) {
    return (sid, d) => {
        if (sid !== 0x22) return [0x7F, sid, 0x11];
        const did = (d[0] << 8) | d[1];
        if (did === 0xF150) return pos(did, [0x0F, 0x27, 0x10]);              // KOMBSP18
        if (did !== 0x2520) return [0x7F, 0x22, 0x31];
        const b = new Array(32).fill(0);
        const on = state.lampFollows === 'kafas' ? state.kafasDemo : state.lampFollows === 'bdc' ? state.bdcDemo : false;
        b[19] = 0x01;                                // parking light green, high beam off
        b[21] = (on ? 0x01 : 0x00) | 0x10;           // HBA indicator, low beam green
        return pos(did, b);
    };
}

const flm = (idx) => (sid, d) => (sid === 0x22 && d[0] === 0xF1 && d[1] === 0x50 ? pos(0xF150, idx) : [0x7F, sid, 0x11]);

module.exports = { fakeSignals, kafas04, bdcG05, kombi, flm, pos, u32 };
