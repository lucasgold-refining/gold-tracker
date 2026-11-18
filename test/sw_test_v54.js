// The service worker must not store an HTTP-cached page over the fresh one.
const fs = require('fs'), path = require('path'), vm = require('vm');
const sw = fs.readFileSync(path.join(__dirname, '..', 'sw.js'), 'utf8');
let fails = 0, n = 0;
const ok = (c, m) => { n++; console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++; };

ok(/const CACHE = 'gold-tracker-v55'/.test(sw), 'cache name is v55');
const nav = sw.split("req.mode === 'navigate'")[1].split('return;')[0];
ok(/cache:\s*'reload'/.test(nav) && /req\.url/.test(nav), 'navigation fetches the URL with cache reload');
ok(!/fetch\(req\)/.test(nav), 'the navigation branch does not use the request cache mode');

const stored = {};
function fakeResponse(body, status) {
  return {
    ok: status === 200, status, type: 'basic',
    clone() { return fakeResponse(body, status); },
    text: async () => body
  };
}
const listeners = {};
const self = {
  addEventListener(type, fn) { (listeners[type] = listeners[type] || []).push(fn); },
  skipWaiting() { return Promise.resolve(); },
  clients: { claim() { return Promise.resolve(); } },
  location: { origin: 'https://gold.example' }
};
let httpBody = 'OLD v52 PAGE';
const fetch = (input, init) => {
  const reload = init && init.cache === 'reload';
  const url = typeof input === 'string' ? input : input.url;
  return Promise.resolve(fakeResponse(reload ? 'NEW v53 PAGE' : httpBody, 200));
};
const caches = {
  open: async () => ({
    put: async (key, res) => { stored[String(key)] = await res.text(); },
    addAll: async () => {},
    keys: async () => []
  }),
  keys: async () => [],
  match: async () => null,
  delete: async () => true
};
vm.runInContext(sw, vm.createContext({
  self, caches, fetch, URL, console, location: self.location,
  Promise, setTimeout, clearTimeout, Response
}), { filename: 'sw.js' });
const respond = [];
listeners.fetch.forEach(fn => fn({
  request: { method: 'GET', url: 'https://gold.example/index.html', mode: 'navigate' },
  respondWith(p) { respond.push(p); }
}));

(async () => {
  const res = await respond[0];
  ok(res && await res.text() === 'NEW v53 PAGE', 'the page shown is the reloaded copy');
  await new Promise(r => setTimeout(r, 20));
  ok(stored['./index.html'] === 'NEW v53 PAGE', 'the saved offline copy is the fresh page, not the HTTP cache (' + stored['./index.html'] + ')');
  console.log(`\nSUMMARY sw_v54 ${n - fails} passed, ${fails} failed, of ${n}`);
  process.exit(fails ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
