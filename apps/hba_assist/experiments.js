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
 * Exact frames only (FRAMES + SESSION below); hba_link.js lets nothing else through. Never 27 (security
 * access): a unit that asks for it (NRC 33) ends the experiment. NRC 7E / 7F: one retry in 10 03, kept
 * alive with 3E 00 while it runs, 10 01 at the end.
 *
 * Gates: the setting picks one experiment (Off = nothing is sent), the unit must have answered 22 F150 as
 * the SGBD the bytes are from, the car must be stationary in P on live data (interlock()), and the start
 * button must be pressed twice within 4 s. A run ends after durationMs (60 s) or on the next press.
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
        warn: 'Car stationary in P. KAFAS demo mode on for up to 60 s, then off.' },
    bdc: { id: 'bdc', title: 'E2  BDC high beam assistant demo routine, camera limits (31 A539)', ecu: D.BDC, sgbd: 'BDC_G05', start: 'e2Start', stop: 'e2Stop',
        warn: 'HEADLIGHTS MAY SWITCH: aim the car at a wall, nobody in front. Stationary in P. Up to 60 s, then stopped.' },
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
        if (!this.armedAt || t - this.armedAt > this.armMs) {
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
        const u = this.probe.units[exp.ecu];
        if (!u || !u.answered) return (exp.ecu === D.BDC ? 'BDC' : 'KAFAS') + ' did not answer 22 F150';
        if (u.sgbd !== exp.sgbd) return 'these bytes are from ' + exp.sgbd + '; this car has ' + (u.sgbd || 'SGBD index ' + (u.index || '?'));
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
            const f = FRAMES[exp.start], sid = f[1];
            let r = await this.send(exp.start);
            let n = nrcOf(r, sid);
            if (n === 0x7E || n === 0x7F) {
                this.event('info', exp.sgbd + ' wants the extended session (NRC ' + D.hex(n) + '): 10 03');
                const s = await this.session(exp.ecu, 0x03);
                if (positive(s, 0x10)) { this.extended = true; r = await this.send(exp.start); n = nrcOf(r, sid); } else this.event('crit', 'extended session refused (' + D.hexs(s) + ')');
            }
            if (!r) { this.event('crit', 'no answer to the start request'); return; }
            if (n !== null) { this.event('crit', 'refused: NRC ' + nrcText(n)); return; }
            if (!positive(r, sid)) { this.event('crit', 'unexpected answer ' + D.hexs(r)); return; }
            this.event('ok', 'accepted (' + D.hexs(r) + '). Watching the cluster indicator for ' + Math.round(this.durationMs / 1000) + ' s');
            this.endsAt = this.now() + this.durationMs;
            while (!this.stopRequested && this.now() < this.endsAt) {
                await sleep(this.observeMs);
                if (this.extended) await this.link.request(exp.ecu, 0x3E, [0x00], 1500);     // tester present: keep the session (and the routine) alive
                const o = Object.assign({ phase: 'during' }, await this.probe.observe());
                this.samples.push(o);
                if (this.samples.length > 200) this.samples.splice(1, 1);
                const il = this.interlock();
                if (!il.ok) { this.event('crit', 'interlock lost (' + il.why + '): stopping'); break; }
            }
            if (exp.id === 'bdc') {
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

    /** send the experiment's off / stop frame; fall back to the default session; clear the journal */
    async _revert(exp) {
        const f = FRAMES[exp.stop];
        const r = await this.send(exp.stop).catch(() => null);
        const n = nrcOf(r, f[1]);
        if (positive(r, f[1])) this.event('ok', 'switched back (' + D.hexs(r) + ')');
        else {
            this.event('warn', 'stop ' + (r ? 'refused: NRC ' + nrcText(n) : 'not answered') + ' - returning ' + exp.sgbd + ' to the default session (10 01); an ignition cycle is the final revert');
        }
        if (this.extended || !positive(r, f[1])) await this.session(exp.ecu, 0x01).catch(() => null);
        this.extended = false;
        this._clearJournal();
    }

    _verdict() {
        const b = this.samples.filter((s) => s.phase === 'before')[0] || {};
        const during = this.samples.filter((s) => s.phase === 'during');
        if (!during.length) return { level: 'info', text: 'not run far enough to observe (see the events above)' };
        const seen = during.filter((s) => s.lamps);
        if (!seen.length || !b.lamps) return { level: 'warn', text: 'the cluster indicator could not be read; check what the cluster showed' };
        const lit = seen.filter((s) => s.lamps.hba);
        const recs = Array.from(new Set(during.map((s) => s.rec).filter(Boolean)));
        const extra = ' KAFAS recommendation during: ' + (recs.join(' / ') || '-') + '.';
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
