/* 鼎兆元｜電子佈告欄 — 服務層：API 契約（spec 第五節）的唯一實作
 * 本機假後端（js/mock.js）與 GAS（gas/Code.js）都呼叫這一份，只換 store／files／auth／clock。
 * store: getPosts() savePost(p) getStaff() saveStaff(s) getReads() addRead(r) [getSigs(postId)] addLog(e) getAdmin() setAdmin(a) secret()
 * files: upload(name,mime,b64) share(ids) revoke(ids) quota()
 * clock: { nowMs(), today() }
 * clockSrc（選用）: read() → { rows:[{src, unit, empId, name, active, lineHash}], errors:[字串], sources:[來源] }（打卡系統名單，唯讀；
 *   lineHash＝SHA-256('dzyb-line:' + LINE userId)，原始 userId 不離開 Apps Script）
 * lineVerify（選用）: verify(idToken) → 驗證過的 LINE userId（sub）或 null（LINE ID token 驗證；Mac mini 用 async 墊片、GAS 用 UrlFetchApp、本機假資料認 'TEST:<uid>'） */
'use strict';

function makeService_(L, store, files, auth, clock, clockSrc, lineVerify) {
  var ADMIN_TOKEN_MS = 7 * 24 * 3600e3;   // 主管登入記住 7 天（2026-09-30 Eason 指定；原 12 小時）
  function err(code, message) { var e = new Error(message || code); e.code = code; return e; }
  function iso() { return new Date(clock.nowMs()).toISOString(); }
  function log(action, target, summary) { store.addLog({ at: iso(), action: action, target: target || '', summary: summary || '' }); }

  function findStaff(id) {
    var s = store.getStaff().filter(function (x) { return x.id === id; })[0];
    if (!s || !s.active) throw err('NOT_FOUND', '找不到這位同仁');
    return s;
  }
  function findPost(id) {
    var p = store.getPosts().filter(function (x) { return x.id === id; })[0];
    if (!p) throw err('NOT_FOUND', '找不到這則公告');
    return p;
  }
  function me(s) { return { id: s.id, name: s.name, unit: s.unit }; }
  function staffOf(req) {
    var id = auth.staffIdOf(req.token);
    var s = store.getStaff().filter(function (x) { return x.id === id; })[0];
    if (!auth.verifyStaffToken(store.secret(), req.token, s)) throw err('AUTH', '請重新選擇你的名字');
    return s;
  }
  function requireAdmin(req) {
    var a = store.getAdmin();
    if (a.init) throw err('AUTH', '管理通行碼已更換，請重新登入');     // Eason 填了新 ADMIN_INIT：所有舊登入立即失效
    if (!auth.verifyAdminToken(store.secret(), req.atoken, a.ver, clock.nowMs())) throw err('AUTH', '請重新輸入管理通行碼');
    return a;
  }
  function withStatus(p, td) { var o = Object.assign({}, p); o.status = L.status(p, td); return o; }
  function myReadIds(sid) {
    return store.getReads().filter(function (r) { return r.staffId === sid; }).map(function (r) { return r.postId; });
  }
  function myReadAt(sid) {
    var o = {}; store.getReads().forEach(function (r) { if (r.staffId === sid) o[r.postId] = r.at; }); return o;
  }
  function targets(p) {
    return store.getStaff().filter(function (s) { return s.active && L.mustSign(s.unit, p); });
  }
  // 公告內容指紋（判斷冪等重送是否為同一份內容）
  function fingerprint(d) {
    var s = JSON.stringify([d.id || '', String(d.title || '').trim(), d.body || '', L.normUnits(d.units), d.publishOn || '', d.expiresOn || '', !!d.pinned,
      (d.files || []).map(function (f) { return f && f.id; })]);
    var h = 5381; for (var i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
    return h.toString(36) + ':' + s.length;
  }
  function nextId(prefix, list, width) {
    var n = 0;
    list.forEach(function (x) { if (x.id.indexOf(prefix) === 0) n = Math.max(n, parseInt(x.id.slice(prefix.length), 10) || 0); });
    var s = String(n + 1); while (s.length < width) s = '0' + s;
    return prefix + s;
  }

  // 打卡名單的 LINE 綁定 → 同仁 lineHash（只動 lineHash；比對規則在 L.lineHashUpdates，與 Mac mini 每小時工作共用）
  function applyLineHash(got) {
    var all = store.getStaff(), n = 0;
    L.lineHashUpdates(all, got).forEach(function (u) {
      var s = all.filter(function (x) { return x.id === u.id; })[0];
      if (s) { s.lineHash = u.lineHash; if (u.bump) s.pinVer = (Number(s.pinVer) || 0) + 1; store.saveStaff(s); n++; }   // 解綁／改綁：pinVer+1 踢掉已登入的手機
    });
    return n;
  }

  function boardFor(s) {
    var td = clock.today();
    var posts = store.getPosts().map(function (p) { return withStatus(p, td); })
      .filter(function (p) { return p.status.state === 'on' && L.canSee(s.unit, p); }).sort(L.sortBoard);
    return { today: td, me: me(s), posts: posts, myReads: myReadAt(s.id) };
  }

  var H = {
    roster: function () {
      return store.getStaff().filter(function (s) { return s.active; }).map(function (s) {
        return { id: s.id, name: L.maskName(s.name), unit: s.unit, store: s.store || '', hasPin: !!s.pinHash, locked: (Number(s.fail) || 0) >= L.STAFF_MAX_FAIL };
      });
    },
    setPin: function (q) {
      var s = findStaff(q.staffId);
      if (s.pinHash) throw err('HAS_PIN', '已經設定過密碼');
      var bad = L.pinProblem(q.pin);
      if (bad) throw err(bad, bad === 'WEAK_PIN' ? '太好猜了（如 1111、1234），請換一組' : '請輸入 4 位數字');
      s.salt = auth.newSalt(); s.pinHash = auth.hashPin(s.salt, q.pin); s.pinVer = (Number(s.pinVer) || 0) + 1; s.fail = 0;
      store.saveStaff(s);
      return { token: auth.makeStaffToken(store.secret(), s.id, s.pinVer), me: me(s), board: boardFor(s) };
    },
    login: function (q) {
      var s = findStaff(q.staffId);
      if (!s.pinHash) throw err('BAD_REQ', '尚未設定密碼');
      var r = auth.staffLogin(s, String(q.pin || ''));
      if (r.fail !== (Number(s.fail) || 0)) { s.fail = r.fail; store.saveStaff(s); }
      if (!r.ok) {
        var e = err(r.code, r.code === 'LOCKED' ? '密碼錯誤太多次，已鎖定' : '密碼錯誤（還可以試 ' + r.left + ' 次）');
        e.left = r.left; throw e;
      }
      return { token: auth.makeStaffToken(store.secret(), s.id, s.pinVer), me: me(s), board: boardFor(s) };
    },
    // LINE 自動登入（2026-10-09）：從「鼎兆元打卡」選單進來，用打卡系統已綁定的 LINE 帳號直接登入。
    // 刻意不看也不動 PIN 與連錯次數：沒設密碼、或密碼被鎖住的人也能用 LINE 登入——鎖定是保護「4 位數密碼被猜」，
    // LINE ID token 是另一個獨立的身分證明（由 LINE 簽發、後端向 LINE 驗證），猜密碼的人拿不到。
    // 回傳與 login 相同；同一個 LINE 對到多人（例如同一人在兩店各有一筆）時回 choices，讓本人選，再帶 staffId 重送。
    lineLogin: function (q) {
      if (!lineVerify) throw err('LINE_OFF', 'LINE 登入目前無法使用，請選你的名字登入');
      var tok = String(q.idToken || '');
      if (!tok || tok.length > 4096) throw err('BAD_REQ', '缺少 LINE 登入資料');
      var sub = lineVerify.verify(tok);
      if (!sub) throw err('LINE_BAD', 'LINE 登入驗證失敗，請選你的名字登入');
      var h = auth.lineHash(sub);
      var hits = store.getStaff().filter(function (s) { return s.active && s.lineHash && s.lineHash === h; });
      if (q.staffId) hits = hits.filter(function (s) { return s.id === String(q.staffId); });
      if (!hits.length) throw err('LINE_NOT_LINKED', '這個 LINE 還沒對到佈告欄名單，請選你的名字登入');
      if (hits.length > 1) return { choices: hits.map(function (s) { return { id: s.id, name: L.maskName(s.name), unit: s.unit }; }) };
      var s = hits[0];
      return { token: auth.makeStaffToken(store.secret(), s.id, s.pinVer), me: me(s), board: boardFor(s) };
    },
    board: function (q) { return boardFor(staffOf(q)); },
    history: function (q) {
      var s = staffOf(q), td = clock.today();
      var posts = store.getPosts().filter(function (p) { return L.status(p, td).state === 'off' && L.canSee(s.unit, p); })
        .sort(function (a, b) { return L.sortHistory(a, b, td); }).map(function (p) { return withStatus(p, td); });
      return { today: td, posts: posts, myReads: myReadAt(s.id) };
    },
    ack: function (q) {
      var s = staffOf(q), p = findPost(q.postId);
      if (L.status(p, clock.today()).state !== 'on') throw err('BAD_REQ', '這則公告已下架');
      if (!L.canSee(s.unit, p) || !L.mustSign(s.unit, p)) throw err('BAD_REQ', '這則公告不需要你簽名');
      var sig = String(q.sig || '');
      if (sig.indexOf('data:image/') !== 0 || sig.length > L.SIG_MAX_CHARS) throw err('BAD_REQ', '簽名格式錯誤');
      if (myReadIds(s.id).indexOf(p.id) >= 0) throw err('ALREADY', '你已經簽過這則公告');
      var at = iso();
      store.addRead({ postId: p.id, staffId: s.id, name: s.name, unit: s.unit, at: at, sig: sig });
      return { at: at };
    },
    adminLogin: function (q) {
      var a = store.getAdmin();
      // 通行碼只能由 Eason 在 Apps Script「指令碼屬性」填 ADMIN_INIT 設定或更換（網頁沒有變更功能）。
      // 偵測到 ADMIN_INIT：轉成雜湊、刪掉原文；若是更換（原本已有通行碼），版本 +1 讓所有舊的管理登入失效。
      // 有待生效的 ADMIN_INIT 時：只接受新通行碼（舊的立即失效），輸對才轉成雜湊；輸錯不會消化它
      if (a.init) {
        if (Number(a.lockUntil) > clock.nowMs()) { var le = err('ADMIN_LOCKED', '錯誤太多次，請 15 分鐘後再試'); le.until = Number(a.lockUntil); throw le; }   // 鎖定中一律不比對
        if (a.hash && String(a.init).length < 6) throw err('AUTH', '新的管理通行碼至少要 6 碼，請到 Apps Script 指令碼屬性 ADMIN_INIT 修改');   // 更換時才檢查長度
        if (!auth.safeEq(String(q.pass || ''), String(a.init))) {
          var bad = auth.adminLogin({ hash: '-', salt: '', fail: a.fail, lockUntil: a.lockUntil }, '', clock.nowMs());   // 沿用連錯鎖定
          a.fail = bad.st.fail; a.lockUntil = bad.st.lockUntil; store.setAdmin(a);
          var be = err(bad.code === 'ADMIN_LOCKED' ? 'ADMIN_LOCKED' : 'AUTH', bad.code === 'ADMIN_LOCKED' ? '錯誤太多次，請 15 分鐘後再試' : '通行碼錯誤');
          if (bad.until) be.until = bad.until; throw be;
        }
        var replacing = !!a.hash;
        a.salt = auth.newSalt(); a.hash = auth.hashPin(a.salt, String(a.init)); a.init = '';
        a.ver = replacing ? (Number(a.ver) || 1) + 1 : (Number(a.ver) || 1); a.fail = 0; a.lockUntil = 0;
        store.setAdmin(a); if (replacing) log('更換通行碼', '', '由指令碼屬性 ADMIN_INIT 更換');
      }
      if (!a.hash) throw err('AUTH', '管理通行碼尚未設定');
      var r = auth.adminLogin(a, String(q.pass || ''), clock.nowMs());
      a.fail = r.st.fail; a.lockUntil = r.st.lockUntil; store.setAdmin(a);
      if (!r.ok) {
        var e = err(r.code, r.code === 'ADMIN_LOCKED' ? '錯誤太多次，請 15 分鐘後再試' : '通行碼錯誤');
        e.until = r.until; throw e;
      }
      var atoken = auth.makeAdminToken(store.secret(), a.ver, clock.nowMs() + ADMIN_TOKEN_MS);
      return { atoken: atoken, data: H.adminData({ atoken: atoken }) };   // 一併回傳設定頁資料，少一次往返
    },
    adminData: function (q) {
      var t = [clock.nowMs()], mark = function () { t.push(clock.nowMs()); };
      requireAdmin(q); mark();
      var td = clock.today(), reads = store.getReads(); mark();
      var posts = store.getPosts().map(function (p) {
        var o = withStatus(p, td), tg = targets(p);
        var ids = {}; tg.forEach(function (s) { ids[s.id] = 1; });
        o.readCount = reads.filter(function (r) { return r.postId === p.id && ids[r.staffId]; }).length;
        o.targetCount = tg.length;
        return o;
      });
      var staff = store.getStaff().filter(function (s) { return s.active; }).map(function (s) {
        return { id: s.id, name: s.name, unit: s.unit, store: s.store || '', hasPin: !!s.pinHash, locked: (Number(s.fail) || 0) >= L.STAFF_MAX_FAIL };
      });
      mark();
      var quota = null;
      try { quota = files.quota(); } catch (e) { quota = null; }
      mark();
      if (typeof Logger !== 'undefined') console.log('adminData ms=' + JSON.stringify(t.slice(1).map(function (x, i) { return x - t[i]; })));   // 診斷只進紀錄（C12）
      return { today: td, posts: posts, staff: staff, quota: quota };
    },
    receipts: function (q) {
      requireAdmin(q);
      var p = findPost(q.postId), reads = store.getReads().filter(function (r) { return r.postId === p.id; });
      var sigs = store.getSigs ? store.getSigs(p.id) : null;             // GAS：簽名圖存在 Drive，只在看回條時才讀
      var byId = {}; reads.forEach(function (r) { if (sigs) r.sig = sigs[r.staffId] || null; byId[r.staffId] = r; });
      var rows = targets(p).map(function (s) {
        var r = byId[s.id]; delete byId[s.id];
        return { staffId: s.id, name: s.name, unit: s.unit, active: true, inTarget: true, read: !!r, at: r ? r.at : null, sig: r ? r.sig : null };
      });
      var allStaff = store.getStaff();
      Object.keys(byId).forEach(function (k) {           // 已刪除、或公告改單位後不在對象內但簽過的人：紀錄保留、不計入人數
        var r = byId[k], st = allStaff.filter(function (x) { return x.id === r.staffId; })[0];
        rows.push({ staffId: r.staffId, name: r.name, unit: r.unit, active: !!(st && st.active), inTarget: false, read: true, at: r.at, sig: r.sig });
      });
      return { rows: rows };
    },
    uploadFile: function (q) {
      requireAdmin(q);
      var type = L.fileType(q.name), mime = L.fileMime(q.name);
      if (!type) throw err('BAD_TYPE', '只接受 Word／PDF／Excel');
      var size = Math.floor(String(q.data || '').length * 3 / 4);
      if (!(size > 0) || size > L.MAX_BYTES + 3) throw err('TOO_BIG', '單檔不能超過 20MB');
      return files.upload(String(q.name), mime, String(q.data));
    },
    savePost: function (q) {
      requireAdmin(q);
      var d = q.post || {};
      // 冪等：前端每次按下儲存帶一個 reqId；逾時重送同一個 reqId 時回傳第一次的結果，不重複建立公告
      var bad0 = L.postProblem(d); if (bad0) throw err('BAD_REQ', bad0);   // 先驗證格式，畸形請求不會走到指紋計算
      var rid = String(q.reqId || ''), fp = fingerprint(d), prev = null;
      if (rid && store.getReq) { try { prev = JSON.parse(store.getReq(rid) || 'null'); } catch (e) { prev = null; } }
      if (prev && prev.id && !store.getPosts().some(function (x) { return x.id === prev.id; })) prev = null;   // 紀錄指向的公告不存在就當新請求
      if (prev && prev.id) {
        if (prev.fp === fp && (!d.id || d.id === prev.id)) return { post: withStatus(findPost(prev.id), clock.today()) };   // 真的重送：回第一次結果
        if (!d.id) d.id = prev.id;       // 第一次其實已建立、之後又改了內容：改成編輯那一則，不另建、也不丟掉修改
      }
      var bad = L.postProblem(d); if (bad) throw err('BAD_REQ', bad);
      var fl = (d.files || []).map(function (f) {
        var t = L.fileType(f && f.name);
        if (!t || !f.id) throw err('BAD_TYPE', '附件格式錯誤');            // 類型一律由副檔名判斷，不信任前端
        return { id: String(f.id), name: String(f.name), type: t, size: Number(f.size) || 0 };
      });
      var now = iso(), p, removed = [];
      if (d.id) {
        p = findPost(d.id);
        var keep = {}; fl.forEach(function (f) { keep[f.id] = 1; });
        removed = (p.files || []).filter(function (f) { return !keep[f.id]; }).map(function (f) { return f.id; });
      } else {
        var day = clock.today().replace(/-/g, '');
        p = { id: nextId('P-' + day + '-', store.getPosts(), 3), published: true, offOn: '', createdAt: now };
      }
      p.title = String(d.title).trim(); p.body = String(d.body || ''); p.units = L.normUnits(d.units);
      p.publishOn = d.publishOn; p.expiresOn = d.expiresOn || ''; p.pinned = !!d.pinned; p.files = fl; p.updatedAt = now;
      if (fl.length) files.share(fl.map(function (f) { return f.id; }));   // 先驗證並分享（不合格的 id 在這裡就被擋，公告不會寫入）
      store.savePost(p);                                                  // 再寫試算表
      if (rid && store.putReq) store.putReq(rid, JSON.stringify({ id: p.id, fp: fp }));
      if (removed.length) files.revoke(removed);                          // 最後才撤銷移除的附件
      log(d.id ? '編輯' : '上架', p.id, p.title);
      return { post: withStatus(p, clock.today()) };
    },
    setPublished: function (q) {
      requireAdmin(q);
      var p = findPost(q.postId), td = clock.today();
      if (q.on) {
        if (p.expiresOn && p.expiresOn < td) throw err('BAD_REQ', '已過到期日，請先編輯延後到期日');
        p.published = true; p.offOn = '';
      } else { p.published = false; p.offOn = td; }
      p.updatedAt = iso(); store.savePost(p);
      log(q.on ? '重新上架' : '下架', p.id, p.title);
      return { post: withStatus(p, td) };
    },
    setPinned: function (q) {
      requireAdmin(q);
      var p = findPost(q.postId); p.pinned = !!q.on; p.updatedAt = iso(); store.savePost(p);
      log(q.on ? '置頂' : '取消置頂', p.id, p.title);
      return { post: withStatus(p, clock.today()) };
    },
    staffAdd: function (q) {
      requireAdmin(q);
      var name = String(q.name || '').trim();
      if (!name || name.length > 20) throw err('BAD_REQ', '請填姓名（20 字內）');
      if (L.STAFF_UNIT_IDS.indexOf(q.unit) < 0) throw err('BAD_REQ', '單位錯誤');
      var stores = L.STORES[q.unit] || [], st = String(q.store || '');
      if (stores.length && stores.indexOf(st) < 0) throw err('BAD_REQ', '請選擇門市');
      if (!stores.length) st = '';
      var all = store.getStaff();
      if (all.some(function (s) { return s.active && s.name === name && s.unit === q.unit; })) throw err('BAD_REQ', '此單位已有同名同仁');
      var s = { id: nextId('S-', all, 3), name: name, unit: q.unit, pinHash: '', salt: '', pinVer: 0, fail: 0, active: true, createdAt: iso(), deletedAt: '', src: '', store: st, lineHash: '' };
      store.saveStaff(s); log('新增同仁', s.id, name + '（' + L.STAFF_UNIT_NAME[s.unit] + (st ? st : '') + '）');
      return { staff: { id: s.id, name: s.name, unit: s.unit, store: st, hasPin: false, locked: false } };
    },
    staffSetStore: function (q) {
      requireAdmin(q);
      var s = findStaff(q.staffId), stores = L.STORES[s.unit] || [], st = String(q.store || '');
      if (!stores.length || stores.indexOf(st) < 0) throw err('BAD_REQ', '門市錯誤');
      s.store = st; store.saveStaff(s); log('變更門市', s.id, s.name + '→' + st);
      return {};
    },
    // 從打卡系統同步：只新增在職且尚未在名單的人；打卡已離職者只列出，不自動刪除
    syncClock: function (q) {
      requireAdmin(q);
      if (!clockSrc) throw err('BAD_REQ', '未設定打卡系統來源');
      var got = clockSrc.read(), all = store.getStaff(), added = [], adopted = 0;
      var liveKeys = {};
      got.rows.forEach(function (r) {
        var key = r.src + ':' + r.empId, name = String(r.name || '').trim();
        if (!r.empId || !name || L.STAFF_UNIT_IDS.indexOf(r.unit) < 0) return;
        if (r.active) liveKeys[key] = 1;
        if (!r.active) return;
        var had = all.filter(function (s) { return s.src === key; })[0];
        if (had) { if (r.store && !had.store && had.active) { had.store = r.store; store.saveStaff(had); } return; }   // 已同步過（含被手動刪除的，不再加回）；補上門市
        var same = all.filter(function (s) { return s.active && !s.src && s.name === name && s.unit === r.unit; })[0];
        if (same) { same.src = key; if (r.store && !same.store) same.store = r.store; store.saveStaff(same); adopted++; return; }   // 手動建過的同一人：補上來源
        var gone = all.filter(function (s) { return !s.active && !s.src && s.name === name && s.unit === r.unit; })[0];
        if (gone) { gone.src = key; store.saveStaff(gone); return; }            // 佈告欄已手動刪除的同一人：視為刻意刪除，不加回
        var s = { id: nextId('S-', all, 3), name: name, unit: r.unit, pinHash: '', salt: '', pinVer: 0, fail: 0, active: true, createdAt: iso(), deletedAt: '', src: key, store: r.store || '', lineHash: '' };
        store.saveStaff(s); all.push(s); added.push(name + '（' + L.STAFF_UNIT_NAME[r.unit] + '）');
      });
      applyLineHash(got);                                                   // LINE 綁定：在職→打卡名單的 lineHash，離職／沒綁→清空（只在值有變時寫入）
      var left = all.filter(function (s) { return s.active && s.src && !liveKeys[s.src] && got.sources.indexOf(s.src.split(':')[0]) >= 0; })
        .map(function (s) { return { id: s.id, name: s.name, unit: s.unit }; });
      if (added.length || adopted) log('打卡同步', '', '新增 ' + added.length + ' 人、對應 ' + adopted + ' 人');
      return { added: added, adopted: adopted, left: left, counts: got.counts, errors: got.errors };
    },
    staffDelete: function (q) {
      requireAdmin(q);
      var s = findStaff(q.staffId); s.active = false; s.deletedAt = iso(); store.saveStaff(s);
      log('刪除同仁', s.id, s.name); return {};
    },
    staffResetPin: function (q) {
      requireAdmin(q);
      var s = findStaff(q.staffId); s.pinHash = ''; s.salt = ''; s.pinVer = (Number(s.pinVer) || 0) + 1; s.fail = 0; store.saveStaff(s);
      log('重設密碼', s.id, s.name); return {};
    },
  };

  // 回傳 C12 格式；不讓內部錯誤訊息外洩
  function call(action, req) {
    try {
      return callInner(action, req);
    } finally {
      if (store.endRequest) store.endRequest();   // 成功或失敗（例如連錯被鎖）都要把同仁異動寫進名單快照
    }
  }
  function callInner(action, req) {
    try {
      if (!Object.prototype.hasOwnProperty.call(H, action)) throw err('BAD_REQ', '未知的動作');
      return { ok: true, data: H[action](req || {}) };
    } catch (e) {
      if (e && e.code) {
        var o = { ok: false, code: e.code, message: e.message };
        if (e.left !== undefined) o.left = e.left;
        if (e.until) o.until = e.until;
        return o;
      }
      if (typeof console !== 'undefined') console.error(action + ': ' + (e && e.stack || e));   // 內部錯誤只進紀錄，不回給前端（C12）
      return { ok: false, code: 'SERVER', message: '系統忙碌，請稍後再試' };
    }
  }
  return { call: call, WRITE_ACTIONS: ['setPin', 'login', 'ack', 'adminLogin', 'savePost', 'setPublished', 'setPinned', 'staffAdd', 'staffDelete', 'staffResetPin', 'syncClock', 'staffSetStore', 'lineLogin'] };   // uploadFile 不碰試算表，不上鎖
}

if (typeof module !== 'undefined') module.exports = { makeService_: makeService_ };
