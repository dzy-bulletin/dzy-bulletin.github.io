// node test/primary.test.js — 打卡名單跨店同名的主店判定（2026-10-10）：L.resolveClockRows、Service.syncClock 改掛主店／改單位、LINE 綁定不被誤清
'use strict';
const crypto = require('crypto');
const L = require('../js/logic.js');
const { makeAuth_ } = require('../gas/Auth.js');
const { makeService_ } = require('../gas/Service.js');

let pass = 0, fail = 0;
function eq(name, got, want) {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) pass++; else { fail++; console.log('✗', name, '\n   got ', g, '\n   want', w); }
}
const nodeCrypto = { sha256Hex: (s) => crypto.createHash('sha256').update(s, 'utf8').digest('hex'),
  hmacB64url: (k, m) => crypto.createHmac('sha256', Buffer.from(k, 'utf8')).update(m, 'utf8').digest('base64url'), randomHex: (n) => crypto.randomBytes(n).toString('hex') };
const A = makeAuth_(nodeCrypto, L);
const H1 = A.lineHash('U1'), H2 = A.lineHash('U2'), H3 = A.lineHash('U3');
const LAB = { gf: '小辛辣光復店', js: '墨竹亭金山店', mgf: '墨竹亭光復店', cf: '央廚' };
const R = (src, unit, empId, name, extra) => Object.assign({ src, unit, store: src === 'js' ? '金山' : src === 'mgf' ? '光復' : '', empId, name, active: true, lineHash: '' }, extra || {});

// ---------- 1. L.resolveClockRows ----------
{ const rows = [
    R('js', 'mzt', 'J1', '甲'), R('mgf', 'mzt', 'G4', '甲', { lineHash: H1 }),                 // 判定主店 mgf；只在金山綁過 LINE 也要合併
    R('js', 'mzt', 'J2', '乙', { lineHash: H2 }), R('mgf', 'mzt', 'G1', '乙'),                 // 判定改歸總部墨竹亭
    R('gf', 'mala', 'E1', '丙'), R('js', 'mzt', 'J3', '丙'),                                     // 沒判定 → hold
    R('mgf', 'mzt', 'G3', '丁'),                                                                  // 單一來源但判定歸總部
    R('js', 'mzt', 'J4', '戊'), R('mgf', 'mzt', 'G5', '戊', { active: false }),                  // 只有一邊在職 → 不算重複
    R('cf', 'cf', 'C1', '己'), R('js', 'mzt', 'J5', '己'),                                       // 判定主店 gf 但 gf 沒這人 → hold
    R('gf', 'mala', 'E2', '庚')];
  const P = { 甲: { src: 'mgf' }, 乙: { src: 'mgf', unit: 'hq-mzt', store: '' }, 丁: { src: 'mgf', unit: 'hq-mzt', store: '' }, 己: { src: 'gf' } };
  const before = JSON.stringify(rows);
  const res = L.resolveClockRows(rows, P, LAB);
  const by = (k) => res.rows.find((r) => r.src + ':' + r.empId === k);
  eq('不改動傳入的列', JSON.stringify(rows), before);
  eq('列數不變（不刪列）', res.rows.length, rows.length);
  eq('甲：主店那列 decided＋aka；另一列 dupOf；LINE 綁定合併到兩列', [by('mgf:G4').decided, by('mgf:G4').aka, by('js:J1').dupOf, by('js:J1').lineHash, by('mgf:G4').lineHash],
    [true, ['js:J1'], 'mgf:G4', H1, H1]);
  eq('乙：改歸總部墨竹亭、門市清空；金山那列的綁定合併過來', [by('mgf:G1').unit, by('mgf:G1').store, by('mgf:G1').lineHash, by('js:J2').dupOf], ['hq-mzt', '', H2, 'mgf:G1']);
  eq('丙：沒判定 → 兩列都 hold、不標 decided', [by('gf:E1').hold, by('js:J3').hold, !!by('gf:E1').decided], [true, true, false]);
  eq('丁：單一來源也套用判定（改歸總部）', [by('mgf:G3').unit, by('mgf:G3').decided, by('mgf:G3').aka], ['hq-mzt', true, []]);
  eq('戊：另一店已離職 → 不算重複、不動', [by('js:J4').decided, by('js:J4').hold, by('js:J4').dupOf], [undefined, undefined, undefined]);
  eq('己：判定的主店沒有這人 → hold', [by('cf:C1').hold, by('js:J5').hold], [true, true]);
  eq('庚：一般人不動', Object.keys(by('gf:E2')).sort(), Object.keys(R('gf', 'mala', 'E2', '庚')).sort());
  eq('訊息：丙請 Eason 判定、己主店沒這人', res.messages, ['「丙」同時在 小辛辣光復店（E1）、墨竹亭金山店（J3），請 Eason 判定以哪家店為主（判定前不同步這個人）',
    '「己」的主店（小辛辣光復店）名單裡沒有這個人或這次沒讀到，暫不同步']);
  eq('沒有 primary 也能跑（全部重複都 hold）', L.resolveClockRows([R('gf', 'mala', 'E1', '丙'), R('js', 'mzt', 'J3', '丙')]).rows.map((r) => r.hold), [true, true]);
  eq('不合法的 unit 判定不套用', L.resolveClockRows([R('mgf', 'mzt', 'G3', '丁')], { 丁: { src: 'mgf', unit: 'boss' } }).rows[0].unit, 'mzt');
}

