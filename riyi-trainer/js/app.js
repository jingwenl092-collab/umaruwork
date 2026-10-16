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
    report: $('view-report'), history: $('view-history')
  };
  function go(name) {
    aiToken++;   // 切换页面后，尚未返回的讲评一律作废
    stopTimer();
    stopRec();
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

  function pickVoice(lang) {
    refreshVoices();
    if (!speechVoices.length) return null;
    var want = String(lang || '').toLowerCase();
    var i, v, l;
    for (i = 0; i < speechVoices.length; i++) {
      v = speechVoices[i];
      l = String(v.lang || '').toLowerCase().replace('_', '-');
      if (l === want) return v;
    }
    var head = want.split('-')[0];
    for (i = 0; i < speechVoices.length; i++) {
      v = speechVoices[i];
      l = String(v.lang || '').toLowerCase().replace('_', '-');
      if (l.indexOf(head) === 0) return v;
    }
    return null;
  }

  function clearSpeechHint() {
    ['speechHint', 'srcSpeechHint'].forEach(function (id) {
      var el = $(id);
      if (el) { el.textContent = ''; hide(el); }
    });
  }

  function showSpeechHint(lang, targetId) {
    var el = $(targetId || 'speechHint');
    if (!el) return;
    var isJa = String(lang || '').toLowerCase().indexOf('ja') === 0;
    el.textContent = isJa
      ? '听不到声音？这台设备可能缺少日语语音包。Windows：设置 → 时间和语言 → 语言和区域 → 添加语言「日本語」并勾选「语音」；装好后刷新页面再试。'
      : '听不到声音？请在系统语言设置里安装中文语音包，装好后刷新页面再试。';
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

  function doSpeak(text, lang, btn, onDone, hintId) {
    var synth = window.speechSynthesis;
    var u = new SpeechSynthesisUtterance(text);
    u.lang = lang;
    u.rate = 0.95;
    u.pitch = 1;

    var v = pickVoice(lang);
    if (v) u.voice = v;

    if (speechVoices.length && !v) {
      showSpeechHint(lang, hintId);
      if (onDone) onDone();
      return;
    }

    var finished = false;
    function finishOnce() {
      if (finished) return;
      finished = true;
      setSpeakLabel(btn, false);
      if (onDone) onDone();
    }

    u.onstart = function () { setSpeakLabel(btn, true); };
    u.onend = finishOnce;
    u.onerror = function () {
      showSpeechHint(lang, hintId);
      finishOnce();
    };

    try { synth.resume(); } catch (err) {}
    try { synth.speak(u); } catch (err) {
      showSpeechHint(lang, hintId);
      finishOnce();
      return;
    }

    if (!v) {
      setTimeout(function () {
        if (!synth.speaking && !synth.pending) {
          showSpeechHint(lang, hintId);
          finishOnce();
        }
      }, 1200);
    }
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
        setTimeout(function () { doSpeak(text, lang, btn, onDone, hintId); }, 180);
      } else {
        doSpeak(text, lang, btn, onDone, hintId);
      }
    } catch (e) {
      showSpeechHint(lang, hintId);
      if (onDone) onDone();
    }
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