'use strict';
/**
 * ckm.js - E6: the high beam assistant switched the way the iDrive menu does it, not through diagnostics.
 *
 * The head unit's SOME/IP catalog (iDrive 7) has Vehicle2.configLM2 (setter id 91) of type
 * VehicleTypes.ConfigLMExt2Wrapper: the personal light settings (CKM) the head unit sends to the BDC. Two
 * of its members are the high beam assistant:
 *   setupLampMainBeamAssistantCKM   LampMainBeamAssistantCKM          1 NICHT_AKTIV, 2 AKTIV, 3 SIGNAL_UNGUELTIG
 *   configLampHighBeamAssistCKM     ConfigurationLightHighBeamAssistCkm 1 DEFAULT_ON, 2 DEFAULT_OFF,
 *                                                                      3 DEAKTIVIERT, 7 SIGNAL_UNBEFUELLT
 * Every other member is sent as its "invalid / not filled" value (the catalog's defaultValue), which the
 * receiver ignores, so only the high beam assistant changes. Vehicle2.statusConfigLM2 (getter + notifier)
 * reports what the BDC has, read before and after.
 *
 * One press: AKTIV + DEFAULT_ON. Next press: back to what statusConfigLM2 said before (else NICHT_AKTIV +
 * DEFAULT_OFF). After each write the BDC's own HBA state (D57E, via probe.observe) is sampled.
 */
const IFACE = 'de.bmw.infotainment.vehicle.Vehicle2';

const LEAVE = { setupLampCorneringLightCKM: 3, setupLampWelcomeLightCKM: 3, setupLampTouristSolutionCKM: 3,
    setupLampAdaptiveHeadLampsCKM: 7, setupLampOVTCKM: 3, setupLampLightcarpetCKM: 3 };
const LEAVE_NAMES = { setupLampCorneringLightCKM: 'SIGNAL_UNGUELTIG', setupLampWelcomeLightCKM: 'SIGNAL_UNGUELTIG',
    setupLampTouristSolutionCKM: 'SIGNAL_UNGUELTIG', setupLampAdaptiveHeadLampsCKM: 'SIGNAL_UNGUELTIG',
    setupLampOVTCKM: 'SIGNAL_UNGUELTIG', setupLampLightcarpetCKM: 'SIGNAL_UNGUELTIG' };
