// 日译训练场 · 题库汇总器
// 句子来源：data-daily.js / data-travel.js / data-business.js / data-campus.js（须先于本文件加载）
// 注音标记格式：{汉字|读音}
//   归一化后每条句子得到：
//     ja  —— 去除标记的纯文本（用于朗读、AI 讲评、日→中方向的原文显示）
//     furi —— 带标记的原文（用于中→日方向参考译文的振假名渲染）
(function () {
  var raw = window.RAW_SENTENCES || [];
  var FURI_RE = /\{([^{}|]+)\|([^{}|]+)\}/g;

  window.SENTENCES = raw.map(function (s) {
    var plain = String(s.ja).replace(FURI_RE, '$1');
    return {
      scene: s.scene,
      level: s.level,
      zh: s.zh,
      ja: plain,      // 纯文本（无注音）
      furi: s.ja      // 原样保留，含 {汉字|读音} 标记
    };
  });
})();
