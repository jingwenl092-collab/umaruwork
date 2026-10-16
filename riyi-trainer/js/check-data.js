// 题库校验脚本（node 运行）：js/check-data.js
global.window = {};
require('./data-daily.js');
require('./data-travel.js');
require('./data-business.js');
require('./data-campus.js');
require('./data.js');

var S = window.SENTENCES;
var errs = [], warns = [];
var count = {}, seenJa = {}, seenZh = {};
var SCENES = ['daily', 'travel', 'business', 'campus'];

S.forEach(function (s, i) {
  var tag = '#' + (i + 1) + ' [' + s.scene + '/L' + s.level + ']';

  // 1. 分组计数
  var key = s.scene + '/' + s.level;
  count[key] = (count[key] || 0) + 1;
  if (SCENES.indexOf(s.scene) < 0) errs.push(tag + ' 未知场景 ' + s.scene);
  if ([1, 2, 3].indexOf(s.level) < 0) errs.push(tag + ' 未知难度 ' + s.level);

  // 2. 中日文本非空
  if (!s.zh || !s.zh.trim()) errs.push(tag + ' 中文为空');
  if (!s.ja || !s.ja.trim()) errs.push(tag + ' 日文为空');

  // 3. 日文必须含假名
  if (!/[\u3040-\u30ff]/.test(s.ja)) errs.push(tag + ' 日文无假名: ' + s.ja);

  // 4. 注音标记配对检查
  var open = (s.furi.match(/\{/g) || []).length;
  var close = (s.furi.match(/\}/g) || []).length;
  var bar = (s.furi.match(/\|/g) || []).length;
  if (open !== close || open !== bar) errs.push(tag + ' 注音标记不配对 {=' + open + ' }=' + close + ' |=' + bar);

  // 5. 去标记后应等于 ja，且无残留
  var stripped = s.furi.replace(/\{([^{}|]+)\|([^{}]+)\}/g, '$1');
  if (stripped !== s.ja) errs.push(tag + ' 去标记后与 ja 不一致\n    furi→ ' + stripped + '\n    ja  → ' + s.ja);
  if (/[{}|]/.test(stripped)) errs.push(tag + ' 去标记后有残留符号: ' + stripped);

  // 6. 注音里不得含汉字以外的怪东西（读音必须是纯假名）
  s.furi.replace(/\{([^{}|]+)\|([^{}]+)\}/g, function (_, w, r) {
    if (!/^[\u3040-\u30ff]+$/.test(r)) errs.push(tag + ' 读音不是纯假名: {' + w + '|' + r + '}');
    if (!/[\u4e00-\u9fff]/.test(w)) warns.push(tag + ' 注音对象不含汉字: {' + w + '|' + r + '}');
    return '';
  });

  // 7. 重复检查
  if (seenJa[s.ja]) errs.push(tag + ' 日文重复: ' + s.ja + '（与 #' + seenJa[s.ja] + '）');
  else seenJa[s.ja] = i + 1;
  if (seenZh[s.zh]) errs.push(tag + ' 中文重复: ' + s.zh);
  else seenZh[s.zh] = i + 1;

  // 8. 日常生活场景不得出现重敬语（用户反馈的整改项）
  if (s.scene === 'daily' && /させていただ|でござい|ございました|拝受|お伝えください|ご回答/.test(s.ja)) {
    errs.push(tag + ' 日常场景出现重敬语: ' + s.ja);
  }
});

// 9. 每组 20 句
SCENES.forEach(function (sc) {
  [1, 2, 3].forEach(function (lv) {
    var n = count[sc + '/' + lv] || 0;
    if (n !== 20) errs.push('分组 ' + sc + '/L' + lv + ' 句数=' + n + '（应为 20）');
  });
});

console.log('总句数: ' + S.length + (S.length === 240 ? ' ✓' : ' ✗ 应为 240'));
console.log('分组: ' + JSON.stringify(count));
console.log('错误 ' + errs.length + ' 条' + (errs.length ? '：' : ' ✓'));
errs.forEach(function (e) { console.log('  ✗ ' + e); });
console.log('提醒 ' + warns.length + ' 条');
warns.forEach(function (w) { console.log('  ⚠ ' + w); });
process.exit(errs.length ? 1 : 0);
