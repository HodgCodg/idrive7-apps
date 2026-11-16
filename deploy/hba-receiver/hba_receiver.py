#!/usr/bin/env python3
"""Receives High Beam Assistant reports from the car (apps/hba_assist/uploader.js) over Tailscale.

POST /hba/upload?name=<report>.json  with the JSON body -> saved to OUT_DIR/<name> (never overwrites:
a repeat gets a numeric suffix). Only valid JSON up to MAX_BYTES is accepted. Bind to the Tailscale
address only, so it is not reachable from the LAN or the internet.
"""
import json
import os
import re
import sys
from datetime import datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

BIND = os.environ.get('HBA_BIND', '100.73.22.59')
PORT = int(os.environ.get('HBA_PORT', '8771'))
OUT_DIR = os.environ.get('HBA_OUT', os.path.expanduser('~/hba-reports'))
MAX_BYTES = 20 * 1024 * 1024


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
        name = (parse_qs(u.query).get('name') or [''])[0]
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
        self.log_message('saved %s (%d bytes)', path, len(body))
        return self._reply(200, {'ok': True, 'saved': os.path.basename(path)})

    def log_message(self, fmt, *args):
        sys.stderr.write('%s %s\n' % (self.address_string(), fmt % args))


if __name__ == '__main__':
    ThreadingHTTPServer((BIND, PORT), Handler).serve_forever()
