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
const { fakeSignals, kafas04, bdcG05, kombi, flm, pos, u32 } = require('./hba_fake_car');
function car(units, allow) {
    const f = fakeSignals(units);
    const link = new HbaLink(f.signals, log, { timeoutMs: 150, dtcTimeoutMs: 300, gapMs: 1, allow });
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
    assert.ok(c.sent.every((r) => [0x40, 0x5D, 0x43, 0x44, 0x60].indexOf(r[0]) >= 0));
    let f = p.findings().map((x) => x.level + ' ' + x.text);
    assert.ok(f.some((x) => /^crit KAFAS HBA enabling code: EC_Off$/.test(x)), f.join('\n'));
    assert.ok(p.findings().some((x) => x.basis === 'inference' && /not expected to run HBA/.test(x.text)), 'consequence not marked as inference');
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
    assert.ok(p.findings().some((x) => x.level === 'crit' && x.basis === 'inference' && /never the HBA button\. If it was held/.test(x.text)), p.findings().map((x) => x.text).join('\n'));

    // 6. Second run with the active-time counter higher: "ROSE"; EC_Operational -> ok.
    st.ec = 0; st.opTime = 0; st.kafasDtc = [];
    p = new Probe(c.link, { log, dataDir: src, catalogFile: path.join(src, 'missing.json') });
    await p.run(); st.opTime = 42; await p.run();
    f = p.findings();
    assert.ok(f.some((x) => x.level === 'ok' && /enabling code: EC_Operational/.test(x.text)));
    assert.ok(f.some((x) => x.basis === 'inference' && /counter ROSE \(0 -> 42 s/.test(x.text)));
    await p.run();
    assert.ok(p.findings().some((x) => x.level === 'info' && /counter unchanged \(42 s.*not conclusive/.test(x.text)), 'an unchanged counter read as "HBA not active"');
    st.ec = 4; await p.run();
    assert.ok(p.findings().some((x) => x.level === 'warn' && /EC_NA \(meaning for HBA unclear\)/.test(x.text)));
    st.ec = 0;
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
    assert.strictEqual(c.link.stats.missed, 4, 'KAFAS + both FLM + KOMBI F150 reads');

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

    // 10. Experiments: the exact-frame list, gates, sessions, refusals, revert in every way out, verdict.
    const X = require(path.join(src, 'experiments'));
    const ok = [[0x5D, 0x2E, [0xD3, 0xA6, 1]], [0x5D, 0x2E, [0xD3, 0xA6, 0]], [0x40, 0x31, [1, 0xA5, 0x39, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]],
        [0x40, 0x31, [2, 0xA5, 0x39]], [0x40, 0x31, [3, 0xA5, 0x39]], [0x40, 0x10, [3]], [0x5D, 0x10, [1]], [0x5D, 0x3E, [0]]];
    ok.forEach((r) => assert.ok(X.allowed(r[0], r[1], r[2]), 'not allowed: ' + JSON.stringify(r)));
    const no = [[0x5D, 0x2E, [0xD3, 0xA6, 2]], [0x40, 0x2E, [0xD3, 0xA6, 1]], [0x60, 0x2E, [0xD3, 0xA6, 1]],
        [0x40, 0x31, [1, 0xA5, 0x39, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]],          // SCHALTER_KAMERA 00: the app's own limits
        [0x40, 0x31, [1, 0xA5, 0x39, 1, 0x32, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]],       // a distance
        [0x40, 0x31, [1, 0xA5, 0x39, 1, 0, 0xFF, 0x6A, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]],    // a zone angle
        [0x40, 0x31, [1, 0xA5, 0x39, 1]], [0x5D, 0x31, [2, 0xA5, 0x39]], [0x40, 0x10, [2]], [0x60, 0x10, [3]], [0x43, 0x10, [3]],
        [0x40, 0x3E, [0x80]], [0x40, 0x27, [1]], [0x40, 0x2F, [0xE3, 0xB8, 3, 1]], [0x40, 0x2E, [0xD5, 0x42, 5]], [0x40, 0x14, [0xFF, 0xFF, 0xFF]],
        [0x5D, 0x2E, [0xD3, 0xA6, 1, 0]], [0xDF, 0x2E, [0xD3, 0xA6, 1]]];
    no.forEach((r) => assert.ok(!X.allowed(r[0], r[1], r[2]), 'allowed: ' + JSON.stringify(r)));
    let xs = { ec: 0, opTime: 0, stalk: () => ({ zero: 1, fla: 0, hb: 0, flash: 0 }), lampFollows: 'kafas' };
    c = car({ 0x40: bdcG05(xs), 0x5D: kafas04(xs), 0x60: kombi(xs) }, X.allowed);
    await c.ready;
    for (const r of no) await assert.rejects(c.link.request(r[0], r[1], r[2]));
    assert.strictEqual(c.sent.length, 0, 'a frame off the list reached the transport');

    const later2 = (ms) => new Promise((r) => setTimeout(r, ms));
    let il = { ok: true, why: '' };
    const exps = (link, pr) => new X.Experiments(link, pr, { log, dataDir: src, interlock: () => il, durationMs: 500, observeMs: 60, armMs: 400 });
    const writes = (sent) => sent.filter((r) => r[1] !== 0x22 && r[1] !== 0x19).map((r) => D.hexs(r));

    // gates: no checks yet -> nothing; one press only arms; interlock off -> nothing; wrong variant -> nothing
    p = new Probe(c.link, { log, dataDir: src, catalogFile: cat });
    let x = exps(c.link, p);
    await x.press('kafas'); await x.press('kafas');
    assert.ok(x.events.some((e) => /not started: run the checks first/.test(e.text)));
    await p.run();
    assert.strictEqual(p.units[0x60].sgbd, 'KOMBSP18');
    assert.ok(p.findings().some((f) => f.text === 'Cluster HBA indicator: off (low beam lamp green, high beam off)'), p.findings().map((f) => f.text).join('\n'));
    x = exps(c.link, p);
    await x.press('kafas');
    assert.strictEqual(x.view().armed, true);
    await later2(450); await x.press('kafas');                              // too late: arms again, sends nothing
    il = { ok: false, why: 'selector not in P (D)' };
    await x.press('kafas');
    assert.ok(x.events.some((e) => /not started: selector not in P/.test(e.text)));
    assert.deepStrictEqual(writes(c.sent), [], 'a gate let a write through');
    il = { ok: true, why: '' };

    // E1 accepted: indicator comes on, KAFAS switched off at the end, journal gone
    await x.press('kafas'); await x.press('kafas');
    assert.deepStrictEqual(writes(c.sent), ['5D 2E D3 A6 01', '5D 2E D3 A6 00']);
    assert.strictEqual(xs.kafasDemo, false, 'KAFAS left in demo mode');
    assert.ok(/CAME ON \(green\)/.test(x.verdict.text), x.verdict.text);
    assert.ok(!fs.existsSync(path.join(src, 'experiment-journal.json')));
    assert.ok(fs.readdirSync(path.join(src, 'reports')).some((f) => /^experiment-kafas-/.test(f)));

    // E1 needing the extended session: 10 03, retry, 3E 00 while it runs, off, 10 01
    c.sent.length = 0; xs.kafasWrite = 'session';
    await x.press('kafas'); await x.press('kafas');
    const w = writes(c.sent);
    assert.deepStrictEqual(w.slice(0, 3), ['5D 2E D3 A6 01', '5D 10 03', '5D 2E D3 A6 01']);
    assert.ok(w.filter((r) => r === '5D 3E 00').length >= 2, w.join(' | '));
    assert.deepStrictEqual(w.slice(-2), ['5D 2E D3 A6 00', '5D 10 01']);
    assert.strictEqual(xs.ext[0x5D], false); assert.strictEqual(xs.kafasDemo, false);

    // security access asked for: refused, never 27, still switched back
    c.sent.length = 0; xs.kafasWrite = 'nrc33';
    await x.press('kafas'); await x.press('kafas');
    assert.ok(x.events.some((e) => /refused: NRC 33 security access required \(not attempted\)/.test(e.text)));
    assert.ok(!c.sent.some((r) => r[1] === 0x27));
    assert.ok(writes(c.sent).indexOf('5D 2E D3 A6 00') >= 0);
    xs.kafasWrite = 'ok';

    // E2 whose stop routine is missing: 10 01 fallback, "ignition cycle" said; lamp from the BDC demo
    c.sent.length = 0; xs.lampFollows = 'bdc'; xs.bdcStop = 'nrc12';
    await x.press('bdc'); await x.press('bdc');
    const w2 = writes(c.sent);
    assert.strictEqual(w2[0], '40 31 01 A5 39 01' + ' 00'.repeat(13));   // SCHALTER_KAMERA 01, DISTANZ 00, 6 x 2 zone bytes
    assert.ok(w2.indexOf('40 31 03 A5 39') >= 0 && w2.indexOf('40 31 02 A5 39') >= 0 && w2[w2.length - 1] === '40 10 01', w2.join(' | '));
    assert.ok(x.events.some((e) => /refused: NRC 12 .*ignition cycle is the final revert/.test(e.text)));
    assert.ok(/CAME ON/.test(x.verdict.text));
    xs.bdcStop = 'ok'; xs.bdcDemo = false;

    // a stop press ends it early; the interlock going away ends it too
    c.sent.length = 0;
    const longX = new X.Experiments(c.link, p, { log, dataDir: src, interlock: () => il, durationMs: 60000, observeMs: 50, armMs: 400 });
    await longX.press('kafas'); const run = longX.press('kafas');
    await later2(300); await longX.press('kafas'); await run;
    assert.strictEqual(longX.state, 'done'); assert.strictEqual(xs.kafasDemo, false);
    const run2 = (longX.press('kafas'), longX.press('kafas'));
    await later2(300); il = { ok: false, why: 'the car is moving' }; await run2;
    assert.ok(longX.events.some((e) => /interlock lost \(the car is moving\)/.test(e.text))); assert.strictEqual(xs.kafasDemo, false);
    il = { ok: true, why: '' };

    // the wrong BDC: these bytes are for BDC_G05 only
    p.units[0x40].sgbd = 'BDC_G11';
    c.sent.length = 0; await x.press('bdc'); await x.press('bdc');
    assert.deepStrictEqual(writes(c.sent), []);
    assert.ok(x.events.some((e) => /these bytes are from BDC_G05; this car has BDC_G11/.test(e.text)));
    p.units[0x40].sgbd = 'BDC_G05';

    // the app stopped during a run: the next start switches it off first
    xs.kafasDemo = true;
    fs.writeFileSync(path.join(src, 'experiment-journal.json'), JSON.stringify({ id: 'kafas', t: 1 }));
    c.sent.length = 0;
    assert.strictEqual(await exps(c.link, p).recover(), true);
    assert.deepStrictEqual(writes(c.sent), ['5D 2E D3 A6 00']); assert.strictEqual(xs.kafasDemo, false);
    assert.strictEqual(await exps(c.link, p).recover(), false, 'recovered twice');

    // the Experiment page draws in every state
    const UI2 = require(path.join(src, 'ui'));
    const { Recorder } = require(path.join(src, 'kit/record'));
    const G2 = require(path.join(src, 'kit/gauges')), t2 = require(path.join(src, 'kit/themes')).theme('ice');
    const seen = [];
    [['off', ''], ['kafas', ''], ['bdc', 'run the checks first']].forEach((s2) => {
        const cv = new Recorder(UI2.W, UI2.H), text = cv.text.bind(cv);
        cv.own = true; cv.text = function (str) { seen.push(String(str)); return text.apply(null, arguments); };
        UI2.draw(cv, G2, t2, Object.assign(p.view(), { exp: x.view(), expId: s2[0], blocker: s2[1] }), 'Experiment');
    });
    assert.ok(seen.some((q) => /^HEADLIGHTS MAY SWITCH/.test(q)) && seen.some((q) => /^Off: nothing but reads is sent/.test(q)) && seen.some((q) => /^Cannot start: run the checks first/.test(q)));

    console.log('test_hba_assist: all checks passed (' + lines.length + ' log lines)');
})().catch((e) => { console.error(e); console.error(lines.slice(-30).join('\n')); process.exit(1); });
