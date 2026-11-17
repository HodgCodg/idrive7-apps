'use strict';
/**
 * High Beam Assistant - finds out on the car why BMW's high beam assistant (HBA / FLA) does not come on,
 * through the head unit's own diagnostic link, and runs BMW's own HBA demo jobs as live-diagnostic
 * experiments to see what they do to the cluster's HBA indicator.
 *
 * Checks are READ-ONLY (22 / 19 02). The only writes are the experiments' exact frames
 * (experiments.js): Setting "Experiment" ships Off (then nothing but reads is ever sent), the car must be
 * one press starts and the next press stops (any speed, any gear), and every run is switched back off at its end
 * and at the next app start if the app stopped during one.
 *
 * Opening the app sends nothing but the switch-off of an unfinished experiment. Every run is saved with its
 * raw requests / replies in <data>/reports/ and uploaded to the owner's server over Tailscale (uploader.js).
 */
const mgu = require('./kit/mgu');
const G = require('./kit/gauges');
const { Canvas } = require('./kit/canvas');
const Car = require('./kit/car');
const { HbaLink } = require('./hba_link');
const { Probe } = require('./probe');
const { Experiments, allowed } = require('./experiments');
const UI = require('./ui');
const { Uploader } = require('./uploader');
const { Activity } = require('./activity');
const fs = require('fs');
const path = require('path');

const BUTTON_TEST_MS = 20000;

