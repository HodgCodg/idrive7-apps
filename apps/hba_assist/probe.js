'use strict';
/**
 * probe.js - finds out, from the car itself, why the high beam assistant (HBA / FLA) does not come on
 * and which way of switching it, if any, this car offers. READ-ONLY (hba_link.js refuses anything else).
 *
 *   const p = new Probe(link, { log, dataDir, catalogFile });
 *   await p.run()                 identify the units, read KAFAS's HBA state, fault memories, catalog scan
 *   await p.buttonTest(15000, fn) poll the stalk's HBA button as the BDC sees it; fn(view) on each change
 *   p.view()                      everything known so far, for the screen
 *   p.findings()                  [{ level: 'ok'|'warn'|'crit'|'info', text, basis }]  basis: measured / inference
 *   p.save()                      writes <dataDir>/reports/hba-<time>.json (raw replies included)
 */
const fs = require('fs');
const path = require('path');
const D = require('./hba_dids');
const catalog = require('./catalog');

const UNITS = [[D.BDC, 'BDC'], [D.KAFAS, 'KAFAS'], [D.FLM_L, 'FLM left'], [D.FLM_R, 'FLM right']];
const DTC_MASK = 0xFF;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class Probe {
    constructor(link, opts) {
        this.link = link;
        this.log = opts.log;
        this.dataDir = opts.dataDir;
        this.catalogFile = opts.catalogFile;
        this.now = opts.now || (() => Date.now());
        this.state = 'idle';            // idle | running | button | done
        this.units = {};                // addr -> { index, sgbd, answered, nrc }
        this.kafas = {};                // did -> { name, value, raw, nrc, answered }
        this.faults = {};               // addr -> { list, raw, answered }
        this.catalog = null;
        this.button = { dids: [], samples: 0, answered: 0, fla: null, presses: 0, highBeam: 0, flash: 0, ran: false, lastMs: 0 };
        this.opHistory = [];            // [{ t, opTime }] FASTA "time HBA activated by driver" readings
        this.started = null;
        this.cancelled = false;
    }

    /** the whole read-only check; resolves when done (each request has its own timeout) */
    async run() {
        if (this.state === 'running' || this.state === 'button') return;
        this.state = 'running';
        this.started = new Date(this.now()).toISOString();
        this.cancelled = false;
        try {
            for (const [addr, name] of UNITS) {
                if (this.cancelled) return;
                const r = await this.link.read(addr, 0xF150);
                const index = D.sgbdIndex(r);
                this.units[addr] = { name, answered: !!r, index, sgbd: (D.SGBD[addr] || {})[index] || '', nrc: D.nrc(r), raw: D.hexs(r) };
            }
            await this.readKafas();
            const bdc = this.units[D.BDC] || {};
            this.button.dids = D.buttonDids(bdc.sgbd);
            if (this.present(D.BDC)) {
                await this.readButtonOnce();
                if (this.button.dids.indexOf(0xD580) < 0) {       // BDC_G05's SGBD (a test-bench revision) has no D580: does this car's?
                    const r = await this.link.read(D.BDC, 0xD580, 800);
                    this.extraD580 = { answered: !!r, value: D.BUTTON[0xD580](r), nrc: D.nrc(r), raw: D.hexs(r) };
                }
            }
            for (const addr of [D.BDC, D.KAFAS]) {
                if (this.cancelled) return;
                if (!this.present(addr)) continue;
                const r = await this.link.dtcs(addr, DTC_MASK);
                this.faults[addr] = { answered: !!r, list: D.dtcs(r), nrc: D.nrc(r), raw: D.hexs(r) };
            }
            this.catalog = catalog.scanFile(this.catalogFile);
            this.log.info('catalog: ' + (this.catalog.ok ? this.catalog.interfaces + ' interfaces, ' + this.catalog.hits.length + ' matches' : this.catalog.error));
            this.catalog.hits.concat(this.catalog.users || []).forEach((h) => this.log.info('catalog match: ' + h.kind + ' ' + (h.iface ? h.iface + ' ' : '') + h.name + (h.flags.length ? ' [' + h.flags.join(',') + ']' : '')));
        } catch (e) {
            this.log.error('probe: ' + (e && e.stack || e));
            this.error = String(e && e.message || e);
        } finally {
            this.state = 'done';
        }
        this.findings().forEach((f) => this.log.info('finding [' + f.level + '/' + f.basis + '] ' + f.text));
    }

    /** did the unit answer 22 F150? (one that didn't is not asked anything else: each read would only time out) */
    present(addr) { return !!(this.units[addr] && this.units[addr].answered); }

    async readKafas() {
        if (!this.present(D.KAFAS)) return;
        for (const did of D.KAFAS_ORDER) {
            if (this.cancelled) return;
            const r = await this.link.read(D.KAFAS, did);
            const def = D.KAFAS_DIDS[did];
            this.kafas[did] = { name: def.name, answered: !!r, value: def.decode(r), nrc: D.nrc(r), raw: D.hexs(r) };
        }
        const f = this.kafas[0xE474] && this.kafas[0xE474].value;
        if (f && typeof f.opTime === 'number') this.opHistory.push({ t: this.now(), opTime: f.opTime });
    }

    async readButtonOnce() {
        const out = {};
        for (const did of this.button.dids) {
            const r = await this.link.read(D.BDC, did, 800);
            this.button.samples++;
            const v = D.BUTTON[did](r);
            if (v) { this.button.answered++; Object.keys(v).forEach((k) => { if (v[k] !== undefined) out[k] = v[k]; }); }
            else if (r) this.button['nrc' + D.hex(did, 4)] = D.nrc(r);
        }
        return out;
    }

    /** poll the button for ms; counts presses (0 -> 1 edges) of HBA button, high beam push and flash pull */
    async buttonTest(ms, onChange) {
        if (this.state === 'running' || this.state === 'button') return;
        if (!this.button.dids.length) this.button.dids = D.buttonDids((this.units[D.BDC] || {}).sgbd);
        this.state = 'button';
        this.cancelled = false;
        Object.assign(this.button, { presses: 0, highBeam: 0, flash: 0, samples: 0, answered: 0, ran: true, endsAt: this.now() + ms });
        let prev = {};
        try {
            while (this.now() < this.button.endsAt && !this.cancelled) {
                const v = await this.readButtonOnce();
                if (v.fla === 1 && prev.fla !== 1) this.button.presses++;
                if (v.highBeam === 1 && prev.highBeam !== 1) this.button.highBeam++;
                if (v.flash === 1 && prev.flash !== 1) this.button.flash++;
                const changed = v.fla !== prev.fla || v.highBeam !== prev.highBeam || v.flash !== prev.flash;
                this.button.fla = v.fla === undefined ? null : v.fla;
                prev = v;
                if (changed) {
                    this.log.info('stalk: HBA button=' + v.fla + ' high beam=' + v.highBeam + ' flash=' + v.flash);
                    if (onChange) onChange(this.view());
                }
                await sleep(40);       // the read itself takes a round trip; hold the button ~1 s so a press can't fall between two reads
            }
        } finally {
            this.state = 'done';
            this.button.endsAt = 0;
        }
        this.log.info('button test: ' + this.button.samples + ' reads, ' + this.button.answered + ' answered, HBA presses ' + this.button.presses +
            ', high beam pushes ' + this.button.highBeam + ', flash pulls ' + this.button.flash);
        if (onChange) onChange(this.view());
    }

    cancel() { this.cancelled = true; }

    /** is KAFAS's "time HBA activated by the driver" counter rising between two runs? */
    opTimeTrend() {
        const h = this.opHistory;
        if (h.length < 2) return null;
        const a = h[h.length - 2], b = h[h.length - 1];
        return { from: a.opTime, to: b.opTime, seconds: Math.round((b.t - a.t) / 1000), rising: b.opTime > a.opTime };
    }

    findings() {
        const out = [];
        const add = (level, text, basis) => out.push({ level, text, basis: basis || 'measured' });
        const bdc = this.units[D.BDC], kaf = this.units[D.KAFAS];
        if (bdc) add(bdc.answered ? 'info' : 'crit', bdc.answered ? 'BDC: SGBD index ' + (bdc.index || '?') + (bdc.sgbd ? ' = ' + bdc.sgbd : ' (unknown variant)') : 'BDC did not answer');
        if (kaf) add(kaf.answered ? 'info' : 'crit', kaf.answered ? 'KAFAS: SGBD index ' + (kaf.index || '?') + (kaf.sgbd ? ' = ' + kaf.sgbd : ' (not KAFAS04: identifiers below may not apply)') : 'KAFAS did not answer');
        if (this.extraD580 && this.extraD580.value) add('info', 'BDC also answers D580 (HBA button, BDC2015 identifier): ' + this.extraD580.raw);
        const k = (did) => this.kafas[did] && this.kafas[did].value;
        const ec = k(0xE482);
        if (ec) {
            if (ec.raw === 0 || ec.raw === 5) add('ok', 'KAFAS HBA enabling code: ' + ec.text);
            else if (ec.raw === 4 || ec.raw === 0xFF) add('warn', 'KAFAS HBA enabling code: ' + ec.text + ' (meaning for HBA unclear)');
            else {
                add('crit', 'KAFAS HBA enabling code: ' + ec.text);
                add('crit', 'KAFAS is then not expected to run HBA, whatever the button does', 'inference');
            }
        } else if (this.kafas[0xE482]) add('warn', 'KAFAS HBA enabling code not readable (' + (this.kafas[0xE482].raw || 'no answer') + ')');
        const cal = k(0xD6BC);
        if (cal) add(cal.raw === 1 ? 'ok' : 'crit', 'KAFAS camera calibration: ' + cal.text);
        const fasta = k(0xE474);
        if (fasta && typeof fasta.opTime === 'number') {
            add(fasta.opTime > 0 ? 'info' : 'warn', 'KAFAS: HBA has been active ' + fasta.opTime + ' s in total (driver-activated); button overrides counted: ' + (fasta.overrideButton || 0));
        }
        const tr = this.opTimeTrend();
        if (tr) {
            if (tr.rising) add('ok', 'HBA active-time counter ROSE (' + tr.from + ' -> ' + tr.to + ' s over ' + tr.seconds + ' s): HBA was active between the two runs', 'inference');
            else add('info', 'HBA active-time counter unchanged (' + tr.to + ' s, ' + tr.seconds + ' s apart) - not conclusive: KAFAS may store it only at the end of a drive cycle. The cluster indicator is the check', 'inference');
        }
        const why = k(0xD341);
        if (why && why.active.length) add('info', 'KAFAS holds high beam off because: ' + why.active.join(', '));
        if (why && why.failsafe) add('crit', 'KAFAS camera is in fail-safe mode');
        const rec = k(0xD3AD);
        if (rec) add('info', 'KAFAS high beam recommendation now: ' + rec.text);
        [D.BDC, D.KAFAS].forEach((a) => {
            const f = this.faults[a];
            if (!f || !f.list) return;
            f.list.filter((d) => d.relevant).forEach((d) => add('crit', (a === D.BDC ? 'BDC' : 'KAFAS') + ' fault ' + d.hex + ': ' + d.text + ' (status ' + D.hex(d.status) + ')'));
        });
        const b = this.button;
        if (b.ran) {
            if (!b.answered) add('warn', 'Button test: the BDC answered none of the button reads (' + b.dids.map((x) => D.hex(x, 4)).join('/') + ')');
            else if (b.presses) add('ok', 'Button test: the BDC saw the HBA button pressed ' + b.presses + ' time(s) - the button and its LIN link work');
            else if (b.highBeam || b.flash) add('crit', 'Button test: the BDC saw the stalk move (high beam ' + b.highBeam + ', flash ' + b.flash + ') but never the HBA button. If it was held ~1 s each time, the button (or its contact in the SZL) is faulty', 'inference');
            else add('warn', 'Button test: nothing pressed was seen. Press the HBA button and push / pull the stalk during the test');
        }
        if (this.catalog) {
            if (!this.catalog.ok) add('warn', 'SOME/IP catalog not readable: ' + this.catalog.error);
            else {
                const usable = this.catalog.hits.concat(this.catalog.users || []).filter((h) => h.kind === 'method' || h.flags.indexOf('set') >= 0);
                if (usable.length) add('ok', 'Head unit offers ' + usable.length + ' writable HBA-related interface(s): ' + usable.slice(0, 3).map((h) => h.iface + '.' + h.name).join(', ') + ' - candidate for Enable / Disable (verify first)', 'inference');
                else add('warn', 'Head unit catalog (' + this.catalog.interfaces + ' interfaces): no writable HBA setting or method (' + this.catalog.hits.length + ' read-only matches)');
            }
        }
        if (this.error) add('crit', 'Probe error: ' + this.error);
        return out;
    }

    view() {
        return { state: this.state, started: this.started, units: this.units, kafas: this.kafas, faults: this.faults,
            catalog: this.catalog, button: Object.assign({}, this.button), trend: this.opTimeTrend(), findings: this.findings(),
            stats: Object.assign({}, this.link.stats),
            link: { ready: !!this.link.ready, available: !!this.link.available, error: this.link.error || null } };
    }

    /** the full result with every raw reply, as JSON in <dataDir>/reports/ ; returns the file or null */
    save() {
        try {
            const dir = path.join(this.dataDir, 'reports');
            if (!fs.existsSync(dir)) fs.mkdirSync(dir);
            const file = path.join(dir, 'hba-' + new Date(this.now()).toISOString().replace(/[:.]/g, '-') + '.json');
            const v = this.view();
            v.trace = this.link.trace.slice();
            fs.writeFileSync(file, JSON.stringify(v, null, 1));
            this.log.info('report saved: ' + file);
            return file;
        } catch (e) {
            this.log.warn('report not saved: ' + e);
            return null;
        }
    }
}

module.exports = { Probe, UNITS };
