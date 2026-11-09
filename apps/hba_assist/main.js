'use strict';
/**
 * High Beam Assistant - finds out on the car why BMW's high beam assistant (HBA / FLA) does not come
 * on, and which way of switching it the car offers, through the head unit's own diagnostic link.
 *
 * READ-ONLY. Every request goes through hba_link.js, which refuses anything but 22 (read data) and
 * 19 02 (read fault memory) to the BDC, KAFAS and headlight modules. Nothing in the car is changed:
 * no writes, no routines, no sessions, no coding.
 *
 * Opening the app sends nothing; "Run checks" and "Button test" do. Each run is saved with every
 * raw request / reply in <data>/reports/hba-<time>.json, and logged to the app's log.
 *
 * There is no Enable / Disable control: BMW's descriptions of this car's units (BDC_G05, KAFAS04)
 * offer no request that switches the function the way the stalk does (see README.md). The
 * Interfaces page shows whether the head unit's own catalog has one.
 */
const mgu = require('./kit/mgu');
const G = require('./kit/gauges');
const { Canvas } = require('./kit/canvas');
const { HbaLink } = require('./hba_link');
const { Probe } = require('./probe');
const UI = require('./ui');

const BUTTON_TEST_MS = 20000;

mgu.run({
    async start(ctx) {
        const { ui, log } = ctx;
        const link = new HbaLink(ctx.signals, log);
        const probe = new Probe(link, { log, dataDir: ctx.dataDir });
        let page = UI.PAGES[0];
        let loop = null;

        const render = async () => {
            const cv = ctx.canvas(UI.W, UI.H) || new Canvas(UI.W, UI.H);
            UI.draw(cv, G, ctx.theme(), probe.view(), page);
            await ui.image('MAIN_GFX', cv);
        };
        const repaint = () => (loop && loop.kick ? loop.kick() : render());
        loop = ctx.loop('MAIN', 4, render);

        const runChecks = () => {
            if (!link.ready) { log.warn('diagnostic link not ready: ' + (link.error || 'starting')); return repaint(); }
            const p = probe.run().then(() => probe.save()).then(repaint).catch((e) => log.error('run: ' + e));
            repaint();
            return p;
        };
        const buttonTest = () => {
            if (!link.ready) return repaint();
            page = 'Button';
            const p = probe.buttonTest(BUTTON_TEST_MS, repaint).then(() => probe.save()).then(repaint).catch((e) => log.error('button: ' + e));
            repaint();
            return p;
        };

        ui.onClick('BTN_RUN', runChecks);
        ui.onClick('BTN_BUTTON', buttonTest);
        ui.onClick('BTN_PAGE', () => { page = UI.PAGES[(UI.PAGES.indexOf(page) + 1) % UI.PAGES.length]; return render(); });
        if (ctx.onTab) ctx.onTab((i) => { if (UI.PAGES[i]) page = UI.PAGES[i]; return render(); });

        await link.init();
        log.info('hba_assist ready (diagnostic link ' + (link.ready ? 'up' : 'down: ' + link.error) + ')');
        await render();
    },
});
