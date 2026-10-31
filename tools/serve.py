#!/usr/bin/env python3
"""Static file server for MIRAGE with caching disabled (so edits show on reload).
The app is fully client-side — any static server works; this one just adds the
right MIME type for ES modules and the .bin font, no-cache headers, and the
oasis-fetch relay the pages build OASIS images through (their archives' hosts
send no CORS headers): src/oasis-hosts.js's rule, its list read from that file,
as tools/oasis.mjs serve and functions/oasis-fetch.js apply it."""
import http.server
import socketserver
import os
import re
import sys
import urllib.parse
import urllib.request

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
os.chdir(ROOT)


def oasis_hosts():
    src = open(os.path.join(ROOT, 'src', 'oasis-hosts.js'), encoding='utf-8').read()
    return re.findall(r"'([^']+)'", re.search(r'OASIS_HOSTS = \[(.*?)\];', src, re.S).group(1))


def relay_target(raw, hosts):
    """The URL to fetch for ?url=, or None: src/oasis-hosts.js's relayTarget."""
    try:
        u = urllib.parse.urlsplit(raw)
    except ValueError:
        return None
    if u.scheme not in ('http', 'https') or u.username or u.password or u.port:
        return None
    at = (u.hostname or '') + u.path
    ok = any((at.startswith(h) and '/../' not in u.path) if '/' in h else u.hostname == h for h in hosts)
    return raw if ok else None


class Handler(http.server.SimpleHTTPRequestHandler):
    extensions_map = {
        **http.server.SimpleHTTPRequestHandler.extensions_map,
        '.js': 'text/javascript',
        '.mjs': 'text/javascript',
        '.bin': 'application/octet-stream',
    }

    def do_GET(self):
        u = urllib.parse.urlsplit(self.path)
        if u.path != '/oasis-fetch':
            return super().do_GET()
        hosts = oasis_hosts()
        target = relay_target(urllib.parse.parse_qs(u.query).get('url', [''])[0], hosts)
        if not target:
            return self.send_error(403, 'oasis-fetch: not a host OASIS images use')
        try:
            with urllib.request.urlopen(target, timeout=60) as r:
                if not relay_target(r.geturl(), hosts):
                    return self.send_error(502, 'oasis-fetch: redirected off the hosts')
                body = r.read()
        except Exception as e:
            return self.send_error(502, 'oasis-fetch: %s' % e)
        self.send_response(200)
        self.send_header('Content-Type', 'application/octet-stream')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def end_headers(self):
        self.send_header('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0')
        super().end_headers()

    def log_message(self, *args):
        pass


def main():
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8761
    socketserver.TCPServer.allow_reuse_address = True
    with socketserver.ThreadingTCPServer(('', port), Handler) as httpd:
        print('MIRAGE serving %s on http://localhost:%d (no-cache)' % (ROOT, port))
        httpd.serve_forever()


if __name__ == '__main__':
    main()
