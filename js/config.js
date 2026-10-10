/* 設定。GAS_URL 在 T10 部署後填入；MODE 可用網址 ?mode=local 暫時切換成假資料。 */
'use strict';
var CFG = (function () {
  var c = {
    VERSION: '0.7.3',
    ROSTER_CSV: '',   // 「鼎兆元｜電子佈告欄｜公開名單」試算表（獨立檔案，只有遮罩姓名）發布到網路的 CSV 網址（不經 Apps Script，秒開）；空白＝只用後端
    GAS_URL: 'https://dingzhaoyuandemac-mini.tailc27c34.ts.net',
    MODE: 'cloud',
    LIFF_ID: '2011292256-iTZEbOWG',      // LINE「鼎兆元打卡」選單的「佈告欄」按鈕開的 LIFF（line.html）；空白＝line.html 直接轉到首頁（選名字＋密碼）
    TIMEOUT: { _default: 30000, uploadFile: 240000, adminData: 40000, savePost: 120000, syncClock: 150000, lineLogin: 30000, receipts: 90000, login: 90000, setPin: 90000, ack: 90000 }
  };
  try {
    var m = new URLSearchParams(location.search).get('mode');
    if (m === 'local' || m === 'cloud') c.MODE = m;
    // 測試用：只有在本機（localhost 或 127.0.0.1）開啟時才允許 ?api= 指定後端；正式網址一律忽略（防止假連結把人導到釣魚後端）。
    // 兩種寫法都要認：只認 localhost 時，E2E 用 127.0.0.1 開頁會悄悄打到正式 GAS（#13 第 2 輪）
    var api = new URLSearchParams(location.search).get('api');
    if (api && /^(localhost|127\.0\.0\.1)$/.test(location.hostname) && /^http:\/\/(127\.0\.0\.1|localhost):\d+\/?$/.test(api)) { c.GAS_URL = api; c.MODE = 'cloud'; }
  } catch (e) {}
  if (c.MODE === 'cloud' && !c.GAS_URL) c.MODE = 'local';   // 尚未部署後端前，一律走假資料
  return c;
})();
