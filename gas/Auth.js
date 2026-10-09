/* 鼎兆元｜電子佈告欄 — 密碼雜湊、憑證、鎖定（契約 C6、C7、C8、C14）
 * 加密原語由外部注入：GAS 用 gasCrypto_()，node 測試用 crypto 模組，兩邊輸出必須一致。 */
'use strict';

function makeAuth_(c, rules) {
  // c = { sha256Hex(str), hmacB64url(key, msg), randomHex(bytes) }
  var STAFF_MAX_FAIL = rules.STAFF_MAX_FAIL, ADMIN_MAX_FAIL = rules.ADMIN_MAX_FAIL, ADMIN_LOCK_MS = rules.ADMIN_LOCK_MS;

  function safeEq(a, b) {
    a = String(a); b = String(b);
    if (a.length !== b.length) return false;
    var r = 0;
    for (var i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
    return r === 0;
  }
  function newSalt() { return c.randomHex(16); }
  // LINE userId（verify 回來的 sub）→ 同仁表的 lineHash；三個後端輸出必須相同（test/line.test.js 測試向量）
  function lineHash(sub) { return c.sha256Hex((rules.LINE_HASH_PREFIX || 'dzyb-line:') + String(sub)); }
  function hashPin(salt, pin) { return c.sha256Hex(salt + pin); }            // C8

  // C6
  function makeStaffToken(secret, id, ver) {
    return id + '.' + ver + '.' + c.hmacB64url(secret, id + '|' + ver);
  }
  // row = {id, pinVer, active}；回傳 true／false
  // 2026-10-09（LINE 自動登入）起不再要求 row.pinHash：沒設密碼的同仁也能用打卡綁定的 LINE 登入。
  // 安全性仍靠 pinVer：清掉密碼的唯一途徑（重設密碼）一定讓 pinVer +1，舊憑證照樣全部失效；設定密碼（setPin）也 +1。
  function verifyStaffToken(secret, token, row) {
    var p = String(token || '').split('.');
    if (p.length !== 3 || !row || !row.active) return false;
    if (p[0] !== row.id || String(p[1]) !== String(row.pinVer)) return false;
    return safeEq(p[2], c.hmacB64url(secret, p[0] + '|' + p[1]));
  }
  function staffIdOf(token) { return String(token || '').split('.')[0] || null; }

  // C7
  function makeAdminToken(secret, ver, expMs) {
    return 'A.' + ver + '.' + expMs + '.' + c.hmacB64url(secret, 'A|' + ver + '|' + expMs);
  }
  function verifyAdminToken(secret, token, ver, nowMs) {
    var p = String(token || '').split('.');
    if (p.length !== 4 || p[0] !== 'A') return false;
    if (String(p[1]) !== String(ver) || !(Number(p[2]) > nowMs)) return false;
    return safeEq(p[3], c.hmacB64url(secret, 'A|' + p[1] + '|' + p[2]));
  }

  // C14 同仁登入：回傳 {ok, code, left, fail}；fail 是要寫回的新連錯次數
  function staffLogin(row, pin) {
    var fail = Number(row.fail) || 0;
    if (fail >= STAFF_MAX_FAIL) return { ok: false, code: 'LOCKED', fail: fail, left: 0 };
    if (row.pinHash && safeEq(hashPin(row.salt, String(pin)), row.pinHash)) return { ok: true, fail: 0 };
    fail++;
    if (fail >= STAFF_MAX_FAIL) return { ok: false, code: 'LOCKED', fail: fail, left: 0 };
    return { ok: false, code: 'BAD_PIN', fail: fail, left: STAFF_MAX_FAIL - fail };
  }

  // 管理通行碼：st = {hash, salt, fail, lockUntil}；回傳 {ok, code, st}（st 是要寫回的新狀態）
  function adminLogin(st, pass, nowMs) {
    var s = { hash: st.hash, salt: st.salt, fail: Number(st.fail) || 0, lockUntil: Number(st.lockUntil) || 0 };
    if (s.lockUntil > nowMs) return { ok: false, code: 'ADMIN_LOCKED', st: s, until: s.lockUntil };
    if (s.hash && safeEq(hashPin(s.salt, String(pass)), s.hash)) { s.fail = 0; s.lockUntil = 0; return { ok: true, st: s }; }
    s.fail++;
    if (s.fail >= ADMIN_MAX_FAIL) { s.fail = 0; s.lockUntil = nowMs + ADMIN_LOCK_MS; return { ok: false, code: 'ADMIN_LOCKED', st: s, until: s.lockUntil }; }
    return { ok: false, code: 'AUTH', st: s, left: ADMIN_MAX_FAIL - s.fail };
  }

  return {
    newSalt: newSalt, hashPin: hashPin, safeEq: safeEq, lineHash: lineHash,
    makeStaffToken: makeStaffToken, verifyStaffToken: verifyStaffToken, staffIdOf: staffIdOf,
    makeAdminToken: makeAdminToken, verifyAdminToken: verifyAdminToken,
    staffLogin: staffLogin, adminLogin: adminLogin
  };
}

// ---- GAS 端的加密原語 ----
function gasCrypto_() {
  function hex(bytes) {
    return bytes.map(function (b) { var v = (b < 0 ? b + 256 : b).toString(16); return v.length < 2 ? '0' + v : v; }).join('');
  }
  return {
    sha256Hex: function (s) {
      return hex(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, s, Utilities.Charset.UTF_8));
    },
    hmacB64url: function (key, msg) {
      return Utilities.base64EncodeWebSafe(Utilities.computeHmacSha256Signature(msg, key, Utilities.Charset.UTF_8)).replace(/=+$/, '');
    },
    randomHex: function (bytes) {
      var s = '';
      while (s.length < bytes * 2) s += Utilities.getUuid().replace(/-/g, '');
      return s.slice(0, bytes * 2);
    }
  };
}

if (typeof module !== 'undefined') module.exports = { makeAuth_: makeAuth_ };