// ---------- 2. Service.syncClock ----------
function memStore(staff) {
  const d = { posts: [], staff, reads: [], log: [], admin: {}, saves: 0 };
  return { d, getPosts: () => [], savePost: () => {}, getStaff: () => JSON.parse(JSON.stringify(d.staff)),
    saveStaff: (s) => { d.saves++; const i = d.staff.findIndex((x) => x.id === s.id); if (i >= 0) d.staff[i] = JSON.parse(JSON.stringify(s)); else d.staff.push(JSON.parse(JSON.stringify(s))); },
    getReads: () => [], addRead: () => {}, addLog: (e) => d.log.push(e), getAdmin: () => ({ hash: A.hashPin('s', 'adminpass'), salt: 's', ver: 1, fail: 0, lockUntil: 0, init: '' }),
    setAdmin: () => {}, secret: () => 'SECRET' };
}
const S0 = (id, name, unit, extra) => Object.assign({ id, name, unit, pinHash: '', salt: '', pinVer: 0, fail: 0, active: true, createdAt: '', deletedAt: '', src: '', store: '', lineHash: '' }, extra || {});
const clock = { nowMs: () => Date.now(), today: () => '2026-10-10' };
{ // 佈告欄現況：甲、乙、己 是從金山同步來的；庚 從小辛辣與金山各同步一次（兩筆）；辛 手動建在總部鼎兆元
  const st = memStore([
    S0('S-001', '甲', 'mzt', { src: 'js:J1', store: '金山', lineHash: H1, pinVer: 3 }),
    S0('S-002', '乙', 'mzt', { src: 'js:J2', store: '金山', lineHash: H2 }),
    S0('S-003', '庚', 'mala', { src: 'gf:E2' }), S0('S-004', '庚', 'mzt', { src: 'js:J6', store: '金山' }),
    S0('S-005', '辛', 'hq-dzy')]);
  const raw = [
    R('js', 'mzt', 'J1', '甲'), R('mgf', 'mzt', 'G4', '甲', { lineHash: H1 }),
    R('js', 'mzt', 'J2', '乙', { lineHash: H2 }), R('mgf', 'mzt', 'G1', '乙'),
    R('gf', 'mala', 'E1', '丙'), R('js', 'mzt', 'J3', '丙'),
    R('mgf', 'mzt', 'G3', '丁'),
    R('gf', 'mala', 'E2', '庚'), R('js', 'mzt', 'J6', '庚'),
    R('js', 'mzt', 'J7', '辛'), R('mgf', 'mzt', 'G9', '壬')];
  const P = { 甲: { src: 'mgf' }, 乙: { src: 'mgf', unit: 'hq-mzt', store: '' }, 丁: { src: 'mgf', unit: 'hq-mzt', store: '' }, 庚: { src: 'gf' }, 辛: { src: 'js', unit: 'hq-dzy', store: '' } };
  const read = () => { const r = L.resolveClockRows(raw, P, LAB); return { rows: r.rows, messages: r.messages, errors: [], sources: ['gf', 'js', 'mgf'], counts: {} }; };
  const sv = makeService_(L, st, { quota: () => null }, A, clock, { read }, { verify: () => null });
  const at = A.makeAdminToken('SECRET', 1, Date.now() + 60e3);
  const by = (id) => st.d.staff.find((s) => s.id === id);
  const r = sv.call('syncClock', { atoken: at });
  eq('syncClock ok', r.ok, true);
  eq('甲：改掛到主店來源、單位與門市照主店、LINE 綁定還在、沒被登出', [by('S-001').src, by('S-001').unit, by('S-001').store, by('S-001').lineHash, by('S-001').pinVer], ['mgf:G4', 'mzt', '光復', H1, 3]);
  eq('乙：改掛主店並改歸總部墨竹亭、門市清空、綁定保留', [by('S-002').src, by('S-002').unit, by('S-002').store, by('S-002').lineHash], ['mgf:G1', 'hq-mzt', '', H2]);
  eq('辛：手動建的總部鼎兆元被對應到主店來源', [by('S-005').src, by('S-005').unit], ['js:J7', 'hq-dzy']);
  const names = st.d.staff.filter((s) => s.active).map((s) => s.name).sort();
  eq('新增：丁（歸總部墨竹亭）、壬；丙（待判定）不新增；甲乙不重複', [names, st.d.staff.find((s) => s.name === '丁').unit], [['丁', '乙', '壬', '庚', '庚', '甲', '辛'], 'hq-mzt']);
  eq('added 名單', r.data.added, ['丁（總部墨竹亭）', '壬（墨竹亭）']);
  eq('moved 名單', r.data.moved, ['甲（墨竹亭金山→墨竹亭光復）', '乙（墨竹亭金山→總部墨竹亭）']);
  eq('errors：丙待判定＋庚有兩筆', r.data.errors, ['「丙」同時在 小辛辣光復店（E1）、墨竹亭金山店（J3），請 Eason 判定以哪家店為主（判定前不同步這個人）',
    '「庚」在同仁名單有 2 筆（S-003、S-004），主店是 小辛辣，請刪掉多的那筆']);
  eq('沒有人被列成打卡已離職', r.data.left, []);
  const saves = st.d.saves; const r2 = sv.call('syncClock', { atoken: at });
  eq('第二次同步沒有變化就不寫、不再改單位', [st.d.saves, r2.data.moved, r2.data.added], [saves, [], []]);
  // Mac mini 每小時只刷 lineHash：用 resolve 過的列，不會把還沒改掛的舊來源同仁清掉
  const old = [S0('S-9', '甲', 'mzt', { src: 'js:J1', lineHash: H1 })];
  eq('lineHashUpdates：主店綁定合併到舊來源列 → 舊來源的同仁不被清空、不登出', L.lineHashUpdates(old, read()), []);
  eq('lineHashUpdates：沒 resolve 的話會被清掉（證明合併有作用）', L.lineHashUpdates(old, { rows: raw, sources: ['gf', 'js', 'mgf'] }), [{ id: 'S-9', lineHash: '', bump: true }]);
}

