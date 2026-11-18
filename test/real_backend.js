// The real Code.gs + Api.gs (vm, mock spreadsheet) behind an HTTP server, so the browser app talks to the actual script.
const http = require('http'), fs = require('fs'), path = require('path'), vm = require('vm');
const { build } = require('./mock');
const SHEET = path.join(__dirname, '..', 'sheet');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.png': 'image/png' };
function makeBackend(apiPath, opt) {
  opt = opt || {};
  const env = build(); const ctx = vm.createContext(Object.assign({ console }, env.g));
  vm.runInContext(fs.readFileSync(path.join(SHEET, 'Code.gs'), 'utf8'), ctx, { filename: 'Code.gs' });
  const load = p => vm.runInContext(fs.readFileSync(p, 'utf8'), ctx, { filename: 'Api.gs' });
  load(apiPath || path.join(SHEET, 'Api.gs'));
  ctx.setupGoldApi(); const token = env.scriptProps.GOLD_API_TOKEN;
  if (!opt.keepArchive) env.sheets.Archive.d.splice(1);
  ctx.setupBatchNumbers_();
  const raw = text => JSON.parse(ctx.doPost({ postData: { contents: text }, parameter: {} }).text);
  const post = o => raw(JSON.stringify(Object.assign({ token }, o)));
  let k = 0;
  const add = o => { const r = post(Object.assign({ action: 'addPurchase', rid: 'seed-' + (++k), lite: true, date: '2026-11-17', at: '2026-11-17T10:00:00+08:00', weightBhy: 2, purity: 0.9, cost: 7000 }, o)); if (!r.ok) throw new Error(r.error); return r; };
  return { env, ctx, token, raw, post, add, swapApi: p => load(p) };
}
function serve(root, be) {
  const log = [];
  const s = http.createServer((req, res) => {
    if (req.url.startsWith('/mock-api')) {
      let buf = ''; req.on('data', c => buf += c);
      req.on('end', () => {
        let body = {}; try { body = JSON.parse(buf || '{}'); } catch (e) {}
        log.push({ action: body.action, rid: body.rid, body });
        if (be.offline) { res.writeHead(503); res.end('{}'); return; }
        let out; try { out = be.cur.raw(buf); } catch (e) { out = { ok: false, error: String(e && e.message || e) }; }
        log[log.length - 1].out = out;
        res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(out));
      });
      return;
    }
    let pth = decodeURIComponent((req.url || '/').split('?')[0]); if (pth === '/') pth = '/index.html';
    const fp = path.join(root, pth);
    if (!fp.startsWith(root) || !fs.existsSync(fp) || fs.statSync(fp).isDirectory()) { res.writeHead(404); res.end('x'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(fp)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    fs.createReadStream(fp).pipe(res);
  });
  return new Promise(r => s.listen(0, '127.0.0.1', () => r({ server: s, port: s.address().port, log })));
}
module.exports = { makeBackend, serve };
