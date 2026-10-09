/* 鼎兆元｜電子佈告欄 — 本機假後端（?mode=local）
 * 與正式後端共用 gas/Service.js，只把資料放在 localStorage（dzyb_mock_db）。
 * 加密用假的雜湊，只為了讓流程跑得起來，不具安全性。 */
'use strict';

var DZYB_MOCK = (function () {
  var G = typeof window !== 'undefined' ? window : global;
  var L = G.DZYB, KEY = 'dzyb_mock_db';
  var BLOBS = {};                                   // 本機上傳的檔案內容（重新整理就消失）

  function fakeHex(s, len) {                        // FNV-1a 疊代，湊出固定長度的 hex
    var out = '', h = 2166136261, i, k = 0;
    while (out.length < len) {
      for (i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
      h ^= k++; out += ('00000000' + h.toString(16)).slice(-8);
    }
    return out.slice(0, len);
  }
  // sha256Hex 用真的 SHA-256（js/sha256.js）：LINE 登入的 lineHash 必須與正式後端算出同一個值（測試向量見 test/line.test.js）
  var sha = G.DZYB_SHA256 ? G.DZYB_SHA256.hex : function (s) { return fakeHex(s, 64); };
  var fakeCrypto = {
    sha256Hex: function (s) { return sha(s); },
    hmacB64url: function (k, m) { return fakeHex(k + '|' + m, 43); },
    randomHex: function (n) { var s = ''; while (s.length < n * 2) s += Math.floor(Math.random() * 16).toString(16); return s; }
  };
  var auth = G.makeAuth_(fakeCrypto, L);

  // 資料帶入測試：測試以 add_init_script 注入 window.__E2E_DATA（每次隨機產生），有就用它，不用下方示範資料
  function seedFromE2E(d) {
    var staff = d.staff.map(function (x) {
      var salt = x.pin ? 'e2e-' + x.id : '';
      return { id: x.id, name: x.name, unit: x.unit, salt: salt, pinHash: x.pin ? auth.hashPin(salt, x.pin) : '',
        pinVer: 1, fail: x.fail || 0, active: true, createdAt: '2026-01-01T00:00:00.000Z', deletedAt: '', src: x.src || '', store: x.store || '',
        lineHash: x.lineUid ? auth.lineHash(x.lineUid) : '' };   // 帶入資料的 lineUid＝模擬打卡系統已綁定的 LINE userId
    });
    var posts = d.posts.map(function (p) {
      return { id: p.id, title: p.title, body: p.body || '', units: p.units, publishOn: p.publishOn, expiresOn: p.expiresOn || '',
        pinned: !!p.pinned, published: p.published !== false, offOn: p.offOn || '', files: p.files || [],
        createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' };
    });
    var reads = d.reads.map(function (r) {
      var st = staff.filter(function (x) { return x.id === r.staffId; })[0];
      return { postId: r.postId, staffId: r.staffId, name: st.name, unit: st.unit, at: r.at, sig: '' };
    });
    return { posts: posts, staff: staff, reads: reads, log: [], admin: { hash: '', salt: '', init: d.adminPass, ver: 1, fail: 0, lockUntil: 0 },
      secret: 'e2e-secret', fileSeq: 0 };
  }

  function seed() { return seedFromE2E(G.__E2E_DATA || G.DZYB_DEMO(L)); }

  var db = null, mem = null;
  function storage() { try { return G.localStorage || null; } catch (e) { return null; } }
  function load() {
    if (db) return db;
    var ls = storage();
    try { db = ls ? JSON.parse(ls.getItem(KEY)) : mem; } catch (e) { db = null; }
    if (!db) { db = seed(); save(); }
    return db;
  }
  function save() { var ls = storage(); try { if (ls) ls.setItem(KEY, JSON.stringify(db)); else mem = db; } catch (e) {} }
  function clone(o) { return JSON.parse(JSON.stringify(o)); }
  function upsert(list, obj) {
    var i = list.findIndex(function (x) { return x.id === obj.id; });
    if (i >= 0) list[i] = clone(obj); else list.push(clone(obj));
  }

  var store = {
    getPosts: function () { return clone(load().posts); },
    savePost: function (p) { upsert(load().posts, p); save(); },
    getStaff: function () { return clone(load().staff); },
    saveStaff: function (s) { upsert(load().staff, s); save(); },
    getReads: function () { return clone(load().reads); },
    addRead: function (r) { load().reads.push(clone(r)); save(); },
    addLog: function (e) { load().log.push(e); save(); },
    getAdmin: function () { return clone(load().admin); },
    setAdmin: function (a) { load().admin = clone(a); save(); },
    secret: function () { return load().secret; },
    getReq: function (rid) { return (load().reqs || {})[rid] || null; },
    putReq: function (rid, id) { var d = load(); (d.reqs = d.reqs || {})[rid] = id; save(); }
  };
  var files = {
    upload: function (name, mime, b64) {
      var d = load(), id = 'L-' + (++d.fileSeq); save();
      BLOBS[id] = 'data:' + mime + ';base64,' + b64;
      return { id: id, name: name, type: L.fileType(name), size: Math.floor(b64.length * 3 / 4) };
    },
    share: function () {}, revoke: function (ids) { ids.forEach(function (id) { delete BLOBS[id]; }); },
    quota: function () { return { limit: 16106127360, usage: 7935000000 }; }
  };
  var clock = { nowMs: function () { return Date.now(); }, today: function () { return L.today(); } };
  // 模擬打卡系統名單（來自注入資料或示範資料）
  var CLOCK = (G.__E2E_DATA || G.DZYB_DEMO(L)).clock || [];
  var clockSrc = { read: function () {
    var rows = CLOCK.map(function (r) {                           // 比照 Apps Script：只交出 lineHash，不交出 LINE userId
      var o = JSON.parse(JSON.stringify(r)); o.lineHash = r.lineUid ? auth.lineHash(r.lineUid) : ''; delete o.lineUid; return o;
    });
    return { rows: rows, errors: [], sources: ['gf', 'cf', 'js'],
      counts: { '小辛辣光復店': CLOCK.filter(function (r) { return r.src === 'gf' && r.active; }).length, '央廚': CLOCK.filter(function (r) { return r.src === 'cf' && r.active; }).length, '墨竹亭金山店': CLOCK.filter(function (r) { return r.src === 'js' && r.active; }).length } };
  } };
  // 本機假資料的 LINE 驗證：只認 'TEST:<uid>'（line.html?mode=local&test_uid=… 用），其他一律當驗證失敗
  var lineVerify = { verify: function (tok) { var m = /^TEST:(.{1,64})$/.exec(String(tok || '')); return m ? m[1] : null; } };
  var svc = G.makeService_(L, store, files, auth, clock, clockSrc, lineVerify);

  return {
    call: function (action, req) {
      var res = svc.call(action, clone(req || {}));
      return new Promise(function (ok) { setTimeout(function () { ok(res); }, 120); });   // 模擬網路延遲
    },
    callSync: function (action, req) { return svc.call(action, clone(req || {})); },
    blobOf: function (id) { return BLOBS[id] || null; },
    dropPost: function (id) { var d = load(); d.posts = d.posts.filter(function (p) { return p.id !== id; }); save(); },   // 測試用：模擬 reqId 紀錄指向的公告已不存在
    setAdminInit: function (pw) { var d = load(); d.admin.init = pw; save(); },   // 模擬 Eason 在指令碼屬性填 ADMIN_INIT
    setClockActive: function (empId, on) { CLOCK.forEach(function (r) { if (r.empId === empId) r.active = on; }); },   // 測試用
    reset: function () { db = seed(); save(); },
    testerReset: function () {                       // 預覽用：清掉測試員的密碼與簽名
      var d = load();
      d.staff.forEach(function (s) { if (s.name.indexOf('測試員') === 0) { s.pinHash = ''; s.salt = ''; s.pinVer++; s.fail = 0; } });
      var ids = d.staff.filter(function (s) { return s.name.indexOf('測試員') === 0; }).map(function (s) { return s.id; });
      d.reads = d.reads.filter(function (r) { return ids.indexOf(r.staffId) < 0; });
      save();
    }
  };
})();

if (typeof module !== 'undefined') module.exports = DZYB_MOCK;