mgu.run({
    async start(ctx) {
        const { ui, settings } = ctx;
        // ---- everything the app sees and does is recorded (activity.js) and uploaded ----
        const session = new Date().toISOString().replace(/[:.]/g, '-');
        const act = new Activity({ dataDir: ctx.dataDir, session });
        const log = {};
        ['error', 'warn', 'info', 'debug'].forEach((lvl) => {
            log[lvl] = (...a) => {
                act.event('log', { level: lvl, msg: a.map((x) => (x && x.stack) ? x.stack : (typeof x === 'object' ? safeJson(x) : String(x))).join(' ') });
                return ctx.log[lvl].apply(ctx.log, a);
            };
        });
        // every raw SOME/IP signal value the app receives, on change (and at most every 250 ms per field)
        if (ctx.signals && typeof ctx.signals.watch === 'function') {
            const watch = ctx.signals.watch.bind(ctx.signals);
            ctx.signals.watch = (iface, inst, handlers, ...rest) => {
                const wrapped = {};
                Object.keys(handlers || {}).forEach((field) => {
                    const fn = handlers[field];
                    if (typeof fn !== 'function') { wrapped[field] = fn; return; }
                    let last = null, lastT = 0;
                    wrapped[field] = (v, ...more) => {
                        const j = safeJson(v), now = Date.now();
                        if (j !== last && now - lastT >= 250) { act.event('signal', { iface, inst, field, value: v }); last = j; lastT = now; }
                        return fn(v, ...more);
                    };
                });
                act.event('watch', { iface, inst, fields: Object.keys(handlers || {}) });
                return watch(iface, inst, wrapped, ...rest);
            };
        }
        process.on('uncaughtException', (e) => act.event('crash', { kind: 'uncaughtException', error: String(e && e.stack || e) }));
        process.on('unhandledRejection', (e) => act.event('crash', { kind: 'unhandledRejection', error: String(e && e.stack || e) }));
        act.event('start', { app: ctx.spec && ctx.spec.id, version: ctx.spec && ctx.spec.version, node: process.versions, pid: process.pid,
            platform: process.platform, arch: process.arch, uptime: process.uptime(), dataDir: ctx.dataDir, settings: allSettings() });

        const link = new HbaLink(ctx.signals, log, { allow: allowed });
        link.onExchange = (x) => act.event('uds', x);
        const probe = new Probe(link, { log, dataDir: ctx.dataDir });
        const car = new Car(ctx, ['speed', 'gear', 'condition']);
        // no parked-only gate since 0.6.0: the owner runs the experiments while driving (his call). The speed and
        // selector are still recorded with every run (activity log), and the other safeguards stay: double press,
        // one press starts, the next stops (no time limit), switched back at the end / next start.
        const interlock = () => ({ ok: true, why: '' });
        const exp = new Experiments(link, probe, { log, dataDir: ctx.dataDir, interlock, singlePress: true, untilStopped: true });
        // every saved report goes to the owner's server over Tailscale (queued and retried while offline)
        const uploader = new Uploader({ dataDir: ctx.dataDir, log, enabled: () => settings.get('upload') !== false, onFlush: () => act.flush('server pull'), onChange: () => { const uv = uploader.view(); const u = safeJson({ enabled: uv.enabled, reached: uv.reached, via: uv.via, error: uv.error });  /* counters alone are not news */ if (u !== lastUpload) { act.event('upload', JSON.parse(u)); lastUpload = u; } repaint(); } });
        let lastUpload = null;
        let page = UI.PAGES[0];
        let loop = null;

        const view = () => Object.assign(probe.view(), { upload: uploader.view(), exp: exp.view(), expId: settings.get('experiment'),
            blocker: exp.state === 'running' ? '' : exp.blocker(settings.get('experiment')) });
        const render = async () => {
            const cv = ctx.canvas(UI.W, UI.H) || new Canvas(UI.W, UI.H);
            UI.draw(cv, G, ctx.theme(), view(), page);
            await ui.image('MAIN_GFX', cv);
        };
        const repaint = () => (loop && loop.kick ? loop.kick() : render());
        loop = ctx.loop('MAIN', 4, render);
        const showExpButton = () => ui.visible('BTN_EXP', settings.get('experiment') !== 'off');

        const onClick = (id, fn) => ui.onClick(id, (...a) => { act.event('click', { id, page }); return fn(...a); });
        onClick('BTN_RUN', () => {
            if (!link.ready) { log.warn('diagnostic link not ready: ' + (link.error || 'starting')); return repaint(); }
            const p = probe.run().then(() => probe.save()).then(() => { uploader.kick(); }).then(repaint).catch((e) => log.error('run: ' + e));
            repaint();
            return p;
        });
        onClick('BTN_BUTTON', () => {
            if (!link.ready) return repaint();
            page = 'Button';
            const p = probe.buttonTest(BUTTON_TEST_MS, repaint).then(() => probe.save()).then(() => { uploader.kick(); }).then(repaint).catch((e) => log.error('button: ' + e));
            repaint();
            return p;
        });
        onClick('BTN_EXP', () => {
            const id = settings.get('experiment');
            if (id === 'off' || !link.ready) return repaint();
            page = 'Experiment';
            const p = exp.press(id).then(() => { uploader.kick(); }).then(repaint).catch((e) => log.error('experiment: ' + e));
            repaint();
            return p;
        });
        onClick('BTN_PAGE', () => { page = UI.PAGES[(UI.PAGES.indexOf(page) + 1) % UI.PAGES.length]; return render(); });
        if (ctx.onTab) ctx.onTab((i) => { act.event('tab', { index: i, page: UI.PAGES[i] }); if (UI.PAGES[i]) page = UI.PAGES[i]; return render(); });
        settings.onChange((key) => { act.event('setting', { key, value: settings.get(key) }); if (key === 'upload') uploader.kick(); if (key === 'experiment') { showExpButton(); return render(); } return null; });

        // Upload: everything now - a full snapshot (screen state, every exchange, settings, car, app log files),
        // the activity so far, and every report still waiting
        onClick('BTN_UPLOAD', () => {
            snapshot('upload button');
            act.flush('upload button');
            return Promise.resolve(uploader.kick()).then(repaint);
        });
        // the screen state and the car's values whenever they change (checked every 2 s)
        let lastView = null, lastCar = null;
        const watcher = setInterval(() => {
            try {
                const vv = view(); delete vv.upload; const v = safeJson(vv);   // the upload counter alone is not news
                if (v !== lastView) { act.event('view', JSON.parse(v)); lastView = v; }
                const c = safeJson(car.data());
                if (c !== lastCar) { act.event('car', JSON.parse(c)); lastCar = c; }
            } catch (e) { act.event('log', { level: 'warn', msg: 'watcher: ' + e }); }
        }, 2000);
        if (watcher.unref) watcher.unref();
        act.onFlush = () => uploader.kick();
        function snapshot(reason) {
            try {
                const dir = path.join(ctx.dataDir, 'reports');
                if (!fs.existsSync(dir)) fs.mkdirSync(dir);
                const readLog = (f) => { try { return fs.readFileSync(f, 'utf8'); } catch (e) { return null; } };
                const logFile = path.join(ctx.dataDir, ((ctx.spec && ctx.spec.id) || 'hba_assist') + '.log');
                let files = [];
                try { files = walk(ctx.dataDir); } catch (e) {}
                const snap = { type: 'snapshot', reason, session, t: new Date().toISOString(), app: ctx.spec && ctx.spec.id, version: ctx.spec && ctx.spec.version,
                    node: process.versions, uptime: process.uptime(), memory: process.memoryUsage(), settings: allSettings(), page,
                    view: view(), trace: link.trace.slice(), link: { ready: link.ready, available: link.available, error: link.error || null, stats: link.stats },
                    car: car.data(), experiment: exp.view(), upload: uploader.view(), files,
                    appLog: readLog(logFile), appLogPrevious: readLog(logFile + '.1') };
                const file = path.join(dir, 'snapshot-' + new Date().toISOString().replace(/[:.]/g, '-') + '.json');
                fs.writeFileSync(file, safeJson(snap));
                log.info('snapshot saved: ' + file);
            } catch (e) { log.warn('snapshot: ' + e); }
        }
        function walk(dir, out, depth) {
            out = out || []; depth = depth || 0;
            fs.readdirSync(dir).forEach((f) => {
                const p = path.join(dir, f), st = fs.statSync(p);
                out.push({ path: path.relative(ctx.dataDir, p), size: st.size, mtime: st.mtime.toISOString(), dir: st.isDirectory() });
                if (st.isDirectory() && depth < 3) walk(p, out, depth + 1);
            });
            return out;
        }
        function allSettings() {
            const o = {};
            ((ctx.spec && ctx.spec.settings) || []).forEach((s) => { try { o[s.key] = settings.get(s.key); } catch (e) {} });
            return o;
        }

        uploader.start();
        await link.init();
        log.info('hba_assist ready (diagnostic link ' + (link.ready ? 'up' : 'down: ' + link.error) + ', experiment ' + settings.get('experiment') + ')');
        showExpButton();
        // an experiment the app was stopped in the middle of is switched off first, before anything else
        if (link.ready) await exp.recover().catch((e) => log.error('recover: ' + e));
        else link.onAvailable((a) => { if (a) exp.recover().then(repaint).catch((e) => log.error('recover: ' + e)); });
        act.event('ready', { link: { ready: link.ready, available: link.available, error: link.error || null } });
        await render();
    },
});

function safeJson(x) {
    const seen = [];
    try {
        return JSON.stringify(x, (k, v) => {
            if (v && typeof v === 'object') { if (seen.indexOf(v) >= 0) return '[circular]'; seen.push(v); }
            if (typeof Buffer !== 'undefined' && Buffer.isBuffer(v)) return v.toString('hex');
            return v;
        });
    } catch (e) { return JSON.stringify(String(x)); }
}
