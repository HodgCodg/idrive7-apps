'use strict';

// High Beam Assistant against the real kit/diag.js, with a fake BDC_G05 + KAFAS04 on a fake TASU that
// answer as BMW's SGBD tables describe. No SDK, vehicle or build needed:
//   node kit/tools/test_hba_assist.js
// Checks: only 22 / 19 02 ever reach the transport, the decoders, timeouts, the button test and findings,
// the catalog scan, and that every page draws with the kit's real canvas and gauges.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const root = path.resolve(__dirname, '..', '..');
const app = path.join(root, 'apps/hba_assist');

// Stage the app as the build lays it out: its files + kit runtime under ./kit/
const src = fs.mkdtempSync(path.join(os.tmpdir(), 'hba-assist-'));
fs.mkdirSync(path.join(src, 'kit'));
fs.readdirSync(app).filter((f) => f.endsWith('.js')).forEach((f) => fs.copyFileSync(path.join(app, f), path.join(src, f)));
fs.readdirSync(path.join(root, 'kit/runtime')).filter((f) => f.endsWith('.js')).forEach((f) => fs.copyFileSync(path.join(root, 'kit/runtime', f), path.join(src, 'kit', f)));
['fonts', 'locales'].forEach((d) => { if (fs.existsSync(path.join(root, 'kit/runtime', d))) fs.cpSync(path.join(root, 'kit/runtime', d), path.join(src, 'kit', d), { recursive: true }); });
['locale.json'].forEach((f) => { if (fs.existsSync(path.join(root, 'kit/runtime', f))) fs.copyFileSync(path.join(root, 'kit/runtime', f), path.join(src, 'kit', f)); });
process.on('exit', () => fs.rmSync(src, { recursive: true, force: true }));

const { HbaLink, check } = require(path.join(src, 'hba_link'));
const { Probe } = require(path.join(src, 'probe'));
const D = require(path.join(src, 'hba_dids'));
const catalog = require(path.join(src, 'catalog'));
const lines = [];
const log = { info: (m) => lines.push(m), warn: (m) => lines.push('W ' + m), error: (m) => lines.push('E ' + m) };

// ---- a fake car behind the real kit/diag.js (frames as the head unit's TASU delivers them) -----------
const { fakeSignals, kafas04, bdcG05, flm, pos, u32 } = require('./hba_fake_car');
function car(units) {
    const f = fakeSignals(units);
    const link = new HbaLink(f.signals, log, { timeoutMs: 150, dtcTimeoutMs: 300, gapMs: 1 });
    return { link, sent: f.sent, ready: link.init().then(() => link) };
}

