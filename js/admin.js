/* 設定面板：管理通行碼登入、公告管理、新增／編輯（含附件上傳）、已讀回條、同仁名單（通行碼只能由 Eason 在指令碼屬性更換） */
'use strict';
var Admin = (function () {
  var L = DZYB, esc = UI.esc;
  var a = { tab: 'posts', filter: 'on', data: null, expand: null, receipts: {}, edit: null, draft: null, files: [], upMsg: '', dirty: false, sync: null };

  function open() { if (UI.store.get('atoken')) load(); else loginForm(); }
  function needLogin(msg) { loginForm(msg); }
  function takeDirty() { var d = a.dirty; a.dirty = false; return d; }

  function loginForm(msg) {
    var s = UI.sheet('<div class="bar"><b>設定</b><button data-close>取消</button></div><div class="body">' +
      '<label class="f">請輸入管理通行碼</label><input class="inp" id="pc" type="password" autocomplete="off">' +
      '<div class="err" id="pcErr"></div><div style="height:12px"></div><button class="btn primary" id="pcGo">進入設定</button></div>');
    if (msg) s.querySelector('#pcErr').textContent = msg;
    var go = s.querySelector('#pcGo');
    var submit = function () {
      var done = UI.busy(go, '驗證中…');
      API.call('adminLogin', { pass: s.querySelector('#pc').value }).then(function (r) {
        done();
        if (r.ok) { UI.store.set('atoken', r.data.atoken); a.tab = 'posts'; if (r.data.data) { a.data = r.data.data; render(); } else load(); }   // 登入回應已含設定頁資料
        else s.querySelector('#pcErr').textContent = r.message;
      });
    };
    go.onclick = submit;
    s.querySelector('#pc').onkeydown = function (e) { if (e.key === 'Enter') submit(); };
    setTimeout(function () { var el = s.querySelector('#pc'); if (el) el.focus(); }, 50);
  }

  function load(keepScroll) {
    var top = keepScroll ? UI.$('sheet').scrollTop : 0;
    if (!a.data) UI.sheet('<div class="bar"><b>設定</b><button data-close>關閉</button></div><div class="body"><div class="loading">載入中</div></div>');
    var t0 = Date.now();
    return API.admin('adminData').then(function (r) {
      if (!r.ok) {
        if (r.code === 'AUTH') return;
        if (a.data) { UI.toast(r.message); return; }
        var es = UI.sheet('<div class="bar"><b>設定</b><button data-close>關閉</button></div><div class="body"><div class="errbox"></div><button class="btn primary" id="adRetry">重試</button></div>');
        es.querySelector('.errbox').textContent = r.message + '（' + Math.round((Date.now() - t0) / 1000) + ' 秒）';
        es.querySelector('#adRetry').onclick = function () { load(); };
        return;
      }
      a.data = r.data; a.loadMs = Date.now() - t0; render(); UI.$('sheet').scrollTop = top;
    });
  }

  function render() {
    var tabs = [['posts', '公告管理'], ['new', a.edit ? '編輯公告' : '新增公告'], ['staff', '同仁名單']];
    var h = '<div class="bar"><b>設定</b><button id="lock">登出</button><button data-close>關閉</button></div><div class="body">' +
      '<div class="seg">' + tabs.map(function (t) { return '<button data-at="' + t[0] + '" class="' + (a.tab === t[0] ? 'on' : '') + '">' + t[1] + '</button>'; }).join('') + '</div>';
    h += a.tab === 'posts' ? postsHTML() : a.tab === 'new' ? formHTML() : staffHTML();
    var s = UI.sheet(h + '</div>');
    s.querySelector('#lock').onclick = function () { UI.store.del('atoken'); a.data = null; a.edit = null; a.draft = null; a.files = []; UI.closeSheet(); UI.toast('已登出設定'); };   // 登出清草稿：之後同仁端收到 MOVED 才會照常重載
    s.querySelectorAll('[data-at]').forEach(function (b) {
      b.onclick = function () { if (b.dataset.at !== 'new') { a.edit = null; a.draft = null; a.files = []; } a.tab = b.dataset.at; render(); };
    });
    bind(s);
  }

  /* ---------- 公告管理 ---------- */
  function tags(p) { return L.isAllUnits(p.units) ? '<span class="tag all">全部</span>' : p.units.map(function (u) { return '<span class="tag ' + u + '">' + L.UNIT_NAME[u] + '</span>'; }).join(' '); }
  function postsHTML() {
    var names = { on: '上架中', plan: '排定上架', off: '已下架' }, posts = a.data.posts;
    var cnt = function (k) { return posts.filter(function (p) { return p.status.state === k; }).length; };
    var list = posts.filter(function (p) { return p.status.state === a.filter; });
    list.sort(a.filter === 'off' ? function (x, y) { return L.sortHistory(x, y, a.data.today); } : L.sortBoard);
    var q = a.data.quota;
    var h = (q ? '<div class="quota">雲端空間：已用 ' + (q.usage / 1073741824).toFixed(1) + ' GB／' + (q.limit / 1073741824).toFixed(0) + ' GB（與其他系統共用）</div>' : '') +
      '<div class="months">' + Object.keys(names).map(function (k) { return '<button data-af="' + k + '" class="' + (a.filter === k ? 'on' : '') + '">' + names[k] + ' ' + cnt(k) + '</button>'; }).join('') + '</div><div class="panel">';
    if (!list.length) h += '<div class="empty" style="padding:20px 0">沒有資料</div>';
    h += list.map(function (p) {
      var st = p.status, exp = a.expand === p.id, pct = p.targetCount ? Math.round(p.readCount / p.targetCount * 100) : 0;
      var stTag = { on: '<span class="status st-on">上架中</span>', plan: '<span class="status st-plan">排定</span>', off: '<span class="status st-off">已下架</span>' }[st.state];
      return '<div class="arow"><div class="t">' + (p.pinned ? '📌 ' : '') + esc(p.title) + '</div>' +
        '<div class="meta" style="margin-top:3px">' + stTag + tags(p) + '<span>上架 ' + L.fmtMD(p.publishOn) + '</span><span>' +
        (st.state === 'off' ? '下架 ' + L.fmtMD(st.offDate) + '（封存於 ' + L.fmtYM(st.month) + '）' : (p.expiresOn ? '到期 ' + L.fmtMD(p.expiresOn) : '不自動下架')) + '</span>' +
        (p.files.length ? '<span>📎' + p.files.length + '</span>' : '') + '</div>' +
        (st.state !== 'plan' ? '<div class="meta" style="margin-top:6px">已讀 <b style="color:var(--ink)">' + p.readCount + '/' + p.targetCount + '</b> 人</div><div class="prog"><i style="width:' + pct + '%"></i></div>' : '') +
        (exp ? receiptsHTML(p.id) : '') +
        '<div class="acts">' + (st.state !== 'plan' ? '<button class="btn ghost small" data-rx="' + esc(p.id) + '">' + (exp ? '收起回條' : '已讀回條／簽名') + '</button>' : '') +
        (st.state === 'off' ? '<button class="btn ghost small" data-re="' + esc(p.id) + '">重新上架</button>'
          : '<button class="btn ghost small" data-off="' + esc(p.id) + '">下架</button><button class="btn ghost small" data-pin="' + esc(p.id) + '">' + (p.pinned ? '取消置頂' : '置頂') + '</button>') +
        '<button class="btn ghost small" data-ed="' + esc(p.id) + '">編輯</button></div></div>';
    }).join('');
    return h + '</div><div class="hint">公告不提供刪除，下架後依下架月份封存於歷史區，永久留存。</div>';
  }
  function receiptsHTML(id) {
    var rows = a.receipts[id];
    if (!rows) return '<div class="loading" style="padding:10px 0">載入回條中</div>';
    var pendN = rows.filter(function (r) { return !r.read && r.active !== false && r.inTarget !== false; }).length;
    var sorted = rows.slice().sort(function (x, y) { return Number(!!x.read) - Number(!!y.read); });   // 未簽名排前面
    return '<div class="acts" style="margin-top:8px"><button class="btn primary small" data-cp="' + esc(id) + '">📋 複製未簽名名單（' + pendN + ' 人）</button></div>' +
      '<div class="names">' + (sorted.map(function (r) {
      return '<span class="' + (r.read ? '' : 'no') + '">' + (r.read ? '✓' : '✗') + ' ' + esc(r.name) + '<small style="opacity:.6"> ' + (L.STAFF_UNIT_NAME[r.unit] || '') +
        (!r.active ? '（已刪除）' : r.inTarget === false ? '（已不在公告單位）' : '') + (r.read ? ' ' + esc(UI.fmtTime(r.at)) : '') + '</small>' +
        (r.sig ? '<br><img src="' + esc(r.sig) + '" style="height:40px;background:#fff;border-radius:4px;margin-top:3px">' : '') + '</span>';
    }).join('') || '<span>此單位沒有同仁</span>') + '</div>';
  }

  /* ---------- 新增／編輯 ---------- */
  function startEdit(p) {
    a.edit = p ? p.id : null;
    a.draft = p ? { title: p.title, body: p.body, units: p.units.slice(), publishOn: p.publishOn, expiresOn: p.expiresOn || '', pinned: !!p.pinned }
      : { title: '', body: '', units: [], publishOn: a.data.today, expiresOn: '', pinned: false };
    a.files = p ? p.files.slice() : []; a.upMsg = ''; a.tab = 'new';
    a.reqId = Date.now().toString(36) + Math.random().toString(36).slice(2, 10);   // 冪等鍵綁這份草稿：換草稿就換新
  }
  function formHTML() {
    if (!a.draft) startEdit(null);
    var d = a.draft, all = d.units.length === 3;
    return '<div class="panel">' +
      '<label class="f">標題 *</label><input class="inp" id="fTitle" maxlength="60">' +
      '<label class="f">內容</label><textarea class="inp" id="fBody" maxlength="' + L.BODY_MAX + '"></textarea>' +
      '<label class="f">顯示單位 *</label><div class="chk"><label><input type="checkbox" id="uAll"' + (all ? ' checked' : '') + '> 全部</label>' +
      L.UNITS.map(function (u) { return '<label><input type="checkbox" class="uOne" value="' + u.id + '"' + (d.units.indexOf(u.id) >= 0 ? ' checked' : '') + '> ' + u.name + '</label>'; }).join('') + '</div>' +
      '<div class="row"><div><label class="f">上架日 *</label><input class="inp" type="date" id="fPub"></div>' +
      '<div><label class="f">到期日（到期自動下架）</label><input class="inp" type="date" id="fExp"></div></div>' +
      '<div class="hint" style="margin:4px 0 0">到期日留空＝不自動下架，需手動下架。</div>' +
      '<label class="f">置頂</label><div class="chk"><label><input type="checkbox" id="fPin"' + (d.pinned ? ' checked' : '') + '> 置頂顯示在最上方</label></div>' +
      '<label class="f">附件（Word／PDF／Excel，最多 ' + L.MAX_FILES + ' 個，單檔 20MB 以內）</label>' +
      '<div class="files" style="margin:4px 0">' + a.files.map(function (f, i) {
        return '<div class="file">' + UI.ficon(f.type) + '<span class="fn">' + esc(f.name) + '</span><span class="fs">' + L.fmtSize(f.size) + '</span><button class="btn ghost small" data-rmf="' + i + '">移除</button></div>';
      }).join('') + '</div>' +
      (a.files.length < L.MAX_FILES ? '<input type="file" id="fFile" multiple accept=".pdf,.doc,.docx,.xls,.xlsx">' : '') +
      (a.upMsg ? '<div class="upbar" id="upMsg"></div>' : '') +
      '<div class="err" id="fErr"></div><div style="height:14px"></div>' +
      '<button class="btn primary" id="fSave">' + (a.edit ? '儲存修改' : '上架公告') + '</button>' +
      (a.edit ? '<div style="height:8px"></div><button class="btn ghost" id="fCancel">取消編輯</button>' : '') + '</div>';
  }
  function bindForm(s) {
    var d = a.draft, q = function (id) { return s.querySelector('#' + id); };
    q('fTitle').value = d.title; q('fBody').value = d.body; q('fPub').value = d.publishOn; q('fExp').value = d.expiresOn;
    if (a.upMsg) q('upMsg').textContent = a.upMsg;
    q('fTitle').oninput = function () { d.title = this.value; };
    q('fBody').oninput = function () { d.body = this.value; };
    q('fPub').oninput = function () { d.publishOn = this.value; };
    q('fExp').oninput = function () { d.expiresOn = this.value; };
    q('fPin').onchange = function () { d.pinned = this.checked; };
    var ones = Array.prototype.slice.call(s.querySelectorAll('.uOne'));
    var sync = function () { d.units = ones.filter(function (c) { return c.checked; }).map(function (c) { return c.value; }); q('uAll').checked = d.units.length === 3; };
    q('uAll').onchange = function () { var on = this.checked; ones.forEach(function (c) { c.checked = on; }); sync(); };
    ones.forEach(function (c) { c.onchange = sync; });
    s.querySelectorAll('[data-rmf]').forEach(function (b) { b.onclick = function () { a.files.splice(+b.dataset.rmf, 1); render(); }; });
    if (q('fFile')) q('fFile').onchange = function (e) { upload(Array.prototype.slice.call(e.target.files)); };
    if (q('fCancel')) q('fCancel').onclick = function () { a.edit = null; a.draft = null; a.files = []; a.tab = 'posts'; render(); };
    q('fSave').onclick = function () {
      var post = Object.assign({ id: a.edit || undefined, files: a.files }, d);
      var bad = L.postProblem(post); if (bad) { q('fErr').textContent = bad; return; }
      var done = UI.busy(q('fSave'), '儲存中…');
      API.admin('savePost', { post: post, reqId: a.reqId }).then(function (r) {
        done();
        if (!r.ok) { if (r.code !== 'AUTH') q('fErr').textContent = r.message; return; }
        var st = r.data.post.status.state;
        UI.toast(st === 'off' ? '已儲存（這則目前是下架狀態）' : a.edit ? '已儲存' : st === 'plan' ? '已排定，' + L.fmtMD(r.data.post.publishOn) + ' 上架' : '已上架');
        a.edit = null; a.draft = null; a.files = []; a.tab = 'posts'; a.filter = st; a.dirty = true; load();
      });
    };
  }
  function readB64(file) {
    return new Promise(function (ok, no) {
      var fr = new FileReader();
      fr.onload = function () { ok(String(fr.result).split(',')[1] || ''); };
      fr.onerror = function () { no(fr.error); };
      fr.readAsDataURL(file);
    });
  }
  function upload(picked) {
    var errs = [], queue = [];
    picked.forEach(function (f) {
      var e = L.checkFiles(a.files.concat(queue).concat([{ name: f.name, size: f.size }])).filter(function (x) { return x.name === f.name; })[0];
      if (e) errs.push(f.name + '：' + ({ BAD_TYPE: '只接受 Word／PDF／Excel', TOO_BIG: '超過 20MB（' + L.fmtSize(f.size) + '）', TOO_MANY: '最多 ' + L.MAX_FILES + ' 個附件，未加入' })[e.code]);
      else queue.push(f);
    });
    var total = queue.length, i = 0;
    function next() {
      if (i >= total) { a.upMsg = ''; render(); showErrs(); return; }
      var f = queue[i];
      a.upMsg = '上傳中 ' + (i + 1) + '/' + total + '：' + f.name + '（請勿關閉頁面）'; render();
      readB64(f).then(function (b64) { return API.admin('uploadFile', { name: f.name, data: b64 }); })
        .then(function (r) { if (r.ok) a.files.push(r.data); else if (r.code !== 'AUTH') errs.push(f.name + '：' + r.message); i++; next(); },
          function () { errs.push(f.name + '：讀取檔案失敗'); i++; next(); });
    }
    function showErrs() { var el = UI.$('fErr'); if (el && errs.length) el.innerHTML = errs.map(esc).join('<br>'); }
    if (!total) showErrs(); else next();
  }

  /* ---------- 同仁名單 ---------- */
  function staffHTML() {
    var st = a.data.staff;
    var sy = a.sync, syHTML = '';
    if (sy) {
      syHTML = '<div class="upbar" style="margin-top:10px">' +
        '各來源在職人數：' + Object.keys(sy.counts || {}).map(function (k) { return esc(k) + ' ' + sy.counts[k] + ' 人'; }).join('、') + '<br>' +
        '新增 ' + sy.added.length + ' 人' + (sy.added.length ? '：' + sy.added.map(esc).join('、') : '') +
        (sy.adopted ? '<br>已對應既有名單 ' + sy.adopted + ' 人' : '') +
        (sy.moved && sy.moved.length ? '<br>依主店判定調整：' + sy.moved.map(esc).join('、') : '') +
        (sy.left.length ? '<br>⚠️ 打卡系統已離職、但仍在佈告欄名單（請自行決定是否刪除）：' + sy.left.map(function (x) { return esc(x.name) + '（' + L.STAFF_UNIT_NAME[x.unit] + '）'; }).join('、') : '') +
        (sy.errors.length ? '<br>❌ ' + sy.errors.map(esc).join('<br>❌ ') : '') + '</div>';
    }
    return '<div class="panel"><h4>從打卡系統同步</h4><div class="hint" style="margin:0 0 8px">讀取小辛辣光復店、央廚、墨竹亭金山店、墨竹亭光復店、墨竹亭六張犁店、總部打卡系統的在職名單，自動加入缺少的同仁（只讀取，不會改動打卡系統）。同一人在兩家以上時，依 Eason 判定的主店只留一筆；總部同仁要先由 Eason 判定歸哪一組才會同步。小辛辣美村、南昌請手動新增。</div>' +
      '<button class="btn ghost" id="syncBtn">↻ 從打卡系統同步</button>' + syHTML + '</div>' +
      '<div class="panel"><h4>新增同仁</h4><div class="row"><input class="inp" id="sName" placeholder="姓名（全名）" maxlength="20">' +
      '<select class="inp" id="sUnit">' + L.STAFF_UNITS.map(function (u) { return '<option value="' + u.id + '">' + u.name + '</option>'; }).join('') + '</select>' +
      '<select class="inp" id="sStore"' + (L.STORES[L.STAFF_UNITS[0].id] ? '' : ' hidden') + '><option value="">選門市</option>' + L.STORES.mzt.map(function (x) { return '<option>' + x + '</option>'; }).join('') + '</select></div>' +
      '<div class="err" id="sErr"></div><div style="height:10px"></div><button class="btn primary" id="sAdd">新增</button></div>' +
      L.STAFF_UNITS.map(function (u) {
        var ppl = st.filter(function (s) { return s.unit === u.id; });
        return '<div class="panel"><h4><span class="tag ' + (u.id.indexOf('hq-') === 0 ? 'hq' : u.id) + '">' + u.name + '</span> ' + ppl.length + ' 人</h4>' + (ppl.map(function (s) {
          var stSel = L.STORES[s.unit] ? '<select class="inp stSel" data-st="' + esc(s.id) + '" style="width:auto;padding:4px 6px">' + (L.STORES[s.unit].indexOf(s.store) < 0 ? '<option value="" disabled selected>未分店</option>' : '') +
            L.STORES[s.unit].map(function (x) { return '<option' + (x === s.store ? ' selected' : '') + '>' + x + '</option>'; }).join('') + '</select>' : '';
          return '<div class="arow" style="display:flex;align-items:center;gap:8px;padding:8px 0;flex-wrap:wrap"><span style="flex:1">' + esc(s.name) + ' <small style="color:var(--sub)">' +
            (s.locked ? '<span class="lockmark">🔒 已鎖定</span>' : s.hasPin ? '已設密碼' : '未設密碼') + '</small></span>' +
            stSel + (s.hasPin ? '<button class="btn ghost small" data-rp="' + esc(s.id) + '">重設密碼</button>' : '') +
            '<button class="btn ghost small" data-del="' + esc(s.id) + '">刪除</button></div>';
        }).join('') || '<div class="hint">尚無同仁</div>') + '</div>';
      }).join('') +
      '<div class="hint">總部三組都看得到全部公告；總部鼎兆元只簽「全部」，總部墨竹亭／小辛辣只簽自己品牌的公告。名單頁只顯示遮罩姓名（例：陳O安）。應讀人數＝公告單位內目前名單上的同仁；刪除同仁後，他的簽名紀錄保留，但不再計入人數。</div>';
  }

  /* ---------- 複製文字（clipboard 不可用時退回手動複製） ---------- */
  function copyText(t) {
    if (navigator.clipboard && window.isSecureContext) return navigator.clipboard.writeText(t).then(function () { return true; }, function () { return legacyCopy(t); });
    return Promise.resolve(legacyCopy(t));
  }
  function legacyCopy(t) {
    try { var ta = document.createElement('textarea'); ta.value = t; ta.style.position = 'fixed'; ta.style.opacity = '0'; document.body.appendChild(ta); ta.select(); var ok = document.execCommand('copy'); ta.remove(); return ok; } catch (e) { return false; }
  }
  function showText(t) {
    var s = UI.sheet('<div class="bar"><b>請手動複製</b><button id="stBack">返回</button></div><div class="body"><div class="hint" style="margin:0 0 8px">這支手機不支援自動複製，請長按下方文字全選後複製。</div><textarea class="inp" style="min-height:180px" readonly></textarea></div>');
    s.querySelector('textarea').value = t; s.querySelector('textarea').select();
    s.querySelector('#stBack').onclick = function () { render(); };
  }

  /* ---------- 事件 ---------- */
  function act(btn, action, payload, okMsg, confirmMsg) {
    if (confirmMsg && !confirm(confirmMsg)) return;
    var done = UI.busy(btn, '…');
    API.admin(action, payload).then(function (r) {
      done();
      if (!r.ok) { if (r.code !== 'AUTH') UI.toast(r.message); return; }
      if (okMsg) UI.toast(okMsg);
      a.dirty = true; a.receipts = {}; load(true);
    });
  }
  function bind(s) {
    var find = function (id) { return a.data.posts.filter(function (p) { return p.id === id; })[0]; };
    s.querySelectorAll('[data-af]').forEach(function (b) { b.onclick = function () { a.filter = b.dataset.af; a.expand = null; render(); }; });
    s.querySelectorAll('[data-cp]').forEach(function (b) {
      b.onclick = function () {
        var p = find(b.dataset.cp), text = L.unsignedText(p.title, a.receipts[p.id] || []);
        copyText(text).then(function (ok) { if (ok) UI.toast('已複製，可以貼到 LINE 群組'); else showText(text); });
      };
    });
    s.querySelectorAll('[data-rx]').forEach(function (b) {
      b.onclick = function () {
        var id = b.dataset.rx; a.expand = a.expand === id ? null : id; render();
        if (a.expand && !a.receipts[id]) API.admin('receipts', { postId: id }).then(function (r) { if (r.ok) { a.receipts[id] = r.data.rows; var t = UI.$('sheet').scrollTop; render(); UI.$('sheet').scrollTop = t; } });
      };
    });
    s.querySelectorAll('[data-off]').forEach(function (b) { var p = find(b.dataset.off); b.onclick = function () { act(b, 'setPublished', { postId: p.id, on: false }, '已下架並封存', '確定下架「' + p.title + '」？\n下架後會封存到 ' + L.fmtYM(a.data.today.slice(0, 7)) + ' 的歷史區。'); }; });
    s.querySelectorAll('[data-re]').forEach(function (b) {
      var p = find(b.dataset.re);
      b.onclick = function () {
        if (p.expiresOn && p.expiresOn < a.data.today) { UI.toast('已過到期日，請先延後到期日'); startEdit(p); render(); return; }
        act(b, 'setPublished', { postId: p.id, on: true }, '已重新上架');
      };
    });
    s.querySelectorAll('[data-pin]').forEach(function (b) { var p = find(b.dataset.pin); b.onclick = function () { act(b, 'setPinned', { postId: p.id, on: !p.pinned }, p.pinned ? '已取消置頂' : '已置頂'); }; });
    s.querySelectorAll('[data-ed]').forEach(function (b) { b.onclick = function () { startEdit(find(b.dataset.ed)); render(); }; });
    if (a.tab === 'new') bindForm(s);
    var q = function (id) { return s.querySelector('#' + id); };
    if (q('sUnit')) q('sUnit').onchange = function () { q('sStore').hidden = !L.STORES[q('sUnit').value]; };
    s.querySelectorAll('[data-st]').forEach(function (sel) {
      sel.onchange = function () {
        var st = a.data.staff.filter(function (x) { return x.id === sel.dataset.st; })[0];
        API.admin('staffSetStore', { staffId: st.id, store: sel.value }).then(function (r) {
          if (!r.ok) { if (r.code !== 'AUTH') UI.toast(r.message); return; }
          UI.toast(st.name + ' 改到 ' + sel.value); a.dirty = true; load(true);
        });
      };
    });
    if (q('sAdd')) q('sAdd').onclick = function () {
      var name = q('sName').value.trim(); if (!name) { q('sErr').textContent = '請填姓名'; return; }
      if (L.STORES[q('sUnit').value] && !q('sStore').value) { q('sErr').textContent = '請選擇門市'; return; }
      var done = UI.busy(q('sAdd'), '新增中…');
      API.admin('staffAdd', { name: name, unit: q('sUnit').value, store: q('sStore').value }).then(function (r) {
        done(); if (!r.ok) { if (r.code !== 'AUTH') q('sErr').textContent = r.message; return; }
        UI.toast('已新增 ' + name); a.dirty = true; load(true);
      });
    };
    s.querySelectorAll('[data-rp]').forEach(function (b) {
      var st = a.data.staff.filter(function (x) { return x.id === b.dataset.rp; })[0];
      b.onclick = function () { act(b, 'staffResetPin', { staffId: st.id }, '已重設，請通知 ' + st.name, '重設「' + st.name + '」的密碼？\n舊密碼立即失效，他已登入的手機也會被登出，下次選名字時設定新密碼。'); };
    });
    s.querySelectorAll('[data-del]').forEach(function (b) {
      var st = a.data.staff.filter(function (x) { return x.id === b.dataset.del; })[0];
      b.onclick = function () { act(b, 'staffDelete', { staffId: st.id }, '已刪除', '確定從名單刪除「' + st.name + '」？\n他的簽名紀錄會保留。'); };
    });
    if (q('syncBtn')) q('syncBtn').onclick = function () {
      var done = UI.busy(q('syncBtn'), '同步中…');
      API.admin('syncClock', {}).then(function (r) {
        done(); if (!r.ok) { if (r.code !== 'AUTH') UI.toast(r.message); return; }
        a.sync = r.data; UI.toast('同步完成，新增 ' + r.data.added.length + ' 人'); a.dirty = true; load(true);
      });
    };
  }

  function hasDraft() { return !!a.draft && !!UI.store.get('atoken'); }   // api.js：收到 MOVED 時，登入中且有草稿就不自動重載
  return { open: open, needLogin: needLogin, takeDirty: takeDirty, hasDraft: hasDraft };
})();
