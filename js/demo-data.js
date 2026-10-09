/* 示範資料（帶入格式：同仁密碼為明碼，由各後端自己雜湊）。本機假資料與伺服器測試模式共用這一份。 */
'use strict';
var DZYB_DEMO = function (L) {
  var T = L.today(), A = L.addDays, all = ['mzt', 'mala', 'cf'];
  var staff = [
    ['S-001', '陳大安', 'mala'], ['S-002', '林雅婷', 'mala'], ['S-003', '黃俊宇', 'mala'], ['S-004', '張詩涵', 'mala'],
    ['S-005', '李志豪', 'mzt', '光復'], ['S-006', '王淑芳', 'mzt', '金山'], ['S-007', '吳家翔', 'mzt', '金山'], ['S-008', '劉怡君', 'mzt', '六張犁'],
    ['S-009', '蔡明哲', 'cf'], ['S-010', '楊佩琪', 'cf'], ['S-011', '許文傑', 'cf'], ['S-012', '鄭宜萱', 'cf'],
    ['S-013', '測試員甲', 'mala'], ['S-014', '測試員乙', 'mzt', '光復'], ['S-015', '測試員丙', 'cf'],
    ['S-016', '周總經理', 'hq-dzy'], ['S-017', '孫品牌經理', 'hq-mzt'], ['S-018', '趙營運督導', 'hq-mala']
  ].map(function (r) { return { id: r[0], name: r[1], unit: r[2], store: r[3] || '', pin: r[1].indexOf('測試員') === 0 ? null : '0000', fail: 0,
    lineUid: r[0] === 'S-001' ? 'U-demo-001' : '' }; });   // lineUid＝模擬打卡系統綁定的 LINE（本機預覽：line.html?mode=local&test_uid=U-demo-001）
  var F = function (id, name, mb) { return { id: id, name: name, type: L.fileType(name), size: Math.round(mb * 1048576) }; };
  var P = function (o) { return Object.assign({ published: true, offOn: '', expiresOn: '', pinned: false, files: [], body: '' }, o); };
  var posts = [
    P({ id: 'P-20260925-001', title: '10 月份排班提醒與請假流程調整', units: all, pinned: true, publishOn: A(T, -4), expiresOn: A(T, 32),
      body: '各位同仁好：\n\n1. 10 月班表已上傳，請於本週五前確認。\n2. 自 10/1 起，請假需提前 3 天於打卡系統申請，臨時請假請直接電話告知店長。\n3. 附件為新版請假流程與 10 月假日對照表。\n\n如有疑問請洽各單位主管。',
      files: [F('demo-1', '請假流程說明_v2.pdf', 1.2), F('demo-2', '2026年10月假日對照表.xlsx', 0.3)] }),
    P({ id: 'P-20260920-001', title: '【新品】藤椒雞上市作業 SOP', units: ['mala'], publishOn: A(T, -9), expiresOn: A(T, 21),
      body: '藤椒雞 10/1 三店同步上市。\n請全員於上市前詳讀附件 SOP，重點：\n・醃料比例與靜置時間\n・出餐份量 180g\n・過敏原標示（含花椒）',
      files: [F('demo-3', '藤椒雞_SOP.docx', 2.4), F('demo-4', '藤椒雞_出餐照片.pdf', 6.8)] }),
    P({ id: 'P-20260915-001', title: '燃麵醬料配方更新（第 3 版）', units: ['mzt'], publishOn: A(T, -14),
      body: '即日起燃麵醬料改用第 3 版配方，舊版請勿再使用。', files: [F('demo-5', '燃麵醬料配方_v3.pdf', 0.8)] }),
    P({ id: 'P-20260927-001', title: '冷凍庫盤點時間調整為每週二', units: ['cf'], publishOn: A(T, -2), expiresOn: A(T, 11),
      body: '自下週起冷凍庫盤點由每週一改為每週二 14:00，請當班同仁配合。' }),
    P({ id: 'P-20260910-001', title: '颱風季應變通報流程', units: all, pinned: true, publishOn: A(T, -19), expiresOn: A(T, 1),
      body: '颱風警報發布時：\n1. 店長於 LINE 群組回報營業狀態\n2. 停止營業須經品牌主管同意\n3. 同仁安全優先', files: [F('demo-6', '颱風應變流程圖.pdf', 0.5)] }),
    P({ id: 'P-20260929-001', title: '中秋節金發放說明', units: all, publishOn: A(T, 2), expiresOn: A(T, 16), body: '中秋節金將隨 10 月薪資發放。' }),
    P({ id: 'P-20260801-001', title: '8 月起勞健保費率調整說明', units: all, publishOn: '2026-08-01', expiresOn: '2026-08-31',
      body: '8 月起勞健保費率調整，薪資單將同步更新。', files: [F('demo-7', '勞健保費率對照.xlsx', 0.2)] }),
    P({ id: 'P-20260720-001', title: '暑期限定活動結束通知', units: ['mala'], publishOn: '2026-07-20', expiresOn: '2026-08-15', body: '暑期限定套餐於 8/15 結束販售。' }),
    P({ id: 'P-20260701-001', title: '七月消防演練時間表', units: ['mzt'], publishOn: '2026-07-01', expiresOn: '2026-07-20', body: '各店消防演練時間如附件。',
      files: [F('demo-8', '消防演練時間表.docx', 0.4)] }),
    P({ id: 'P-20260820-001', title: '舊版配送時刻表（已停用）', units: ['cf'], publishOn: '2026-08-20', published: false, offOn: '2026-09-05', body: '此版時刻表已由新版取代。' })
  ];
  var R = function (p, s, at) { return { postId: p, staffId: s, at: at }; };
  var reads = [
    R('P-20260925-001', 'S-001', '2026-09-26T02:12:00.000Z'), R('P-20260925-001', 'S-005', '2026-09-25T10:02:00.000Z'),
    R('P-20260925-001', 'S-009', '2026-09-27T01:30:00.000Z'), R('P-20260920-001', 'S-001', '2026-09-21T02:00:00.000Z'),
    R('P-20260915-001', 'S-005', '2026-09-16T04:00:00.000Z'), R('P-20260915-001', 'S-006', '2026-09-16T04:30:00.000Z'),
    R('P-20260910-001', 'S-001', '2026-09-11T02:00:00.000Z'), R('P-20260801-001', 'S-001', '2026-08-02T02:00:00.000Z')
  ];
  var clock = [
    { src: 'gf', unit: 'mala', empId: 'A01', name: '陳大安', active: true, lineUid: 'U-demo-001' },
    { src: 'gf', unit: 'mala', empId: 'A02', name: '光復新人', active: true },
    { src: 'gf', unit: 'mala', empId: 'A03', name: '已離職員工', active: false },
    { src: 'cf', unit: 'cf', empId: 'CF01', name: '蔡明哲', active: true },
    { src: 'cf', unit: 'cf', empId: 'CF09', name: '央廚新人', active: true },
    { src: 'js', unit: 'mzt', store: '金山', empId: 'J01', name: '金山新人', active: true }
  ];
  return { staff: staff, posts: posts, reads: reads, clock: clock, adminPass: '1234' };
};
if (typeof module !== 'undefined') module.exports = DZYB_DEMO;
