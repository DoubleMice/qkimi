  /* ================= 提示音 & 标题闪烁 ================= */

  var audioCtx = null;
  /* 浏览器自动播放策略:首次点击页面时恢复音频上下文 */
  document.addEventListener('click', function () {
    if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume();
  });

  function playDiDi() {
    if (!state.bell) return;
    try {
      if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      [880, 660].forEach(function (freq, i) {
        var o = audioCtx.createOscillator();
        var g = audioCtx.createGain();
        o.type = 'sine';
        o.frequency.value = freq;
        g.gain.setValueAtTime(0.0001, audioCtx.currentTime + i * 0.12);
        g.gain.exponentialRampToValueAtTime(0.15, audioCtx.currentTime + i * 0.12 + 0.02);
        g.gain.exponentialRampToValueAtTime(0.0001, audioCtx.currentTime + i * 0.12 + 0.11);
        o.connect(g).connect(audioCtx.destination);
        o.start(audioCtx.currentTime + i * 0.12);
        o.stop(audioCtx.currentTime + i * 0.12 + 0.12);
      });
    } catch (e) { /* 无音频环境 */ }
  }

  /* 工具调用发起时：轻柔短促的「嘀」声，不打扰但有存在感 */
  function playToolPop() {
    if (!state.bell) return;
    try {
      if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      var o = audioCtx.createOscillator();
      var g = audioCtx.createGain();
      o.type = 'sine';
      o.frequency.value = 780;
      g.gain.setValueAtTime(0.0001, audioCtx.currentTime);
      g.gain.exponentialRampToValueAtTime(0.07, audioCtx.currentTime + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, audioCtx.currentTime + 0.07);
      o.connect(g).connect(audioCtx.destination);
      o.start(audioCtx.currentTime);
      o.stop(audioCtx.currentTime + 0.08);
    } catch (e) { /* 无音频环境 */ }
  }

  /* 出错时：下行双音，有明显的「不对劲」感 */
  function playErrorBuzz() {
    if (!state.bell) return;
    try {
      if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      [440, 330].forEach(function (freq, i) {
        var o = audioCtx.createOscillator();
        var g = audioCtx.createGain();
        o.type = 'square';
        o.frequency.value = freq;
        g.gain.setValueAtTime(0.0001, audioCtx.currentTime + i * 0.1);
        g.gain.exponentialRampToValueAtTime(0.08, audioCtx.currentTime + i * 0.1 + 0.01);
        g.gain.exponentialRampToValueAtTime(0.0001, audioCtx.currentTime + i * 0.1 + 0.09);
        o.connect(g).connect(audioCtx.destination);
        o.start(audioCtx.currentTime + i * 0.1);
        o.stop(audioCtx.currentTime + i * 0.1 + 0.1);
      });
    } catch (e) { /* 无音频环境 */ }
  }

  /* 上下文血量低于20%时：上行警示双音 */
  function playLowCtxAlert() {
    if (!state.bell) return;
    try {
      if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      [520, 700].forEach(function (freq, i) {
        var o = audioCtx.createOscillator();
        var g = audioCtx.createGain();
        o.type = 'triangle';
        o.frequency.value = freq;
        g.gain.setValueAtTime(0.0001, audioCtx.currentTime + i * 0.15);
        g.gain.exponentialRampToValueAtTime(0.10, audioCtx.currentTime + i * 0.15 + 0.02);
        g.gain.exponentialRampToValueAtTime(0.0001, audioCtx.currentTime + i * 0.15 + 0.14);
        o.connect(g).connect(audioCtx.destination);
        o.start(audioCtx.currentTime + i * 0.15);
        o.stop(audioCtx.currentTime + i * 0.15 + 0.15);
      });
    } catch (e) { /* 无音频环境 */ }
  }

  function flashTitle() {
    if (!document.hidden) return;
    var orig = document.title;
    var on = false;
    clearInterval(state.flashTimer);
    state.flashTimer = setInterval(function () {
      on = !on;
      document.title = on ? '【新消息】Kimi 小月来信啦' : orig;
    }, 800);
  }
  document.addEventListener('visibilitychange', function () {
    if (!document.hidden) {
      clearInterval(state.flashTimer);
      document.title = 'Kimi 2007';
    }
  });
