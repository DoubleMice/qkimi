  /* ================= 审批 / 结构化问题 ================= */

  var interactionDomSeq = 0;

  function normalizeApproval(p, sid) {
    var id = p.approval_id || p.approvalId || p.toolCallId || p.tool_call_id || p.id || p.request_id;
    if (!id) return null;
    return {
      approval_id: id,
      session_id: p.session_id || p.sessionId || sid,
      tool_name: p.tool_name || p.toolName || p.name || 'tool',
      action: p.action || p.description || 'Kimi 请求执行一个操作',
      display: p.tool_input_display || p.display || {},
    };
  }

  function normalizeQuestion(p, sid) {
    var id = p.question_id || p.questionId || p.id || p.request_id;
    if (!id || !Array.isArray(p.questions)) return null;
    return {
      question_id: id,
      session_id: p.session_id || p.sessionId || sid,
      questions: p.questions,
    };
  }

  function interactionCard(kind, id) {
    var card = appendMsg('bot', '');
    card.classList.add('interaction-card', kind + '-card');
    card.setAttribute('data-interaction-id', id);
    card.querySelector('.msg-body').textContent = '';
    return card;
  }

  function interactionDisplayText(display) {
    if (!display) return '';
    if (typeof display === 'string') return display;
    if (display.path) return String(display.path);
    if (display.command) return String(display.command);
    try {
      var text = JSON.stringify(display, null, 2);
      return text === '{}' ? '' : text.slice(0, 1200);
    } catch (e) { return ''; }
  }

  function registerApproval(sid, payload) {
    var data = normalizeApproval(payload, sid);
    if (!data || !data.session_id) return;
    var ui = uiFor(data.session_id);
    var existing = ui.approvals[data.approval_id];
    if (existing) existing.data = data;
    else ui.approvals[data.approval_id] = { data: data, card: null, submitting: false };
    if (data.session_id === state.sid) {
      hideTyping();
      renderApprovalRecord(data.session_id, ui.approvals[data.approval_id]);
      renderActivityCenter();
    }
    renderSessionList();
  }

  function renderApprovalRecord(sid, record) {
    if (!record || (record.card && document.contains(record.card))) return;
    var data = record.data;
    var card = interactionCard('approval', data.approval_id);
    record.card = card;
    var body = card.querySelector('.msg-body');
    var shell = document.createElement('div');
    shell.className = 'interaction-shell';
    shell.innerHTML = '<div class="interaction-title">🔐 需要许可</div>' +
      '<div class="interaction-main"></div><div class="interaction-detail"></div>' +
      '<div class="interaction-status" aria-live="polite"></div>' +
      '<div class="interaction-actions"></div>';
    shell.querySelector('.interaction-main').textContent = data.action || data.tool_name;
    var detailText = interactionDisplayText(data.display);
    var detail = shell.querySelector('.interaction-detail');
    if (detailText) detail.textContent = detailText;
    else detail.hidden = true;
    var actions = shell.querySelector('.interaction-actions');
    var yes = document.createElement('button');
    var no = document.createElement('button');
    yes.type = no.type = 'button';
    yes.className = 'ap-btn yes';
    no.className = 'ap-btn no';
    yes.textContent = '✔ 批准';
    no.textContent = '✘ 拒绝';
    actions.appendChild(yes);
    actions.appendChild(no);
    body.appendChild(shell);

    function decide(decision) {
      if (record.submitting) return;
      record.submitting = true;
      yes.disabled = no.disabled = true;
      shell.querySelector('.interaction-status').textContent = '正在提交…';
      api('/sessions/' + encodeURIComponent(sid) + '/approvals/' + encodeURIComponent(data.approval_id), {
        method: 'POST',
        body: JSON.stringify({ decision: decision }),
      }).then(function () {
        settleApproval(sid, data.approval_id, decision === 'approved' ? '✅ 已批准' : '🚫 已拒绝');
      }).catch(function (err) {
        record.submitting = false;
        yes.disabled = no.disabled = false;
        shell.querySelector('.interaction-status').textContent = '提交失败: ' + err.message;
      });
    }
    yes.addEventListener('click', function () { decide('approved'); });
    no.addEventListener('click', function () { decide('rejected'); });
  }

  function settleApproval(sid, id, label) {
    var ui = uiFor(sid);
    var record = ui && ui.approvals[id];
    if (!record) return;
    delete ui.approvals[id];
    if (record.card && document.contains(record.card)) {
      var actions = record.card.querySelector('.interaction-actions');
      if (actions) actions.remove();
      var status = record.card.querySelector('.interaction-status');
      if (status) status.textContent = label;
      record.card.classList.add('resolved');
    }
    if (sid === state.sid) renderActivityCenter();
    renderSessionList();
  }

  function registerQuestion(sid, payload) {
    var data = normalizeQuestion(payload, sid);
    if (!data || !data.session_id) return;
    var ui = uiFor(data.session_id);
    var existing = ui.questions[data.question_id];
    if (existing) existing.data = data;
    else ui.questions[data.question_id] = { data: data, card: null, submitting: false };
    if (data.session_id === state.sid) {
      hideTyping();
      renderQuestionRecord(data.session_id, ui.questions[data.question_id]);
      renderActivityCenter();
    }
    renderSessionList();
  }

  function renderQuestionRecord(sid, record) {
    if (!record || (record.card && document.contains(record.card))) return;
    var data = record.data;
    var card = interactionCard('question', data.question_id);
    record.card = card;
    var body = card.querySelector('.msg-body');
    var shell = document.createElement('div');
    shell.className = 'interaction-shell';
    shell.innerHTML = '<div class="interaction-title">❓ 需要你的选择</div>' +
      '<form class="question-form"></form>' +
      '<div class="interaction-status" aria-live="polite"></div>' +
      '<div class="interaction-actions"></div>';
    var form = shell.querySelector('.question-form');
    var controls = {};

    data.questions.forEach(function (q, qi) {
      var field = document.createElement('fieldset');
      field.className = 'question-block';
      var legend = document.createElement('legend');
      legend.textContent = q.header || ('问题 ' + (qi + 1));
      field.appendChild(legend);
      var prompt = document.createElement('div');
      prompt.className = 'question-prompt';
      prompt.textContent = q.question || '';
      field.appendChild(prompt);
      if (q.body) {
        var note = document.createElement('div');
        note.className = 'question-note';
        note.textContent = q.body;
        field.appendChild(note);
      }
      var name = 'q_' + (++interactionDomSeq);
      var inputs = [];
      (q.options || []).forEach(function (opt) {
        var label = document.createElement('label');
        label.className = 'question-option';
        var choose = document.createElement('input');
        choose.type = q.multi_select ? 'checkbox' : 'radio';
        choose.name = name;
        choose.value = opt.id;
        choose.setAttribute('data-option-id', opt.id);
        label.appendChild(choose);
        var copy = document.createElement('span');
        copy.className = 'question-option-copy';
        var title = document.createElement('span');
        title.className = 'question-option-label';
        title.textContent = opt.label;
        copy.appendChild(title);
        if (opt.recommended || opt.is_recommended) {
          var recommended = document.createElement('span');
          recommended.className = 'question-recommended';
          recommended.textContent = '推荐';
          copy.appendChild(recommended);
        }
        if (opt.description) {
          var desc = document.createElement('span');
          desc.className = 'question-option-desc';
          desc.textContent = opt.description;
          copy.appendChild(desc);
        }
        label.appendChild(copy);
        field.appendChild(label);
        inputs.push(choose);
      });

      var otherChoice = null;
      var otherText = null;
      if (q.allow_other) {
        var otherLabel = document.createElement('label');
        otherLabel.className = 'question-option question-other';
        otherChoice = document.createElement('input');
        otherChoice.type = q.multi_select ? 'checkbox' : 'radio';
        otherChoice.name = name;
        otherChoice.value = '__other__';
        otherLabel.appendChild(otherChoice);
        var otherWrap = document.createElement('span');
        otherWrap.className = 'question-option-copy';
        var otherName = document.createElement('span');
        otherName.className = 'question-option-label';
        otherName.textContent = q.other_label || '其他';
        otherText = document.createElement('input');
        otherText.type = 'text';
        otherText.className = 'question-other-input';
        otherText.placeholder = q.other_description || '请输入其他答案';
        otherText.disabled = true;
        otherWrap.appendChild(otherName);
        otherWrap.appendChild(otherText);
        otherLabel.appendChild(otherWrap);
        field.appendChild(otherLabel);
        otherChoice.addEventListener('change', function () {
          otherText.disabled = !otherChoice.checked;
          if (otherChoice.checked) otherText.focus();
        });
        if (!q.multi_select) {
          inputs.forEach(function (optInput) {
            optInput.addEventListener('change', function () { otherText.disabled = true; });
          });
        }
      }
      controls[q.id] = { question: q, field: field, inputs: inputs, otherChoice: otherChoice, otherText: otherText };
      form.appendChild(field);
    });

    var actions = shell.querySelector('.interaction-actions');
    var submit = document.createElement('button');
    var dismiss = document.createElement('button');
    submit.type = dismiss.type = 'button';
    submit.className = 'ap-btn yes';
    dismiss.className = 'ap-btn no';
    submit.textContent = '提交回答';
    dismiss.textContent = '跳过本次';
    actions.appendChild(submit);
    actions.appendChild(dismiss);
    body.appendChild(shell);

    function setLoading(loading, text) {
      record.submitting = loading;
      Array.prototype.forEach.call(shell.querySelectorAll('input, button'), function (el) { el.disabled = loading; });
      if (!loading) {
        Object.keys(controls).forEach(function (qid) {
          var c = controls[qid];
          if (c.otherText) c.otherText.disabled = !c.otherChoice.checked;
        });
      }
      shell.querySelector('.interaction-status').textContent = text || '';
    }

    function collectAnswers() {
      var answers = {};
      var missing = null;
      Object.keys(controls).some(function (qid) {
        var c = controls[qid];
        var selected = c.inputs.filter(function (el) { return el.checked; }).map(function (el) { return el.value; });
        var hasOther = !!(c.otherChoice && c.otherChoice.checked);
        var other = c.otherText ? c.otherText.value.trim() : '';
        if ((!selected.length && !hasOther) || (hasOther && !other)) {
          missing = c;
          return true;
        }
        if (c.question.multi_select) {
          answers[qid] = hasOther
            ? { kind: 'multi_with_other', option_ids: selected, other_text: other }
            : { kind: 'multi', option_ids: selected };
        } else {
          answers[qid] = hasOther
            ? { kind: 'other', text: other }
            : { kind: 'single', option_id: selected[0] };
        }
        return false;
      });
      if (missing) {
        shell.querySelector('.interaction-status').textContent = '请完成所有问题；选择“其他”时需填写内容。';
        var focusTarget = missing.field.querySelector('input:not(:disabled)');
        if (focusTarget) focusTarget.focus();
        return null;
      }
      return answers;
    }

    submit.addEventListener('click', function () {
      if (record.submitting) return;
      var answers = collectAnswers();
      if (!answers) return;
      setLoading(true, '正在提交回答…');
      api('/sessions/' + encodeURIComponent(sid) + '/questions/' + encodeURIComponent(data.question_id), {
        method: 'POST',
        body: JSON.stringify({ answers: answers, method: 'click' }),
      }).then(function () {
        settleQuestion(sid, data.question_id, '✅ 已回答');
      }).catch(function (err) {
        setLoading(false, '提交失败: ' + err.message);
      });
    });

    dismiss.addEventListener('click', function () {
      if (record.submitting) return;
      setLoading(true, '正在跳过…');
      api('/sessions/' + encodeURIComponent(sid) + '/questions/' + encodeURIComponent(data.question_id) + ':dismiss', {
        method: 'POST',
      }).then(function () {
        settleQuestion(sid, data.question_id, '⏭ 已跳过');
      }).catch(function (err) {
        if (err.code === 40909) {
          settleQuestion(sid, data.question_id, '⏭ 已跳过');
          return;
        }
        setLoading(false, '跳过失败: ' + err.message);
      });
    });
  }

  function settleQuestion(sid, id, label) {
    var ui = uiFor(sid);
    var record = ui && ui.questions[id];
    if (!record) return;
    delete ui.questions[id];
    if (record.card && document.contains(record.card)) {
      Array.prototype.forEach.call(record.card.querySelectorAll('input, button'), function (el) { el.disabled = true; });
      var actions = record.card.querySelector('.interaction-actions');
      if (actions) actions.remove();
      var status = record.card.querySelector('.interaction-status');
      if (status) status.textContent = label;
      record.card.classList.add('resolved');
    }
    if (sid === state.sid) renderActivityCenter();
    renderSessionList();
  }

  function syncInteractionState(sid, approvals, questions) {
    var ui = uiFor(sid);
    var nextApprovals = {};
    approvals.forEach(function (p) {
      var data = normalizeApproval(p, sid);
      if (!data) return;
      var old = ui.approvals[data.approval_id];
      nextApprovals[data.approval_id] = old || { data: data, card: null, submitting: false };
      nextApprovals[data.approval_id].data = data;
    });
    var nextQuestions = {};
    questions.forEach(function (q) {
      var data = normalizeQuestion(q, sid);
      if (!data) return;
      var old = ui.questions[data.question_id];
      nextQuestions[data.question_id] = old || { data: data, card: null, submitting: false };
      nextQuestions[data.question_id].data = data;
    });
    ui.approvals = nextApprovals;
    ui.questions = nextQuestions;
    if (sid === state.sid) renderActivityCenter();
    renderSessionList();
  }

  function renderInteractionCards(sid) {
    if (sid !== state.sid) return;
    $$('.interaction-card').forEach(function (card) { card.remove(); });
    var ui = uiFor(sid);
    Object.keys(ui.approvals).forEach(function (id) {
      ui.approvals[id].card = null;
      renderApprovalRecord(sid, ui.approvals[id]);
    });
    Object.keys(ui.questions).forEach(function (id) {
      ui.questions[id].card = null;
      renderQuestionRecord(sid, ui.questions[id]);
    });
  }
