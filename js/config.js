/* 設定。GAS_URL 在 T10 部署後填入；MODE 可用網址 ?mode=local 暫時切換成假資料。 */
'use strict';
var CFG = (function () {
  var c = {
    VERSION: '0.7.8',
    // 管理系統「公告專區」嵌入本站時（?embed=dzy），只接受這個網站送來的入場券（2026-10-16）。本機測試另認 localhost（見下方）
    DZY_ORIGIN: 'https://dzy.mozhuting.com',
    ROSTER_CSV: '',   // 「鼎兆元｜電子佈告欄｜公開名單」試算表（獨立檔案，只有遮罩姓名）發布到網路的 CSV 網址（不經 Apps Script，秒開）；空白＝只用後端
    GAS_URL: 'https://dingzhaoyuandemac-mini.tailc27c34.ts.net',
    MODE: 'cloud',
    LIFF_ID: '2011292256-iTZEbOWG',      // LINE「鼎兆元打卡」選單的「佈告欄」按鈕開的 LIFF（line.html）；空白＝line.html 直接轉到首頁（選名字＋密碼）
    TIMEOUT: { _default: 30000, uploadFile: 240000, adminData: 40000, savePost: 120000, syncClock: 150000, lineLogin: 30000, dzyLogin: 30000, dzyAdminLogin: 40000, receipts: 90000, login: 90000, setPin: 90000, ack: 90000 }
  };
  try {
    var m = new URLSearchParams(location.search).get('mode');
    if (m === 'local' || m === 'cloud') c.MODE = m;
    // 測試用：只有在本機（localhost 或 127.0.0.1）開啟時才允許 ?api= 指定後端；正式網址一律忽略（防止假連結把人導到釣魚後端）。
    // 兩種寫法都要認：只認 localhost 時，E2E 用 127.0.0.1 開頁會悄悄打到正式 GAS（#13 第 2 輪）
    var api = new URLSearchParams(location.search).get('api');
    if (api && /^(localhost|127\.0\.0\.1)$/.test(location.hostname) && /^http:\/\/(127\.0\.0\.1|localhost):\d+\/?$/.test(api)) { c.GAS_URL = api; c.MODE = 'cloud'; c.API_OVERRIDE = true; }
    // 測試用：本機開啟時可用 ?dzy=<本機網址> 指定嵌入方（正式網址一律忽略）
    var dz = new URLSearchParams(location.search).get('dzy');
    if (dz && /^(localhost|127\.0\.0\.1)$/.test(location.hostname) && /^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(dz)) c.DZY_ORIGIN = dz;
  } catch (e) {}
  if (c.MODE === 'cloud' && !c.GAS_URL) c.MODE = 'local';   // 尚未部署後端前，一律走假資料
  // DEV＝本機開發／測試（假資料，或本機網址指定 ?api=）。2026-10-17 起「⚙ 設定」「不是我」「主管設定」「同仁名單」只在 DEV 顯示：
  // 正式網址一律看不到，公告管理改從管理系統「公告專區」進（Eason 指定）。本機假資料不碰真後端，留著給整套測試用
  c.DEV = c.MODE === 'local' || !!c.API_OVERRIDE;
  return c;
})();