const SETUP = { 1: 'NICHT_AKTIV', 2: 'AKTIV', 3: 'SIGNAL_UNGUELTIG' };
const CONFIG = { 1: 'FERNLICHTASSISTENT_DEFAULT_ON', 2: 'FERNLICHTASSISTENT_DEFAULT_OFF', 3: 'FERNLICHTASSISTENT_DEAKTIVIERT', 7: 'SIGNAL_UNBEFUELLT' };
const num = (v, table) => {
    if (typeof v === 'number') return v;
    const k = Object.keys(table).filter((n) => table[n] === v)[0];
    return k ? Number(k) : null;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class Ckm {
    constructor(signals, probe, log) {
        this.signals = signals;
        this.probe = probe;
        this.log = log;
        this.sub = null;
        this.status = null;       // the last statusConfigLM2
        this.before = null;       // statusConfigLM2 before our first write
        this.state = 'idle';      // idle | on | busy
        this.events = [];
        this.samples = [];
        this.verdict = null;
    }

    event(level, text) {
        this.events.push({ t: Date.now(), level, text });
        if (this.events.length > 60) this.events.shift();
        this.log[level === 'crit' ? 'warn' : 'info']('E6: ' + text);
    }

    async init() {
        try {
            this.sub = await this.signals.watch(IFACE, '1', { statusConfigLM2: (v) => {
                const was = JSON.stringify(this.status);
                this.status = v;
                if (JSON.stringify(v) !== was) this.log.info('E6: statusConfigLM2 = ' + JSON.stringify(v));
            } }, this.log);
        } catch (e) { this.event('crit', 'Vehicle2 not available: ' + e); }
    }

    hba() {
        const s = this.status || {};
        return { setup: num(s.statusLampMainBeamAssistantCKM, SETUP), config: num(s.statusLampHighBeamAssistCKM, CONFIG) };
    }

    async write(setup, config) {
        const p = this.sub && this.sub.proxy;
        if (!p) return 'Vehicle2 not ready';
        const byNumber = Object.assign({}, LEAVE, { setupLampMainBeamAssistantCKM: setup, configLampHighBeamAssistCKM: config });
        const byName = Object.assign({}, LEAVE_NAMES, { setupLampMainBeamAssistantCKM: SETUP[setup], configLampHighBeamAssistCKM: CONFIG[config] });
        let last = '';
        for (const v of [byName, byNumber]) {
            try {
                this.log.info('E6: write configLM2 = ' + JSON.stringify(v));
                await this.signals.set(p, 'configLM2', v, 5000);
                return '';
            } catch (e) { last = String(e && e.message || e); this.log.warn('E6: write ' + JSON.stringify(v) + ': ' + last); }
        }
        return last || 'refused';
    }

    async refresh() {
        const p = this.sub && this.sub.proxy;
        if (p && p.getValue) { try { this.status = await p.getValue('statusConfigLM2', 3000); } catch (e) { /* notifier keeps it */ } }
    }

    async observe(phase) {
        await this.refresh();
        const o = Object.assign({ phase, ckm: this.hba(), raw: this.status }, await this.probe.observe().catch(() => ({})));
        this.samples.push(o);
        if (this.samples.length > 200) this.samples.splice(1, 1);
        return o;
    }

    /** one press: on (AKTIV + DEFAULT_ON); the next: back to how it was */
    async press() {
        if (this.state === 'busy') return;
        const turnOn = this.state !== 'on';
        this.state = 'busy';
        try {
            const b = await this.observe('before');
            if (turnOn && !this.before) this.before = b.ckm;
            let setup = 2, config = 1, what = 'HBA AKTIV + DEFAULT_ON';
            if (!turnOn) {
                const was = this.before || {};
                setup = was.setup === 1 || was.setup === 2 ? was.setup : 1;
                config = was.config === 1 || was.config === 2 || was.config === 3 ? was.config : 2;
                what = 'back to ' + SETUP[setup] + ' + ' + CONFIG[config];
            }
            this.event('info', 'head unit setting before: ' + JSON.stringify(b.ckm) + '; BDC HBA ' + (b.bdc ? b.bdc.hbaState : '?'));
            const err = await this.write(setup, config);
            if (err) { this.event('crit', 'write refused: ' + err); this.state = turnOn ? 'idle' : 'on'; return; }
            this.event('ok', 'sent: ' + what);
            let seen = null;
            for (let i = 0; i < 8; i++) {
                await sleep(1500);
                const o = await this.observe('after');
                if (o.bdc && b.bdc && o.bdc.hbaState !== b.bdc.hbaState) { seen = o; break; }
            }
            const o = seen || this.samples[this.samples.length - 1];
            const text = 'head unit setting now ' + JSON.stringify(o.ckm) + '; BDC HBA function ' + (b.bdc ? b.bdc.hbaState : '?') + ' -> ' +
                (o.bdc ? o.bdc.hbaState : '?') + ', glare-free ' + (o.bdc ? o.bdc.gfhbaState : '?') + '; cluster HBA lamp ' + (o.lamps ? o.lamps.hba : '?');
            this.verdict = { level: seen ? 'ok' : 'warn', text: (seen ? 'BDC HBA CHANGED: ' : 'no change in the BDC: ') + text };
            this.event(this.verdict.level, this.verdict.text);
            this.state = turnOn ? 'on' : 'idle';
        } catch (e) {
            this.event('crit', 'error: ' + (e && e.message || e));
            this.state = turnOn ? 'idle' : 'on';
        }
    }

    view() {
        return { state: this.state === 'on' ? 'running' : this.state, current: { id: 'ckm' }, events: this.events.slice(-14),
            samples: this.samples.slice(-1)[0] || null, verdict: this.verdict, armed: false, endsAt: 0, extended: false, ckm: this.hba() };
    }
}

module.exports = { Ckm, IFACE };