(async () => {
    // 1. The guard: only 22 (1-8 DIDs) and 19 02 <mask>, only to 40 / 5D / 43 / 44.
    assert.doesNotThrow(() => check(0x40, 0x22, [0xE3, 0xB8]));
    assert.doesNotThrow(() => check(0x5D, 0x19, [0x02, 0xFF]));
    [[0x40, 0x2E, [0xE3, 0xB8, 1]], [0x40, 0x2F, [0x50, 0x24, 3, 1]], [0x40, 0x31, [0x01, 0xA5, 0x39]], [0x5D, 0x2E, [0xD3, 0xA6, 1]],
        [0x40, 0x10, [0x03]], [0x40, 0x14, [0xFF, 0xFF, 0xFF]], [0x40, 0x27, [0x01]], [0x40, 0x11, [0x01]], [0x40, 0x3E, [0x00]],
        [0xDF, 0x22, [0xF1, 0x50]], [0x12, 0x22, [0xF1, 0x50]], [0x40, 0x19, [0x04, 0, 0, 0, 0xFF]], [0x40, 0x22, []], [0x40, 0x22, [0xF1]],
        [0x40, 0x22, new Array(18).fill(0)], [0x40, 0x22, [0x100, 0]]].forEach((r) => {
        assert.throws(() => check(r[0], r[1], r[2]), undefined, 'allowed: ' + JSON.stringify(r));
    });

    // 2. A refused request never reaches the transport.
    let c = car({});
    await c.ready;
    await assert.rejects(c.link.request(0x40, 0x2E, [0xE3, 0xB8, 1]));
    await assert.rejects(c.link.request(0x40, 0x31, [0x01, 0xA5, 0x39]));
    assert.strictEqual(c.sent.length, 0, 'a write reached the transport');
    assert.strictEqual(c.link.stats.blocked, 2);

    // 3. Decoders against SGBD layouts.
    assert.strictEqual(D.sgbdIndex(pos(0xF150, [0x0F, 0x26, 0x80])), '0F2680');
    assert.deepStrictEqual(D.BUTTON[0xE3B8](pos(0xE3B8, [1, 0, 0, 0, 0, 0, 1, 0, 1, 0xFD, 0xFD])), { fla: 1, highBeam: 0, flash: 1 });
    assert.deepStrictEqual(D.BUTTON[0xD580](pos(0xD580, [1])), { fla: 1 });
    assert.strictEqual(D.BUTTON[0xE3B8]([0x7F, 0x22, 0x31]), null);
    assert.strictEqual(D.BUTTON[0xE3B8](pos(0xD580, [1, 0, 0, 0, 0, 0, 1, 0, 1])), null, 'another DID decoded as E3B8');
    assert.strictEqual(D.KAFAS_DIDS[0xE482].decode(pos(0xE482, [3])).text, 'EC_Off');
    const fasta = D.KAFAS_DIDS[0xE474].decode(pos(0xE474, [].concat.apply([], [70000, 0, 0, 0, 0, 0, 0, 0, 0, 12, 0, 0].map(u32))));
    assert.strictEqual(fasta.opTime, 70000); assert.strictEqual(fasta.overrideButton, 12);
    assert.deepStrictEqual(D.KAFAS_DIDS[0xD341].decode(pos(0xD341, [0, 0, 1, 1, 0, 0, 0, 0, 0, 0, 1, 0])).active, ['speed below threshold', 'ambient brightness (day)']);
    assert.deepStrictEqual(D.dtcs([0x59, 0x02, 0xFF, 0x80, 0x0A, 0x21, 0x09]).map((x) => [x.hex, x.relevant]), [['800A21', true]]);
    assert.deepStrictEqual(D.buttonDids('BDC_G05'), [0xE3B8]);
    assert.deepStrictEqual(D.buttonDids('BDC_G11'), [0xD580, 0xD583]);

    // 4. A full run on a G30 LCI-like car whose KAFAS has HBA off (EC_Off) and FLA_FSC_Missing stored.
    const st = { ec: 3, opTime: 0, kafasDtc: [0x80, 0x0A, 0x21, 0x08], stalk: () => ({ zero: 1, fla: 0, hb: 0, flash: 0 }) };
    const cat = path.join(src, 'someip-interfaces.json');
    fs.writeFileSync(cat, JSON.stringify({ version: 1, interfaces: {
        'de.bmw.infotainment.vehicle.Vehicle2': { serviceId: 1, fields: { statusCarSpeed2: { getter: { id: 1 }, notifier: {} } } },
        'de.bmw.infotainment.lighting.ExteriorLightSettings': { serviceId: 2, fields: { settingHighBeamAssistant: { getter: { id: 3 }, setter: { id: 4 }, notifier: {} } } },
    } }));
    c = car({ 0x40: bdcG05(st), 0x5D: kafas04(st), 0x43: flm([0x0F, 0x26, 0xC0]), 0x44: flm([0x0F, 0x26, 0xD0]) });
    await c.ready;
    let p = new Probe(c.link, { log, dataDir: src, catalogFile: cat });
    await p.run();
    assert.strictEqual(p.units[0x40].sgbd, 'BDC_G05');
    assert.strictEqual(p.units[0x5D].sgbd, 'KAFAS04');
    assert.strictEqual(p.units[0x43].sgbd, 'FLM02_L');
    assert.ok(c.sent.every((r) => r[1] === 0x22 || (r[1] === 0x19 && r[2] === 0x02)), 'probe sent something but 22 / 19 02');
    assert.ok(c.sent.every((r) => [0x40, 0x5D, 0x43, 0x44].indexOf(r[0]) >= 0));
    let f = p.findings().map((x) => x.level + ' ' + x.text);
    assert.ok(f.some((x) => /^crit KAFAS HBA enabling code: EC_Off/.test(x)), f.join('\n'));
    assert.ok(f.some((x) => /^crit KAFAS fault 800A21: KAFAS: FLA_FSC_Missing/.test(x)), f.join('\n'));
    assert.ok(f.some((x) => /^warn KAFAS: HBA has been active 0 s/.test(x)), f.join('\n'));
    assert.ok(f.some((x) => /^info KAFAS holds high beam off because: speed below threshold, ambient brightness/.test(x)));
    assert.ok(f.some((x) => /^ok Head unit offers 1 writable .*ExteriorLightSettings\.settingHighBeamAssistant/.test(x)), f.join('\n'));
    const saved = p.save();
    const rep = JSON.parse(fs.readFileSync(saved, 'utf8'));
    assert.ok(rep.trace.length >= 10 && rep.trace.some((x) => /^5D 22 E4 82/.test(x.req) && x.res === '62 E4 82 03'), 'report lacks raw exchanges');

    // 5. Button test: the HBA button toggles -> counted; only the stalk moves -> "button faulty".
    let n = 0;
    st.stalk = () => { n++; return { zero: 1, fla: n % 4 < 2 ? 1 : 0, hb: 0, flash: 0 }; };
    await p.buttonTest(800);
    assert.ok(p.button.presses >= 2, 'presses ' + p.button.presses);
    assert.ok(p.findings().some((x) => x.level === 'ok' && /saw the HBA button pressed/.test(x.text)));
    n = 0;
    st.stalk = () => { n++; return { zero: 0, fla: 0, hb: n % 4 < 2 ? 1 : 0, flash: 0 }; };
    await p.buttonTest(800);
    assert.strictEqual(p.button.presses, 0);
    assert.ok(p.findings().some((x) => x.level === 'crit' && /never the HBA button/.test(x.text)), p.findings().map((x) => x.text).join('\n'));

    // 6. Second run with the active-time counter higher: "ROSE"; EC_Operational -> ok.
    st.ec = 0; st.opTime = 0; st.kafasDtc = [];
    p = new Probe(c.link, { log, dataDir: src, catalogFile: path.join(src, 'missing.json') });
    await p.run(); st.opTime = 42; await p.run();
    f = p.findings();
    assert.ok(f.some((x) => x.level === 'ok' && /enabling code: EC_Operational/.test(x.text)));
    assert.ok(f.some((x) => x.basis === 'inference' && /counter ROSE \(0 -> 42 s/.test(x.text)));
    assert.ok(f.some((x) => x.level === 'warn' && /catalog not readable/.test(x.text)));

    // 7. Silent KAFAS: every read times out, the run still ends, and says so.
    c = car({ 0x40: bdcG05(st) });
    await c.ready;
    p = new Probe(c.link, { log, dataDir: src, catalogFile: cat });
    const t0 = Date.now();
    await p.run();
    assert.ok(Date.now() - t0 < 3000, 'run took ' + (Date.now() - t0) + ' ms');
    assert.ok(p.findings().some((x) => x.level === 'crit' && x.text === 'KAFAS did not answer'));
    assert.ok(!c.sent.some((r) => r[0] === 0x5D && !(r[1] === 0x22 && r[2] === 0xF1 && r[3] === 0x50)), 'a silent KAFAS was asked more than F150');
    assert.strictEqual(c.link.stats.missed, 3, 'KAFAS + both FLM F150 reads');

    // 8. Catalog scan: names in English and German, types and enum items, getter id 0 is no getter.
    const s = catalog.scan(JSON.stringify({ interfaces: {
        'a.Light': { fields: { fernlichtAssistentStatus: { getter: { id: 0 }, notifier: {} }, x: { dataRef: 'T1' } }, methods: { requestFLA: {} } },
        'b.Other': { fields: { speed: { getter: { id: 2 } } } } },
    datatypes: { T1: { type: 'struct', members: [{ name: 'highBeamAssist' }] }, E1: { type: 'enum', items: { HBA_ON: 1, FLASH: 2 } } } }));
    const got = s.hits.map((h) => h.kind + ':' + h.name + ':' + h.flags.join(','));
    assert.deepStrictEqual(got.sort(), ['enum:E1.HBA_ON:', 'field:fernlichtAssistentStatus:notify', 'member:T1.highBeamAssist:', 'method:requestFLA:'].sort());
    assert.deepStrictEqual(s.users.map((u) => u.iface + '.' + u.name), ['a.Light.x']);
    assert.ok(!catalog.PATTERN.test('flash') && !catalog.PATTERN.test('Flap') && !catalog.PATTERN.test('inflation'));

    // 9. Every page draws with the kit's real recorder and gauges, before and after a run.
    const { Recorder: Canvas } = require(path.join(src, 'kit/record'));     // what the GPU renderer gets on the car
    const G = require(path.join(src, 'kit/gauges'));
    const t = require(path.join(src, 'kit/themes')).theme('ice');
    const UI = require(path.join(src, 'ui'));
    const fresh = new Probe(c.link, { log, dataDir: src, catalogFile: cat });
    const texts = [];
    [fresh, p].forEach((pr) => UI.PAGES.forEach((pg) => {
        const cv = new Canvas(UI.W, UI.H), text = cv.text.bind(cv);
        cv.own = true;
        cv.text = function (str) { texts.push(String(str)); return text.apply(null, arguments); };
        UI.draw(cv, G, t, pr.view(), pg);
    }));
    assert.ok(texts.some((x) => /KAFAS did not answer/.test(x)), 'Findings page lacks the finding');
    assert.ok(texts.some((x) => /^Press "Run checks"/.test(x)), 'fresh page lacks the start hint');
    assert.ok(texts.some((x) => /^field  de\.bmw\.infotainment\.lighting\.ExteriorLightSettings  settingHighBeamAssistant  \[get, set, notify\]$/.test(x)), 'Interfaces page lacks the catalog match');

    console.log('test_hba_assist: all checks passed (' + lines.length + ' log lines)');
})().catch((e) => { console.error(e); console.error(lines.slice(-30).join('\n')); process.exit(1); });
