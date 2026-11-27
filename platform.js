(() => {
  const BOOKMARKS_KEY = "ai_frontier_forge_bookmarks_v1";
  const NOTES_KEY = "ai_frontier_forge_notes_v1";

  let siteBaseUrl = "https://atcxigua.github.io/ai-frontier-forge/";
  let repoBaseUrl = "https://github.com/atcXiGua/ai-frontier-forge";
  let customShareRenderer = null;
  let toastFn = () => {};

  function safeReadJson(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      if (!raw) return fallback;
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === "object" ? parsed : fallback;
    } catch {
      return fallback;
    }
  }

  function safeWriteJson(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {
      // Ignore storage quota errors
    }
  }

  async function writeClipboard(text) {
    try {
      if (navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
        await navigator.clipboard.writeText(text);
        return true;
      }
    } catch {
      // Fallback below
    }
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand("copy");
      ta.remove();
      return Boolean(ok);
    } catch {
      return false;
    }
  }

  function getCanonicalBaseUrl() {
    if (location.protocol === "http:" || location.protocol === "https:") {
      return `${location.origin}${location.pathname}`;
    }
    return siteBaseUrl;
  }

  // ==================== 1. Deep-Link Router ====================

  function buildHash(params) {
    const sp = new URLSearchParams();
    const order = ["tab", "id", "article", "diagram", "week", "level", "topic", "vendor"];
    for (const k of order) {
      const v = params && params[k];
      if (v && v !== "all" && !(k === "tab" && v === "overview" && !params.week && !params.id)) {
        sp.set(k, String(v));
      }
    }
    const qs = sp.toString();
    return qs ? `#${qs}` : "";
  }

  function buildDeepLink(params) {
    const base = getCanonicalBaseUrl().replace(/#.*$/, "");
    return `${base}${buildHash(params || {})}`;
  }

  function parseDeepLink(rawHash) {
    const h = String(rawHash !== undefined ? rawHash : location.hash || "").replace(/^#/, "");
    if (!h) return {};
    const sp = new URLSearchParams(h);
    const out = {};
    for (const [k, v] of sp.entries()) {
      if (v) out[k] = v;
    }
    return out;
  }

  function syncDeepLink(params, options) {
    try {
      const nextHash = buildHash(params || {});
      const curHash = location.hash || "";
      if (nextHash !== curHash) {
        const base = `${location.pathname}${location.search}`;
        const nextUrl = nextHash ? `${base}${nextHash}` : base;
        if (options && options.push) {
          history.pushState({ affNav: true, hash: nextHash }, "", nextUrl);
        } else {
          history.replaceState(history.state, "", nextUrl);
        }
      }
    } catch {
      // Ignore history API restrictions
    }
  }

  // ==================== 1.5 Mobile Back-Gesture / History Layer Guard ====================

  const navLayerStack = [];
  let ignorePopCount = 0;
  let backNavHandler = null;
  let popBound = false;

  function pushNavLayer(name, nextParams) {
    try {
      const base = `${location.pathname}${location.search}`;
      const nextHash = nextParams ? buildHash(nextParams) : location.hash || "";
      const nextUrl = nextHash ? `${base}${nextHash}` : base;
      navLayerStack.push(name);
      history.pushState({ affLayer: name, depth: navLayerStack.length }, "", nextUrl);
    } catch {
      // Ignore history API restrictions
    }
  }

  function popNavLayer(name, fromPopState) {
    const idx = navLayerStack.lastIndexOf(name);
    if (idx < 0) return;
    navLayerStack.splice(idx, 1);
    if (!fromPopState) {
      try {
        if (history.state && history.state.affLayer === name) {
          ignorePopCount += 1;
          history.back();
        }
      } catch {
        // Ignore history API restrictions
      }
    }
  }

  function onBackNavigation(handler) {
    backNavHandler = typeof handler === "function" ? handler : null;
    if (popBound) return;
    popBound = true;
    window.addEventListener("popstate", (e) => {
      if (ignorePopCount > 0) {
        ignorePopCount -= 1;
        return;
      }
      const poppedLayer = navLayerStack.length ? navLayerStack.pop() : null;
      if (backNavHandler) {
        backNavHandler({ poppedLayer, state: e.state || null, hash: location.hash || "" });
      }
    });
  }

  let lockedScrollY = 0;
  let isBodyScrollLocked = false;

  function setBodyScrollLock(locked) {
    const next = Boolean(locked);
    if (next === isBodyScrollLocked) return;
    isBodyScrollLocked = next;
    document.documentElement.classList.toggle("scroll-locked", next);
    document.body.classList.toggle("scroll-locked", next);
    if (next) {
      lockedScrollY = window.scrollY || document.documentElement.scrollTop || 0;
      Object.assign(document.body.style, { position: "fixed", top: `-${lockedScrollY}px`, left: "0", right: "0", width: "100%" });
    } else {
      Object.assign(document.body.style, { position: "", top: "", left: "", right: "", width: "" });
      window.scrollTo({ top: lockedScrollY, behavior: "instant" });
    }
  }

  function bindSwipeLeftClose(el, onClose) {
    if (!el) return;
    let sx = 0, sy = 0, active = false;
    el.addEventListener("touchstart", (e) => {
      if (e.touches.length !== 1) return;
      sx = e.touches[0].clientX;
      sy = e.touches[0].clientY;
      active = true;
    }, { passive: true });
    el.addEventListener("touchend", (e) => {
      if (!active || !e.changedTouches.length) return;
      active = false;
      const dx = e.changedTouches[0].clientX - sx;
      const dy = e.changedTouches[0].clientY - sy;
      if (dx < -68 && Math.abs(dx) > Math.abs(dy) * 1.4) onClose();
    }, { passive: true });
  }

  // ==================== 2. Minimalist One-Click Share ====================

  function buildSharePayload(kind, meta) {
    const m = meta || {};
    if (kind === "site") {
      const url = buildDeepLink({});
      return {
        title: "AI Frontier Forge · 前沿 AI 工程与咨询知识熔炉",
        text: "分享一个纯静态前沿 AI 知识库与模拟面试训练台（Anthropic / Google / OpenAI 一手工程实践 + 交互图解 + 免 Key 模拟面试）：",
        url,
      };
    }
    if (kind === "digest") {
      const url = buildDeepLink({ tab: "overview", week: m.week_key || "" });
      const title = m.headline || `AI Frontier Forge ${m.issue_label || "前沿周报"}`;
      return {
        title,
        text: `【AI Frontier Forge 周报】${title}`,
        url,
      };
    }
    if (kind === "article") {
      const url = buildDeepLink({ tab: "all", article: m.id || m.source_title || "" });
      const title = m.source_title || "精选一手工程文章";
      return {
        title,
        text: `【AI Frontier Forge 原文精读】${title}（共沉淀 ${m.total_assets || ""} 条题库/提示词/避坑资产）`,
        url,
      };
    }
    if (kind === "diagram") {
      const url = buildDeepLink({ tab: "diagrams", diagram: m.id || "" });
      const title = m.title || "交互式架构图解";
      return {
        title,
        text: `【AI Frontier Forge 交互架构图解】${title}`,
        url,
      };
    }
    // Single KB asset (question / prompt / pitfall)
    const tab = m.tab || "questions";
    const url = buildDeepLink({ tab, id: m.id || "" });
    const kindLabel = tab === "prompts" ? "实战提示词" : tab === "pitfalls" ? "生产避坑" : "行业场景题";
    const title = m.title || "前沿 AI 知识条目";
    return {
      title,
      text: `【AI Frontier Forge · ${kindLabel}】${title}`,
      url,
    };
  }

  async function shareResource(kind, meta) {
    const payload = buildSharePayload(kind, meta);
    if (typeof customShareRenderer === "function") {
      return customShareRenderer(payload, kind, meta);
    }
    const shareLine = `${payload.text}\n${payload.url}`;

    // Prefer native share sheet on touch/mobile devices when supported
    const isTouchDevice =
      typeof navigator !== "undefined" &&
      typeof navigator.share === "function" &&
      (navigator.maxTouchPoints > 0 || window.matchMedia?.("(max-width: 768px)")?.matches);

    if (isTouchDevice) {
      try {
        await navigator.share({ title: payload.title, text: payload.text, url: payload.url });
        toastFn("已唤起系统分享面板");
        return { method: "native", url: payload.url };
      } catch (err) {
        if (err && err.name === "AbortError") {
          return { method: "cancelled", url: payload.url };
        }
      }
    }

    const ok = await writeClipboard(shareLine);
    toastFn(ok ? "已复制推荐文案与直达链接，可直接粘贴分享" : "复制失败，请手动复制地址栏链接");
    return { method: ok ? "clipboard" : "failed", url: payload.url };
  }

  function buildAttributedCopy(rawText, meta) {
    const m = meta || {};
    const url = m.id
      ? buildDeepLink({ tab: m.tab || "questions", id: m.id })
      : buildDeepLink({});
    const label = m.title ? `AI Frontier Forge · ${m.title}` : "AI Frontier Forge";
    return `${String(rawText || "").trimEnd()}\n\n---\n来源：${label}\n直达：${url}`;
  }

  // ==================== 3. Thin Swappable Storage & Feedback Adapter ====================
  // Future migration to Cloudflare Workers / REST backend only swaps this adapter object.

  function createLocalAdapter() {
    let bookmarks = safeReadJson(BOOKMARKS_KEY, {});
    let notes = safeReadJson(NOTES_KEY, {});

    return {
      isBookmarked(id) {
        return Boolean(id && bookmarks[id]);
      },
      toggleBookmark(id) {
        if (!id) return false;
        if (bookmarks[id]) {
          delete bookmarks[id];
        } else {
          bookmarks[id] = new Date().toISOString();
        }
        safeWriteJson(BOOKMARKS_KEY, bookmarks);
        return Boolean(bookmarks[id]);
      },
      getBookmarkIds() {
        return Object.keys(bookmarks);
      },
      getBookmarkCount() {
        return Object.keys(bookmarks).length;
      },
      getNote(id) {
        if (!id || !notes[id]) return "";
        return typeof notes[id] === "string" ? notes[id] : String(notes[id].text || "");
      },
      saveNote(id, text) {
        if (!id) return "";
        const clean = String(text || "").trim();
        if (!clean) {
          delete notes[id];
        } else {
          notes[id] = { text: clean, updated_at: new Date().toISOString() };
        }
        safeWriteJson(NOTES_KEY, notes);
        return clean;
      },
      buildFeedbackUrl(payload) {
        const p = payload || {};
        const kind = p.kind || "item";
        const titleText = p.title || "站点体验 / 内容反馈";
        const deepUrl = p.url || buildDeepLink(p.id ? { tab: p.tab || "questions", id: p.id } : {});
        const issueTitle =
          kind === "contribute"
            ? `[内容推荐] ${titleText}`
            : `[反馈/纠错] ${p.id ? `${p.id} · ` : ""}${titleText}`;
        const bodyLines = [
          "### 关联上下文（自动填充）",
          `- **类型**：${kind}`,
          p.id ? `- **条目 ID**：\`${p.id}\`` : null,
          `- **标题**：${titleText}`,
          `- **直达链接**：${deepUrl}`,
          p.source_url ? `- **原始出处**：${p.source_url}` : null,
          "",
          "### 你的建议 / 纠错 / 补充内容",
          "<!-- 请在此填写你的具体意见、勘误说明或补充案例 -->",
        ].filter((x) => x !== null);
        const sp = new URLSearchParams({
          title: issueTitle.slice(0, 120),
          body: bodyLines.join("\n"),
        });
        return `${repoBaseUrl.replace(/\/+$/, "")}/issues/new?${sp.toString()}`;
      },
      submitFeedback(payload) {
        const url = this.buildFeedbackUrl(payload);
        window.open(url, "_blank", "noopener,noreferrer");
        return { mode: "github_issue", url };
      },
    };
  }

  let adapter = createLocalAdapter();

  function init(options) {
    const opts = options || {};
    if (opts.siteUrl) siteBaseUrl = String(opts.siteUrl);
    if (opts.repoUrl) repoBaseUrl = String(opts.repoUrl);
    if (typeof opts.showToast === "function") toastFn = opts.showToast;
    if (opts.adapter && typeof opts.adapter === "object") {
      adapter = Object.assign(createLocalAdapter(), opts.adapter);
    }
  }

  window.ForgePlatform = {
    init,
    buildDeepLink,
    parseDeepLink,
    syncDeepLink,
    pushNavLayer,
    popNavLayer,
    onBackNavigation,
    setBodyScrollLock,
    bindSwipeLeftClose,
    shareResource,
    buildAttributedCopy,
    registerShareRenderer(fn) {
      customShareRenderer = typeof fn === "function" ? fn : null;
    },
    isBookmarked: (id) => adapter.isBookmarked(id),
    toggleBookmark: (id) => adapter.toggleBookmark(id),
    getBookmarkIds: () => adapter.getBookmarkIds(),
    getBookmarkCount: () => adapter.getBookmarkCount(),
    getNote: (id) => adapter.getNote(id),
    saveNote: (id, text) => adapter.saveNote(id, text),
    buildFeedbackUrl: (payload) => adapter.buildFeedbackUrl(payload),
    submitFeedback: (payload) => adapter.submitFeedback(payload),
    setAdapter(custom) {
      if (custom && typeof custom === "object") {
        adapter = Object.assign(adapter, custom);
      }
    },
  };
})();
