'use strict';
// The favicon regressed silently: no file existed, no link declared one, and
// every probe returned 46 KB of SPA HTML with a 200. Browsers cache that as
// "no icon" for weeks. So the property to pin is not "the file exists" — it is
// that every path a browser tries actually receives an image.

const test = require('node:test');
const assert = require('node:assert/strict');
const { app, db } = require('../server');

let server, base;
test.before(async () => { server = app.listen(0, '127.0.0.1'); await new Promise(r => server.once('listening', r)); base = `http://127.0.0.1:${server.address().port}`; });
test.after(async () => { await new Promise(r => server.close(r)); db.close(); });

test('every path a browser tries for a favicon gets an image, not the SPA', async () => {
  for (const path of ['/favicon.svg', '/favicon.ico']) {
    const response = await fetch(base + path);
    assert.equal(response.status, 200, `${path} must not 404`);
    const type = response.headers.get('content-type') || '';
    assert.match(type, /^image\//, `${path} must return an image, got ${type}`);
    // If the response is text/html it will be the SPA fallback — the exact bug
    // that shipped last time. Length alone is enough to distinguish: the SPA
    // page is ~46 KB, the icon is < 2 KB.
    const body = await response.arrayBuffer();
    assert.ok(body.byteLength > 0 && body.byteLength < 4096,
      `${path} is ${body.byteLength} bytes; a favicon should be under a few KB`);
  }
});

test('the HTML tells the browser where to look, at a busted-cache URL', () => {
  // Two independent properties. Without the link tag the browser only tries
  // /favicon.ico. Without the version query, a browser that already cached the
  // stale HTML response never re-fetches.
  const fs = require('node:fs');
  const path = require('node:path');
  for (const file of ['index.html', 'public/index.html']) {
    const html = fs.readFileSync(path.join(__dirname, '..', '..', file), 'utf8');
    assert.match(html, /<link rel="icon"[^>]*href="\/favicon\.svg\?v=\d+"[^>]*type="image\/svg\+xml"/,
      `${file} must declare the SVG icon with a version query`);
  }
});
