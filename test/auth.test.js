// node test/auth.test.js
'use strict';
const crypto = require('crypto');
const L = require('../js/logic.js');
const { makeAuth_ } = require('../gas/Auth.js');

const nodeCrypto = {
  sha256Hex: s => crypto.createHash('sha256').update(s, 'utf8').digest('hex'),
  hmacB64url: (k, m) => crypto.createHmac('sha256', Buffer.from(k, 'utf8')).update(m, 'utf8').digest('base64url'),
  randomHex: n => crypto.randomBytes(n).toString('hex'),
};
const A = makeAuth_(nodeCrypto, L);
let pass = 0, fail = 0;
function eq(name, got, want) {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) pass++; else { fail++; console.log('✗', name, '\n   got ', g, '\n   want', w); }
}
const SECRET = 'test-secret-0123456789abcdef';

// C8
const salt = A.newSalt();
eq('salt 32 hex', /^[0-9a-f]{32}$/.test(salt), true);
eq('hash stable', A.hashPin('ab', '2580'), nodeCrypto.sha256Hex('ab2580'));
eq('hash differs by salt', A.hashPin('ab', '2580') === A.hashPin('ac', '2580'), false);

// 已知向量：GAS 端部署後用同樣輸入比對（見 T8 驗收）
eq('hmac known vector', nodeCrypto.hmacB64url('k', 'S-001|1'), crypto.createHmac('sha256', 'k').update('S-001|1').digest('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''));

// C6 同仁憑證
const row = { id: 'S-007', pinHash: A.hashPin(salt, '2580'), salt, pinVer: 2, active: true, fail: 0 };
const tok = A.makeStaffToken(SECRET, 'S-007', 2);
eq('token shape', /^S-007\.2\.[A-Za-z0-9_-]{43}$/.test(tok), true);
eq('token ok', A.verifyStaffToken(SECRET, tok, row), true);
eq('staffIdOf', A.staffIdOf(tok), 'S-007');
const tampered = tok.slice(0, -1) + (tok.slice(-1) === 'A' ? 'B' : 'A');
eq('token tampered', A.verifyStaffToken(SECRET, tampered, row), false);
eq('token other id', A.verifyStaffToken(SECRET, tok.replace('S-007', 'S-008'), Object.assign({}, row, { id: 'S-008' })), false);
eq('token after reset (ver+1)', A.verifyStaffToken(SECRET, tok, Object.assign({}, row, { pinVer: 3 })), false);
eq('token inactive', A.verifyStaffToken(SECRET, tok, Object.assign({}, row, { active: false })), false);
// 2026-10-09 LINE 登入：沒設密碼也能持有憑證（安全性靠 pinVer：重設密碼一定 +1）
eq('token no pin, same ver (LINE login)', A.verifyStaffToken(SECRET, tok, Object.assign({}, row, { pinHash: '' })), true);
eq('token no pin after reset (ver+1)', A.verifyStaffToken(SECRET, tok, Object.assign({}, row, { pinHash: '', pinVer: 3 })), false);
eq('token wrong secret', A.verifyStaffToken('other', tok, row), false);
eq('token garbage', A.verifyStaffToken(SECRET, 'x', row), false);
eq('token null', A.verifyStaffToken(SECRET, null, row), false);

// C7 管理憑證
const now = 1759200000000;
const at = A.makeAdminToken(SECRET, 1, now + 12 * 3600e3);
eq('admin ok', A.verifyAdminToken(SECRET, at, 1, now), true);
eq('admin expired', A.verifyAdminToken(SECRET, at, 1, now + 13 * 3600e3), false);
eq('admin ver changed', A.verifyAdminToken(SECRET, at, 2, now), false);
eq('admin tampered exp', A.verifyAdminToken(SECRET, at.replace(String(now + 12 * 3600e3), String(now + 99 * 3600e3)), 1, now), false);
eq('staff token as admin', A.verifyAdminToken(SECRET, tok, 1, now), false);

// C14 同仁連錯 3 次
let r = Object.assign({}, row);
let res = A.staffLogin(r, '0000'); eq('bad 1', [res.code, res.left, res.fail], ['BAD_PIN', 2, 1]); r.fail = res.fail;
res = A.staffLogin(r, '0001'); eq('bad 2', [res.code, res.left], ['BAD_PIN', 1]); r.fail = res.fail;
res = A.staffLogin(r, '2580'); eq('good resets', [res.ok, res.fail], [true, 0]); r.fail = res.fail;
res = A.staffLogin(r, '1'); r.fail = res.fail; res = A.staffLogin(r, '2'); r.fail = res.fail;
res = A.staffLogin(r, '3'); eq('bad 3 locks', [res.code, res.fail], ['LOCKED', 3]); r.fail = res.fail;
res = A.staffLogin(r, '2580'); eq('locked even with right pin', [res.ok, res.code], [false, 'LOCKED']);
res = A.staffLogin(Object.assign({}, row, { pinHash: '' }), '2580'); eq('no pin never ok', res.ok, false);

// 管理通行碼連錯 5 次鎖 15 分鐘
const as = A.newSalt();
let st = { hash: A.hashPin(as, 'boss-pass'), salt: as, fail: 0, lockUntil: 0 };
let ar;
for (let i = 1; i <= 4; i++) { ar = A.adminLogin(st, 'x', now); st = ar.st; }
eq('admin 4 wrong', [ar.code, ar.left], ['AUTH', 1]);
ar = A.adminLogin(st, 'x', now); st = ar.st;
eq('admin 5 wrong locks', [ar.code, st.lockUntil], ['ADMIN_LOCKED', now + 15 * 60e3]);
ar = A.adminLogin(st, 'boss-pass', now + 60e3); eq('admin locked right pass', ar.code, 'ADMIN_LOCKED');
ar = A.adminLogin(st, 'boss-pass', now + 16 * 60e3); eq('admin after lock ok', ar.ok, true);

console.log(`auth: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
