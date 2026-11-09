'use strict';
/**
 * hba_fake_car.js - a fake InternalTasu with a BDC_G05, KAFAS04 and FLM02 pair behind it, answering as
 * BMW's SGBD tables describe, for test_hba_assist.js and preview_hba.js. Replies come back the way the
 * head unit delivers them (sendTasuResponse, 9-byte TASU header, answering unit in byte 6), so kit/diag.js
 * parses them exactly as on the car.
 *
 *   const car = fakeSignals({ 0x40: bdcG05(state), 0x5D: kafas04(state) });
 *   new HbaLink(car.signals, log); car.sent -> [[target, sid, ...data], ...]
 *   state = { ec, opTime, kafasDtc: [b0, b1, b2, status, ...], bdcDtc, stalk: () => ({ zero, fla, hb, flash }) }
 */

function fakeSignals(units, opts) {
    const sent = [];
    let onResponse = null;
    const delayMs = (opts && opts.delayMs) || 2;
    const signals = {
        proxy: async () => ({ fake: true }),
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

function kafas04(state) {
    return (sid, d) => {
        if (sid === 0x19) return [0x59, 0x02, 0xFF].concat(state.kafasDtc || []);
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
        const did = (d[0] << 8) | d[1];
        if (did === 0xF150) return pos(did, [0x0F, 0x26, 0x80]);
        if (did === 0xE3B8) {
            const b = state.stalk();
            return pos(did, [b.zero, 0, 0, 0, 0, 0, b.fla, b.hb, b.flash, 0xFD, 0xFD]);
        }
        return [0x7F, 0x22, 0x31];
    };
}

const flm = (idx) => (sid, d) => (sid === 0x22 && d[0] === 0xF1 && d[1] === 0x50 ? pos(0xF150, idx) : [0x7F, sid, 0x11]);

module.exports = { fakeSignals, kafas04, bdcG05, flm, pos, u32 };
