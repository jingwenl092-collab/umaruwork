// 日译训练场 · 应用逻辑
(function () {
  'use strict';

  var ROUND_SIZE = 10;
  var LOG_KEY = 'riyi_log_v1';
  var SCENES = { daily: '日常生活', travel: '旅行', business: '商务', campus: '校园' };
  var LEVELS = { 1: '初级', 2: '中级', 3: '高级' };

  var state = {
    dir: 'zh2ja', level: 2, scene: 'daily',
    queue: [], idx: 0, results: [], startedAt: 0,
    mode: 'voice', recognizing: false, recognition: null,
    current: null, lastCall: null
  };

  // ---------- 工具 ----------
  function $(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function show(el) { el.classList.remove('hidden'); }
  function hide(el) { el.classList.add('hidden'); }
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

  // ---------- 视图切换 ----------
  var views = {
    home: $('view-home'), practice: $('view-practice'),
    report: $('view-report'), history: $('view-history')
  };
  function go(name) {
    Object.keys(views).forEach(function (k) {
      views[k].classList.toggle('hidden', k !== name);
    });
    window.scrollTo(0, 0);
  }

  // ---------- 云服务初始化 ----------
  var cloud = null;
  var cachedModel = null;
  var cloudError = null;

  function initCloud() {
    if (!window.WorkBuddyCloud || !window.PUBLIC_CONFIG) {
      cloudError = 'SDK 未加载';
      return;
    }
    try {
      cloud = window.WorkBuddyCloud.createWorkBuddyCloud({
        endpoint: window.PUBLIC_CONFIG.endpoint,
        oauthRelayBaseUrl: window.PUBLIC_CONFIG.oauthRelayBaseUrl,
        publishableKey: window.PUBLIC_CONFIG.publishableKey
      });
    } catch (e) {
      cloudError = e && e.message ? e.message : '初始化失败';
    }
  }

  var SYSTEM_PROMPT = '你是资深中日翻译教练，正在一对一指导学员练句子翻译。学员作答可能来自语音识别，若有同音错字请按其本意宽容评价。输出必须是且仅是一个 JSON 对象，不要打分，不要多余文字。长度限制：verdict 为一句话总评，不超过20字；highlights 为做得好的点，1-2条，每条不超过25字；suggestions 为改进建议，1-2条，每条不超过40字且必须写出更地道的正确说法。格式：{"verdict":"","highlights":[],"suggestions":[]}';

  function friendlyLLMError(error) {
    var code = (error && error.error && error.error.code) || (error && error.code) || '';
    code = String(code);
    if (code === 'model_empty') return '当前环境暂无可用模型，请联系开发者检查云服务配置。';
    if (code === 'sdk_missing') return 'AI 服务未能加载，请检查网络后刷新页面。';
    if (code.indexOf('quota_') === 0) return 'AI 讲评用量已达上限，请稍后再试。';
    if (code.indexOf('auth_') === 0) return '云服务校验失败，请在应用预览或已发布页面中使用。';
    if (code.indexOf('request_') === 0) return '请求参数异常，请刷新页面重试。';
    if (code.indexOf('gateway_') === 0 || code.indexOf('model_') === 0) return 'AI 服务暂时不可用，请点击重试。';
    return '讲评失败，请稍后重试。';
  }

  // 讲评要快：优先响应最快的模型，其次保证可用
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
    var m = t.match(/\{[\s\S]*\}/);
    var obj = null;
    if (m) { try { obj = JSON.parse(m[0]); } catch (e) { obj = null; } }
    if (!obj && t) obj = { verdict: t, highlights: [], suggestions: [] };
    if (!obj) { var err = new Error('empty'); err.code = 'empty_answer'; throw err; }
    if (!Array.isArray(obj.highlights)) obj.highlights = obj.highlights ? [String(obj.highlights)] : [];
    if (!Array.isArray(obj.suggestions)) obj.suggestions = obj.suggestions ? [String(obj.suggestions)] : [];
    return obj;
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
    } catch (e) { /* 忽略 */ }
    return speechVoices;
  }

  if ('speechSynthesis' in window) {
    refreshVoices();
    try {
      window.speechSynthesis.addEventListener('voiceschanged', refreshVoices);
    } catch (e) { /* 忽略 */ }
    // 部分浏览器不触发 voiceschanged，兜底轮询几次
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
    var el = $('speechHint');
    if (el) { el.textContent = ''; hide(el); }
  }

  function showSpeechHint(lang) {
    var el = $('speechHint');
    if (!el) return;
    var isJa = String(lang || '').toLowerCase().indexOf('ja') === 0;
    el.textContent = isJa
      ? '听不到声音？这台设备可能缺少日语语音包。Windows：设置 → 时间和语言 → 语言和区域 → 添加语言「日本語」→ 语言选项里勾选「语音」；macOS：系统设置 → 辅助功能 → 朗读内容 → 系统声音 → 下载日语声音；手机：系统设置 → 文字转语音/朗读 → 安装日语语音。装好后刷新页面再试。没有语音包也能照常练习。'
      : '听不到声音？这台设备可能缺少中文语音包。Windows/macOS 请在系统语言设置里安装中文语音；手机请在「文字转语音」设置里安装中文语音。装好后刷新页面再试。';
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

  function doSpeak(text, lang, btn) {
    var synth = window.speechSynthesis;
    var u = new SpeechSynthesisUtterance(text);
    u.lang = lang;
    u.rate = 0.95;
    u.pitch = 1;

    var v = pickVoice(lang);
    if (v) u.voice = v;

    // 有语音包但目标语言没有：硬用别的语言念会很怪，直接给提示
    if (speechVoices.length && !v) {
      showSpeechHint(lang);
      return;
    }

    u.onstart = function () { setSpeakLabel(btn, true); };
    u.onend = function () { setSpeakLabel(btn, false); };
    u.onerror = function () { setSpeakLabel(btn, false); showSpeechHint(lang); };

    try { synth.resume(); } catch (err) { /* 忽略 */ }
    try { synth.speak(u); } catch (err) { showSpeechHint(lang); return; }

    // 只在「没找到任何语音」时才兜底判断：Chrome 缺少语音包会静默忽略 speak()
    if (!v) {
      setTimeout(function () {
        if (!synth.speaking && !synth.pending) {
          setSpeakLabel(btn, false);
          showSpeechHint(lang);
        }
      }, 1200);
    }
  }

  function speak(text, lang, btn) {
    if (!('speechSynthesis' in window) || !text) return;
    clearSpeechHint();
    var synth = window.speechSynthesis;
    try {
      if (synth.speaking || synth.pending) {
        synth.cancel();
        setTimeout(function () { doSpeak(text, lang, btn); }, 180);
      } else {
        doSpeak(text, lang, btn);
      }
    } catch (e) {
      showSpeechHint(lang);
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
    state.current = state.queue[state.idx];
    var s = state.current;
    $('practiceMeta').textContent = (state.dir === 'zh2ja' ? '中 → 日' : '日 → 中') +
      ' · ' + LEVELS[state.level] + ' · ' + SCENES[state.scene];
    $('practiceCount').textContent = '第 ' + (state.idx + 1) + ' / ' + state.queue.length + ' 句';
    $('progressBar').style.width = (state.idx / state.queue.length * 100) + '%';
    $('srcLabel').textContent = state.dir === 'zh2ja' ? '原句 · 请翻译成日语' : '原句 · 请翻译成中文';
    $('srcText').textContent = currentSrc(s);
    if (state.dir === 'ja2zh') show($('speakBtn')); else hide($('speakBtn'));

    var input = $('answerInput');
    input.value = '';
    input.readOnly = false;
    $('submitBtn').disabled = true;
    hide($('feedbackCard'));
    hide($('errorCard'));
    hide($('loadingCard'));
    show($('inputCard'));
    clearSpeechHint();
    applyMode();
  }

  // ---------- 输入模式与语音识别 ----------
  var SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  var voiceSupported = !!SR;

  function applyMode() {
    if (!voiceSupported) state.mode = 'type';
    if (state.mode === 'voice' && voiceSupported) {
      show($('micArea'));
      $('modeBtn').textContent = '切换打字输入';
    } else {
      hide($('micArea'));
    }
  }

  function syncSubmit() {
    $('submitBtn').disabled = !$('answerInput').value.trim();
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
      else if (e.error === 'no-speech') msg = '没有听到声音，请再试一次。';
      $('micHint').textContent = msg;
    };
    rec.onend = function () {
      state.recognizing = false;
      $('micBtn').classList.remove('recording');
      $('micHint').textContent = '点击开始口译，说完自动结束';
    };

    try {
      rec.start();
    } catch (e) { return; }
    state.recognizing = true;
    state.recognition = rec;
    $('micBtn').classList.add('recording');
    $('micHint').textContent = '正在听……说完自动结束（再点一下可手动停止）';
  }

  // ---------- 提交与讲评 ----------
  async function callFeedback(call) {
    hide($('errorCard'));
    show($('loadingCard'));
    try {
      var f = await getFeedback(call.dir, call.source, call.reference, call.userText);
      hide($('loadingCard'));
      renderFeedback(f, call);
    } catch (err) {
      hide($('loadingCard'));
      show($('errorCard'));
      $('errorMsg').textContent = friendlyLLMError(err);
    }
  }

  function renderFeedback(f, call) {
    state.results.push({
      src: call.source, ref: call.reference, user: call.userText,
      verdict: f.verdict || '已完成这句的讲评。',
      highlights: f.highlights, suggestions: f.suggestions
    });
    hide($('inputCard'));
    $('fbVerdict').textContent = f.verdict || '已完成这句的讲评。';

    var html = '<div class="fb-sec"><div class="fb-sec-t">你的翻译</div>' +
      '<div class="fb-user">' + esc(call.userText) + '</div></div>';
    if (f.highlights.length) {
      html += '<div class="fb-sec"><div class="fb-sec-t good">做得好</div>' +
        f.highlights.map(function (h) { return '<div class="fb-li good">' + esc(h) + '</div>'; }).join('') +
        '</div>';
    }
    if (f.suggestions.length) {
      html += '<div class="fb-sec"><div class="fb-sec-t sug">可以更好</div>' +
        f.suggestions.map(function (x) { return '<div class="fb-li sug">' + esc(x) + '</div>'; }).join('') +
        '</div>';
    }
    $('fbBody').innerHTML = html;

    $('refText').textContent = call.reference;
    show($('feedbackCard'));
    $('nextBtn').textContent = state.idx + 1 >= state.queue.length ? '查看本轮回顾' : '下一句';
    window.scrollTo(0, 0);
  }

  function finishRound() {
    var rec = {
      id: Date.now(), ts: Date.now(),
      dir: state.dir, scene: state.scene, level: state.level,
      count: state.results.length,
      durSec: Math.max(1, Math.round((Date.now() - state.startedAt) / 1000)),
      items: state.results
    };
    appendRound(rec);
    renderReport(rec);
  }

  // ---------- 报告页 ----------
  function renderReport(rec) {
    $('reportMeta').textContent = (rec.dir === 'zh2ja' ? '中 → 日' : '日 → 中') +
      ' · ' + LEVELS[rec.level] + ' · ' + SCENES[rec.scene] +
      ' · ' + rec.count + ' 句 · 用时 ' + fmtDur(rec.durSec);
    var html = '';
    rec.items.forEach(function (it, i) {
      html += '<div class="rpt-item card">' +
        '<div class="rpt-head">' +
        '<span class="rpt-idx">第 ' + (i + 1) + ' 句</span>' +
        '<span class="rpt-src">' + esc(it.src) + '</span>' +
        '<span class="rpt-badge">' + esc(it.verdict) + '</span>' +
        '</div><div class="rpt-body">' +
        '<div class="rpt-row"><span>你的翻译</span><p>' + esc(it.user) + '</p></div>' +
        '<div class="rpt-row ref"><span>参考译文</span><p>' + esc(it.ref) + '</p></div>' +
        (it.suggestions.length ? '<div class="rpt-row"><span>教练建议</span><p>' + esc(it.suggestions.join('；')) + '</p></div>' : '') +
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
          return '<div class="rpt-sent"><b>第 ' + (i + 1) + ' 句</b>' + esc(it.src) +
            '<p class="rpt-v">' + esc(it.verdict) + '</p></div>';
        }).join('');
        html += '<div class="rpt-item card">' +
          '<div class="rpt-head">' +
          '<span class="rpt-idx">' + fmtDate(r.ts) + '</span>' +
          '<span class="rpt-src">' + (r.dir === 'zh2ja' ? '中→日' : '日→中') + ' · ' + LEVELS[r.level] + ' · ' + SCENES[r.scene] + ' · ' + r.count + ' 句</span>' +
          '<span class="rpt-badge">' + fmtDur(r.durSec) + '</span>' +
          '</div><div class="rpt-body">' + sents + '</div></div>';
      });
    }
    $('historyList').innerHTML = html;
    go('history');
  }

  // ---------- 事件绑定 ----------
  document.querySelectorAll('.dir-btn').forEach(function (b) {
    b.addEventListener('click', function () {
      document.querySelectorAll('.dir-btn').forEach(function (x) { x.classList.remove('active'); });
      b.classList.add('active');
      state.dir = b.dataset.dir;
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
        dir: state.dir, scene: state.scene, level: state.level,
        count: state.results.length,
        durSec: Math.max(1, Math.round((Date.now() - state.startedAt) / 1000)),
        items: state.results
      };
      appendRound(rec);
      renderHome();
    }
  });

  $('modeBtn').addEventListener('click', function () {
    state.mode = state.mode === 'voice' ? 'type' : 'voice';
    applyMode();
    if (state.mode === 'voice') startRec();
  });

  $('micBtn').addEventListener('click', function () {
    if (state.recognizing && state.recognition) state.recognition.stop();
    else startRec();
  });

  $('answerInput').addEventListener('input', syncSubmit);

  $('submitBtn').addEventListener('click', function () {
    var userText = $('answerInput').value.trim();
    if (!userText) return;
    var s = state.current;
    state.lastCall = {
      dir: state.dir,
      source: currentSrc(s),
      reference: currentRef(s),
      userText: userText
    };
    $('answerInput').readOnly = true;
    $('submitBtn').disabled = true;
    callFeedback(state.lastCall);
  });

  $('retryBtn').addEventListener('click', function () {
    if (state.lastCall) callFeedback(state.lastCall);
  });

  $('nextBtn').addEventListener('click', function () {
    state.idx++;
    if (state.idx >= state.queue.length) finishRound();
    else renderSentence();
  });

  $('speakBtn').addEventListener('click', function () {
    if (state.current) speak(currentSrc(state.current), 'ja-JP', this);
  });
  $('refSpeakBtn').addEventListener('click', function () {
    if (state.lastCall) {
      speak(state.lastCall.reference, state.lastCall.dir === 'zh2ja' ? 'ja-JP' : 'zh-CN', this);
    }
  });

  $('clearBtn').addEventListener('click', function () {
    if (!confirm('确定清空全部练习记录吗？此操作无法恢复。')) return;
    localStorage.removeItem(LOG_KEY);
    renderHistory();
  });

  // 报告/历史列表的展开事件（事件委托，仅绑定一次）
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
