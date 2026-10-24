// node test/logic.test.js
'use strict';
const L = require('../js/logic.js');
let pass = 0, fail = 0;
function eq(name, got, want) {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) pass++; else { fail++; console.log('✗', name, '\n   got ', g, '\n   want', w); }
}

// C3 遮罩
eq('mask 1', L.maskName('陳'), '陳');
eq('mask 2', L.maskName('陳安'), '陳O');
eq('mask 3', L.maskName('陳小安'), '陳O安');
eq('mask 4', L.maskName('歐陽娜娜'), '歐OO娜');
eq('mask trim', L.maskName('  王大明 '), '王O明');
eq('mask empty', L.maskName(''), '');
eq('mask emoji-safe', L.maskName('A𠀋B'), 'AOB');

// C9 密碼
eq('pin ok', L.pinProblem('2580'), null);
eq('pin ok2', L.pinProblem('1357'), null);
eq('pin same', L.pinProblem('0000'), 'WEAK_PIN');
eq('pin same9', L.pinProblem('9999'), 'WEAK_PIN');
eq('pin asc', L.pinProblem('1234'), 'WEAK_PIN');
eq('pin asc0', L.pinProblem('0123'), 'WEAK_PIN');
eq('pin asc6', L.pinProblem('6789'), 'WEAK_PIN');
eq('pin desc', L.pinProblem('8765'), 'WEAK_PIN');
eq('pin desc0', L.pinProblem('3210'), 'WEAK_PIN');
eq('pin 3 digits', L.pinProblem('123'), 'BAD_REQ');
eq('pin 5 digits', L.pinProblem('12345'), 'BAD_REQ');
eq('pin letters', L.pinProblem('12a4'), 'BAD_REQ');
eq('pin number type', L.pinProblem(2580), 'BAD_REQ');
eq('pin wrap not weak', L.pinProblem('8901'), null);

// C10 狀態
const T = '2026-09-29';
const P = o => Object.assign({ published: true, offOn: null, expiresOn: null, publishOn: '2026-09-01' }, o);
eq('on', L.status(P({}), T), { state: 'on', offDate: null, month: null });
eq('on expires today', L.status(P({ expiresOn: T }), T).state, 'on');
eq('off expired', L.status(P({ expiresOn: '2026-09-28' }), T), { state: 'off', offDate: '2026-09-28', month: '2026-09' });
eq('off expired prev month', L.status(P({ expiresOn: '2026-08-31' }), T).month, '2026-08');
eq('plan', L.status(P({ publishOn: '2026-09-30' }), T).state, 'plan');
eq('publish today on', L.status(P({ publishOn: T }), T).state, 'on');
eq('manual off', L.status(P({ published: false, offOn: '2026-09-05', expiresOn: '2026-12-31' }), T), { state: 'off', offDate: '2026-09-05', month: '2026-09' });
eq('manual off beats plan', L.status(P({ published: false, offOn: '2026-09-05', publishOn: '2026-10-01' }), T).state, 'off');
eq('manual off month uses offOn not expiry', L.status(P({ published: false, offOn: '2026-10-02', expiresOn: '2026-09-10' }), '2026-10-03').month, '2026-10');

// 日期
eq('addDays', L.addDays('2026-09-29', 3), '2026-10-02');
eq('addDays neg', L.addDays('2026-03-01', -1), '2026-02-28');
eq('today format', /^\d{4}-\d{2}-\d{2}$/.test(L.today()), true);
eq('today taipei', L.today(new Date('2026-09-29T17:00:00Z')), '2026-09-30');

// 單位
eq('normUnits order', L.normUnits(['cf', 'mzt', 'x']), ['mzt', 'cf']);
eq('isAll', L.isAllUnits(['cf', 'mala', 'mzt']), true);
eq('isAll no', L.isAllUnits(['cf', 'mala']), false);

// 排序
const list = [
  { id: 'a', pinned: false, publishOn: '2026-09-28' },
  { id: 'b', pinned: true, publishOn: '2026-09-01' },
  { id: 'c', pinned: false, publishOn: '2026-09-29' },
];
eq('sortBoard', list.slice().sort(L.sortBoard).map(x => x.id), ['b', 'c', 'a']);

// C11 附件
eq('type pdf', L.fileType('A.PDF'), 'pdf');
eq('type doc', L.fileType('x.doc'), 'docx');
eq('type xls', L.fileType('x.xls'), 'xlsx');
eq('type bad', L.fileType('x.png'), null);
eq('type none', L.fileType('noext'), null);
const MB = 1024 * 1024;
eq('files ok', L.checkFiles([{ name: 'a.pdf', size: 20 * MB }]), []);
eq('files too big', L.checkFiles([{ name: 'a.pdf', size: 20 * MB + 1 }]), [{ name: 'a.pdf', code: 'TOO_BIG' }]);
eq('files empty', L.checkFiles([{ name: 'a.pdf', size: 0 }]), [{ name: 'a.pdf', code: 'TOO_BIG' }]);
eq('files bad type', L.checkFiles([{ name: 'a.jpg', size: 10 }]), [{ name: 'a.jpg', code: 'BAD_TYPE' }]);
eq('files 6th', L.checkFiles([1, 2, 3, 4, 5, 6].map(i => ({ name: i + '.pdf', size: 1 }))), [{ name: '6.pdf', code: 'TOO_MANY' }]);

