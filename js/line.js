/* LINE 自動登入（line.html，LIFF 端點）：從「鼎兆元打卡」官方帳號的選單「佈告欄」進來時，
 * 用打卡系統已綁定的 LINE 帳號直接登入，成功就轉到首頁；對不到人或任何失敗都退回首頁的選名字＋密碼（一次性提示）。
 * 每次都重新呼叫 lineLogin（就算手機已記住某人）：共用手機、換帳號時以 LINE 為準。 */
'use strict';
var Line = (function () {
  var $ = UI.$, esc = UI.esc;
  var NOT_LINKED = '這個 LINE 還沒對到名單，請選你的名字';
  var FAILED = 'LINE 登入沒有成功，請選你的名字並輸入密碼';
  var RETRY_KEY = 'dzyb_lineRetry';

  // 硬逾時要比 API 的 lineLogin 逾時（含 LINE 驗證）再多 10 秒，否則後端正常但慢時會被提早踢回首頁（#32-9）
  var TIMEOUT_MS = ((CFG.TIMEOUT && CFG.TIMEOUT.lineLogin) || 30000) + 10000, REDIRECT_MS = 10000, gone = false, timer = null;

  function say(t) { $('app').innerHTML = '<div class="loading"></div>'; $('app').firstChild.textContent = t; }
  function ss(op, k, v) { try { return op === 'get' ? sessionStorage.getItem(k) : op === 'set' ? sessionStorage.setItem(k, v) : sessionStorage.removeItem(k); } catch (e) { return op === 'get' ? '1' : null; } }   // 存不了就當作「已經試過」，不重導
  // 回首頁：本機測試（?mode=local、?api=）時把參數帶過去，正式網址就是乾淨的 index.html
  function home(flash) {
    if (gone) return; gone = true; clearTimeout(timer);
    ss('del', RETRY_KEY);
    if (flash) UI.store.set('flash', flash);
    var q = new URLSearchParams(location.search), keep = new URLSearchParams();
    ['mode', 'api'].forEach(function (k) { if (q.get(k)) keep.set(k, q.get(k)); });
    var qs = keep.toString();
    location.replace('index.html' + (qs ? '?' + qs : ''));
  }
  // 重新登入 LINE（#32-1、#32-3）：同一個分頁只試一次（sessionStorage 旗標），第二次或任何錯誤都退回首頁。
  // LINE app 內（LIFF 瀏覽器）不能呼叫 liff.login()：改成 logout 後重新載入，讓 liff.init 自己重新取得登入。
  function relogin(logoutFirst) {
    if (ss('get', RETRY_KEY)) { home(FAILED); return; }
    ss('set', RETRY_KEY, '1');
    try {
      if (logoutFirst) liff.logout();
      // 備援計時：liff.login／reload 照理會離開這頁（計時器跟著消失）；10 秒內既沒轉走也沒丟錯就退回首頁（#32-9）
      clearTimeout(timer); timer = setTimeout(function () { home(FAILED); }, REDIRECT_MS);
      if (liff.isInClient()) location.reload(); else liff.login({ redirectUri: location.href });
    } catch (e) { home(FAILED); }
  }
  function loadSdk() {
    return new Promise(function (ok, no) {
      var s = document.createElement('script'); s.src = 'https://static.line-scdn.net/liff/edge/2/sdk.js';
      s.onload = ok; s.onerror = no; document.head.appendChild(s);
    });
  }

  function login(idToken, staffId, inLiff) {
    say('正在用 LINE 帳號登入…');
    API.call('lineLogin', staffId ? { idToken: idToken, staffId: staffId } : { idToken: idToken }).then(function (r) {
      if (r.ok && r.data && r.data.token) { Staff.saveLogin(r.data); return home(); }
      if (r.ok && r.data && r.data.choices) return choose(idToken, r.data.choices, inLiff);
      if (r.code === 'LINE_BAD' && inLiff) return relogin(true);   // LIFF 快取的 ID token 過期：重新登入 LINE 一次
      home(r.code === 'LINE_NOT_LINKED' ? NOT_LINKED : FAILED);
    }).catch(function () { home(FAILED); });
  }
  // 同一個 LINE 對到多位同仁（例如兩店各有一筆）：列出遮罩姓名讓本人選（選人期間不計逾時）
  function choose(idToken, choices, inLiff) {
    clearTimeout(timer);
    var s = UI.sheet('<div class="bar"><b>你是哪一位？</b></div><div class="body">' +
      '<div class="hint" style="margin:0 0 10px">這個 LINE 對到不只一位同仁，請選你自己。</div><div class="picklist">' +
      choices.map(function (c) {
        return '<button data-pick="' + esc(c.id) + '">' + esc(c.name) + '<br><small style="color:var(--sub);font-weight:400">' + esc(DZYB.STAFF_UNIT_NAME[c.unit] || '') + '</small></button>';
      }).join('') + '</div><button class="btn ghost" id="lcNone" style="margin-top:12px">都不是我，改用選名字登入</button></div>', true);
    // 不走 UI.closeSheet：那會觸發首頁的「選名字」畫面
    s.querySelectorAll('[data-pick]').forEach(function (b) { b.onclick = function () { $('mask').classList.remove('show'); arm(); login(idToken, b.dataset.pick, inLiff); }; });
    s.querySelector('#lcNone').onclick = function () { home(); };
  }
  // 硬性逾時：不管卡在哪一步（SDK 載不到、LIFF 沒回應、後端沒回應），TIMEOUT_MS 後一律退回首頁
  function arm() { clearTimeout(timer); timer = setTimeout(function () { home(FAILED); }, TIMEOUT_MS); }

  function start() {
    var q = new URLSearchParams(location.search), testUid = CFG.MODE === 'local' ? q.get('test_uid') : null;
    arm();
    if (testUid) return login('TEST:' + testUid);            // 本機假資料測試：不經 LIFF（只在 ?mode=local）
    if (!CFG.LIFF_ID || CFG.MODE === 'local') return home();   // 本機模式不連真的 LINE（10/9 填入正式 LIFF ID 後 e2e 會被導去 LINE 錯誤頁）
    say('正在用 LINE 帳號登入…');
    loadSdk().then(function () { return liff.init({ liffId: CFG.LIFF_ID }); }).then(function () {
      if (!liff.isLoggedIn()) return relogin(false);          // 第二次還是沒登入（瀏覽器存不了 LIFF 登入）→ 退回首頁，不無限轉址
      var tok = liff.getIDToken();
      if (!tok) return home(FAILED);
      login(tok, null, true);
    }).catch(function () { home(FAILED); });
  }
  return { start: start };
})();
