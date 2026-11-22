import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const script = readFileSync(new URL('../extension/content.js', import.meta.url), 'utf8');

test('page script keeps a black pointer until the matching work session ends', () => {
  let listener;
  let host = null;
  let creations = 0;
  let interval = null;
  let clock = 1000;
  const makeElement = () => ({
    attrs: {}, style: {},
    setAttribute(key, value) { this.attrs[key] = value; },
    getAttribute(key) { return this.attrs[key]; },
    attachShadow() { return { append() {} }; },
    append() {},
    remove() { if (host === this) host = null; }
  });
  const context = {
    Date: { now: () => clock },
    setInterval(fn) { interval = fn; return 1; },
    clearInterval() { interval = null; },
    crypto: { randomUUID: () => 'deadbeef-0000-0000-0000-000000000000' },
    chrome: { runtime: { id: 'pero-test', onMessage: { addListener(fn) { listener = fn; } } } },
    document: {
      querySelector(selector) { return selector === '[data-pero-work-pointer]' ? host : null; },
      createElement() { creations++; return makeElement(); },
      createElementNS: makeElement,
      documentElement: { append(el) { host = el; } }
    }
  };
  vm.runInNewContext(script, context);
  const send = (action, token) => {
    let response;
    listener({ source: 'pero-work-pointer', action, token }, { id: 'pero-test' }, result => { response = result; });
    return response;
  };
  assert.equal(send('POINTER_START', 'abc123xyz').ok, true);
  assert.equal(host?.attrs['data-pero-work-pointer'], 'abc123xyz');
  assert.match(host.style.cssText, /pointer-events:none/);
  assert.equal(creations, 2); // Host and its shadow style; SVG uses createElementNS.
  send('POINTER_START', 'abc123xyz');
  assert.equal(creations, 2); // Repeated keep-alive does not recreate or move the pointer.
  send('POINTER_STOP', 'other789');
  assert.ok(host);
  send('POINTER_STOP', 'abc123xyz');
  assert.equal(host, null);
  assert.equal(send('POINTER_START', '../bad').ok, false);
  send('POINTER_START', 'abc123xyz');
  assert.ok(host);
  clock += 6000;
  interval(); // If the panel was closed without a STOP, the stale cursor expires.
  assert.equal(host, null);
});
