'use strict';
/**
 * hba_dids.js - what the High Beam Assistant probe reads, and how to decode it.
 *
 * Every identifier here is READ-ONLY (UDS 0x22 / 0x19) and comes from BMW's own SGBD
 * (EdiabasX SGBD reference, github.com/emdzej/ediabasx-docs-sgbd):
 *
 *   BDC_G05  "Body Domain Controller BDC-03 ab SP18", rev 1.000   (SGBD index 0F2680)
 *   BDC_G11  "Body Domain Controller" (BDC2015), rev 12.002       (SGBD index 0F2050)
 *   KAFAS04  "Kamerabasiertes Fahrerassistenzsystem Mid, High", rev 8.000 (0F24F0)
 *
 * Field order = the order of the SGBD's RES_0x..._D table (byte order of the reply).
 * Pure functions, no I/O: test_hba_assist.js checks them against hand-built replies.
 */

const BDC = 0x40, KAFAS = 0x5D, FLM_L = 0x43, FLM_R = 0x44;

// SGBD index (22 F150, 3 bytes) -> SGBD name. From apps/live_data/builtin/sgbd_index.json.
const SGBD = {
    0x40: { '0F19C0': 'BDC', '0F2050': 'BDC_G11', '0F2680': 'BDC_G05' },
    0x5D: { '0F1350': 'KAFAS01', '0F1840': 'KAFAS20', '0F2160': 'KAFASG11', '0F24F0': 'KAFAS04',
        '0F2AB0': 'ADCAM_L', '0F2AC0': 'ADCAM_M', '0F3090': 'ADCAM_M' },
    0x43: { '0F2200': 'FLM01_L', '0F26C0': 'FLM02_L', '0F26C8': 'FLM02X_L', '0F26CC': 'FLM2_1_L', '0F2E30': 'FLM03_L' },
    0x44: { '0F2210': 'FLM01_R', '0F26D0': 'FLM02_R', '0F26D8': 'FLM02X_R', '0F26DC': 'FLM2_1_R', '0F2E40': 'FLM03_R' },
};

const hex = (n, w) => (n >>> 0).toString(16).toUpperCase().padStart(w || 2, '0');
const hexs = (b) => (b || []).map((x) => hex(x)).join(' ');

/** data bytes of a positive 22 reply for did, or null (refused / other DID / short). */
function data(reply, did) {
    if (!reply || reply[0] !== 0x62 || reply.length < 3) return null;
    if (((reply[1] << 8) | reply[2]) !== did) return null;
    return Array.prototype.slice.call(reply, 3);
}

/** NRC of a refusal 7F 22 xx, else null */
function nrc(reply) { return reply && reply[0] === 0x7F ? reply[2] : null; }

function u32(b, i) { return ((b[i] << 24) >>> 0) + (b[i + 1] << 16) + (b[i + 2] << 8) + b[i + 3]; }

/** 22 F150 -> SGBD index as 6 hex digits ('' when not readable) */
function sgbdIndex(reply) {
    const d = data(reply, 0xF150);
    return d && d.length >= 3 ? hex((d[0] << 16) | (d[1] << 8) | d[2], 6) : '';
}

/**
 * The stalk's high-beam-assistant button, as the BDC sees it (LIN from the SZL).
 * BDC_G05: 0xE3B8 LENKSTOCK_BLINKER, 11 x u8, byte 6 = STAT_FERNLICHTASSISTENT (0/1);
 *          byte 7 = STAT_FERNLICHT (stalk pushed to high beam), byte 8 = STAT_LICHTHUPE (flash).
 * BDC_G11 / BDC: 0xD580 LENKSTOCK_BLINKER_TASTER_FLA, 1 x s8 (0/1);
 *          0xD583 LENKSTOCK_BLINKER_LICHTHUPE_FERNLICHT, [FERNLICHT, LICHTHUPE].
 * Each decoder: reply -> { fla, highBeam, flash } (undefined where the reply has no such field) or null.
 */
const BUTTON = {
    0xE3B8: (r) => {
        const d = data(r, 0xE3B8);
        if (!d || d.length < 9) return null;
        return { fla: d[6], highBeam: d[7], flash: d[8] };
    },
    0xD580: (r) => {
        const d = data(r, 0xD580);
        return d && d.length >= 1 ? { fla: d[0] } : null;
    },
    0xD583: (r) => {
        const d = data(r, 0xD583);
        return d && d.length >= 2 ? { highBeam: d[0], flash: d[1] } : null;
    },
};
/** which button identifiers to read for a BDC SGBD (unknown variant: try both families) */
function buttonDids(sgbd) {
    if (sgbd === 'BDC_G05') return [0xE3B8];
    if (sgbd === 'BDC_G11' || sgbd === 'BDC') return [0xD580, 0xD583];
    return [0xE3B8, 0xD580, 0xD583];
}

const ENABLE_CODE = { 0: 'EC_Operational', 1: 'EC_Prepared', 2: 'EC_Error_State', 3: 'EC_Off', 4: 'EC_NA', 5: 'EC_Not_Needed', 0xFF: 'invalid' };
const CALIB = { 1: 'OK', 2: 'running (SPC)', 3: 'temporarily not OK', 4: 'fallback (SPC)', 5: 'permanent error', 0xFF: 'invalid' };
const RECOMMEND = { 0: 'none (fault / view blocked)', 1: 'high beam OFF', 2: 'high beam ON' };
const VARIANT = { 0: 'KAFAS_HIGH', 1: 'KAFAS_MID', 0xFF: 'invalid' };