// 表單
const D = o => Object.assign({ title: '標題', units: ['mala'], publishOn: '2026-09-29', expiresOn: null, files: [] }, o);
eq('post ok', L.postProblem(D({})), null);
eq('post no title', L.postProblem(D({ title: '  ' })), '請填標題');
eq('post long title', L.postProblem(D({ title: 'x'.repeat(61) })), '標題最多 60 字');
eq('post no unit', L.postProblem(D({ units: [] })), '請選擇顯示單位');
eq('post bad unit only', L.postProblem(D({ units: ['xx'] })), '請選擇顯示單位');
eq('post exp before pub', L.postProblem(D({ expiresOn: '2026-09-28' })), '到期日不能早於上架日');
eq('post body too long', L.postProblem(D({ body: 'x'.repeat(5001) })), '內容最多 5000 字（較長的內容請做成附件）');
eq('post body max ok', L.postProblem(D({ body: 'x'.repeat(5000) })), null);
eq('post exp same day ok', L.postProblem(D({ expiresOn: '2026-09-29' })), null);

// C15 總部三組
const ALLP = { units: ['mzt', 'mala', 'cf'] }, MZT = { units: ['mzt'] }, MALA = { units: ['mala'] }, CF = { units: ['cf'] }, MC = { units: ['mzt', 'cf'] };
// 2026-10-25 v0.8.0 公告依品牌可見（docs/brand-visibility.md）
eq('viewTabs mzt', L.viewTabs('mzt'), ['mzt']);
eq('viewTabs mala', L.viewTabs('mala'), ['mala']);
eq('viewTabs cf', L.viewTabs('cf'), ['cf']);
eq('viewTabs hq-mzt', L.viewTabs('hq-mzt'), ['mzt']);
eq('viewTabs hq-mala', L.viewTabs('hq-mala'), ['mala']);
eq('viewTabs hq-dzy', L.viewTabs('hq-dzy'), ['mzt']);
eq('viewTabs unknown unit', L.viewTabs('xx'), []);
eq('viewTabs seeAll store', L.viewTabs('mala', true), ['mzt', 'mala', 'cf']);
eq('viewTabs seeAll hq-dzy', L.viewTabs('hq-dzy', true), ['mzt', 'mala', 'cf']);
eq('viewTabs seeAll truthy only', L.viewTabs('mala', 'yes'), ['mala']);
eq('canSee store other unit', L.canSee('mala', CF), false);
eq('canSee store own', L.canSee('mala', MALA), true);
eq('canSee store all', L.canSee('cf', ALLP), true);
eq('canSee store partial overlap', L.canSee('cf', MC), true);
eq('canSee mala partial no overlap', L.canSee('mala', MC), false);
eq('canSee hq-mzt mzt', L.canSee('hq-mzt', MZT), true);
eq('canSee hq-mzt all', L.canSee('hq-mzt', ALLP), true);
eq('canSee hq-mzt mala', L.canSee('hq-mzt', MALA), false);
eq('canSee hq-mala cf', L.canSee('hq-mala', CF), false);
eq('canSee hq-dzy mzt', L.canSee('hq-dzy', MZT), true);
eq('canSee hq-dzy cf', L.canSee('hq-dzy', CF), false);
eq('canSee hq-dzy all', L.canSee('hq-dzy', ALLP), true);
eq('canSee seeAll cf', L.canSee('mala', CF, true), true);
eq('canSee seeAll hq-dzy mala', L.canSee('hq-dzy', MALA, true), true);
eq('canSee no units', L.canSee('mala', { units: [] }), false);
eq('canSee unknown unit', L.canSee('xx', ALLP), false);
eq('mustSign store own', L.mustSign('mala', MALA), true);
eq('mustSign store other', L.mustSign('mala', CF), false);
eq('mustSign hq-dzy all', L.mustSign('hq-dzy', ALLP), true);
eq('mustSign hq-dzy partial', L.mustSign('hq-dzy', MC), false);
eq('mustSign hq-mzt partial with mzt', L.mustSign('hq-mzt', MC), true);
eq('mustSign hq-mala mzt', L.mustSign('hq-mala', MZT), false);
eq('homeTab', [L.homeTab('cf'), L.homeTab('hq-mala'), L.homeTab('hq-dzy')], ['cf', 'mala', 'mzt']);
eq('staff unit names', L.STAFF_UNIT_IDS.map(k => L.STAFF_UNIT_NAME[k]), ['墨竹亭', '小辛辣', '央廚', '總部鼎兆元', '總部墨竹亭', '總部小辛辣']);

// 未簽名名單文字
const RR = [
  { name: '甲', unit: 'mala', read: false, active: true, inTarget: true },
  { name: '乙', unit: 'mzt', read: false, active: true, inTarget: true },
  { name: '丙', unit: 'mala', read: true, active: true, inTarget: true },
  { name: '丁', unit: 'mala', read: false, active: false, inTarget: false },
  { name: '戊', unit: 'hq-dzy', read: false, active: true, inTarget: true },
  { name: '己', unit: 'mala', read: false, active: true, inTarget: true },
];
eq('unsignedText grouped', L.unsignedText('SOP', RR), '「SOP」尚未簽名（4 人）\n墨竹亭：乙\n小辛辣：甲、己\n總部鼎兆元：戊\n請盡快到電子佈告欄閱讀並簽名，謝謝！');
eq('unsignedText all signed', L.unsignedText('SOP', [{ name: '丙', unit: 'mala', read: true, active: true }]), '「SOP」全部已簽名 ✅');

eq('STORES mzt', L.STORES.mzt, ['光復', '金山', '六張犁']);
eq('STORES mala none', L.STORES.mala, undefined);

// 格式
eq('fmtMD', L.fmtMD('2026-09-05'), '9/5');
eq('fmtYM', L.fmtYM('2026-09'), '2026 年 9 月');
eq('fmtSize', L.fmtSize(1.5 * MB), '1.5 MB');

console.log(`logic: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
