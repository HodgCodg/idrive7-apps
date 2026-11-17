'use strict';
/**
 * experiments.js - live-diagnostic EXPERIMENTS: the only writes this app can send. Each is a diagnostic job
 * from BMW's own SGBD that names the high beam assistant, run on the stationary car to see what it does to
 * the cluster's HBA indicator and KAFAS's view, and switched back off afterwards. They are BMW
 * demo / diagnostic modes under test, NOT the factory activation path and not an Enable button.
 *
 *   E1 kafas  KAFAS04  2E D3A6 01 / 00   DEMO_MODE_FLA ("Demo-Mode für Fernlichtassistent ein-/ausschalten").
 *             No read-back exists (2E only); may persist - so it is switched off at stop, on timeout and at
 *             every app start that finds a journal of an unfinished run.
 *   E2 bdc    BDC_G05  31 01 A539 01 00 00..   LICHT_FLA_DEMO_MODUS ("Aktivierung und Steuerung des
 *             Fernlichtassistenten für Präsentationen und Diagnose") with SCHALTER_KAMERA = 1: the glare-free
 *             limits come from KAFAS's camera, never from the app (the 13 angle/distance bytes are fixed 0).
 *             Stop 31 02 A539; a unit without a stop routine gets 10 01 (and an ignition cycle ends it).
 *             THE HEADLIGHTS MAY SWITCH: aim the car at a wall, nobody in front.
 *
 *   E5 both   E1 then E2: KAFAS's HBA demo mode on, so the camera is in HBA mode and (presumably) sends its
 *             glare-free limits, AND the BDC's demo routine with SCHALTER_KAMERA = 1 ("use the limits from the camera
 *             signals"), so the BDC drives the matrix headlights from them: the factory glare-free assistant as a
 *             whole. Stopped in reverse order (E2 stop, then E1 off).
 *
 * Exact frames only (FRAMES + SESSION below); hba_link.js lets nothing else through. Never 27 (security
 * access): a unit that asks for it (NRC 33) ends the experiment. NRC 7E / 7F: one retry in 10 03, kept
 * alive with 3E 00 while it runs, 10 01 at the end.
 *
 * Gates: the setting picks one experiment (Off = nothing is sent), the unit must have answered 22 F150 as
 * the SGBD the bytes are from, the car must be stationary in P on live data (interlock()), and the start
 * button must be pressed twice within 4 s (opts.singlePress: once). A run ends after durationMs (60 s) or on the
 * next press (opts.untilStopped: only on the next press).
 * The verdict comes from the cluster's own HBA indicator (KOMBI 2520), read before, during and after.
 */
const fs = require('fs');
const path = require('path');
const D = require('./hba_dids');

const FRAMES = Object.freeze({
    e1On: [0x5D, 0x2E, [0xD3, 0xA6, 0x01]],
    e1Off: [0x5D, 0x2E, [0xD3, 0xA6, 0x00]],
    // 31 01 A539, SCHALTER_KAMERA 01, DISTANZ_ALLER_GRENZEN 00, 6 x signed int zone limits 0000 (unused with the camera switch)
    e2Start: [0x40, 0x31, [0x01, 0xA5, 0x39, 0x01, 0x00, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]],
    e2Stop: [0x40, 0x31, [0x02, 0xA5, 0x39]],
    e2Results: [0x40, 0x31, [0x03, 0xA5, 0x39]],
});
const SESSION = Object.freeze([[0x10, [0x01]], [0x10, [0x03]], [0x3E, [0x00]]]);   // to 0x40 / 0x5D

const EXPERIMENTS = Object.freeze({
    kafas: { id: 'kafas', title: 'E1  KAFAS high beam assistant demo mode (2E D3A6)', ecu: D.KAFAS, sgbd: 'KAFAS04', start: 'e1On', stop: 'e1Off',
        warn: 'KAFAS demo mode on.' },
    bdc: { id: 'bdc', title: 'E2  BDC high beam assistant demo routine, camera limits (31 A539)', ecu: D.BDC, sgbd: 'BDC_G05', start: 'e2Start', stop: 'e2Stop',
        warn: 'Headlights may switch.' },
    both: { id: 'both', title: 'E5  Factory glare-free HBA: KAFAS demo + BDC routine with camera limits', ecu: D.BDC, sgbd: 'BDC_G05',
        parts: ['kafas', 'bdc'], warn: 'KAFAS demo mode and the BDC routine together.' },
});