// ---------- 3. 第 1 輪審查（#33）P1–P8 的情境 ----------
{ const at = A.makeAdminToken('SECRET', 1, Date.now() + 60e3);
  const mk = (staff, raw, P, sources) => { const st = memStore(staff);
    const read = () => { const r = L.resolveClockRows(raw, P, LAB); return { rows: r.rows, messages: r.messages, errors: [], sources: sources || ['gf', 'js', 'mgf'], counts: {} }; };
    return { st, read, sv: makeService_(L, st, { quota: () => null }, A, clock, { read }, { verify: () => null }), by: (id) => st.d.staff.find((s) => s.id === id) }; };
  // P1：主店那小時讀取失敗 → 還掛舊店的同仁 hold，lineHash 不清、不登出；也不被列成已離職
  { const raw = [R('js', 'mzt', 'J1', '甲', { lineHash: H1 })];
    const t = mk([S0('S-1', '甲', 'mzt', { src: 'js:J1', lineHash: H1, pinVer: 2 })], raw, { 甲: { src: 'mgf' } }, ['gf', 'js']);
    eq('P1：主店讀取失敗 → lineHashUpdates 不動', L.lineHashUpdates(t.st.d.staff, t.read()), []);
    const r = t.sv.call('syncClock', { atoken: at });
    eq('P1：syncClock 不新增、不登出、不列離職', [t.st.d.staff.length, t.by('S-1').pinVer, t.by('S-1').lineHash, r.data.left], [1, 2, H1, []]); }
  // P2：非主店（舊店）這輪讀取失敗 → aka 是空的，仍用名字改掛，不新增第二筆
  { const t = mk([S0('S-1', '甲', 'mzt', { src: 'js:J1', store: '金山', lineHash: H1 })], [R('mgf', 'mzt', 'G4', '甲', { lineHash: H1 })], { 甲: { src: 'mgf' } }, ['gf', 'mgf']);
    t.sv.call('syncClock', { atoken: at });
    eq('P2：舊店沒讀到也改掛主店、不重複', [t.st.d.staff.length, t.by('S-1').src, t.by('S-1').store], [1, 'mgf:G4', '光復']); }
  // P3：主店有兩位在職同名 → hold、訊息，不合併 LINE、不登出任何人
  { const raw = [R('mgf', 'mzt', 'G1', '甲', { lineHash: H1 }), R('mgf', 'mzt', 'G2', '甲', { lineHash: H2 }), R('js', 'mzt', 'J1', '甲')];
    const res = L.resolveClockRows(raw, { 甲: { src: 'mgf' } }, LAB);
    eq('P3：全部 hold、綁定不合併', [res.rows.map((r) => r.hold), res.rows.map((r) => r.lineHash)], [[true, true, true], [H1, H2, '']]);
    eq('P3：訊息', res.messages, ['「甲」在主店（墨竹亭光復店）有 2 位在職同名，分不出是哪一位，暫不同步']); }
  // P4：判定前舊店已標離職 → mirror 先跑也不登出；同步時改掛主店、不新增、不列離職
  { const raw = [R('js', 'mzt', 'J1', '甲', { active: false, lineHash: H1 }), R('mgf', 'mzt', 'G4', '甲', { lineHash: H1 })];
    const t = mk([S0('S-1', '甲', 'mzt', { src: 'js:J1', lineHash: H1, pinVer: 1 })], raw, { 甲: { src: 'mgf' } });
    eq('P4：mirror 先跑 → 舊來源同仁綁定不清', L.lineHashUpdates(t.st.d.staff, t.read()), []);
    const r = t.sv.call('syncClock', { atoken: at });
    eq('P4：改掛、不新增、不登出、不列離職', [t.st.d.staff.length, t.by('S-1').src, t.by('S-1').pinVer, r.data.left], [1, 'mgf:G4', 1, []]); }
  // P5：舊店那筆在佈告欄已手動刪除 → 不加回、也不新增
  { const t = mk([S0('S-1', '甲', 'mzt', { src: 'js:J1', active: false, deletedAt: 'x' })], [R('js', 'mzt', 'J1', '甲'), R('mgf', 'mzt', 'G4', '甲')], { 甲: { src: 'mgf' } });
    t.sv.call('syncClock', { atoken: at });
    const r5 = t.sv.call('syncClock', { atoken: at });
    eq('P5：手動刪除的不加回', [t.st.d.staff.length, t.by('S-1').active], [1, false]);
    eq('P10：不加回時說出來', r5.data.errors, ['「甲」在同仁名單已刪除，不自動加回；如果是新來的同名同仁，請在同仁名單手動新增']); }
  // P12：只判定 src、佈告欄門市空白 → 補主店門市
  { const t = mk([S0('S-1', '甲', 'mzt', { src: 'mgf:G4', store: '' })], [R('mgf', 'mzt', 'G4', '甲'), R('js', 'mzt', 'J1', '甲')], { 甲: { src: 'mgf' } });
    t.sv.call('syncClock', { atoken: at });
    eq('P12：補上主店門市', t.by('S-1').store, '光復'); }
  // P6：判定表名字打錯／缺 src 有提示
  eq('P6：判定表的名字在名冊找不到、缺 src', L.resolveClockRows([R('gf', 'mala', 'E1', '甲'), R('js', 'mzt', 'J1', '甲')], { 甲: {}, 乙乙: { src: 'gf' } }, LAB).messages,
    ['「甲」的主店判定缺少 src，暫不同步', '主店判定表裡的「乙乙」在讀到的名冊裡都找不到（名字打錯、已移除，或那家店這次沒讀到）']);
  // P7：改掛後從主店離職、別店仍在職 → hold＋請重新判定；不登出、不列離職
  { const raw = [R('mgf', 'mzt', 'G4', '甲', { active: false, lineHash: H1 }), R('js', 'mzt', 'J1', '甲', { lineHash: H1 })];
    const t = mk([S0('S-1', '甲', 'mzt', { src: 'mgf:G4', lineHash: H1, pinVer: 1 })], raw, { 甲: { src: 'mgf' } });
    const r = t.sv.call('syncClock', { atoken: at });
    eq('P7：不登出、不列離職、請重新判定', [t.by('S-1').pinVer, t.by('S-1').lineHash, r.data.left, r.data.errors],
      [1, H1, [], ['「甲」在主店（墨竹亭光復店）已離職，但 墨竹亭金山店（J1） 仍在職，請 Eason 重新判定主店（暫不同步）']]); }
  // P8：只判定 src 的人，主管手動改的門市不被蓋回；有寫 unit 的照判定
  { const t = mk([S0('S-1', '甲', 'mzt', { src: 'mgf:G4', store: '六張犁' }), S0('S-2', '乙', 'mzt', { src: 'mgf:G1', store: '光復' })],
      [R('mgf', 'mzt', 'G4', '甲'), R('js', 'mzt', 'J1', '甲'), R('mgf', 'mzt', 'G1', '乙')], { 甲: { src: 'mgf' }, 乙: { src: 'mgf', unit: 'hq-mzt', store: '' } });
    t.sv.call('syncClock', { atoken: at });
    eq('P8：手動門市保留；有寫 unit 的照判定', [t.by('S-1').store, t.by('S-2').unit, t.by('S-2').store], ['六張犁', 'hq-mzt', '']); }
  // 兩筆都在職時優先改掛 aka 裡那筆
  { const t = mk([S0('S-1', '甲', 'mala', { src: 'gf:X9' }), S0('S-2', '甲', 'mzt', { src: 'js:J1' })], [R('js', 'mzt', 'J1', '甲'), R('mgf', 'mzt', 'G4', '甲')], { 甲: { src: 'mgf' } });
    t.sv.call('syncClock', { atoken: at });
    eq('改掛優先 aka 那筆', [t.by('S-2').src, t.by('S-1').src], ['mgf:G4', 'gf:X9']); }
}

console.log(`primary.test：${pass} 通過、${fail} 失敗`);
if (fail) process.exit(1);
