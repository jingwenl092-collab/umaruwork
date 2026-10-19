// 数据校验脚本（node 运行）：node js/check-data.js
// 同时校验「翻译练习题库」与「阅读文章」
global.window = {};
require('./data-daily.js');
require('./data-travel.js');
require('./data-business.js');
require('./data-campus.js');
require('./data-reading.js');
require('./data-talk.js');
require('./data.js');

var FURI_RE = /\{([^{}|]+)\|([^{}|]+)\}/g;
var errs = [], warns = [];

// 通用的注音标记检查：配对、去标记一致性、读音是否纯假名
function checkFuri(text, tag, plain) {
  var open = (text.match(/\{/g) || []).length;
  var close = (text.match(/\}/g) || []).length;
  var bar = (text.match(/\|/g) || []).length;
  if (open !== close || open !== bar) {
    errs.push(tag + ' 注音标记不配对 {=' + open + ' }=' + close + ' |=' + bar);
  }
  var stripped = String(text).replace(FURI_RE, '$1');
  if (stripped !== plain) {
    errs.push(tag + ' 去标记后与纯文本不一致\n    furi→ ' + stripped + '\n    ja  → ' + plain);
  }
  if (/[{}|]/.test(stripped)) {
    errs.push(tag + ' 去标记后有残留符号: ' + stripped);
  }
  String(text).replace(FURI_RE, function (_, w, r) {
    if (!/^[\u3040-\u30ff]+$/.test(r)) errs.push(tag + ' 读音不是纯假名: {' + w + '|' + r + '}');
    if (!/[\u4e00-\u9fff]/.test(w)) warns.push(tag + ' 注音对象不含汉字: {' + w + '|' + r + '}');
    return '';
  });
}

// ============ 一、翻译练习题库 ============
var S = window.SENTENCES;
var count = {}, seenJa = {}, seenZh = {};
var SCENES = ['daily', 'travel', 'business', 'campus'];

S.forEach(function (s, i) {
  var tag = '#句' + (i + 1) + ' [' + s.scene + '/L' + s.level + ']';
  var key = s.scene + '/' + s.level;
  count[key] = (count[key] || 0) + 1;
  if (SCENES.indexOf(s.scene) < 0) errs.push(tag + ' 未知场景 ' + s.scene);
  if ([1, 2, 3].indexOf(s.level) < 0) errs.push(tag + ' 未知难度 ' + s.level);
  if (!s.zh || !s.zh.trim()) errs.push(tag + ' 中文为空');
  if (!s.ja || !s.ja.trim()) errs.push(tag + ' 日文为空');
  if (!/[\u3040-\u30ff]/.test(s.ja)) errs.push(tag + ' 日文无假名: ' + s.ja);
  checkFuri(s.furi, tag, s.ja);
  if (seenJa[s.ja]) errs.push(tag + ' 日文重复（与 #句' + seenJa[s.ja] + '）');
  else seenJa[s.ja] = i + 1;
  if (seenZh[s.zh]) errs.push(tag + ' 中文重复');
  else seenZh[s.zh] = i + 1;
  // 日常生活场景不得出现重敬语（用户反馈的整改项）
  if (s.scene === 'daily' && /させていただ|でござい|ございました|拝受|お伝えください|ご回答/.test(s.ja)) {
    errs.push(tag + ' 日常场景出现重敬语: ' + s.ja);
  }
});

SCENES.forEach(function (sc) {
  [1, 2, 3].forEach(function (lv) {
    var n = count[sc + '/' + lv] || 0;
    if (n !== 20) errs.push('分组 ' + sc + '/L' + lv + ' 句数=' + n + '（应为 20）');
  });
});

// ============ 二、阅读文章 ============
var R = window.READING || [];
var CATS = ['社会', '科学', '文化', '生活'];
var seenId = {};
var readCount = {};

R.forEach(function (a, i) {
  var tag = '@文' + (i + 1) + ' [' + a.id + ']';

  if (!a.id) errs.push(tag + ' 缺少 id');
  if (seenId[a.id]) errs.push(tag + ' id 重复: ' + a.id);
  else seenId[a.id] = i + 1;

  if (CATS.indexOf(a.cat) < 0) errs.push(tag + ' 未知分类: ' + a.cat);
  if ([1, 2, 3].indexOf(a.level) < 0) errs.push(tag + ' 未知难度: ' + a.level);
  readCount[a.level] = (readCount[a.level] || 0) + 1;

  // 标题
  if (!a.zhTitle || !a.zhTitle.trim()) errs.push(tag + ' 中文标题为空');
  if (!a.jaTitle || !a.jaTitle.trim()) errs.push(tag + ' 日文标题为空');
  if (!/[\u3040-\u30ff]/.test(a.jaTitle)) errs.push(tag + ' 日文标题无假名: ' + a.jaTitle);
  checkFuri(a.jaTitleFuri, tag + ' 标题', a.jaTitle);

  // 段落
  if (!a.paras.length) errs.push(tag + ' 没有正文段落');
  a.paras.forEach(function (p, pi) {
    var ptag = tag + ' 段' + (pi + 1);
    if (!p.ja || !p.ja.trim()) errs.push(ptag + ' 日文为空');
    if (!/[\u3040-\u30ff]/.test(p.ja)) errs.push(ptag + ' 日文无假名: ' + p.ja);
    if (!p.zh || !p.zh.trim()) errs.push(ptag + ' 中文对照为空');
    if (p.ja.length < 20) warns.push(ptag + ' 段落偏短（' + p.ja.length + '字）');
    checkFuri(p.furi, ptag, p.ja);
  });

  // 理解题
  if (a.questions.length < 2) errs.push(tag + ' 理解题少于 2 道');
  a.questions.forEach(function (q, qi) {
    var qtag = tag + ' 题' + (qi + 1);
    if (!q.q || !q.q.trim()) errs.push(qtag + ' 题干为空');
    if (!q.explain || !q.explain.trim()) errs.push(qtag + ' 缺少解析');
    if (q.options.length !== 4) errs.push(qtag + ' 选项不是 4 个（当前 ' + q.options.length + '）');
    if (typeof q.answer !== 'number' || q.answer < 0 || q.answer > 3) {
      errs.push(qtag + ' 答案下标非法: ' + q.answer);
    }
    // 选项不能重复
    var seenOpt = {};
    q.options.forEach(function (o, oi) {
      if (!o.ja || !o.ja.trim()) errs.push(qtag + ' 选项' + (oi + 1) + ' 为空');
      if (seenOpt[o.ja]) errs.push(qtag + ' 选项重复: ' + o.ja);
      else seenOpt[o.ja] = 1;
      checkFuri(o.furi, qtag + ' 选项' + (oi + 1), o.ja);
    });
  });
});

