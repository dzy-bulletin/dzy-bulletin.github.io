/* LINE 自動登入（line.html，LIFF 端點）：從「鼎兆元打卡」官方帳號的選單「佈告欄」進來時，
 * 用打卡系統已綁定的 LINE 帳號直接登入，成功就轉到首頁；對不到人或任何失敗都退回首頁的選名字＋密碼（一次性提示）。
 * 每次都重新呼叫 lineLogin（就算手機已記住某人）：共用手機、換帳號時以 LINE 為準。 */
'use strict';
var Line = (function () {
  var $ = UI.$, esc = UI.esc;
  var NOT_LINKED = '這個 LINE 還沒對到名單，請選你的名字';
  var FAILED = 'LINE 登入沒有成功，請選你的名字並輸入密碼';
  var RETRY_KEY = 'dzyb_lineRetry';

  function say(t) { $('app').innerHTML = '<div class="loading"></div>'; $('app').firstChild.textContent = t; }
  // 回首頁：本機測試（?mode=local、?api=）時把參數帶過去，正式網址就是乾淨的 index.html
  function home(flash) {
    if (flash) UI.store.set('flash', flash);
    var q = new URLSearchParams(location.search), keep = new URLSearchParams();
    ['mode', 'api'].forEach(function (k) { if (q.get(k)) keep.set(k, q.get(k)); });
    var qs = keep.toString();
    location.replace('index.html' + (qs ? '?' + qs : ''));
  }
  function loadSdk() {
    return new Promise(function (ok, no) {
      var s = document.createElement('script'); s.src = 'https://static.line-scdn.net/liff/edge/2/sdk.js';
      s.onload = ok; s.onerror = no; document.head.appendChild(s);
    });
  }

  function login(idToken, staffId, onBadToken) {
    say('正在用 LINE 帳號登入…');
    API.call('lineLogin', staffId ? { idToken: idToken, staffId: staffId } : { idToken: idToken }).then(function (r) {
      if (r.ok && r.data && r.data.token) { try { sessionStorage.removeItem(RETRY_KEY); } catch (e) {} Staff.saveLogin(r.data); return home(); }
      if (r.ok && r.data && r.data.choices) return choose(idToken, r.data.choices);
      if (r.code === 'LINE_BAD' && onBadToken && onBadToken()) return;   // LIFF 快取的 ID token 過期：重新登入 LINE 一次
      home(r.code === 'LINE_NOT_LINKED' ? NOT_LINKED : FAILED);
    });
  }
  // 同一個 LINE 對到多位同仁（例如兩店各有一筆）：列出遮罩姓名讓本人選
  function choose(idToken, choices) {
    var s = UI.sheet('<div class="bar"><b>你是哪一位？</b></div><div class="body">' +
      '<div class="hint" style="margin:0 0 10px">這個 LINE 對到不只一位同仁，請選你自己。</div><div class="picklist">' +
      choices.map(function (c) {
        return '<button data-pick="' + esc(c.id) + '">' + esc(c.name) + '<br><small style="color:var(--sub);font-weight:400">' + esc(DZYB.STAFF_UNIT_NAME[c.unit] || '') + '</small></button>';
      }).join('') + '</div><button class="btn ghost" id="lcNone" style="margin-top:12px">都不是我，改用選名字登入</button></div>', true);
    // 不走 UI.closeSheet：那會觸發首頁的「選名字」畫面
    s.querySelectorAll('[data-pick]').forEach(function (b) { b.onclick = function () { $('mask').classList.remove('show'); login(idToken, b.dataset.pick); }; });
    s.querySelector('#lcNone').onclick = function () { home(); };
  }

  function start() {
    var q = new URLSearchParams(location.search), testUid = CFG.MODE === 'local' ? q.get('test_uid') : null;
    if (testUid) return login('TEST:' + testUid);            // 本機假資料測試：不經 LIFF（只在 ?mode=local）
    if (!CFG.LIFF_ID) return home();
    say('正在用 LINE 帳號登入…');
    loadSdk().then(function () { return liff.init({ liffId: CFG.LIFF_ID }); }).then(function () {
      if (!liff.isLoggedIn()) { liff.login({ redirectUri: location.href }); return; }
      var tok = liff.getIDToken();
      if (!tok) return home(FAILED);
      login(tok, null, function () {
        var tried = false; try { tried = !!sessionStorage.getItem(RETRY_KEY); sessionStorage.setItem(RETRY_KEY, '1'); } catch (e) { tried = true; }
        if (tried) return false;
        liff.logout(); liff.login({ redirectUri: location.href }); return true;
      });
    }).catch(function () { home(FAILED); });
  }
  return { start: start };
})();
