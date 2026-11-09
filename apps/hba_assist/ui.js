'use strict';
/**
 * ui.js - the High Beam Assistant app's pages, drawn from probe.view(). No state of its own.
 */
const D = require('./hba_dids');

const W = 1600, H = 520;
const PAGES = ['Findings', 'KAFAS', 'Button', 'Interfaces'];
const LEVEL = { ok: 'accent', info: 'text', warn: 'warn', crit: 'crit' };

/** text cut into lines that fit w at size */
function wrap(cv, s, w, size) {
    const words = String(s).split(' '), lines = [];
    let line = '';
    words.forEach((word) => {
        const next = line ? line + ' ' + word : word;
        if (line && cv.textWidth(next, size, { font: 'label' }) > w) { lines.push(line); line = word; } else line = next;
    });
    if (line) lines.push(line);
    return lines;
}

/** lines of [text, colour] from y down, until bottom; returns the y after the last */
function lines(cv, t, x, y, w, items, size, bottom) {
    const lh = Math.round(size * 1.3);
    for (const it of items) {
        for (const l of wrap(cv, it[0], w, size)) {
            if (y + lh > bottom) { cv.text('...', x, y + lh * 0.75, size, t.dim, { font: 'label' }); return y + lh; }
            cv.text(l, x, y + lh * 0.75, size, t[it[1]] || it[1] || t.text, { font: 'label' });
            y += lh;
        }
        y += 4;
    }
    return y;
}

function status(v) {
    if (!v.link.ready) return 'Diagnostic link (InternalTasu) not available' + (v.link.error ? ': ' + v.link.error : ' yet') + ' - nothing can be read';
    if (v.state === 'running') return 'Reading the car...';
    if (v.state === 'button') return 'Button test running: press the HBA button on the stalk now';
    if (!v.started) return 'Press "Run checks" (car parked, ignition on, nothing is changed in the car)';
    return 'Checked ' + v.started.replace('T', ' ').slice(0, 19) + ' UTC  ·  ' + v.stats.replies + ' replies, ' + v.stats.missed + ' unanswered, ' + v.stats.refused + ' refused';
}

function findings(cv, G, t, v) {
    const p = G.panel(cv, t, 20, G.TOP + 8, W - 40, G.BOTTOM - G.TOP - 16, 'What the car says');
    const items = v.findings.length ? v.findings.map((f) => [(f.basis === 'inference' ? '(inferred) ' : '') + f.text, LEVEL[f.level]]) : [['No results yet.', 'dim']];
    lines(cv, t, p.x + 20, p.y + 52, p.w - 40, [[status(v), 'dim']].concat(items), 22, p.y + p.h - 8);
}

function kafas(cv, G, t, v) {
    const p = G.panel(cv, t, 20, G.TOP + 8, W - 40, G.BOTTOM - G.TOP - 16, 'KAFAS (0x5D) high beam assistant data');
    const rows = D.KAFAS_ORDER.map((did) => {
        const k = v.kafas[did];
        let val = '';
        if (!k) val = '-';
        else if (!k.answered) val = 'no answer';
        else if (!k.value) val = 'refused / unexpected: ' + k.raw;
        else if (did === 0xD341) val = k.value.active.length ? k.value.active.join(', ') : 'nothing holds it off';
        else if (did === 0xE474) val = 'active ' + k.value.opTime + ' s · button ' + (k.value.overrideButton || 0) + ' · stalk ' + (k.value.overrideStalk || 0) + ' · flash ' + (k.value.overrideFlash || 0);
        else val = k.value.text + (k.value.progress !== undefined ? ' (' + k.value.progress + ' %)' : '');
        return [D.hex(did, 4), k ? k.name : '', { text: val, color: k && k.answered && k.value ? 'text' : 'dim' }];
    });
    G.table(cv, t, p.x + 20, p.y + 62, p.w - 40, [{ label: 'DID', w: 100 }, { label: 'SGBD name', w: 420 }, { label: 'value', w: p.w - 560 }], rows, { size: 22, rowH: 42 });
    if (v.trend) cv.text('Active-time counter ' + v.trend.from + ' -> ' + v.trend.to + ' s over ' + v.trend.seconds + ' s', p.x + 20, p.y + p.h - 18, 20, v.trend.rising ? t.accent : t.dim, { font: 'label' });
}

function button(cv, G, t, v) {
    const b = v.button;
    const p = G.panel(cv, t, 20, G.TOP + 8, W - 40, G.BOTTOM - G.TOP - 16, 'Stalk button, as the BDC (0x40) reads it');
    const now = b.fla === 1 ? 'PRESSED' : b.fla === 0 ? 'released' : '-';
    cv.text(now, p.x + 40, p.y + 140, 72, b.fla === 1 ? t.accent : t.dim, { font: 'bold' });
    const items = [
        [v.state === 'button' ? 'Test running: press the HBA button several times, then push the stalk forward and pull it once.' : 'Press "Button test" (20 s). Then press the HBA button a few times, push the stalk forward and pull it once.', v.state === 'button' ? 'accent' : 'dim'],
        ['HBA button presses seen: ' + b.presses + '   ·   high beam pushes: ' + b.highBeam + '   ·   flash pulls: ' + b.flash, 'text'],
        ['Read from ' + (b.dids.length ? b.dids.map((d) => D.hex(d, 4)).join(' / ') : '-') + ': ' + b.answered + ' of ' + b.samples + ' reads answered', 'dim'],
    ];
    lines(cv, t, p.x + 520, p.y + 60, p.w - 560, items, 24, p.y + p.h - 8);
}

function interfaces(cv, G, t, v) {
    const p = G.panel(cv, t, 20, G.TOP + 8, W - 40, G.BOTTOM - G.TOP - 16, 'Head unit SOME/IP catalog: high beam related');
    const c = v.catalog;
    let items;
    if (!c) items = [['Not scanned yet.', 'dim']];
    else if (!c.ok) items = [['Could not read ' + c.file + ': ' + c.error, 'warn']];
    else {
        const all = c.hits.concat(c.users || []);
        items = [[c.interfaces + ' interfaces in ' + c.file + ', ' + all.length + ' match(es)', 'dim']].concat(all.slice(0, 30).map((h) =>
            [h.kind + '  ' + (h.iface ? h.iface + '  ' : '') + h.name + (h.flags.length ? '  [' + h.flags.join(', ') + ']' : ''), h.kind === 'method' || h.flags.indexOf('set') >= 0 ? 'accent' : 'text']));
        if (!all.length && c.context.length) items.push(['Light-related interfaces (no high beam match): ' + c.context.join(', '), 'dim']);
    }
    lines(cv, t, p.x + 20, p.y + 52, p.w - 40, items, 20, p.y + p.h - 8);
}

function draw(cv, G, t, v, page) {
    cv.clear(t.bg);
    G.frame(cv, t, PAGES, PAGES.indexOf(page), [v.state === 'running' && { text: 'READING' }, v.state === 'button' && { text: 'BUTTON TEST' }]);
    if (page === 'KAFAS') kafas(cv, G, t, v);
    else if (page === 'Button') button(cv, G, t, v);
    else if (page === 'Interfaces') interfaces(cv, G, t, v);
    else findings(cv, G, t, v);
}

module.exports = { draw, PAGES, W, H, wrap };