const same = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);

/** the exact-frame list (hba_link.js opts.allow) */
function allowed(target, sid, data) {
    const k = Object.keys(FRAMES);
    for (let i = 0; i < k.length; i++) {
        const f = FRAMES[k[i]];
        if (f[0] === target && f[1] === sid && same(f[2], data)) return true;
    }
    if (target !== D.BDC && target !== D.KAFAS) return false;
    return SESSION.some((f) => f[0] === sid && same(f[1], data));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const positive = (r, sid) => !!r && r[0] === sid + 0x40;
const nrcOf = (r, sid) => (r && r[0] === 0x7F && r[1] === sid ? r[2] : null);
const NRC_TEXT = { 0x11: 'service not supported', 0x12: 'not supported by this unit', 0x13: 'wrong length', 0x22: 'conditions not correct',
    0x24: 'sequence error', 0x31: 'out of range', 0x33: 'security access required (not attempted)', 0x7E: 'not in this session', 0x7F: 'not in this session' };
const nrcText = (n) => D.hex(n) + ' ' + (NRC_TEXT[n] || '');

class Experiments {
    /**
     * opts: { log, dataDir, interlock: () => ({ ok, why }), now, durationMs (60000), observeMs (2000), armMs (4000) }
     */
    constructor(link, probe, opts) {
        this.link = link;
        this.probe = probe;
        this.log = opts.log;
        this.journal = path.join(opts.dataDir, 'experiment-journal.json');
        this.interlock = opts.interlock || (() => ({ ok: false, why: 'no interlock' }));
        this.now = opts.now || (() => Date.now());
        this.durationMs = opts.durationMs || 60000;
        this.observeMs = opts.observeMs || 2000;
        this.armMs = opts.armMs || 4000;
        this.singlePress = !!opts.singlePress;      // the app: one press starts
        this.untilStopped = !!opts.untilStopped;    // the app: runs until the next press (or the next app start)
        this.state = 'idle';                  // idle | running | done
        this.current = null;                  // the experiment of the last / current run
        this.events = [];
        this.samples = [];
        this.verdict = null;
        this.armedAt = 0;
        this.stopRequested = false;
        this.extended = false;
        this.endsAt = 0;
        this.running = null;
    }

    event(level, text) {
        this.events.push({ t: this.now(), level, text });
        if (this.events.length > 60) this.events.shift();
        this.log[level === 'crit' ? 'warn' : 'info']('experiment: ' + text);
    }

    send(key) { const f = FRAMES[key]; return this.link.request(f[0], f[1], f[2], 3000); }
    session(ecu, sub) { return this.link.request(ecu, 0x10, [sub], 3000); }

    /** an unfinished run (app stopped / restarted during it): switch it off now */
    async recover() {
        let j = null;
        try { j = JSON.parse(fs.readFileSync(this.journal, 'utf8')); } catch (e) { return false; }
        const exp = EXPERIMENTS[j && j.id];
        if (!exp) { this._clearJournal(); return false; }
        this.current = exp;
        this.event('warn', 'an unfinished ' + exp.id + ' run was found (started ' + new Date(j.t).toISOString() + '): switching it off');
        await this._revert(exp);
        return true;
    }

    /** the experiment button: running -> stop; else the 1st press arms, a 2nd within armMs starts */
    press(id) {
        if (this.state === 'running') { this.stopRequested = true; this.event('info', 'stop pressed'); return this.running || Promise.resolve(); }
        const exp = EXPERIMENTS[id];
        if (!exp) { this.event('info', 'no experiment selected (Settings, Experiment)'); return Promise.resolve(); }
        const why = this.blocker(id);
        if (why) { this.armedAt = 0; this.current = exp; this.event('crit', 'not started: ' + why); return Promise.resolve(); }
        const t = this.now();
        if (!this.singlePress && (!this.armedAt || t - this.armedAt > this.armMs)) {
            this.armedAt = t;
            this.current = exp;
            this.event('warn', 'armed: ' + exp.warn + ' Press again within ' + Math.round(this.armMs / 1000) + ' s to start');
            return Promise.resolve();
        }
        this.armedAt = 0;
        this.running = this.start(id).catch((e) => this.event('crit', 'error: ' + (e && e.message || e))).then(() => { this.running = null; });
        return this.running;
    }

    /** why id can't run now ('' = it can) */
    blocker(id) {
        const exp = EXPERIMENTS[id];
        if (!exp) return 'no experiment selected';
        if (!this.probe.started || this.probe.state !== 'done') return 'run the checks first';
        for (const part of (exp.parts ? exp.parts.map((k) => EXPERIMENTS[k]) : [exp])) {
            const u = this.probe.units[part.ecu];
            if (!u || !u.answered) return (part.ecu === D.BDC ? 'BDC' : 'KAFAS') + ' did not answer 22 F150';
            if (u.sgbd !== part.sgbd) return 'these bytes are from ' + part.sgbd + '; this car has ' + (u.sgbd || 'SGBD index ' + (u.index || '?'));
        }
        const il = this.interlock();
        if (!il.ok) return il.why;
        return '';
    }

    async start(id) {
        const exp = EXPERIMENTS[id];
        this.current = exp;
        const why = this.blocker(id);
        if (why) { this.event('crit', 'not started: ' + why); return; }
        this.state = 'running';
        this.stopRequested = false;
        this.extended = false;
        this.samples = [];
        this.verdict = null;
        try {
            const ec = this.probe.kafas[0xE482] && this.probe.kafas[0xE482].value;
            if (ec && ec.raw !== 0 && ec.raw !== 5) this.event('warn', 'KAFAS enabling code is ' + ec.text + ': normal HBA is not expected whatever this shows');
            this._writeJournal(exp);
            this.samples.push(Object.assign({ phase: 'before' }, await this.probe.observe()));
            this.extendedEcus = [];
            for (const part of (exp.parts ? exp.parts.map((k) => EXPERIMENTS[k]) : [exp])) {
                if (!(await this._start(part))) return;
            }
            this.extended = this.extendedEcus.length > 0;
            const dur = this.untilStopped ? 0 : exp.durationMs || this.durationMs;
            this.event('ok', 'running. Watching the cluster, the camera and the BDC ' + (dur ? 'for ' + Math.round(dur / 1000) + ' s' : 'until you press again'));
            this.endsAt = dur ? this.now() + dur : 0;
            while (!this.stopRequested && (!this.endsAt || this.now() < this.endsAt)) {
                await sleep(this.observeMs);
                for (const ecu of this.extendedEcus) await this.link.request(ecu, 0x3E, [0x00], 1500);     // tester present: keep the session (and the routine) alive
                const o = Object.assign({ phase: 'during' }, await this.probe.observe());
                this.samples.push(o);
                if (this.samples.length > 200) this.samples.splice(1, 1);
                const il = this.interlock();
                if (!il.ok) { this.event('crit', 'interlock lost (' + il.why + '): stopping'); break; }
            }
            if (exp.id === 'bdc' || exp.id === 'both') {
                const rr = await this.send('e2Results');
                this.event('info', 'routine results: ' + (rr ? D.hexs(rr) : 'no answer'));
            }
        } finally {
            await this._revert(exp);
            this.samples.push(Object.assign({ phase: 'after' }, await this.probe.observe().catch(() => ({}))));
            this.verdict = this._verdict();
            this.event(this.verdict.level, 'verdict: ' + this.verdict.text);
            this.state = 'done';
            this.endsAt = 0;
            this._save();
        }
    }

    /** one part's start frame (with one retry in 10 03); true when accepted */
    async _start(part) {
        const sid = FRAMES[part.start][1];
        let r = await this.send(part.start);
        let n = nrcOf(r, sid);
        if (n === 0x7E || n === 0x7F) {
            this.event('info', part.sgbd + ' wants the extended session (NRC ' + D.hex(n) + '): 10 03');
            const s = await this.session(part.ecu, 0x03);
            if (positive(s, 0x10)) { this.extendedEcus.push(part.ecu); r = await this.send(part.start); n = nrcOf(r, sid); } else this.event('crit', 'extended session refused (' + D.hexs(s) + ')');
        }
        if (!r) { this.event('crit', part.id + ': no answer to the start request'); return false; }
        if (n !== null) { this.event('crit', part.id + ' refused: NRC ' + nrcText(n)); return false; }
        if (!positive(r, sid)) { this.event('crit', part.id + ': unexpected answer ' + D.hexs(r)); return false; }
        this.event('ok', part.id + ' accepted (' + D.hexs(r) + ')');
        return true;
    }

    /** send the experiment's off / stop frame; fall back to the default session; clear the journal */
    async _revert(exp) {
        if (exp.parts) {
            const parts = exp.parts.slice().reverse().map((k) => EXPERIMENTS[k]);
            for (const part of parts) await this._revertOne(part, (this.extendedEcus || []).indexOf(part.ecu) >= 0);
            this.extended = false; this.extendedEcus = [];
            this._clearJournal();
            return;
        }
        await this._revertOne(exp, this.extended);
        this.extended = false;
        this._clearJournal();
    }

    async _revertOne(exp, extended) {
        const f = FRAMES[exp.stop];
        const r = await this.send(exp.stop).catch(() => null);
        const n = nrcOf(r, f[1]);
        if (positive(r, f[1])) this.event('ok', 'switched back (' + D.hexs(r) + ')');
        else {
            this.event('warn', 'stop ' + (r ? 'refused: NRC ' + nrcText(n) : 'not answered') + ' - returning ' + exp.sgbd + ' to the default session (10 01); an ignition cycle is the final revert');
        }
        if (extended || !positive(r, f[1])) await this.session(exp.ecu, 0x01).catch(() => null);
    }

    _verdict() {
        const b = this.samples.filter((s) => s.phase === 'before')[0] || {};
        const during = this.samples.filter((s) => s.phase === 'during');
        if (!during.length) return { level: 'info', text: 'not run far enough to observe (see the events above)' };
        const seen = during.filter((s) => s.lamps);
        if (!seen.length || !b.lamps) return { level: 'warn', text: 'the cluster indicator could not be read; check what the cluster showed' };
        const lit = seen.filter((s) => s.lamps.hba);
        const recs = Array.from(new Set(during.map((s) => s.rec).filter(Boolean)));
        const bdc = during.filter((s) => s.bdc);
        const uniq = (k) => Array.from(new Set(bdc.map((s) => s.bdc[k]).filter((v) => v !== null && v !== undefined))).join(' / ') || '-';
        const extra = ' KAFAS recommendation during: ' + (recs.join(' / ') || '-') + '.' + (bdc.length ? ' BDC during: high beam ' + uniq('highBeam') +
            ', HBA function ' + uniq('hbaState') + ', glare-free HBA function ' + uniq('gfhbaState') + '.' : '');
        if (lit.length && !b.lamps.hba) return { level: 'ok', text: 'the cluster HBA indicator CAME ON (' + D.colour(lit[0].lamps.hba) + ') in ' + lit.length + ' of ' + seen.length + ' readings.' + extra };
        if (b.lamps.hba) return { level: 'info', text: 'the HBA indicator was already on before the run (' + D.colour(b.lamps.hba) + ').' + extra };
        return { level: 'warn', text: 'the HBA indicator stayed off (' + seen.length + ' readings).' + extra };
    }

    _writeJournal(exp) { try { fs.writeFileSync(this.journal, JSON.stringify({ id: exp.id, t: this.now() })); } catch (e) { this.log.warn('journal: ' + e); } }
    _clearJournal() { try { if (fs.existsSync(this.journal)) fs.unlinkSync(this.journal); } catch (e) { this.log.warn('journal: ' + e); } }

    _save() {
        try {
            const dir = path.join(path.dirname(this.journal), 'reports');
            if (!fs.existsSync(dir)) fs.mkdirSync(dir);
            const file = path.join(dir, 'experiment-' + (this.current ? this.current.id : 'x') + '-' + new Date(this.now()).toISOString().replace(/[:.]/g, '-') + '.json');
            fs.writeFileSync(file, JSON.stringify({ experiment: this.current, verdict: this.verdict, events: this.events, samples: this.samples, trace: this.link.trace.slice() }, null, 1));
            this.log.info('experiment report saved: ' + file);
        } catch (e) { this.log.warn('experiment report not saved: ' + e); }
    }

    view() {
        return { state: this.state, current: this.current, events: this.events.slice(-14), samples: this.samples.slice(-1)[0] || null,
            verdict: this.verdict, armed: !!this.armedAt && this.now() - this.armedAt <= this.armMs, endsAt: this.endsAt, extended: this.extended };
    }
}

module.exports = { Experiments, EXPERIMENTS, FRAMES, allowed };
