// 日译训练场 · 题库汇总器
// 句子来源：data-daily.js / data-travel.js / data-business.js / data-campus.js（须先于本文件加载）
// 阅读文章来源：data-reading.js（须先于本文件加载）
// 注音标记格式：{汉字|读音}
//   归一化后每条句子得到：
//     ja  —— 去除标记的纯文本（用于朗读、AI 讲评、日→中方向的原文显示）
//     furi —— 带标记的原文（用于中→日方向参考译文的振假名渲染）
(function () {
  var FURI_RE = /\{([^{}|]+)\|([^{}|]+)\}/g;

  // 去掉注音标记，得到纯文本（朗读与 AI 讲评用）
  function stripFuri(s) {
    return String(s == null ? '' : s).replace(FURI_RE, '$1');
  }
  window.stripFuri = stripFuri;

  // ---------- 翻译练习题库 ----------
  var raw = window.RAW_SENTENCES || [];
  window.SENTENCES = raw.map(function (s) {
    return {
      scene: s.scene,
      level: s.level,
      zh: s.zh,
      ja: stripFuri(s.ja),   // 纯文本（无注音）
      furi: s.ja             // 原样保留，含 {汉字|读音} 标记
    };
  });

  // ---------- 阅读文章 ----------
  // 每段与每个选项都同时保留「纯文本」和「带注音」两份：
  //   ja   —— 纯文本（朗读用）
  //   furi —— 带标记（振假名渲染用）
  var rawReading = window.RAW_READING || [];
  window.READING = rawReading.map(function (a) {
    return {
      id: a.id,
      cat: a.cat,
      level: a.level,
      zhTitle: a.zhTitle,
      jaTitle: stripFuri(a.jaTitle),
      jaTitleFuri: a.jaTitle,
      paras: (a.paras || []).map(function (p) {
        return { ja: stripFuri(p.ja), furi: p.ja, zh: p.zh || '' };
      }),
      questions: (a.questions || []).map(function (q) {
        return {
          q: q.q,
          options: (q.options || []).map(function (o) {
            return { ja: stripFuri(o), furi: o };
          }),
          answer: q.answer,
          explain: q.explain || ''
        };
      })
    };
  });

  // ---------- 偶像活动对话 ----------
  // 开场白与提示句同样保留两份：ja 纯文本（朗读/AI）、furi 带标记（振假名渲染）
  function normLine(o) {
    return { ja: stripFuri(o.ja), furi: o.ja, zh: o.zh || '' };
  }
  var rawTalk = window.RAW_TALK || { levels: {}, scenes: [] };
  window.TALK = {
    levels: rawTalk.levels || {},
    scenes: (rawTalk.scenes || []).map(function (s) {
      var openers = {};
      Object.keys(s.openers || {}).forEach(function (lv) {
        openers[lv] = (s.openers[lv] || []).map(normLine);
      });
      return {
        id: s.id,
        emoji: s.emoji || '💬',
        name: s.name,
        zhName: s.zhName || s.name,
        desc: s.desc || '',
        briefing: s.briefing || '',
        etiquette: s.etiquette || [],
        persona: s.persona || '',
        openers: openers,
        phrases: (s.phrases || []).map(normLine)
      };
    })
  };
})();
