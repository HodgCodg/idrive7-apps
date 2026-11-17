#!/usr/bin/env python3
"""Receives High Beam Assistant reports from the car (apps/hba_assist/uploader.js) over Tailscale.

POST /hba/upload?name=<report>.json  with the JSON body -> saved to OUT_DIR/<name> (never overwrites:
a repeat gets a numeric suffix). Only valid JSON up to MAX_BYTES is accepted. Bind to the Tailscale
address only, so it is not reachable from the LAN or the internet.

PULL: the car's Tailscale runs in userspace mode, so the app can't connect OUT (ENETUNREACH), but
connections IN reach 127.0.0.1 on the head unit. Every PULL_S this pulls from the app's endpoint at
HBA_CAR (default the tailnet node "mgu", 100.70.87.25:8772): /hba/flush, /hba/list, /hba/file, /hba/ack.
A car that is off or asleep just fails quietly until it is back.
"""
import json
import os
import re
import sys
import threading
import time
import urllib.request
from datetime import datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

BIND = os.environ.get('HBA_BIND', '100.73.22.59')
PORT = int(os.environ.get('HBA_PORT', '8771'))
OUT_DIR = os.environ.get('HBA_OUT', os.path.expanduser('~/hba-reports'))
MAX_BYTES = 20 * 1024 * 1024
CAR = os.environ.get('HBA_CAR', 'http://100.70.87.25:8772')
PULL_S = int(os.environ.get('HBA_PULL_S', '20'))


def save(name, body):
    """validated JSON -> OUT_DIR/<name>, never overwriting; returns the path"""
    json.loads(body)
    name = re.sub(r'[^A-Za-z0-9._-]', '_', os.path.basename(name))[:120]
    if not name.endswith('.json'):
        name = 'report-' + datetime.now().strftime('%Y%m%d-%H%M%S') + '.json'
    os.makedirs(OUT_DIR, exist_ok=True)
    path, stem, n = os.path.join(OUT_DIR, name), name[:-5], 1
    while os.path.exists(path):
        path = os.path.join(OUT_DIR, '%s.%d.json' % (stem, n))
        n += 1
    tmp = path + '.part'
    with open(tmp, 'wb') as f:
        f.write(body)
    os.rename(tmp, path)
    return path


class Handler(BaseHTTPRequestHandler):
    def _reply(self, code, msg):
        body = (json.dumps(msg) + '\n').encode()
        self.send_response(code)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if urlparse(self.path).path == '/hba/health':
            return self._reply(200, {'ok': True})
        return self._reply(404, {'error': 'not found'})

    def do_POST(self):
        u = urlparse(self.path)
        if u.path != '/hba/upload':
            return self._reply(404, {'error': 'not found'})
        length = int(self.headers.get('Content-Length') or 0)
        if length <= 0 or length > MAX_BYTES:
            return self._reply(413, {'error': 'size'})
        body = self.rfile.read(length)
        try:
            json.loads(body)
        except ValueError:
            return self._reply(400, {'error': 'not json'})
        path = save((parse_qs(u.query).get('name') or [''])[0], body)
        self.log_message('saved %s (%d bytes)', path, len(body))
        return self._reply(200, {'ok': True, 'saved': os.path.basename(path)})

    def log_message(self, fmt, *args):
        sys.stderr.write('%s %s\n' % (self.address_string(), fmt % args))


def pull_once():
    from urllib.parse import quote
    get = lambda p, method='GET': urllib.request.urlopen(urllib.request.Request(CAR + p, method=method, data=b'' if method == 'POST' else None), timeout=30).read()
    get('/hba/flush')
    got = 0
    cat = os.path.join(OUT_DIR, 'catalog.json')
    if not os.path.exists(cat):  # the head unit's SOME/IP catalog, once (app 0.9.3+ serves it; older apps 404)
        try:
            body = get('/hba/catalog')
            json.loads(body)
            with open(cat + '.part', 'wb') as f:
                f.write(body)
            os.rename(cat + '.part', cat)
            sys.stderr.write('pulled %s (%d bytes)\n' % (cat, len(body)))
        except Exception as e:
            pass
    for item in json.loads(get('/hba/list')):
        name = item['name']
        body = get('/hba/file?name=' + quote(name))
        if not body:
            continue
        try:
            path = save(name, body)
        except ValueError:  # cut short on the car (head unit shut down mid-write): keep the bytes, don't block the queue
            os.makedirs(OUT_DIR, exist_ok=True)
            path = os.path.join(OUT_DIR, re.sub(r'[^A-Za-z0-9._-]', '_', os.path.basename(name)) + '.damaged')
            with open(path, 'wb') as f:
                f.write(body)
        get('/hba/ack?name=' + quote(name), 'POST')
        sys.stderr.write('pulled %s (%d bytes)\n' % (path, len(body)))
        got += 1
    return got


def puller():
    state = None
    while True:
        try:
            pull_once()
            now = 'ok'
        except Exception as e:  # car off / asleep / app not open: quiet until it changes
            now = 'unreachable (%s)' % (getattr(e, 'reason', None) or e)
        if now != state:
            sys.stderr.write('car %s: %s\n' % (CAR, now))
            state = now
        time.sleep(PULL_S)


if __name__ == '__main__':
    if CAR and CAR != 'off':
        threading.Thread(target=puller, daemon=True).start()
    ThreadingHTTPServer((BIND, PORT), Handler).serve_forever()
