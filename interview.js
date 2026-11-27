(() => {
  const CONFIG_KEY = "ai_frontier_forge_interview_config_v1";
  const RECORDS_KEY = "ai_frontier_forge_interview_records_v1";
  const DEFAULT_TIMER_SEC = 180;
  const MAX_FOLLOWUP_ROUNDS = 2;

  const PRESETS = {
    deepseek: {
      id: "deepseek",
      label: "DeepSeek",
      baseUrl: "https://api.deepseek.com/v1",
      model: "deepseek-chat",
    },
    siliconflow: {
      id: "siliconflow",
      label: "硅基流动 SiliconFlow",
      baseUrl: "https://api.siliconflow.cn/v1",
      model: "deepseek-ai/DeepSeek-V3",
    },
    openai: {
      id: "openai",
      label: "OpenAI",
      baseUrl: "https://api.openai.com/v1",
      model: "gpt-4o-mini",
    },
    custom: {
      id: "custom",
      label: "自定义 Compatible",
      baseUrl: "",
      model: "",
    },
  };

  const TRACK_LABELS = {
    engineering: "工程落地",
    consulting: "咨询方案",
    both: "工程+咨询双修",
  };

  let hooks = {
    getQuestionById: () => null,
    showToast: () => {},
    onStatsChange: () => {},
    escapeHtml: defaultEscapeHtml,
    renderInlineMarkdown: defaultRenderInlineMarkdown,
  };

  let config = loadConfig();
  let records = loadRecords();

  const timerState = Object.create(null); // qid -> { remainingSec, running, deadlineTs }
  const activeIntervals = new Map(); // qid -> intervalId (legacy card timers if any)
  let studioTimerInterval = null;

  const panelState = Object.create(null); // qid -> transient live session state
  const draftTimers = new Map(); // qid -> timeoutId

  const studioState = {
    open: false,
    questionId: null,
    leftTab: "answer", // 'answer' | 'reference'
    rightTab: "live", // 'live' | 'archive'
    selectedArchiveIdx: null,
  };

  const archiveState = {
    open: false,
    filter: "all", // 'all' | 'ai' | 'self'
    selectedKey: null, // `${qid}::${attemptIndex}`
  };

  let modalActivePreset = config.preset || "deepseek";
  let modalsMounted = false;
  let globalEscBound = false;

  // ==================== Helpers ====================

  function defaultEscapeHtml(str) {
    return String(str || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function defaultRenderInlineMarkdown(str) {
    return defaultEscapeHtml(str)
      .replace(/`([^`]+)`/g, '<code class="inline-code">$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  }

  function esc(str) {
    return hooks.escapeHtml(str);
  }

  function md(str) {
    return hooks.renderInlineMarkdown(str);
  }

  function pad2(n) {
    return String(n).padStart(2, "0");
  }

  function formatDateTime(ts) {
    const d = new Date(Number(ts) || Date.now());
    if (Number.isNaN(d.getTime())) return "--";
    return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  }

  function formatFilenameStamp(ts) {
    const d = new Date(Number(ts) || Date.now());
    const safe = Number.isNaN(d.getTime()) ? new Date() : d;
    return `${safe.getFullYear()}${pad2(safe.getMonth() + 1)}${pad2(safe.getDate())}-${pad2(safe.getHours())}${pad2(safe.getMinutes())}`;
  }

  function loadConfig() {
    try {
      const raw = localStorage.getItem(CONFIG_KEY);
      if (!raw) {
        return { preset: "deepseek", baseUrl: "", apiKey: "", model: "" };
      }
      const parsed = JSON.parse(raw);
      return {
        preset: typeof parsed.preset === "string" ? parsed.preset : "custom",
        baseUrl: typeof parsed.baseUrl === "string" ? parsed.baseUrl : "",
        apiKey: typeof parsed.apiKey === "string" ? parsed.apiKey : "",
        model: typeof parsed.model === "string" ? parsed.model : "",
      };
    } catch {
      return { preset: "deepseek", baseUrl: "", apiKey: "", model: "" };
    }
  }

  function saveConfig(nextConfig) {
    config = {
      preset: nextConfig.preset || "custom",
      baseUrl: String(nextConfig.baseUrl || "").trim(),
      apiKey: String(nextConfig.apiKey || "").trim(),
      model: String(nextConfig.model || "").trim(),
    };
    try {
      localStorage.setItem(CONFIG_KEY, JSON.stringify(config));
    } catch {
      // Ignore storage quota / privacy mode errors
    }
  }

  function clearConfig() {
    config = { preset: "deepseek", baseUrl: "", apiKey: "", model: "" };
    try {
      localStorage.removeItem(CONFIG_KEY);
    } catch {
      // Ignore storage errors
    }
  }

  function isByokConfigured() {
    return Boolean(config.baseUrl.trim() && config.apiKey.trim() && config.model.trim());
  }

  function loadRecords() {
    try {
      const raw = localStorage.getItem(RECORDS_KEY);
      if (!raw) return {};
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }

  function saveRecords() {
    try {
      localStorage.setItem(RECORDS_KEY, JSON.stringify(records));
    } catch {
      // Ignore storage quota errors
    }
  }

  function ensureRecord(qid) {
    if (!records[qid] || typeof records[qid] !== "object") {
      records[qid] = { draft: "", attempts: [] };
    }
    if (typeof records[qid].draft !== "string") {
      records[qid].draft = "";
    }
    if (!Array.isArray(records[qid].attempts)) {
      records[qid].attempts = [];
    }
    return records[qid];
  }

  function ensurePanelState(qid) {
    if (!panelState[qid]) {
      panelState[qid] = {
        selfEvalOpen: false,
        selfEvalAnswer: "",
        checkedIndices: new Set(),
        selfEvalSaved: false,
        lastSavedSelfAttemptIdx: null,
        aiLoading: false,
        aiError: null,
        aiSession: null,
      };
    }
    return panelState[qid];
  }

  function ensureTimer(qid) {
    if (!timerState[qid]) {
      timerState[qid] = {
        remainingSec: DEFAULT_TIMER_SEC,
        running: false,
        deadlineTs: null,
      };
    }
    return timerState[qid];
  }

  function getRemainingSec(qid) {
    const t = ensureTimer(qid);
    if (t.running && t.deadlineTs) {
      const rem = Math.max(0, Math.ceil((t.deadlineTs - Date.now()) / 1000));
      t.remainingSec = rem;
      if (rem <= 0) {
        t.running = false;
        t.deadlineTs = null;
      }
      return rem;
    }
    return t.remainingSec;
  }

  function formatTime(sec) {
    const safe = Math.max(0, Math.floor(sec));
    const m = Math.floor(safe / 60);
    const s = safe % 60;
    return `${pad2(m)}:${pad2(s)}`;
  }

  function getScoreClass(score) {
    if (score >= 80) return "mock-score-high";
    if (score >= 60) return "mock-score-mid";
    return "mock-score-low";
  }

  function buildChatCompletionsUrl(baseUrl) {
    const clean = String(baseUrl || "").trim().replace(/\/+$/, "");
    if (!clean) return "";
    if (/\/chat\/completions$/i.test(clean)) return clean;
    return `${clean}/chat/completions`;
  }

  function copyTextToClipboard(text) {
    if (navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
      return navigator.clipboard.writeText(text).catch(() => fallbackCopy(text));
    }
    return fallbackCopy(text);
  }

  function fallbackCopy(text) {
    return new Promise((resolve, reject) => {
      try {
        const ta = document.createElement("textarea");
        ta.value = text;
        ta.setAttribute("readonly", "");
        ta.style.position = "fixed";
        ta.style.top = "-9999px";
        ta.style.left = "-9999px";
        document.body.appendChild(ta);
        ta.focus();
        ta.select();
        const ok = document.execCommand("copy");
        ta.remove();
        if (ok) resolve();
        else reject(new Error("execCommand copy failed"));
      } catch (err) {
        reject(err);
      }
    });
  }

  function triggerDownload(filename, content, mimeType) {
    const blob = new Blob([content], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.style.display = "none";
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1200);
  }

  function syncBodyScrollLock() {
    const settingsModal = document.getElementById("aiSettingsModal");
    const settingsOpen = Boolean(settingsModal && !settingsModal.classList.contains("hidden"));
    const anyOpen = studioState.open || archiveState.open || settingsOpen;
    document.body.style.overflow = anyOpen ? "hidden" : "";
  }

  function updateTopbarButton() {
    const btn = document.getElementById("aiSettingsBtn");
    if (!btn) return;
    if (isByokConfigured()) {
      btn.innerHTML = `<span class="ai-status-dot connected" aria-hidden="true"></span><span>🤖 AI 面试官：${esc(config.model)}</span>`;
      btn.title = `当前已配置：${config.model}（点击修改或测试连接）`;
    } else {
      btn.innerHTML = `<span class="ai-status-dot" aria-hidden="true"></span><span>🤖 AI 面试官（免 Key / 配置）</span>`;
      btn.title = "配置 AI 模拟面试官（可选 BYOK，不配置也可免 Key 自评）";
    }
  }

  function resolveQuestion(qid) {
    const found = hooks.getQuestionById(qid);
    if (found) return found;
    return {
      id: qid,
      title: `题目 ${qid}`,
      scenario: "",
      reference_answer: "",
      key_points: [],
      follow_up_questions: [],
      common_mistakes: "",
      topic: "未分类",
      difficulty: "-",
      track: "",
      source_title: "",
      source_url: "",
    };
  }

  // ==================== Public API: Open State & Stats ====================

  function isOpen(questionId) {
    return studioState.open && studioState.questionId === questionId;
  }

  function setOpen(questionId, bool) {
    if (bool) {
      openStudio(questionId);
      return true;
    }
    if (studioState.open && studioState.questionId === questionId) {
      closeStudio();
    }
    return false;
  }

  function toggleOpen(questionId) {
    if (studioState.open && studioState.questionId === questionId) {
      closeStudio();
      return false;
    }
    openStudio(questionId);
    return true;
  }

  function getQuestionSummary(questionId) {
    const rec = records[questionId];
    const attempts = rec && Array.isArray(rec.attempts) ? rec.attempts : [];
    if (!attempts.length) {
      return { attemptsCount: 0, bestScore: null, lastScore: null, lastMode: null };
    }
    let bestScore = null;
    for (const a of attempts) {
      const s = Number(a.score);
      if (Number.isFinite(s)) {
        bestScore = bestScore === null ? s : Math.max(bestScore, s);
      }
    }
    const last = attempts[attempts.length - 1];
    const lastScoreNum = Number(last.score);
    return {
      attemptsCount: attempts.length,
      bestScore,
      lastScore: Number.isFinite(lastScoreNum) ? lastScoreNum : null,
      lastMode: last.mode === "ai" ? "ai" : "self",
    };
  }

  function getStats() {
    let totalAttempts = 0;
    let attemptedQuestions = 0;
    let scoreSum = 0;
    let scoreCount = 0;

    for (const qid of Object.keys(records)) {
      const rec = records[qid];
      const attempts = rec && Array.isArray(rec.attempts) ? rec.attempts : [];
      if (attempts.length > 0) {
        attemptedQuestions += 1;
        totalAttempts += attempts.length;
        for (const a of attempts) {
          const s = Number(a.score);
          if (Number.isFinite(s)) {
            scoreSum += s;
            scoreCount += 1;
          }
        }
      }
    }

    const hasByok = isByokConfigured();
    return {
      totalAttempts,
      attemptedQuestions,
      avgScore: scoreCount > 0 ? Math.round(scoreSum / scoreCount) : null,
      hasByok,
      modelName: hasByok ? config.model : "",
    };
  }

  // ==================== Timers ====================

  function stopStudioTimerInterval() {
    if (studioTimerInterval !== null) {
      clearInterval(studioTimerInterval);
      studioTimerInterval = null;
    }
  }

  function cleanupTimers() {
    for (const id of activeIntervals.values()) {
      clearInterval(id);
    }
    activeIntervals.clear();
    // Preserve live Studio modal timer while Studio is open during background card re-renders
    if (!studioState.open) {
      stopStudioTimerInterval();
    }
  }

  function syncStudioTimerDom(qid) {
    const root = document.getElementById("interviewStudioModal");
    if (!root || !studioState.open || studioState.questionId !== qid) return;
    const t = ensureTimer(qid);
    const rem = getRemainingSec(qid);
    const displayEl = root.querySelector(".mock-timer-display");
    const toggleBtn = root.querySelector(".mock-timer-toggle-btn");

    if (displayEl) {
      displayEl.textContent = formatTime(rem);
      displayEl.classList.toggle("is-expired", rem <= 0);
      displayEl.classList.toggle("is-warning", rem > 0 && rem <= 30);
    }
    if (toggleBtn) {
      if (t.running) {
        toggleBtn.textContent = "⏸ 暂停计时";
      } else if (rem <= 0) {
        toggleBtn.textContent = "▶ 重新计时";
      } else if (rem < DEFAULT_TIMER_SEC) {
        toggleBtn.textContent = "▶ 继续计时";
      } else {
        toggleBtn.textContent = "▶ 开始 3 分钟计时";
      }
    }
  }

  function attachStudioTimerInterval(qid) {
    stopStudioTimerInterval();
    const t = ensureTimer(qid);
    if (!t.running) {
      syncStudioTimerDom(qid);
      return;
    }

    const tick = () => {
      if (!studioState.open || studioState.questionId !== qid) {
        stopStudioTimerInterval();
        return;
      }
      const rem = getRemainingSec(qid);
      syncStudioTimerDom(qid);
      if (rem <= 0) {
        stopStudioTimerInterval();
        hooks.showToast("⏰ 3 分钟模拟作答时间到，可以提交自评或请 AI 打分啦！");
      }
    };

    tick();
    if (ensureTimer(qid).running) {
      studioTimerInterval = setInterval(tick, 500);
    }
  }

  function pauseTimer(qid) {
    const t = ensureTimer(qid);
    if (t.running) {
      t.remainingSec = getRemainingSec(qid);
      t.running = false;
      t.deadlineTs = null;
      stopStudioTimerInterval();
      syncStudioTimerDom(qid);
    }
  }

  // ==================== Export Markdown & Offline Print/PDF ====================

  function buildReportMarkdown(question, attempt) {
    const modeLabel = attempt.mode === "ai" ? "AI 面试官打分与追问" : "采分点自评";
    const trackLabel = TRACK_LABELS[question.track] || question.track || "综合";
    const lines = [
      `# 模拟面试复盘报告：${question.title || question.id}`,
      "",
      `- **题目 ID**：\`${question.id || ""}\``,
      `- **专题 / 难度 / 赛道**：${question.topic || "-"} / ${question.difficulty || "-"} / ${trackLabel}`,
      `- **演练时间**：${formatDateTime(attempt.ts)}`,
      `- **评估模式**：${modeLabel}${attempt.mode === "ai" && attempt.model ? `（${attempt.model}）` : ""}`,
      `- **综合得分**：**${attempt.score ?? "--"} / 100**`,
    ];

    if (attempt.mode === "ai" && attempt.aiFeedback && attempt.aiFeedback.verdict) {
      lines.push(`- **一句话总评**：${attempt.aiFeedback.verdict}`);
    }

    lines.push(
      "",
      "## 1. 实战 / 面试场景",
      "",
      question.scenario || "（无场景描述）",
      "",
      "## 2. 候选人首轮作答",
      "",
      attempt.answer ? attempt.answer.trim() : "（空）",
      "",
      "## 3. 采分点评估与反馈",
      ""
    );

    if (attempt.mode === "ai" && attempt.aiFeedback) {
      const fb = attempt.aiFeedback;
      lines.push("### 命中采分点");
      if (fb.hit_points && fb.hit_points.length) {
        fb.hit_points.forEach((pt) => lines.push(`- [x] ${pt}`));
      } else {
        lines.push("- （无明确命中项）");
      }
      lines.push("", "### 遗漏 / 薄弱点");
      if (fb.missed_points && fb.missed_points.length) {
        fb.missed_points.forEach((pt) => lines.push(`- [ ] ${pt}`));
      } else {
        lines.push("- （核心要点基本覆盖）");
      }
      lines.push("", "### 面试官点评与改进建议", "", fb.feedback || "（无）");
    } else {
      const checkedSet = new Set(Array.isArray(attempt.checkedIndices) ? attempt.checkedIndices : []);
      const kps = Array.isArray(question.key_points) ? question.key_points : [];
      if (kps.length) {
        kps.forEach((pt, idx) => {
          lines.push(`- [${checkedSet.has(idx) ? "x" : " "}] ${pt}`);
        });
      } else {
        lines.push("- （本题无预设采分点）");
      }
    }

    if (Array.isArray(attempt.followUps) && attempt.followUps.length > 0) {
      lines.push("", "## 4. 面试官连环追问完整对话记录", "");
      attempt.followUps.forEach((msg, idx) => {
        const speaker = msg.role === "interviewer" ? "🤖 AI 面试官" : "🧑‍💻 候选人";
        lines.push(`### ${idx + 1}. ${speaker}`, "", msg.text || "", "");
      });
    }

    lines.push("## 5. 参考高分回答与原文溯源", "");
    if (question.reference_answer) {
      lines.push(question.reference_answer, "");
    }
    if (question.common_mistakes) {
      lines.push("### 常见踩坑答法", "", question.common_mistakes, "");
    }
    if (question.source_url) {
      lines.push(`**原文来源**：[${question.source_title || question.source_url}](${question.source_url})`);
    }
    lines.push(
      "",
      "---",
      "> 由 **AI Frontier Forge** 模拟面试室生成 · 免费在线刷题与前沿周报：https://atcxigua.github.io/ai-frontier-forge/"
    );

    return lines.join("\n");
  }

  function exportReportMarkdown(question, attempt) {
    if (!question || !attempt) return;
    const safeQid = String(question.id || "question").replace(/[^a-zA-Z0-9_-]/g, "_");
    const stamp = formatFilenameStamp(attempt.ts);
    const filename = `ai-forge-report-${safeQid}-${stamp}.md`;
    const content = "\uFEFF" + buildReportMarkdown(question, attempt);
    triggerDownload(filename, content, "text/markdown;charset=utf-8");
    window.ForgeAnalytics?.track?.("report_exported", { format: "md", qid: question.id });
    hooks.showToast(`已导出 Markdown 报告：${filename}`);
  }

  function buildPrintReportHtml(question, attempt) {
    const modeLabel = attempt.mode === "ai" ? "AI 面试官打分与追问" : "采分点自评";
    const trackLabel = TRACK_LABELS[question.track] || question.track || "综合";
    const score = Number.isFinite(Number(attempt.score)) ? Number(attempt.score) : 0;
    const scoreColor = score >= 80 ? "#047857" : score >= 60 ? "#b45309" : "#b91c1c";
    const scoreBg = score >= 80 ? "#ecfdf5" : score >= 60 ? "#fffbeb" : "#fef2f2";

    let evalSectionHtml = "";
    if (attempt.mode === "ai" && attempt.aiFeedback) {
      const fb = attempt.aiFeedback;
      const hitHtml =
        fb.hit_points && fb.hit_points.length
          ? `<ul>${fb.hit_points.map((x) => `<li>${defaultRenderInlineMarkdown(x)}</li>`).join("")}</ul>`
          : `<p class="muted">暂无明显命中要点</p>`;
      const missHtml =
        fb.missed_points && fb.missed_points.length
          ? `<ul>${fb.missed_points.map((x) => `<li>${defaultRenderInlineMarkdown(x)}</li>`).join("")}</ul>`
          : `<p class="muted">核心采分点基本覆盖</p>`;

      evalSectionHtml = `
        <div class="section">
          <h2>3. AI 面试官评分与反馈</h2>
          ${fb.verdict ? `<p class="verdict">总评：${defaultEscapeHtml(fb.verdict)}</p>` : ""}
          <div class="grid-2">
            <div class="box box-hit">
              <h3>✅ 命中采分点</h3>
              ${hitHtml}
            </div>
            <div class="box box-miss">
              <h3>⚠️ 遗漏 / 薄弱点</h3>
              ${missHtml}
            </div>
          </div>
          <div class="box" style="margin-top: 10px;">
            <h3>💡 改进建议</h3>
            <p class="pre-line">${defaultRenderInlineMarkdown(fb.feedback || "")}</p>
          </div>
        </div>`;
    } else {
      const checkedSet = new Set(Array.isArray(attempt.checkedIndices) ? attempt.checkedIndices : []);
      const kps = Array.isArray(question.key_points) ? question.key_points : [];
      const items = kps
        .map(
          (pt, idx) =>
            `<li class="${checkedSet.has(idx) ? "kp-hit" : "kp-miss"}">${checkedSet.has(idx) ? "✅" : "⬜"} ${defaultRenderInlineMarkdown(pt)}</li>`
        )
        .join("");
      evalSectionHtml = `
        <div class="section">
          <h2>3. 采分点自评清单</h2>
          <ul class="kp-list">${items || "<li>无预设采分点</li>"}</ul>
        </div>`;
    }

    const followUps = Array.isArray(attempt.followUps) ? attempt.followUps : [];
    const transcriptHtml = followUps.length
      ? `
        <div class="section">
          <h2>4. 面试官连环追问完整对话记录</h2>
          ${followUps
            .map((m) => {
              const isAi = m.role === "interviewer";
              return `
                <div class="msg ${isAi ? "msg-ai" : "msg-user"}">
                  <div class="msg-role">${isAi ? "🤖 AI 面试官" : "🧑‍💻 候选人"}</div>
                  <div class="pre-line">${defaultRenderInlineMarkdown(m.text || "")}</div>
                </div>`;
            })
            .join("")}
        </div>`
      : "";

    const refHtml = `
      <div class="section">
        <h2>${followUps.length ? "5" : "4"}. 参考高分回答与原文溯源</h2>
        <div class="box">
          <p class="pre-line">${defaultRenderInlineMarkdown(question.reference_answer || "（无）")}</p>
        </div>
        ${
          question.common_mistakes
            ? `<div class="box" style="margin-top: 8px;">
                 <h3>常见踩坑答法</h3>
                 <p class="pre-line">${defaultRenderInlineMarkdown(question.common_mistakes)}</p>
               </div>`
            : ""
        }
        ${
          question.source_url
            ? `<p class="muted" style="margin-top: 8px;">原文来源：${defaultEscapeHtml(question.source_title || "")}（${defaultEscapeHtml(question.source_url)}）</p>`
            : ""
        }
      </div>`;

    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <title>模拟面试复盘报告 - ${defaultEscapeHtml(question.title || question.id)}</title>
  <style>
    * { box-sizing: border-box; }
    body {
      margin: 0;
      padding: 28px 32px;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
      color: #0f172a;
      background: #ffffff;
      line-height: 1.65;
      font-size: 13.5px;
    }
    .header {
      display: flex;
      justify-content: space-between;
      align-items: flex-start;
      gap: 16px;
      border-bottom: 2px solid #e2e8f0;
      padding-bottom: 14px;
      margin-bottom: 18px;
    }
    h1 { margin: 0 0 6px; font-size: 20px; line-height: 1.35; }
    h2 { margin: 0 0 8px; font-size: 15px; color: #1e293b; border-left: 3px solid #4f46e5; padding-left: 8px; }
    h3 { margin: 0 0 6px; font-size: 13px; color: #334155; }
    .meta { font-size: 12px; color: #475569; }
    .score-pill {
      padding: 8px 16px;
      border-radius: 10px;
      background: ${scoreBg};
      color: ${scoreColor};
      border: 1px solid ${scoreColor}44;
      text-align: center;
      flex-shrink: 0;
    }
    .score-pill strong { display: block; font-size: 24px; line-height: 1.1; }
    .score-pill span { font-size: 11px; }
    .section { margin-bottom: 18px; }
    .box {
      padding: 12px 14px;
      border: 1px solid #e2e8f0;
      border-radius: 8px;
      background: #f8fafc;
      page-break-inside: avoid;
    }
    .box-hit { background: #f0fdf4; border-color: #bbf7d0; }
    .box-miss { background: #fffbeb; border-color: #fde68a; }
    .grid-2 { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
    .verdict { font-weight: 700; margin: 0 0 10px; color: #1e293b; }
    .pre-line { white-space: pre-line; margin: 0; }
    .muted { color: #64748b; font-size: 12px; }
    ul { margin: 4px 0 0; padding-left: 18px; }
    li { margin-bottom: 4px; }
    .kp-list { list-style: none; padding-left: 0; }
    .kp-hit { color: #065f46; }
    .kp-miss { color: #475569; }
    .msg {
      padding: 10px 12px;
      border-radius: 8px;
      margin-bottom: 8px;
      border: 1px solid #e2e8f0;
      page-break-inside: avoid;
    }
    .msg-ai { background: #eef2ff; border-color: #c7d2fe; }
    .msg-user { background: #f8fafc; border-color: #cbd5e1; }
    .msg-role { font-size: 11.5px; font-weight: 700; color: #334155; margin-bottom: 4px; }
    code.inline-code { background: #e2e8f0; padding: 1px 4px; border-radius: 4px; font-size: 12px; }
    .footer { margin-top: 22px; padding-top: 10px; border-top: 1px solid #e2e8f0; font-size: 11px; color: #64748b; display: flex; justify-content: space-between; }
    @media print {
      body { padding: 0; }
      @page { margin: 14mm; }
    }
  </style>
</head>
<body>
  <div class="header">
    <div>
      <h1>${defaultEscapeHtml(question.title || question.id)}</h1>
      <div class="meta">
        ID: ${defaultEscapeHtml(question.id || "")} · 专题: ${defaultEscapeHtml(question.topic || "-")} · 难度: ${defaultEscapeHtml(question.difficulty || "-")} · 赛道: ${defaultEscapeHtml(trackLabel)}<br/>
        演练时间: ${defaultEscapeHtml(formatDateTime(attempt.ts))} · 模式: ${defaultEscapeHtml(modeLabel)}
      </div>
    </div>
    <div class="score-pill">
      <strong>${score}</strong>
      <span>综合得分 / 100</span>
    </div>
  </div>

  <div class="section">
    <h2>1. 实战 / 面试场景</h2>
    <div class="box"><p class="pre-line">${defaultRenderInlineMarkdown(question.scenario || "（无）")}</p></div>
  </div>

  <div class="section">
    <h2>2. 候选人首轮作答</h2>
    <div class="box"><p class="pre-line">${defaultEscapeHtml(attempt.answer || "（空）")}</p></div>
  </div>

  ${evalSectionHtml}
  ${transcriptHtml}
  ${refHtml}

  <div class="footer">
    <span>由 AI Frontier Forge 模拟面试室生成 · 免费在线刷题与前沿周报：https://atcxigua.github.io/ai-frontier-forge/</span>
    <span>导出时间：${defaultEscapeHtml(formatDateTime(Date.now()))}</span>
  </div>
</body>
</html>`;
  }

  function printReportPdf(question, attempt) {
    if (!question || !attempt) return;
    window.ForgeAnalytics?.track?.("report_exported", { format: "pdf", qid: question.id });
    const oldFrame = document.getElementById("forgePrintFrame");
    if (oldFrame) oldFrame.remove();

    const iframe = document.createElement("iframe");
    iframe.id = "forgePrintFrame";
    iframe.style.position = "fixed";
    iframe.style.right = "0";
    iframe.style.bottom = "0";
    iframe.style.width = "0";
    iframe.style.height = "0";
    iframe.style.border = "0";
    iframe.style.visibility = "hidden";
    document.body.appendChild(iframe);

    const html = buildPrintReportHtml(question, attempt);
    try {
      const doc = iframe.contentDocument || iframe.contentWindow?.document;
      if (!doc) throw new Error("Print iframe unavailable");
      doc.open();
      doc.write(html);
      doc.close();

      hooks.showToast("已打开打印 / 另存 PDF 预览");
      setTimeout(() => {
        try {
          iframe.contentWindow.focus();
          iframe.contentWindow.print();
        } catch {
          hooks.showToast("调用浏览器打印失败，请尝试导出 Markdown");
        }
      }, 150);
    } catch {
      iframe.remove();
      hooks.showToast("打印预览初始化失败，请改用导出 Markdown");
    }
  }

  // ==================== Grading Prompt Builder ====================

  function buildCopyGradingPrompt(question, userAnswer) {
    const keyPointsText = (question.key_points || [])
      .map((pt, i) => `${i + 1}. ${pt}`)
      .join("\n");
    const followUpsText = (question.follow_up_questions || [])
      .map((fq, i) => `${i + 1}. ${fq}`)
      .join("\n");
    const trackLabel = TRACK_LABELS[question.track] || question.track || "综合";
    const answerBody =
      userAnswer && userAnswer.trim()
        ? userAnswer.trim()
        : "（我尚未填写答案，请先作为面试官向我提问，等我回复后再按上述采分点严格批改。）";

    return [
      "你是一位严苛的资深 AI 应用架构师与解决方案面试官。请严格基于下方「题目信息」与「核心采分点」，对我的模拟面试作答进行专业批改、打分与追问。",
      "",
      "## 题目信息",
      `- 题目：${question.title || ""}`,
      `- 专题：${question.topic || ""} | 难度：${question.difficulty || ""} | 赛道：${trackLabel}`,
      `- 实战/面试场景：${question.scenario || ""}`,
      "",
      "## 核心采分点（Rubric）",
      keyPointsText || "（无预设采分点）",
      "",
      "## 常见踩坑答法（反例参考）",
      question.common_mistakes || "（无）",
      "",
      "## 参考连环追问方向",
      followUpsText || "（无）",
      "",
      "## 候选人作答",
      answerBody,
      "",
      "## 请按以下结构输出批改结果",
      "1. **综合得分（0-100 分）**与一句话总评（不放水，看工程深度、权衡取舍和量化指标）。",
      "2. **命中采分点**：列出已覆盖的要点及亮点。",
      "3. **遗漏与踩坑**：指出未覆盖的采分点、概念偏差或泛泛而谈之处。",
      "4. **高分改进建议**：给出 2-3 条具体可落地的补充表述。",
      "5. **连环追问（1 题）**：针对我回答中最薄弱的环节提出 1 个犀利追问，等我继续作答。",
    ].join("\n");
  }

  // ==================== OpenAI-Compatible API Calls ====================

  function extractHttpErrorMessage(status, bodyText) {
    let detail = "";
    if (bodyText) {
      try {
        const parsed = JSON.parse(bodyText);
        detail = parsed?.error?.message || parsed?.message || parsed?.detail || "";
      } catch {
        detail = bodyText.slice(0, 180);
      }
    }
    if (status === 401 || status === 403) {
      return `鉴权失败（HTTP ${status}）：请检查 API Key 是否有效。${detail ? `详情：${detail}` : ""}`;
    }
    if (status === 404) {
      return `接口或模型未找到（HTTP 404）：请确认 Base URL（通常以 /v1 结尾）与 Model 名称正确。${detail ? `详情：${detail}` : ""}`;
    }
    if (status === 429) {
      return `请求频率受限或余额不足（HTTP 429）。${detail ? `详情：${detail}` : ""}`;
    }
    return `API 请求失败（HTTP ${status}）${detail ? `：${detail}` : ""}`;
  }

  async function callChatCompletions(cfg, messages, options = {}) {
    const endpoint = buildChatCompletionsUrl(cfg.baseUrl);
    if (!endpoint) {
      throw new Error("请先填写有效的 Base URL。");
    }

    const timeoutMs = options.timeoutMs || 60000;
    const controller = typeof AbortController !== "undefined" ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;

    try {
      const resp = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${cfg.apiKey.trim()}`,
        },
        body: JSON.stringify({
          model: cfg.model.trim(),
          messages,
          temperature: options.temperature !== undefined ? options.temperature : 0.3,
          max_tokens: options.max_tokens || 1000,
        }),
        signal: controller ? controller.signal : undefined,
      });

      const bodyText = await resp.text();
      if (!resp.ok) {
        throw new Error(extractHttpErrorMessage(resp.status, bodyText));
      }

      let data;
      try {
        data = JSON.parse(bodyText);
      } catch {
        throw new Error("服务端返回了非 JSON 响应，请检查 Base URL 是否指向 OpenAI 兼容接口。");
      }

      const content = data?.choices?.[0]?.message?.content;
      if (typeof content !== "string" || !content.trim()) {
        throw new Error("模型未返回有效文本内容，请重试或检查模型配置。");
      }
      return content.trim();
    } catch (err) {
      if (err && err.name === "AbortError") {
        throw new Error(`请求超时（>${Math.round(timeoutMs / 1000)} 秒），请检查网络或更换响应更快的模型。`);
      }
      if (err instanceof TypeError) {
        throw new Error(
          "网络请求被拦截或连接失败（常见原因：目标 API 未开启浏览器 CORS 跨域、Base URL 错误或网络不可达）。可改用支持 CORS 的兼容端点，或使用「免 Key 自评 / 复制批改 Prompt」。"
        );
      }
      throw err;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  function tryParseJsonLoose(rawText) {
    const trimmed = String(rawText || "").trim();
    if (!trimmed) return null;

    try {
      return JSON.parse(trimmed);
    } catch {
      // continue
    }

    const fenceMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fenceMatch && fenceMatch[1]) {
      try {
        return JSON.parse(fenceMatch[1].trim());
      } catch {
        // continue
      }
    }

    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start !== -1 && end > start) {
      try {
        return JSON.parse(trimmed.slice(start, end + 1));
      } catch {
        // continue
      }
    }

    return null;
  }

  function clampScore(val, fallback = 60) {
    const num = Number(val);
    if (!Number.isFinite(num)) return fallback;
    return Math.max(0, Math.min(100, Math.round(num)));
  }

  function toStringArray(val) {
    if (!Array.isArray(val)) return [];
    return val.map((x) => String(x || "").trim()).filter(Boolean);
  }

  function parseInitialAiGrading(rawText, question) {
    const obj = tryParseJsonLoose(rawText);
    const defaultFollowUp =
      (question.follow_up_questions && question.follow_up_questions[0]) ||
      "如果要把你的方案推向高并发生产环境，你最担心哪个瓶颈，会如何设置监控与兜底策略？";

    if (obj && typeof obj === "object") {
      return {
        score: clampScore(obj.score, 65),
        verdict: String(obj.verdict || "已完成结构化面试评估").trim(),
        hit_points: toStringArray(obj.hit_points),
        missed_points: toStringArray(obj.missed_points),
        feedback: String(obj.feedback || "请结合遗漏采分点进一步补充架构权衡与量化验收指标。").trim(),
        follow_up_question: String(obj.follow_up_question || defaultFollowUp).trim(),
      };
    }

    const scoreMatch = String(rawText).match(/(?:score|得分|评分|分数)[：:\s"*]*(\d{1,3})/i);
    const extractedScore = scoreMatch ? clampScore(scoreMatch[1], 65) : 65;
    return {
      score: extractedScore,
      verdict: "AI 已完成评估（文本降级解析）",
      hit_points: [],
      missed_points: [],
      feedback: String(rawText || "").trim(),
      follow_up_question: defaultFollowUp,
    };
  }

  function parseFollowUpAiReply(rawText, isFinalRound) {
    const obj = tryParseJsonLoose(rawText);
    if (obj && typeof obj === "object") {
      if (isFinalRound) {
        const evalPart = String(obj.evaluation || obj.comment || "").trim();
        const summaryPart = String(obj.final_summary || obj.summary || "").trim();
        const combined = [
          evalPart ? `**本轮追问点评：**${evalPart}` : "",
          summaryPart ? `**最终模拟面试总结：**${summaryPart}` : "",
        ]
          .filter(Boolean)
          .join("\n\n");
        return combined || String(rawText).trim();
      }
      const evalPart = String(obj.evaluation || obj.comment || "").trim();
      const nextQ = String(obj.follow_up_question || obj.next_question || "").trim();
      const combined = [
        evalPart ? `**本轮追问点评：**${evalPart}` : "",
        nextQ ? `**第 2 轮深度追问：**${nextQ}` : "",
      ]
        .filter(Boolean)
        .join("\n\n");
      return combined || String(rawText).trim();
    }
    return String(rawText || "").trim();
  }

  function buildInitialGradingMessages(question, answer) {
    const keyPoints = (question.key_points || []).map((pt, i) => `${i + 1}. ${pt}`).join("\n");
    const followUps = (question.follow_up_questions || []).map((fq, i) => `${i + 1}. ${fq}`).join("\n");

    const systemPrompt = [
      "你是一位严谨、专业的资深 AI 应用架构与解决方案面试官。",
      "请严格对照题目采分点与常见踩坑点对候选人回答打分（0-100 整数），绝不敷衍给高分。",
      "你必须只输出一个合法 JSON 对象，不要包含额外解释文字，字段如下：",
      '{"score": 0-100整数, "verdict": "25字以内一句话总评", "hit_points": ["命中的要点"], "missed_points": ["遗漏或薄弱的要点"], "feedback": "2-4句具体改进建议", "follow_up_question": "针对薄弱点提出的1个犀利追问"}',
    ].join("\n");

    const userPrompt = [
      `【题目】${question.title || ""}`,
      `【场景】${question.scenario || ""}`,
      `【核心采分点】\n${keyPoints}`,
      `【常见踩坑】${question.common_mistakes || ""}`,
      `【参考高分要点】${question.reference_answer || ""}`,
      `【参考追问方向】\n${followUps}`,
      `【候选人作答】\n${answer}`,
    ].join("\n\n");

    return [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ];
  }

  function buildFollowUpMessages(question, initialAnswer, session, isFinalRound) {
    const systemPrompt = isFinalRound
      ? [
          "你是正在进行 AI 技术/咨询模拟面试的资深面试官。当前为第 2 轮（最后一轮）追问评估。",
          "请简明点评候选人的第 2 轮追问回答，并给出整场模拟面试的最终总结（核心优势、最大短板、下一步准备建议）。",
          '请只输出合法 JSON：{"evaluation": "对第2轮回答的2句精准点评", "final_summary": "整场模拟面试的最终总结与提升建议"}',
        ].join("\n")
      : [
          "你是正在进行 AI 技术/咨询模拟面试的资深面试官。当前为第 1 轮追问评估，评估后需再提出第 2 轮（最后一轮）更深度的追问。",
          '请只输出合法 JSON：{"evaluation": "对第1轮回答的2句精准点评", "follow_up_question": "第2轮更深度的生产落地或架构取舍追问"}',
        ].join("\n");

    const historyLines = (session.followUps || [])
      .map((m) => `${m.role === "interviewer" ? "面试官" : "候选人"}：${m.text}`)
      .join("\n\n");

    const userPrompt = [
      `【题目】${question.title || ""}`,
      `【核心采分点】${(question.key_points || []).join("；")}`,
      `【候选人首轮作答】${initialAnswer}`,
      `【首轮评分与评语】${session.feedback.score}分 - ${session.feedback.verdict}；${session.feedback.feedback}`,
      `【追问对话记录】\n${historyLines}`,
    ].join("\n\n");

    return [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ];
  }

  // ==================== Compact Card Strip (No Page Bloat) ====================

  function renderCardStripHtml(question) {
    if (!question || !question.id) return "";
    const summary = getQuestionSummary(question.id);
    if (!summary.attemptsCount) return "";
    const modeLabel = summary.lastMode === "ai" ? "AI 评分" : "自评";
    return `
      <div class="mock-history-strip" data-strip-qid="${esc(question.id)}">
        <span>📊 历史模拟 <strong>${summary.attemptsCount}</strong> 次 · 最高 <strong>${summary.bestScore ?? "--"}</strong> 分 · 最近 <strong>${summary.lastScore ?? "--"}</strong> 分（${modeLabel}）</span>
        <button type="button" class="btn btn-ghost btn-xs open-question-archive-btn" data-qid="${esc(question.id)}">📂 查看本题归档</button>
      </div>`;
  }

  function renderPanelHtml(question) {
    // Backward-compatible alias: keeps cards compact while opening full Studio modal on demand
    return renderCardStripHtml(question);
  }

  function bindCard(cardEl, question) {
    if (!cardEl || !question) return;
    const btn = cardEl.querySelector(".open-question-archive-btn");
    if (btn && !btn._forgeBound) {
      btn._forgeBound = true;
      btn.addEventListener("click", () => {
        openStudio(question.id, { initialTab: "archive" });
      });
    }
  }

  // ==================== Shared Report Detail Renderer ====================

  function renderAttemptReportBodyHtml(question, attempt) {
    const score = Number.isFinite(Number(attempt.score)) ? Number(attempt.score) : 0;
    const scoreCls = getScoreClass(score);
    const modeLabel = attempt.mode === "ai" ? "⚡ AI 面试官评分" : "📝 采分点自评";

    let evalHtml = "";
    if (attempt.mode === "ai" && attempt.aiFeedback) {
      const fb = attempt.aiFeedback;
      const hitItems =
        fb.hit_points && fb.hit_points.length
          ? fb.hit_points.map((x) => `<li>${md(x)}</li>`).join("")
          : `<li>暂未明确命中核心采分点，建议补充架构细节与量化指标。</li>`;
      const missItems =
        fb.missed_points && fb.missed_points.length
          ? fb.missed_points.map((x) => `<li>${md(x)}</li>`).join("")
          : `<li>核心采分点基本覆盖，表现扎实！</li>`;

      evalHtml = `
        <div class="mock-ai-box">
          <div class="mock-ai-header">
            <div style="display: flex; align-items: center; gap: 10px; flex-wrap: wrap;">
              <span class="mock-score-num ${scoreCls}">${score} 分</span>
              <span class="mock-ai-verdict">${esc(fb.verdict || "AI 评估完成")}</span>
            </div>
            <span class="badge badge-neutral">${esc(modeLabel)}</span>
          </div>
          <div class="mock-ai-lists">
            <div class="mock-ai-hit">
              <div class="section-heading">✅ 命中采分点</div>
              <ul class="bullet-list">${hitItems}</ul>
            </div>
            <div class="mock-ai-miss">
              <div class="section-heading">⚠️ 遗漏 / 薄弱点</div>
              <ul class="bullet-list">${missItems}</ul>
            </div>
          </div>
          <div class="section-block">
            <div class="section-heading">💡 面试官点评与改进建议</div>
            <p class="section-text">${md(fb.feedback || "")}</p>
          </div>
        </div>`;
    } else {
      const checkedSet = new Set(Array.isArray(attempt.checkedIndices) ? attempt.checkedIndices : []);
      const keyPoints = Array.isArray(question.key_points) ? question.key_points : [];
      const rubricRows = keyPoints.length
        ? keyPoints
            .map((pt, idx) => {
              const hit = checkedSet.has(idx);
              return `
                <div class="mock-rubric-item ${hit ? "is-checked" : ""}">
                  <span>${hit ? "✅" : "⬜"}</span>
                  <span>${md(pt)}</span>
                </div>`;
            })
            .join("")
        : `<div class="stat-sub">本题暂无预设采分点。</div>`;

      evalHtml = `
        <div class="mock-score-banner" style="margin-top: 10px;">
          <div>
            <span class="stat-sub">自评得分：</span>
            <span class="mock-score-num ${scoreCls}">${score}</span>
            <span class="stat-sub">/ 100（命中 ${checkedSet.size}/${keyPoints.length}）</span>
          </div>
          <span class="badge badge-neutral">${esc(modeLabel)}</span>
        </div>
        <div class="section-block">
          <div class="section-heading">采分点勾选明细</div>
          <div class="mock-rubric-list">${rubricRows}</div>
        </div>`;
    }

    const followUps = Array.isArray(attempt.followUps) ? attempt.followUps : [];
    const transcriptHtml = followUps.length
      ? `
        <div class="mock-followup-thread" style="margin-top: 12px;">
          <div class="section-heading">💬 面试官连环追问完整记录（共 ${followUps.length} 条）</div>
          ${followUps
            .map((msg) => {
              const isInterviewer = msg.role === "interviewer";
              return `
                <div class="mock-followup-msg ${isInterviewer ? "role-interviewer" : "role-candidate"}">
                  <div class="section-heading" style="margin-bottom: 4px;">${isInterviewer ? "🤖 AI 面试官" : "🧑‍💻 你的回应"}</div>
                  <div class="section-text">${md(msg.text || "")}</div>
                </div>`;
            })
            .join("")}
        </div>`
      : "";

    return `
      <div class="section-block" style="margin-top: 10px;">
        <div class="section-heading">你的首轮作答</div>
        <div class="mock-user-answer-box">${esc(attempt.answer || "（空）")}</div>
      </div>
      ${evalHtml}
      ${transcriptHtml}
    `;
  }

  // ==================== Studio Modal (#interviewStudioModal) ====================

  function openStudio(questionId, options = {}) {
    if (!modalsMounted) mountAllModals();
    const question = hooks.getQuestionById(questionId);
    if (!question) {
      hooks.showToast("未找到对应题目");
      return;
    }

    const rec = ensureRecord(questionId);
    window.ForgeAnalytics?.track?.("mock_interview_start", {
      qid: questionId,
      track: question.track || "both",
      mode: isByokConfigured() ? "byok" : "no_key",
    });
    studioState.open = true;
    studioState.questionId = questionId;
    studioState.leftTab = "answer";
    studioState.rightTab = options.initialTab === "archive" ? "archive" : "live";

    if (studioState.rightTab === "archive") {
      if (
        typeof options.attemptIndex === "number" &&
        options.attemptIndex >= 0 &&
        options.attemptIndex < rec.attempts.length
      ) {
        studioState.selectedArchiveIdx = options.attemptIndex;
      } else {
        studioState.selectedArchiveIdx = rec.attempts.length ? rec.attempts.length - 1 : null;
      }
    }

    const modal = document.getElementById("interviewStudioModal");
    if (!modal) return;
    modal.classList.remove("hidden");
    renderStudioFull();
    syncBodyScrollLock();
    window.ForgePlatform?.pushNavLayer?.("studio");
  }

  function closeStudio(fromPop) {
    if (!studioState.open) return;
    studioState.open = false;
    stopStudioTimerInterval();
    const modal = document.getElementById("interviewStudioModal");
    if (modal) modal.classList.add("hidden");
    syncBodyScrollLock();
    window.ForgePlatform?.popNavLayer?.("studio", fromPop);
  }

  function closeTopModal(fromPop) {
    const settingsModal = document.getElementById("aiSettingsModal");
    if (settingsModal && !settingsModal.classList.contains("hidden")) {
      closeSettingsModal();
      return true;
    }
    const archiveModal = document.getElementById("archiveModal");
    if (archiveModal && !archiveModal.classList.contains("hidden")) {
      closeArchiveModal();
      return true;
    }
    if (studioState.open) {
      closeStudio(fromPop);
      return true;
    }
    return false;
  }

  function renderStudioHeaderHtml(question) {
    const summary = getQuestionSummary(question.id);
    const byok = isByokConfigured();
    const trackLabel = TRACK_LABELS[question.track] || question.track || "";
    const scorePill =
      summary.attemptsCount > 0
        ? `<span class="badge badge-score">最高 ${summary.bestScore ?? "--"} 分 · ${summary.attemptsCount} 次</span>`
        : "";

    return `
      <div class="studio-header-main">
        <h2 id="studioModalTitle" style="margin: 0; font-size: 1.05rem; line-height: 1.35;">🎙️ ${esc(question.title)}</h2>
        <div class="badges" style="margin-top: 5px;">
          <span class="badge">${esc(question.topic || "")}</span>
          ${question.difficulty ? `<span class="badge badge-neutral">${esc(question.difficulty)}</span>` : ""}
          ${trackLabel ? `<span class="badge badge-neutral">${esc(trackLabel)}</span>` : ""}
          ${scorePill}
        </div>
      </div>
      <div class="studio-header-actions">
        <button type="button" class="mock-mode-pill ${byok ? "is-byok" : ""} studio-config-btn" title="配置 AI 面试官（可选 BYOK）">
          ${byok ? `⚡ ${esc(config.model)}` : "📝 免 Key 模式 · 配置 AI"}
        </button>
        <button type="button" class="btn btn-ghost btn-xs studio-open-global-archive-btn" title="查看全部题目归档">📚 全部档案</button>
        <button type="button" class="btn btn-ghost btn-xs studio-close-btn" aria-label="关闭演练室">✕ 关闭</button>
      </div>`;
  }

  function renderStudioLeftHtml(question) {
    const qid = question.id;
    const rec = ensureRecord(qid);
    const ps = ensurePanelState(qid);
    const rem = getRemainingSec(qid);
    const t = ensureTimer(qid);

    const timerCls = [
      "mock-timer-display",
      rem <= 0 ? "is-expired" : rem <= 30 ? "is-warning" : "",
    ]
      .filter(Boolean)
      .join(" ");

    const timerBtnText = t.running
      ? "⏸ 暂停计时"
      : rem <= 0
        ? "▶ 重新计时"
        : rem < DEFAULT_TIMER_SEC
          ? "▶ 继续计时"
          : "▶ 开始 3 分钟计时";

    const bodyHtml =
      studioState.leftTab === "reference"
        ? `
          <div class="section-block" style="margin-top: 0;">
            <div class="section-heading">参考高分回答</div>
            <p class="section-text">${md(question.reference_answer || "（无）")}</p>
          </div>
          <div class="section-block">
            <div class="section-heading">核心采分点</div>
            <ul class="bullet-list">${(question.key_points || []).map((pt) => `<li>${md(pt)}</li>`).join("")}</ul>
          </div>
          <div class="section-block">
            <div class="section-heading">面试官 / 客户连环追问</div>
            <ul class="bullet-list">${(question.follow_up_questions || []).map((fq) => `<li>${md(fq)}</li>`).join("")}</ul>
          </div>
          <div class="section-block">
            <div class="section-heading">常见踩坑答法</div>
            <p class="section-text">${md(question.common_mistakes || "（无）")}</p>
          </div>
          ${
            question.source_url
              ? `<div class="evidence-box">
                   ${question.evidence_quote ? `<strong>原文溯源：</strong>${md(question.evidence_quote)}<br/>` : ""}
                   来源：<a href="${esc(question.source_url)}" target="_blank" rel="noopener noreferrer">${esc(question.source_title || question.source_url)} ↗</a>
                 </div>`
              : ""
          }`
        : `
          <div class="studio-scenario">
            <div class="section-heading">实战 / 面试场景</div>
            <p class="section-text">${md(question.scenario || "")}</p>
          </div>

          <div class="mock-timer-bar">
            <div style="display: flex; align-items: center; gap: 10px;">
              <span class="stat-sub">⏱️ 3 分钟计时</span>
              <span class="${timerCls}">${formatTime(rem)}</span>
            </div>
            <div class="mock-timer-actions">
              <button type="button" class="btn btn-ghost btn-xs mock-timer-toggle-btn">${timerBtnText}</button>
              <button type="button" class="btn btn-ghost btn-xs mock-timer-reset-btn">↺ 重置</button>
            </div>
          </div>

          <textarea
            class="mock-textarea mock-answer-input"
            rows="9"
            placeholder="请像真实面试一样结构化作答：结论先行 -> 核心架构与权衡 -> 量化指标与容错兜底（草稿实时本地保存）..."
          >${esc(rec.draft)}</textarea>

          <div class="mock-editor-meta">
            <span class="mock-char-count">已输入 ${rec.draft.length} 字</span>
            <span class="mock-draft-status">${rec.draft ? "草稿已自动保存" : "免 Key 自评 / 可选 BYOK 直连"}</span>
          </div>

          <div class="mock-actions-row">
            <button type="button" class="btn btn-primary btn-sm mock-self-eval-btn">📝 提交并对照采分点自评</button>
            <button type="button" class="btn btn-sm mock-ai-grade-btn" ${ps.aiLoading ? "disabled" : ""}>
              ${ps.aiLoading ? "⏳ AI 批改中..." : "⚡ AI 面试官打分并追问"}
            </button>
            <button type="button" class="btn btn-ghost btn-sm mock-copy-prompt-btn">📋 复制批改 Prompt</button>
          </div>`;

    return `
      <div class="studio-tabs">
        <button type="button" class="studio-tab-btn studio-left-tab ${studioState.leftTab === "answer" ? "active" : ""}" data-left-tab="answer">📝 题目与作答</button>
        <button type="button" class="studio-tab-btn studio-left-tab ${studioState.leftTab === "reference" ? "active" : ""}" data-left-tab="reference">👁️ 参考高分解析</button>
      </div>
      <div class="studio-pane-scroll">${bodyHtml}</div>`;
  }

  function renderStudioRightHtml(question) {
    const qid = question.id;
    const rec = ensureRecord(qid);
    const ps = ensurePanelState(qid);
    const attemptsCount = rec.attempts.length;

    const tabsHtml = `
      <div class="studio-tabs">
        <button type="button" class="studio-tab-btn studio-right-tab ${studioState.rightTab === "live" ? "active" : ""}" data-right-tab="live">💬 评分与追问对话</button>
        <button type="button" class="studio-tab-btn studio-right-tab ${studioState.rightTab === "archive" ? "active" : ""}" data-right-tab="archive">📂 本题归档 (${attemptsCount})</button>
      </div>`;

    if (studioState.rightTab === "archive") {
      return `${tabsHtml}<div class="studio-pane-scroll">${renderQuestionArchiveTabHtml(question, rec)}</div>`;
    }

    // Live right tab: scrollable evaluation + chat messages, plus sticky bottom reply bar if AI follow-up is active
    const scrollParts = [];

    if (!ps.selfEvalOpen && !ps.aiLoading && !ps.aiError && !ps.aiSession) {
      scrollParts.push(`
        <div class="studio-empty-guide">
          <div style="font-size: 1.5rem; margin-bottom: 8px;">🎯</div>
          <h3 style="margin: 0 0 8px; font-size: 0.98rem;">沉浸式双栏模拟演练室已就绪</h3>
          <p class="stat-sub" style="margin: 0 0 12px; line-height: 1.6;">
            在左侧写下你的面试回答（可开启 3 分钟计时），然后选择任一评估方式：
          </p>
          <ul class="bullet-list" style="text-align: left; font-size: 0.84rem; color: var(--text-muted);">
            <li><strong>📝 免 Key 采分点自评</strong>：右侧即刻对照核心采分点勾选打分并归档。</li>
            <li><strong>⚡ AI 面试官打分并追问</strong>：支持 2 轮连环深度追问，底部固定回复栏免滚屏，全程自动归档。</li>
            <li><strong>📋 复制批改 Prompt</strong>：一键复制含采分点与答案的严苛面试官提示词。</li>
          </ul>
          ${
            attemptsCount > 0
              ? `<button type="button" class="btn btn-ghost btn-sm studio-jump-archive-btn" style="margin-top: 12px;">📂 查看本题 ${attemptsCount} 条历史归档</button>`
              : ""
          }
        </div>`);
    }

    // Mode A live self-eval rubric
    if (ps.selfEvalOpen) {
      const keyPoints = Array.isArray(question.key_points) ? question.key_points : [];
      const checkedCount = Array.from(ps.checkedIndices).filter((i) => i >= 0 && i < keyPoints.length).length;
      const score = keyPoints.length ? Math.round((checkedCount / keyPoints.length) * 100) : 0;
      const scoreCls = getScoreClass(score);

      const rubricHtml = keyPoints.length
        ? keyPoints
            .map((pt, idx) => {
              const isChecked = ps.checkedIndices.has(idx);
              return `
                <label class="mock-rubric-item ${isChecked ? "is-checked" : ""}" data-rubric-idx="${idx}">
                  <input type="checkbox" class="mock-rubric-check" data-rubric-idx="${idx}" ${isChecked ? "checked" : ""} />
                  <span>${md(pt)}</span>
                </label>`;
            })
            .join("")
        : `<div class="stat-sub">本题暂无预设采分点，可切到左侧「参考高分解析」对照复盘。</div>`;

      const savedSelfAttempt =
        ps.selfEvalSaved &&
        ps.lastSavedSelfAttemptIdx !== null &&
        rec.attempts[ps.lastSavedSelfAttemptIdx]
          ? rec.attempts[ps.lastSavedSelfAttemptIdx]
          : null;

      scrollParts.push(`
        <div class="mock-eval-col" style="margin-bottom: 12px;">
          <div class="section-heading">核心采分点自评（勾选已答中要点）</div>
          <div class="mock-rubric-list">${rubricHtml}</div>
          <div class="mock-score-banner">
            <div>
              <span class="stat-sub">自评得分：</span>
              <span class="mock-score-num ${scoreCls}">${score}</span>
              <span class="stat-sub">/ 100（命中 ${checkedCount}/${keyPoints.length}）</span>
            </div>
            <button type="button" class="btn btn-primary btn-sm mock-save-self-btn" ${ps.selfEvalSaved ? "disabled" : ""}>
              ${ps.selfEvalSaved ? "✅ 已归档本次自评" : "💾 保存本次自评得分"}
            </button>
          </div>
          ${
            savedSelfAttempt
              ? `<div class="studio-report-actions" style="margin-top: 10px;">
                   <button type="button" class="btn btn-ghost btn-xs studio-export-md-btn" data-attempt-idx="${ps.lastSavedSelfAttemptIdx}">📝 导出 Markdown (.md)</button>
                   <button type="button" class="btn btn-ghost btn-xs studio-print-pdf-btn" data-attempt-idx="${ps.lastSavedSelfAttemptIdx}">🖨️ 打印 / 另存 PDF</button>
                 </div>`
              : ""
          }
        </div>`);
    }

    // Mode B live AI loading / error / session
    if (ps.aiLoading) {
      scrollParts.push(`<div class="mock-loading">🤖 AI 面试官正在对照采分点严格批改并生成追问，请稍候...</div>`);
    }

    if (ps.aiError) {
      scrollParts.push(`
        <div class="mock-error-box">
          <div><strong>⚠️ AI 批改失败：</strong>${esc(ps.aiError)}</div>
          <div style="margin-top: 8px; display: flex; gap: 8px; flex-wrap: wrap;">
            <button type="button" class="btn btn-ghost btn-xs mock-open-settings-inline-btn">⚙️ 检查 AI 配置</button>
          </div>
        </div>`);
    }

    let stickyReplyBarHtml = "";
    if (ps.aiSession && ps.aiSession.feedback) {
      const session = ps.aiSession;
      const fb = session.feedback;
      const scoreCls = getScoreClass(fb.score);

      const hitItems = fb.hit_points.length
        ? fb.hit_points.map((x) => `<li>${md(x)}</li>`).join("")
        : `<li>暂未明确命中核心采分点，建议补充架构细节与量化指标。</li>`;
      const missItems = fb.missed_points.length
        ? fb.missed_points.map((x) => `<li>${md(x)}</li>`).join("")
        : `<li>核心采分点基本覆盖，表现扎实！</li>`;

      const msgsHtml = (session.followUps || [])
        .map((msg) => {
          const isInterviewer = msg.role === "interviewer";
          return `
            <div class="mock-followup-msg ${isInterviewer ? "role-interviewer" : "role-candidate"}">
              <div class="section-heading" style="margin-bottom: 4px;">${isInterviewer ? "🤖 AI 面试官" : "🧑‍💻 你的回应"}</div>
              <div class="section-text">${md(msg.text)}</div>
            </div>`;
        })
        .join("");

      scrollParts.push(`
        <div class="mock-ai-box" style="margin-top: 0;">
          <div class="mock-ai-header">
            <div style="display: flex; align-items: center; gap: 10px; flex-wrap: wrap;">
              <span class="mock-score-num ${scoreCls}">${fb.score} 分</span>
              <span class="mock-ai-verdict">${esc(fb.verdict)}</span>
            </div>
            <span class="badge badge-neutral">⚡ ${esc(config.model || "AI 面试官")}</span>
          </div>

          <div class="studio-report-actions" style="margin-bottom: 10px;">
            <button type="button" class="btn btn-ghost btn-xs studio-export-md-btn" data-attempt-idx="${session.attemptIndex}">📝 导出 Markdown (.md)</button>
            <button type="button" class="btn btn-ghost btn-xs studio-print-pdf-btn" data-attempt-idx="${session.attemptIndex}">🖨️ 打印 / 另存 PDF</button>
            <span class="stat-sub" style="margin-left: auto;">✅ 已自动归档到本地</span>
          </div>

          <div class="mock-ai-lists">
            <div class="mock-ai-hit">
              <div class="section-heading">✅ 命中采分点</div>
              <ul class="bullet-list">${hitItems}</ul>
            </div>
            <div class="mock-ai-miss">
              <div class="section-heading">⚠️ 遗漏 / 薄弱点</div>
              <ul class="bullet-list">${missItems}</ul>
            </div>
          </div>

          <div class="section-block">
            <div class="section-heading">💡 面试官点评与改进建议</div>
            <p class="section-text">${md(fb.feedback)}</p>
          </div>

          <div class="mock-followup-thread">
            <div class="section-heading">💬 面试官连环追问（最多 ${MAX_FOLLOWUP_ROUNDS} 轮）</div>
            ${msgsHtml}
            ${session.followUpLoading ? `<div class="mock-loading">🤖 面试官正在评估你的追问回答...</div>` : ""}
            ${session.followUpError ? `<div class="mock-error-box">⚠️ ${esc(session.followUpError)}</div>` : ""}
            ${session.finished ? `<div class="stat-sub" style="margin-top: 6px;">✅ 已完成全部 ${MAX_FOLLOWUP_ROUNDS} 轮深度追问，完整记录已归档，可随时导出 Markdown 或打印 PDF。</div>` : ""}
          </div>
        </div>`);

      if (!session.finished) {
        const nextRoundNum = Math.min(session.completedRounds + 1, MAX_FOLLOWUP_ROUNDS);
        stickyReplyBarHtml = `
          <div class="studio-reply-bar">
            <form class="mock-followup-form">
              <textarea
                class="mock-textarea mock-followup-input"
                rows="2"
                placeholder="在此回应面试官第 ${nextRoundNum}/${MAX_FOLLOWUP_ROUNDS} 轮追问（Ctrl+Enter 快捷发送）..."
                ${session.followUpLoading ? "disabled" : ""}
              >${esc(session.followUpDraft || "")}</textarea>
              <button type="submit" class="btn btn-primary btn-sm mock-followup-submit-btn" ${session.followUpLoading ? "disabled" : ""}>
                ${nextRoundNum >= MAX_FOLLOWUP_ROUNDS ? "📤 发送终轮回答" : `📤 发送（第 ${nextRoundNum}/${MAX_FOLLOWUP_ROUNDS} 轮）`}
              </button>
            </form>
          </div>`;
      }
    }

    return `
      ${tabsHtml}
      <div class="studio-chat-scroll">${scrollParts.join("")}</div>
      ${stickyReplyBarHtml}`;
  }

  function renderQuestionArchiveTabHtml(question, rec) {
    const attempts = rec.attempts || [];
    if (!attempts.length) {
      return `
        <div class="studio-empty-guide">
          <div style="font-size: 1.4rem; margin-bottom: 6px;">📂</div>
          <p class="stat-sub" style="margin: 0;">本题暂无归档记录。完成一次「采分点自评」或「AI 面试官打分」后将自动归档到这里。</p>
        </div>`;
    }

    if (
      studioState.selectedArchiveIdx === null ||
      studioState.selectedArchiveIdx < 0 ||
      studioState.selectedArchiveIdx >= attempts.length
    ) {
      studioState.selectedArchiveIdx = attempts.length - 1;
    }

    // List newest first
    const itemsHtml = attempts
      .map((a, idx) => ({ a, idx }))
      .reverse()
      .map(({ a, idx }) => {
        const active = idx === studioState.selectedArchiveIdx;
        const modeBadge = a.mode === "ai" ? "⚡ AI" : "📝 自评";
        const qaCount = Array.isArray(a.followUps) ? a.followUps.length : 0;
        const scoreCls = getScoreClass(Number(a.score) || 0);
        return `
          <button type="button" class="archive-item ${active ? "active" : ""}" data-q-archive-idx="${idx}">
            <div style="display: flex; justify-content: space-between; align-items: center; gap: 8px; width: 100%;">
              <span><strong>${modeBadge}</strong> · ${esc(formatDateTime(a.ts))}</span>
              <span class="mock-score-num ${scoreCls}" style="font-size: 0.95rem;">${a.score ?? "--"} 分</span>
            </div>
            <div class="stat-sub" style="text-align: left; margin-top: 3px;">
              ${qaCount ? `含 ${qaCount} 条连环追问对话` : "首轮作答与评分记录"}
            </div>
          </button>`;
      })
      .join("");

    const selectedAttempt = attempts[studioState.selectedArchiveIdx];
    return `
      <div class="archive-list" style="max-height: 190px; margin-bottom: 12px;">${itemsHtml}</div>
      <div class="archive-detail" style="padding: 12px; border: 1px solid var(--border); border-radius: 10px;">
        <div class="studio-report-actions" style="margin-bottom: 8px;">
          <button type="button" class="btn btn-ghost btn-xs studio-export-md-btn" data-attempt-idx="${studioState.selectedArchiveIdx}">📝 导出 Markdown (.md)</button>
          <button type="button" class="btn btn-ghost btn-xs studio-print-pdf-btn" data-attempt-idx="${studioState.selectedArchiveIdx}">🖨️ 打印 / 另存 PDF</button>
          <button type="button" class="btn btn-ghost btn-xs studio-delete-attempt-btn" data-attempt-idx="${studioState.selectedArchiveIdx}" style="margin-left: auto; color: var(--red);">🗑️ 删除此记录</button>
        </div>
        ${renderAttemptReportBodyHtml(question, selectedAttempt)}
      </div>`;
  }

  function renderStudioFull() {
    const modal = document.getElementById("interviewStudioModal");
    if (!modal || !studioState.open || !studioState.questionId) return;
    const question = resolveQuestion(studioState.questionId);

    const headerEl = modal.querySelector(".studio-header");
    const leftEl = modal.querySelector(".studio-left");
    const rightEl = modal.querySelector(".studio-right");

    if (headerEl) {
      headerEl.innerHTML = renderStudioHeaderHtml(question);
      bindStudioHeaderEvents(headerEl, question);
    }
    if (leftEl) {
      leftEl.innerHTML = renderStudioLeftHtml(question);
      bindStudioLeftEvents(leftEl, question);
    }
    if (rightEl) {
      rightEl.innerHTML = renderStudioRightHtml(question);
      bindStudioRightEvents(rightEl, question);
    }

    attachStudioTimerInterval(question.id);
  }

  function refreshStudioHeader() {
    const modal = document.getElementById("interviewStudioModal");
    if (!modal || !studioState.open || !studioState.questionId) return;
    const question = resolveQuestion(studioState.questionId);
    const headerEl = modal.querySelector(".studio-header");
    if (headerEl) {
      headerEl.innerHTML = renderStudioHeaderHtml(question);
      bindStudioHeaderEvents(headerEl, question);
    }
  }

  function refreshStudioLeft() {
    const modal = document.getElementById("interviewStudioModal");
    if (!modal || !studioState.open || !studioState.questionId) return;
    const question = resolveQuestion(studioState.questionId);
    const leftEl = modal.querySelector(".studio-left");
    if (leftEl) {
      leftEl.innerHTML = renderStudioLeftHtml(question);
      bindStudioLeftEvents(leftEl, question);
    }
    attachStudioTimerInterval(question.id);
  }

  function refreshStudioRight(options = {}) {
    const modal = document.getElementById("interviewStudioModal");
    if (!modal || !studioState.open || !studioState.questionId) return;
    const question = resolveQuestion(studioState.questionId);
    const rightEl = modal.querySelector(".studio-right");
    if (!rightEl) return;

    rightEl.innerHTML = renderStudioRightHtml(question);
    bindStudioRightEvents(rightEl, question);

    if (options.scrollToBottom) {
      const chatScroll = rightEl.querySelector(".studio-chat-scroll");
      if (chatScroll) {
        chatScroll.scrollTop = chatScroll.scrollHeight;
      }
    }
  }

  function syncStudioAiButtonState(qid) {
    const modal = document.getElementById("interviewStudioModal");
    if (!modal || !studioState.open || studioState.questionId !== qid) return;
    const ps = ensurePanelState(qid);
    const btn = modal.querySelector(".mock-ai-grade-btn");
    if (btn) {
      btn.disabled = Boolean(ps.aiLoading);
      btn.textContent = ps.aiLoading ? "⏳ AI 批改中..." : "⚡ AI 面试官打分并追问";
    }
  }

  function bindStudioHeaderEvents(headerEl) {
    headerEl.querySelector(".studio-config-btn")?.addEventListener("click", () => {
      openSettingsModal();
    });
    headerEl.querySelector(".studio-open-global-archive-btn")?.addEventListener("click", () => {
      openArchiveModal();
    });
    headerEl.querySelector(".studio-close-btn")?.addEventListener("click", closeStudio);
  }

  function bindStudioLeftEvents(leftEl, question) {
    const qid = question.id;
    const rec = ensureRecord(qid);
    const ps = ensurePanelState(qid);

    leftEl.querySelectorAll(".studio-left-tab").forEach((btn) => {
      btn.addEventListener("click", () => {
        studioState.leftTab = btn.dataset.leftTab || "answer";
        refreshStudioLeft();
      });
    });

    // Timer controls
    leftEl.querySelector(".mock-timer-toggle-btn")?.addEventListener("click", () => {
      const t = ensureTimer(qid);
      if (t.running) {
        pauseTimer(qid);
      } else {
        const currentRem = getRemainingSec(qid);
        const startSec = currentRem <= 0 ? DEFAULT_TIMER_SEC : currentRem;
        t.remainingSec = startSec;
        t.running = true;
        t.deadlineTs = Date.now() + startSec * 1000;
        attachStudioTimerInterval(qid);
      }
    });

    leftEl.querySelector(".mock-timer-reset-btn")?.addEventListener("click", () => {
      const t = ensureTimer(qid);
      stopStudioTimerInterval();
      t.running = false;
      t.deadlineTs = null;
      t.remainingSec = DEFAULT_TIMER_SEC;
      syncStudioTimerDom(qid);
    });

    // Answer textarea
    const textarea = leftEl.querySelector(".mock-answer-input");
    const charCountEl = leftEl.querySelector(".mock-char-count");
    const draftStatusEl = leftEl.querySelector(".mock-draft-status");

    if (textarea) {
      textarea.addEventListener("input", () => {
        rec.draft = textarea.value;
        if (charCountEl) charCountEl.textContent = `已输入 ${textarea.value.length} 字`;
        if (draftStatusEl) draftStatusEl.textContent = "草稿自动保存中...";
        clearTimeout(draftTimers.get(qid));
        draftTimers.set(
          qid,
          setTimeout(() => {
            saveRecords();
            if (draftStatusEl && draftStatusEl.isConnected) {
              draftStatusEl.textContent = textarea.value ? "草稿已自动保存" : "免 Key 自评 / 可选 BYOK 直连";
            }
          }, 250)
        );
      });

      textarea.addEventListener("blur", () => {
        clearTimeout(draftTimers.get(qid));
        rec.draft = textarea.value;
        saveRecords();
      });
    }

    // Mode A: Self-eval submit
    leftEl.querySelector(".mock-self-eval-btn")?.addEventListener("click", () => {
      const rawVal = textarea ? textarea.value : rec.draft;
      const trimmed = rawVal.trim();
      if (!trimmed) {
        hooks.showToast("请先输入你的模拟面试回答，再对照采分点自评！");
        if (textarea) textarea.focus();
        return;
      }
      rec.draft = rawVal;
      saveRecords();
      pauseTimer(qid);

      if (ps.selfEvalAnswer !== trimmed) {
        ps.selfEvalSaved = false;
        ps.lastSavedSelfAttemptIdx = null;
      }
      ps.selfEvalAnswer = trimmed;
      ps.selfEvalOpen = true;
      studioState.rightTab = "live";
      refreshStudioRight();
      if (window.innerWidth <= 960) {
        document.querySelector("#interviewStudioModal .studio-right")?.scrollIntoView({ behavior: "smooth", block: "start" });
      }
    });

    // Mode A: Copy structured grading prompt
    leftEl.querySelector(".mock-copy-prompt-btn")?.addEventListener("click", () => {
      const rawVal = textarea ? textarea.value : rec.draft;
      const promptText = buildCopyGradingPrompt(question, rawVal);
      copyTextToClipboard(promptText)
        .then(() => {
          hooks.showToast(
            rawVal.trim()
              ? "已复制批改 Prompt，可直接粘贴给外部 AI 助手 / LLM 批改！"
              : "已复制面试批改 Prompt（当前回答为空，粘贴后可补充作答）"
          );
        })
        .catch(() => {
          hooks.showToast("复制失败，请检查浏览器剪贴板权限");
        });
    });

    // Mode B: AI Grade & Follow-Up
    leftEl.querySelector(".mock-ai-grade-btn")?.addEventListener("click", async () => {
      if (!isByokConfigured()) {
        hooks.showToast("请先配置 AI 面试官 API Key（或先用免 Key 自评 / 复制 Prompt）");
        openSettingsModal();
        return;
      }

      const rawVal = textarea ? textarea.value : rec.draft;
      const trimmed = rawVal.trim();
      if (!trimmed) {
        hooks.showToast("请先写下你的模拟回答，再让 AI 面试官打分！");
        if (textarea) textarea.focus();
        return;
      }

      rec.draft = rawVal;
      saveRecords();
      pauseTimer(qid);

      ps.aiLoading = true;
      ps.aiError = null;
      studioState.rightTab = "live";
      syncStudioAiButtonState(qid);
      refreshStudioRight({ scrollToBottom: true });

      try {
        const messages = buildInitialGradingMessages(question, trimmed);
        const replyText = await callChatCompletions(config, messages, {
          temperature: 0.3,
          max_tokens: 1100,
          timeoutMs: 60000,
        });
        const parsed = parseInitialAiGrading(replyText, question);
        const followUps = parsed.follow_up_question
          ? [{ role: "interviewer", text: parsed.follow_up_question, round: 1, ts: Date.now() }]
          : [];

        rec.attempts.push({
          ts: Date.now(),
          mode: "ai",
          model: config.model,
          score: parsed.score,
          checkedIndices: [],
          answer: trimmed,
          aiFeedback: parsed,
          followUps,
        });
        saveRecords();

        ps.aiLoading = false;
        ps.aiError = null;
        ps.aiSession = {
          attemptIndex: rec.attempts.length - 1,
          feedback: parsed,
          followUps,
          completedRounds: 0,
          finished: !parsed.follow_up_question,
          followUpLoading: false,
          followUpError: null,
          followUpDraft: "",
        };

        hooks.showToast(`⚡ AI 面试官评分完成：${parsed.score} 分（已自动归档）`);
        hooks.onStatsChange();
        syncStudioAiButtonState(qid);
        refreshStudioHeader();
        refreshStudioRight({ scrollToBottom: true });
      } catch (err) {
        ps.aiLoading = false;
        ps.aiError = err && err.message ? err.message : "调用 AI 接口失败，请重试。";
        syncStudioAiButtonState(qid);
        refreshStudioRight({ scrollToBottom: true });
      }
    });
  }

  function bindStudioRightEvents(rightEl, question) {
    const qid = question.id;
    const rec = ensureRecord(qid);
    const ps = ensurePanelState(qid);

    rightEl.querySelectorAll(".studio-right-tab").forEach((btn) => {
      btn.addEventListener("click", () => {
        studioState.rightTab = btn.dataset.rightTab || "live";
        if (studioState.rightTab === "archive" && rec.attempts.length) {
          studioState.selectedArchiveIdx = rec.attempts.length - 1;
        }
        refreshStudioRight();
      });
    });

    rightEl.querySelector(".studio-jump-archive-btn")?.addEventListener("click", () => {
      studioState.rightTab = "archive";
      studioState.selectedArchiveIdx = rec.attempts.length ? rec.attempts.length - 1 : null;
      refreshStudioRight();
    });

    // Self-eval rubric checkboxes
    rightEl.querySelectorAll(".mock-rubric-check").forEach((chk) => {
      chk.addEventListener("change", () => {
        const idx = Number(chk.dataset.rubricIdx);
        if (chk.checked) ps.checkedIndices.add(idx);
        else ps.checkedIndices.delete(idx);
        ps.selfEvalSaved = false;
        ps.lastSavedSelfAttemptIdx = null;
        refreshStudioRight();
      });
    });

    // Save self-eval score
    rightEl.querySelector(".mock-save-self-btn")?.addEventListener("click", () => {
      const keyPoints = Array.isArray(question.key_points) ? question.key_points : [];
      const checkedArr = Array.from(ps.checkedIndices)
        .filter((i) => i >= 0 && i < keyPoints.length)
        .sort((a, b) => a - b);
      const score = keyPoints.length ? Math.round((checkedArr.length / keyPoints.length) * 100) : 0;

      rec.attempts.push({
        ts: Date.now(),
        mode: "self",
        score,
        checkedIndices: checkedArr,
        answer: ps.selfEvalAnswer || rec.draft.trim(),
        aiFeedback: null,
        followUps: [],
      });
      saveRecords();
      ps.selfEvalSaved = true;
      ps.lastSavedSelfAttemptIdx = rec.attempts.length - 1;
      hooks.showToast(`已保存并归档自评得分：${score} 分`);
      hooks.onStatsChange();
      refreshStudioHeader();
      refreshStudioRight();
    });

    // Inline settings button on error
    rightEl.querySelector(".mock-open-settings-inline-btn")?.addEventListener("click", () => {
      openSettingsModal();
    });

    // Export Markdown & Print PDF (both live & archive tabs)
    rightEl.querySelectorAll(".studio-export-md-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        const idx = Number(btn.dataset.attemptIdx);
        const attempt = rec.attempts[idx];
        if (attempt) exportReportMarkdown(question, attempt);
      });
    });

    rightEl.querySelectorAll(".studio-print-pdf-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        const idx = Number(btn.dataset.attemptIdx);
        const attempt = rec.attempts[idx];
        if (attempt) printReportPdf(question, attempt);
      });
    });

    // Archive item selection
    rightEl.querySelectorAll("[data-q-archive-idx]").forEach((btn) => {
      btn.addEventListener("click", () => {
        studioState.selectedArchiveIdx = Number(btn.dataset.qArchiveIdx);
        refreshStudioRight();
      });
    });

    // Delete single attempt from per-question archive
    rightEl.querySelector(".studio-delete-attempt-btn")?.addEventListener("click", () => {
      const idx = Number(rightEl.querySelector(".studio-delete-attempt-btn").dataset.attemptIdx);
      if (idx < 0 || idx >= rec.attempts.length) return;
      rec.attempts.splice(idx, 1);
      saveRecords();

      // Keep live session pointer safe if deleted
      if (ps.aiSession) {
        if (ps.aiSession.attemptIndex === idx) ps.aiSession = null;
        else if (ps.aiSession.attemptIndex > idx) ps.aiSession.attemptIndex -= 1;
      }
      if (ps.lastSavedSelfAttemptIdx !== null) {
        if (ps.lastSavedSelfAttemptIdx === idx) {
          ps.selfEvalSaved = false;
          ps.lastSavedSelfAttemptIdx = null;
        } else if (ps.lastSavedSelfAttemptIdx > idx) {
          ps.lastSavedSelfAttemptIdx -= 1;
        }
      }

      studioState.selectedArchiveIdx = rec.attempts.length ? Math.min(idx, rec.attempts.length - 1) : null;
      hooks.showToast("已删除该条归档记录");
      hooks.onStatsChange();
      refreshStudioHeader();
      refreshStudioRight();
    });

    // Sticky bottom follow-up form
    const followUpInput = rightEl.querySelector(".mock-followup-input");
    const followUpForm = rightEl.querySelector(".mock-followup-form");

    if (followUpInput && ps.aiSession) {
      followUpInput.addEventListener("input", () => {
        if (ps.aiSession) ps.aiSession.followUpDraft = followUpInput.value;
      });
      followUpInput.addEventListener("keydown", (e) => {
        if ((e.ctrlKey || e.metaKey) && e.key === "Enter" && followUpForm) {
          e.preventDefault();
          followUpForm.requestSubmit ? followUpForm.requestSubmit() : followUpForm.dispatchEvent(new Event("submit", { cancelable: true }));
        }
      });
    }

    if (followUpForm && ps.aiSession) {
      followUpForm.addEventListener("submit", async (e) => {
        e.preventDefault();
        const session = ps.aiSession;
        if (!session || session.finished || session.followUpLoading) return;

        if (!isByokConfigured()) {
          hooks.showToast("AI 面试官配置已清除，请重新配置后再继续追问");
          openSettingsModal();
          return;
        }

        const replyVal = (followUpInput ? followUpInput.value : session.followUpDraft || "").trim();
        if (!replyVal) {
          hooks.showToast("请先输入对追问的回答再发送！");
          if (followUpInput) followUpInput.focus();
          return;
        }

        const nextRound = session.completedRounds + 1;
        const isFinalRound = nextRound >= MAX_FOLLOWUP_ROUNDS;

        session.followUps.push({
          role: "candidate",
          text: replyVal,
          round: nextRound,
          ts: Date.now(),
        });
        session.followUpDraft = "";
        session.followUpLoading = true;
        session.followUpError = null;

        // Immediately persist candidate reply to localStorage
        const persistedAttempt = rec.attempts[session.attemptIndex];
        if (persistedAttempt) {
          persistedAttempt.followUps = session.followUps.slice();
          saveRecords();
        }

        refreshStudioRight({ scrollToBottom: true });

        try {
          const initialAnswer = (persistedAttempt && persistedAttempt.answer) || rec.draft.trim();
          const msgs = buildFollowUpMessages(question, initialAnswer, session, isFinalRound);
          const aiReplyRaw = await callChatCompletions(config, msgs, {
            temperature: 0.3,
            max_tokens: 900,
            timeoutMs: 60000,
          });
          const formattedReply = parseFollowUpAiReply(aiReplyRaw, isFinalRound);

          session.followUps.push({
            role: "interviewer",
            text: formattedReply,
            round: nextRound,
            isFinal: isFinalRound,
            ts: Date.now(),
          });
          session.completedRounds = nextRound;
          session.finished = isFinalRound;
          session.followUpLoading = false;
          session.followUpError = null;

          // Immediately persist interviewer round reply to localStorage
          if (persistedAttempt) {
            persistedAttempt.followUps = session.followUps.slice();
            saveRecords();
          }

          if (isFinalRound) {
            hooks.showToast("🎉 2 轮连环追问已完成，完整对话已归档！");
          }
        } catch (err) {
          const lastMsg = session.followUps[session.followUps.length - 1];
          if (lastMsg && lastMsg.role === "candidate") {
            session.followUps.pop();
            session.followUpDraft = lastMsg.text;
          }
          if (persistedAttempt) {
            persistedAttempt.followUps = session.followUps.slice();
            saveRecords();
          }
          session.followUpLoading = false;
          session.followUpError = err && err.message ? err.message : "追问请求失败，请重试。";
        }

        refreshStudioRight({ scrollToBottom: true });
      });
    }
  }

  // ==================== Global Archive Modal (#archiveModal) ====================

  function collectAllArchivedEntries() {
    const entries = [];
    for (const qid of Object.keys(records)) {
      const rec = records[qid];
      const attempts = rec && Array.isArray(rec.attempts) ? rec.attempts : [];
      attempts.forEach((attempt, idx) => {
        entries.push({
          key: `${qid}::${idx}`,
          qid,
          attemptIndex: idx,
          attempt,
          question: resolveQuestion(qid),
        });
      });
    }
    entries.sort((a, b) => (Number(b.attempt.ts) || 0) - (Number(a.attempt.ts) || 0));
    return entries;
  }

  function openArchiveModal() {
    if (!modalsMounted) mountAllModals();
    archiveState.open = true;
    const modal = document.getElementById("archiveModal");
    if (!modal) return;
    modal.classList.remove("hidden");
    renderArchiveModalContent();
    syncBodyScrollLock();
  }

  function closeArchiveModal() {
    archiveState.open = false;
    const modal = document.getElementById("archiveModal");
    if (modal) modal.classList.add("hidden");
    syncBodyScrollLock();
  }

  function exportAllArchivesJson() {
    const payload = {
      version: 1,
      app: "AI Frontier Forge",
      exportedAt: new Date().toISOString(),
      records,
    };
    const filename = `ai-frontier-forge-archive-${formatFilenameStamp(Date.now())}.json`;
    triggerDownload(filename, JSON.stringify(payload, null, 2), "application/json;charset=utf-8");
    hooks.showToast(`已导出全部历史档案：${filename}`);
  }

  function importArchivesJsonFile(file) {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const parsed = JSON.parse(String(reader.result || ""));
        const incomingRecords = parsed && typeof parsed.records === "object" ? parsed.records : parsed;
        if (!incomingRecords || typeof incomingRecords !== "object" || Array.isArray(incomingRecords)) {
          throw new Error("无效的档案 JSON 格式");
        }

        let importedAttempts = 0;
        for (const qid of Object.keys(incomingRecords)) {
          const inc = incomingRecords[qid];
          if (!inc || typeof inc !== "object") continue;
          const local = ensureRecord(qid);

          if (typeof inc.draft === "string" && inc.draft.trim() && !local.draft.trim()) {
            local.draft = inc.draft;
          }

          if (Array.isArray(inc.attempts)) {
            const existingSig = new Set(local.attempts.map((a) => `${a.ts}|${a.mode}|${a.score}`));
            for (const a of inc.attempts) {
              if (!a || typeof a !== "object") continue;
              const sig = `${a.ts}|${a.mode}|${a.score}`;
              if (!existingSig.has(sig)) {
                local.attempts.push({
                  ts: Number(a.ts) || Date.now(),
                  mode: a.mode === "ai" ? "ai" : "self",
                  model: typeof a.model === "string" ? a.model : "",
                  score: clampScore(a.score, 0),
                  checkedIndices: Array.isArray(a.checkedIndices) ? a.checkedIndices : [],
                  answer: typeof a.answer === "string" ? a.answer : "",
                  aiFeedback: a.aiFeedback && typeof a.aiFeedback === "object" ? a.aiFeedback : null,
                  followUps: Array.isArray(a.followUps) ? a.followUps : [],
                });
                existingSig.add(sig);
                importedAttempts += 1;
              }
            }
            local.attempts.sort((x, y) => (Number(x.ts) || 0) - (Number(y.ts) || 0));
          }
        }

        saveRecords();
        hooks.onStatsChange();
        renderArchiveModalContent();
        if (studioState.open) {
          refreshStudioHeader();
          refreshStudioRight();
        }
        hooks.showToast(
          importedAttempts > 0
            ? `✅ 成功导入恢复 ${importedAttempts} 条模拟面试记录`
            : "导入完成（所有记录已存在，未重复添加）"
        );
      } catch (err) {
        hooks.showToast(`导入失败：${err && err.message ? err.message : "JSON 文件解析错误"}`);
      }
    };
    reader.readAsText(file, "utf-8");
  }

  function renderArchiveModalContent() {
    const modal = document.getElementById("archiveModal");
    if (!modal || !archiveState.open) return;

    const allEntries = collectAllArchivedEntries();
    const aiCount = allEntries.filter((e) => e.attempt.mode === "ai").length;
    const selfCount = allEntries.filter((e) => e.attempt.mode !== "ai").length;

    const filtered = allEntries.filter((e) => {
      if (archiveState.filter === "ai") return e.attempt.mode === "ai";
      if (archiveState.filter === "self") return e.attempt.mode !== "ai";
      return true;
    });

    if (!filtered.some((e) => e.key === archiveState.selectedKey)) {
      archiveState.selectedKey = filtered.length ? filtered[0].key : null;
    }
    const selected = filtered.find((e) => e.key === archiveState.selectedKey) || null;

    const listHtml = filtered.length
      ? filtered
          .map((e) => {
            const active = selected && selected.key === e.key;
            const scoreCls = getScoreClass(Number(e.attempt.score) || 0);
            const modeLabel = e.attempt.mode === "ai" ? "⚡ AI" : "📝 自评";
            const qaCount = Array.isArray(e.attempt.followUps) ? e.attempt.followUps.length : 0;
            return `
              <button type="button" class="archive-item ${active ? "active" : ""}" data-archive-key="${esc(e.key)}">
                <div style="font-weight: 600; font-size: 0.86rem; line-height: 1.35; text-align: left;">${esc(e.question.title)}</div>
                <div style="display: flex; justify-content: space-between; align-items: center; gap: 6px; margin-top: 5px; width: 100%;">
                  <span class="stat-sub">${modeLabel} · ${esc(formatDateTime(e.attempt.ts))}${qaCount ? ` · ${qaCount}条对话` : ""}</span>
                  <span class="mock-score-num ${scoreCls}" style="font-size: 0.9rem;">${e.attempt.score ?? "--"} 分</span>
                </div>
              </button>`;
          })
          .join("")
      : `<div class="studio-empty-guide" style="padding: 24px 12px;">
           <p class="stat-sub" style="margin: 0;">当前筛选下暂无归档记录。</p>
         </div>`;

    const detailHtml = selected
      ? `
        <div style="display: flex; justify-content: space-between; align-items: flex-start; gap: 10px; flex-wrap: wrap;">
          <h3 style="margin: 0; font-size: 1rem; line-height: 1.4;">${esc(selected.question.title)}</h3>
        </div>
        <div class="archive-meta-grid">
          <div><span class="stat-sub">专题：</span><strong>${esc(selected.question.topic || "-")}</strong></div>
          <div><span class="stat-sub">难度：</span><strong>${esc(selected.question.difficulty || "-")}</strong></div>
          <div><span class="stat-sub">时间：</span><strong>${esc(formatDateTime(selected.attempt.ts))}</strong></div>
          <div><span class="stat-sub">模式：</span><strong>${selected.attempt.mode === "ai" ? "AI 面试官" : "采分点自评"}</strong></div>
        </div>
        <div class="studio-report-actions" style="margin-top: 10px;">
          <button type="button" class="btn btn-primary btn-xs archive-export-md-btn">📝 导出 Markdown (.md)</button>
          <button type="button" class="btn btn-ghost btn-xs archive-print-pdf-btn">🖨️ 打印 / 另存 PDF</button>
          <button type="button" class="btn btn-ghost btn-xs archive-open-studio-btn">🎙️ 进入该题演练室</button>
          <button type="button" class="btn btn-ghost btn-xs archive-delete-btn" style="margin-left: auto; color: var(--red);">🗑️ 删除</button>
        </div>
        ${renderAttemptReportBodyHtml(selected.question, selected.attempt)}`
      : `
        <div class="studio-empty-guide">
          <div style="font-size: 1.6rem; margin-bottom: 8px;">📚</div>
          <h3 style="margin: 0 0 6px; font-size: 0.98rem;">暂无可查看的归档报告</h3>
          <p class="stat-sub" style="margin: 0;">完成任意题目的模拟自评或 AI 面试打分后，完整答卷、评分与多轮追问记录将自动归档于此，并支持导出 Markdown、打印 PDF 与 JSON 全量备份。</p>
        </div>`;

    const bodyEl = modal.querySelector(".archive-modal-content");
    if (!bodyEl) return;

    bodyEl.innerHTML = `
      <div class="archive-toolbar">
        <div style="display: flex; gap: 6px; flex-wrap: wrap;">
          <button type="button" class="preset-btn archive-filter-btn ${archiveState.filter === "all" ? "active" : ""}" data-filter="all">全部 (${allEntries.length})</button>
          <button type="button" class="preset-btn archive-filter-btn ${archiveState.filter === "ai" ? "active" : ""}" data-filter="ai">⚡ AI 面试官 (${aiCount})</button>
          <button type="button" class="preset-btn archive-filter-btn ${archiveState.filter === "self" ? "active" : ""}" data-filter="self">📝 采分点自评 (${selfCount})</button>
        </div>
        <div style="display: flex; gap: 8px; flex-wrap: wrap;">
          <button type="button" class="btn btn-ghost btn-xs archive-export-all-btn">📤 导出全部档案 (.json)</button>
          <button type="button" class="btn btn-ghost btn-xs archive-import-btn">📥 导入恢复 (.json)</button>
          <input type="file" id="archiveImportFileInput" accept=".json,application/json" style="display: none;" />
        </div>
      </div>
      <div class="archive-layout">
        <div class="archive-list">${listHtml}</div>
        <div class="archive-detail">${detailHtml}</div>
      </div>`;

    // Bind events
    bodyEl.querySelectorAll(".archive-filter-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        archiveState.filter = btn.dataset.filter || "all";
        renderArchiveModalContent();
      });
    });

    bodyEl.querySelectorAll("[data-archive-key]").forEach((btn) => {
      btn.addEventListener("click", () => {
        archiveState.selectedKey = btn.dataset.archiveKey;
        renderArchiveModalContent();
      });
    });

    bodyEl.querySelector(".archive-export-all-btn")?.addEventListener("click", exportAllArchivesJson);

    const fileInput = bodyEl.querySelector("#archiveImportFileInput");
    bodyEl.querySelector(".archive-import-btn")?.addEventListener("click", () => {
      if (fileInput) fileInput.click();
    });
    fileInput?.addEventListener("change", () => {
      if (fileInput.files && fileInput.files[0]) {
        importArchivesJsonFile(fileInput.files[0]);
        fileInput.value = "";
      }
    });

    if (selected) {
      bodyEl.querySelector(".archive-export-md-btn")?.addEventListener("click", () => {
        exportReportMarkdown(selected.question, selected.attempt);
      });
      bodyEl.querySelector(".archive-print-pdf-btn")?.addEventListener("click", () => {
        printReportPdf(selected.question, selected.attempt);
      });
      bodyEl.querySelector(".archive-open-studio-btn")?.addEventListener("click", () => {
        closeArchiveModal();
        openStudio(selected.qid, { initialTab: "live" });
      });
      bodyEl.querySelector(".archive-delete-btn")?.addEventListener("click", () => {
        const rec = ensureRecord(selected.qid);
        if (selected.attemptIndex >= 0 && selected.attemptIndex < rec.attempts.length) {
          rec.attempts.splice(selected.attemptIndex, 1);
          saveRecords();
          const ps = panelState[selected.qid];
          if (ps && ps.aiSession) {
            if (ps.aiSession.attemptIndex === selected.attemptIndex) ps.aiSession = null;
            else if (ps.aiSession.attemptIndex > selected.attemptIndex) ps.aiSession.attemptIndex -= 1;
          }
          hooks.showToast("已删除该条归档记录");
          hooks.onStatsChange();
          renderArchiveModalContent();
          if (studioState.open && studioState.questionId === selected.qid) {
            refreshStudioHeader();
            refreshStudioRight();
          }
        }
      });
    }
  }

  // ==================== BYOK Settings Modal (#aiSettingsModal) ====================

  function renderSettingsModalHtml() {
    const presetButtonsHtml = Object.values(PRESETS)
      .map(
        (p) =>
          `<button type="button" class="preset-btn ${config.preset === p.id ? "active" : ""}" data-preset="${esc(p.id)}">${esc(p.label)}</button>`
      )
      .join("");

    return `
      <div id="aiSettingsModal" class="modal-backdrop hidden" role="dialog" aria-modal="true" aria-labelledby="aiSettingsTitle">
        <div class="modal-dialog">
          <div class="modal-header">
            <h2 id="aiSettingsTitle" style="margin: 0; font-size: 1.08rem;">🤖 配置 AI 模拟面试官（可选 BYOK）</h2>
            <button type="button" id="aiModalCloseBtn" class="btn btn-ghost btn-xs" aria-label="关闭弹窗">✕</button>
          </div>
          <div class="modal-body">
            <div class="privacy-notice">
              <strong>🔒 隐私与安全声明（零后端纯本地）：</strong>
              你的 API Key <strong>仅保存在当前浏览器的 <code>localStorage</code></strong>，本站无任何后端服务器，绝不上传或中转你的密钥；开启 AI 批改时，请求直接从浏览器发往你选择的 OpenAI 兼容服务商。不配置也可永久使用「免 Key 采分点自评」与「一键复制批改 Prompt」。
            </div>

            <div class="form-field">
              <div class="form-label">快捷服务商预设</div>
              <div class="preset-row">${presetButtonsHtml}</div>
            </div>

            <div class="form-field">
              <label class="form-label" for="aiBaseUrlInput">API Base URL（OpenAI 兼容，含 /v1）</label>
              <input id="aiBaseUrlInput" class="form-input" type="url" placeholder="例如：https://api.deepseek.com/v1" value="${esc(config.baseUrl)}" />
            </div>

            <div class="form-field">
              <label class="form-label" for="aiApiKeyInput">API Key</label>
              <div class="input-with-toggle">
                <input id="aiApiKeyInput" class="form-input" type="password" autocomplete="off" spellcheck="false" placeholder="sk-..." value="${esc(config.apiKey)}" />
                <button type="button" id="aiToggleKeyVisBtn" class="btn btn-ghost btn-sm" title="显示或隐藏 API Key">👁️</button>
              </div>
            </div>

            <div class="form-field">
              <label class="form-label" for="aiModelInput">模型名称（Model）</label>
              <input id="aiModelInput" class="form-input" type="text" placeholder="例如：deepseek-chat / gpt-4o-mini" value="${esc(config.model)}" />
            </div>

            <div id="aiTestResultBox" class="test-result-box hidden" role="status" aria-live="polite"></div>
          </div>
          <div class="modal-footer">
            <button type="button" id="aiTestConnBtn" class="btn btn-ghost btn-sm">🔌 测试连接</button>
            <div style="display: flex; gap: 8px; flex-wrap: wrap;">
              <button type="button" id="aiClearKeyBtn" class="btn btn-ghost btn-sm">清除 Key</button>
              <button type="button" id="aiSaveConfigBtn" class="btn btn-primary btn-sm">保存配置</button>
            </div>
          </div>
        </div>
      </div>`;
  }

  function renderStudioShellHtml() {
    return `
      <div id="interviewStudioModal" class="modal-backdrop studio-backdrop hidden" role="dialog" aria-modal="true" aria-labelledby="studioModalTitle">
        <div class="modal-dialog studio-dialog">
          <div class="studio-header"></div>
          <div class="studio-body">
            <section class="studio-left"></section>
            <section class="studio-right"></section>
          </div>
        </div>
      </div>`;
  }

  function renderArchiveShellHtml() {
    return `
      <div id="archiveModal" class="modal-backdrop hidden" role="dialog" aria-modal="true" aria-labelledby="archiveModalTitle">
        <div class="modal-dialog archive-dialog">
          <div class="modal-header">
            <h2 id="archiveModalTitle" style="margin: 0; font-size: 1.08rem;">📚 模拟面试历史档案库</h2>
            <button type="button" id="archiveModalCloseBtn" class="btn btn-ghost btn-xs" aria-label="关闭档案库">✕ 关闭</button>
          </div>
          <div class="modal-body archive-modal-content" style="padding: 14px 18px; display: flex; flex-direction: column; min-height: 0; flex: 1;"></div>
        </div>
      </div>`;
  }

  function setTestResult(status, message) {
    const box = document.getElementById("aiTestResultBox");
    if (!box) return;
    box.classList.remove("hidden", "is-ok", "is-err");
    if (status === "ok") box.classList.add("is-ok");
    else if (status === "err") box.classList.add("is-err");
    box.textContent = message;
  }

  function hideTestResult() {
    const box = document.getElementById("aiTestResultBox");
    if (!box) return;
    box.classList.add("hidden");
    box.classList.remove("is-ok", "is-err");
    box.textContent = "";
  }

  function syncModalInputsFromConfig() {
    const modal = document.getElementById("aiSettingsModal");
    if (!modal) return;
    modalActivePreset = config.preset || "deepseek";

    const baseInput = document.getElementById("aiBaseUrlInput");
    const keyInput = document.getElementById("aiApiKeyInput");
    const modelInput = document.getElementById("aiModelInput");
    const toggleKeyBtn = document.getElementById("aiToggleKeyVisBtn");

    if (baseInput) baseInput.value = config.baseUrl || "";
    if (keyInput) {
      keyInput.value = config.apiKey || "";
      keyInput.type = "password";
    }
    if (toggleKeyBtn) toggleKeyBtn.textContent = "👁️";
    if (modelInput) modelInput.value = config.model || "";

    modal.querySelectorAll(".preset-btn").forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.preset === modalActivePreset);
    });
    hideTestResult();
  }

  function closeSettingsModal() {
    const modal = document.getElementById("aiSettingsModal");
    if (modal) modal.classList.add("hidden");
    syncBodyScrollLock();
  }

  function openSettingsModal() {
    if (!modalsMounted) mountAllModals();
    const modal = document.getElementById("aiSettingsModal");
    if (!modal) return;
    syncModalInputsFromConfig();
    modal.classList.remove("hidden");
    syncBodyScrollLock();

    const firstEmpty = !config.baseUrl
      ? document.getElementById("aiBaseUrlInput")
      : !config.apiKey
        ? document.getElementById("aiApiKeyInput")
        : document.getElementById("aiModelInput");
    if (firstEmpty) firstEmpty.focus();
  }

  function mountAllModals() {
    const root = document.getElementById("interviewModalRoot");
    if (!root) return;
    // Order: Studio -> Archive -> Settings (so Settings can layer cleanly above Studio/Archive)
    root.innerHTML = renderStudioShellHtml() + renderArchiveShellHtml() + renderSettingsModalHtml();
    modalsMounted = true;

    // Bind Studio backdrop click
    const studioModal = document.getElementById("interviewStudioModal");
    studioModal?.addEventListener("click", (e) => {
      if (e.target === studioModal) closeStudio();
    });

    // Bind Archive backdrop & close click
    const archiveModal = document.getElementById("archiveModal");
    archiveModal?.addEventListener("click", (e) => {
      if (e.target === archiveModal) closeArchiveModal();
    });
    document.getElementById("archiveModalCloseBtn")?.addEventListener("click", closeArchiveModal);

    // Bind Settings modal
    const settingsModal = document.getElementById("aiSettingsModal");
    const baseInput = document.getElementById("aiBaseUrlInput");
    const keyInput = document.getElementById("aiApiKeyInput");
    const modelInput = document.getElementById("aiModelInput");
    const toggleKeyBtn = document.getElementById("aiToggleKeyVisBtn");
    const testBtn = document.getElementById("aiTestConnBtn");
    const saveBtn = document.getElementById("aiSaveConfigBtn");
    const clearBtn = document.getElementById("aiClearKeyBtn");
    const closeBtn = document.getElementById("aiModalCloseBtn");

    settingsModal?.addEventListener("click", (e) => {
      if (e.target === settingsModal) closeSettingsModal();
    });
    closeBtn?.addEventListener("click", closeSettingsModal);

    if (!globalEscBound) {
      globalEscBound = true;
      document.addEventListener("keydown", (e) => {
        if (e.key !== "Escape") return;
        const sm = document.getElementById("aiSettingsModal");
        if (sm && !sm.classList.contains("hidden")) {
          closeSettingsModal();
          return;
        }
        if (archiveState.open) {
          closeArchiveModal();
          return;
        }
        if (studioState.open) {
          closeStudio();
        }
      });
    }

    settingsModal?.querySelectorAll(".preset-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        const pid = btn.dataset.preset;
        const p = PRESETS[pid];
        if (!p) return;
        modalActivePreset = pid;
        settingsModal.querySelectorAll(".preset-btn").forEach((b) => {
          b.classList.toggle("active", b.dataset.preset === pid);
        });
        if (pid !== "custom") {
          if (baseInput) baseInput.value = p.baseUrl;
          if (modelInput) modelInput.value = p.model;
        }
        hideTestResult();
      });
    });

    toggleKeyBtn?.addEventListener("click", () => {
      if (!keyInput) return;
      const isPwd = keyInput.type === "password";
      keyInput.type = isPwd ? "text" : "password";
      toggleKeyBtn.textContent = isPwd ? "🙈" : "👁️";
    });

    testBtn?.addEventListener("click", async () => {
      const candidate = {
        baseUrl: baseInput ? baseInput.value.trim() : "",
        apiKey: keyInput ? keyInput.value.trim() : "",
        model: modelInput ? modelInput.value.trim() : "",
      };
      if (!candidate.baseUrl || !candidate.apiKey || !candidate.model) {
        setTestResult("err", "请先完整填写 Base URL、API Key 和 Model 名称后再测试连接。");
        return;
      }

      testBtn.disabled = true;
      testBtn.textContent = "⏳ 测试中...";
      setTestResult("", "正在从浏览器直连测试模型接口...");
      const startTs = Date.now();

      try {
        const reply = await callChatCompletions(
          candidate,
          [{ role: "user", content: "Reply with OK only." }],
          { max_tokens: 16, temperature: 0, timeoutMs: 20000 }
        );
        const elapsed = Date.now() - startTs;
        setTestResult("ok", `✅ 连接成功（${elapsed} ms）· 模型响应：${reply.slice(0, 40)}`);
      } catch (err) {
        setTestResult("err", `❌ ${err && err.message ? err.message : "连接测试失败"}`);
      } finally {
        testBtn.disabled = false;
        testBtn.textContent = "🔌 测试连接";
      }
    });

    saveBtn?.addEventListener("click", () => {
      const next = {
        preset: modalActivePreset,
        baseUrl: baseInput ? baseInput.value.trim() : "",
        apiKey: keyInput ? keyInput.value.trim() : "",
        model: modelInput ? modelInput.value.trim() : "",
      };
      if (!next.baseUrl || !next.apiKey || !next.model) {
        setTestResult("err", "保存失败：Base URL、API Key 和 Model 均不能为空（如需关闭 BYOK 请点「清除 Key」）。");
        return;
      }
      saveConfig(next);
      window.ForgeAnalytics?.track?.("byok_config_saved", { preset: next.preset || "custom" });
      updateTopbarButton();
      closeSettingsModal();
      hooks.showToast(`✅ AI 面试官已配置为 ${config.model}（仅保存在本地）`);
      hooks.onStatsChange();
      if (studioState.open) refreshStudioHeader();
    });

    clearBtn?.addEventListener("click", () => {
      clearConfig();
      syncModalInputsFromConfig();
      updateTopbarButton();
      hooks.showToast("已清除本地保存的 API Key，已切回免 Key 自评模式");
      hooks.onStatsChange();
      if (studioState.open) refreshStudioHeader();
    });
  }

  // ==================== Init ====================

  function init(options = {}) {
    hooks = {
      getQuestionById: typeof options.getQuestionById === "function" ? options.getQuestionById : () => null,
      showToast: typeof options.showToast === "function" ? options.showToast : () => {},
      onStatsChange: typeof options.onStatsChange === "function" ? options.onStatsChange : () => {},
      escapeHtml: typeof options.escapeHtml === "function" ? options.escapeHtml : defaultEscapeHtml,
      renderInlineMarkdown:
        typeof options.renderInlineMarkdown === "function" ? options.renderInlineMarkdown : defaultRenderInlineMarkdown,
    };

    config = loadConfig();
    records = loadRecords();
    mountAllModals();
    updateTopbarButton();
  }

  window.ForgeInterview = {
    init,
    openStudio,
    closeTopModal,
    openArchiveModal,
    renderCardStripHtml,
    isOpen,
    setOpen,
    toggleOpen,
    getQuestionSummary,
    getStats,
    renderPanelHtml,
    bindCard,
    openSettingsModal,
    cleanupTimers,
  };
})();
