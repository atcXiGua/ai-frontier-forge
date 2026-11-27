(() => {
  const STORAGE_KEY = "ai_frontier_forge_progress_v1";
  const THEME_KEY = "ai_frontier_forge_theme";
  const PAGE_SIZE = 15;

  const TRACK_LABELS = {
    engineering: "工程落地",
    consulting: "咨询方案",
    both: "工程+咨询双修",
  };

  const SEVERITY_LABELS = {
    high: "高危",
    medium: "中危",
    low: "低危",
  };

  const VIEW_META = {
    overview: { title: "📊 概览与周报", unit: "期周报" },
    primer: { title: "🎓 零基础通识课", unit: "课" },
    all: { title: "📦 全部资产", unit: "条" },
    questions: { title: "🧠 行业题库", unit: "题" },
    prompts: { title: "✨ 提示词库", unit: "套" },
    pitfalls: { title: "🛡️ 避坑指南", unit: "条" },
    diagrams: { title: "🎬 交互图解", unit: "张" },
    articles: { title: "📚 原文文章库", unit: "篇" },
  };

  const DEFAULT_LEVELS = [
    { id: "L0", label: "🐣 零基础通识 L0" },
    { id: "L1", label: "🌱 入门基础 L1" },
    { id: "L2", label: "🔧 工程进阶 L2" },
    { id: "L3", label: "🏗️ 架构深水 L3" },
  ];

  const KIND_META = {
    questions: { label: "🧠 题库", badge: "题库" },
    prompts: { label: "✨ 提示词", badge: "提示词" },
    pitfalls: { label: "🛡️ 避坑", badge: "避坑" },
    diagrams: { label: "🎬 图解", badge: "图解" },
  };

  const kb = {
    generated_at: "",
    analytics: {},
    topics: [],
    vendors: [],
    levels: DEFAULT_LEVELS,
    sub_tags: [],
    articles: [],
    questions: [],
    prompts: [],
    pitfalls: [],
    diagrams: [],
    lessons: [],
    digests: [],
  };

  // Fast O(1) lookup maps & precomputed flat lowercase search strings (eliminates JSON.stringify lag)
  const questionById = new Map();
  const promptById = new Map();
  const pitfallById = new Map();
  const diagramById = new Map();

  function buildSearchText(item, fields) {
    return fields
      .map((f) => {
        const v = item[f];
        if (Array.isArray(v)) return v.join(" ");
        return v ? String(v) : "";
      })
      .join(" ")
      .toLowerCase();
  }

  function hydrateKnowledgeBase(source) {
    const src = source && typeof source === "object" ? source : {};
    kb.generated_at = src.generated_at || "";
    kb.analytics = src.analytics && typeof src.analytics === "object" ? src.analytics : {};
    kb.topics = Array.isArray(src.topics) ? src.topics : [];
    kb.vendors = Array.isArray(src.vendors) ? src.vendors : [];
    kb.levels = Array.isArray(src.levels) && src.levels.length ? src.levels : DEFAULT_LEVELS;
    kb.sub_tags = Array.isArray(src.sub_tags) ? src.sub_tags : [];
    kb.articles = Array.isArray(src.articles) ? src.articles : [];
    kb.questions = Array.isArray(src.questions) ? src.questions : [];
    kb.prompts = Array.isArray(src.prompts) ? src.prompts : [];
    kb.pitfalls = Array.isArray(src.pitfalls) ? src.pitfalls : [];
    kb.diagrams = Array.isArray(src.diagrams) ? src.diagrams : [];
    kb.lessons = Array.isArray(src.lessons) ? src.lessons : [];
    kb.digests = Array.isArray(src.digests) ? src.digests : [];

    questionById.clear();
    promptById.clear();
    pitfallById.clear();
    diagramById.clear();

    kb.questions.forEach((q) => {
      q._kind = "questions";
      q.level = q.level || q.difficulty || "L2";
      q._searchText = buildSearchText(q, [
        "id", "title", "topic", "vendor", "level", "sub_tags", "scenario", "reference_answer", "key_points", "source_title", "week_key",
      ]);
      questionById.set(q.id, q);
    });
    kb.prompts.forEach((p) => {
      p._kind = "prompts";
      p.level = p.level || "L2";
      p._searchText = buildSearchText(p, [
        "id", "title", "topic", "vendor", "level", "sub_tags", "role", "use_case", "template", "source_title", "week_key",
      ]);
      promptById.set(p.id, p);
    });
    kb.pitfalls.forEach((k) => {
      k._kind = "pitfalls";
      k.level = k.level || (k.severity === "high" ? "L3" : k.severity === "low" ? "L1" : "L2");
      k._searchText = buildSearchText(k, [
        "id", "title", "topic", "vendor", "level", "sub_tags", "symptom", "root_cause", "architectural_fix", "source_title", "week_key",
      ]);
      pitfallById.set(k.id, k);
    });
    kb.diagrams.forEach((d) => {
      d._kind = "diagrams";
      d.level = d.level || "L3";
      d._searchText = buildSearchText(d, ["id", "title", "topic", "vendor", "level", "sub_tags", "subtitle", "source_title"]);
      diagramById.set(d.id, d);
    });
    kb.articles.forEach((a) => {
      a.level = a.level || "L2";
      a._searchText = buildSearchText(a, ["source_title", "source_url", "vendor", "level", "topics", "sub_tags", "week_key", "date"]);
    });
    kb.digests.forEach((d) => {
      d._searchText = buildSearchText(d, ["issue_label", "week_key", "headline", "summary", "date_range"]);
    });
  }

  async function fetchJsonStrict(url) {
    const resp = await fetch(url, { cache: "no-cache" });
    if (!resp.ok) throw new Error(`HTTP ${resp.status} for ${url}`);
    return resp.json();
  }

  function loadFallbackDataJs() {
    if (window.FORGE_KB && typeof window.FORGE_KB === "object") {
      return Promise.resolve(window.FORGE_KB);
    }
    return new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = "./data.js";
      s.onload = () => {
        if (window.FORGE_KB && typeof window.FORGE_KB === "object") resolve(window.FORGE_KB);
        else reject(new Error("window.FORGE_KB not found after loading data.js"));
      };
      s.onerror = () => reject(new Error("Failed to load fallback ./data.js"));
      document.head.appendChild(s);
    });
  }

  async function loadKnowledgeBaseData() {
    if (typeof fetch === "function" && location.protocol !== "file:") {
      try {
        const [meta, questions, prompts, pitfalls, diagrams, digests, lessons] = await Promise.all([
          fetchJsonStrict("./data/meta.json"),
          fetchJsonStrict("./data/questions.json"),
          fetchJsonStrict("./data/prompts.json"),
          fetchJsonStrict("./data/pitfalls.json"),
          fetchJsonStrict("./data/diagrams.json"),
          fetchJsonStrict("./data/digests.json"),
          fetchJsonStrict("./data/lessons.json").catch(() => []),
        ]);
        hydrateKnowledgeBase({ ...meta, questions, prompts, pitfalls, diagrams, digests, lessons });
        return true;
      } catch {
        // Fall through to window.FORGE_KB / ./data.js fallback
      }
    }

    try {
      const fallback = await loadFallbackDataJs();
      hydrateKnowledgeBase(fallback);
      return true;
    } catch {
      return false;
    }
  }

  // ==================== Zero-Backend Analytics (file:// & localhost safe) ====================

  const ForgeAnalytics = (() => {
    const isProd =
      typeof location !== "undefined" &&
      (location.protocol === "http:" || location.protocol === "https:") &&
      !["localhost", "127.0.0.1", "0.0.0.0", ""].includes(location.hostname);

    function init() {
      const cfg = kb.analytics || {};

      if (!isProd) return;

      // 1. Explicit PV/UV via Vercount (auto-reveals pill only when real numbers populate)
      if (cfg.vercount_enabled !== false) {
        const pill = document.getElementById("siteAnalyticsPill");
        const pvEl = document.getElementById("vercount_value_site_pv");
        if (pill && pvEl && typeof MutationObserver !== "undefined") {
          const obs = new MutationObserver(() => {
            const val = (pvEl.textContent || "").trim();
            if (val && val !== "--" && val !== "Loading") {
              pill.classList.remove("hidden");
              obs.disconnect();
            }
          });
          obs.observe(pvEl, { childList: true, characterData: true, subtree: true });
        }
        const s = document.createElement("script");
        s.defer = true;
        s.src = "https://events.vercount.one/js";
        document.head.appendChild(s);
      }

      // 2. Optional Private Funnel Dashboard via Umami Cloud (activates once umami_website_id is set)
      if (cfg.umami_website_id) {
        const u = document.createElement("script");
        u.defer = true;
        u.src = cfg.umami_script_url || "https://cloud.umami.is/script.js";
        u.setAttribute("data-website-id", cfg.umami_website_id);
        document.head.appendChild(u);
      }
    }

    function track(eventName, props) {
      if (!isProd) return;
      try {
        if (window.umami && typeof window.umami.track === "function") {
          window.umami.track(eventName, props || {});
        }
      } catch {
        // Ignore analytics errors
      }
    }

    return { init, track, isProd };
  })();

  window.ForgeAnalytics = ForgeAnalytics;

  // ==================== Application State ====================

  const state = {
    tab: "overview",
    allKind: "all",
    vendor: "all",
    article: "all",
    topic: "all",
    level: "all",
    subTag: "all",
    subTagSearch: "",
    track: "all",
    sub: "all",
    week: "all",
    query: "",
    onlyBookmarked: false,
    onlyUnmastered: false,
    onlyActiveLifecycle: true,
    page: 1,
    showAllOnPage: false,
    topicTreeOpen: true,
    levelTreeOpen: false,
    vendorTreeOpen: false,
    filterPopoverOpen: false,
    articleGroupBy: "week", // "week" | "vendor"
    selectedDigestIdx: 0,
    digestViewMode: "single", // "single" | "archive"
    digestSocialOpen: {},
    digestSocialTab: {},
    drawer: { open: false, tab: null, id: null, showAnswer: true },
    cmd: { open: false, query: "", activeIndex: 0, items: [] },
    diagramState: {},
    progress: loadProgress(),
  };

  let diagramPlayTimer = null;
  let searchDebounceTimer = null;
  let noteSaveTimer = null;

  function loadProgress() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      const parsed = raw ? JSON.parse(raw) : {};
      return {
        questions: parsed.questions || {},
        pitfalls: parsed.pitfalls || {},
      };
    } catch {
      return { questions: {}, pitfalls: {} };
    }
  }

  function saveProgress() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state.progress));
    } catch {
      // Ignore storage quota errors
    }
  }

  function escapeHtml(str) {
    return String(str || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function renderInlineMarkdown(str) {
    return escapeHtml(str)
      .replace(/`([^`]+)`/g, '<code class="inline-code">$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  }

  function highlightVars(templateText) {
    return escapeHtml(templateText).replace(
      /(\{\{[^{}\s]+\}\}|\{[A-Za-z0-9_\u4e00-\u9fa5-]+\})/g,
      '<span class="var-token">$1</span>'
    );
  }

  function showToast(message) {
    const el = document.getElementById("toast");
    if (!el) return;
    el.textContent = message;
    el.classList.add("show");
    clearTimeout(showToast._timer);
    showToast._timer = setTimeout(() => el.classList.remove("show"), 2200);
  }

  async function copyTextToClipboard(text, toastMessage) {
    try {
      await navigator.clipboard.writeText(text);
      showToast(toastMessage);
    } catch {
      const ta = document.createElement("textarea");
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      ta.remove();
      showToast(toastMessage);
    }
  }

  function downloadMarkdownFile(filename, content) {
    const blob = new Blob(["\uFEFF" + content], { type: "text/markdown;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function getAllAssets() {
    return [...kb.questions, ...kb.prompts, ...kb.pitfalls, ...kb.diagrams];
  }

  function isLifecycleAllowed(item) {
    if (!state.onlyActiveLifecycle) return true;
    const lc = item.lifecycle || "active";
    return lc === "active" || lc === "classic";
  }

  function initTheme() {
    const saved = localStorage.getItem(THEME_KEY) || "dark";
    document.documentElement.setAttribute("data-theme", saved);
    updateThemeLabel(saved);
    document.getElementById("themeToggle")?.addEventListener("click", () => {
      const cur = document.documentElement.getAttribute("data-theme") || "dark";
      const next = cur === "dark" ? "light" : "dark";
      document.documentElement.setAttribute("data-theme", next);
      localStorage.setItem(THEME_KEY, next);
      updateThemeLabel(next);
    });
  }

  function updateThemeLabel(theme) {
    const el = document.getElementById("themeToggle");
    if (el) el.textContent = theme === "dark" ? "☀️ 亮色" : "🌙 暗色";
  }

  // ==================== Filtering Engine ====================

  function filterListForTab(tabKey) {
    const q = state.query.toLowerCase();
    if (tabKey === "overview") {
      return kb.digests.filter((d) => !q || (d._searchText || "").includes(q));
    }
    if (tabKey === "primer") {
      return kb.lessons.filter((l) => !q || `${l.title} ${l.subtitle} ${l.one_liner} ${l.topic}`.toLowerCase().includes(q));
    }
    if (tabKey === "articles") {
      return kb.articles.filter((a) => {
        if (state.vendor !== "all" && a.vendor_id !== state.vendor) return false;
        if (state.topic !== "all" && !(a.topics || []).includes(state.topic)) return false;
        if (state.level !== "all" && a.level !== state.level) return false;
        if (state.subTag !== "all" && !(a.sub_tags || []).includes(state.subTag)) return false;
        if (state.week !== "all" && a.week_key !== state.week) return false;
        return !q || (a._searchText || "").includes(q);
      });
    }
    const list = tabKey === "all" ? getAllAssets() : kb[tabKey] || [];
    return list.filter((item) => {
      if (!isLifecycleAllowed(item)) return false;
      if (tabKey === "all" && state.allKind !== "all" && item._kind !== state.allKind) return false;
      if (state.vendor !== "all" && item.vendor_id !== state.vendor) return false;
      if (state.article !== "all" && item.source_title !== state.article) return false;
      if (state.topic !== "all" && item.topic !== state.topic) return false;
      if (state.level !== "all" && item.level !== state.level) return false;
      if (state.subTag !== "all" && !(item.sub_tags || []).includes(state.subTag)) return false;
      if (state.week !== "all" && item.week_key && item.week_key !== state.week) return false;
      if (state.onlyBookmarked && !window.ForgePlatform?.isBookmarked?.(item.id)) return false;
      if (
        tabKey !== "prompts" &&
        tabKey !== "diagrams" &&
        tabKey !== "all" &&
        state.track !== "all" &&
        item.track !== state.track
      ) {
        return false;
      }
      if (tabKey === "questions" && state.sub !== "all" && item.difficulty !== state.sub) return false;
      if (tabKey === "pitfalls" && state.sub !== "all" && item.severity !== state.sub) return false;
      if (tabKey === "questions" && state.onlyUnmastered && state.progress.questions[item.id] === "mastered") {
        return false;
      }
      return !q || (item._searchText || "").includes(q);
    });
  }

  function getActiveFilterCount() {
    let n = 0;
    if (state.subTag !== "all") n++;
    if (state.level !== "all") n++;
    if (state.track !== "all") n++;
    if (state.sub !== "all") n++;
    if (state.week !== "all") n++;
    if (state.onlyBookmarked) n++;
    if (state.onlyUnmastered) n++;
    if (!state.onlyActiveLifecycle) n++;
    return n;
  }

  // ==================== Left Rail & Filter Popover Rendering ====================

  function renderDockMeta() {
    const updatedEl = document.getElementById("updatedAt");
    if (updatedEl) {
      updatedEl.textContent = kb.generated_at ? kb.generated_at.slice(0, 10) : "离线模式";
      updatedEl.title = kb.generated_at ? `构建于 ${kb.generated_at}` : "离线模式";
    }
    const archiveBtn = document.getElementById("openArchiveBtn");
    if (archiveBtn && window.ForgeInterview?.getStats) {
      const s = window.ForgeInterview.getStats();
      archiveBtn.textContent = `📂 复盘档案 (${s.totalAttempts})`;
    }
  }

  function updateRailCounts() {
    const map = {
      overview: ["tabCountDigests", kb.digests.length],
      primer: ["tabCountPrimer", kb.lessons.length],
      all: ["tabCountAll", filterListForTab("all").length],
      questions: ["tabCountQuestions", filterListForTab("questions").length],
      prompts: ["tabCountPrompts", filterListForTab("prompts").length],
      pitfalls: ["tabCountPitfalls", filterListForTab("pitfalls").length],
      diagrams: ["tabCountDiagrams", filterListForTab("diagrams").length],
      articles: ["tabCountArticles", filterListForTab("articles").length],
    };
    for (const [elId, count] of Object.values(map)) {
      const el = document.getElementById(elId);
      if (el) el.textContent = String(count);
    }
  }

  function getScopeItemsForCounts() {
    if (state.tab === "articles") return kb.articles;
    if (state.tab === "questions") return kb.questions.filter(isLifecycleAllowed);
    if (state.tab === "prompts") return kb.prompts.filter(isLifecycleAllowed);
    if (state.tab === "pitfalls") return kb.pitfalls.filter(isLifecycleAllowed);
    if (state.tab === "diagrams") return kb.diagrams.filter(isLifecycleAllowed);
    // Overview & All: tree clicks jump to the unified 'all' view covering all 4 asset types
    return getAllAssets().filter(isLifecycleAllowed);
  }

  function itemMatchesTopic(item, topic) {
    if (state.tab === "articles") return (item.topics || []).includes(topic);
    return item.topic === topic;
  }

  function renderRailTrees() {
    const scopeLabelMap = {
      overview: "全部资产",
      all: "全部资产",
      questions: "题库",
      prompts: "提示词",
      pitfalls: "避坑",
      diagrams: "图解",
      articles: "原文",
    };
    const scopeTag = scopeLabelMap[state.tab] || "当前";
    const baseScope = getScopeItemsForCounts().filter(
      (item) => state.week === "all" || !item.week_key || item.week_key === state.week
    );

    const topicHead = document.getElementById("toggleTopicTree");
    if (topicHead) {
      topicHead.innerHTML = `<span>${state.topicTreeOpen ? "▾" : "▸"} 按专题分类（${scopeTag}）</span>`;
    }
    const levelHead = document.getElementById("toggleLevelTree");
    if (levelHead) {
      levelHead.innerHTML = `<span>${state.levelTreeOpen ? "▾" : "▸"} 按难度分级（${scopeTag}）</span>`;
    }
    const vendorHead = document.getElementById("toggleVendorTree");
    if (vendorHead) {
      vendorHead.innerHTML = `<span>${state.vendorTreeOpen ? "▾" : "▸"} 按厂商信源（${scopeTag}）</span>`;
    }

    // Topic tree (scoped to active tab, vendor & level)
    const topicPool = baseScope.filter(
      (item) =>
        (state.vendor === "all" || item.vendor_id === state.vendor) &&
        (state.level === "all" || item.level === state.level)
    );
    const topicCounts = {};
    for (const item of topicPool) {
      if (state.tab === "articles") {
        for (const t of item.topics || []) {
          topicCounts[t] = (topicCounts[t] || 0) + 1;
        }
      } else {
        topicCounts[item.topic] = (topicCounts[item.topic] || 0) + 1;
      }
    }
    const topicEl = document.getElementById("topicTreeList");
    if (topicEl) {
      topicEl.classList.toggle("collapsed", !state.topicTreeOpen);
      topicEl.innerHTML = [
        `<button class="rail-tree-btn ${state.topic === "all" ? "active" : ""}" data-topic="all">
           <span class="rail-tree-name">全部专题</span>
           <span class="count-pill">${topicPool.length}</span>
         </button>`,
        ...kb.topics.map(
          (t) =>
            `<button class="rail-tree-btn ${state.topic === t ? "active" : ""}" data-topic="${escapeHtml(t)}">
               <span class="rail-tree-name">${escapeHtml(t)}</span>
               <span class="count-pill">${topicCounts[t] || 0}</span>
             </button>`
        ),
      ].join("");
    }

    // Level tree (metadata-driven L1 / L2 / L3)
    const levelPool = baseScope.filter(
      (item) =>
        (state.vendor === "all" || item.vendor_id === state.vendor) &&
        (state.topic === "all" || itemMatchesTopic(item, state.topic))
    );
    const levelCounts = {};
    for (const item of levelPool) {
      const lv = item.level || "L2";
      levelCounts[lv] = (levelCounts[lv] || 0) + 1;
    }
    const levelEl = document.getElementById("levelTreeList");
    if (levelEl) {
      levelEl.classList.toggle("collapsed", !state.levelTreeOpen);
      levelEl.innerHTML = [
        `<button class="rail-tree-btn ${state.level === "all" ? "active" : ""}" data-level="all">
           <span class="rail-tree-name">全部难度</span>
           <span class="count-pill">${levelPool.length}</span>
         </button>`,
        ...kb.levels.map(
          (lv) =>
            `<button class="rail-tree-btn ${state.level === lv.id ? "active" : ""}" data-level="${escapeHtml(lv.id)}">
               <span class="rail-tree-name">${escapeHtml(lv.label)}</span>
               <span class="count-pill">${levelCounts[lv.id] || 0}</span>
             </button>`
        ),
      ].join("");
    }

    // Vendor tree (scoped to active tab, topic & level)
    const vendorPool = baseScope.filter(
      (item) =>
        (state.topic === "all" || itemMatchesTopic(item, state.topic)) &&
        (state.level === "all" || item.level === state.level)
    );
    const vendorCounts = {};
    for (const item of vendorPool) {
      const vid = item.vendor_id || "community";
      vendorCounts[vid] = (vendorCounts[vid] || 0) + 1;
    }
    const vendorEl = document.getElementById("vendorTreeList");
    if (vendorEl) {
      vendorEl.classList.toggle("collapsed", !state.vendorTreeOpen);
      vendorEl.innerHTML = [
        `<button class="rail-tree-btn ${state.vendor === "all" ? "active" : ""}" data-vendor="all">
           <span class="rail-tree-name"><span class="vendor-dot dot-all"></span><span>全部厂商</span></span>
           <span class="count-pill">${vendorPool.length}</span>
         </button>`,
        ...kb.vendors
          .filter((v) => (vendorCounts[v.id] || 0) > 0 || state.vendor === v.id)
          .map(
            (v) =>
              `<button class="rail-tree-btn ${state.vendor === v.id ? "active" : ""}" data-vendor="${escapeHtml(v.id)}">
                 <span class="rail-tree-name"><span class="vendor-dot dot-${escapeHtml(v.id)}"></span><span>${escapeHtml(v.label)}</span></span>
                 <span class="count-pill">${vendorCounts[v.id] || 0}</span>
               </button>`
          ),
      ].join("");
    }
  }

  function formatIssueDateShort(digest) {
    if (!digest) return "";
    if (digest.display_range) return digest.display_range;
    const raw = String(digest.date_range || "");
    const parts = raw.split("~").map((s) => s.trim());
    if (parts.length === 2 && parts[0].length === 10 && parts[1].length === 10) {
      const [y1, m1, d1] = parts[0].split("-");
      const [y2, m2, d2] = parts[1].split("-");
      return y1 === y2 ? `${y1}.${m1}.${d1} – ${m2}.${d2}` : `${y1}.${m1}.${d1} – ${y2}.${m2}.${d2}`;
    }
    return raw;
  }

  function formatIssueMonthDay(digest) {
    const raw = String(digest?.date_range || "");
    const parts = raw.split("~").map((s) => s.trim());
    if (parts.length === 2 && parts[0].length === 10 && parts[1].length === 10) {
      const [, m1, d1] = parts[0].split("-");
      const [, m2, d2] = parts[1].split("-");
      return `${m1}/${d1} ~ ${m2}/${d2}`;
    }
    return formatIssueDateShort(digest);
  }

  function formatWeekHuman(weekKey) {
    if (!weekKey) return "未归档";
    const d = kb.digests.find((x) => x.week_key === weekKey);
    if (d) return `${d.issue_label}（${formatIssueDateShort(d)}）`;
    return weekKey;
  }

  function formatWeekBadge(weekKey) {
    if (!weekKey) return "";
    const d = kb.digests.find((x) => x.week_key === weekKey);
    return d ? d.issue_label : weekKey;
  }

  function renderFilterPopoverControls() {
    // Sub-tag pills inside popover (scoped to active tab, vendor, topic, week)
    const subPool = getScopeItemsForCounts().filter(
      (item) =>
        (state.vendor === "all" || item.vendor_id === state.vendor) &&
        (state.topic === "all" || itemMatchesTopic(item, state.topic)) &&
        (state.week === "all" || !item.week_key || item.week_key === state.week)
    );
    const subCounts = {};
    for (const item of subPool) {
      for (const tag of item.sub_tags || []) {
        subCounts[tag] = (subCounts[tag] || 0) + 1;
      }
    }
    const subEl = document.getElementById("subTagPills");
    if (subEl) {
      const tagQ = (state.subTagSearch || "").trim().toLowerCase();
      const avail = kb.sub_tags.filter(
        (t) => ((subCounts[t] || 0) > 0 || state.subTag === t) && (!tagQ || t.toLowerCase().includes(tagQ))
      );
      subEl.innerHTML = [
        `<button type="button" class="subtag-pill ${state.subTag === "all" ? "active" : ""}" data-subtag="all">全部</button>`,
        ...avail.map(
          (t) =>
            `<button type="button" class="subtag-pill ${state.subTag === t ? "active" : ""}" data-subtag="${escapeHtml(t)}"># ${escapeHtml(t)} (${subCounts[t] || 0})</button>`
        ),
      ].join("");
    }

    // Track & Sub filter visibility by tab
    const trackWrap = document.getElementById("trackFilterWrap");
    const subWrap = document.getElementById("subFilterWrap");
    const subSelect = document.getElementById("subFilter");
    const subLabel = document.getElementById("subFilterLabel");
    const unmasteredWrap = document.getElementById("unmasteredWrap");

    if (state.tab === "questions") {
      trackWrap?.classList.remove("hidden");
      subWrap?.classList.remove("hidden");
      unmasteredWrap?.classList.remove("hidden");
      if (subLabel) subLabel.textContent = "题目难度";
      if (subSelect) {
        subSelect.innerHTML = `
          <option value="all">全部难度</option>
          <option value="L0">🐣 L0 零基础通识</option>
          <option value="L1">🌱 L1 入门基础</option>
          <option value="L2">🔧 L2 工程进阶</option>
          <option value="L3">🏗️ L3 架构深水</option>`;
        subSelect.value = state.sub;
      }
    } else if (state.tab === "pitfalls") {
      trackWrap?.classList.remove("hidden");
      subWrap?.classList.remove("hidden");
      unmasteredWrap?.classList.add("hidden");
      if (subLabel) subLabel.textContent = "严重程度";
      if (subSelect) {
        subSelect.innerHTML = `
          <option value="all">全部严重度</option>
          <option value="high">高危</option>
          <option value="medium">中危</option>
          <option value="low">低危</option>`;
        subSelect.value = state.sub;
      }
    } else {
      trackWrap?.classList.add("hidden");
      subWrap?.classList.add("hidden");
      unmasteredWrap?.classList.add("hidden");
    }

    // Week dropdown
    const weekSelect = document.getElementById("weekFilter");
    if (weekSelect) {
      const weeks = Array.from(new Set(kb.digests.map((d) => d.week_key).filter(Boolean)));
      weekSelect.innerHTML = [
        `<option value="all">全部期次</option>`,
        ...weeks.map((wk) => {
          const d = kb.digests.find((x) => x.week_key === wk);
          const lbl = d ? `${d.issue_label} · ${formatIssueDateShort(d)}` : wk;
          return `<option value="${escapeHtml(wk)}">${escapeHtml(lbl)}</option>`;
        }),
      ].join("");
      weekSelect.value = state.week;
    }

    const trackSel = document.getElementById("trackFilter");
    if (trackSel) trackSel.value = state.track;
    const bmChk = document.getElementById("onlyBookmarked");
    if (bmChk) bmChk.checked = state.onlyBookmarked;
    const unmChk = document.getElementById("onlyUnmastered");
    if (unmChk) unmChk.checked = state.onlyUnmastered;
    const lcChk = document.getElementById("onlyActiveLifecycle");
    if (lcChk) lcChk.checked = state.onlyActiveLifecycle;

    const badge = document.getElementById("activeFilterCount");
    const count = getActiveFilterCount();
    if (badge) {
      badge.textContent = String(count);
      badge.classList.toggle("hidden", count === 0);
    }

    const filterBtn = document.getElementById("filterPopoverBtn");
    if (filterBtn) {
      filterBtn.classList.toggle("hidden", state.tab === "overview");
    }
  }

  function renderActiveChips() {
    const bar = document.getElementById("activeFilterChips");
    if (!bar) return;
    const chips = [];
    if (state.topic !== "all") chips.push({ key: "topic", label: `专题：${state.topic}` });
    if (state.level !== "all") {
      const lvObj = kb.levels.find((x) => x.id === state.level);
      chips.push({ key: "level", label: `难度：${lvObj ? lvObj.label : state.level}` });
    }
    if (state.vendor !== "all") {
      const v = kb.vendors.find((x) => x.id === state.vendor);
      chips.push({ key: "vendor", label: `厂商：${v ? v.label : state.vendor}` });
    }
    if (state.article !== "all") {
      const short = state.article.length > 28 ? state.article.slice(0, 28) + "…" : state.article;
      chips.push({ key: "article", label: `原文：${short}` });
    }
    if (state.subTag !== "all") chips.push({ key: "subTag", label: `#${state.subTag}` });
    if (state.week !== "all") chips.push({ key: "week", label: `期次：${formatWeekHuman(state.week)}` });
    if (state.track !== "all") chips.push({ key: "track", label: `赛道：${TRACK_LABELS[state.track] || state.track}` });
    if (state.sub !== "all") chips.push({ key: "sub", label: state.tab === "pitfalls" ? `严重度：${SEVERITY_LABELS[state.sub] || state.sub}` : `难度：${state.sub}` });
    if (state.onlyBookmarked) chips.push({ key: "onlyBookmarked", label: "⭐ 仅看已收藏" });
    if (state.onlyUnmastered) chips.push({ key: "onlyUnmastered", label: "仅未掌握" });
    if (!state.onlyActiveLifecycle) chips.push({ key: "onlyActiveLifecycle", label: "含历史归档/已取代" });
    if (state.query) chips.push({ key: "query", label: `搜索：“${state.query}”` });

    if (!chips.length) {
      bar.classList.add("hidden");
      bar.innerHTML = "";
      return;
    }
    bar.classList.remove("hidden");
    bar.innerHTML = `
      <span class="stat-sub">当前筛选：</span>
      ${chips.map((c) => `<span class="filter-chip">${escapeHtml(c.label)} <button type="button" data-clear-chip="${c.key}" aria-label="清除此筛选">×</button></span>`).join("")}
      <button type="button" class="btn btn-ghost btn-xs" data-clear-chip="all">清除全部</button>`;
  }

  // ==================== View 1: Overview + Single-Issue Weekly Digest ====================

  function resolveDigestPitfall(d) {
    if (d.featured_pitfall_id && pitfallById.has(d.featured_pitfall_id)) {
      const k = pitfallById.get(d.featured_pitfall_id);
      return {
        ...k,
        severity_label: SEVERITY_LABELS[k.severity] || k.severity,
      };
    }
    return d.featured_pitfall || null;
  }

  function resolveDigestPrompt(d) {
    if (d.featured_prompt_id && promptById.has(d.featured_prompt_id)) {
      return promptById.get(d.featured_prompt_id);
    }
    return d.featured_prompt || null;
  }

  function renderOverview() {
    const activeQs = kb.questions.filter(isLifecycleAllowed);
    const qTotal = activeQs.length;
    const masteredCount = activeQs.filter((q) => state.progress.questions[q.id] === "mastered").length;
    const pct = qTotal ? Math.round((masteredCount / qTotal) * 100) : 0;
    const checkedCount = kb.pitfalls.filter((k) => Boolean(state.progress.pitfalls[k.id])).length;
    const mockStats = window.ForgeInterview?.getStats?.() || { totalAttempts: 0, attemptedQuestions: 0, avgScore: null };
    const avgText = mockStats.avgScore !== null && mockStats.avgScore !== undefined ? `${mockStats.avgScore} 分` : "--";
    const mockLine =
      mockStats.attemptedQuestions > 0
        ? `已练 ${mockStats.attemptedQuestions} 题 · 作答 ${mockStats.totalAttempts} 次 · 均分 ${avgText}`
        : `模拟作答 ${mockStats.totalAttempts} 次 · 均分 --`;

    const statsHtml = `
      <section class="stats-grid" aria-label="学习进度概览">
        <div class="stat-card">
          <div class="stat-label">行业场景题库</div>
          <div class="stat-row">
            <span id="statQuestions" class="stat-value">${qTotal}</span>
            <span id="masteryBadge" class="stat-sub">已掌握 ${masteredCount}/${qTotal} (${pct}%)</span>
          </div>
          <div class="progress-bar"><div id="masteryFill" class="progress-fill" style="width: ${pct}%"></div></div>
        </div>
        <div class="stat-card">
          <div class="stat-label">实战提示词库</div>
          <div class="stat-row">
            <span id="statPrompts" class="stat-value">${kb.prompts.length}</span>
            <span class="stat-sub">支持一键复制</span>
          </div>
        </div>
        <div class="stat-card">
          <div class="stat-label">生产避坑指南</div>
          <div class="stat-row">
            <span id="statPitfalls" class="stat-value">${kb.pitfalls.length}</span>
            <span id="checkedPitfalls" class="stat-sub">已排查 ${checkedCount}/${kb.pitfalls.length} 条</span>
          </div>
        </div>
        <div class="stat-card stat-card-accent">
          <div class="stat-label">沉浸式 AI 模拟面试</div>
          <div id="mockStatsLine" class="stat-mini-desc">${escapeHtml(mockLine)}</div>
          <button type="button" class="btn btn-primary btn-xs overview-random-quiz-btn">🎲 随机抽题自测</button>
        </div>
      </section>${window.ForgePrimer?.renderOverviewBanner?.() || ""}`;

    const digests = filterListForTab("overview");
    if (!digests.length) {
      return `${statsHtml}<div class="empty-state">暂无匹配的前沿周报期号。</div>`;
    }

    if (state.selectedDigestIdx >= digests.length) state.selectedDigestIdx = 0;
    const d = digests[state.selectedDigestIdx];

    // Group issue select options by year only when spanning multiple years; otherwise keep super crisp
    const byYear = new Map();
    digests.forEach((item, idx) => {
      const yr = item.year || String(item.week_key || "").slice(0, 4) || "其他";
      if (!byYear.has(yr)) byYear.set(yr, []);
      byYear.get(yr).push({ item, idx });
    });

    const selectOptionsHtml =
      byYear.size > 1
        ? Array.from(byYear.entries())
            .map(
              ([yr, list]) =>
                `<optgroup label="${escapeHtml(yr)} 年">${list
                  .map(
                    ({ item, idx }) =>
                      `<option value="${idx}" ${idx === state.selectedDigestIdx ? "selected" : ""}>${escapeHtml(item.issue_label)} · ${escapeHtml(formatIssueMonthDay(item))}（${item.counts?.articles || 0} 篇）</option>`
                  )
                  .join("")}</optgroup>`
            )
            .join("")
        : digests
            .map(
              (item, idx) =>
                `<option value="${idx}" ${idx === state.selectedDigestIdx ? "selected" : ""}>${escapeHtml(item.issue_label)} · ${escapeHtml(formatIssueDateShort(item))}（${item.counts?.articles || 0} 篇）</option>`
            )
            .join("");

    const switcherHtml = `
      <div class="digest-switcher-bar">
        <div class="digest-switcher-left">
          <button type="button" class="btn btn-ghost btn-xs digest-prev-issue-btn" ${state.selectedDigestIdx >= digests.length - 1 ? "disabled" : ""}>← 上一期</button>
          <select id="digestIssueSelect" class="digest-issue-select" aria-label="选择前沿周报期号">${selectOptionsHtml}</select>
          <button type="button" class="btn btn-ghost btn-xs digest-next-issue-btn" ${state.selectedDigestIdx <= 0 ? "disabled" : ""}>下一期 →</button>
        </div>
        <div style="display:flex; gap:6px; flex-wrap:wrap;">
          <button type="button" class="btn btn-xs ${state.digestViewMode === "single" ? "btn-primary" : "btn-ghost"} digest-mode-btn" data-mode="single">📰 本期详览</button>
          <button type="button" class="btn btn-xs ${state.digestViewMode === "archive" ? "btn-primary" : "btn-ghost"} digest-mode-btn" data-mode="archive">📋 往期归档 (${digests.length})</button>
          <button type="button" class="btn btn-xs btn-ghost share-digest-btn" data-digest-id="${escapeHtml(d.id)}">🔗 分享本期</button>
        </div>
      </div>`;

    if (state.digestViewMode === "archive") {
      const archiveRows = digests
        .map(
          (item, idx) => `
          <div class="index-row digest-archive-pick" data-issue-idx="${idx}">
            <div class="index-row-main">
              <div class="index-row-title-line">
                <span class="badge digest-issue-badge">${escapeHtml(item.issue_label)}</span>
                <span class="index-row-title">${escapeHtml(item.headline)}</span>
              </div>
              <div class="index-row-desc">${escapeHtml(formatIssueDateShort(item))} · ${(item.top_trends || []).map((t) => "#" + t.tag).join(" · ")}</div>
            </div>
            <div class="index-row-actions">
              <span class="stat-sub">${item.counts?.articles || 0}篇 / ${item.counts?.total_assets || 0}资产</span>
              <button type="button" class="btn btn-ghost btn-xs">查看本期 →</button>
            </div>
          </div>`
        )
        .join("");
      return `${statsHtml}${switcherHtml}<div class="index-list">${archiveRows}</div>`;
    }

    return `${statsHtml}${switcherHtml}${renderSingleDigestCard(d)}`;
  }

  function renderSingleDigestCard(d) {
    const counts = d.counts || {};
    const trends = d.top_trends || [];
    const qs = d.must_practice_questions || [];
    const pf = resolveDigestPitfall(d);
    const pr = resolveDigestPrompt(d);
    const articles = d.articles || [];
    const diagrams = d.featured_diagrams || [];

    const vendorBadges = (d.vendor_breakdown || [])
      .map((v) => `<span class="badge badge-vendor-${escapeHtml(v.id)}">${escapeHtml(v.label)} (${v.count})</span>`)
      .join("");

    const trendsHtml = trends
      .map(
        (t) => `
        <div class="digest-trend-item">
          <div class="digest-trend-head">
            <span class="digest-rank-pill">趋势 0${t.rank}</span>
            <button type="button" class="badge badge-subtag digest-filter-subtag-btn" data-subtag="${escapeHtml(t.tag)}"># ${escapeHtml(t.tag)} (${t.asset_count})</button>
          </div>
          <p class="digest-trend-insight">${renderInlineMarkdown(t.insight)}</p>
          <div class="digest-trend-meta">信源：${escapeHtml((t.vendors || []).join(" / "))}</div>
        </div>`
      )
      .join("");

    const questionsHtml = qs
      .map(
        (q, idx) => `
        <div class="digest-q-item">
          <div class="digest-q-top">
            <div>
              <div class="digest-q-title">
                <span class="digest-q-num">Q${idx + 1}</span>
                <span>${escapeHtml(q.title)}</span>
              </div>
              <div class="badges" style="margin-top: 6px;">
                <span class="badge badge-vendor-${escapeHtml(q.vendor_id || "community")}">${escapeHtml(q.vendor)}</span>
                <span class="badge">${escapeHtml(q.topic)}</span>
                <span class="badge badge-neutral">${escapeHtml(q.difficulty)}</span>
              </div>
            </div>
            <div class="digest-q-actions">
              <button type="button" class="btn btn-primary btn-xs digest-mock-btn" data-qid="${escapeHtml(q.id)}">🎙️ 沉浸模拟面试</button>
              <button type="button" class="btn btn-ghost btn-xs digest-open-drawer-btn" data-target-tab="questions" data-target-id="${escapeHtml(q.id)}">👁️ 抽屉精读</button>
            </div>
          </div>
          <p class="section-text" style="margin-top: 8px; font-size: 0.85rem; color: var(--text-muted);">${renderInlineMarkdown(q.scenario_preview)}</p>
        </div>`
      )
      .join("");

    const pitfallBoxHtml = pf
      ? `<div class="digest-pick-box digest-pick-pitfall">
           <div class="digest-pick-head">
             <span class="section-heading" style="margin:0;">🛡️ 本周最值得收藏的 1 条避坑</span>
             <span class="badge badge-${escapeHtml(pf.severity || "high")}">${escapeHtml(pf.severity_label || SEVERITY_LABELS[pf.severity] || pf.severity)}</span>
           </div>
           <h3 class="digest-pick-title">${escapeHtml(pf.title)}</h3>
           <p class="section-text" style="font-size:0.85rem;"><strong>🚨 现象：</strong>${renderInlineMarkdown(pf.symptom || "")}</p>
           <p class="section-text" style="margin-top:6px; font-size:0.85rem;"><strong>🏗️ 解法：</strong>${renderInlineMarkdown(pf.architectural_fix || "")}</p>
           <div class="digest-pick-footer">
             <a href="${escapeHtml(pf.source_url || "#")}" target="_blank" rel="noopener noreferrer" class="digest-source-link">${escapeHtml(pf.source_title || "")} ↗</a>
             <button type="button" class="btn btn-ghost btn-xs digest-open-drawer-btn" data-target-tab="pitfalls" data-target-id="${escapeHtml(pf.id)}">查看完整避坑 →</button>
           </div>
         </div>`
      : "";

    const promptBoxHtml = pr
      ? `<div class="digest-pick-box digest-pick-prompt">
           <div class="digest-pick-head">
             <span class="section-heading" style="margin:0;">✨ 本周最值得收藏的 1 个提示词</span>
             <span class="badge badge-neutral">${escapeHtml(pr.topic || "提示词")}</span>
           </div>
           <h3 class="digest-pick-title">${escapeHtml(pr.title)}</h3>
           <p class="section-text" style="font-size:0.85rem;"><strong>适用场景：</strong>${renderInlineMarkdown(pr.use_case || "")}</p>
           <pre class="prompt-pre digest-prompt-pre">${highlightVars(pr.template || "")}</pre>
           <div class="digest-pick-footer">
             <button type="button" class="btn btn-primary btn-xs digest-copy-prompt-btn" data-prompt-id="${escapeHtml(pr.id)}">📋 一键复制模板</button>
             <button type="button" class="btn btn-ghost btn-xs digest-open-drawer-btn" data-target-tab="prompts" data-target-id="${escapeHtml(pr.id)}">抽屉查看详情 →</button>
           </div>
         </div>`
      : "";

    const diagramsStripHtml = diagrams.length
      ? `<div class="section-block">
           <div class="section-heading">🎬 本周配套交互动态图解</div>
           <div class="digest-diagrams-row">
             ${diagrams
               .map(
                 (dg) =>
                   `<button type="button" class="btn btn-ghost btn-xs digest-jump-diagram-btn" data-diagram-id="${escapeHtml(dg.id)}">🎬 ${escapeHtml(dg.title)} →</button>`
               )
               .join("")}
           </div>
         </div>`
      : "";

    const previewArticles = articles.slice(0, 6);
    const articlesHtml = previewArticles
      .map(
        (a) => `
        <div class="digest-article-row">
          <div class="digest-article-main">
            <span class="vendor-dot dot-${escapeHtml(a.vendor_id || "community")}"></span>
            <a href="${escapeHtml(a.source_url)}" target="_blank" rel="noopener noreferrer" class="digest-article-link">${escapeHtml(a.source_title)} ↗</a>
          </div>
          <div class="digest-article-right">
            <span class="stat-sub">${a.counts.questions}题 / ${a.counts.prompts}词 / ${a.counts.pitfalls}坑</span>
            <button type="button" class="btn btn-ghost btn-xs digest-filter-article-btn" data-article="${escapeHtml(a.source_title)}">🔎 精读</button>
          </div>
        </div>`
      )
      .join("");

    return `
      <article id="card-${escapeHtml(d.id)}" class="card digest-card" data-digest-id="${escapeHtml(d.id)}">
        <div class="digest-hero">
          <div class="digest-hero-top">
            <div class="badges">
              <span class="badge digest-issue-badge">📰 ${escapeHtml(d.issue_label)}</span>
              <span class="badge badge-neutral">${escapeHtml(formatIssueDateShort(d))}</span>
              ${vendorBadges}
            </div>
          </div>
          <h2 class="digest-headline">${escapeHtml(d.headline)}</h2>
          <p class="section-text" style="font-size:0.88rem;">${renderInlineMarkdown(d.summary)}</p>
          ${d.editor_note ? `<div class="evidence-box" style="margin-top:10px;"><strong>✍️ 编者按：</strong>${renderInlineMarkdown(d.editor_note)}</div>` : ""}
          <div class="digest-kpi-row">
            <div class="digest-kpi"><span class="digest-kpi-num">${counts.articles || 0}</span><span class="digest-kpi-label">收录原文</span></div>
            <div class="digest-kpi"><span class="digest-kpi-num">${counts.questions || 0}</span><span class="digest-kpi-label">场景题库</span></div>
            <div class="digest-kpi"><span class="digest-kpi-num">${counts.prompts || 0}</span><span class="digest-kpi-label">提示词模板</span></div>
            <div class="digest-kpi"><span class="digest-kpi-num">${counts.pitfalls || 0}</span><span class="digest-kpi-label">生产避坑</span></div>
            <div class="digest-kpi"><span class="digest-kpi-num">${counts.diagrams || 0}</span><span class="digest-kpi-label">交互图解</span></div>
          </div>
        </div>

        <div class="section-block">
          <div class="section-heading">🔥 本周 Top 3 核心趋势</div>
          <div class="digest-trends-grid">${trendsHtml}</div>
        </div>

        <div class="section-block">
          <div class="section-heading">🧠 本周必刷 3 题</div>
          <div class="digest-q-list">${questionsHtml}</div>
        </div>

        <div class="digest-picks-grid">
          ${pitfallBoxHtml}
          ${promptBoxHtml}
        </div>

        ${diagramsStripHtml}

        <div class="section-block">
          <div style="display:flex; justify-content:space-between; align-items:center; gap:8px; flex-wrap:wrap;">
            <div class="section-heading" style="margin:0;">📚 本周精选原文（展示 ${previewArticles.length} / 共 ${articles.length} 篇）</div>
            <button type="button" class="btn btn-ghost btn-xs goto-articles-hub-btn" data-week="${escapeHtml(d.week_key)}">查看全部 ${articles.length} 篇原文归档 →</button>
          </div>
          <div class="digest-articles-list">${articlesHtml}</div>
        </div>
      </article>`;
  }

  // ==================== View 2: Clean Index List + Pagination (Questions / Prompts / Pitfalls) ====================

  function renderIndexList(items, tabKey) {
    let kindBarHtml = "";
    if (tabKey === "all") {
      const savedAllKind = state.allKind;
      state.allKind = "all";
      const allScoped = filterListForTab("all");
      state.allKind = savedAllKind;
      const kc = { questions: 0, prompts: 0, pitfalls: 0, diagrams: 0 };
      allScoped.forEach((x) => {
        if (kc[x._kind] !== undefined) kc[x._kind] += 1;
      });
      const pills = [
        { k: "all", label: `全部 (${allScoped.length})` },
        { k: "questions", label: `🧠 题库 (${kc.questions})` },
        { k: "prompts", label: `✨ 提示词 (${kc.prompts})` },
        { k: "pitfalls", label: `🛡️ 避坑 (${kc.pitfalls})` },
        { k: "diagrams", label: `🎬 图解 (${kc.diagrams})` },
      ];
      kindBarHtml = `<div class="all-kind-bar">${pills
        .map(
          (p) =>
            `<button type="button" class="btn btn-xs ${state.allKind === p.k ? "btn-primary" : "btn-ghost"} all-kind-pill" data-all-kind="${p.k}">${p.label}</button>`
        )
        .join("")}</div>`;
    }

    const total = items.length;
    const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
    if (state.page > totalPages) state.page = totalPages;
    const startIdx = state.showAllOnPage ? 0 : (state.page - 1) * PAGE_SIZE;
    const endIdx = state.showAllOnPage ? total : Math.min(total, startIdx + PAGE_SIZE);
    const pageItems = items.slice(startIdx, endIdx);

    const rowsHtml = pageItems
      .map((item) => {
        const rowKind = tabKey === "all" ? item._kind || "questions" : tabKey;
        const isSelected = state.drawer.open && state.drawer.tab === rowKind && state.drawer.id === item.id;
        const isStarred = window.ForgePlatform?.isBookmarked?.(item.id);
        const kindBadge =
          tabKey === "all" && KIND_META[rowKind]
            ? `<span class="badge">${escapeHtml(KIND_META[rowKind].label)}</span>`
            : "";
        const levelBadge = item.level
          ? `<span class="badge badge-level-${escapeHtml(item.level)}">${escapeHtml(item.level)}</span>`
          : "";
        let dotCls = "";
        let desc = "";
        let badgesHtml = "";
        let quickActionHtml = "";

        if (rowKind === "questions") {
          const st = state.progress.questions[item.id];
          if (st === "mastered") dotCls = "done";
          else if (st === "review") dotCls = "warn";
          else if (st === "hard") dotCls = "hot";
          desc = item.scenario || "";
          const summary = window.ForgeInterview?.getQuestionSummary?.(item.id);
          const scoreBadge =
            summary && summary.attemptsCount > 0
              ? `<span class="badge badge-green">最高 ${summary.bestScore ?? "--"} 分</span>`
              : `<span class="badge badge-neutral">${escapeHtml(TRACK_LABELS[item.track] || item.track)}</span>`;
          badgesHtml = `
            ${kindBadge}
            <span class="badge badge-vendor-${escapeHtml(item.vendor_id || "community")}">${escapeHtml((item.vendor || "").split(" / ")[0])}</span>
            ${levelBadge}
            ${scoreBadge}
            ${item.lifecycle === "classic" ? `<span class="badge badge-classic">⭐ 常青</span>` : ""}`;
          quickActionHtml = `<button type="button" class="btn btn-primary btn-xs row-mock-btn" data-id="${escapeHtml(item.id)}">🎙️ 模拟面试</button>`;
        } else if (rowKind === "prompts") {
          desc = item.use_case || "";
          badgesHtml = `
            ${kindBadge}
            <span class="badge badge-vendor-${escapeHtml(item.vendor_id || "community")}">${escapeHtml((item.vendor || "").split(" / ")[0])}</span>
            ${levelBadge}
            <span class="badge badge-neutral">${escapeHtml(item.topic)}</span>
            <span class="badge badge-neutral">${escapeHtml(item.role || "")}</span>`;
          quickActionHtml = `<button type="button" class="btn btn-primary btn-xs row-copy-prompt-btn" data-id="${escapeHtml(item.id)}">📋 复制模板</button>`;
        } else if (rowKind === "diagrams") {
          dotCls = "done";
          desc = item.subtitle || "";
          badgesHtml = `
            ${kindBadge}
            <span class="badge badge-vendor-${escapeHtml(item.vendor_id || "community")}">${escapeHtml((item.vendor || "").split(" / ")[0])}</span>
            ${levelBadge}
            <span class="badge badge-green">交互动态图解</span>`;
          quickActionHtml = `<button type="button" class="btn btn-primary btn-xs row-jump-diagram-btn" data-diagram-id="${escapeHtml(item.id)}">🎬 查看图解</button>`;
        } else {
          const checked = Boolean(state.progress.pitfalls[item.id]);
          if (checked) dotCls = "done";
          else if (item.severity === "high") dotCls = "hot";
          desc = item.symptom || "";
          badgesHtml = `
            ${kindBadge}
            <span class="badge badge-${escapeHtml(item.severity)}">${escapeHtml(SEVERITY_LABELS[item.severity] || item.severity)}</span>
            <span class="badge badge-vendor-${escapeHtml(item.vendor_id || "community")}">${escapeHtml((item.vendor || "").split(" / ")[0])}</span>
            ${levelBadge}
            <span class="badge badge-neutral">${escapeHtml(item.topic)}</span>`;
          quickActionHtml = `<label class="toggle-inline row-pitfall-label" data-stop-row="1"><input type="checkbox" class="row-pitfall-check" data-id="${escapeHtml(item.id)}" ${checked ? "checked" : ""} /><span>${checked ? "已排查" : "排查"}</span></label>`;
        }

        const rowOpenAttrs =
          rowKind === "diagrams"
            ? `data-jump-diagram-id="${escapeHtml(item.id)}"`
            : `data-open-drawer-id="${escapeHtml(item.id)}" data-open-drawer-tab="${rowKind}"`;

        return `
          <div class="index-row ${isSelected ? "is-selected" : ""}" ${rowOpenAttrs}>
            <div class="index-row-main">
              <div class="index-row-title-line">
                <span class="row-status-dot ${dotCls}"></span>
                <h2 class="index-row-title">${isStarred ? "⭐ " : ""}${escapeHtml(item.title)}</h2>
              </div>
              <p class="index-row-desc">${escapeHtml(desc)}</p>
              <div class="index-row-meta">${badgesHtml}</div>
            </div>
            <div class="index-row-actions">
              ${quickActionHtml}
              <button type="button" class="btn btn-ghost btn-xs">${rowKind === "diagrams" ? "进入 →" : "阅读 →"}</button>
            </div>
          </div>`;
      })
      .join("");

    const paginationHtml =
      total > PAGE_SIZE
        ? `<div class="pagination-bar">
             <span>当前展示第 <strong>${startIdx + 1}–${endIdx}</strong> 条 / 共 <strong>${total}</strong> 条</span>
             <div class="pagination-btns">
               ${
                 state.showAllOnPage
                   ? `<button type="button" class="btn btn-ghost btn-xs page-toggle-all-btn">恢复分页 (${PAGE_SIZE}条/页)</button>`
                   : `<button type="button" class="btn btn-ghost btn-xs page-prev-btn" ${state.page <= 1 ? "disabled" : ""}>← 上一页</button>
                      <span>第 ${state.page} / ${totalPages} 页</span>
                      <button type="button" class="btn btn-ghost btn-xs page-next-btn" ${state.page >= totalPages ? "disabled" : ""}>下一页 →</button>
                      <button type="button" class="btn btn-ghost btn-xs page-toggle-all-btn">展开全部</button>`
               }
             </div>
           </div>`
        : "";

    return `${kindBarHtml}<div class="index-list">${rowsHtml}</div>${paginationHtml}`;
  }

  // ==================== View 3: Article Hub (Replaces 500-item <select>) ====================

  function renderArticlesHub(items) {
    const controlsHtml = `
      <div class="article-hub-bar">
        <div class="stat-sub">共收录 <strong>${items.length}</strong> 篇高密度信源原文，点击「精读资产」可按单篇文章钻取全部题库/提示词/避坑</div>
        <div style="display:flex; gap:6px;">
          <button type="button" class="btn btn-xs ${state.articleGroupBy === "week" ? "btn-primary" : "btn-ghost"} article-groupby-btn" data-group="week">📅 按周报周期分组</button>
          <button type="button" class="btn btn-xs ${state.articleGroupBy === "vendor" ? "btn-primary" : "btn-ghost"} article-groupby-btn" data-group="vendor">🏢 按厂商分组</button>
        </div>
      </div>`;

    const groups = new Map();
    for (const a of items) {
      const key =
        state.articleGroupBy === "vendor"
          ? a.vendor || "前沿研究者 & 社区"
          : formatWeekHuman(a.week_key);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(a);
    }

    const sectionsHtml = Array.from(groups.entries())
      .map(([groupName, list]) => {
        const rows = list
          .map(
            (a) => `
            <div class="index-row">
              <div class="index-row-main">
                <div class="index-row-title-line">
                  <span class="vendor-dot dot-${escapeHtml(a.vendor_id || "community")}"></span>
                  <a href="${escapeHtml(a.source_url)}" target="_blank" rel="noopener noreferrer" class="digest-article-link" style="font-size:0.93rem; font-weight:600;">${escapeHtml(a.source_title)} ↗</a>
                </div>
                <div class="index-row-meta" style="margin-top:6px;">
                  <span class="badge badge-vendor-${escapeHtml(a.vendor_id || "community")}">${escapeHtml(a.vendor)}</span>
                  <span class="badge badge-level-${escapeHtml(a.level || "L2")}">${escapeHtml(a.level || "L2")}</span>
                  ${a.week_key ? `<span class="badge badge-neutral">${escapeHtml(formatWeekBadge(a.week_key))}</span>` : ""}
                  <span class="badge badge-green">产出 ${a.total_assets} 条（${a.counts.questions}题 · ${a.counts.prompts}词 · ${a.counts.pitfalls}坑）</span>
                </div>
              </div>
              <div class="index-row-actions">
                <button type="button" class="btn btn-ghost btn-xs share-article-btn" data-article-id="${escapeHtml(a.id)}">🔗 分享</button>
                <button type="button" class="btn btn-primary btn-xs digest-filter-article-btn" data-article="${escapeHtml(a.source_title)}">🔎 精读资产</button>
              </div>
            </div>`
          )
          .join("");
        return `
          <section class="article-hub-group">
            <div class="article-hub-group-head">
              <span>${escapeHtml(groupName)}</span>
              <span>${list.length} 篇</span>
            </div>
            <div class="index-list">${rows}</div>
          </section>`;
      })
      .join("");

    return `${controlsHtml}${sectionsHtml}`;
  }

  // ==================== View 4: Interactive Animated SVG Diagrams ====================

  function getDiagramRuntime(d) {
    if (!state.diagramState[d.id]) {
      state.diagramState[d.id] = { step: 0, inspectedNodeId: null, playing: true };
    }
    return state.diagramState[d.id];
  }

  function renderDiagramDetailInner(d, rt) {
    const stage = d.stages[rt.step] || d.stages[0];
    const inspectedNode = rt.inspectedNodeId ? d.nodes.find((n) => n.id === rt.inspectedNodeId) : null;
    if (inspectedNode) {
      return `
        <div class="diagram-detail-head">
          <span class="badge">${escapeHtml(inspectedNode.badge)}</span>
          <button type="button" class="btn btn-ghost btn-xs diagram-back-stage-btn">返回当前步骤 (${rt.step + 1}/${d.stages.length})</button>
        </div>
        <h3 style="margin: 6px 0 8px;">${escapeHtml(inspectedNode.title)}</h3>
        <p class="section-text">${renderInlineMarkdown(inspectedNode.summary)}</p>
        <div class="pitfall-grid" style="margin-top: 12px;">
          <div class="pitfall-cell">
            <div class="section-heading">💡 典型示例</div>
            <p class="section-text">${renderInlineMarkdown(inspectedNode.example)}</p>
          </div>
          <div class="pitfall-cell">
            <div class="section-heading">🚧 架构红线</div>
            <p class="section-text">${renderInlineMarkdown(inspectedNode.redline)}</p>
          </div>
        </div>`;
    }
    return `
      <div class="diagram-detail-head">
        <span class="badge">阶段 ${rt.step + 1} / ${d.stages.length} · ${escapeHtml(stage.title)}</span>
        <span class="stat-sub">提示：可直接点击上方任意节点查看详解</span>
      </div>
      <p class="section-text" style="margin-top: 8px;">${renderInlineMarkdown(stage.desc)}</p>
      <div class="pitfall-grid" style="margin-top: 12px;">
        <div class="pitfall-cell">
          <div class="section-heading">⚙️ 工程要点</div>
          <p class="section-text">${renderInlineMarkdown(stage.engineering_point)}</p>
        </div>
        <div class="pitfall-cell">
          <div class="section-heading">📊 实测案例</div>
          <p class="section-text">${renderInlineMarkdown(stage.case_study)}</p>
        </div>
      </div>`;
  }

  function renderDiagrams(items) {
    return items
      .map((d) => {
        const rt = getDiagramRuntime(d);
        const stage = d.stages[rt.step] || d.stages[0];
        const inspectedNode = rt.inspectedNodeId ? d.nodes.find((n) => n.id === rt.inspectedNodeId) : null;

        const edgesSvg = d.edges
          .map((e) => {
            const active = !inspectedNode && stage.active_edges.includes(e.id);
            const marker = active ? "url(#arrow-active)" : "url(#arrow-muted)";
            const pillHtml = e.pill
              ? `<g class="edge-pill-group ${active ? "is-active" : ""}" data-edge-pill="${escapeHtml(e.id)}">
                   <rect class="edge-pill-bg" x="${e.pill.x}" y="${e.pill.y}" width="${e.pill.w}" height="22" rx="11"></rect>
                   <text class="edge-pill-text" x="${e.pill.x + e.pill.w / 2}" y="${e.pill.y + 14.5}">${escapeHtml(e.pill.text)}</text>
                 </g>`
              : "";
            return `<path class="flow-edge ${active ? "is-active" : ""}" data-edge-id="${escapeHtml(e.id)}" d="${e.d}" marker-end="${marker}"></path>${pillHtml}`;
          })
          .join("");

        const nodesSvg = d.nodes
          .map((n) => {
            const isInspected = inspectedNode && inspectedNode.id === n.id;
            const isActive = !inspectedNode && stage.active_nodes.includes(n.id);
            const cx = n.x + n.w / 2;
            const cy = n.y + n.h / 2;
            const cls = [
              "mem-node",
              n.kind === "engine" ? "is-engine" : "",
              isActive ? "is-active" : "",
              isInspected ? "is-inspected" : "",
            ]
              .filter(Boolean)
              .join(" ");
            const textLines = n.sub2
              ? `<text class="node-title" x="${cx}" y="${cy - 14}">${escapeHtml(n.label)}</text>
                 <text class="node-sub" x="${cx}" y="${cy + 6}">${escapeHtml(n.sub)}</text>
                 <text class="node-sub" x="${cx}" y="${cy + 24}">${escapeHtml(n.sub2)}</text>`
              : `<text class="node-title" x="${cx}" y="${cy - 4}">${escapeHtml(n.label)}</text>
                 <text class="node-sub" x="${cx}" y="${cy + 14}">${escapeHtml(n.sub)}</text>`;
            return `<g class="${cls}" data-node-id="${escapeHtml(n.id)}" role="button" tabindex="0">
                      <rect x="${n.x}" y="${n.y}" width="${n.w}" height="${n.h}" rx="${n.rx}"></rect>
                      ${textLines}
                    </g>`;
          })
          .join("");

        return `
        <article id="card-${escapeHtml(d.id)}" class="card diagram-card" data-diagram-id="${escapeHtml(d.id)}">
          <div class="card-header">
            <div>
              <h2 class="card-title">${escapeHtml(d.title)}</h2>
              <div class="badges">
                <span class="badge badge-vendor-${escapeHtml(d.vendor_id || "community")}">${escapeHtml(d.vendor)}</span>
                <span class="badge">${escapeHtml(d.topic)}</span>
                <span class="badge badge-green">交互动态图解</span>
              </div>
            </div>
            <div style="display:flex; gap:8px; align-items:center; flex-wrap:wrap;">
              <button type="button" class="btn btn-ghost btn-sm share-diagram-btn" data-diagram-id="${escapeHtml(d.id)}">🔗 分享</button>
              <button type="button" class="btn btn-primary btn-sm diagram-play-btn">${rt.playing ? "⏸ 暂停演示" : "▶ 自动播放"}</button>
            </div>
          </div>
          <p class="stat-mini-desc">${escapeHtml(d.subtitle)}</p>

          <div class="diagram-stage-wrap">
            <svg class="diagram-svg" viewBox="${escapeHtml(d.viewBox || "0 0 680 416")}" role="img" aria-label="${escapeHtml(d.title)}">
              <defs>
                <marker id="arrow-muted" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
                  <path d="M 0 1 L 10 5 L 0 9 z" fill="#94a3b8"></path>
                </marker>
                <marker id="arrow-active" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
                  <path d="M 0 1 L 10 5 L 0 9 z" fill="#38bdf8"></path>
                </marker>
              </defs>
              ${edgesSvg}
              ${nodesSvg}
            </svg>
          </div>

          <div class="diagram-controls">
            <div class="diagram-nav-left">
              <button type="button" class="btn btn-xs diagram-prev-btn">← 上一步</button>
              <span class="stat-sub diagram-step-counter"><strong>${rt.step + 1} / ${d.stages.length}</strong></span>
              <button type="button" class="btn btn-xs diagram-next-btn">下一步 →</button>
            </div>
            <div class="step-dots">
              ${d.stages
                .map(
                  (st, i) =>
                    `<button type="button" class="step-dot ${i === rt.step && !inspectedNode ? "active" : ""}" data-step="${i}" title="${escapeHtml(st.title)}"></button>`
                )
                .join("")}
            </div>
          </div>

          <div class="diagram-detail-panel">${renderDiagramDetailInner(d, rt)}</div>

          <div class="evidence-box">
            来源：<a href="${escapeHtml(d.source_url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(d.source_title)} ↗</a>
          </div>
        </article>`;
      })
      .join("");
  }

  function updateDiagramCardInPlace(card, d) {
    const rt = getDiagramRuntime(d);
    const stage = d.stages[rt.step] || d.stages[0];
    const inspectedNode = rt.inspectedNodeId ? d.nodes.find((n) => n.id === rt.inspectedNodeId) : null;

    card.querySelectorAll(".flow-edge").forEach((el) => {
      const active = !inspectedNode && stage.active_edges.includes(el.dataset.edgeId);
      el.classList.toggle("is-active", active);
      el.setAttribute("marker-end", active ? "url(#arrow-active)" : "url(#arrow-muted)");
    });
    card.querySelectorAll(".edge-pill-group").forEach((el) => {
      const active = !inspectedNode && stage.active_edges.includes(el.dataset.edgePill);
      el.classList.toggle("is-active", active);
    });
    card.querySelectorAll(".mem-node").forEach((el) => {
      const nid = el.dataset.nodeId;
      el.classList.toggle("is-inspected", Boolean(inspectedNode && inspectedNode.id === nid));
      el.classList.toggle("is-active", !inspectedNode && stage.active_nodes.includes(nid));
    });
    const counter = card.querySelector(".diagram-step-counter");
    if (counter) counter.innerHTML = `<strong>${rt.step + 1} / ${d.stages.length}</strong>`;
    const playBtn = card.querySelector(".diagram-play-btn");
    if (playBtn) playBtn.textContent = rt.playing ? "⏸ 暂停演示" : "▶ 自动播放";
    card.querySelectorAll(".step-dot").forEach((dot) => {
      dot.classList.toggle("active", Number(dot.dataset.step) === rt.step && !inspectedNode);
    });
    const panel = card.querySelector(".diagram-detail-panel");
    if (panel) panel.innerHTML = renderDiagramDetailInner(d, rt);
  }

  function syncDiagramAutoPlay() {
    clearInterval(diagramPlayTimer);
    diagramPlayTimer = null;
    if (state.tab !== "diagrams") return;
    const activePlay = kb.diagrams.some((d) => {
      const rt = getDiagramRuntime(d);
      return rt.playing && !rt.inspectedNodeId;
    });
    if (!activePlay) return;
    diagramPlayTimer = setInterval(() => {
      if (state.tab !== "diagrams") return;
      for (const d of kb.diagrams) {
        const rt = getDiagramRuntime(d);
        if (rt.playing && !rt.inspectedNodeId && d.stages.length > 1) {
          rt.step = (rt.step + 1) % d.stages.length;
          const card = document.querySelector(`.diagram-card[data-diagram-id="${CSS.escape(d.id)}"]`);
          if (card) updateDiagramCardInPlace(card, d);
        }
      }
    }, 3200);
  }

  // ==================== Slide-Over Reader Drawer ====================

  function getDrawerItem(tabKey, id) {
    if (tabKey === "questions") return questionById.get(id);
    if (tabKey === "prompts") return promptById.get(id);
    if (tabKey === "pitfalls") return pitfallById.get(id);
    return null;
  }

  function syncUrlState(push) {
    if (!window.ForgePlatform?.syncDeepLink) return;
    if (state.drawer.open && state.drawer.id) {
      window.ForgePlatform.syncDeepLink({ tab: state.drawer.tab || state.tab, id: state.drawer.id }, { push });
      return;
    }
    const artObj = state.article !== "all" ? kb.articles.find((a) => a.source_title === state.article) : null;
    window.ForgePlatform.syncDeepLink(
      {
        tab: state.tab,
        week: state.tab === "overview" ? kb.digests[state.selectedDigestIdx]?.week_key || "" : state.week,
        level: state.level,
        topic: state.topic,
        vendor: state.vendor,
        article: artObj ? artObj.id : state.article,
      },
      { push }
    );
  }

  function openDrawer(tabKey, id, fromPop) {
    const item = getDrawerItem(tabKey, id);
    if (!item) return;
    const wasOpen = state.drawer.open;
    state.drawer = { open: true, tab: tabKey, id, showAnswer: true };
    renderDrawer();
    document.getElementById("readerBackdrop")?.classList.remove("hidden");
    document.getElementById("readerDrawer")?.classList.remove("hidden");
    const body = document.getElementById("readerDrawerBody");
    if (body) body.scrollTop = 0;
    syncBodyScrollLock();
    if (!wasOpen && !fromPop && window.ForgePlatform?.pushNavLayer) {
      window.ForgePlatform.pushNavLayer("drawer", { tab: tabKey, id });
    } else {
      syncUrlState(false);
    }
  }

  function closeDrawer(fromPop) {
    if (!state.drawer.open) return;
    state.drawer.open = false;
    document.getElementById("readerBackdrop")?.classList.add("hidden");
    document.getElementById("readerDrawer")?.classList.add("hidden");
    document.querySelectorAll(".index-row.is-selected").forEach((el) => el.classList.remove("is-selected"));
    syncBodyScrollLock();
    window.ForgePlatform?.popNavLayer?.("drawer", fromPop);
    if (fromPop) syncUrlState(false);
  }

  function stepDrawer(delta) {
    if (!state.drawer.open) return;
    const list = filterListForTab(state.tab === "all" ? "all" : state.drawer.tab).filter((x) => (x._kind || state.drawer.tab) !== "diagrams");
    const idx = list.findIndex((x) => x.id === state.drawer.id);
    if (idx < 0 || list.length <= 1) return;
    const nextIdx = (idx + delta + list.length) % list.length;
    const nextItem = list[nextIdx];
    state.drawer.id = nextItem.id;
    if (nextItem._kind) state.drawer.tab = nextItem._kind;
    renderDrawer();
    syncUrlState();
    const body = document.getElementById("readerDrawerBody");
    if (body) body.scrollTop = 0;
  }

  function renderDrawer() {
    if (!state.drawer.open) return;
    const { tab: tabKey, id } = state.drawer;
    const item = getDrawerItem(tabKey, id);
    if (!item) {
      closeDrawer();
      return;
    }

    const list = filterListForTab(tabKey);
    const curIdx = list.findIndex((x) => x.id === id);
    const posText = curIdx >= 0 ? `${curIdx + 1} / ${list.length}` : "";

    const headerEl = document.getElementById("readerDrawerHeader");
    const bodyEl = document.getElementById("readerDrawerBody");
    const footerEl = document.getElementById("readerDrawerFooter");

    let primaryBtnHtml = "";
    if (tabKey === "questions") {
      primaryBtnHtml = `<button type="button" class="btn btn-primary btn-xs drawer-mock-btn">🎙️ 沉浸模拟面试</button>`;
    } else if (tabKey === "prompts") {
      primaryBtnHtml = `<button type="button" class="btn btn-primary btn-xs drawer-copy-prompt-btn">📋 一键复制模板</button>`;
    }

    const isBookmarked = Boolean(window.ForgePlatform?.isBookmarked?.(item.id));
    if (headerEl) {
      headerEl.innerHTML = `
        <div class="drawer-nav-group">
          <button type="button" class="btn btn-ghost btn-xs drawer-prev-btn" ${list.length <= 1 ? "disabled" : ""}>← 上一条</button>
          <span class="stat-sub">${escapeHtml(posText)}</span>
          <button type="button" class="btn btn-ghost btn-xs drawer-next-btn" ${list.length <= 1 ? "disabled" : ""}>下一条 →</button>
        </div>
        <div class="drawer-nav-group">
          <button type="button" class="btn btn-ghost btn-xs drawer-bookmark-btn ${isBookmarked ? "btn-bookmark-active" : ""}" title="本地收藏此条目">${isBookmarked ? "⭐ 已收藏" : "☆ 收藏"}</button>
          <button type="button" class="btn btn-ghost btn-xs drawer-share-btn" title="复制直达链接与推荐文案">🔗 分享</button>
          ${primaryBtnHtml}
          <button type="button" class="btn btn-ghost btn-xs drawer-close-btn">← 返回</button>
        </div>`;
    }

    const subTagsHtml = (item.sub_tags || [])
      .map((t) => `<button type="button" class="badge badge-subtag drawer-subtag-btn" data-subtag="${escapeHtml(t)}"># ${escapeHtml(t)}</button>`)
      .join("");

    let lifecycleHtml = "";
    if (item.lifecycle === "superseded") {
      lifecycleHtml = `<div class="lifecycle-banner">⚠️ <strong>代际更新提示：</strong>该条目已标记为已被新模型/新范式取代${item.lifecycle_note ? `（${escapeHtml(item.lifecycle_note)}）` : ""}。</div>`;
    } else if (item.lifecycle === "archived") {
      lifecycleHtml = `<div class="lifecycle-banner">📦 <strong>历史归档条目：</strong>仅作技术演进参考。</div>`;
    }

    let contentHtml = "";
    if (tabKey === "questions") {
      const summary = window.ForgeInterview?.getQuestionSummary?.(item.id);
      const scoreBadge =
        summary && summary.attemptsCount > 0
          ? `<span class="badge badge-green">模拟最高 ${summary.bestScore ?? "--"} 分 (${summary.attemptsCount}次)</span>`
          : "";
      contentHtml = `
        ${lifecycleHtml}
        <h2 class="drawer-title">${escapeHtml(item.title)}</h2>
        <div class="badges" style="margin-bottom: 14px;">
          <span class="badge badge-vendor-${escapeHtml(item.vendor_id || "community")}">${escapeHtml(item.vendor)}</span>
          <span class="badge">${escapeHtml(item.topic)}</span>
          <span class="badge badge-neutral">${escapeHtml(TRACK_LABELS[item.track] || item.track)}</span>
          <span class="badge badge-neutral">${escapeHtml(item.difficulty)}</span>
          ${scoreBadge}
          ${subTagsHtml}
        </div>
        <div class="section-block">
          <div class="section-heading">实战 / 面试场景</div>
          <p class="section-text">${renderInlineMarkdown(item.scenario)}</p>
        </div>
        ${window.ForgeInterview?.renderCardStripHtml ? window.ForgeInterview.renderCardStripHtml(item) : ""}
        <div style="margin-top: 14px;">
          <button type="button" class="btn btn-ghost btn-xs drawer-toggle-answer-btn">
            ${state.drawer.showAnswer ? "🙈 隐藏参考解析（自测模式）" : "👁️ 展开参考高分解析"}
          </button>
        </div>
        ${
          state.drawer.showAnswer
            ? `<div class="section-block">
                 <div class="section-heading">参考高分回答</div>
                 <p class="section-text">${renderInlineMarkdown(item.reference_answer)}</p>
               </div>
               <div class="section-block">
                 <div class="section-heading">核心采分点</div>
                 <ul class="bullet-list">${(item.key_points || []).map((pt) => `<li>${renderInlineMarkdown(pt)}</li>`).join("")}</ul>
               </div>
               <div class="section-block">
                 <div class="section-heading">面试官 / 客户连环追问</div>
                 <ul class="bullet-list">${(item.follow_up_questions || []).map((fq) => `<li>${renderInlineMarkdown(fq)}</li>`).join("")}</ul>
               </div>
               <div class="section-block">
                 <div class="section-heading">常见踩坑答法</div>
                 <p class="section-text">${renderInlineMarkdown(item.common_mistakes)}</p>
               </div>`
            : ""
        }
        <div class="evidence-box">
          <strong>原文溯源：</strong>${renderInlineMarkdown(item.evidence_quote)}<br/>
          来源：${window.ForgePrimer ? window.ForgePrimer.renderSourceLink(item) : `<a href="${escapeHtml(item.source_url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(item.source_title)} ↗</a>`}
        </div>`;
    } else if (tabKey === "prompts") {
      contentHtml = `
        ${lifecycleHtml}
        <h2 class="drawer-title">${escapeHtml(item.title)}</h2>
        <div class="badges" style="margin-bottom: 14px;">
          <span class="badge badge-vendor-${escapeHtml(item.vendor_id || "community")}">${escapeHtml(item.vendor)}</span>
          <span class="badge">${escapeHtml(item.topic)}</span>
          <span class="badge badge-neutral">角色：${escapeHtml(item.role)}</span>
          ${subTagsHtml}
        </div>
        <div class="section-block">
          <div class="section-heading">适用场景</div>
          <p class="section-text">${renderInlineMarkdown(item.use_case)}</p>
        </div>
        <div class="section-block">
          <div class="section-heading">结构化提示词模板</div>
          <pre class="prompt-pre">${highlightVars(item.template)}</pre>
        </div>
        <div class="section-block">
          <div class="section-heading">可替换变量</div>
          <ul class="bullet-list">${(item.variables || []).map((v) => `<li><code class="inline-code">{{${escapeHtml(v.name)}}}</code>：${renderInlineMarkdown(v.description)}</li>`).join("")}</ul>
        </div>
        <div class="pitfall-grid">
          <div class="pitfall-cell">
            <div class="section-heading">❌ 常见反例</div>
            <p class="section-text">${renderInlineMarkdown(item.anti_pattern)}</p>
          </div>
          <div class="pitfall-cell">
            <div class="section-heading">🎯 调优建议</div>
            <p class="section-text">${renderInlineMarkdown(item.tuning_tips)}</p>
          </div>
        </div>
        <div class="evidence-box">
          <strong>方法论溯源：</strong>${renderInlineMarkdown(item.evidence_quote)}<br/>
          来源：${window.ForgePrimer ? window.ForgePrimer.renderSourceLink(item) : `<a href="${escapeHtml(item.source_url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(item.source_title)} ↗</a>`}
        </div>`;
    } else {
      contentHtml = `
        ${lifecycleHtml}
        <h2 class="drawer-title">${escapeHtml(item.title)}</h2>
        <div class="badges" style="margin-bottom: 14px;">
          <span class="badge badge-${escapeHtml(item.severity)}">${escapeHtml(SEVERITY_LABELS[item.severity] || item.severity)}</span>
          <span class="badge badge-vendor-${escapeHtml(item.vendor_id || "community")}">${escapeHtml(item.vendor)}</span>
          <span class="badge">${escapeHtml(item.topic)}</span>
          ${subTagsHtml}
        </div>
        <div class="pitfall-grid">
          <div class="pitfall-cell">
            <div class="section-heading">🚨 线上 / 落地现象</div>
            <p class="section-text">${renderInlineMarkdown(item.symptom)}</p>
          </div>
          <div class="pitfall-cell">
            <div class="section-heading">🔍 底层根因</div>
            <p class="section-text">${renderInlineMarkdown(item.root_cause)}</p>
          </div>
          <div class="pitfall-cell">
            <div class="section-heading">⛔ 踩坑做法</div>
            <p class="section-text">${renderInlineMarkdown(item.bad_practice)}</p>
          </div>
          <div class="pitfall-cell">
            <div class="section-heading">🏗️ 架构级解法</div>
            <p class="section-text">${renderInlineMarkdown(item.architectural_fix)}</p>
          </div>
        </div>
        <div class="section-block">
          <div class="section-heading">⚓ 确定性验收锚点</div>
          <p class="section-text">${renderInlineMarkdown(item.verification_anchor)}</p>
        </div>
        <div class="evidence-box">
          <strong>案例溯源：</strong>${renderInlineMarkdown(item.evidence_quote)}<br/>
          来源：${window.ForgePrimer ? window.ForgePrimer.renderSourceLink(item) : `<a href="${escapeHtml(item.source_url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(item.source_title)} ↗</a>`}
        </div>`;
    }

    const savedNote = window.ForgePlatform?.getNote?.(item.id) || "";
    const noteAndFeedbackHtml = `
      <div class="drawer-note-box">
        <div class="drawer-note-head">
          <span class="section-heading" style="margin:0;">📝 我的个人笔记（本地自动保存）</span>
          <span id="drawerNoteStatus" class="stat-sub">${savedNote ? "已保存" : "可记录面试心得或实战踩坑"}</span>
        </div>
        <textarea id="drawerNoteInput" class="drawer-note-input" placeholder="记下你对这条知识的提炼、项目类比或追问思路...">${escapeHtml(savedNote)}</textarea>
        <div class="drawer-feedback-row">
          <span class="stat-sub">发现勘误、有更好的实践或想补充案例？</span>
          <button type="button" class="btn btn-ghost btn-xs drawer-feedback-btn">💬 纠错 / 补充反馈</button>
        </div>
      </div>`;

    if (bodyEl) {
      bodyEl.innerHTML = `${contentHtml}${noteAndFeedbackHtml}`;
      if (tabKey === "questions" && window.ForgeInterview?.bindCard) {
        window.ForgeInterview.bindCard(bodyEl, item);
      }
    }

    if (footerEl) {
      if (tabKey === "questions") {
        const st = state.progress.questions[item.id] || "";
        footerEl.innerHTML = `
          <div class="status-group">
            <button type="button" class="status-btn ${st === "mastered" ? "active-mastered" : ""}" data-drawer-qstatus="mastered">✅ 已掌握</button>
            <button type="button" class="status-btn ${st === "review" ? "active-review" : ""}" data-drawer-qstatus="review">🔁 需复习</button>
            <button type="button" class="status-btn ${st === "hard" ? "active-hard" : ""}" data-drawer-qstatus="hard">🔥 不会/重点</button>
          </div>
          <span class="stat-sub">ID: ${escapeHtml(item.id)}</span>`;
      } else if (tabKey === "pitfalls") {
        const checked = Boolean(state.progress.pitfalls[item.id]);
        footerEl.innerHTML = `
          <label class="toggle-inline">
            <input type="checkbox" id="drawerPitfallCheck" ${checked ? "checked" : ""} />
            <span>${checked ? "✅ 已排查 / 内化" : "标记为已排查"}</span>
          </label>
          <span class="stat-sub">ID: ${escapeHtml(item.id)}</span>`;
      } else {
        footerEl.innerHTML = `
          <span class="stat-sub">点击顶部按钮可一键复制模板</span>
          <span class="stat-sub">ID: ${escapeHtml(item.id)}</span>`;
      }
    }
  }

  // ==================== Global Ctrl+K Command Palette ====================

  function buildCommandItems(rawQuery) {
    const q = (rawQuery || "").trim().toLowerCase();
    const groups = [];

    // 1. Quick views & actions
    const actions = [
      { id: "act-overview", title: "📊 概览与每周周报", sub: "工作区首页", run: () => switchTab("overview") },
      { id: "act-random", title: "🎲 随机抽题沉浸模拟面试", sub: "AI 面试室", run: () => triggerRandomQuiz() },
      { id: "act-articles", title: "📚 浏览全部原文文章归档", sub: `${kb.articles.length} 篇`, run: () => switchTab("articles") },
      { id: "act-archive", title: "📂 打开模拟面试历史复盘档案", sub: "归档 / 导出", run: () => window.ForgeInterview?.openArchiveModal?.() },
      { id: "act-theme", title: "🌓 切换深色 / 浅色主题", sub: "外观", run: () => document.getElementById("themeToggle")?.click() },
    ].filter((x) => !q || x.title.toLowerCase().includes(q) || x.sub.toLowerCase().includes(q));
    if (actions.length) groups.push({ label: "⚡ 快捷操作", items: actions });

    // 2. Topics & Vendors
    const taxonomy = [
      ...kb.topics.map((t) => ({
        id: `top-${t}`,
        title: `🏷️ 专题：${t}`,
        sub: "筛选题库",
        run: () => {
          state.topic = t;
          state.page = 1;
          switchTab(state.tab === "overview" || state.tab === "articles" ? "questions" : state.tab);
        },
      })),
      ...kb.vendors.map((v) => ({
        id: `ven-${v.id}`,
        title: `🏢 厂商：${v.label}`,
        sub: "按信源筛选",
        run: () => {
          state.vendor = v.id;
          state.page = 1;
          switchTab(state.tab === "overview" ? "questions" : state.tab);
        },
      })),
    ].filter((x) => !q || x.title.toLowerCase().includes(q));
    if (taxonomy.length) groups.push({ label: "📂 按分类跳转", items: taxonomy.slice(0, q ? 8 : 6) });

    // 3. Articles
    const matchedArticles = kb.articles
      .filter((a) => !q || (a._searchText || "").includes(q))
      .slice(0, q ? 6 : 4)
      .map((a) => ({
        id: a.id,
        title: `📄 ${a.source_title}`,
        sub: `${a.vendor.split(" / ")[0]} · ${a.total_assets}条`,
        run: () => {
          state.vendor = "all";
          state.topic = "all";
          state.subTag = "all";
          state.article = a.source_title;
          state.page = 1;
          switchTab("questions");
        },
      }));
    if (matchedArticles.length) groups.push({ label: "📚 原文文章直达", items: matchedArticles });

    // 4. Direct KB Assets
    const assetMatches = [];
    for (const [kind, list, icon] of [
      ["questions", kb.questions, "🧠"],
      ["prompts", kb.prompts, "✨"],
      ["pitfalls", kb.pitfalls, "🛡️"],
    ]) {
      for (const item of list) {
        if (!q || (item._searchText || "").includes(q)) {
          assetMatches.push({
            id: item.id,
            title: `${icon} ${item.title}`,
            sub: item.topic,
            run: () => {
              switchTab(kind);
              openDrawer(kind, item.id);
            },
          });
        }
        if (assetMatches.length >= (q ? 14 : 6)) break;
      }
    }
    if (assetMatches.length) groups.push({ label: "🎯 条目直达（回车抽屉精读）", items: assetMatches });

    return groups;
  }

  function openCmdPalette() {
    if (state.cmd.open) return;
    state.cmd.open = true;
    state.cmd.query = "";
    state.cmd.activeIndex = 0;
    const backdrop = document.getElementById("cmdPaletteBackdrop");
    const input = document.getElementById("cmdPaletteInput");
    backdrop?.classList.remove("hidden");
    syncBodyScrollLock();
    window.ForgePlatform?.pushNavLayer?.("cmd");
    if (input) {
      input.value = "";
      setTimeout(() => input.focus(), 30);
    }
    renderCmdPalette();
  }

  function closeCmdPalette(fromPop) {
    if (!state.cmd.open) return;
    state.cmd.open = false;
    document.getElementById("cmdPaletteBackdrop")?.classList.add("hidden");
    syncBodyScrollLock();
    window.ForgePlatform?.popNavLayer?.("cmd", fromPop);
  }

  function renderCmdPalette() {
    const groups = buildCommandItems(state.cmd.query);
    const flat = [];
    let html = "";
    for (const g of groups) {
      html += `<div class="cmd-group-label">${escapeHtml(g.label)}</div>`;
      for (const item of g.items) {
        const idx = flat.length;
        flat.push(item);
        html += `<button type="button" class="cmd-item ${idx === state.cmd.activeIndex ? "active" : ""}" data-cmd-idx="${idx}">
                   <span class="cmd-item-title">${escapeHtml(item.title)}</span>
                   <span class="cmd-item-sub">${escapeHtml(item.sub)}</span>
                 </button>`;
      }
    }
    if (!flat.length) {
      html = `<div class="empty-state" style="padding:28px;">没有匹配的分类或条目</div>`;
    }
    state.cmd.items = flat;
    if (state.cmd.activeIndex >= flat.length) state.cmd.activeIndex = 0;
    const container = document.getElementById("cmdPaletteResults");
    if (container) container.innerHTML = html;
  }

  // ==================== Core Render Pipeline ====================

  function syncNavChrome(tabKey) {
    document.querySelectorAll(".rail-nav-btn").forEach((btn) => btn.classList.toggle("active", btn.dataset.tab === tabKey));
    document.getElementById("goHomeBtn")?.classList.toggle("hidden", tabKey === "overview");
    document.querySelectorAll("#mobileQuickTabs [data-mobile-tab]").forEach((btn) => {
      const isAct = btn.dataset.mobileTab === tabKey;
      btn.classList.toggle("active", isAct);
      if (isAct && window.innerWidth <= 640) btn.scrollIntoView({ inline: "nearest", block: "nearest" });
    });
  }

  function switchTab(tabKey, opts) {
    const pushHist = opts ? opts.push !== false : true;
    state.tab = tabKey;
    if (tabKey !== "primer") window.ForgePrimer?.resetActiveLesson?.();
    state.sub = "all";
    state.page = 1;
    state.showAllOnPage = false;
    closeMobileRail(true);
    syncNavChrome(tabKey);
    renderRailTrees();
    renderFilterPopoverControls();
    renderContent();
    syncUrlState(pushHist);
    window.scrollTo({ top: 0, behavior: "instant" });
  }

  function triggerRandomQuiz() {
    const activePool = kb.questions.filter(isLifecycleAllowed);
    const unmastered = activePool.filter((q) => state.progress.questions[q.id] !== "mastered");
    const candidates = unmastered.length ? unmastered : activePool.length ? activePool : kb.questions;
    if (!candidates.length) {
      showToast("题库暂无题目");
      return;
    }
    const picked = candidates[Math.floor(Math.random() * candidates.length)];
    closeMobileRail();
    window.ForgeInterview?.openStudio?.(picked.id);
    showToast("已随机抽取 1 道前沿实战题，进入沉浸模拟面试间！");
  }

  function resetAllFilters() {
    state.allKind = "all";
    state.vendor = "all";
    state.article = "all";
    state.topic = "all";
    state.level = "all";
    state.subTag = "all";
    state.subTagSearch = "";
    state.track = "all";
    state.sub = "all";
    state.week = "all";
    state.query = "";
    state.onlyBookmarked = false;
    state.onlyUnmastered = false;
    state.onlyActiveLifecycle = true;
    state.page = 1;
    const searchEl = document.getElementById("searchInput");
    if (searchEl) searchEl.value = "";
    const tagSearchEl = document.getElementById("subTagSearchInput");
    if (tagSearchEl) tagSearchEl.value = "";
    renderRailTrees();
    renderFilterPopoverControls();
    renderContent();
    syncUrlState();
  }

  function renderContent() {
    renderDockMeta();
    updateRailCounts();
    renderActiveChips();

    const items = filterListForTab(state.tab);
    const meta = VIEW_META[state.tab] || { title: state.tab, unit: "条" };
    const titleEl = document.getElementById("viewTitle");
    const badgeEl = document.getElementById("viewCountBadge");
    if (titleEl) titleEl.textContent = meta.title;
    if (badgeEl) badgeEl.textContent = `${items.length} ${meta.unit}`;

    const area = document.getElementById("contentArea");
    if (!area) return;

    window.ForgeInterview?.cleanupTimers?.();

    if (state.tab === "overview") {
      area.innerHTML = renderOverview();
    } else if (state.tab === "primer") {
      area.innerHTML = window.ForgePrimer?.renderPrimerView?.(items) || "";
    } else if (!items.length) {
      area.innerHTML = `<div class="empty-state">当前筛选条件下暂无条目，试试点击「清除全部」或按 <code>Ctrl+K</code> 全局检索。</div>`;
    } else if (state.tab === "all" || state.tab === "questions" || state.tab === "prompts" || state.tab === "pitfalls") {
      area.innerHTML = renderIndexList(items, state.tab);
    } else if (state.tab === "articles") {
      area.innerHTML = renderArticlesHub(items);
    } else if (state.tab === "diagrams") {
      area.innerHTML = renderDiagrams(items);
    }

    syncDiagramAutoPlay();
  }

  // ==================== Mobile Rail & Scroll Lock Helpers ====================

  function syncBodyScrollLock() {
    const railOpen = document.getElementById("appRail")?.classList.contains("mobile-open");
    const mobileFilterOpen = state.filterPopoverOpen && window.innerWidth <= 640;
    window.ForgePlatform?.setBodyScrollLock?.(Boolean(railOpen || state.drawer.open || state.cmd.open || mobileFilterOpen));
  }

  function openMobileRail() {
    setFilterPopoverOpen(false, true);
    const rail = document.getElementById("appRail");
    if (rail?.classList.contains("mobile-open")) return;
    rail?.classList.add("mobile-open");
    document.getElementById("railBackdrop")?.classList.remove("hidden");
    syncBodyScrollLock();
    window.ForgePlatform?.pushNavLayer?.("rail");
  }

  function closeMobileRail(fromPop) {
    const rail = document.getElementById("appRail");
    if (!rail?.classList.contains("mobile-open")) return;
    rail.classList.remove("mobile-open");
    document.getElementById("railBackdrop")?.classList.add("hidden");
    syncBodyScrollLock();
    window.ForgePlatform?.popNavLayer?.("rail", fromPop);
  }

  function setFilterPopoverOpen(open, fromPop) {
    if (state.filterPopoverOpen === open) return;
    state.filterPopoverOpen = open;
    document.getElementById("filterPopover")?.classList.toggle("hidden", !open);
    document.getElementById("filterBackdrop")?.classList.toggle("hidden", !open);
    document.querySelector(".main-toolbar")?.classList.toggle("has-open-filter", open);
    document.getElementById("filterPopoverBtn")?.setAttribute("aria-expanded", String(open));
    syncBodyScrollLock();
    if (open && window.innerWidth <= 640) window.ForgePlatform?.pushNavLayer?.("filter");
    else if (!open) window.ForgePlatform?.popNavLayer?.("filter", fromPop);
  }

  // ==================== Event Delegation (Fast, Zero Listener Leak) ====================

  function bindGlobalEvents() {
    // Demand probe tracking across entire document (including interview modals)
    document.addEventListener("click", (e) => {
      const probe = e.target.closest?.(".demand-probe-link");
      if (probe) {
        ForgeAnalytics.track("demand_hook_click", { hook: probe.dataset.probe || "unknown" });
      }
    });

    // Rail main tabs
    document.querySelectorAll(".rail-nav-btn").forEach((btn) => {
      btn.addEventListener("click", () => switchTab(btn.dataset.tab));
    });

    // Collapsible rail trees
    document.getElementById("toggleTopicTree")?.addEventListener("click", (e) => {
      state.topicTreeOpen = !state.topicTreeOpen;
      e.currentTarget.setAttribute("aria-expanded", String(state.topicTreeOpen));
      renderRailTrees();
    });

    document.getElementById("toggleLevelTree")?.addEventListener("click", (e) => {
      state.levelTreeOpen = !state.levelTreeOpen;
      e.currentTarget.setAttribute("aria-expanded", String(state.levelTreeOpen));
      renderRailTrees();
    });

    document.getElementById("toggleVendorTree")?.addEventListener("click", (e) => {
      state.vendorTreeOpen = !state.vendorTreeOpen;
      e.currentTarget.setAttribute("aria-expanded", String(state.vendorTreeOpen));
      renderRailTrees();
    });

    // Delegated clicks inside rail trees
    document.getElementById("topicTreeList")?.addEventListener("click", (e) => {
      const btn = e.target.closest(".rail-tree-btn");
      if (!btn) return;
      state.topic = btn.dataset.topic;
      state.page = 1;
      if (state.tab === "overview") switchTab("all");
      else {
        renderRailTrees();
        renderFilterPopoverControls();
        renderContent();
        syncUrlState();
      }
    });

    document.getElementById("levelTreeList")?.addEventListener("click", (e) => {
      const btn = e.target.closest(".rail-tree-btn");
      if (!btn) return;
      state.level = btn.dataset.level;
      state.page = 1;
      if (state.tab === "overview") switchTab("all");
      else {
        renderRailTrees();
        renderFilterPopoverControls();
        renderContent();
        syncUrlState();
      }
    });

    document.getElementById("vendorTreeList")?.addEventListener("click", (e) => {
      const btn = e.target.closest(".rail-tree-btn");
      if (!btn) return;
      state.vendor = btn.dataset.vendor;
      state.article = "all";
      state.page = 1;
      if (state.tab === "overview") switchTab("all");
      else {
        renderRailTrees();
        renderFilterPopoverControls();
        renderContent();
        syncUrlState();
      }
    });

    // Top toolbar Share & Footer Feedback buttons
    document.getElementById("shareSiteBtn")?.addEventListener("click", () => {
      if (state.tab === "overview" && kb.digests[state.selectedDigestIdx]) {
        window.ForgePlatform?.shareResource?.("digest", kb.digests[state.selectedDigestIdx]);
      } else if (state.article !== "all") {
        const a = kb.articles.find((x) => x.source_title === state.article);
        window.ForgePlatform?.shareResource?.("article", a || { source_title: state.article });
      } else {
        window.ForgePlatform?.shareResource?.("site", {});
      }
    });
    document.getElementById("siteFeedbackBtn")?.addEventListener("click", () => {
      window.ForgePlatform?.submitFeedback?.({
        kind: "contribute",
        title: "站点体验建议 / 前沿好文推荐",
      });
    });

    // Dock buttons
    document.getElementById("randomQuizBtn")?.addEventListener("click", triggerRandomQuiz);
    document.getElementById("openArchiveBtn")?.addEventListener("click", () => {
      closeMobileRail();
      window.ForgeInterview?.openArchiveModal?.();
    });
    document.getElementById("aiSettingsBtn")?.addEventListener("click", () => {
      closeMobileRail();
      window.ForgeInterview?.openSettingsModal?.();
    });

    // Mobile rail, brand logo & home button, quick tabs & left-swipe close
    document.getElementById("openRailBtn")?.addEventListener("click", openMobileRail);
    document.getElementById("brandHomeBtn")?.addEventListener("click", () => {
      if (state.drawer?.open) closeDrawer();
      switchTab("overview");
    });
    document.getElementById("goHomeBtn")?.addEventListener("click", () => switchTab("overview"));
    document.getElementById("closeRailBtn")?.addEventListener("click", () => closeMobileRail(false));
    document.getElementById("railBackdrop")?.addEventListener("click", () => closeMobileRail(false));
    document.getElementById("filterBackdrop")?.addEventListener("click", () => setFilterPopoverOpen(false));
    document.getElementById("mobileQuickTabs")?.addEventListener("click", (e) => {
      const btn = e.target.closest?.(".mobile-qtab");
      if (btn?.dataset.mobileTab) switchTab(btn.dataset.mobileTab);
    });
    window.ForgePlatform?.bindSwipeLeftClose?.(document.getElementById("appRail"), () => closeMobileRail(false));

    // Search with 180ms debounce
    document.getElementById("searchInput")?.addEventListener("input", (e) => {
      const val = e.target.value.trim();
      clearTimeout(searchDebounceTimer);
      searchDebounceTimer = setTimeout(() => {
        state.query = val;
        state.page = 1;
        renderContent();
      }, 180);
    });

    // Filter popover controls
    document.getElementById("filterPopoverBtn")?.addEventListener("click", (e) => {
      e.stopPropagation();
      setFilterPopoverOpen(!state.filterPopoverOpen);
    });
    document.getElementById("closeFilterPopoverBtn")?.addEventListener("click", () => setFilterPopoverOpen(false));
    document.getElementById("resetFiltersBtn")?.addEventListener("click", () => {
      resetAllFilters();
      setFilterPopoverOpen(false);
    });
    document.addEventListener("click", (e) => {
      if (state.filterPopoverOpen && !e.target.closest?.(".filter-popover-anchor")) {
        setFilterPopoverOpen(false);
      }
    });

    document.getElementById("subTagSearchInput")?.addEventListener("input", (e) => {
      state.subTagSearch = e.target.value || "";
      renderFilterPopoverControls();
    });

    document.getElementById("subTagPills")?.addEventListener("click", (e) => {
      const btn = e.target.closest(".subtag-pill");
      if (!btn) return;
      const tag = btn.dataset.subtag;
      state.subTag = state.subTag === tag ? "all" : tag;
      state.page = 1;
      renderFilterPopoverControls();
      renderContent();
    });

    document.getElementById("onlyBookmarked")?.addEventListener("change", (e) => {
      state.onlyBookmarked = e.target.checked;
      state.page = 1;
      renderFilterPopoverControls();
      renderContent();
    });

    document.getElementById("trackFilter")?.addEventListener("change", (e) => {
      state.track = e.target.value;
      state.page = 1;
      renderFilterPopoverControls();
      renderContent();
    });
    document.getElementById("subFilter")?.addEventListener("change", (e) => {
      state.sub = e.target.value;
      state.page = 1;
      renderFilterPopoverControls();
      renderContent();
    });
    document.getElementById("weekFilter")?.addEventListener("change", (e) => {
      state.week = e.target.value;
      state.page = 1;
      renderRailTrees();
      renderFilterPopoverControls();
      renderContent();
    });
    document.getElementById("onlyUnmastered")?.addEventListener("change", (e) => {
      state.onlyUnmastered = e.target.checked;
      state.page = 1;
      renderFilterPopoverControls();
      renderContent();
    });
    document.getElementById("onlyActiveLifecycle")?.addEventListener("change", (e) => {
      state.onlyActiveLifecycle = e.target.checked;
      state.page = 1;
      renderRailTrees();
      renderFilterPopoverControls();
      renderContent();
    });

    // Active chips removal
    document.getElementById("activeFilterChips")?.addEventListener("click", (e) => {
      const btn = e.target.closest("[data-clear-chip]");
      if (!btn) return;
      const key = btn.dataset.clearChip;
      if (key === "all") {
        resetAllFilters();
        return;
      }
      if (key === "onlyBookmarked") state.onlyBookmarked = false;
      else if (key === "onlyUnmastered") state.onlyUnmastered = false;
      else if (key === "onlyActiveLifecycle") state.onlyActiveLifecycle = true;
      else if (key === "query") {
        state.query = "";
        const searchEl = document.getElementById("searchInput");
        if (searchEl) searchEl.value = "";
      } else {
        state[key] = "all";
      }
      state.page = 1;
      renderRailTrees();
      renderFilterPopoverControls();
      renderContent();
    });

    // Main Content Area single-point Event Delegation
    const area = document.getElementById("contentArea");
    area?.addEventListener("click", (e) => {
      const target = e.target;
      if (window.ForgePrimer?.handleClick?.(target)) return;

      // Round 2: Share digest / article / diagram, All-assets kind pills, L1 empty-state CTA
      const shareDigestBtn = target.closest(".share-digest-btn");
      if (shareDigestBtn) {
        const dObj = kb.digests.find((x) => x.id === shareDigestBtn.dataset.digestId) || kb.digests[state.selectedDigestIdx];
        if (dObj) window.ForgePlatform?.shareResource?.("digest", dObj);
        return;
      }
      const shareArticleBtn = target.closest(".share-article-btn");
      if (shareArticleBtn) {
        e.stopPropagation();
        const aObj = kb.articles.find((x) => x.id === shareArticleBtn.dataset.articleId);
        if (aObj) window.ForgePlatform?.shareResource?.("article", aObj);
        return;
      }
      const shareDiagramBtn = target.closest(".share-diagram-btn");
      if (shareDiagramBtn) {
        e.stopPropagation();
        const dObj = diagramById.get(shareDiagramBtn.dataset.diagramId);
        if (dObj) window.ForgePlatform?.shareResource?.("diagram", dObj);
        return;
      }
      const allKindPill = target.closest(".all-kind-pill");
      if (allKindPill) {
        state.allKind = allKindPill.dataset.allKind || "all";
        state.page = 1;
        renderContent();
        return;
      }

      // Overview random quiz
      if (target.closest(".overview-random-quiz-btn")) {
        triggerRandomQuiz();
        return;
      }

      // Digest issue navigation & mode
      if (target.closest(".digest-prev-issue-btn")) {
        const list = filterListForTab("overview");
        if (state.selectedDigestIdx < list.length - 1) {
          state.selectedDigestIdx += 1;
          renderContent();
        }
        return;
      }
      if (target.closest(".digest-next-issue-btn")) {
        if (state.selectedDigestIdx > 0) {
          state.selectedDigestIdx -= 1;
          renderContent();
        }
        return;
      }
      const modeBtn = target.closest(".digest-mode-btn");
      if (modeBtn) {
        state.digestViewMode = modeBtn.dataset.mode || "single";
        renderContent();
        return;
      }
      const archivePick = target.closest(".digest-archive-pick");
      if (archivePick) {
        state.selectedDigestIdx = Number(archivePick.dataset.issueIdx) || 0;
        state.digestViewMode = "single";
        renderContent();
        return;
      }

      // Digest interactive actions
      const digestMock = target.closest(".digest-mock-btn");
      if (digestMock) {
        window.ForgeInterview?.openStudio?.(digestMock.dataset.qid);
        return;
      }
      const digestDrawer = target.closest(".digest-open-drawer-btn");
      if (digestDrawer) {
        const tTab = digestDrawer.dataset.targetTab;
        const tId = digestDrawer.dataset.targetId;
        if (tTab && tId) {
          switchTab(tTab);
          openDrawer(tTab, tId);
        }
        return;
      }
      const digestSubtag = target.closest(".digest-filter-subtag-btn");
      if (digestSubtag) {
        state.subTag = digestSubtag.dataset.subtag;
        state.page = 1;
        switchTab("questions");
        showToast(`已按趋势标签「#${state.subTag}」筛选`);
        return;
      }
      const digestDiagram = target.closest(".digest-jump-diagram-btn");
      if (digestDiagram) {
        switchTab("diagrams");
        return;
      }
      const gotoArticles = target.closest(".goto-articles-hub-btn");
      if (gotoArticles) {
        state.week = gotoArticles.dataset.week || "all";
        switchTab("articles");
        return;
      }
      const filterArticleBtn = target.closest(".digest-filter-article-btn");
      if (filterArticleBtn) {
        state.vendor = "all";
        state.topic = "all";
        state.level = "all";
        state.subTag = "all";
        state.allKind = "all";
        state.article = filterArticleBtn.dataset.article;
        state.page = 1;
        switchTab("all");
        showToast("已切换到该原文提炼的全部资产");
        return;
      }
      const digestCopyPrompt = target.closest(".digest-copy-prompt-btn");
      if (digestCopyPrompt) {
        const p = promptById.get(digestCopyPrompt.dataset.promptId);
        if (p?.template) {
          const payload = window.ForgePlatform?.buildAttributedCopy
            ? window.ForgePlatform.buildAttributedCopy(p.template, { title: p.title, id: p.id, tab: "prompts" })
            : p.template;
          copyTextToClipboard(payload, "已复制本周精选提示词模板（附来源链接）");
          ForgeAnalytics.track("prompt_copied", { pid: p.id, role: p.role || "" });
        }
        return;
      }
      const toggleSocial = target.closest(".toggle-digest-social-btn");
      if (toggleSocial) {
        const did = toggleSocial.dataset.digestId;
        state.digestSocialOpen[did] = !state.digestSocialOpen[did];
        renderContent();
        return;
      }
      const socialTab = target.closest(".digest-social-tab");
      if (socialTab) {
        state.digestSocialTab[socialTab.dataset.digestId] = socialTab.dataset.platform;
        renderContent();
        return;
      }
      const copySocial = target.closest(".digest-copy-social-btn");
      if (copySocial) {
        const did = copySocial.dataset.digestId;
        const dObj = kb.digests.find((x) => x.id === did);
        const plat = state.digestSocialTab[did] || "juejin_zhihu";
        const text = dObj?.social_drafts?.[plat] || "";
        const names = { juejin_zhihu: "掘金/知乎长文", xiaohongshu: "小红书卡片", x_thread: "X Thread" };
        if (text) copyTextToClipboard(text, `已复制「${names[plat] || plat}」引流草稿`);
        return;
      }
      const dlSocial = target.closest(".digest-download-social-btn");
      if (dlSocial) {
        const dObj = kb.digests.find((x) => x.id === dlSocial.dataset.digestId);
        if (!dObj) return;
        const drafts = dObj.social_drafts || {};
        const md = [
          `# 社媒引流复盘草稿 · ${dObj.issue_label}（${dObj.week_key}）`,
          "",
          "## 版本 A：掘金 / 知乎长文深度复盘版",
          "",
          drafts.juejin_zhihu || "",
          "",
          "---",
          "",
          "## 版本 B：小红书图文卡片版",
          "",
          drafts.xiaohongshu || "",
          "",
          "---",
          "",
          "## 版本 C：X (Twitter) 线程版",
          "",
          drafts.x_thread || "",
        ].join("\n");
        const fn = `week_${dObj.week_slug || dObj.week_key}.md`;
        downloadMarkdownFile(fn, md);
        showToast(`已导出全平台社媒草稿 ${fn}`);
        return;
      }

      // Article Hub group toggle
      const groupByBtn = target.closest(".article-groupby-btn");
      if (groupByBtn) {
        state.articleGroupBy = groupByBtn.dataset.group || "week";
        renderContent();
        return;
      }

      // Pagination
      if (target.closest(".page-prev-btn")) {
        if (state.page > 1) {
          state.page -= 1;
          renderContent();
          window.scrollTo({ top: 0, behavior: "smooth" });
        }
        return;
      }
      if (target.closest(".page-next-btn")) {
        state.page += 1;
        renderContent();
        window.scrollTo({ top: 0, behavior: "smooth" });
        return;
      }
      if (target.closest(".page-toggle-all-btn")) {
        state.showAllOnPage = !state.showAllOnPage;
        state.page = 1;
        renderContent();
        return;
      }

      // Index Row quick actions (must stop before opening drawer)
      const rowMock = target.closest(".row-mock-btn");
      if (rowMock) {
        e.stopPropagation();
        window.ForgeInterview?.openStudio?.(rowMock.dataset.id);
        return;
      }
      const rowCopyPrompt = target.closest(".row-copy-prompt-btn");
      if (rowCopyPrompt) {
        e.stopPropagation();
        const p = promptById.get(rowCopyPrompt.dataset.id);
        if (p?.template) {
          const payload = window.ForgePlatform?.buildAttributedCopy
            ? window.ForgePlatform.buildAttributedCopy(p.template, { title: p.title, id: p.id, tab: "prompts" })
            : p.template;
          copyTextToClipboard(payload, "已复制结构化提示词到剪贴板（附来源链接）");
          ForgeAnalytics.track("prompt_copied", { pid: p.id, role: p.role || "" });
        }
        return;
      }
      const jumpDiagramBtn = target.closest(".row-jump-diagram-btn, [data-jump-diagram-id]");
      if (jumpDiagramBtn) {
        const did = jumpDiagramBtn.dataset.diagramId || jumpDiagramBtn.dataset.jumpDiagramId;
        switchTab("diagrams");
        if (did) {
          setTimeout(() => {
            document.getElementById(`card-${did}`)?.scrollIntoView({ behavior: "smooth", block: "start" });
          }, 60);
        }
        return;
      }
      if (target.closest("[data-stop-row]")) {
        return;
      }

      // Open Reader Drawer when clicking index row
      const rowEl = target.closest("[data-open-drawer-id]");
      if (rowEl && !target.closest("a")) {
        openDrawer(rowEl.dataset.openDrawerTab, rowEl.dataset.openDrawerId);
        return;
      }

      // Diagram controls (in-place update!)
      const diagCard = target.closest(".diagram-card");
      if (diagCard) {
        const d = diagramById.get(diagCard.dataset.diagramId);
        if (!d) return;
        const rt = getDiagramRuntime(d);
        if (target.closest(".diagram-play-btn")) {
          rt.playing = !rt.playing;
          if (rt.playing) rt.inspectedNodeId = null;
          updateDiagramCardInPlace(diagCard, d);
          syncDiagramAutoPlay();
        } else if (target.closest(".diagram-prev-btn")) {
          rt.playing = false;
          rt.inspectedNodeId = null;
          rt.step = (rt.step - 1 + d.stages.length) % d.stages.length;
          updateDiagramCardInPlace(diagCard, d);
          syncDiagramAutoPlay();
        } else if (target.closest(".diagram-next-btn")) {
          rt.playing = false;
          rt.inspectedNodeId = null;
          rt.step = (rt.step + 1) % d.stages.length;
          updateDiagramCardInPlace(diagCard, d);
          syncDiagramAutoPlay();
        } else if (target.closest(".step-dot")) {
          const dot = target.closest(".step-dot");
          rt.playing = false;
          rt.inspectedNodeId = null;
          rt.step = Number(dot.dataset.step) || 0;
          updateDiagramCardInPlace(diagCard, d);
          syncDiagramAutoPlay();
        } else if (target.closest(".mem-node")) {
          const nodeEl = target.closest(".mem-node");
          rt.playing = false;
          rt.inspectedNodeId = nodeEl.dataset.nodeId;
          updateDiagramCardInPlace(diagCard, d);
          syncDiagramAutoPlay();
        } else if (target.closest(".diagram-back-stage-btn")) {
          rt.inspectedNodeId = null;
          updateDiagramCardInPlace(diagCard, d);
          syncDiagramAutoPlay();
        }
      }
    });

    area?.addEventListener("change", (e) => {
      if (e.target.id === "digestIssueSelect") {
        state.selectedDigestIdx = Number(e.target.value) || 0;
        renderContent();
        return;
      }
      if (e.target.classList.contains("row-pitfall-check")) {
        const id = e.target.dataset.id;
        state.progress.pitfalls[id] = e.target.checked;
        saveProgress();
        renderContent();
      }
    });

    // Reader Drawer Events
    document.getElementById("readerBackdrop")?.addEventListener("click", closeDrawer);
    document.getElementById("readerDrawer")?.addEventListener("click", (e) => {
      const target = e.target;
      if (window.ForgePrimer?.handleClick?.(target)) return;
      if (target.closest(".drawer-close-btn")) {
        closeDrawer();
      } else if (target.closest(".drawer-prev-btn")) {
        stepDrawer(-1);
      } else if (target.closest(".drawer-next-btn")) {
        stepDrawer(1);
      } else if (target.closest(".drawer-mock-btn")) {
        const qid = state.drawer.id;
        closeDrawer(true);
        window.ForgeInterview?.openStudio?.(qid);
      } else if (target.closest(".drawer-bookmark-btn")) {
        const id = state.drawer.id;
        const nowStarred = window.ForgePlatform?.toggleBookmark?.(id);
        renderDrawer();
        renderContent();
        showToast(nowStarred ? "⭐ 已加入本地收藏夹" : "已取消收藏");
      } else if (target.closest(".drawer-share-btn")) {
        const item = getDrawerItem(state.drawer.tab, state.drawer.id);
        if (item) {
          window.ForgePlatform?.shareResource?.("item", {
            tab: state.drawer.tab,
            id: item.id,
            title: item.title,
          });
        }
      } else if (target.closest(".drawer-feedback-btn")) {
        const item = getDrawerItem(state.drawer.tab, state.drawer.id);
        if (item) {
          window.ForgePlatform?.submitFeedback?.({
            kind: state.drawer.tab,
            id: item.id,
            title: item.title,
            tab: state.drawer.tab,
            source_url: item.source_url,
          });
        }
      } else if (target.closest(".drawer-copy-prompt-btn")) {
        const p = promptById.get(state.drawer.id);
        if (p?.template) {
          const payload = window.ForgePlatform?.buildAttributedCopy
            ? window.ForgePlatform.buildAttributedCopy(p.template, { title: p.title, id: p.id, tab: "prompts" })
            : p.template;
          copyTextToClipboard(payload, "已复制结构化提示词到剪贴板（附来源链接）");
          ForgeAnalytics.track("prompt_copied", { pid: p.id, role: p.role || "" });
        }
      } else if (target.closest(".drawer-toggle-answer-btn")) {
        state.drawer.showAnswer = !state.drawer.showAnswer;
        renderDrawer();
      } else if (target.closest(".drawer-subtag-btn")) {
        const tag = target.closest(".drawer-subtag-btn").dataset.subtag;
        state.subTag = tag;
        state.page = 1;
        closeDrawer();
        renderFilterPopoverControls();
        renderContent();
      } else if (target.closest("[data-drawer-qstatus]")) {
        const nextSt = target.closest("[data-drawer-qstatus]").dataset.drawerQstatus;
        const id = state.drawer.id;
        if (state.progress.questions[id] === nextSt) delete state.progress.questions[id];
        else state.progress.questions[id] = nextSt;
        saveProgress();
        renderDrawer();
        renderContent();
      }
    });
    document.getElementById("readerDrawer")?.addEventListener("input", (e) => {
      if (e.target.id === "drawerNoteInput" && state.drawer.id) {
        const val = e.target.value;
        const id = state.drawer.id;
        clearTimeout(noteSaveTimer);
        const stEl = document.getElementById("drawerNoteStatus");
        if (stEl) stEl.textContent = "保存中...";
        noteSaveTimer = setTimeout(() => {
          const saved = window.ForgePlatform?.saveNote?.(id, val);
          const el = document.getElementById("drawerNoteStatus");
          if (el) el.textContent = saved ? "已自动保存 ✓" : "已清空";
        }, 250);
      }
    });
    document.getElementById("readerDrawer")?.addEventListener("change", (e) => {
      if (e.target.id === "drawerPitfallCheck") {
        state.progress.pitfalls[state.drawer.id] = e.target.checked;
        saveProgress();
        renderDrawer();
        renderContent();
      }
    });

    // Command Palette Events
    document.getElementById("cmdPaletteBtn")?.addEventListener("click", openCmdPalette);
    document.getElementById("cmdCloseBtn")?.addEventListener("click", closeCmdPalette);
    document.getElementById("cmdPaletteBackdrop")?.addEventListener("click", (e) => {
      if (e.target.id === "cmdPaletteBackdrop") closeCmdPalette();
    });
    document.getElementById("cmdPaletteInput")?.addEventListener("input", (e) => {
      state.cmd.query = e.target.value;
      state.cmd.activeIndex = 0;
      renderCmdPalette();
    });
    document.getElementById("cmdPaletteResults")?.addEventListener("click", (e) => {
      const btn = e.target.closest(".cmd-item");
      if (!btn) return;
      const item = state.cmd.items[Number(btn.dataset.cmdIdx)];
      closeCmdPalette();
      if (item?.run) item.run();
    });

    // Global Keyboard Shortcuts (Ctrl+K / Cmd+K / Esc / Drawer Left-Right)
    document.addEventListener("keydown", (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        if (state.cmd.open) closeCmdPalette();
        else openCmdPalette();
        return;
      }
      if (state.cmd.open) {
        if (e.key === "Escape") {
          e.preventDefault();
          closeCmdPalette();
        } else if (e.key === "ArrowDown") {
          e.preventDefault();
          if (state.cmd.items.length) {
            state.cmd.activeIndex = (state.cmd.activeIndex + 1) % state.cmd.items.length;
            renderCmdPalette();
          }
        } else if (e.key === "ArrowUp") {
          e.preventDefault();
          if (state.cmd.items.length) {
            state.cmd.activeIndex = (state.cmd.activeIndex - 1 + state.cmd.items.length) % state.cmd.items.length;
            renderCmdPalette();
          }
        } else if (e.key === "Enter") {
          e.preventDefault();
          const item = state.cmd.items[state.cmd.activeIndex];
          closeCmdPalette();
          if (item?.run) item.run();
        }
        return;
      }
      if (e.key === "Escape") {
        if (state.filterPopoverOpen) {
          setFilterPopoverOpen(false);
          return;
        }
        if (state.drawer.open) {
          closeDrawer();
          return;
        }
      }
      if (state.drawer.open && !["INPUT", "TEXTAREA", "SELECT"].includes(document.activeElement?.tagName || "")) {
        if (e.key === "ArrowLeft") stepDrawer(-1);
        else if (e.key === "ArrowRight") stepDrawer(1);
      }
    });

    // Back to top
    const backToTopBtn = document.getElementById("backToTopBtn");
    window.addEventListener(
      "scroll",
      () => {
        backToTopBtn?.classList.toggle("show", window.scrollY > 320);
      },
      { passive: true }
    );
    backToTopBtn?.addEventListener("click", () => {
      window.scrollTo({ top: 0, behavior: "smooth" });
    });
  }

  function applyDeepLinkFromHash() {
    const params = window.ForgePlatform?.parseDeepLink?.() || {};
    if (!Object.keys(params).length) return false;
    if (params.level && ["L0", "L1", "L2", "L3"].includes(params.level)) state.level = params.level;
    if (params.topic && kb.topics.includes(params.topic)) state.topic = params.topic;
    if (params.vendor && kb.vendors.some((v) => v.id === params.vendor)) state.vendor = params.vendor;
    if (params.article) {
      const art = kb.articles.find((a) => a.id === params.article || a.source_title === params.article);
      if (art) state.article = art.source_title;
    }
    if (params.week) {
      const dIdx = kb.digests.findIndex((d) => d.week_key === params.week);
      if (dIdx >= 0) {
        state.selectedDigestIdx = dIdx;
        state.digestViewMode = "single";
      } else {
        state.week = params.week;
      }
    }
    if (params.diagram && diagramById.has(params.diagram)) {
      switchTab("diagrams", { push: false });
      setTimeout(() => {
        document.getElementById(`card-${params.diagram}`)?.scrollIntoView({ behavior: "smooth", block: "start" });
      }, 80);
      return true;
    }
    if (params.id) {
      let targetTab = params.tab;
      if (!targetTab || !getDrawerItem(targetTab, params.id)) {
        if (questionById.has(params.id)) targetTab = "questions";
        else if (promptById.has(params.id)) targetTab = "prompts";
        else if (pitfallById.has(params.id)) targetTab = "pitfalls";
      }
      if (targetTab && getDrawerItem(targetTab, params.id)) {
        switchTab(params.tab === "all" ? "all" : targetTab, { push: false });
        openDrawer(targetTab, params.id, true);
        return true;
      }
    }
    if (params.tab && VIEW_META[params.tab]) {
      switchTab(params.tab, { push: false });
      return true;
    }
    return false;
  }

  // ==================== Boot ====================

  async function bootApp() {
    initTheme();
    bindGlobalEvents();

    const loaded = await loadKnowledgeBaseData();
    if (!loaded) {
      const area = document.getElementById("contentArea");
      if (area) {
        area.innerHTML = `<div class="empty-state">无法加载知识库数据：请通过本地 HTTP 服务打开本页面（例如 <code>python -m http.server</code>），浏览器安全策略不支持通过 <code>file://</code> 直接读取 JSON 文件。</div>`;
      }
      return;
    }

    ForgeAnalytics.init();
    window.ForgePlatform?.init?.({
      siteUrl: kb.analytics?.site_url,
      repoUrl: kb.analytics?.repo_url,
      showToast,
    });
    window.ForgeInterview?.init?.({
      getQuestionById: (id) => questionById.get(id),
      showToast,
      onStatsChange: () => {
        renderDockMeta();
        renderContent();
        if (state.drawer.open) renderDrawer();
      },
      escapeHtml,
      renderInlineMarkdown,
    });
    window.ForgePrimer?.init?.({
      getKb: () => kb, getActiveTab: () => state.tab, escapeHtml, renderInlineMarkdown,
      showToast, openDrawer, closeDrawer, switchTab, renderContent,
      openStudio: (qid) => window.ForgeInterview?.openStudio?.(qid),
      jumpToLevel: (lv, tab) => { resetAllFilters(); state.level = lv; switchTab(tab || "questions", { push: true }); },
    });
    window.ForgePlatform?.onBackNavigation?.(() => {
      if (window.ForgeInterview?.closeTopModal?.(true)) return;
      if (state.cmd.open) { closeCmdPalette(true); return; }
      if (state.filterPopoverOpen) { setFilterPopoverOpen(false, true); return; }
      if (state.drawer.open) { closeDrawer(true); return; }
      if (document.getElementById("appRail")?.classList.contains("mobile-open")) { closeMobileRail(true); return; }
      if (state.tab === "primer" && window.ForgePrimer?.closeActiveLesson?.(true)) return;
      if (!applyDeepLinkFromHash() && state.tab !== "overview") {
        switchTab("overview", { push: false });
      }
    });
    window.addEventListener("hashchange", () => {
      applyDeepLinkFromHash();
    });
    if (!applyDeepLinkFromHash()) {
      syncNavChrome(state.tab);
      renderRailTrees();
      renderFilterPopoverControls();
      renderContent();
    }
  }

  bootApp();
})();
