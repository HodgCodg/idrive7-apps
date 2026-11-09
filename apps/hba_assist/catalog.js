'use strict';
/**
 * catalog.js - look through the head unit's own SOME/IP interface database for anything about the
 * high beam assistant. READ-ONLY: it opens one file and never talks to an interface.
 *
 * MainApp installs an app only when every interface its manifest names is in this database
 * (iDrive 7: /etc/oap/someip/someip-interfaces.json), so an interface found here is one an app can
 * really use. An HMI-level setting with a setter or method (an iDrive "High-beam Assistant" switch)
 * would go through BMW's own logic exactly like the stalk does - the only clean way to switch the
 * function from the head unit. Whether one exists on this firmware is what this scan answers.
 *
 *   scan(text) -> { interfaces: n, hits: [{ iface, kind, name, flags, path }] }
 *   kind: 'interface' | 'field' | 'method' | 'event' | 'type' | 'member' | 'enum'
 *   flags (fields): 'get' / 'set' / 'notify' as the database lists them
 */
const fs = require('fs');

const FILE = '/etc/oap/someip/someip-interfaces.json';
// English and German names BMW uses for it: long ones anywhere in a name, the short ones
// (FLA = Fernlichtassistent, HBA / HMA = high beam assist, GFHB / BFFL = glare-free high beam) only as a
// whole word of a camelCase / snake_case / dotted name ('requestFLA', 'HBA_ON'; not 'inflation', 'flash')
const LONG = /high.?beam|fernlicht|blendfrei|glare.?free|anti.?dazzle|main.?beam/i;
const SHORT = ['fla', 'hba', 'hma', 'gfhb', 'bffl'];
function words(name) {
    return String(name).replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
        .split(/[^A-Za-z0-9]+/).map((w) => w.toLowerCase());
}
const PATTERN = { test: (name) => LONG.test(name) || words(name).some((w) => SHORT.indexOf(w) >= 0) };
const CONTEXT = /exteriorlight|aussenlicht|lightsetting|lichteinstellung|lightfunction|lichtfunktion|lighting/i;

function flagsOf(f) {
    const out = [];
    if (f && f.getter && f.getter.id) out.push('get');      // a getter with id 0 is no getter (check_signals.py)
    if (f && f.setter) out.push('set');
    if (f && f.notifier) out.push('notify');
    return out;
}

/** every match in the database text (a JSON document); throws when it isn't JSON */
function scan(text, opts) {
    const db = JSON.parse(text);
    const ifaces = (db && db.interfaces) || {};
    const types = (db && db.datatypes) || {};
    const hits = [], context = [];
    const re = (opts && opts.pattern) || PATTERN;
    const add = (h) => { if (hits.length < 400) hits.push(h); };
    Object.keys(ifaces).forEach((id) => {
        const i = ifaces[id] || {};
        if (re.test(id)) add({ iface: id, kind: 'interface', name: id, flags: [] });
        else if (CONTEXT.test(id)) context.push(id);
        Object.keys(i.fields || {}).forEach((n) => { if (re.test(n)) add({ iface: id, kind: 'field', name: n, flags: flagsOf(i.fields[n]), type: i.fields[n] && i.fields[n].dataRef }); });
        Object.keys(i.methods || {}).forEach((n) => { if (re.test(n)) add({ iface: id, kind: 'method', name: n, flags: [] }); });
        Object.keys(i.events || i.broadcasts || {}).forEach((n) => { if (re.test(n)) add({ iface: id, kind: 'event', name: n, flags: [] }); });
    });
    // data types: a struct member or an enum item can carry it inside a generic "light settings" field
    Object.keys(types).forEach((ref) => {
        const d = types[ref] || {};
        if (re.test(ref)) add({ iface: '', kind: 'type', name: ref, flags: [] });
        (d.members || []).forEach((m) => { if (m && re.test(m.name || '')) add({ iface: '', kind: 'member', name: ref + '.' + m.name, flags: [] }); });
        Object.keys(d.items || {}).forEach((k) => { if (re.test(k)) add({ iface: '', kind: 'enum', name: ref + '.' + k, flags: [] }); });
    });
    // which interfaces use a matching type (so a member / enum hit points at an interface)
    const typeHits = hits.filter((h) => !h.iface).map((h) => h.name.split('.')[0]);
    const users = [];
    if (typeHits.length) {
        Object.keys(ifaces).forEach((id) => {
            const f = ifaces[id].fields || {};
            Object.keys(f).forEach((n) => {
                if (typeHits.indexOf(f[n] && f[n].dataRef) >= 0) users.push({ iface: id, kind: 'field', name: n, flags: flagsOf(f[n]), type: f[n].dataRef });
            });
        });
    }
    return { interfaces: Object.keys(ifaces).length, hits, users, context: context.slice(0, 40) };
}

/** scan the unit's file: { ok, file, ...scan } or { ok: false, file, error } */
function scanFile(file) {
    const f = file || FILE;
    try {
        return Object.assign({ ok: true, file: f }, scan(fs.readFileSync(f, 'utf8')));
    } catch (e) {
        return { ok: false, file: f, error: String(e && e.message || e), hits: [], users: [], context: [] };
    }
}

module.exports = { scan, scanFile, FILE, PATTERN };
