// test/circle-key-check.test.js — ops/circle-key-check.js (R8, 13 Oct 2026): the by-hand check of a Circle API key.
//
// Offline. A stub standing in for Circle's Facilitator Service runs in this process, the tool runs as a child process against it.
// What is pinned: three probes, all must pass for ACCEPTED (status alone is not enough); the key's bearer goes out on every probe and
// the key never comes back in the output; --stdin takes the key from a pipe or from a hidden terminal prompt (a real pty here) and
// uses it instead of the env's; nothing is ever written.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const { generatePrivateKey } = require('viem/accounts');

const ROOT = path.join(__dirname, '..');
const TOOL = path.join(ROOT, 'ops', 'circle-key-check.js');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'af-ckc-'));
const keyFile = path.join(tmp, 'arc-payto.key');
fs.writeFileSync(keyFile, generatePrivateKey());

const SECRET = 'zz-fixture-one-aaaaaaaaaaaaaaaa:zz-fixture-two-bbbbbbbbbbbbbbbb';   // the part after the label: must never be printed (not hex on purpose: a 32-hex:32-hex pair is the shape of a real Circle key and secret scanners flag it)
const KEY = `TEST_API_KEY:${SECRET}`;
const ENV_SECRET = 'zz-envfix-one-cccccccccccccccc:zz-envfix-two-dddddddddddddddd';
const ENV_KEY = `TEST_API_KEY:${ENV_SECRET}`;

