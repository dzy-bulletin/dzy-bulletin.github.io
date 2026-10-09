/* 同仁端：選名字／密碼、公告、歷史區、內容頁、簽名 */
'use strict';
var Staff = (function () {
  var L = DZYB, $ = UI.$, esc = UI.esc;
  var FORGOT = '請主管到「設定 → 同仁名單」按「重設密碼」，你下次選名字時就能設定新密碼。';
  var v = { tab: 'board', unit: null, month: null, board: null, hist: null, loading: false, refreshing: false, error: null };

  function me() { try { return JSON.parse(UI.store.get('me')); } catch (e) { return null; } }
  function loggedIn() { return !!(UI.store.get('token') && me()); }

  function start() {
    $('foot').textContent = '鼎兆元｜電子佈告欄 v' + CFG.VERSION + (CFG.MODE === 'local' ? '（本機假資料）' : '') + '　';
    var gl = document.createElement('a'); gl.href = 'guide.html'; gl.textContent = '📖 使用教學'; gl.style.color = 'inherit'; $('foot').appendChild(gl);
    if (CFG.MODE === 'local') {
      // 本機假資料提示條由程式產生，不寫在 HTML 原始碼（避免 LINE 等連結預覽抓到）
      $('demoBar').innerHTML = '🧪 本機假資料｜管理通行碼 <b>1234</b>｜假同仁密碼 <b>0000</b> <button id="testMe">🖊 用未讀測試員登入</button> <button id="resetDemo">重置假資料</button>';
      $('demoBar').hidden = false;
      $('resetDemo').onclick = function () { if (confirm('重置所有假資料？')) { DZYB_MOCK.reset(); clearMe(); location.reload(); } };
      $('testMe').onclick = function () { DZYB_MOCK.testerReset(); clearMe(); v.board = v.hist = null; UI.toast('測試員的密碼與簽名已清除'); picker(true, 'mala'); };
    }
    $('openAdmin').onclick = function () { Admin.open(); };
    // LINE 自動登入（line.html）失敗時留下的一次性提示：顯示一次就刪
    var flash = UI.store.get('flash'); if (flash) UI.store.del('flash');
    if (loggedIn()) { loadBoard(); if (flash) UI.toast(flash); } else picker(true, undefined, flash);
  }
  function clearMe() { UI.store.del('token'); UI.store.del('me'); UI.store.del('board'); renderMe(); $('app').innerHTML = ''; }   // 名單快取（roster）保留：換人時秒開
  function logout(msg) {
    var m = me(), g = m ? (m.unit.indexOf('hq-') === 0 ? 'hq' : m.unit) : undefined;   // 登出後名單停在原本的分組
    clearMe(); v.board = v.hist = null; if (msg) UI.toast(msg); picker(true, g);
  }
  function onSheetClosed() {
    if (!loggedIn()) setTimeout(function () { picker(true); }, 0);
    else if (typeof Admin !== 'undefined' && Admin.takeDirty()) loadBoard();
  }

  function renderMe() {
    var m = me(), bar = $('meBar');
    if (!m || !UI.store.get('token')) { bar.innerHTML = ''; return; }
    bar.innerHTML = '👤 <span id="meName"></span> <button id="chgMe">不是我</button>';
    $('meName').textContent = m.name + '（' + L.STAFF_UNIT_NAME[m.unit] + '）';
    $('chgMe').onclick = function () { logout(); };
  }

  /* ---------- 選名字與密碼 ---------- */
  // 名單來源：①手機快取（秒開）②名單快照 CSV（Google 試算表發布檔，不經 Apps Script）③後端 roster（最準、可能很慢）
  function cachedRoster() { try { return JSON.parse(UI.store.get('roster')) || null; } catch (e) { return null; } }
  // 本機名單快取跟著這支手機上發生的變化即時更新（避免剛設好密碼、登出後又被要求設密碼）
  function patches() { try { return JSON.parse(UI.store.get('rosterPatch')) || {}; } catch (e) { return {}; } }
  function prunePatches(before) {
    var ps = patches(), keep = {}, lim = Math.max(before, Date.now() - 86400e3);
    Object.keys(ps).forEach(function (k) { if (ps[k].at > lim) keep[k] = ps[k]; });
    UI.store.set('rosterPatch', JSON.stringify(keep));
  }
  function patchRoster(id, patch) {
    var l = cachedRoster();
    if (l) { l.forEach(function (s) { if (s.id === id) Object.assign(s, patch); }); UI.store.set('roster', JSON.stringify(l)); }
    var ps = patches(); ps[id] = Object.assign({}, patch, { at: Date.now() }); UI.store.set('rosterPatch', JSON.stringify(ps));
  }
  // 來源資料的時間早於本機變化才套用（快照約 5 分鐘更新；後端回應若在變化之前送出也可能較舊）
  function applyPatches(list, srcAt) {
    var ps = patches();
    list.forEach(function (x) { var p = ps[x.id]; if (p && p.at > srcAt) { if ('locked' in p) x.locked = p.locked; if ('hasPin' in p) x.hasPin = p.hasPin; } });
    return list;
  }
  function parseCsv(t) {
    var lines = String(t || '').replace(/\r/g, '').split('\n').filter(function (l) { return l.trim(); });
    if (!lines.length) return null;
    var cell = function (l) { return l.split(',').map(function (c) { return c.replace(/^"|"$/g, ''); }); };
    var h = cell(lines[0]);
    if (h.join(',') !== 'id,name,unit,store,hasPin,locked') return null;
    return lines.slice(1).map(cell).map(function (c) { return { id: c[0], name: c[1], unit: c[2], store: c[3], hasPin: c[4] === 'Y', locked: c[5] === 'Y' }; });
  }
  function fetchCsvRoster() {
    if (!CFG.ROSTER_CSV || CFG.MODE !== 'cloud') return Promise.resolve(null);
    var ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    var t = setTimeout(function () { if (ctl) ctl.abort(); }, 8000);
    return fetch(CFG.ROSTER_CSV + (CFG.ROSTER_CSV.indexOf('?') < 0 ? '?' : '&') + 't=' + Date.now(), { signal: ctl ? ctl.signal : undefined })
      .then(function (r) { return r.ok ? r.text() : null; }).then(function (x) { clearTimeout(t); return parseCsv(x); }, function () { clearTimeout(t); return null; });
  }

  function picker(force, unit, notice) {
    var lock = force === true, people = null, shown = false, done = false;
    var GROUPS = L.UNITS.concat([{ id: 'hq', name: '總部' }]);
    var grp = function (u) { return u.indexOf('hq-') === 0 ? 'hq' : u; };
    var cur = unit || (me() && grp(me().unit)) || v.unit || 'mala', curStore = null;
    var head = '<div class="bar"><b>請選擇你是誰</b>' + (lock ? '' : '<button data-close>取消</button>') + '</div>';
    UI.sheet(head + '<div class="body"><div class="loading">載入名單中</div><button class="btn ghost" id="toAdmin" style="margin-top:6px">⚙ 主管設定</button></div>', lock);
    $('sheet').querySelector('#toAdmin').onclick = function () { done = true; Admin.open(); };

    function draw() {
      if (done) return;
      shown = true;
      var list = people.filter(function (s) { return grp(s.unit) === cur; }), stores = L.STORES[cur] || null, body;
      if (stores && !curStore) {
        var extra = list.some(function (s) { return stores.indexOf(s.store) < 0; }) ? ['未分店'] : [];
        body = '<div class="hint" style="margin:0 0 6px">請先選門市</div><div class="picklist">' + stores.concat(extra).map(function (st) {
          var n = list.filter(function (s) { return (stores.indexOf(s.store) < 0 ? '未分店' : s.store) === st; }).length;
          return '<button data-ps="' + esc(st) + '">' + esc(st) + '<br><small style="color:var(--sub);font-weight:400">' + n + ' 人</small></button>';
        }).join('') + '</div>';
      } else {
        if (stores) list = list.filter(function (s) { return (stores.indexOf(s.store) < 0 ? '未分店' : s.store) === curStore; });
        body = (stores ? '<button class="btn ghost small" id="backStore" style="margin-bottom:8px">← ' + esc(curStore) + '（換門市）</button>' : '') +
          '<div class="picklist">' + (list.map(function (p) { return '<button data-pick="' + esc(p.id) + '">' + esc(p.name) + (p.locked ? ' 🔒' : '') + (cur === 'hq' ? '<br><small style="color:var(--sub);font-weight:400">' + L.STAFF_UNIT_NAME[p.unit].replace('總部', '') + '</small>' : '') + '</button>'; }).join('') || '<div class="hint" style="grid-column:1/-1">這個單位還沒有同仁名單</div>') + '</div>';
      }
      var s = UI.sheet(head + '<div class="body">' +
        (notice ? '<div class="err" id="pkNotice" style="margin:0 0 8px">' + esc(notice) + '</div>' : '') +
        '<div class="hint" style="margin:0 0 10px">選自己的名字並輸入 4 位數密碼（第一次使用會請你設定）。這支手機會記住你，按「我已閱讀」時會請你手寫簽名。</div>' +
        '<div class="seg">' + GROUPS.map(function (u) { return '<button data-pu="' + u.id + '" class="' + (u.id === cur ? 'on' : '') + '">' + u.name + '</button>'; }).join('') + '</div>' +
        body + '<div class="hint" style="margin-top:14px">找不到自己的名字？請洽主管在「設定 → 同仁名單」新增。</div>' +
        '<button class="btn ghost" id="toAdmin" style="margin-top:6px">⚙ 主管設定</button></div>', lock);
      s.querySelector('#toAdmin').onclick = function () { done = true; Admin.open(); };
      s.querySelectorAll('[data-pu]').forEach(function (b) { b.onclick = function () { cur = b.dataset.pu; curStore = null; draw(); }; });
      s.querySelectorAll('[data-ps]').forEach(function (b) { b.onclick = function () { curStore = b.dataset.ps; draw(); }; });
      if (s.querySelector('#backStore')) s.querySelector('#backStore').onclick = function () { curStore = null; draw(); };
      s.querySelectorAll('[data-pick]').forEach(function (b) {
        b.onclick = function () {
          done = true;
          pinForm(people.filter(function (p) { return p.id === b.dataset.pick; })[0], function () {
            // 回到名單時，合併這支手機剛發生的變化（被鎖、設好密碼），避免期間抵達的名單把它蓋掉
            applyPatches(people, people._srcAt || 0);                        // 只套用比目前名單來源更新的本機變化（不會卡在已被重設的鎖定）
            done = false; draw();
            var t2 = Date.now();                                               // 回到名單時重抓一次（別支手機可能已重設鎖定）
            API.call('roster').then(function (r) { if (r.ok && !done) { r.data._api = true; applyPatches(r.data, t2); prunePatches(t2); r.data._srcAt = t2; people = r.data; UI.store.set('roster', JSON.stringify(r.data)); draw(); } });
          });
        };
      });
    }
    // 名單到了就畫；之後來的更新（CSV、後端）只在使用者還停在名單畫面時重畫
    function got(list, src) {
      if (!list || !list.length && src !== 'api') return;
      if (src === 'csv') applyPatches(list, Date.now() - 10 * 60e3);   // 快照最多晚約 5～10 分鐘
      if (src === 'api') { applyPatches(list, reqAt); prunePatches(reqAt); }   // 後端回應若在本機變化之前送出，以本機變化為準；之前的變化已被後端涵蓋，清掉
      list._srcAt = src === 'api' ? reqAt : src === 'csv' ? Date.now() - 10 * 60e3 : 0;
      people = list; if (src === 'api') UI.store.set('roster', JSON.stringify(list));
      if (!done) draw();
    }
    got(cachedRoster(), 'cache');
    fetchCsvRoster().then(function (l) { if (!people || !people._api) got(l, 'csv'); });
    var reqAt = Date.now();
    API.call('roster').then(function (r) {
      if (r.ok) { r.data._api = true; got(r.data, 'api'); return; }
      if (people || done) return;
      var es = UI.sheet('<div class="bar"><b>請選擇你是誰</b></div><div class="body"><div class="errbox"></div><button class="btn primary" id="rt">重試</button>' +
        '<button class="btn ghost" id="toAdmin" style="margin-top:8px">⚙ 主管設定</button></div>', true);
      es.querySelector('.errbox').textContent = r.message;
      es.querySelector('#rt').onclick = function () { picker(force, unit); };
      es.querySelector('#toAdmin').onclick = function () { Admin.open(); };
    });
  }

  function pinInput(id, ph) { return '<input class="inp pinbox" id="' + id + '" type="password" inputmode="numeric" pattern="[0-9]*" maxlength="4" autocomplete="off" placeholder="' + ph + '">'; }

  function pinForm(p, back) {
    var title = p.locked ? '已鎖定' : p.hasPin ? '輸入密碼' : '設定個人密碼';
    var body;
    if (p.locked) body = '<div class="content" style="margin-top:0">密碼錯誤太多次，已鎖定。' + FORGOT + '</div><button class="btn ghost" id="pfBack2">我知道了</button>';
    else if (p.hasPin) body = '<div class="hint" style="margin:0 0 10px" id="pfWho"></div>' + pinInput('pv', '請輸入 4 位數密碼') +
      '<div class="err" id="pfErr"></div><div style="height:12px"></div><button class="btn primary" id="pfGo">進入</button>' +
      '<div style="height:10px"></div><button class="btn ghost" id="pfForgot">忘記密碼？</button>';
    else body = '<div class="hint" style="margin:0 0 10px" id="pfWho"></div><label class="f">輸入 4 位數密碼</label>' + pinInput('p1', '••••') +
      '<label class="f">再輸入一次</label>' + pinInput('p2', '••••') + '<div class="err" id="pfErr"></div><div style="height:12px"></div><button class="btn primary" id="pfGo">設定並進入</button>';
    var s = UI.sheet('<div class="bar"><b>' + title + '</b><button id="pfBack">返回</button></div><div class="body">' + body + '</div>', true);
    s.querySelector('#pfBack').onclick = back;
    if (p.locked) { s.querySelector('#pfBack2').onclick = back; return; }
    s.querySelector('#pfWho').textContent = p.name + '（' + L.STAFF_UNIT_NAME[p.unit] + '）' + (p.hasPin ? '' : '你好，第一次使用請設定 4 位數密碼，之後換手機時要輸入。');
    var err = s.querySelector('#pfErr'), go = s.querySelector('#pfGo');
    if (p.hasPin) {
      s.querySelector('#pfForgot').onclick = function () {
        var f = UI.sheet('<div class="bar"><b>忘記密碼</b><button id="fgBack">返回</button></div><div class="body"><div class="content" style="margin-top:0">' + FORGOT + '</div><button class="btn ghost" id="fgOk">我知道了</button></div>', true);
        f.querySelector('#fgBack').onclick = function () { pinForm(p, back); };
        f.querySelector('#fgOk').onclick = back;
      };
      var submit = function () {
        var done = UI.busy(go, '驗證中…');
        API.call('login', { staffId: p.id, pin: s.querySelector('#pv').value }).then(function (r) {
          done();
          if (r.ok) return enter(r.data);
          if (r.code === 'LOCKED') { p.locked = true; patchRoster(p.id, { locked: true }); return pinForm(p, back); }
          if (r.code === 'BAD_REQ' && /尚未設定密碼/.test(r.message)) { p.hasPin = false; return pinForm(p, back); }   // 名單快照可能還沒更新
          err.textContent = r.message; s.querySelector('#pv').value = '';
        });
      };
      go.onclick = submit;
      s.querySelector('#pv').onkeydown = function (e) { if (e.key === 'Enter') submit(); };
      setTimeout(function () { var el = s.querySelector('#pv'); if (el) el.focus(); }, 50);
    } else {
      go.onclick = function () {
        var a = s.querySelector('#p1').value, b = s.querySelector('#p2').value;
        var bad = L.pinProblem(a);
        if (bad === 'BAD_REQ') { err.textContent = '請輸入 4 位數字'; return; }
        if (bad === 'WEAK_PIN') { err.textContent = '太好猜了（如 1111、1234），請換一組'; return; }
        if (a !== b) { err.textContent = '兩次輸入不一樣'; return; }
        var done = UI.busy(go, '設定中…');
        API.call('setPin', { staffId: p.id, pin: a }).then(function (r) {
          done();
          if (r.ok) return enter(r.data);
          if (r.code === 'HAS_PIN') { p.hasPin = true; return pinForm(p, back); }
          err.textContent = r.message;
        });
      };
      setTimeout(function () { var el = s.querySelector('#p1'); if (el) el.focus(); }, 50);
    }
  }

  // 登入成功後存進這支手機（密碼登入與 line.html 的 LINE 登入共用；LINE 登入不動名單快取的 hasPin／locked）
  function saveLogin(d) {
    UI.store.set('token', d.token); UI.store.set('me', JSON.stringify(d.me));
    if (d.board) UI.store.set('board', JSON.stringify({ id: d.me.id, b: d.board }));
  }
  function enter(d) {
    saveLogin(d); patchRoster(d.me.id, { hasPin: true, locked: false });
    v.unit = L.homeTab(d.me.unit); v.tab = 'board'; v.board = v.hist = null;
    UI.closeSheet(); UI.toast('你好，' + d.me.name);
    if (d.board) { v.board = d.board; cacheBoard(d.board); renderMe(); render(); }   // 登入回應已含公告，不用再等一次
    else loadBoard();
  }
  // 上次的公告存在這支手機：再次打開時先顯示，背景更新（Apps Script 回應常要數秒到數十秒）
  function cacheBoard(b) { UI.store.set('board', JSON.stringify({ id: b.me.id, b: b })); }
  function cachedBoard() { try { var c = JSON.parse(UI.store.get('board')); var m = me(); return c && m && c.id === m.id ? c.b : null; } catch (e) { return null; } }

  /* ---------- 公告與歷史 ---------- */
  function loadBoard() {
    renderMe(); v.error = null;
    var cached = !v.board && cachedBoard();
    if (cached) { v.board = cached; v.refreshing = true; v.loading = false; } else v.loading = !v.board;
    render();
    API.staff('board').then(function (r) {
      v.loading = false; v.refreshing = false;
      if (!r.ok) { if (r.code !== 'AUTH') { if (v.board) UI.toast('更新失敗，顯示的是上次的內容'); else v.error = r.message; render(); } return; }
      v.board = r.data; cacheBoard(r.data); UI.store.set('me', JSON.stringify(r.data.me)); renderMe();
      if (!v.unit) v.unit = L.homeTab(r.data.me.unit);
      render();
    });
  }
  function loadHistory() {
    v.loading = true; v.error = null; render();
    API.staff('history').then(function (r) {
      v.loading = false;
      if (!r.ok) { if (r.code !== 'AUTH') { v.error = r.message; render(); } return; }
      v.hist = r.data; render();
    });
  }
  function reads() { return (v.tab === 'hist' ? v.hist : v.board || {}).myReads || {}; }
  function iTarget(p) { var m = me(); return !!m && L.mustSign(m.unit, p); }

  function render() {
    var app = $('app'), m = me();
    if (!m) { app.innerHTML = ''; return; }
    var tabs = L.viewTabs(m.unit), home = L.homeTab(m.unit);
    if (tabs.indexOf(v.unit) < 0) v.unit = home;
    var myR = (v.board && v.board.myReads) || {};
    var unread = function (u) {
      return v.board ? v.board.posts.filter(function (p) { return p.units.indexOf(u) >= 0 && iTarget(p) && !myR[p.id]; }).length : 0;
    };
    var h = '<div class="tabs"><button data-tab="board" class="' + (v.tab === 'board' ? 'on' : '') + '">📌 公告</button>' +
      '<button data-tab="hist" class="' + (v.tab === 'hist' ? 'on' : '') + '">🗂 歷史區</button></div>' +
      '<div class="seg">' + L.UNITS.filter(function (u) { return tabs.indexOf(u.id) >= 0; }).map(function (u) {
        var n = (v.tab === 'board' && u.id === home) ? unread(u.id) : 0;
        return '<button data-unit="' + u.id + '" class="' + (v.unit === u.id ? 'on' : '') + '">' + u.name + (n ? '<span class="n">' + n + '</span>' : '') + '</button>';
      }).join('') + '</div>';
    if (v.refreshing) h += '<div class="hint" style="text-align:center">更新中…</div>';
    if (v.loading) h += '<div class="loading">載入中</div>';
    else if (v.error) h += '<div class="errbox" id="errMsg"></div><button class="btn ghost" id="retry">重試</button>';
    else if (v.tab === 'board' && v.board) {
      var list = v.board.posts.filter(function (p) { return p.units.indexOf(v.unit) >= 0; });
      h += list.length ? list.map(card).join('') : '<div class="empty">目前沒有公告</div>';
    } else if (v.tab === 'hist' && v.hist) {
      var arch = v.hist.posts.filter(function (p) { return p.units.indexOf(v.unit) >= 0; });
      var months = arch.map(function (p) { return p.status.month; }).filter(function (x, i, a) { return a.indexOf(x) === i; }).sort().reverse();
      if (months.indexOf(v.month) < 0) v.month = months[0] || null;
      h += '<div class="hint">依下架日期的月份封存</div>';
      if (!months.length) h += '<div class="empty">還沒有封存的公告</div>';
      else h += '<div class="months">' + months.map(function (mm) { return '<button data-month="' + mm + '" class="' + (mm === v.month ? 'on' : '') + '">' + L.fmtYM(mm) + '</button>'; }).join('') + '</div>' +
        arch.filter(function (p) { return p.status.month === v.month; }).map(card).join('');
    }
    app.innerHTML = h;
    if (v.error) { $('errMsg').textContent = v.error; $('retry').onclick = function () { v.tab === 'hist' ? loadHistory() : loadBoard(); }; }
    app.querySelectorAll('[data-tab]').forEach(function (b) {
      b.onclick = function () { v.tab = b.dataset.tab; if (v.tab === 'hist') loadHistory(); else loadBoard(); };
    });
    app.querySelectorAll('[data-unit]').forEach(function (b) { b.onclick = function () { v.unit = b.dataset.unit; render(); }; });
    app.querySelectorAll('[data-month]').forEach(function (b) { b.onclick = function () { v.month = b.dataset.month; render(); }; });
    app.querySelectorAll('[data-post]').forEach(function (b) { b.onclick = function () { openPost(b.dataset.post); }; });
  }

  function tags(p) {
    return L.isAllUnits(p.units) ? '<span class="tag all">全部</span>' : p.units.map(function (u) { return '<span class="tag ' + u + '">' + L.UNIT_NAME[u] + '</span>'; }).join(' ');
  }
  function card(p) {
    var st = p.status, r = reads()[p.id], on = st.state === 'on';
    var exp = on ? (p.expiresOn ? '到期 ' + L.fmtMD(p.expiresOn) : '不自動下架') : '下架 ' + L.fmtMD(st.offDate);
    return '<button class="card ' + (p.pinned && on ? 'pin' : '') + '" data-post="' + esc(p.id) + '">' +
      (on && iTarget(p) && !r ? '<span class="unread"></span>' : '') + '<h3>' + esc(p.title) + '</h3>' +
      '<div class="meta">' + (p.pinned && on ? '<span class="pinmark">📌 置頂</span>' : '') + tags(p) +
      '<span>上架 ' + L.fmtMD(p.publishOn) + '</span><span>' + exp + '</span>' +
      (p.files.length ? '<span>📎 ' + p.files.length + '</span>' : '') + (r ? '<span class="readok">✓ 已讀</span>' : '') + '</div></button>';
  }

  function findPost(id) { var src = v.tab === 'hist' ? v.hist : v.board; return src && src.posts.filter(function (p) { return p.id === id; })[0]; }

  function openPost(id, justSig) {
    var p = findPost(id); if (!p) return;
    var st = p.status, at = reads()[p.id], foot = '';
    if (st.state === 'on' && iTarget(p)) {
      foot = at ? '<div class="done">✓ 已於 ' + esc(UI.fmtTime(at)) + ' 簽名確認閱讀' + (justSig ? '<div><img src="' + esc(justSig) + '" style="max-width:220px;height:70px;object-fit:contain;background:#fff;border-radius:8px;margin-top:8px"></div>' : '') + '</div>'
        : '<button class="btn primary" id="ackBtn">我已閱讀</button>';
    } else if (st.state === 'off') foot = '<div class="hint" style="text-align:center">此公告已於 ' + L.fmtMD(st.offDate) + ' 下架，僅供查閱</div>';
    var s = UI.sheet('<div class="bar"><b>公告內容</b><button data-close>關閉</button></div><div class="body">' +
      '<div class="meta">' + (p.pinned && st.state === 'on' ? '<span class="pinmark">📌 置頂</span>' : '') + tags(p) + '</div>' +
      '<h2>' + esc(p.title) + '</h2>' +
      '<div class="meta"><span>上架 ' + p.publishOn + '</span><span>' + (st.state === 'off' ? '下架 ' + st.offDate : (p.expiresOn ? '到期 ' + p.expiresOn : '不自動下架')) + '</span></div>' +
      (p.body ? '<div class="content">' + esc(p.body) + '</div>' : '') +
      (p.files.length ? '<div class="meta" style="margin-top:8px">附件（點開線上檢視）</div><div class="files">' + p.files.map(function (f, i) { return UI.fileRow(f, 'data-view="' + i + '"'); }).join('') + '</div>' : '') +
      foot + '</div>');
    s.querySelectorAll('[data-view]').forEach(function (b) { b.onclick = function () { UI.view(p.files[+b.dataset.view]); }; });
    var ack = s.querySelector('#ackBtn');
    if (ack) ack.onclick = function () {
      Sign.open(p, me(), function () { openPost(id); }, function (at2, sig) {
        if (!at2) { UI.closeSheet(); UI.toast('你已經簽過這則公告'); loadBoard(); return; }   // 重複送出：以伺服器紀錄為準
        v.board.myReads[p.id] = at2;
        UI.toast('已簽名確認'); render(); openPost(id, sig);
      });
    };
  }

  return { start: start, logout: logout, onSheetClosed: onSheetClosed, loadBoard: loadBoard, picker: picker, me: me, saveLogin: saveLogin };
})();