// KAFAS04 0xD341 ABSCHALTGRUND_FERNLICHT: why the high beam is held off, 12 x u8 (0/1)
const REASONS = [
    ['oncoming', 'oncoming vehicle detected'],
    ['ahead', 'vehicle ahead detected'],
    ['slow', 'speed below threshold'],
    ['daylight', 'ambient brightness (day)'],
    ['town', 'street lighting (town)'],
    ['fog', 'fog detected'],
    ['motorway', 'motorway detected'],
    ['delay', 'switch-on delay running'],
    ['tunnel', 'tunnel detected'],
    ['blockage', 'camera view blocked / dirty'],
    ['leftHand', 'traffic: left-hand drive country'],   // direction, not a reason; shown as info
    ['failsafe', 'camera in fail-safe mode'],
];

// KAFAS04 0xE474 FASTA_FLA_DATA: 12 x u32 big-endian (L/H = high)
const FASTA = ['opTime', 'nightTime', 'recommendHbTime', 'recommendLbTime', 'overrides', 'opTimeTotal',
    'overrideFullHb', 'overrideGfhb', 'overrideLb', 'overrideButton', 'overrideFlash', 'overrideStalk'];

/** KAFAS04 decoders: reply -> object or null */
const KAFAS_DIDS = {
    0xD807: { name: 'KAFAS_VARIANT', decode: (r) => { const d = data(r, 0xD807); return d && d.length ? { raw: d[0], text: VARIANT[d[0]] || hex(d[0]) } : null; } },
    0xE482: { name: 'KONFIGURATION_KAFAS_FLA', decode: (r) => { const d = data(r, 0xE482); return d && d.length ? { raw: d[0], text: ENABLE_CODE[d[0]] || 'value ' + hex(d[0]) } : null; } },
    0xD6BC: { name: 'STAT_KALIB', decode: (r) => { const d = data(r, 0xD6BC); return d && d.length ? { raw: d[0], text: CALIB[d[0]] || 'value ' + hex(d[0]), progress: d.length > 1 ? d[1] : undefined } : null; } },
    0xD3AD: { name: 'EMPFEHLUNG_LD', decode: (r) => { const d = data(r, 0xD3AD); return d && d.length ? { raw: d[0], text: RECOMMEND[d[0]] || 'value ' + hex(d[0]) } : null; } },
    0xD341: {
        name: 'ABSCHALTGRUND_FERNLICHT',
        decode: (r) => {
            const d = data(r, 0xD341);
            if (!d || d.length < 8) return null;
            const out = { active: [] };
            REASONS.forEach((x, i) => {
                if (i >= d.length) return;
                out[x[0]] = d[i];
                if (d[i] === 1 && x[0] !== 'leftHand') out.active.push(x[1]);
            });
            return out;
        },
    },
    0xE474: {
        name: 'FASTA_FLA_DATA',
        decode: (r) => {
            const d = data(r, 0xE474);
            if (!d || d.length < 4) return null;
            const out = {};
            FASTA.forEach((k, i) => { if (d.length >= 4 * i + 4) out[k] = u32(d, 4 * i); });
            return out;
        },
    },
};
const KAFAS_ORDER = [0xD807, 0xE482, 0xD6BC, 0xD3AD, 0xD341, 0xE474];

// DTCs that bear on the high beam assistant (from the SGBDs above). Any other code is shown as hex.
const DTC_TEXT = {
    0x030340: 'SZL (LIN): internal hardware fault',
    0x030341: 'SZL turn-signal stalk: function fault',
    0x030342: 'SZL turn-signal stalk: BC/FLA button signal implausible',
    0x030343: 'SZL turn-signal stalk: button stuck (FAS/BC/FLA)',
    0x03034D: 'SZL (LIN): communication fault',
    0x030350: 'SZL (LIN): LIN slave missing',
    0x030351: 'SZL (LIN): wrong variant fitted',
    0x030352: 'SZL (LIN): alive counter fault',
    0x800A21: 'KAFAS: FLA_FSC_Missing (high beam assistant enabling code missing)',
    0x800A01: 'KAFAS: FLA_Misconfiguration',
    0x800AC4: 'KAFAS: camera calibration failed',
    0x800AC8: 'KAFAS: permanent calibration fault',
};
const DTC_KEY = Object.keys(DTC_TEXT).map(Number);

/** 19 02 reply -> [{ code (number), hex, status, text, relevant }] or null */
function dtcs(reply) {
    if (!reply || reply[0] !== 0x59 || reply[1] !== 0x02) return null;
    const out = [];
    // 59 02 <availability mask> then 4 bytes per DTC: 3 code bytes + status
    for (let i = 3; i + 4 <= reply.length; i += 4) {
        const code = ((reply[i] << 16) | (reply[i + 1] << 8) | reply[i + 2]) >>> 0;
        out.push({ code, hex: hex(code, 6), status: reply[i + 3], text: DTC_TEXT[code] || '', relevant: DTC_KEY.indexOf(code) >= 0 });
    }
    return out;
}

module.exports = {
    BDC, KAFAS, FLM_L, FLM_R, SGBD, hex, hexs, data, nrc, sgbdIndex,
    BUTTON, buttonDids, KAFAS_DIDS, KAFAS_ORDER, REASONS, FASTA, ENABLE_CODE, DTC_TEXT, dtcs,
};