// ============ 三、偶像活动对话 ============
var T = window.TALK || { levels: {}, scenes: [] };
var seenScene = {};
// 角色设定为「虚构通用成员」，素材里不允许出现真实团体名/人名
var BANNED = /AKB|SKE|NMB|HKT|NGT|STU|=LOVE|イコラブ|指原|秋元|48グループ|乃木坂|櫻坂|日向坂|大西|姫奈|プロデューサー/;

[1, 2, 3].forEach(function (lv) {
  var info = T.levels[lv];
  if (!info) { errs.push('对话难度 L' + lv + ' 缺失'); return; }
  if (!info.name || !info.hint) errs.push('对话难度 L' + lv + ' 缺少 name/hint');
  if (!info.rule || info.rule.length < 10) errs.push('对话难度 L' + lv + ' 的 rule 过于简单');
});

if (T.scenes.length < 4) errs.push('对话场景只有 ' + T.scenes.length + ' 个（应为 4）');

T.scenes.forEach(function (s, i) {
  var tag = '§对话' + (i + 1) + ' [' + s.id + ']';
  if (!s.id) errs.push(tag + ' 缺少 id');
  if (seenScene[s.id]) errs.push(tag + ' id 重复: ' + s.id);
  else seenScene[s.id] = i + 1;
  if (!s.name || !s.zhName) errs.push(tag + ' 缺少场景名称');
  if (!s.desc || s.desc.length < 6) errs.push(tag + ' 一句话介绍过短');
  if (!s.briefing || s.briefing.length < 20) errs.push(tag + ' 情境说明过短');
  if (!s.persona || s.persona.length < 20) errs.push(tag + ' 角色设定（日文）过短');
  if ((s.etiquette || []).length < 3) errs.push(tag + ' 礼仪提示少于 3 条');
  if ((s.phrases || []).length < 4) errs.push(tag + ' 常用说法少于 4 句');

  [1, 2, 3].forEach(function (lv) {
    var ops = s.openers[lv] || [];
    if (ops.length < 2) errs.push(tag + ' 难度 L' + lv + ' 的开场白少于 2 句');
    ops.forEach(function (o, oi) {
      var otag = tag + ' L' + lv + ' 开场' + (oi + 1);
      if (!o.ja || !o.zh) errs.push(otag + ' 日文或中文为空');
      if (!/[\u3040-\u30ff]/.test(o.ja)) errs.push(otag + ' 日文无假名');
      if (BANNED.test(o.ja)) errs.push(otag + ' 出现真实团体/人名');
      checkFuri(o.furi, otag, o.ja);
    });
  });

  (s.phrases || []).forEach(function (p, pi) {
    var ptag = tag + ' 说法' + (pi + 1);
    if (!p.ja || !p.zh) errs.push(ptag + ' 日文或中文为空');
    if (!/[\u3040-\u30ff]/.test(p.ja)) errs.push(ptag + ' 日文无假名');
    if (BANNED.test(p.ja) || BANNED.test(p.zh)) errs.push(ptag + ' 出现真实团体/人名');
    checkFuri(p.furi, ptag, p.ja);
  });
});

// ============ 输出 ============
console.log('【翻译题库】总句数: ' + S.length + (S.length === 240 ? ' ✓' : ' ✗ 应为 240'));
console.log('  分组: ' + JSON.stringify(count));
console.log('【阅读文章】总篇数: ' + R.length + (R.length >= 6 ? ' ✓' : ' ✗ 偏少'));
console.log('  按难度: ' + JSON.stringify(readCount));
console.log('【偶像对话】场景 ' + T.scenes.length + ' 个' +
  (T.scenes.length >= 4 ? ' ✓' : ' ✗') + '，难度 ' + Object.keys(T.levels).length + ' 档');
console.log('  场景: ' + T.scenes.map(function (s) {
  return s.id + '(' + s.phrases.length + ' 说法)';
}).join(' · '));
console.log('错误 ' + errs.length + ' 条' + (errs.length ? '：' : ' ✓'));
errs.forEach(function (e) { console.log('  ✗ ' + e); });
console.log('提醒 ' + warns.length + ' 条');
warns.forEach(function (w) { console.log('  ⚠ ' + w); });
process.exit(errs.length ? 1 : 0);
