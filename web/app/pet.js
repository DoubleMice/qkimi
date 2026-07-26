  /* ================= 代码宠物 ================= */

  var petCanvas = $('#petCanvas');
  var petCtx = petCanvas ? petCanvas.getContext('2d') : null;
  var petSprite = new Image();
  var petSpriteReady = false;
  petSprite.addEventListener('load', function () {
    petSpriteReady = true;
    drawPet();
  });
  petSprite.src = 'assets/pet-kimi.png';
  var petMode = 'idle';      /* idle | thinking | working | happy | sad | alert | attention | sleeping
                                | eating | bathing | playing | walking | doze (后五种为互动/自主行为) */
  var petFrame = 0;
  var petIdleTimer = null;
  var petBubbleTimer = null;
  var petBubbleEl = $('#petBubble');
  var petGen = 0;            /* 限时回退定时器世代号：防止旧定时器顶掉新模式 */
  var petHearts = null;      /* 摸头小心心动画 { t: 起始时间戳 } */
  var petHeartTimer = null;
  var petWalkX = 0;          /* walking 模式 canvas 水平位移(CSS px) */
  var petWalkDir = 1;        /* walking 朝向：1 向右 -1 向左 */

  var PET_IDLE_TIMEOUT = 5 * 60 * 1000; /* 5分钟无事件→睡觉 */

  /* 各状态帧数 */
  var PET_FRAMES = { idle: 4, thinking: 2, working: 2, happy: 3, sad: 2, alert: 2, attention: 2, sleeping: 2, eating: 3, bathing: 2, playing: 3, walking: 2, doze: 2 };
  /* 各状态帧速(ms) */
  var PET_FPS = { idle: 600, thinking: 400, working: 200, happy: 180, sad: 500, alert: 150, attention: 400, sleeping: 1200, eating: 300, bathing: 450, playing: 260, walking: 300, doze: 1100 };
  /* 各状态持续后回到 idle 的时长(ms), 0=不自动回退 */
  var PET_DURATION = { idle: 0, thinking: 0, working: 0, happy: 2800, sad: 3500, alert: 4000, attention: 0, sleeping: 0, eating: 3000, bathing: 3000, playing: 3500, walking: 4000, doze: 9000 };
  /* 各状态的气泡文字 */
  var PET_BUBBLE = {
    idle: '', thinking: '🤔 思考中…', working: '⚙️ 工具调用',
    happy: '✅ 完成啦！', sad: '😢 出错了…', alert: '⚠️ 上下文告急！',
    attention: '❓ 需要你的确认', sleeping: '💤 zzz',
    eating: '🐟 啾啾吃鱼…', bathing: '🫧 搓搓洗洗…', playing: '🟣 好耶！',
    walking: '🚶 溜达溜达～', doze: '💤 打个盹…',
  };

  /* 成长值：等级经验阈值（Lv.1-6） */
  var PET_LEVELS = [0, 50, 150, 300, 600, 1000];
  var PET_STORE_KEY = 'kimi2007.pet.v1';
  var PET_POS_KEY = 'kimi2007.pet.pos';
  var PET_DAY_PAT_LIMIT = 50; /* 摸头经验每日上限 */

  /* 养成数值：0-100，随真实时间衰减（含关闭期间，读取时按时间差结算） */
  var PET_STATS = ['hunger', 'clean', 'mood'];
  var PET_STAT_NAMES = { hunger: '饥饿', clean: '清洁', mood: '心情' };
  var PET_STAT_DECAY_MS = { hunger: 2 * 60 * 1000, clean: 3 * 60 * 1000, mood: 4 * 60 * 1000 }; /* 每点所需毫秒 */
  var PET_STAT_RESTORE = 25;   /* 每次互动恢复量 */
  var PET_STAT_LOW = 30;       /* 低于此值冒泡提醒、数值条变红 */
  var PET_REMIND_INTERVAL = 5 * 60 * 1000; /* 低值提醒最小间隔 */
  var petLastRemind = 0;

  function petToday() {
    var d = new Date();
    var m = '0' + (d.getMonth() + 1);
    var day = '0' + d.getDate();
    return d.getFullYear() + '-' + m.slice(-2) + '-' + day.slice(-2);
  }

  /* 读取成长值；隐私模式等异常时从零开始。旧存档缺数值字段时补满值。 */
  function readPetGrowth() {
    var g = { exp: 0, pats: 0, day: petToday(), dayPats: 0, hunger: 100, clean: 100, mood: 100, ts: Date.now(), feeds: 0, baths: 0, plays: 0 };
    try {
      var raw = localStorage.getItem(PET_STORE_KEY);
      if (raw) {
        var saved = JSON.parse(raw);
        if (saved && typeof saved.exp === 'number') {
          g.exp = saved.exp;
          if (typeof saved.pats === 'number') g.pats = saved.pats;
          if (saved.day) g.day = saved.day;
          if (typeof saved.dayPats === 'number') g.dayPats = saved.dayPats;
          PET_STATS.forEach(function (k) { if (typeof saved[k] === 'number') g[k] = saved[k]; });
          if (typeof saved.ts === 'number') g.ts = saved.ts;
          if (typeof saved.feeds === 'number') g.feeds = saved.feeds;
          if (typeof saved.baths === 'number') g.baths = saved.baths;
          if (typeof saved.plays === 'number') g.plays = saved.plays;
        }
      }
    } catch (e) { /* 读取失败则保持默认值 */ }
    /* 跨天重置每日摸头计数 */
    if (g.day !== petToday()) { g.day = petToday(); g.dayPats = 0; }
    /* 离线衰减：按上次结算时间到现在的时间差扣数值 */
    settlePetStats(g, Date.now());
    return g;
  }

  /* 按时间差结算数值衰减（下限 0），并把结算时间推进到 now。
     数值内部保留小数（展示时 Math.round），否则 30s tick 每次不足 1 点会被取整吞掉。 */
  function settlePetStats(g, now) {
    var elapsed = Math.max(0, now - (g.ts || now));
    PET_STATS.forEach(function (k) {
      if (elapsed > 0) g[k] = Math.max(0, g[k] - elapsed / PET_STAT_DECAY_MS[k]);
    });
    g.ts = now;
  }

  var petGrowth = readPetGrowth();

  function savePetGrowth() {
    try { localStorage.setItem(PET_STORE_KEY, JSON.stringify(petGrowth)); } catch (e) { /* 写入失败忽略 */ }
  }

  function petLevel(exp) {
    var lv = 1;
    for (var i = 0; i < PET_LEVELS.length; i++) {
      if (exp >= PET_LEVELS[i]) lv = i + 1;
    }
    return lv;
  }

  /* 悬浮提示：Lv.x · 经验 y/z，满级显示已满级 */
  function updatePetTitle() {
    var petAreaEl = $('#petArea');
    if (!petAreaEl) return;
    var lv = petLevel(petGrowth.exp);
    var next = lv < PET_LEVELS.length ? PET_LEVELS[lv] : null;
    petAreaEl.title = next == null
      ? 'Lv.' + lv + ' · 已满级'
      : 'Lv.' + lv + ' · 经验 ' + petGrowth.exp + '/' + next;
  }

  /* 加经验，返回是否升级；升级时撒花庆祝 */
  function addPetExp(amount) {
    var before = petLevel(petGrowth.exp);
    petGrowth.exp += amount;
    savePetGrowth();
    updatePetTitle();
    var after = petLevel(petGrowth.exp);
    if (after > before) {
      setPetMode('happy');
      showPetBubble('🎉 升级啦！Lv.' + after);
      return true;
    }
    return false;
  }

  /* 摸头计数：+1 经验，每日前 50 次有效，返回是否升级 */
  function patPetGrowth() {
    if (petGrowth.day !== petToday()) { petGrowth.day = petToday(); petGrowth.dayPats = 0; }
    if (petGrowth.dayPats >= PET_DAY_PAT_LIMIT) return false;
    petGrowth.pats += 1;
    petGrowth.dayPats += 1;
    return addPetExp(1);
  }

  /* 刷新悬浮数值卡（悬停条 + pinned 资料卡共用一份 DOM） */
  function updatePetStatsCard() {
    var lv = petLevel(petGrowth.exp);
    var lvEl = $('#petStatsLv');
    if (!lvEl) return;
    lvEl.textContent = 'Lv.' + lv;
    /* 经验条：当前等级区间内的进度；满级拉满 */
    var cur = PET_LEVELS[lv - 1];
    var next = lv < PET_LEVELS.length ? PET_LEVELS[lv] : null;
    var pct = next == null ? 100 : Math.round((petGrowth.exp - cur) / (next - cur) * 100);
    $('#petStatsExpBar').style.width = pct + '%';
    PET_STATS.forEach(function (k) {
      var v = Math.round(petGrowth[k]);
      var bar = { hunger: $('#petBarHunger'), clean: $('#petBarClean'), mood: $('#petBarMood') }[k];
      var num = { hunger: $('#petNumHunger'), clean: $('#petNumClean'), mood: $('#petNumMood') }[k];
      var actionValue = { hunger: $('#petActionFeedValue'), clean: $('#petActionBathValue'), mood: $('#petActionPlayValue') }[k];
      if (bar) { bar.style.width = v + '%'; bar.parentNode.classList.toggle('low', v < PET_STAT_LOW); }
      if (num) num.textContent = v;
      if (actionValue) actionValue.textContent = v;
    });
    var detail = $('#petStatsDetail');
    if (detail) {
      detail.textContent = '经验 ' + petGrowth.exp + (next == null ? '（已满级）' : '/' + next) +
        ' · 摸头 ' + petGrowth.pats + ' 次 · 喂食 ' + petGrowth.feeds +
        ' · 洗澡 ' + petGrowth.baths + ' · 玩耍 ' + petGrowth.plays;
    }
  }

  /* 低值提醒：数值最低项低于阈值时冒泡，5 分钟内不重复 */
  function petStatRemind() {
    if (petMode !== 'idle' || Date.now() - petLastRemind < PET_REMIND_INTERVAL) return;
    var worst = null;
    PET_STATS.forEach(function (k) { if (worst === null || petGrowth[k] < petGrowth[worst]) worst = k; });
    if (worst === null || petGrowth[worst] >= PET_STAT_LOW) return;
    petLastRemind = Date.now();
    var critical = petGrowth[worst] < 15;
    var lines = {
      hunger: critical ? '饿扁了QAQ' : '好饿…想吃东西',
      clean: critical ? '脏得没法见人了！' : '脏兮兮的了…',
      mood: critical ? '再不陪我玩就哭了' : '有点无聊…',
    };
    showPetBubble(lines[worst]);
  }

  /* 数值结算 tick：30s 一次，衰减 + 存档 + 刷新数值卡 + 低值提醒 */
  function petStatTick() {
    settlePetStats(petGrowth, Date.now());
    savePetGrowth();
    updatePetStatsCard();
    petStatRemind();
  }

  /* 喂食/洗澡/玩耍：恢复对应数值 +25、+2 经验；接近满值时拒绝 */
  function petInteract(stat, countKey, mode, refuseText) {
    settlePetStats(petGrowth, Date.now());
    if (petGrowth[stat] >= 98) {
      showPetBubble(refuseText);
      return false;
    }
    petGrowth[stat] = Math.min(100, petGrowth[stat] + PET_STAT_RESTORE);
    petGrowth[countKey] += 1;
    savePetGrowth();
    updatePetStatsCard();
    setPetMode(mode); /* 模式自带气泡；若升级会被 addPetExp 的庆祝顶掉 */
    addPetExp(2);
    return true;
  }

  function petFeed() { return petInteract('hunger', 'feeds', 'eating', '吃不下了～'); }
  function petBath() { return petInteract('clean', 'baths', 'bathing', '已经很干净啦'); }
  function petPlay() { return petInteract('mood', 'plays', 'playing', '现在不想玩'); }

  function setPetMode(mode) {
    if (!petCtx) return;
    /* 离开 walking：清掉 canvas 位移/掉头，避免残留 transform */
    if (mode !== 'walking' && petCanvas) { petCanvas.style.transform = ''; petWalkX = 0; petWalkDir = 1; }
    petMode = mode;
    petFrame = 0;
    petGen++;
    /* 限时模式到时自动回退 idle；世代号防止旧定时器顶掉新模式 */
    var dur = PET_DURATION[mode] || 0;
    if (dur > 0) {
      var gen = petGen;
      setTimeout(function () {
        if (gen === petGen && petMode === mode) setPetMode('idle');
      }, dur);
    }
    showPetBubble(PET_BUBBLE[mode] || '');
    resetPetIdleTimer();
  }

  /* 气泡显隐用 on class（样式见 style.css .pet-bubble） */
  function showPetBubble(text) {
    if (!petBubbleEl) return;
    if (petBubbleTimer) clearTimeout(petBubbleTimer);
    if (!text) { petBubbleEl.classList.remove('on'); return; }
    petBubbleEl.textContent = text;
    petBubbleEl.classList.add('on');
    /* 气泡自动消失，持续时长跟随状态 */
    var duration = PET_DURATION[petMode] || 2500;
    petBubbleTimer = setTimeout(function () { petBubbleEl.classList.remove('on'); }, Math.max(duration, 2000));
  }

  function resetPetIdleTimer() {
    if (petIdleTimer) clearTimeout(petIdleTimer);
    if (petMode === 'sleeping') return;
    petIdleTimer = setTimeout(function () { setPetMode('sleeping'); }, PET_IDLE_TIMEOUT);
  }

  /* 画布按 56×68 的逻辑坐标绘制，展示为 112×136；位图随 DPR 放大，
     让新版插画在 Retina 屏上保持清晰，同时保留状态道具的像素小动画。 */
  var PET_W = 56, PET_H = 68, PET_DISPLAY_SCALE = 2;

  function setupPetCanvas() {
    if (!petCanvas || !petCtx) return;
    var dpr = Math.max(1, window.devicePixelRatio || 1);
    petCanvas.width = PET_W * PET_DISPLAY_SCALE * dpr;
    petCanvas.height = PET_H * PET_DISPLAY_SCALE * dpr;
    petCtx.setTransform(PET_DISPLAY_SCALE * dpr, 0, 0, PET_DISPLAY_SCALE * dpr, 0, 0);
    petCtx.imageSmoothingEnabled = true;
    drawPet();
  }

  /* ===== 像素绘图助手：所有图形落在整数网格上，放大后保持锐利像素风 ===== */
  function pxx(x, y, w, h, color) {
    petCtx.fillStyle = color;
    petCtx.fillRect(Math.round(x), Math.round(y), Math.round(w), Math.round(h));
  }
  /* 实心圆（逐像素栅格化，天然锯齿即像素感） */
  function discPx(cx, cy, r, color) {
    for (var y = Math.floor(cy - r); y <= Math.ceil(cy + r); y++) {
      for (var x = Math.floor(cx - r); x <= Math.ceil(cx + r); x++) {
        var dx = x - cx, dy = y - cy;
        if (dx * dx + dy * dy <= r * r) pxx(x, y, 1, 1, color);
      }
    }
  }
  /* 实心椭圆 */
  function ellPx(cx, cy, rx, ry, color) {
    for (var y = Math.floor(cy - ry); y <= Math.ceil(cy + ry); y++) {
      for (var x = Math.floor(cx - rx); x <= Math.ceil(cx + rx); x++) {
        var dx = (x - cx) / rx, dy = (y - cy) / ry;
        if (dx * dx + dy * dy <= 1) pxx(x, y, 1, 1, color);
      }
    }
  }
  /* 圆环（肥皂泡、张嘴） */
  function ringPx(cx, cy, r, color) {
    for (var y = Math.floor(cy - r); y <= Math.ceil(cy + r); y++) {
      for (var x = Math.floor(cx - r); x <= Math.ceil(cx + r); x++) {
        var d = Math.sqrt((x - cx) * (x - cx) + (y - cy) * (y - cy));
        if (d <= r && d > r - 1.2) pxx(x, y, 1, 1, color);
      }
    }
  }
  /* 点阵字形/图案：map 为字符串行，'1' 即一个像素 */
  function glyphPx(map, x, y, color) {
    for (var r = 0; r < map.length; r++) {
      for (var col = 0; col < map[r].length; col++) {
        if (map[r].charAt(col) === '1') pxx(x + col, y + r, 1, 1, color);
      }
    }
  }
  var PET_GLYPHS = {
    '?': ['01110', '10001', '00001', '00010', '00100', '00100', '00000', '00100'],
    '!': ['00100', '00100', '00100', '00100', '00100', '00100', '00000', '00100'],
    'z': ['01111', '00010', '00100', '01000', '01111'],
    star: ['00100', '00100', '10101', '01110', '10101'],
    spark: ['00100', '01010', '00100'],
  };

  /* 像素小心心：u 为单元格边长 */
  function drawPetHeart(c, x, y, u) {
    var cells = [[-1, -1], [1, -1], [-1, 0], [0, 0], [1, 0], [0, 1]];
    for (var i = 0; i < cells.length; i++) {
      c.fillRect(x + cells[i][0] * u - u / 2, y + cells[i][1] * u - u / 2, u, u);
    }
  }

  /* 绘制宠物当前帧——原创暖萌小企鹅；主形象为细腻插画，状态道具仍保留
     轻巧的像素动画，让它有老式桌面宠物那种随时陪伴的感觉。 */
  function drawPet() {
    if (!petCtx) return;
    var c = petCtx;
    c.clearRect(0, 0, PET_W, PET_H);

    var f = petFrame;
    var bobY = 0, squishX = 0, breathe = 0;
    if (petMode === 'working') bobY = f === 0 ? -2 : 0;
    if (petMode === 'happy') bobY = f === 0 ? -6 : f === 1 ? -3 : 0;
    if (petMode === 'alert') squishX = f === 0 ? -1 : 1;
    if (petMode === 'playing') bobY = f === 1 ? -1 : 0;
    if (petMode === 'idle') {
      breathe = f === 1 ? 0.018 : 0;
      bobY = f === 2 ? -0.5 : f === 3 ? 0.5 : 0;
    }

    var cx = PET_W / 2 + squishX;
    var baseY = 49 + bobY;
    var headY = 29 + bobY;
    var eyeY = headY - 1;
    var eyeOpen = !(petMode === 'sleeping' || petMode === 'doze');

    /* 跳起时阴影收缩，令完成庆祝更有弹性。 */
    var shadowRx = 13, shadowAlpha = 0.14;
    if (petMode === 'happy') {
      shadowRx = f === 0 ? 8 : f === 1 ? 10 : 13;
      shadowAlpha = f === 0 ? 0.05 : f === 1 ? 0.09 : 0.14;
    }
    ellPx(cx, 64, shadowRx, 2, 'rgba(20,35,58,' + shadowAlpha + ')');

    /* 图像加载前保留一个简单轮廓，网络切换时不会出现突兀空白。 */
    if (!petSpriteReady) {
      ellPx(cx, 39 + bobY, 16, 21, '#1c2943');
      ellPx(cx, 36 + bobY, 14, 15, '#fff2c9');
      discPx(cx - 6, 34 + bobY, 2.5, '#17213a');
      discPx(cx + 6, 34 + bobY, 2.5, '#17213a');
      ellPx(cx, 40 + bobY, 3, 2, '#f2b436');
    } else {
      c.save();
      c.translate(cx, PET_H / 2 + bobY);
      c.scale(petMode === 'alert' ? (f === 0 ? 0.97 : 1.03) : 1, 1 + breathe);
      c.drawImage(petSprite, -PET_W / 2, -PET_H / 2, PET_W, PET_H);
      c.restore();
    }

    /* 睡眠时给大眼睛盖上一层小眼皮，避免静态底图显得醒着。 */
    if (!eyeOpen) {
      c.save();
      c.globalAlpha = 0.86;
      ellPx(cx - 8, eyeY, 4.8, 2.8, '#fff0c8');
      ellPx(cx + 8, eyeY, 4.8, 2.8, '#fff0c8');
      c.restore();
      pxx(cx - 11, eyeY, 6, 1, '#2d3a56');
      pxx(cx + 5, eyeY, 6, 1, '#2d3a56');
    }

    if (petMode === 'sad') {
      /* 左眼下的泪光在两帧之间轻轻闪烁。 */
      pxx(cx - 10, eyeY + 5, 2, 2, f === 0 ? '#71d4f6' : 'rgba(113,212,246,.48)');
    }

    if (petMode === 'thinking') {
      glyphPx(PET_GLYPHS['?'], cx - 2, headY - 25 - (f === 1 ? 1 : 0), f === 0 ? '#3364b4' : '#5588cc');
    }
    if (petMode === 'working') {
      /* 身前小终端随帧亮灭，和工具调用状态对应。 */
      pxx(cx - 8, baseY - 2, 16, 8, '#294d7f');
      pxx(cx - 7, baseY - 1, 14, 5, '#d9efff');
      pxx(cx - 5, baseY, 3, 1, f === 0 ? '#4f9be0' : '#70b8ee');
      pxx(cx, baseY, 2, 1, '#4f9be0');
      pxx(cx + 4, baseY, 2, 1, f === 0 ? '#4f9be0' : '#70b8ee');
      pxx(cx - 4, baseY + 6, 8, 1, '#294d7f');
      glyphPx(f === 0 ? PET_GLYPHS.star : PET_GLYPHS.spark, cx - 2, headY - 23, '#6d9fd1');
    }
    if (petMode === 'alert') {
      glyphPx(PET_GLYPHS['!'], cx - 2, headY - 25, f === 0 ? '#cc2222' : '#ff4444');
    }
    if (petMode === 'attention') {
      glyphPx(PET_GLYPHS['?'], cx - 2, headY - 25 - (f === 0 ? 1 : 0), f === 0 ? '#d4880f' : '#f0a830');
    }

    if (petMode === 'eating') {
      /* 企鹅的小鱼会跟着啄食节奏上下轻动。 */
      var fy = headY + 9 + (f === 1 ? 0.5 : 0);
      ellPx(cx + 15, fy, 4.2, 2.6, '#4a86c8');
      ellPx(cx + 15, fy, 3.3, 1.8, '#8ec3ef');
      pxx(cx + 19, fy - 2, 1, 1, '#4a86c8');
      pxx(cx + 19, fy - 1, 2, 1, '#4a86c8');
      pxx(cx + 19, fy, 1, 1, '#4a86c8');
      pxx(cx + 12, fy - 1, 1, 1, '#20304a');
    }
    if (petMode === 'bathing') {
      var bubbles = f === 0
        ? [[cx - 8, headY - 15, 2.2], [cx + 7, headY - 20, 3], [cx + 14, baseY - 7, 1.8]]
        : [[cx - 5, headY - 20, 2.6], [cx + 9, headY - 14, 2], [cx - 14, baseY - 8, 2.2]];
      bubbles.forEach(function (b) {
        ringPx(b[0], b[1], b[2], 'rgba(110,170,225,.85)');
        pxx(b[0] - b[2] / 2, b[1] - b[2] / 2, 1, 1, 'rgba(220,240,255,.9)');
      });
    }
    if (petMode === 'playing') {
      var ballX = cx - 10 + f * 8;
      var ballY = baseY + 8;
      discPx(ballX, ballY, 4, '#ba547f');
      discPx(ballX, ballY, 3.2, '#e787af');
      pxx(ballX - 2, ballY - 1, 4, 1, '#ba547f');
      pxx(ballX - 1, ballY + 1, 3, 1, '#ba547f');
    }
    if (petMode === 'happy' && f < 2) {
      var starColor = f === 0 ? '#f0c020' : '#ffd640';
      glyphPx(PET_GLYPHS.star, cx - 17, headY - 11, starColor);
      glyphPx(PET_GLYPHS.star, cx + 12, headY - 13, starColor);
    }
    if (petMode === 'sleeping' || petMode === 'doze') {
      glyphPx(PET_GLYPHS.z, cx + 11 + f * 2, headY - 14 - f * 3, f === 0 ? 'rgba(100,140,200,.9)' : 'rgba(100,140,200,.5)');
    }

    /* 成长装饰：保留进化感，但把它们贴合到新版企鹅的领结和圆脑袋上。 */
    var petLv = petLevel(petGrowth.exp);
    var overheadMark = petMode === 'thinking' || petMode === 'working' || petMode === 'alert' || petMode === 'attention';
    if (petLv >= 2) glyphPx(PET_GLYPHS.star, cx - 16, headY - 10, '#f0709a');
    if (petLv >= 3 && petLv < 6 && !overheadMark) {
      pxx(cx - 5, headY - 14, 11, 2, '#31415c');
      pxx(cx - 3, headY - 18, 7, 5, '#31415c');
      pxx(cx - 3, headY - 14, 7, 1, '#67aee0');
    }
    if (petLv >= 4) glyphPx(PET_GLYPHS.star, cx - 2, headY + 12, '#f0c020');
    if (petLv >= 5 && eyeOpen) {
      pxx(cx - 13, eyeY - 2, 10, 5, '#23262e');
      pxx(cx + 3, eyeY - 2, 10, 5, '#23262e');
      pxx(cx - 3, eyeY - 1, 6, 1, '#23262e');
    }
    if (petLv >= 6 && !overheadMark) {
      pxx(cx - 6, headY - 18, 12, 3, '#f0c020');
      pxx(cx - 6, headY - 21, 2, 3, '#f0c020');
      pxx(cx - 1, headY - 22, 2, 4, '#f0c020');
      pxx(cx + 4, headY - 21, 2, 3, '#f0c020');
      pxx(cx, headY - 17, 1, 1, '#d04040');
    }

    if (petHearts) {
      var ht = (Date.now() - petHearts.t) / 600;
      if (ht < 1) {
        c.fillStyle = 'rgba(240,80,110,' + (1 - ht).toFixed(2) + ')';
        drawPetHeart(c, cx - 4, headY - 21 - ht * 8, 2);
        if (ht > 0.15) drawPetHeart(c, cx + 5, headY - 18 - (ht - 0.15) * 8, 2);
      }
    }
  }

  /* 宠物动画循环 */
  function tickPet() {
    if (!petCtx) return;
    var frames = PET_FRAMES[petMode] || 1;
    petFrame = (petFrame + 1) % frames;
    drawPet();
    /* walking：canvas 水平折返移动 + 掉头（只动 transform，不影响拖拽落点） */
    if (petMode === 'walking' && petCanvas) {
      petWalkX += petWalkDir * 6;
      if (petWalkX >= 24) { petWalkX = 24; petWalkDir = -1; }
      else if (petWalkX <= -24) { petWalkX = -24; petWalkDir = 1; }
      petCanvas.style.transform = 'translateX(' + petWalkX + 'px) scaleX(' + petWalkDir + ')';
    }
    var fps = PET_FPS[petMode] || 600;
    setTimeout(tickPet, fps);
  }

  /* 自主行为：空闲且状态不差时，随机自言自语 / 走动 / 打盹（仿 QQ 宠物的空闲小动作） */
  var PET_CHATTER = ['今天写点什么好呢', '代码要写注释哦', '(打了个哈欠)', '摸摸我可以加经验哦', '记得按时喝水！', 'bug 退散！', '发呆中…'];
  function petIdleBehavior() {
    setTimeout(function () {
      if (petMode === 'idle' && petGrowth.hunger >= PET_STAT_LOW &&
          petGrowth.clean >= PET_STAT_LOW && petGrowth.mood >= PET_STAT_LOW) {
        var roll = Math.random();
        if (roll < 0.25) setPetMode('walking');
        else if (roll < 0.35) setPetMode('doze');
        else showPetBubble(PET_CHATTER[Math.floor(Math.random() * PET_CHATTER.length)]);
      }
      petIdleBehavior();
    }, 18000 + Math.random() * 22000);
  }

  /* 摸头：冒小心心 + 随机反应气泡 + 成长值 */
  function petPat() {
    if (petMode === 'sleeping') {
      setPetMode('idle');
      showPetBubble('(被戳醒了～)');
      return;
    }
    /* 心形动画用独立短定时器叠加绘制，不打断状态动画循环 */
    petHearts = { t: Date.now() };
    if (petHeartTimer) clearInterval(petHeartTimer);
    petHeartTimer = setInterval(function () {
      if (!petHearts || Date.now() - petHearts.t >= 600) {
        clearInterval(petHeartTimer);
        petHeartTimer = null;
        petHearts = null;
      }
      drawPet();
    }, 100);
    var leveled = patPetGrowth();
    if (!leveled) {
      var reactions = ['啾～', '(｡•̀ᴗ-)✧', '领结歪了吗？', '别闹，码字呢', '(ﾉ>ω<)ﾉ'];
      showPetBubble(reactions[Math.floor(Math.random() * reactions.length)]);
    }
  }

  /* 读取/应用/保存拖拽落点 */
  function readPetPos() {
    try {
      var raw = localStorage.getItem(PET_POS_KEY);
      if (!raw) return null;
      var pos = JSON.parse(raw);
      if (pos && typeof pos.right === 'number' && typeof pos.bottom === 'number' &&
          pos.right >= 0 && pos.right <= 2000 && pos.bottom >= 34 && pos.bottom <= 2000) {
        return pos;
      }
    } catch (e) { /* 读取失败忽略 */ }
    return null;
  }

  function applyPetPos(petAreaEl, right, bottom) {
    petAreaEl.style.right = right + 'px';
    petAreaEl.style.bottom = bottom + 'px';
  }

  function savePetPos(right, bottom) {
    try {
      localStorage.setItem(PET_POS_KEY, JSON.stringify({ right: right, bottom: bottom }));
    } catch (e) { /* 写入失败忽略 */ }
  }

  /* 宠物改为「操作列 + 卡片」整体后，旧的拖拽落点也要保证整组仍在窗口内。 */
  function clampPetPos(petAreaEl, pos) {
    var win = petAreaEl && petAreaEl.closest('.window');
    /* 紧凑布局下宠物 display:none，不能按 0×0 尺寸改写用户保存的位置。 */
    if (!win || !petAreaEl.offsetWidth || !petAreaEl.offsetHeight) return pos;
    var winRect = win.getBoundingClientRect();
    return {
      right: Math.max(0, Math.min(winRect.width - petAreaEl.offsetWidth, pos.right)),
      bottom: Math.max(34, Math.min(winRect.height - petAreaEl.offsetHeight, pos.bottom))
    };
  }

  /* 指针交互：单击=摸头，拖动超过 4px=拖拽换位（相对 .window 定位） */
  function setupPetInteraction(petAreaEl) {
    /* 启动时恢复上次拖拽的位置 */
    var savedPos = readPetPos();
    if (savedPos) {
      var clampedPos = clampPetPos(petAreaEl, savedPos);
      applyPetPos(petAreaEl, clampedPos.right, clampedPos.bottom);
      if (clampedPos.right !== savedPos.right || clampedPos.bottom !== savedPos.bottom) {
        savePetPos(clampedPos.right, clampedPos.bottom);
      }
    }

    var drag = null; /* { startX, startY, startRight, startBottom, moved, bubbleOn } */

    petAreaEl.addEventListener('pointerdown', function (e) {
      /* 只响应左键；右键不显示宠物菜单。 */
      if (e.button !== 0) return;
      /* 点在旁侧操作/数值卡上时不当作摸头或拖拽 */
      if (e.target.closest && e.target.closest('.pet-actions, .pet-stats')) return;
      var win = petAreaEl.closest('.window');
      if (!win) return;
      e.preventDefault();
      var rect = petAreaEl.getBoundingClientRect();
      var winRect = win.getBoundingClientRect();
      drag = {
        startX: e.clientX,
        startY: e.clientY,
        startRight: winRect.right - rect.right,
        startBottom: winRect.bottom - rect.bottom,
        moved: false,
        bubbleOn: false,
      };
    });

    petAreaEl.addEventListener('pointermove', function (e) {
      if (!drag) return;
      if (!drag.moved) {
        if (Math.abs(e.clientX - drag.startX) <= 4 && Math.abs(e.clientY - drag.startY) <= 4) return;
        drag.moved = true;
        try { petAreaEl.setPointerCapture(e.pointerId); } catch (err) { /* 不支持时忽略 */ }
        petAreaEl.classList.add('dragging');
        /* 拖拽期间暂隐气泡，结束后恢复 */
        drag.bubbleOn = !!(petBubbleEl && petBubbleEl.classList.contains('on'));
        if (petBubbleEl) petBubbleEl.classList.remove('on');
      }
      var win = petAreaEl.closest('.window');
      if (!win) return;
      var winRect = win.getBoundingClientRect();
      var right = drag.startRight - (e.clientX - drag.startX);
      var bottom = drag.startBottom - (e.clientY - drag.startY);
      /* 钳制：right≥0、bottom≥34(状态栏26+8)，且不超出 .window 左上边界 */
      right = Math.max(0, Math.min(winRect.width - petAreaEl.offsetWidth, right));
      bottom = Math.max(34, Math.min(winRect.height - petAreaEl.offsetHeight, bottom));
      applyPetPos(petAreaEl, right, bottom);
    });

    petAreaEl.addEventListener('pointerup', function () {
      if (!drag) return;
      var wasMoved = drag.moved;
      var bubbleOn = drag.bubbleOn;
      drag = null;
      if (wasMoved) {
        petAreaEl.classList.remove('dragging');
        if (bubbleOn && petBubbleEl) petBubbleEl.classList.add('on');
        /* 持久化落点 */
        var win = petAreaEl.closest('.window');
        if (win) {
          var rect = petAreaEl.getBoundingClientRect();
          var winRect = win.getBoundingClientRect();
          savePetPos(winRect.right - rect.right, winRect.bottom - rect.bottom);
        }
        return;
      }
      /* 未拖动 = 单击摸头 */
      petPat();
    });

    petAreaEl.addEventListener('pointercancel', function () {
      if (!drag) return;
      var bubbleOn = drag.bubbleOn;
      var wasMoved = drag.moved;
      drag = null;
      if (wasMoved) {
        petAreaEl.classList.remove('dragging');
        if (bubbleOn && petBubbleEl) petBubbleEl.classList.add('on');
      }
    });

    /* 不再提供右键互动菜单，也不让浏览器默认菜单盖住宠物。 */
    petAreaEl.addEventListener('contextmenu', function (e) {
      e.preventDefault();
    });
  }

  /* 互动按钮常驻在宠物旁；前三项直接互动，资料按钮复用统一弹层机制。 */
  function setupPetActions() {
    function bindAction(id, action) {
      var button = $(id);
      if (!button) return;
      button.addEventListener('click', function (e) {
        e.stopPropagation();
        closeAllPopups($('#petStats'));
        action();
      });
    }
    bindAction('#petActionFeed', petFeed);
    bindAction('#petActionBath', petBath);
    bindAction('#petActionPlay', petPlay);

    var infoButton = $('#petActionInfo');
    var stats = $('#petStats');
    if (infoButton && stats) {
      infoButton.addEventListener('click', function (e) {
        /* 阻止冒泡：否则 document 统一关闭逻辑会立刻把刚打开的资料卡关掉。 */
        e.stopPropagation();
        updatePetStatsCard();
        togglePopup(stats, infoButton);
      });
    }
  }

  if (petCtx) {
    setupPetCanvas();
    window.addEventListener('resize', function () {
      setupPetCanvas();
      var petAreaEl = $('#petArea');
      var savedPos = readPetPos();
      if (petAreaEl && savedPos) {
        var clampedPos = clampPetPos(petAreaEl, savedPos);
        applyPetPos(petAreaEl, clampedPos.right, clampedPos.bottom);
        if (clampedPos.right !== savedPos.right || clampedPos.bottom !== savedPos.bottom) {
          savePetPos(clampedPos.right, clampedPos.bottom);
        }
      }
    });
    setTimeout(tickPet, PET_FPS.idle);
    resetPetIdleTimer();
    updatePetTitle();
    updatePetStatsCard();
    setInterval(petStatTick, 30000);
    petIdleBehavior();
    setupPetActions();
    var petAreaEl = $('#petArea');
    if (petAreaEl) setupPetInteraction(petAreaEl);
  }

  /* 测试钩子：smoke/调试用 */
  if (window.__kimi2007) {
    window.__kimi2007.pet = {
      get mode() { return petMode; },
      get spriteLoaded() { return petSpriteReady; },
      set: setPetMode,
      get exp() { return petGrowth.exp; },
      setDuration: function (map) { Object.assign(PET_DURATION, map); },
      get stats() {
        settlePetStats(petGrowth, Date.now());
        return { hunger: petGrowth.hunger, clean: petGrowth.clean, mood: petGrowth.mood };
      },
      feed: petFeed,
      bath: petBath,
      play: petPlay,
      setStats: function (obj) {
        PET_STATS.forEach(function (k) {
          if (obj && typeof obj[k] === 'number') petGrowth[k] = Math.max(0, Math.min(100, obj[k]));
        });
        petGrowth.ts = Date.now();
        savePetGrowth();
        updatePetStatsCard();
      },
    };
  }