/** A stub Circle: handler(method, path) -> [status, body]. calls[] records what arrived. */
async function stub(handler) {
  const calls = [];
  const srv = http.createServer((req, res) => {
    let b = ''; req.on('data', (d) => { b += d; });
    req.on('end', () => {
      const p = req.url.replace(/^\/v1\/facilitator\/x402/, '');
      calls.push({ method: req.method, path: p, auth: req.headers.authorization || null, body: b });
      const [code, obj] = handler(req.method, p);
      res.writeHead(code, { 'content-type': 'application/json' });
      res.end(JSON.stringify(obj));
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  return { calls, url: `http://127.0.0.1:${srv.address().port}/v1/facilitator/x402`, close: () => new Promise((r) => srv.close(r)) };
}
const accepting = (method, p) => (method === 'GET' ? [404, { code: 404, message: 'payment not found' }] : [400, { code: 400, message: 'invalid request body' }]);
const refusing = (code, message = 'forbidden') => () => [code, { code, message }];

function run(args, { env = {}, input = null } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [TOOL, ...args], { cwd: ROOT, env: { PATH: process.env.PATH, ARC_PAYTO_KEY: keyFile, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '', err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('close', (code) => resolve({ code, out, err }));
    child.stdin.end(input == null ? '' : input);
  });
}
const noLeak = (r, secret = SECRET) => { assert.ok(!r.out.includes(secret), 'the key is in stdout'); assert.ok(!r.err.includes(secret), 'the key is in stderr'); };

test('env key, all three probes accepted: ACCEPTED, exit 0, the bearer on every probe, the key never printed', async () => {
  const s = await stub(accepting);
  try {
    const r = await run([], { env: { CIRCLE_FACILITATOR_URL: s.url, CIRCLE_API_KEY: KEY } });
    assert.equal(r.code, 0, r.out + r.err);
    assert.match(r.out, /ACCEPTED/);
    assert.match(r.out, /key source env \| key type TEST_API_KEY/);
    assert.match(r.out, /status 404 \| verify 400 \| settle 400/);
    noLeak(r);
    assert.deepEqual(s.calls.map((c) => `${c.method} ${c.path.replace(/[0-9a-f-]{36}/, '<uuid>')}`), ['GET /status/<uuid>', 'POST /verify', 'POST /settle']);
    for (const c of s.calls) assert.equal(c.auth, `Bearer ${KEY}`);
    assert.equal(s.calls[1].body, '{}');
    assert.equal(s.calls[2].body, '{}');
  } finally { await s.close(); }
});

test('status accepted but settle refused is NOT accepted: the key must pass all three', async () => {
  const s = await stub((m, p) => (p === '/settle' ? [403, { code: 403, message: 'forbidden' }] : accepting(m, p)));
  try {
    const r = await run([], { env: { CIRCLE_FACILITATOR_URL: s.url, CIRCLE_API_KEY: KEY } });
    assert.equal(r.code, 1);
    assert.match(r.out, /status 404 \| verify 400 \| settle 403 -> FORBIDDEN/);
    assert.ok(!/ACCEPTED/.test(r.out));
  } finally { await s.close(); }
});

test('403 on all three is FORBIDDEN and 401 is REJECTED, with Circle\'s own words and no key', async () => {
  for (const [code, word] of [[403, 'FORBIDDEN'], [401, 'REJECTED']]) {
    const s = await stub(refusing(code, code === 403 ? 'forbidden' : 'invalid credentials'));
    try {
      const r = await run([], { env: { CIRCLE_FACILITATOR_URL: s.url, CIRCLE_API_KEY: 'LIVE_API_KEY:' + SECRET } });
      assert.equal(r.code, 1);
      assert.match(r.out, new RegExp(`key type LIVE_API_KEY .*status ${code} \\| verify ${code} \\| settle ${code} -> ${word}`));
      assert.match(r.out, code === 403 ? /Circle says: forbidden/ : /Circle says: invalid credentials/);
      noLeak(r);
    } finally { await s.close(); }
  }
});

test('Circle echoing the key in its answer: replaced before printing', async () => {
  const s = await stub(refusing(401, `bad key ${KEY} for this account`));
  try {
    const r = await run([], { env: { CIRCLE_FACILITATOR_URL: s.url, CIRCLE_API_KEY: KEY } });
    assert.match(r.out, /bad key <key> for this account/);
    noLeak(r);
  } finally { await s.close(); }
});

test('an unexpected status (a 500) is UNEXPECTED, never ACCEPTED', async () => {
  const s = await stub(refusing(500, 'boom'));
  try {
    const r = await run([], { env: { CIRCLE_FACILITATOR_URL: s.url, CIRCLE_API_KEY: KEY } });
    assert.equal(r.code, 1);
    assert.match(r.out, /UNEXPECTED/);
  } finally { await s.close(); }
});

test('--stdin from a pipe: the candidate is used, not the env key, whatever the terminal wrapped around it', async () => {
  for (const input of [`${KEY}\n`, `${KEY}\r\n`, `"${KEY}"\n`, `\x1b[200~${KEY}\x1b[201~\n`, `CIRCLE_API_KEY=${KEY}\n`, `  ${KEY}  `]) {
    const s = await stub(accepting);
    try {
      const r = await run(['--stdin'], { env: { CIRCLE_FACILITATOR_URL: s.url, CIRCLE_API_KEY: ENV_KEY }, input });
      assert.equal(r.code, 0, JSON.stringify(input) + r.out + r.err);
      assert.match(r.out, /key source stdin \| key type TEST_API_KEY/);
      assert.equal(s.calls.length, 3);
      for (const c of s.calls) assert.equal(c.auth, `Bearer ${KEY}`, 'the candidate, not the env key, goes out');
      noLeak(r);
      noLeak(r, ENV_SECRET);
    } finally { await s.close(); }
  }
});

test('--stdin: a LIVE candidate refused, an unrecognised format described by shape only', async () => {
  const s = await stub(refusing(403));
  try {
    const live = 'LIVE_API_KEY:' + SECRET;
    const r = await run(['--stdin'], { env: { CIRCLE_FACILITATOR_URL: s.url }, input: live + '\n' });
    assert.equal(r.code, 1);
    assert.match(r.out, /key source stdin \| key type LIVE_API_KEY .* -> FORBIDDEN/);
    noLeak(r);
    const odd = 'sk_this_is_not_a_circle_key_9876543210';
    const r2 = await run(['--stdin'], { env: { CIRCLE_FACILITATOR_URL: s.url }, input: odd + '\n' });
    assert.match(r2.out, /key type \(unrecognised format: 38 characters, 1 field\)/);
    assert.ok(!r2.out.includes(odd) && !r2.err.includes(odd));
    const lookalike = 'TEST_API_KEY_but:has:many:fields:in:it';
    const r3 = await run(['--stdin'], { env: { CIRCLE_FACILITATOR_URL: s.url }, input: lookalike + '\n' });
    assert.match(r3.out, new RegExp(`key type \\(unrecognised format: ${lookalike.length} characters, 6 fields\\)`), 'only an exact TEST_API_KEY / LIVE_API_KEY label is printed');
    assert.ok(!r3.out.includes('TEST_API_KEY_but'));
    const r4 = await run(['--stdin'], { env: { CIRCLE_FACILITATOR_URL: s.url }, input: 'WHATEVER_secretpart:abc:def\n' });
    assert.match(r4.out, /key type \(unrecognised format: 27 characters, 3 fields\)/, 'an unknown first field is a piece of a secret: not printed');
    assert.ok(!r4.out.includes('WHATEVER') && !r4.out.includes('secretpart'));
  } finally { await s.close(); }
});

test('--stdin with nothing, or with whitespace inside: exit 2, no probe sent, nothing echoed', async () => {
  const s = await stub(accepting);
  try {
    const empty = await run(['--stdin'], { env: { CIRCLE_FACILITATOR_URL: s.url, CIRCLE_API_KEY: ENV_KEY }, input: '\n' });
    assert.equal(empty.code, 2);
    assert.match(empty.out, /no key received/);
    const spaced = await run(['--stdin'], { env: { CIRCLE_FACILITATOR_URL: s.url, CIRCLE_API_KEY: ENV_KEY }, input: 'TEST_API_KEY:abc def:ghi\n' });
    assert.equal(spaced.code, 2);
    assert.match(spaced.out, /whitespace/);
    assert.ok(!spaced.out.includes('abc') && !spaced.err.includes('abc'));
    assert.equal(s.calls.length, 0, 'no key, no probe');
  } finally { await s.close(); }
});

const PTY = `
import os, pty, select, sys, time
node, tool, key = sys.argv[1], sys.argv[2], sys.argv[3]
pid, fd = pty.fork()
if pid == 0:
    os.execv(node, [node, tool, '--stdin'])
buf = b''
def pump(seconds):
    global buf
    end = time.time() + seconds
    while time.time() < end:
        r, _, _ = select.select([fd], [], [], 0.05)
        if r:
            try:
                d = os.read(fd, 4096)
            except OSError:
                return False
            if not d:
                return False
            buf += d
    return True
t0 = time.time()
while b'input hidden' not in buf and time.time() - t0 < 20:
    pump(0.1)
os.write(fd, key.encode() + b'\\r')
t0 = time.time()
while time.time() - t0 < 20 and pump(0.2):
    pass
os.waitpid(pid, 0)
sys.stdout.write(buf.decode('utf-8', 'replace'))
`;

test('--stdin on a real terminal: the prompt shows, what is typed is not echoed, the verdict comes back', async (t) => {
  const s = await stub(accepting);
  try {
    const out = await new Promise((resolve) => {
      const child = spawn('python3', ['-I', '-c', PTY, process.execPath, TOOL, KEY], { env: { PATH: process.env.PATH, ARC_PAYTO_KEY: keyFile, CIRCLE_FACILITATOR_URL: s.url, CIRCLE_API_KEY: ENV_KEY } });
      let o = '';
      child.stdout.on('data', (d) => { o += d; });
      child.on('error', () => resolve(null));
      child.on('close', () => resolve(o));
    });
    if (out === null) return t.skip('python3 is not available here');
    assert.match(out, /Circle API key \(input hidden, then Enter\)/, out);
    assert.match(out, /key source stdin \| key type TEST_API_KEY .* ACCEPTED/, out);
    assert.ok(!out.includes(SECRET), 'the terminal echoed the key');
    assert.ok(!out.includes(SECRET.slice(0, 12)), 'the terminal echoed the start of the key');
    assert.equal(s.calls.length, 3);
    for (const c of s.calls) assert.equal(c.auth, `Bearer ${KEY}`);
  } finally { await s.close(); }
});

test('the tool writes nothing: no new file in ops/, .env untouched, no auth-failure log even when asked for one', async () => {
  const list = () => fs.readdirSync(path.join(ROOT, 'ops')).sort();
  const before = list();
  const envPath = path.join(ROOT, '.env');
  const envBefore = fs.existsSync(envPath) ? fs.statSync(envPath).mtimeMs : null;
  const authLog = path.join(tmp, 'would-be-auth-log.jsonl');
  const s = await stub(refusing(403));
  try {
    const env = { CIRCLE_FACILITATOR_URL: s.url, CIRCLE_API_KEY: KEY, ARC_AUTH_LOG: authLog };
    await run([], { env });
    await run(['--stdin'], { env, input: KEY + '\n' });
  } finally { await s.close(); }
  assert.deepEqual(list(), before, 'a file appeared in ops/');
  assert.equal(fs.existsSync(authLog), false, 'the check wrote the auth-failure log');
  assert.equal(fs.existsSync(path.join(ROOT, 'arc-auth-failures.jsonl')), false);
  assert.equal(fs.existsSync(envPath) ? fs.statSync(envPath).mtimeMs : null, envBefore);
});

test('static guard: no write call, no child process, and the key reaches the console only through describeKey and scrub', () => {
  const src = fs.readFileSync(TOOL, 'utf8');
  const code = src.split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');
  for (const bad of [/writeFile/, /appendFile/, /createWriteStream/, /writeSync/, /renameSync/, /unlinkSync/, /copyFile/, /child_process/, /execSync|spawnSync|execFile/]) {
    assert.ok(!bad.test(code), `the tool must not contain ${bad}`);
  }
  const lines = code.split('\n');
  const allowed = lines.filter((l) => /console\.log\(`mode /.test(l));
  assert.equal(allowed.length, 1, 'exactly one line reports the verdict');
  assert.match(allowed[0], /describeKey\(c\.apiKey\)/);
  assert.ok(!/\$\{[^}]*(candidate|CIRCLE_API_KEY)/.test(allowed[0]));
  // the arguments of every other console / write call: from the call to the end of its statement
  const callArgs = lines.filter((l) => !/console\.log\(`mode /.test(l)).map((l) => { const at = l.search(/console\.|stdout\.write|stderr\.write/); return at < 0 ? null : l.slice(at).split(';')[0]; }).filter(Boolean);
  assert.ok(callArgs.length >= 4, 'the guard found the print calls');
  assert.deepEqual(callArgs.filter((a) => /candidate|apiKey|CIRCLE_API_KEY/.test(a)), [], 'another call prints something key-shaped');
});
