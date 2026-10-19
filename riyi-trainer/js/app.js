// 日译训练场 · 应用逻辑（固定题库 + 盲听同传模式 + 纯文本相似度对比）
(function () {
  'use strict';

  var ROUND_SIZE = 10;
  var LOG_KEY = 'riyi_log_v1';
  var SCENES = { daily: '日常生活', travel: '旅行', business: '商务', campus: '校园' };
  var LEVELS = { 1: '初级', 2: '中级', 3: '高级' };
  var LEVEL_LIMIT_SEC = { 1: 12, 2: 16, 3: 20 };

  var state = {
    dir: 'zh2ja',
    trainMode: 'interp', // 'interp' 盲听同传 | 'sight' 常规看句
    level: 2,
    scene: 'daily',
    queue: [],
    idx: 0,
    results: [],
    startedAt: 0,
    mode: 'voice',
    recognizing: false,
    recognition: null,
    current: null,
    masked: false,
    timerId: null,
    remainSec: 0
  };

  // ---------- 工具 ----------
  function $(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  // 把题库的 {汉字|读音} 标记转成 <ruby>振假名</ruby>
  function furiToHtml(s) {
    if (!s) return '';
    return esc(s).replace(/\{([^{}|]+)\|([^{}|]+)\}/g, function (_, w, r) {
      return '<ruby>' + w + '<rt>' + r + '</rt></ruby>';
    });
  }
  function show(el) { if (el) el.classList.remove('hidden'); }
  function hide(el) { if (el) el.classList.add('hidden'); }
  function pad(n) { return (n < 10 ? '0' : '') + n; }
  function shuffle(arr) {
    for (var i = arr.length - 1; i > 0; i--) {
      var j = Math.floor(Math.random() * (i + 1));
      var t = arr[i]; arr[i] = arr[j]; arr[j] = t;
    }
    return arr;
  }
  function fmtDur(sec) {
    if (sec < 60) return sec + ' 秒';
    return Math.round(sec / 60) + ' 分钟';
  }
  function fmtDate(ts) {
    var d = new Date(ts);
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
  }
  function dayKey(ts) {
    var d = new Date(ts);
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  }

  // ---------- 纯文本相似度与字面差异比对 ----------
  var PUNC_RE = /[，。！？、；：“”‘’（）《》【】「」『』・…—\s,.!?;:'"()\[\]\-]/g;
  // 单字符判定专用：不能带 /g，否则 lastIndex 会在多次 test() 之间残留，
  // 导致同一个标点被交替判成「标点 / 非标点」，打乱命中高亮的对齐
  var PUNC_ONE = /^[，。！？、；：“”‘’（）《》【】「」『』・…—\s,.!?;:'"()\[\]\-]$/;
  function cleanStr(s) {
    return String(s || '').replace(PUNC_RE, '');
  }

  // 基于最长公共子序列（LCS）的字符级 Diff 与重合度计算
  function compareTexts(userRaw, refRaw) {
    var u = Array.from(cleanStr(userRaw));
    var r = Array.from(cleanStr(refRaw));
    var m = u.length, n = r.length;

    var dp = [];
    for (var i = 0; i <= m; i++) {
      dp[i] = new Array(n + 1).fill(0);
    }
    for (var i = 1; i <= m; i++) {
      for (var j = 1; j <= n; j++) {
        if (u[i - 1] === r[j - 1]) dp[i][j] = dp[i - 1][j - 1] + 1;
        else dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
      }
    }

    var lcs = dp[m][n];
    var score = (m === 0 && n === 0) ? 100 : (n === 0 ? 0 : Math.round((2 * lcs) / (m + n) * 100));

    // 回溯标记命中位置
    var uHit = new Array(m).fill(false);
    var rHit = new Array(n).fill(false);
    var x = m, y = n;
    while (x > 0 && y > 0) {
      if (u[x - 1] === r[y - 1]) {
        uHit[x - 1] = true;
        rHit[y - 1] = true;
        x--; y--;
      } else if (dp[x - 1][y] >= dp[x][y - 1]) {
        x--;
      } else {
        y--;
      }
    }

    // 把命中标记映射回带标点的原串
    function renderHighlighted(rawStr, hitArr) {
      var chars = Array.from(String(rawStr || ''));
      var idx = 0;
      return chars.map(function (ch) {
        if (PUNC_ONE.test(ch)) return esc(ch);
        var hit = hitArr[idx++];
        return hit
          ? '<span class="diff-hit">' + esc(ch) + '</span>'
          : '<span class="diff-miss">' + esc(ch) + '</span>';
      }).join('');
    }

    var verdict = '';
    if (score >= 85) verdict = '非常地道！核心表达与参考译文高度一致。';
    else if (score >= 60) verdict = '大意已传达，部分词句或语序可对照参考译文精进。';
    else if (score >= 35) verdict = '抓住了部分关键词，建议多听几遍参考译文跟读模仿。';
    else verdict = '与参考译文差异较大，不妨对照下方标红处复盘句型。';

    return {
      score: score,
      verdict: verdict,
      userHtml: renderHighlighted(userRaw, uHit),
      refDiffHtml: renderHighlighted(refRaw, rHit)
    };
  }

  // ---------- 云端 AI 讲评（keyless 云 LLM） ----------
  var cloud = null;
  var cachedModel = null;
  var cloudError = null;
  var aiToken = 0;      // 自增令牌：用于丢弃「已经翻页但才返回」的过期讲评
  var aiLastCall = null;

  function initCloud() {
    if (!window.WorkBuddyCloud || !window.PUBLIC_CONFIG) {
      cloudError = 'AI 服务未能加载，请检查网络后刷新页面。';
      return;
    }
    try {
      cloud = window.WorkBuddyCloud.createWorkBuddyCloud({
        endpoint: window.PUBLIC_CONFIG.endpoint,
        oauthRelayBaseUrl: window.PUBLIC_CONFIG.oauthRelayBaseUrl,
        publishableKey: window.PUBLIC_CONFIG.publishableKey
      });
    } catch (e) {
      cloudError = (e && e.message) ? e.message : 'AI 服务初始化失败。';
    }
  }

  var SYSTEM_PROMPT = '你是资深中日翻译教练，正在一对一指导学员练句子翻译。学员作答可能来自语音识别，若有同音错字请按其本意宽容评价。输出必须是且仅是一个 JSON 对象，不要打分，不要多余文字。长度限制：verdict 为一句话总评，不超过20字；highlights 为做得好的点，1-2条，每条不超过25字；suggestions 为改进建议，1-2条，每条不超过40字且必须写出更地道的正确说法。格式：{"verdict":"","highlights":[],"suggestions":[]}';

  // 把 SDK 抛出的错误码翻译成人话
  function friendlyLLMError(error) {
    var code = (error && error.error && error.error.code) || (error && error.code) || '';
    code = String(code);
    if (code === 'model_empty') return '当前环境暂无可用模型，请稍后再试。';
    if (code === 'sdk_missing') return 'AI 服务未能加载，请检查网络后刷新页面。';
    if (code.indexOf('quota_') === 0) return 'AI 讲评用量已达上限，请稍后再试。';
    if (code.indexOf('auth_') === 0) return '云服务校验失败，请在已发布的页面中使用（本地打开会校验失败）。';
    if (code.indexOf('request_') === 0) return '请求参数异常，请刷新页面重试。';
    if (code.indexOf('gateway_') === 0 || code.indexOf('model_') === 0) return 'AI 服务暂时不可用，请点击重试。';
    return '讲评失败，请稍后重试。';
  }

  // 讲评要快：优先响应最快的模型，其次保证可用。
  // 注意：直接取列表第一个会落到思考型模型（单次约 110 秒），必须显式挑选。
  var FAST_MODELS = ['deepseek-v4-flash', 'hunyuan-chat', 'default'];

  async function getModel() {
    if (cachedModel) return cachedModel;
    if (!cloud) { var e = new Error('sdk missing'); e.code = 'sdk_missing'; throw e; }
    var list = await cloud.llm.models.list();
    var enabled = [];
    for (var i = 0; i < list.length; i++) {
      if (list[i] && list[i].disabled !== true) enabled.push(list[i]);
    }
    if (!enabled.length) { var err = new Error('no model'); err.code = 'model_empty'; throw err; }

    var pick = null;
    for (var k = 0; k < FAST_MODELS.length; k++) {
      for (var n = 0; n < enabled.length; n++) {
        if (enabled[n].id === FAST_MODELS[k]) { pick = enabled[n]; break; }
      }
      if (pick) break;
    }
    if (!pick) {
      for (var p = 0; p < enabled.length; p++) {
        if (enabled[p].supportsReasoning !== true) { pick = enabled[p]; break; }
      }
    }
    if (!pick) pick = enabled[0];
    cachedModel = pick;
    return pick;
  }

  // 云端仅支持流式调用，必须 stream:true 并用 for await 逐块拼接
  async function getFeedback(dir, source, reference, userText) {
    var model = await getModel();
    var dirText = dir === 'zh2ja'
      ? '中译日（把中文原句译成日语）'
      : '日译中（把日语原句译成中文）';
    var userContent = '练习方向：' + dirText +
      '\n原句：' + source +
      '\n参考译文：' + reference +
      '\n学员的翻译（可能来自语音识别转写）：' + userText +
      '\n请按要求输出 JSON 讲评。';

    var answer = '';
    for await (var chunk of cloud.llm.chat.completions.create({
      model: model.id,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: userContent }
      ],
      stream: true,
      temperature: 0.5
    })) {
      var delta = chunk.choices && chunk.choices[0] && chunk.choices[0].delta;
      if (delta && delta.content) answer += delta.content;
    }
    return parseFeedback(answer);
  }

  function parseFeedback(text) {
    var t = String(text || '').trim();
    // 兼容部分模型输出 ```json ... ``` 围栏的情况
    var m = t.match(/\{[\s\S]*\}/);
    var obj = null;
    if (m) { try { obj = JSON.parse(m[0]); } catch (e) { obj = null; } }
    if (!obj && t) obj = { verdict: t, highlights: [], suggestions: [] };
    if (!obj) { var err = new Error('empty'); err.code = 'empty_answer'; throw err; }
    if (!Array.isArray(obj.highlights)) obj.highlights = obj.highlights ? [String(obj.highlights)] : [];
    if (!Array.isArray(obj.suggestions)) obj.suggestions = obj.suggestions ? [String(obj.suggestions)] : [];
    return obj;
  }

  function setAIState(which) {
    ['aiLoading', 'aiError', 'aiContent'].forEach(function (id) {
      var el = $(id);
      if (el) el.classList.toggle('hidden', id !== which);
    });
  }

  function renderAIContent(f) {
    var html = '<div class="ai-verdict">' + esc(f.verdict || '已完成这句的讲评。') + '</div>';
    if (f.highlights && f.highlights.length) {
      html += '<div class="fb-sec"><div class="fb-sec-t good">做得好</div>' +
        f.highlights.map(function (h) { return '<div class="fb-li good">' + esc(h) + '</div>'; }).join('') +
        '</div>';
    }
    if (f.suggestions && f.suggestions.length) {
      html += '<div class="fb-sec"><div class="fb-sec-t sug">可以更好</div>' +
        f.suggestions.map(function (x) { return '<div class="fb-li sug">' + esc(x) + '</div>'; }).join('') +
        '</div>';
    }
    return html;
  }

  async function requestAIFeedback(call) {
    aiLastCall = call;
    var token = ++aiToken;
    setAIState('aiLoading');
    try {
      var f = await getFeedback(call.dir, call.source, call.reference, call.userText);
      if (token !== aiToken) return;   // 用户已翻到下一句，结果作废
      $('aiContent').innerHTML = renderAIContent(f);
      setAIState('aiContent');
      // 讲评结果并入本轮记录，报告页与历史页可回看
      var item = state.results[state.results.length - 1];
      if (item) {
        item.aiVerdict = f.verdict || '';
        item.aiHighlights = f.highlights || [];
        item.aiSuggestions = f.suggestions || [];
      }
    } catch (e) {
      if (token !== aiToken) return;
      $('aiErrText').textContent = (cloudError && !cloud) ? cloudError : friendlyLLMError(e);
      setAIState('aiError');
    }
  }

  // ---------- 视图切换 ----------
  var views = {
    home: $('view-home'), practice: $('view-practice'),
    report: $('view-report'), history: $('view-history'),
    reading: $('view-reading'), talk: $('view-talk')
  };
  function go(name) {
    aiToken++;   // 切换页面后，尚未返回的讲评一律作废
    stopTimer();
    stopRec();
    stopTalkRec();
    if ('speechSynthesis' in window) {
      try { window.speechSynthesis.cancel(); } catch (e) {}
    }
    Object.keys(views).forEach(function (k) {
      views[k].classList.toggle('hidden', k !== name);
    });
    window.scrollTo(0, 0);
  }

  // ---------- 语音朗读 ----------
  var speechVoices = [];
  var speechReady = false;

  function refreshVoices() {
    if (!('speechSynthesis' in window)) return [];
    try {
      var vs = window.speechSynthesis.getVoices();
      if (vs && vs.length) {
        speechVoices = vs;
        speechReady = true;
      }
    } catch (e) {}
    return speechVoices;
  }

  if ('speechSynthesis' in window) {
    refreshVoices();
    try {
      window.speechSynthesis.addEventListener('voiceschanged', refreshVoices);
    } catch (e) {}
    var voiceTries = 0;
    var voiceTimer = setInterval(function () {
      refreshVoices();
      if (speechReady || ++voiceTries >= 10) clearInterval(voiceTimer);
    }, 300);
  }

  // 选语音。优先级：本地精确 > 网络精确 > 本地同语种 > 网络同语种。
  // 浏览器自带的「网络语音」（Chrome 的 Google 日本語、Edge 的 Microsoft 在线自然语音）不用装系统语音包，
  // 但要联网——很多人「以前没装语音包也有声音」就是靠它，所以不能把它排除掉
  function pickVoice(lang) {
    refreshVoices();
    if (!speechVoices.length) return null;
    var want = String(lang || '').toLowerCase();
    var head = want.split('-')[0];
    var i, v, l, localExact = null, exact = null, localLoose = null, loose = null;
    for (i = 0; i < speechVoices.length; i++) {
      v = speechVoices[i];
      l = String(v.lang || '').toLowerCase().replace('_', '-');
      if (l === want) {
        if (!exact) exact = v;
        if (v.localService !== false && !localExact) localExact = v;
      } else if (l.indexOf(head) === 0) {
        if (!loose) loose = v;
        if (v.localService !== false && !localLoose) localLoose = v;
      }
    }
    return localExact || exact || localLoose || loose;
  }

  function clearSpeechHint() {
    ['speechHint', 'srcSpeechHint', 'readSpeechHint', 'talkSpeechHint'].forEach(function (id) {
      var el = $(id);
      if (el) { el.textContent = ''; hide(el); }
    });
  }

  // kind: 不传=通用排查；'novoice'=根本没找到对应语种的语音；'remote'=用的是浏览器网络语音
  function showSpeechHint(lang, targetId, kind) {
    var el = $(targetId || 'speechHint');
    if (!el) return;
    var isJa = String(lang || '').toLowerCase().indexOf('ja') === 0;
    var txt;
    if (kind === 'novoice') {
      txt = isJa
        ? '这台设备没有日语语音，刚才用浏览器默认语音读出声了，发音可能不准。想要地道发音：Windows 设置 → 时间和语言 → 语言和区域 → 日语 → 选项 → 下载「文本转语音」（约 25MB），装完彻底退出浏览器再打开。'
        : '这台设备没有中文语音，刚才用浏览器默认语音读出声了。请在系统语言设置里安装中文语音包。';
    } else if (kind === 'remote') {
      txt = '没出声。当前用的是浏览器的网络语音（Chrome 的 Google 日本語 / Edge 的在线自然语音），它需要联网——' +
        '请确认网络可用、没有被代理或防火墙拦掉，然后刷新页面重试；想彻底不依赖网络就安装日语语音包。';
    } else {
      txt = (isJa
        ? '听不到声音？这台设备可能缺少日语语音包。Windows：设置 → 时间和语言 → 语言和区域 → 添加语言「日本語」并勾选「语音」；'
        : '听不到声音？请在系统语言设置里安装中文语音包；') +
        '若语音包已装好仍无声，多半是浏览器语音引擎被卡住了——先刷新页面，再检查系统音量、输出设备与 Chrome 的站点声音权限，或换 Chrome / Edge 再试。';
    }
    el.textContent = txt;
    show(el);
  }

  function setSpeakLabel(btn, on) {
    if (!btn) return;
    if (on) {
      if (!btn.dataset.idle) btn.dataset.idle = btn.textContent;
      btn.textContent = '▷ 朗读中…';
    } else if (btn.dataset.idle) {
      btn.textContent = btn.dataset.idle;
    }
  }

  // 静默失败看门狗：Chrome 常见「speak() 既不发声也不报错」，
  // 只靠 onerror 抓不到，必须自己盯 onstart 有没有来
  var TTS_WATCH_MS = 1200;
  var TTS_RETRY_GAP = 260;

  // retry=true 表示第二次尝试：不再指定 voice，交给浏览器自己挑默认语音
  function doSpeak(text, lang, btn, onDone, hintId, retry) {
    var synth = window.speechSynthesis;
    var u = new SpeechSynthesisUtterance(text);
    u.lang = lang;
    u.rate = 0.95;
    u.pitch = 1;
    u.volume = 1;

    var v = pickVoice(lang);
    if (v && !retry) u.voice = v;
    var remote = !!(v && v.localService === false);

    // 一个对应语种的语音都没有时，不再闷声放弃：不指定 voice 交给浏览器默认语音，
    // 至少让用户听到东西，同时说清楚发音可能不准
    if (!retry && speechVoices.length && !v) showSpeechHint(lang, hintId, 'novoice');

    var started = false;
    var finished = false;
    var watch = null;

    function finishOnce() {
      if (finished) return;
      finished = true;
      if (watch) clearTimeout(watch);
      setSpeakLabel(btn, false);
      if (onDone) onDone();
    }

    // 卡住或报错时：先取消再重试一次（换默认语音）。
    // 「静默失败」要立刻把提示摆出来，别让用户对着按钮干等
    function fallback(reason) {
      if (finished || started) return;
      if (watch) clearTimeout(watch);
      if (reason === 'silent') showSpeechHint(lang, hintId, remote ? 'remote' : null);
      if (retry) {
        showSpeechHint(lang, hintId, remote ? 'remote' : null);
        finishOnce();
        return;
      }
      try { synth.cancel(); } catch (err) {}
      setTimeout(function () {
        if (finished) return;
        doSpeak(text, lang, btn, onDone, hintId, true);
      }, TTS_RETRY_GAP);
    }

    u.onstart = function () { started = true; setSpeakLabel(btn, true); };
    u.onend = finishOnce;
    u.onerror = function () { fallback('error'); };

    watch = setTimeout(function () {
      if (started || finished) return;
      if (!synth.speaking && !synth.pending) fallback('silent');
    }, TTS_WATCH_MS);

    try { synth.resume(); } catch (err) {}
    try { synth.speak(u); } catch (err) {
      showSpeechHint(lang, hintId);
      finishOnce();
      return;
    }
    // Chrome 已知问题：resume() 在 speak() 之后还要再调一次，队列才会启动
    setTimeout(function () {
      try { if (synth.paused) synth.resume(); } catch (err) {}
    }, 80);
  }

  function speak(text, lang, btn, onDone, hintId) {
    if (!('speechSynthesis' in window) || !text) {
      if (onDone) onDone();
      return;
    }
    clearSpeechHint();
    var synth = window.speechSynthesis;
    try {
      if (synth.speaking || synth.pending) {
        synth.cancel();
        // 取消后要等引擎真正清空再 speak，否则 Chrome 会把新的一条吞掉
        setTimeout(function () { doSpeak(text, lang, btn, onDone, hintId); }, TTS_RETRY_GAP);
      } else {
        doSpeak(text, lang, btn, onDone, hintId);
      }
    } catch (e) {
      showSpeechHint(lang, hintId);
      if (onDone) onDone();
    }
  }

  // 朗读自检：把「为什么没声音」直接摆在页面上，省得用户瞎猜
  function ttsSelfCheck(targetId) {
    var out = $(targetId || 'ttsResult');
    if (!out) return;
    show(out);

    if (!('speechSynthesis' in window)) {
      out.textContent = '❌ 这个浏览器不支持语音合成，请改用 Chrome 或 Edge。';
      return;
    }
    refreshVoices();
    var ja = pickVoice('ja-JP');
    var zh = pickVoice('zh-CN');
    function vDesc(v) {
      if (!v) return '未找到';
      return v.name + (v.localService === false ? '（网络语音，需联网）' : '（本地）');
    }
    var info = '可用语音 ' + speechVoices.length + ' 个' +
      '；日语：' + vDesc(ja) + '；中文：' + vDesc(zh);

    var synth = window.speechSynthesis;
    try { synth.cancel(); } catch (e) {}
    out.textContent = '🔊 正在试听「こんにちは」…（' + info + '）';

    var settled = false;
    var u = new SpeechSynthesisUtterance('こんにちは');
    u.lang = 'ja-JP';
    u.volume = 1;
    if (ja) u.voice = ja;

    var timer = setTimeout(function () {
      if (settled) return;
      settled = true;
      out.textContent = '⚠️ ' + info + '。试听 2 秒内没有开始发声——浏览器语音引擎可能被卡住了：' +
        '先刷新页面再试；仍不行请检查系统音量与默认输出设备、Chrome 的站点声音是否被静音，或换 Chrome / Edge。';
    }, 2000);

    u.onstart = function () {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      out.textContent = '✅ 已经发声，朗读正常。' + info + '。';
    };
    u.onerror = function () {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      out.textContent = '❌ 发声失败。' + info + '。请检查系统是否安装日语语音包（Windows：设置 → 时间和语言 → 语言和区域 → 添加「日本語」并勾选语音）。';
    };

    setTimeout(function () {
      try { synth.resume(); } catch (e) {}
      try { synth.speak(u); } catch (e) {}
      setTimeout(function () { try { if (synth.paused) synth.resume(); } catch (e) {} }, 80);
    }, 150);
  }

  // ---------- 限时反应倒计时 ----------
  function stopTimer() {
    if (state.timerId) {
      clearInterval(state.timerId);
      state.timerId = null;
    }
    hide($('timerBadge'));
    $('timerBadge').classList.remove('urgent');
  }

  function startCountdown() {
    stopTimer();
    state.remainSec = LEVEL_LIMIT_SEC[state.level] || 15;
    $('timerSec').textContent = state.remainSec;
    show($('timerBadge'));

    state.timerId = setInterval(function () {
      state.remainSec--;
      $('timerSec').textContent = Math.max(0, state.remainSec);
      if (state.remainSec <= 5) $('timerBadge').classList.add('urgent');
      if (state.remainSec <= 0) {
        stopTimer();
        // 倒计时结束：如果已有识别或输入内容则自动提交，否则提示超时并揭晓原句
        if ($('answerInput').value.trim()) {
          submitCurrent();
        } else {
          setMask(false);
          $('micHint').textContent = '⏱ 限时已到！原句已揭晓，请继续作答后提交';
        }
      }
    }, 1000);
  }

  function setMask(masked) {
    state.masked = masked;
    $('srcText').classList.toggle('masked', masked);
    if (state.trainMode === 'interp') {
      show($('peekBtn'));
      $('peekBtn').textContent = masked ? '👁 显示原句' : '🙈 隐藏原句';
    } else {
      hide($('peekBtn'));
    }
  }

  // ---------- 练习流程 ----------
  function currentSrc(s) { return state.dir === 'zh2ja' ? s.zh : s.ja; }
  function currentRef(s) { return state.dir === 'zh2ja' ? s.ja : s.zh; }

  function startPractice() {
    var pool = (window.SENTENCES || []).filter(function (s) {
      return s.scene === state.scene && s.level === state.level;
    });
    if (!pool.length) { alert('该场景与难度下暂无素材'); return; }
    state.queue = shuffle(pool.slice()).slice(0, ROUND_SIZE);
    state.idx = 0;
    state.results = [];
    state.startedAt = Date.now();
    go('practice');
    renderSentence();
  }

  function renderSentence() {
    aiToken++;   // 进入下一句后，上一句尚未返回的讲评一律作废
    stopTimer();
    stopRec();
    state.current = state.queue[state.idx];
    var s = state.current;
    var modeText = state.trainMode === 'interp' ? '🎧 盲听同传' : '📖 常规看句';
    $('practiceMeta').textContent = (state.dir === 'zh2ja' ? '中 → 日' : '日 → 中') +
      ' · ' + modeText + ' · ' + LEVELS[state.level] + ' · ' + SCENES[state.scene];
    $('practiceCount').textContent = '第 ' + (state.idx + 1) + ' / ' + state.queue.length + ' 句';
    $('progressBar').style.width = (state.idx / state.queue.length * 100) + '%';

    // 日→中方向：日文原句带振假名渲染；中→日方向：显示中文
    $('srcText').innerHTML = state.dir === 'ja2zh' ? furiToHtml(s.furi) : esc(s.zh);
    show($('speakBtn'));

    var input = $('answerInput');
    input.value = '';
    input.readOnly = false;
    $('submitBtn').disabled = true;
    hide($('feedbackCard'));
    show($('inputCard'));
    clearSpeechHint();
    applyMode();

    var srcLang = state.dir === 'zh2ja' ? 'zh-CN' : 'ja-JP';
    if (state.trainMode === 'interp') {
      $('srcLabel').textContent = '盲听原句（已模糊隐藏，点击可偷看） · 听完请立即开口翻译';
      setMask(true);
      $('micHint').textContent = '正在朗读原句，读完将自动开启麦克风与限时倒计时…';
      speak(currentSrc(s), srcLang, $('speakBtn'), function () {
        // 仅当用户还停留在当前句的输入状态时，自动开启倒计时和收音
        if (!$('inputCard').classList.contains('hidden')) {
          startCountdown();
          if (state.mode === 'voice' && voiceSupported) {
            startRec();
          }
        }
      }, 'srcSpeechHint');
    } else {
      $('srcLabel').textContent = state.dir === 'zh2ja' ? '原句 · 请翻译成日语' : '原句 · 请翻译成中文';
      setMask(false);
    }
  }

  // ---------- 输入模式与语音识别 ----------
  var SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  var voiceSupported = !!SR;

  function applyMode() {
    if (!voiceSupported) state.mode = 'type';
    if (state.mode === 'voice' && voiceSupported) {
      show($('micArea'));
      $('modeBtn').textContent = '切换打字输入';
      $('micHint').textContent = '点击开始口译，说完自动结束';
    } else {
      hide($('micArea'));
    }
  }

  function syncSubmit() {
    $('submitBtn').disabled = !$('answerInput').value.trim();
  }

  function stopRec() {
    if (state.recognizing && state.recognition) {
      try { state.recognition.stop(); } catch (e) {}
    }
    state.recognizing = false;
    if ($('micBtn')) $('micBtn').classList.remove('recording');
  }

  function startRec() {
    if (!voiceSupported || state.recognizing) return;
    var lang = state.dir === 'zh2ja' ? 'ja-JP' : 'zh-CN';
    var rec = new SR();
    rec.lang = lang;
    rec.interimResults = true;
    rec.continuous = false;
    rec.maxAlternatives = 1;
    var baseLen = $('answerInput').value.length;

    rec.onresult = function (e) {
      var txt = '';
      for (var i = 0; i < e.results.length; i++) txt += e.results[i][0].transcript;
      var cur = $('answerInput').value;
      $('answerInput').value = cur.slice(0, baseLen) + txt;
      syncSubmit();
    };
    rec.onerror = function (e) {
      state.recognizing = false;
      $('micBtn').classList.remove('recording');
      var msg = '识别出错，请重试或改用打字输入。';
      if (e.error === 'not-allowed' || e.error === 'service-not-allowed') msg = '麦克风权限被拒绝，请在浏览器地址栏允许麦克风。';
      else if (e.error === 'no-speech') msg = '没有听到声音，请再点麦克风试一次。';
      $('micHint').textContent = msg;
    };
    rec.onend = function () {
      state.recognizing = false;
      $('micBtn').classList.remove('recording');
      $('micHint').textContent = '点击麦克风可继续补充口译，或直接提交';
    };

    try {
      rec.start();
    } catch (e) { return; }
    state.recognizing = true;
    state.recognition = rec;
    $('micBtn').classList.add('recording');
    $('micHint').textContent = '🔴 正在听……请直接开口翻译（说完自动停止）';
  }

  // ---------- 提交与本地即时对比 ----------
  function submitCurrent() {
    var userText = $('answerInput').value.trim();
    if (!userText) return;
    stopTimer();
    stopRec();
    setMask(false); // 提交后自动揭晓原句

    var s = state.current;
    var call = {
      dir: state.dir,
      source: currentSrc(s),
      srcFuri: state.dir === 'ja2zh' ? s.furi : null,
      reference: currentRef(s),
      refFuri: s.furi,
      userText: userText
    };
    state.lastCall = call;
    $('answerInput').readOnly = true;
    $('submitBtn').disabled = true;

    var diff = compareTexts(call.userText, call.reference);
    renderFeedback(diff, call);

    // 本地比对先立刻呈现，AI 讲评在后台补上（失败也不影响本地结果）
    requestAIFeedback(call);
  }

  function renderFeedback(diff, call) {
    var badgeText = '重合度 ' + diff.score + '%';
    state.results.push({
      src: call.source,
      srcFuri: call.srcFuri,
      ref: call.reference,
      refFuri: call.refFuri,
      user: call.userText,
      score: diff.score,
      verdict: badgeText + ' · ' + diff.verdict
    });

    hide($('inputCard'));
    $('fbBadge').textContent = badgeText;
    $('fbVerdict').textContent = diff.verdict;

    var html = '<div class="fb-sec"><div class="fb-sec-t">你的翻译（绿底=命中字词，红底波浪线=差异字词）</div>' +
      '<div class="fb-user">' + diff.userHtml + '</div></div>';
    $('fbBody').innerHTML = html;

    // 中→日方向：参考译文用振假名渲染 + 下方附带字面命中标注
    if (call.dir === 'zh2ja' && call.refFuri) {
      $('refText').innerHTML = furiToHtml(call.refFuri);
      $('refDiff').innerHTML = '字面命中比对：' + diff.refDiffHtml;
      show($('refDiff'));
    } else {
      $('refText').innerHTML = diff.refDiffHtml;
      hide($('refDiff'));
    }

    show($('feedbackCard'));
    $('nextBtn').textContent = state.idx + 1 >= state.queue.length ? '查看本轮回顾' : '下一句';
  }

  function finishRound() {
    var rec = {
      id: Date.now(), ts: Date.now(),
      dir: state.dir, trainMode: state.trainMode, scene: state.scene, level: state.level,
      count: state.results.length,
      durSec: Math.max(1, Math.round((Date.now() - state.startedAt) / 1000)),
      items: state.results
    };
    appendRound(rec);
    renderReport(rec);
  }

  // 一条练习记录的 AI 讲评片段（没有讲评则返回空串）
  function aiHTML(it) {
    var v = it.aiVerdict || '';
    var g = it.aiHighlights || [];
    var s = it.aiSuggestions || [];
    if (!v && !g.length && !s.length) return '';
    var h = '<div class="rpt-row ai"><span>AI 讲评</span>';
    if (v) h += '<p class="ai-v">' + esc(v) + '</p>';
    g.forEach(function (x) { h += '<p class="ai-g">✓ ' + esc(x) + '</p>'; });
    s.forEach(function (x) { h += '<p class="ai-s">→ ' + esc(x) + '</p>'; });
    h += '</div>';
    return h;
  }

  // ---------- 报告页 ----------
  function renderReport(rec) {
    var modeText = rec.trainMode === 'interp' ? '盲听同传' : '常规看句';
    $('reportMeta').textContent = (rec.dir === 'zh2ja' ? '中 → 日' : '日 → 中') +
      ' · ' + modeText + ' · ' + LEVELS[rec.level] + ' · ' + SCENES[rec.scene] +
      ' · ' + rec.count + ' 句 · 用时 ' + fmtDur(rec.durSec);
    var html = '';
    rec.items.forEach(function (it, i) {
      var srcHtml = (rec.dir === 'ja2zh' && it.srcFuri) ? furiToHtml(it.srcFuri) : esc(it.src);
      var refHtml = (rec.dir === 'zh2ja' && it.refFuri) ? furiToHtml(it.refFuri) : esc(it.ref);
      html += '<div class="rpt-item card open">' +
        '<div class="rpt-head">' +
        '<span class="rpt-idx">第 ' + (i + 1) + ' 句</span>' +
        '<span class="rpt-src">' + srcHtml + '</span>' +
        '<span class="rpt-badge">' + esc(it.verdict) + '</span>' +
        '</div><div class="rpt-body">' +
        '<div class="rpt-row"><span>你的翻译</span><p>' + esc(it.user) + '</p></div>' +
        '<div class="rpt-row ref"><span>参考译文</span><p>' + refHtml + '</p></div>' +
        aiHTML(it) +
        '</div></div>';
    });
    $('reportList').innerHTML = html;
    go('report');
  }

  function bindExpand(listId) {
    $(listId).addEventListener('click', function (e) {
      var head = e.target.closest ? e.target.closest('.rpt-head') : null;
      if (!head) return;
      head.parentElement.classList.toggle('open');
    });
  }

  // ---------- 阅读模块 ----------
  var READ = {
    cat: 'all', lv: 0,
    current: null,
    showZh: false,
    answers: [],
    submitted: false
  };

  function readPool() {
    return (window.READING || []).filter(function (a) {
      if (READ.cat !== 'all' && a.cat !== READ.cat) return false;
      if (READ.lv && a.level !== READ.lv) return false;
      return true;
    });
  }

  function readChars(a) {
    return a.paras.reduce(function (n, p) { return n + p.ja.length; }, 0);
  }

  function renderReadingList() {
    show($('readListPane'));
    hide($('readArticlePane'));
    var pool = readPool();
    if (!pool.length) {
      $('readList').innerHTML = '<div class="card empty">这个筛选条件下还没有文章。</div>';
      return;
    }
    var html = '';
    pool.forEach(function (a) {
      html += '<div class="card read-item" data-id="' + a.id + '">' +
        '<div class="ri-head">' +
        '<span class="ri-cat">' + esc(a.cat) + '</span>' +
        '<span class="ri-lv">' + LEVELS[a.level] + '</span>' +
        '</div>' +
        '<h3 class="ri-title">' + furiToHtml(a.jaTitleFuri) + '</h3>' +
        '<p class="ri-zh">' + esc(a.zhTitle) + '</p>' +
        '<p class="ri-foot">' + a.paras.length + ' 段 · 约 ' + readChars(a) + ' 字 · ' +
        a.questions.length + ' 道理解题</p>' +
        '</div>';
    });
    $('readList').innerHTML = html;
  }

  function renderReadBody() {
    var a = READ.current;
    var html = '';
    a.paras.forEach(function (p, i) {
      html += '<div class="read-para">' +
        '<div class="rp-ja">' + furiToHtml(p.furi) + '</div>' +
        '<p class="rp-zh' + (READ.showZh ? '' : ' hidden') + '">' + esc(p.zh) + '</p>' +
        '<button class="btn-hear small-hear" data-para="' + i + '">▷ 朗读本段</button>' +
        '</div>';
    });
    $('readBody').innerHTML = html;
  }

  function renderQuiz() {
    var a = READ.current;
    var html = '';
    a.questions.forEach(function (q, qi) {
      html += '<div class="qz-item"><div class="qz-q">' + (qi + 1) + '. ' + esc(q.q) + '</div>';
      html += '<div class="qz-opts">';
      q.options.forEach(function (o, oi) {
        var on = READ.answers[qi] === oi ? ' on' : '';
        html += '<button class="qz-opt' + on + '" data-q="' + qi + '" data-o="' + oi + '">' +
          '<span class="qz-n">' + 'ABCD'[oi] + '</span>' + furiToHtml(o.furi) + '</button>';
      });
      html += '</div>';
      if (READ.submitted) {
        var ok = READ.answers[qi] === q.answer;
        html += '<div class="qz-exp ' + (ok ? 'ok' : 'no') + '">' +
          (ok ? '✓ 回答正确。' : (READ.answers[qi] == null ? '未作答。' : '✗ ') + '正确答案是 ' + 'ABCD'[q.answer] + '。') +
          ' ' + esc(q.explain) + '</div>';
      }
      html += '</div>';
    });
    $('readQuiz').innerHTML = html;
  }

  function openArticle(id) {
    var a = null;
    (window.READING || []).forEach(function (x) { if (x.id === id) a = x; });
    if (!a) return;
    READ.current = a;
    READ.showZh = false;
    READ.answers = a.questions.map(function () { return null; });
    READ.submitted = false;

    clearSpeechHint();
    $('readMeta').textContent = a.cat + ' · ' + LEVELS[a.level] + ' · 约 ' + readChars(a) + ' 字';
    $('readTitleJa').innerHTML = furiToHtml(a.jaTitleFuri);
    $('readTitleZh').textContent = a.zhTitle;
    $('readToggleZhBtn').textContent = '显示中文对照';
    hide($('readResult'));
    $('readSubmitBtn').disabled = false;

    renderReadBody();
    renderQuiz();
    hide($('readListPane'));
    show($('readArticlePane'));
    window.scrollTo(0, 0);
  }

  // 顺序朗读：一段读完自动接下一段
  function speakSeq(paras, i, btn, done) {
    if (i >= paras.length) { if (done) done(); return; }
    speak(paras[i].ja, 'ja-JP', btn, function () {
      speakSeq(paras, i + 1, btn, done);
    }, 'readSpeechHint');
  }

  function submitQuiz() {
    var a = READ.current;
    if (!a) return;
    READ.submitted = true;
    var right = 0;
    a.questions.forEach(function (q, qi) {
      if (READ.answers[qi] === q.answer) right++;
    });
    var total = a.questions.length;
    var msg = right === total
      ? '全部答对！这篇文章你已经读懂了。'
      : '答对 ' + right + ' / ' + total + ' 题。往下看每道题的解析，再回读一遍对应的段落。';
    $('readResult').textContent = msg;
    $('readResult').className = 'read-result ' + (right === total ? 'good' : 'warn');
    show($('readResult'));
    $('readSubmitBtn').disabled = true;
    renderQuiz();
  }

  // ---------- 偶像活动对话 ----------
  var TALK_KEY = 'riyi_talk_v1';
  var TALK = {
    sceneId: ((window.TALK && window.TALK.scenes[0]) || {}).id,
    level: 2,
    turns: [],
    busy: false,
    startedAt: 0,
    token: 0          // 会话令牌：结束或重开后，迟到的回复直接丢弃
  };

  function talkScene() {
    var found = null;
    ((window.TALK && window.TALK.scenes) || []).forEach(function (x) {
      if (x.id === TALK.sceneId) found = x;
    });
    return found || (window.TALK.scenes || [])[0];
  }

  function talkLevelInfo() {
    return (window.TALK.levels || {})[TALK.level] || {};
  }

  function loadTalkLog() {
    try { return JSON.parse(localStorage.getItem(TALK_KEY)) || []; }
    catch (e) { return []; }
  }

  function renderTalkSetup() {
    show($('talkSetupPane'));
    hide($('talkChatPane'));

    var html = '';
    ((window.TALK && window.TALK.scenes) || []).forEach(function (s) {
      var on = s.id === TALK.sceneId ? ' active' : '';
      html += '<button class="dir-btn' + on + '" data-scene="' + s.id + '">' +
        '<b>' + s.emoji + ' ' + esc(s.name) + '</b><span>' + esc(s.desc) + '</span></button>';
    });
    $('talkSceneRow').innerHTML = html;

    var sc = talkScene();
    if (sc) {
      var et = sc.etiquette.map(function (x) { return '<li>' + esc(x) + '</li>'; }).join('');
      var ph = sc.phrases.map(function (p) {
        return '<div class="tb-phrase"><div class="tb-ja">' + furiToHtml(p.furi) + '</div>' +
          '<div class="tb-zh">' + esc(p.zh) + '</div></div>';
      }).join('');
      $('talkBrief').innerHTML =
        '<div class="tb-sec"><div class="tb-t">现场是什么样</div><p class="tb-p">' + esc(sc.briefing) + '</p></div>' +
        '<div class="tb-sec"><div class="tb-t">礼貌与节奏</div><ul class="tb-list">' + et + '</ul></div>' +
        '<div class="tb-sec"><div class="tb-t">开口就能用的说法</div>' + ph + '</div>';
    }

    $('talkLevelTip').textContent = '当前难度：' + (talkLevelInfo().hint || '');
    renderTalkRecent();
  }

  function renderTalkRecent() {
    var log = loadTalkLog();
    if (!log.length) { $('talkRecentCard').innerHTML = ''; return; }
    var html = '<div class="card"><div class="read-sec-t">最近的对话</div>';
    log.slice(-4).reverse().forEach(function (s) {
      var n = (s.turns || []).filter(function (t) { return !!t.user; }).length;
      var body = (s.turns || []).map(function (t) {
        return '<div class="tk-line"><b>成员</b><span>' + esc(t.ai && t.ai.ja || '') + '</span></div>' +
          (t.user ? '<div class="tk-line me"><b>你</b><span>' + esc(t.user) + '</span></div>' : '') +
          (t.fb && t.fb.verdict ? '<div class="tk-line fb"><b>点评</b><span>' + esc(t.fb.verdict) + '</span></div>' : '');
      }).join('');
      html += '<details class="tk-recent">' +
        '<summary><span class="tk-date">' + fmtDate(s.ts) + '</span>' +
        '<span class="tk-name">' + esc(s.sceneName) + ' · ' + LEVELS[s.level] + '</span>' +
        '<span class="tk-n">' + n + ' 轮</span></summary>' +
        '<div class="tk-detail">' + body + '</div>' +
        '</details>';
    });
    html += '</div>';
    $('talkRecentCard').innerHTML = html;
  }

  function renderTalkLog() {
    var html = '';
    TALK.turns.forEach(function (t, i) {
      var ruby = TALK.level === 3 ? esc(t.ai.ja) : furiToHtml(t.ai.furi);
      html += '<div class="chat-row ai">' +
        '<div class="chat-ava">♡</div>' +
        '<div class="chat-col">' +
        '<div class="chat-bubble ai">' +
        '<div class="cb-ja">' + ruby + '</div>' +
        '<div class="cb-zh hidden">' + esc(t.ai.zh) + '</div>' +
        '<div class="cb-tools">' +
        '<button class="cb-tool" data-speak="' + i + '">▷ 听</button>' +
        '<button class="cb-tool" data-zh="' + i + '">中文</button>' +
        '</div></div></div></div>';

      if (t.user) {
        var fb = '';
        if (t.pending) {
          fb = '<div class="talk-fb loading"><span class="spinner"></span> 教练正在看你这句话…</div>';
        } else if (t.error) {
          fb = '<div class="talk-fb err"><span class="tfb-err">' + esc(t.error) + '</span>' +
            '<button class="btn-ghost small" data-retry="' + i + '">重试</button></div>';
        } else if (t.fb) {
          fb = talkFbHtml(t.fb);
        }
        html += '<div class="chat-row me"><div class="chat-col">' +
          '<div class="chat-bubble me">' + esc(t.user) + '</div>' + fb +
          '</div></div>';
      }
    });
    if (TALK.busy) {
      html += '<div class="chat-row ai"><div class="chat-ava">♡</div>' +
        '<div class="chat-col"><div class="chat-bubble ai typing">' +
        '<span class="tdot"></span><span class="tdot"></span><span class="tdot"></span>' +
        '</div></div></div>';
    }
    var box = $('talkLog');
    box.innerHTML = html;
    box.scrollTop = box.scrollHeight;
  }

  function talkFbHtml(f) {
    var h = '<div class="talk-fb">';
    if (f.verdict) h += '<div class="tfb-v">' + esc(f.verdict) + '</div>';
    (f.highlights || []).forEach(function (x) {
      h += '<div class="tfb-li good">✓ ' + esc(x) + '</div>';
    });
    (f.suggestions || []).forEach(function (x) {
      h += '<div class="tfb-li sug">→ ' + esc(x) + '</div>';
    });
    if (f.next) h += '<div class="tfb-next">💡 ' + esc(f.next) + '</div>';
    return h + '</div>';
  }

  function syncTalkSend() {
    $('talkSendBtn').disabled = TALK.busy || !$('talkInput').value.trim();
  }

  function startTalk() {
    var sc = talkScene();
    if (!sc) return;
    var pool = sc.openers[TALK.level] || sc.openers[2] || sc.openers[1] || [];
    if (!pool.length) return;
    var first = pool[Math.floor(Math.random() * pool.length)];

    TALK.token++;
    TALK.turns = [{ ai: first, user: null, fb: null }];
    TALK.busy = false;
    TALK.startedAt = Date.now();

    clearSpeechHint();
    hide($('talkHintBox'));
    $('talkInput').value = '';
    $('talkInput').readOnly = false;
    syncTalkSend();
    $('talkMeta').textContent = sc.emoji + ' ' + sc.zhName + ' · ' + LEVELS[TALK.level];
    renderTalkLog();
    hide($('talkSetupPane'));
    show($('talkChatPane'));
    window.scrollTo(0, 0);
    speak(first.ja, 'ja-JP', null, null, 'talkSpeechHint');
  }

  function endTalk() {
    var used = TALK.turns.filter(function (t) { return !!t.user; });
    if (used.length) {
      var sc = talkScene();
      var log = loadTalkLog();
      log.push({
        ts: Date.now(),
        sceneId: sc.id, sceneName: sc.zhName, level: TALK.level,
        turns: TALK.turns.map(function (t) {
          return { ai: t.ai, user: t.user, fb: t.fb || null };
        })
      });
      if (log.length > 30) log = log.slice(-30);
      try { localStorage.setItem(TALK_KEY, JSON.stringify(log)); } catch (e) {}
    }
    TALK.token++;
    TALK.turns = [];
    TALK.busy = false;
    if ('speechSynthesis' in window) {
      try { window.speechSynthesis.cancel(); } catch (e) {}
    }
    renderTalkSetup();
    go('talk');
  }

  async function sendTalk() {
    if (TALK.busy) return;
    var text = $('talkInput').value.trim();
    if (!text) return;
    var last = TALK.turns[TALK.turns.length - 1];
    if (!last || last.user) return;

    last.user = text;
    last.pending = true;
    last.error = '';
    $('talkInput').value = '';
    TALK.busy = true;
    syncTalkSend();
    renderTalkLog();
    await fetchMemberReply(TALK.turns.length - 1, text);
  }

  var TALK_SYS = '你在做「日语现场对话」角色扮演练习：你扮演一位不具名的现役偶像成员（虚构角色，不指向任何真实人物或团体），用户扮演前来参加活动的粉丝。你全程用日语说话。\n' +
    '输出必须是且仅是一个 JSON 对象，不要 Markdown 代码围栏，不要任何解释文字。字段：\n' +
    '{"reply":"你的日文台词，只含日语","zh":"reply 的中文翻译","verdict":"对用户刚才那句日语的一句话中文点评，不超过20字","highlights":["用户说得好的具体点，1条，中文，不超过25字"],"suggestions":["更地道的说法：把「A」换成「B」，B 必须是日语，1-2条，每条不超过45字"],"next":"中文提示：用户下一句可以聊什么，不超过25字"}\n' +
    '【现场感规则（最重要，像真实活动里的闲聊，不要像客服或课本）】\n' +
    '1. 反应要大：惊讶、开心、感动都要直接喊出来（えー！/うわー！/まじで？/やば！/ふふっ）。\n' +
    '2. 复述关键词：把用户话里最具体的一个词先复述一遍，再顺着追问（近况、游戏、食物、季节、追的番）。\n' +
    '3. 主动观察和夸奖用户：耳饰、发色、衣服、头套、来过几次——像真在活动现场打量对面的人。\n' +
    '4. 被夸时大方接住：先照れる（やだー/えー照れる）再道谢，不要客气推辞。\n' +
    '5. 一个话题聊 1〜3 个回合就自然换下一个，别在同一话题上反复总结。\n' +
    '6. 收尾要有「また来てね」的约定感；用户说时间到了就爽快送客并道谢。\n' +
    '【通用规则】保持角色，绝不出戏，不承认自己是 AI；不出现真实人名、团体名、店铺名；不询问或评价用户的真实身份、住址、联系方式；不谈政治宗教与恋爱细节；用户如果用中文说，你仍用日语回应，并在 suggestions 里给出对应的日语说法；用户说得不对时不要直接批评，用 suggestions 给出更地道的版本；reply 要符合场景节奏，时间紧的场合只说一句；verdict 关注意思有没有传达到、像不像现场口语，不苛求语法完美。';

  function buildTalkSystem(sc) {
    return TALK_SYS +
      '\n【本次场景】' + sc.zhName + '（' + sc.name + '）\n' + sc.briefing +
      '\n【角色设定（日文）】' + sc.persona +
      '\n【难度要求】' + (talkLevelInfo().rule || '');
  }

  function buildTalkUser(sc, text) {
    var hist = [];
    TALK.turns.slice(-6).forEach(function (t) {
      if (t.ai && t.ai.ja) hist.push('成员：' + t.ai.ja);
      if (t.user) hist.push('粉丝：' + t.user);
    });
    return '场景：' + sc.zhName +
      '\n最近对话（由旧到新）：\n' + hist.join('\n') +
      '\n\n粉丝刚才说：' + text +
      '\n\n请按要求输出 JSON：reply 是你要说的日文台词，zh 是中文翻译，verdict/highlights/suggestions 点评粉丝刚才那句，next 提示粉丝下一句可以聊什么。';
  }

  function parseTalkReply(text) {
    var t = String(text || '').replace(/```json/gi, '').replace(/```/g, '').trim();
    var m = t.match(/\{[\s\S]*\}/);
    var o = null;
    if (m) { try { o = JSON.parse(m[0]); } catch (e) { o = null; } }
    if (!o || !o.reply) {
      var err = new Error('bad answer');
      err.code = 'bad_answer';
      throw err;
    }
    if (!Array.isArray(o.highlights)) o.highlights = o.highlights ? [String(o.highlights)] : [];
    if (!Array.isArray(o.suggestions)) o.suggestions = o.suggestions ? [String(o.suggestions)] : [];
    return o;
  }

  async function fetchMemberReply(turnIdx, text) {
    var token = TALK.token;
    var sc = talkScene();
    var last = TALK.turns[turnIdx];
    try {
      var model = await getModel();
      var out = '';
      for await (var chunk of cloud.llm.chat.completions.create({
        model: model.id,
        messages: [
          { role: 'system', content: buildTalkSystem(sc) },
          { role: 'user', content: buildTalkUser(sc, text) }
        ],
        stream: true,
        temperature: 0.8
      })) {
        var delta = chunk.choices && chunk.choices[0] && chunk.choices[0].delta;
        if (delta && delta.content) out += delta.content;
      }
      if (token !== TALK.token) return;      // 会话已结束/重开，丢弃这次回复

      var r = parseTalkReply(out);
      last.pending = false;
      last.error = '';
      last.fb = { verdict: r.verdict || '', highlights: r.highlights, suggestions: r.suggestions, next: r.next || '' };

      var plain = window.stripFuri ? window.stripFuri(r.reply) : r.reply;
      TALK.turns.push({ ai: { ja: plain, furi: r.reply, zh: r.zh || '' }, user: null, fb: null });
      TALK.busy = false;
      renderTalkLog();
      speak(plain, 'ja-JP', null, null, 'talkSpeechHint');
    } catch (e) {
      if (token !== TALK.token) return;
      last.pending = false;
      last.error = (cloudError && !cloud) ? cloudError : friendlyLLMError(e);
      TALK.busy = false;
      renderTalkLog();
    }
  }

  // 语音输入（日语）
  var talkRec = null, talkRecOn = false;
  function stopTalkRec() {
    if (talkRecOn && talkRec) { try { talkRec.stop(); } catch (e) {} }
    talkRecOn = false;
    if ($('talkMicBtn')) $('talkMicBtn').textContent = '🎤 语音输入';
  }

  function startTalkRec() {
    if (!voiceSupported) {
      $('talkSpeechHint').textContent = '当前浏览器不支持语音识别，请直接打字，或改用 Chrome / Edge。';
      show($('talkSpeechHint'));
      return;
    }
    if (talkRecOn) { stopTalkRec(); return; }

    var rec = new SR();
    rec.lang = 'ja-JP';
    rec.interimResults = true;
    rec.continuous = false;
    var base = $('talkInput').value;

    rec.onresult = function (e) {
      var txt = '';
      for (var i = 0; i < e.results.length; i++) txt += e.results[i][0].transcript;
      $('talkInput').value = base + txt;
      syncTalkSend();
    };
    rec.onerror = function (e) {
      talkRecOn = false;
      $('talkMicBtn').textContent = '🎤 语音输入';
      var msg = '识别出错，请重试或直接打字。';
      if (e.error === 'not-allowed' || e.error === 'service-not-allowed') msg = '麦克风权限被拒绝，请在浏览器地址栏允许麦克风。';
      else if (e.error === 'no-speech') msg = '没有听到声音，请再点一次。';
      $('talkSpeechHint').textContent = msg;
      show($('talkSpeechHint'));
    };
    rec.onend = function () {
      talkRecOn = false;
      $('talkMicBtn').textContent = '🎤 语音输入';
    };

    try { rec.start(); } catch (e) { return; }
    talkRec = rec;
    talkRecOn = true;
    clearSpeechHint();
    $('talkMicBtn').textContent = '■ 停止录音';
  }

  // ---------- 历史日志 ----------
  function loadLog() {
    try { return JSON.parse(localStorage.getItem(LOG_KEY)) || []; }
    catch (e) { return []; }
  }
  function saveLog(arr) { localStorage.setItem(LOG_KEY, JSON.stringify(arr)); }
  function appendRound(rec) { var a = loadLog(); a.push(rec); saveLog(a); }

  function calcStats(log) {
    var total = 0;
    var days = {};
    log.forEach(function (r) { total += r.count; days[dayKey(r.ts)] = 1; });
    var streak = 0;
    var probe = new Date();
    if (!days[dayKey(probe.getTime())]) probe.setDate(probe.getDate() - 1);
    while (days[dayKey(probe.getTime())]) {
      streak++;
      probe.setDate(probe.getDate() - 1);
    }
    return { total: total, days: Object.keys(days).length, streak: streak };
  }

  function metricHTML(label, num, unit) {
    return '<div class="metric"><div class="m-label">' + label + '</div>' +
      '<div class="m-num">' + num + '<small>' + unit + '</small></div></div>';
  }

  function renderStats(el, log) {
    var st = calcStats(log);
    el.innerHTML =
      metricHTML('累计练习', st.total, ' 句') +
      metricHTML('练习天数', st.days, ' 天') +
      metricHTML('连续练习', st.streak, ' 天');
  }

  function renderHome() {
    renderStats($('homeStats'), loadLog());
    go('home');
  }

  function renderHistory() {
    var log = loadLog();
    renderStats($('historyStats'), log);
    var html = '';
    if (!log.length) {
      html = '<div class="card empty">还没有练习记录，去首页开始第一句吧。</div>';
    } else {
      log.slice().reverse().forEach(function (r) {
        var sents = r.items.map(function (it, i) {
          var srcHtml = (r.dir === 'ja2zh' && it.srcFuri) ? furiToHtml(it.srcFuri) : esc(it.src);
          var refHtml = (r.dir === 'zh2ja' && it.refFuri) ? furiToHtml(it.refFuri) : esc(it.ref);
          return '<div class="rpt-sent"><b>第 ' + (i + 1) + ' 句</b>' + srcHtml +
            '<p class="rpt-v">你的作答：' + esc(it.user) + '</p>' +
            '<p class="rpt-v">参考译文：' + refHtml + '（' + esc(it.verdict) + '）</p>' +
            (it.aiVerdict ? '<p class="rpt-v ai">讲评：' + esc(it.aiVerdict) + '</p>' : '') +
            '</div>';
        }).join('');
        var modeTag = r.trainMode === 'interp' ? ' · 盲听同传' : '';
        html += '<div class="rpt-item card">' +
          '<div class="rpt-head">' +
          '<span class="rpt-idx">' + fmtDate(r.ts) + '</span>' +
          '<span class="rpt-src">' + (r.dir === 'zh2ja' ? '中→日' : '日→中') + modeTag + ' · ' + LEVELS[r.level] + ' · ' + SCENES[r.scene] + ' · ' + r.count + ' 句</span>' +
          '<span class="rpt-badge">' + fmtDur(r.durSec) + '</span>' +
          '</div><div class="rpt-body">' + sents + '</div></div>';
      });
    }
    $('historyList').innerHTML = html;
    go('history');
  }

  // ---------- 事件绑定 ----------
  document.querySelectorAll('#dirRow .dir-btn').forEach(function (b) {
    b.addEventListener('click', function () {
      document.querySelectorAll('#dirRow .dir-btn').forEach(function (x) { x.classList.remove('active'); });
      b.classList.add('active');
      state.dir = b.dataset.dir;
    });
  });
  document.querySelectorAll('#trainModeRow .dir-btn').forEach(function (b) {
    b.addEventListener('click', function () {
      document.querySelectorAll('#trainModeRow .dir-btn').forEach(function (x) { x.classList.remove('active'); });
      b.classList.add('active');
      state.trainMode = b.dataset.tmode;
    });
  });
  document.querySelectorAll('#levelRow .pill').forEach(function (b) {
    b.addEventListener('click', function () {
      document.querySelectorAll('#levelRow .pill').forEach(function (x) { x.classList.remove('active'); });
      b.classList.add('active');
      state.level = parseInt(b.dataset.level, 10);
    });
  });
  document.querySelectorAll('#sceneRow .pill').forEach(function (b) {
    b.addEventListener('click', function () {
      document.querySelectorAll('#sceneRow .pill').forEach(function (x) { x.classList.remove('active'); });
      b.classList.add('active');
      state.scene = b.dataset.scene;
    });
  });

  $('startBtn').addEventListener('click', startPractice);
  $('againBtn').addEventListener('click', startPractice);
  $('logoBtn').addEventListener('click', renderHome);
  $('navHome').addEventListener('click', renderHome);
  $('navHistory').addEventListener('click', renderHistory);
  $('backHomeBtn').addEventListener('click', renderHome);
  $('backHomeBtn2').addEventListener('click', renderHome);

  $('exitBtn').addEventListener('click', function () {
    if (!state.results.length) { renderHome(); return; }
    if (confirm('退出本轮练习？已完成的 ' + state.results.length + ' 句会计入练习日志。')) {
      var rec = {
        id: Date.now(), ts: Date.now(),
        dir: state.dir, trainMode: state.trainMode, scene: state.scene, level: state.level,
        count: state.results.length,
        durSec: Math.max(1, Math.round((Date.now() - state.startedAt) / 1000)),
        items: state.results
      };
      appendRound(rec);
      renderHome();
    }
  });

  $('peekBtn').addEventListener('click', function () {
    setMask(!state.masked);
  });
  $('srcText').addEventListener('click', function () {
    if (state.trainMode === 'interp' && state.masked) setMask(false);
  });

  $('modeBtn').addEventListener('click', function () {
    state.mode = state.mode === 'voice' ? 'type' : 'voice';
    applyMode();
    if (state.mode === 'voice') startRec();
  });

  $('aiRetryBtn').addEventListener('click', function () {
    if (aiLastCall) requestAIFeedback(aiLastCall);
  });

  $('micBtn').addEventListener('click', function () {
    if (state.recognizing && state.recognition) state.recognition.stop();
    else startRec();
  });

  $('answerInput').addEventListener('input', syncSubmit);
  $('submitBtn').addEventListener('click', submitCurrent);

  $('nextBtn').addEventListener('click', function () {
    state.idx++;
    if (state.idx >= state.queue.length) finishRound();
    else renderSentence();
  });

  $('speakBtn').addEventListener('click', function () {
    if (state.current) {
      var srcLang = state.dir === 'zh2ja' ? 'zh-CN' : 'ja-JP';
      speak(currentSrc(state.current), srcLang, this, null, 'srcSpeechHint');
    }
  });
  $('refSpeakBtn').addEventListener('click', function () {
    if (state.lastCall) {
      speak(state.lastCall.reference, state.lastCall.dir === 'zh2ja' ? 'ja-JP' : 'zh-CN', this, null, 'speechHint');
    }
  });

  $('clearBtn').addEventListener('click', function () {
    if (!confirm('确定清空全部练习记录吗？此操作无法恢复。')) return;
    localStorage.removeItem(LOG_KEY);
    renderHistory();
  });

  // ---------- 阅读模块事件 ----------
  function goReading() {
    renderReadingList();
    go('reading');
  }
  $('navReading').addEventListener('click', goReading);
  $('homeReadBtn').addEventListener('click', goReading);

  $('readBackBtn').addEventListener('click', function () {
    if ('speechSynthesis' in window) {
      try { window.speechSynthesis.cancel(); } catch (e) {}
    }
    readingSeqRunning = false;
    renderReadingList();
  });

  $('readList').addEventListener('click', function (e) {
    var item = e.target.closest ? e.target.closest('.read-item') : null;
    if (!item) return;
    openArticle(item.dataset.id);
  });

  $('readBody').addEventListener('click', function (e) {
    var b = e.target.closest ? e.target.closest('[data-para]') : null;
    if (!b || !READ.current) return;
    var p = READ.current.paras[parseInt(b.dataset.para, 10)];
    if (p) speak(p.ja, 'ja-JP', b, null, 'readSpeechHint');
  });

  $('readToggleZhBtn').addEventListener('click', function () {
    READ.showZh = !READ.showZh;
    this.textContent = READ.showZh ? '隐藏中文对照' : '显示中文对照';
    renderReadBody();
  });

  var readingSeqRunning = false;
  $('readSpeakAllBtn').addEventListener('click', function () {
    if (!READ.current) return;
    var btn = this;
    if (readingSeqRunning) {
      try { window.speechSynthesis.cancel(); } catch (e) {}
      readingSeqRunning = false;
      setSpeakLabel(btn, false);
      return;
    }
    readingSeqRunning = true;
    clearSpeechHint();
    speakSeq(READ.current.paras, 0, btn, function () {
      readingSeqRunning = false;
      setSpeakLabel(btn, false);
    });
  });

  $('readQuiz').addEventListener('click', function (e) {
    var b = e.target.closest ? e.target.closest('.qz-opt') : null;
    if (!b || READ.submitted) return;
    READ.answers[parseInt(b.dataset.q, 10)] = parseInt(b.dataset.o, 10);
    renderQuiz();
  });

  $('readSubmitBtn').addEventListener('click', submitQuiz);

  $('readRetryBtn').addEventListener('click', function () {
    if (!READ.current) return;
    READ.answers = READ.current.questions.map(function () { return null; });
    READ.submitted = false;
    hide($('readResult'));
    $('readSubmitBtn').disabled = false;
    renderQuiz();
  });

  document.querySelectorAll('#readCatRow .pill').forEach(function (b) {
    b.addEventListener('click', function () {
      document.querySelectorAll('#readCatRow .pill').forEach(function (x) { x.classList.remove('active'); });
      b.classList.add('active');
      READ.cat = b.dataset.cat;
      renderReadingList();
    });
  });
  document.querySelectorAll('#readLevelRow .pill').forEach(function (b) {
    b.addEventListener('click', function () {
      document.querySelectorAll('#readLevelRow .pill').forEach(function (x) { x.classList.remove('active'); });
      b.classList.add('active');
      READ.lv = parseInt(b.dataset.lv, 10);
      renderReadingList();
    });
  });

  // ---------- 朗读自检 ----------
  $('ttsCheckBtn').addEventListener('click', function () { ttsSelfCheck('ttsResult'); });
  $('readTtsBtn').addEventListener('click', function () { ttsSelfCheck('readSpeechHint'); });

  // ---------- 对话模块事件 ----------
  function goTalk() {
    // 有进行中的会话就回到聊天，切走再回来不会丢上下文
    if (TALK.turns.length) {
      var sc = talkScene();
      $('talkMeta').textContent = sc.emoji + ' ' + sc.zhName + ' · ' + LEVELS[TALK.level];
      renderTalkLog();
      hide($('talkSetupPane'));
      show($('talkChatPane'));
    } else {
      renderTalkSetup();
    }
    go('talk');
  }
  $('navTalk').addEventListener('click', goTalk);
  $('homeTalkBtn').addEventListener('click', goTalk);

  $('talkSceneRow').addEventListener('click', function (e) {
    var b = e.target.closest ? e.target.closest('[data-scene]') : null;
    if (!b) return;
    TALK.sceneId = b.dataset.scene;
    renderTalkSetup();
  });

  document.querySelectorAll('#talkLevelRow .pill').forEach(function (b) {
    b.addEventListener('click', function () {
      document.querySelectorAll('#talkLevelRow .pill').forEach(function (x) { x.classList.remove('active'); });
      b.classList.add('active');
      TALK.level = parseInt(b.dataset.lv, 10);
      $('talkLevelTip').textContent = '当前难度：' + (talkLevelInfo().hint || '');
      renderTalkSetup();
    });
  });

  $('talkStartBtn').addEventListener('click', startTalk);

  $('talkEndBtn').addEventListener('click', function () {
    var used = TALK.turns.filter(function (t) { return !!t.user; }).length;
    if (used && !confirm('结束这次对话？' + used + ' 轮记录会保存在本浏览器里。')) return;
    endTalk();
  });

  $('talkInput').addEventListener('input', syncTalkSend);
  $('talkInput').addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendTalk();
    }
  });
  $('talkSendBtn').addEventListener('click', sendTalk);
  $('talkMicBtn').addEventListener('click', startTalkRec);

  $('talkHintBtn').addEventListener('click', function () {
    var box = $('talkHintBox');
    if (!box.classList.contains('hidden')) { hide(box); return; }
    var sc = talkScene();
    if (!sc) return;
    box.innerHTML = '<div class="th-t">点一句就能填进输入框，改一改再发出去</div>' +
      sc.phrases.map(function (p, i) {
        return '<button class="th-item" data-phrase="' + i + '">' +
          '<span class="th-ja">' + furiToHtml(p.furi) + '</span>' +
          '<span class="th-zh">' + esc(p.zh) + '</span></button>';
      }).join('');
    show(box);
  });

  $('talkHintBox').addEventListener('click', function (e) {
    var b = e.target.closest ? e.target.closest('[data-phrase]') : null;
    if (!b) return;
    var sc = talkScene();
    var p = sc && sc.phrases[parseInt(b.dataset.phrase, 10)];
    if (!p) return;
    $('talkInput').value = p.ja;
    syncTalkSend();
    $('talkInput').focus();
    hide($('talkHintBox'));
  });

  $('talkLog').addEventListener('click', function (e) {
    if (!e.target.closest) return;

    var sp = e.target.closest('[data-speak]');
    if (sp) {
      var t = TALK.turns[parseInt(sp.dataset.speak, 10)];
      if (t) speak(t.ai.ja, 'ja-JP', sp, null, 'talkSpeechHint');
      return;
    }

    var zh = e.target.closest('[data-zh]');
    if (zh) {
      var bubble = zh.closest('.chat-bubble');
      var el = bubble ? bubble.querySelector('.cb-zh') : null;
      if (el) {
        el.classList.toggle('hidden');
        zh.textContent = el.classList.contains('hidden') ? '中文' : '收起';
      }
      return;
    }

    var rt = e.target.closest('[data-retry]');
    if (rt) {
      var i = parseInt(rt.dataset.retry, 10);
      var turn = TALK.turns[i];
      if (turn && turn.user && !TALK.busy) {
        turn.error = '';
        turn.pending = true;
        TALK.busy = true;
        syncTalkSend();
        renderTalkLog();
        fetchMemberReply(i, turn.user);
      }
    }
  });

  bindExpand('reportList');
  bindExpand('historyList');

  // ---------- 启动 ----------
  initCloud();
  if (!voiceSupported) {
    state.mode = 'type';
    $('voiceTip').textContent = '提示：当前浏览器不支持语音识别，已自动切换为打字输入模式。推荐使用 Chrome 或 Edge。';
  }
  renderHome();
})();