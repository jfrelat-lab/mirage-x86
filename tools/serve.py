#!/usr/bin/env python3
"""Static file server for MIRAGE with caching disabled (so edits show on reload).
The app is fully client-side — any static server works; this one just adds the
right MIME type for ES modules and the .bin font, and no-cache headers."""
import http.server
import socketserver
import os
import sys

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
os.chdir(ROOT)


class Handler(http.server.SimpleHTTPRequestHandler):
    extensions_map = {
        **http.server.SimpleHTTPRequestHandler.extensions_map,
        '.js': 'text/javascript',
        '.mjs': 'text/javascript',
        '.bin': 'application/octet-stream',
    }

    def end_headers(self):
        self.send_header('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0')
        super().end_headers()

    def log_message(self, *args):
        pass


def main():
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8761
    socketserver.TCPServer.allow_reuse_address = True
    with socketserver.TCPServer(('', port), Handler) as httpd:
        print('MIRAGE serving %s on http://localhost:%d (no-cache)' % (ROOT, port))
        httpd.serve_forever()


if __name__ == '__main__':
    main()
