  /* ---------------- 图片 / 附件上传 ---------------- */
  function uploadFile(file, signal, retried) {
    var fd = new FormData();
    fd.append('file', file, file.name);
    return fetch(ENV.base + '/api/v1/files', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + ENV.token },
      body: fd,
      signal: signal,
    }).then(function (r) {
      if (r.status === 401 && !retried) {
        return refreshRuntimeEnv().then(function () { return uploadFile(file, signal, true); });
      }
      return r.json().then(function (j) {
        if (!r.ok || j.code !== 0) throw new Error(j.msg || ('HTTP ' + r.status));
        return j.data;
      });
    });
  }

  function renderAttachRow() {
    var row = $('#attachRow');
    var sid = state.sid;
    var ui = currentUi();
    /* 全量重建会移除焦点所在的删除按钮；先记住附件 key，重建后把焦点还回去。 */
    var focusKey = null;
    if (document.activeElement && row.contains(document.activeElement)) {
      focusKey = document.activeElement.getAttribute('data-key') || '';
    }
    row.innerHTML = '';
    (ui ? ui.pendingFiles : []).forEach(function (rec) {
      var chip = document.createElement('div');
      chip.className = 'attach-chip ' + rec.status;
      chip.title = rec.status === 'fail' ? rec.error : rec.name;

      if (rec.previewUrl) {
        var img = document.createElement('img');
        img.className = 'attach-thumb';
        img.src = rec.previewUrl;
        img.alt = '';
        chip.appendChild(img);
      }

      var name = document.createElement('span');
      name.className = 'attach-name';
      name.textContent = (rec.status === 'uploading' ? '⏳ ' : rec.status === 'fail' ? '⚠ ' : '📎 ') +
        rec.name + (rec.status === 'fail' ? '（上传失败）' : '');
      chip.appendChild(name);

      var del = document.createElement('button');
      del.type = 'button';
      del.className = 'attach-del';
      del.title = '移除 ' + rec.name;
      del.setAttribute('aria-label', '移除附件 ' + rec.name);
      del.setAttribute('data-key', String(rec.key));
      del.textContent = '✕';
      del.disabled = !!(ui && (ui.submitting || ui.aborting));
      del.addEventListener('click', function () {
        var uploadedId = rec.id;
        rec.discarded = true;
        if (rec.countedAsUploading) {
          ui.uploading = Math.max(0, ui.uploading - 1);
          rec.countedAsUploading = false;
        }
        ui.pendingFiles = ui.pendingFiles.filter(function (x) { return x !== rec; });
        if (rec.previewUrl) URL.revokeObjectURL(rec.previewUrl);
        renderAttachRow();
        updateComposerState();
        if (uploadedId) {
          rec.id = null;
          rec.uploadPromise = deleteTemporaryFile(sid, uploadedId);
          trackDetachedUpload(ui, rec);
        } else {
          trackDetachedUpload(ui, rec);
        }
      });
      chip.appendChild(del);
      row.appendChild(chip);
    });
    row.hidden = !ui || !ui.pendingFiles.length;
    if (focusKey !== null) {
      var nextFocus = focusKey ? row.querySelector('[data-key="' + focusKey + '"]') : null;
      (nextFocus || input).focus();
    }
  }

  function addAttachments(files) {
    var sid = state.sid;
    var ui = uiFor(sid);
    if (!sid || !ui || ui.submitting || ui.aborting) return;
    Array.prototype.forEach.call(files, function (f) {
      var controller = new AbortController();
      var rec = {
        key: ++state.uploadSeq,
        id: null,
        name: f.name || '未命名附件',
        media_type: f.type || 'application/octet-stream',
        size: f.size || 0,
        status: 'uploading',
        error: '',
        previewUrl: f.type && f.type.indexOf('image/') === 0 ? URL.createObjectURL(f) : '',
        controller: controller,
        discarded: false,
        countedAsUploading: true,
        uploadPromise: null,
        uploadTimeout: null,
      };
      ui.pendingFiles.push(rec);
      ui.uploading++;
      rec.uploadTimeout = setTimeout(function () { controller.abort(); }, 120000);
      renderAttachRow();
      updateComposerState();

      rec.uploadPromise = uploadFile(f, controller.signal).then(function (d) {
        rec.controller = null;
        if (rec.discarded || ui.pendingFiles.indexOf(rec) === -1) {
          rec.id = d.id;
          return deleteTemporaryFile(sid, d.id).then(function () { rec.id = null; });
        }
        rec.id = d.id;
        rec.name = d.name || rec.name;
        rec.media_type = d.media_type || rec.media_type || 'application/octet-stream';
        rec.size = d.size == null ? rec.size : d.size;
        rec.status = 'ready';
      }).catch(function (e) {
        rec.controller = null;
        if (rec.discarded || ui.pendingFiles.indexOf(rec) === -1) return;
        rec.status = 'fail';
        rec.error = e.name === 'AbortError' ? '上传超时，请移除后重新选择' : (e.message || '上传失败');
      }).then(function () {
        if (rec.uploadTimeout) {
          clearTimeout(rec.uploadTimeout);
          rec.uploadTimeout = null;
        }
        if (rec.countedAsUploading) {
          ui.uploading = Math.max(0, ui.uploading - 1);
          rec.countedAsUploading = false;
        }
        if (state.sid === sid) {
          renderAttachRow();
          updateComposerState();
        }
      });
    });
  }

  $('#imgBtn').addEventListener('click', function () { $('#fileImage').click(); });
  $('#attachBtn').addEventListener('click', function () { $('#fileAny').click(); });
  $('#fileImage').addEventListener('change', function (e) {
    addAttachments(e.target.files);
    e.target.value = '';
  });
  $('#fileAny').addEventListener('change', function (e) {
    addAttachments(e.target.files);
    e.target.value = '';
  });

  /* 文件可直接拖到输入区；粘贴截图时自动进入附件队列。 */
  var composerEl = $('.composer');
  ['dragenter', 'dragover'].forEach(function (type) {
    composerEl.addEventListener(type, function (e) {
      if (!e.dataTransfer || !e.dataTransfer.types || Array.prototype.indexOf.call(e.dataTransfer.types, 'Files') < 0) return;
      e.preventDefault();
      composerEl.classList.add('drop-target');
    });
  });
  ['dragleave', 'dragend'].forEach(function (type) {
    composerEl.addEventListener(type, function () { composerEl.classList.remove('drop-target'); });
  });
  composerEl.addEventListener('drop', function (e) {
    composerEl.classList.remove('drop-target');
    if (!e.dataTransfer || !e.dataTransfer.files || !e.dataTransfer.files.length) return;
    e.preventDefault();
    addAttachments(e.dataTransfer.files);
  });
  input.addEventListener('paste', function (e) {
    var items = e.clipboardData && e.clipboardData.items;
    if (!items) return;
    var files = [];
    Array.prototype.forEach.call(items, function (item) {
      if (item.kind !== 'file') return;
      var file = item.getAsFile && item.getAsFile();
      if (file) files.push(file);
    });
    if (files.length) addAttachments(files);
  });

  /* ---------------- 发送方式(Enter / Ctrl+Enter) ---------------- */
  var sendModeMenu = $('#sendModeMenu');

  $('#sendMore').addEventListener('click', function (e) {
    e.stopPropagation();
    var open = togglePopup(sendModeMenu, $('#sendMore'));
    if (open) {
      var selected = sendModeMenu.querySelector('.active-mode') || sendModeMenu.querySelector('button');
      if (selected) selected.focus();
    }
  });

  $$('#sendModeMenu .model-opt').forEach(function (opt) {
    var active = opt.getAttribute('data-mode') === state.sendMode;
    if (active) opt.classList.add('active-mode');
    opt.setAttribute('aria-checked', active ? 'true' : 'false');
    opt.addEventListener('click', function () {
      state.sendMode = opt.getAttribute('data-mode');
      localStorage.setItem('kimi2007.sendmode', state.sendMode);
      $$('#sendModeMenu .model-opt').forEach(function (o) { o.classList.remove('active-mode'); });
      opt.classList.add('active-mode');
      $$('#sendModeMenu .model-opt').forEach(function (o) {
        o.setAttribute('aria-checked', o === opt ? 'true' : 'false');
      });
      closePopup(sendModeMenu);
      updateComposerState();
      notifyUi('发送方式：' + (state.sendMode === 'enter' ? 'Enter 发送' : 'Ctrl+Enter 发送，Enter 换行'));
      input.focus();
    });
  });

  /* ---------------- 聊天字号 ---------------- */
  var FONT_LABELS = { 12: '小', 13.5: '标准', 15: '大' };

  function applyFontSize(notify) {
    chatBody.style.fontSize = state.fontSize + 'px';
    $('#fontBtn').title = '聊天字号: ' + FONT_LABELS[state.fontSize] + '(' + state.fontSize + 'px),点击切换';
    $('#fontBtn').setAttribute('aria-label', $('#fontBtn').title);
    $('#fontBtn').setAttribute('data-size', FONT_LABELS[state.fontSize]);
    if (notify) notifyUi('聊天字号：' + FONT_LABELS[state.fontSize] + '（' + state.fontSize + 'px）');
  }

  applyFontSize(false);

  $('#fontBtn').addEventListener('click', function () {
    var i = FONT_SIZES.indexOf(state.fontSize);
    state.fontSize = FONT_SIZES[(i + 1) % FONT_SIZES.length];
    localStorage.setItem('kimi2007.font', String(state.fontSize));
    applyFontSize(true);
  });
