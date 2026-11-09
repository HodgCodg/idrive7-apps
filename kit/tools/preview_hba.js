#!/usr/bin/env node
'use strict';
/**
 * preview_hba.js - the High Beam Assistant app's pages with a SIMULATED car behind its diagnostic link
 * (kit/tools/hba_fake_car.js), as PNGs. The plain preview.js stub has no TASU, so it can only show the
 * "link not available" screens; this one shows the pages filled in. Nothing here is the real car.
 *
 *   python3 kit/tools/build.py hba_assist --preview-only
 *   node kit/tools/preview_hba.js [dist/hba_assist] [out=preview/hba-sim] [--scenario off|ok|stalk]
 *
 * Scenarios: off   = KAFAS enabling code EC_Off + FLA_FSC_Missing stored, button works
 *            ok    = enabling code operational, HBA active-time counter rising, button works
 *            stalk = enabling code operational, the stalk moves but the HBA button never registers
 */
const fs = require('fs');
const path = require('path');
const { headUnit } = require('./hu-stub');
const { fakeSignals, kafas04, bdcG05, flm } = require('./hba_fake_car');

const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv.splice(i, 2)[1] : d; };
const scenario = opt('--scenario', 'off');
const stage = path.resolve(argv[0] || 'dist/hba_assist');
const out = path.resolve(argv[1] || path.join('preview', 'hba-sim-' + scenario));
fs.mkdirSync(out, { recursive: true });

let n = 0;
const st = {
    off: { ec: 3, opTime: 0, kafasDtc: [0x80, 0x0A, 0x21, 0x08] },
    ok: { ec: 0, opTime: 1200, kafasDtc: [] },
    stalk: { ec: 0, opTime: 0, kafasDtc: [], bdcDtc: [0x03, 0x03, 0x42, 0x08] },
}[scenario];
st.stalk = scenario === 'stalk'
    ? () => { n++; return { zero: 0, fla: 0, hb: n % 6 < 3 ? 1 : 0, flash: 0 }; }
    : () => { n++; return { zero: 1, fla: n % 6 < 3 ? 1 : 0, hb: 0, flash: 0 }; };

let frame = 0;
const hu = headUnit(stage, {
    dataDir: out, fresh: true, sets: {},
    image: async (name, cv) => {
        const f = path.join(out, name.toLowerCase() + '-' + (frame++) + '.png');
        fs.writeFileSync(f, Buffer.isBuffer(cv) ? cv : cv.png());
    },
});
const car = fakeSignals({ 0x40: bdcG05(st), 0x5D: kafas04(st), 0x43: flm([0x0F, 0x26, 0xC0]), 0x44: flm([0x0F, 0x26, 0xD0]) });
hu.ctx.signals = car.signals;
hu.start();

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const click = async (b) => { await hu.handlers[b]({ row: 0 }); await wait(300); };
setTimeout(async () => {
    await click('BTN_RUN');                 // returns when the run is done (the fake car answers in ms)
    if (scenario === 'ok') { st.opTime += 30; await click('BTN_RUN'); }
    await hu.loopFn();                      // Findings
    for (let i = 0; i < 3; i++) { await click('BTN_PAGE'); await hu.loopFn(); }   // KAFAS, Button, Interfaces
    await click('BTN_PAGE');                // back to Findings
    const t = hu.handlers.BTN_BUTTON({ row: 0 });   // 20 s button test against the fake stalk
    await wait(3000); await hu.loopFn();
    await t; await hu.loopFn();
    await click('BTN_PAGE'); await click('BTN_PAGE'); await click('BTN_PAGE'); await hu.loopFn();   // Findings after
    const sent = car.sent.map((r) => r[1]);
    console.log('preview_hba: ' + frame + ' frames in ' + out + '; requests sent: ' + sent.length +
        ' (services ' + Array.from(new Set(sent)).map((x) => x.toString(16)).join(', ') + ')');
    process.exit(0);
}, 1500);
