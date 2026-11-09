'use strict';
/**
 * High Beam Assistant - finds out on the car why BMW's high beam assistant (HBA / FLA) does not come on,
 * through the head unit's own diagnostic link, and runs BMW's own HBA demo jobs as live-diagnostic
 * experiments to see what they do to the cluster's HBA indicator.
 *
 * Checks are READ-ONLY (22 / 19 02). The only writes are the experiments' exact frames
 * (experiments.js): Setting "Experiment" ships Off (then nothing but reads is ever sent), the car must be
 * stationary in P on live data, the button is pressed twice, and every run is switched back off at its end,
 * on its 60 s timeout and at the next app start if the app stopped during one.
 *
 * Opening the app sends nothing but the switch-off of an unfinished experiment. Every run is saved with its
 * raw requests / replies in <data>/reports/.
 */
const mgu = require('./kit/mgu');
const G = require('./kit/gauges');
const { Canvas } = require('./kit/canvas');
const Car = require('./kit/car');
const { HbaLink } = require('./hba_link');
const { Probe } = require('./probe');
const { Experiments, allowed } = require('./experiments');
const UI = require('./ui');

const BUTTON_TEST_MS = 20000;

mgu.run({
    async start(ctx) {
        const { ui, log, settings } = ctx;
        const link = new HbaLink(ctx.signals, log, { allow: allowed });
        const probe = new Probe(link, { log, dataDir: ctx.dataDir });
        const car = new Car(ctx, ['speed', 'gear', 'condition']);
        // stationary in P, on live data only (the demo drive never counts)
        const interlock = () => {
            const d = car.data();
            if (d.demo) return { ok: false, why: 'no live vehicle data' };
            if (typeof d.speed !== 'number') return { ok: false, why: 'vehicle speed unknown' };
            if (d.speed > 0.5) return { ok: false, why: 'the car is moving' };
            if (d.stage !== 'P') return { ok: false, why: 'selector not in P (' + (d.stage || 'unknown') + ')' };
            return { ok: true, why: '' };
        };
        const exp = new Experiments(link, probe, { log, dataDir: ctx.dataDir, interlock });
        let page = UI.PAGES[0];
        let loop = null;

        const view = () => Object.assign(probe.view(), { exp: exp.view(), expId: settings.get('experiment'),
            blocker: exp.state === 'running' ? '' : exp.blocker(settings.get('experiment')) });
        const render = async () => {
            const cv = ctx.canvas(UI.W, UI.H) || new Canvas(UI.W, UI.H);
            UI.draw(cv, G, ctx.theme(), view(), page);
            await ui.image('MAIN_GFX', cv);
        };
        const repaint = () => (loop && loop.kick ? loop.kick() : render());
        loop = ctx.loop('MAIN', 4, render);
        const showExpButton = () => ui.visible('BTN_EXP', settings.get('experiment') !== 'off');

        ui.onClick('BTN_RUN', () => {
            if (!link.ready) { log.warn('diagnostic link not ready: ' + (link.error || 'starting')); return repaint(); }
            const p = probe.run().then(() => probe.save()).then(repaint).catch((e) => log.error('run: ' + e));
            repaint();
            return p;
        });
        ui.onClick('BTN_BUTTON', () => {
            if (!link.ready) return repaint();
            page = 'Button';
            const p = probe.buttonTest(BUTTON_TEST_MS, repaint).then(() => probe.save()).then(repaint).catch((e) => log.error('button: ' + e));
            repaint();
            return p;
        });
        ui.onClick('BTN_EXP', () => {
            const id = settings.get('experiment');
            if (id === 'off' || !link.ready) return repaint();
            page = 'Experiment';
            const p = exp.press(id).then(repaint).catch((e) => log.error('experiment: ' + e));
            repaint();
            return p;
        });
        ui.onClick('BTN_PAGE', () => { page = UI.PAGES[(UI.PAGES.indexOf(page) + 1) % UI.PAGES.length]; return render(); });
        if (ctx.onTab) ctx.onTab((i) => { if (UI.PAGES[i]) page = UI.PAGES[i]; return render(); });
        settings.onChange((key) => { if (key === 'experiment') { showExpButton(); return render(); } return null; });

        await link.init();
        log.info('hba_assist ready (diagnostic link ' + (link.ready ? 'up' : 'down: ' + link.error) + ', experiment ' + settings.get('experiment') + ')');
        showExpButton();
        // an experiment the app was stopped in the middle of is switched off first, before anything else
        if (link.ready) await exp.recover().catch((e) => log.error('recover: ' + e));
        else link.onAvailable((a) => { if (a) exp.recover().then(repaint).catch((e) => log.error('recover: ' + e)); });
        await render();
    },
});
