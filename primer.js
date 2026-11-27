(() => {
  const PRIMER_KEY = "ai_frontier_forge_primer_v1";

  let deps = {};
  let activeLessonId = null;
  let activeAssetKind = "questions";
  let pState = loadState();

  function loadState() {
    try {
      const raw = JSON.parse(localStorage.getItem(PRIMER_KEY) || "{}");
      return {
        completed: raw && typeof raw.completed === "object" && raw.completed ? raw.completed : {},
        quiz: raw && typeof raw.quiz === "object" && raw.quiz ? raw.quiz : {},
      };
    } catch {
      return { completed: {}, quiz: {} };
    }
  }

  function saveState() {
    try {
      localStorage.setItem(PRIMER_KEY, JSON.stringify(pState));
    } catch {
      // Ignore storage quota errors
    }
  }

  function esc(s) {
    return deps.escapeHtml ? deps.escapeHtml(s) : String(s || "");
  }

  function md(s) {
    return deps.renderInlineMarkdown ? deps.renderInlineMarkdown(s) : esc(s);
  }

  function getLessons() {
    const kb = deps.getKb ? deps.getKb() : {};
    return Array.isArray(kb.lessons) ? kb.lessons : [];
  }

  function getLinkedAssets(sourceUrl) {
    const kb = deps.getKb ? deps.getKb() : {};
    return {
      questions: (kb.questions || []).filter((x) => x.source_url === sourceUrl),
      prompts: (kb.prompts || []).filter((x) => x.source_url === sourceUrl),
      pitfalls: (kb.pitfalls || []).filter((x) => x.source_url === sourceUrl),
    };
  }

  function getProgressStats() {
    const lessons = getLessons();
    const total = lessons.length;
    const done = lessons.filter((l) => Boolean(pState.completed[l.id])).length;
    const nextLesson = lessons.find((l) => !pState.completed[l.id]) || lessons[0] || null;
    return { total, done, pct: total ? Math.round((done / total) * 100) : 0, nextLesson };
  }

  function openLessonById(lessonId, opts) {
    const lessons = getLessons();
    if (!lessons.some((l) => l.id === lessonId)) return false;
    activeLessonId = lessonId;
    activeAssetKind = "questions";
    if (!opts || opts.push !== false) {
      window.ForgePlatform?.pushNavLayer?.("primer-lesson");
    }
    deps.renderContent?.();
    window.scrollTo({ top: 0, behavior: "instant" });
    return true;
  }

  function openLessonByUrl(primerUrl) {
    const lesson = getLessons().find((l) => l.source_url === primerUrl);
    if (!lesson) return false;
    deps.closeDrawer?.(true);
    if (deps.getActiveTab?.() !== "primer") {
      deps.switchTab?.("primer", { push: true });
    }
    return openLessonById(lesson.id, { push: true });
  }

  function closeActiveLesson(fromPop) {
    if (!activeLessonId) return false;
    activeLessonId = null;
    if (!fromPop) window.ForgePlatform?.popNavLayer?.("primer-lesson");
    deps.renderContent?.();
    window.scrollTo({ top: 0, behavior: "instant" });
    return true;
  }

  function renderSourceLink(item) {
    const url = String(item?.source_url || "").trim();
    const title = String(item?.source_title || "").trim();
    if (url.startsWith("primer://")) {
      return `<button type="button" class="btn btn-ghost btn-xs jump-primer-lesson-btn" data-primer-url="${esc(url)}">🎓 回到对应通识课：${esc(title)} →</button>`;
    }
    return `<a href="${esc(url)}" target="_blank" rel="noopener noreferrer">${esc(title)} ↗</a>`;
  }

  function renderOverviewBanner() {
    const stats = getProgressStats();
    if (!stats.total) return "";
    const kb = deps.getKb ? deps.getKb() : {};
    const l0Q = (kb.questions || []).filter((x) => (x.level || x.difficulty) === "L0").length;
    const nextOrder = stats.nextLesson ? stats.nextLesson.order : 1;
    const ctaText =
      stats.done === 0
        ? "🎓 开始第 1 课（3 分钟入门）"
        : stats.done < stats.total
          ? `🎓 继续学习第 ${nextOrder} 课 (${stats.done}/${stats.total})`
          : `🎓 已通关全部 ${stats.total} 课 · 随时复习`;

    return `
      <section class="primer-overview-banner" aria-label="零基础通识入口">
        <div class="primer-banner-main">
          <div class="primer-banner-badge">🐣 零基础小白专区 · 100% 说人话 + 生活类比</div>
          <h2 class="primer-banner-title">觉得前沿面试题太硬核？先花 20 分钟通关这 ${stats.total} 节 AI 零基础通识课</h2>
          <p class="primer-banner-desc">不堆黑话、不写代码：从 Token/幻觉、Prompt 提问、RAG vs 微调，到 Agent、MCP、Eval 评测与省钱选型，每课配随堂小测 + 配套 L0 题库 / 提示词 / 避坑。</p>
          <div class="primer-banner-actions">
            <button type="button" class="btn btn-primary btn-sm primer-start-next-btn" data-lesson-id="${esc(stats.nextLesson?.id || "")}">${esc(ctaText)}</button>
            <button type="button" class="btn btn-ghost btn-sm primer-open-hub-btn">🗺️ 查看全部 ${stats.total} 节课程</button>
            <button type="button" class="btn btn-ghost btn-sm primer-jump-l0-btn" data-target-tab="questions">🧠 直达 L0 白话题库 (${l0Q} 题)</button>
          </div>
        </div>
        <div class="primer-banner-progress">
          <div class="primer-ring-num">${stats.done}<span>/${stats.total}</span></div>
          <div class="stat-sub">已完成课程</div>
          <div class="progress-bar" style="width:100%;margin-top:8px;"><div class="progress-fill" style="width:${stats.pct}%"></div></div>
        </div>
      </section>`;
  }

  function renderHub(lessons) {
    const stats = getProgressStats();
    const kb = deps.getKb ? deps.getKb() : {};
    const l0Q = (kb.questions || []).filter((x) => (x.level || x.difficulty) === "L0").length;
    const l0P = (kb.prompts || []).filter((x) => x.level === "L0").length;
    const l0K = (kb.pitfalls || []).filter((x) => x.level === "L0").length;

    const cardsHtml = lessons
      .map((lesson) => {
        const done = Boolean(pState.completed[lesson.id]);
        const linked = getLinkedAssets(lesson.source_url);
        return `
          <article class="primer-lesson-card ${done ? "is-done" : ""}" data-open-lesson="${esc(lesson.id)}" tabindex="0" role="button">
            <div class="primer-card-top">
              <span class="primer-order-pill">第 ${lesson.order} 课 · ${lesson.reading_minutes || 3} 分钟</span>
              <span class="primer-status-pill ${done ? "done" : ""}">${done ? "✅ 已学完" : "▶ 开始学"}</span>
            </div>
            <h3 class="primer-card-title"><span class="primer-emoji">${esc(lesson.emoji || "📘")}</span>${esc(lesson.title)}</h3>
            <p class="primer-card-sub">${esc(lesson.subtitle || "")}</p>
            <div class="primer-card-oneliner">💡 ${esc(lesson.one_liner)}</div>
            <div class="primer-card-foot">
              <span class="badge">${esc(lesson.topic)}</span>
              <span class="primer-linked-counts">配套：🧠 ${linked.questions.length} 题 · ✨ ${linked.prompts.length} 词 · 🛡️ ${linked.pitfalls.length} 坑</span>
            </div>
          </article>`;
      })
      .join("");

    return `
      <section class="primer-hub">
        <div class="primer-hero">
          <div class="primer-hero-top">
            <div>
              <div class="primer-banner-badge">🎓 站内原创沉浸式科普 · 无需技术背景</div>
              <h2 class="primer-hero-title">AI 零基础通识课：20 分钟打通底层直觉</h2>
              <p class="primer-hero-sub">专为零基础 / 转行 / 产品与非技术同学手搓，告别术语墙。按顺序逐课读完、做完 10 秒随堂小测，再顺手刷本课配套 L0 题，就能听懂 90% 的 AI 工程对话。</p>
            </div>
            <div class="primer-hero-meter">
              <div class="primer-ring-num">${stats.done}<span>/${stats.total}</span></div>
              <div class="stat-sub">学习进度 ${stats.pct}%</div>
              <div class="progress-bar" style="width:140px;margin-top:6px;"><div class="progress-fill" style="width:${stats.pct}%"></div></div>
            </div>
          </div>
          <div class="primer-quick-strip">
            <button type="button" class="btn btn-primary btn-xs primer-start-next-btn" data-lesson-id="${esc(stats.nextLesson?.id || "")}">▶ ${stats.done === 0 ? "从第 1 课开始" : `继续第 ${stats.nextLesson?.order || 1} 课`}</button>
            <button type="button" class="btn btn-ghost btn-xs primer-jump-l0-btn" data-target-tab="questions">🧠 全部 L0 白话题库 (${l0Q})</button>
            <button type="button" class="btn btn-ghost btn-xs primer-jump-l0-btn" data-target-tab="prompts">✨ 全部 L0 小白提示词 (${l0P})</button>
            <button type="button" class="btn btn-ghost btn-xs primer-jump-l0-btn" data-target-tab="pitfalls">🛡️ 全部 L0 新手避坑 (${l0K})</button>
          </div>
        </div>
        <div class="primer-grid">${cardsHtml}</div>
      </section>`;
  }

  function renderLinkedAssetCards(linked) {
    const list = linked[activeAssetKind] || [];
    if (!list.length) return `<div class="empty-state" style="padding:20px;">本课该分类暂无配套条目</div>`;
    return list
      .map((item) => {
        const preview =
          activeAssetKind === "questions"
            ? item.scenario
            : activeAssetKind === "prompts"
              ? item.use_case
              : item.symptom;
        const mockBtn =
          activeAssetKind === "questions"
            ? `<button type="button" class="btn btn-ghost btn-xs primer-mock-q-btn" data-qid="${esc(item.id)}">🎙️ 模拟练这题</button>`
            : "";
        return `
          <div class="primer-asset-row" data-open-drawer-tab="${esc(activeAssetKind)}" data-open-drawer-id="${esc(item.id)}">
            <div class="primer-asset-main">
              <div class="primer-asset-title">${esc(item.title)}</div>
              <div class="primer-asset-preview">${esc((preview || "").slice(0, 95))}${(preview || "").length > 95 ? "..." : ""}</div>
            </div>
            <div class="primer-asset-actions">
              ${mockBtn}
              <button type="button" class="btn btn-primary btn-xs">查看详解 →</button>
            </div>
          </div>`;
      })
      .join("");
  }

  function renderLessonDetail(lesson, lessons) {
    const idx = lessons.findIndex((l) => l.id === lesson.id);
    const prev = idx > 0 ? lessons[idx - 1] : null;
    const next = idx >= 0 && idx < lessons.length - 1 ? lessons[idx + 1] : null;
    const done = Boolean(pState.completed[lesson.id]);
    const picked = pState.quiz[lesson.id];
    const hasAnswered = typeof picked === "number";
    const qc = lesson.quick_check || {};
    const isCorrect = hasAnswered && picked === qc.answer_index;
    const linked = getLinkedAssets(lesson.source_url);

    const conceptsHtml = (lesson.core_concepts || [])
      .map(
        (c) => `
        <div class="primer-concept-card">
          <div class="primer-concept-term">${esc(c.term)}</div>
          <p class="primer-concept-plain">${md(c.plain)}</p>
          <div class="primer-concept-ex">🌰 <strong>举个栗子：</strong>${md(c.example)}</div>
        </div>`
      )
      .join("");

    const cmp = lesson.comparison;
    const tableHtml =
      cmp && Array.isArray(cmp.headers) && Array.isArray(cmp.rows)
        ? `
        <section class="primer-section">
          <h3 class="primer-sec-title">📊 ${esc(cmp.title)}</h3>
          <div class="primer-table-wrap">
            <table class="primer-table">
              <thead><tr>${cmp.headers.map((h) => `<th>${esc(h)}</th>`).join("")}</tr></thead>
              <tbody>${cmp.rows.map((r) => `<tr>${r.map((cell) => `<td>${md(cell)}</td>`).join("")}</tr>`).join("")}</tbody>
            </table>
          </div>
        </section>`
        : "";

    const optionsHtml = (qc.options || [])
      .map((opt, i) => {
        let cls = "primer-quiz-opt";
        if (hasAnswered) {
          if (i === qc.answer_index) cls += " is-correct";
          else if (i === picked) cls += " is-wrong";
        }
        const letter = String.fromCharCode(65 + i);
        return `<button type="button" class="${cls}" data-quiz-lesson="${esc(lesson.id)}" data-quiz-idx="${i}">
          <span class="primer-opt-letter">${letter}</span>
          <span>${esc(opt)}</span>
        </button>`;
      })
      .join("");

    const quizFeedbackHtml = hasAnswered
      ? `<div class="primer-quiz-feedback ${isCorrect ? "ok" : "warn"}">
          <strong>${isCorrect ? "🎉 答对了！" : "💡 差一点点，看看人话解析："}</strong>
          <span>${md(qc.explanation || "")}</span>
        </div>`
      : "";

    const takeawaysHtml = (lesson.takeaways || [])
      .map((t) => `<li>${md(t)}</li>`)
      .join("");

    return `
      <article class="primer-reader">
        <div class="primer-reader-bar">
          <button type="button" class="btn btn-ghost btn-sm primer-back-hub-btn">← 返回全部课程</button>
          <div class="primer-reader-meta">第 ${lesson.order} / ${lessons.length} 课 · 约 ${lesson.reading_minutes || 3} 分钟</div>
          <button type="button" class="btn ${done ? "btn-ghost" : "btn-primary"} btn-sm primer-toggle-done-btn" data-lesson-id="${esc(lesson.id)}">
            ${done ? "✅ 已标记学完" : "○ 标记本课已学"}
          </button>
        </div>

        <header class="primer-reader-head">
          <div class="badges" style="margin-bottom:10px;">
            <span class="badge badge-L0">🐣 零基础通识 L0</span>
            <span class="badge">${esc(lesson.topic)}</span>
          </div>
          <h2 class="primer-reader-title">${esc(lesson.emoji || "📘")} ${esc(lesson.title)}</h2>
          <p class="primer-reader-sub">${esc(lesson.subtitle || "")}</p>
          <div class="primer-oneliner-box">
            <div class="primer-box-label">💡 一句话人话</div>
            <p>${md(lesson.one_liner)}</p>
          </div>
        </header>

        <section class="primer-analogy-box">
          <div class="primer-box-label">${esc(lesson.analogy?.title || "🍳 生活类比")}</div>
          <p>${md(lesson.analogy?.body || "")}</p>
        </section>

        <section class="primer-section">
          <h3 class="primer-sec-title">🧩 拆解核心概念（不背书，先懂直觉）</h3>
          <div class="primer-concept-grid">${conceptsHtml}</div>
        </section>

        ${tableHtml}

        <section class="primer-section primer-quiz-box">
          <h3 class="primer-sec-title">🧪 10 秒随堂小测验（点选即刻验证）</h3>
          <p class="primer-quiz-q">${md(qc.question || "")}</p>
          <div class="primer-quiz-options">${optionsHtml}</div>
          ${quizFeedbackHtml}
        </section>

        <section class="primer-section primer-takeaway-box">
          <h3 class="primer-sec-title">💬 记住这 3 句话，聊天/面试直接能用</h3>
          <ul class="bullet-list">${takeawaysHtml}</ul>
        </section>

        <section class="primer-section primer-practice-box">
          <div class="primer-practice-head">
            <div>
              <h3 class="primer-sec-title" style="margin:0;">🎯 本课配套「学练一体」</h3>
              <div class="stat-sub">刚懂概念，立刻看本课对应的白话面试题、即用提示词与新手避坑</div>
            </div>
            <div class="primer-asset-tabs">
              <button type="button" class="btn btn-xs ${activeAssetKind === "questions" ? "btn-primary" : "btn-ghost"} primer-asset-tab-btn" data-asset-kind="questions">🧠 面试题 (${linked.questions.length})</button>
              <button type="button" class="btn btn-xs ${activeAssetKind === "prompts" ? "btn-primary" : "btn-ghost"} primer-asset-tab-btn" data-asset-kind="prompts">✨ 提示词 (${linked.prompts.length})</button>
              <button type="button" class="btn btn-xs ${activeAssetKind === "pitfalls" ? "btn-primary" : "btn-ghost"} primer-asset-tab-btn" data-asset-kind="pitfalls">🛡️ 避坑 (${linked.pitfalls.length})</button>
            </div>
          </div>
          <div class="primer-asset-list">${renderLinkedAssetCards(linked)}</div>
        </section>

        <nav class="primer-footer-nav" aria-label="课程翻页">
          ${prev ? `<button type="button" class="btn btn-ghost btn-sm primer-nav-lesson-btn" data-lesson-id="${esc(prev.id)}">← 上一课：第 ${prev.order} 课</button>` : `<span></span>`}
          ${
            next
              ? `<button type="button" class="btn btn-primary btn-sm primer-complete-next-btn" data-cur-id="${esc(lesson.id)}" data-next-id="${esc(next.id)}">✅ 完成本课并学第 ${next.order} 课 →</button>`
              : `<button type="button" class="btn btn-primary btn-sm primer-complete-finish-btn" data-cur-id="${esc(lesson.id)}">🎉 标记通关并返回课程地图</button>`
          }
        </nav>
      </article>`;
  }

  function renderPrimerView(lessons) {
    const list = Array.isArray(lessons) ? lessons : getLessons();
    if (!list.length) return `<div class="empty-state">通识课程正在加载中...</div>`;
    if (activeLessonId) {
      const found = list.find((l) => l.id === activeLessonId);
      if (found) return renderLessonDetail(found, list);
      activeLessonId = null;
    }
    return renderHub(list);
  }

  function handleClick(target) {
    const jumpPrimer = target.closest(".jump-primer-lesson-btn");
    if (jumpPrimer) {
      openLessonByUrl(jumpPrimer.dataset.primerUrl);
      return true;
    }
    const startNext = target.closest(".primer-start-next-btn");
    if (startNext) {
      const lid = startNext.dataset.lessonId;
      if (deps.getActiveTab?.() !== "primer") deps.switchTab?.("primer", { push: true });
      if (lid) openLessonById(lid, { push: true });
      return true;
    }
    if (target.closest(".primer-open-hub-btn")) {
      activeLessonId = null;
      deps.switchTab?.("primer", { push: true });
      return true;
    }
    const jumpL0 = target.closest(".primer-jump-l0-btn");
    if (jumpL0) {
      const tab = jumpL0.dataset.targetTab || "questions";
      deps.jumpToLevel?.("L0", tab);
      return true;
    }
    const openCard = target.closest("[data-open-lesson]");
    if (openCard) {
      openLessonById(openCard.dataset.openLesson, { push: true });
      return true;
    }
    if (target.closest(".primer-back-hub-btn")) {
      closeActiveLesson(false);
      return true;
    }
    const toggleDone = target.closest(".primer-toggle-done-btn");
    if (toggleDone) {
      const id = toggleDone.dataset.lessonId;
      if (pState.completed[id]) delete pState.completed[id];
      else pState.completed[id] = true;
      saveState();
      deps.renderContent?.();
      deps.showToast?.(pState.completed[id] ? "✅ 已标记本课学完！" : "已取消完成标记");
      return true;
    }
    const quizOpt = target.closest("[data-quiz-lesson]");
    if (quizOpt) {
      const id = quizOpt.dataset.quizLesson;
      const idx = Number(quizOpt.dataset.quizIdx);
      pState.quiz[id] = idx;
      const lesson = getLessons().find((l) => l.id === id);
      if (lesson && lesson.quick_check && idx === lesson.quick_check.answer_index && !pState.completed[id]) {
        pState.completed[id] = true;
        deps.showToast?.("🎉 答对了！已自动为你点亮本课学习进度");
      }
      saveState();
      deps.renderContent?.();
      return true;
    }
    const assetTab = target.closest(".primer-asset-tab-btn");
    if (assetTab) {
      activeAssetKind = assetTab.dataset.assetKind || "questions";
      deps.renderContent?.();
      return true;
    }
    const mockBtn = target.closest(".primer-mock-q-btn");
    if (mockBtn) {
      deps.openStudio?.(mockBtn.dataset.qid);
      return true;
    }
    const navBtn = target.closest(".primer-nav-lesson-btn");
    if (navBtn) {
      openLessonById(navBtn.dataset.lessonId, { push: false });
      return true;
    }
    const nextBtn = target.closest(".primer-complete-next-btn");
    if (nextBtn) {
      pState.completed[nextBtn.dataset.curId] = true;
      saveState();
      openLessonById(nextBtn.dataset.nextId, { push: false });
      deps.showToast?.("✅ 本课已打卡，继续下一课！");
      return true;
    }
    const finishBtn = target.closest(".primer-complete-finish-btn");
    if (finishBtn) {
      pState.completed[finishBtn.dataset.curId] = true;
      saveState();
      closeActiveLesson(false);
      deps.showToast?.("🎉 恭喜通关全部 6 节 AI 零基础通识课！");
      return true;
    }
    return false;
  }

  window.ForgePrimer = {
    init(options) {
      deps = options || {};
    },
    getActiveLessonId: () => activeLessonId,
    resetActiveLesson: () => {
      activeLessonId = null;
    },
    closeActiveLesson,
    openLessonById,
    openLessonByUrl,
    getProgressStats,
    renderSourceLink,
    renderOverviewBanner,
    renderPrimerView,
    handleClick,
  };
})();
