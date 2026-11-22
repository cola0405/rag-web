/* RAG Web 前端交互。数据只从 api.js 来，DOM 只在这里更新。 */
(function () {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const STORAGE_KEY = "rag-web.currentKb";
  const CHAT_STORAGE_KEY = "rag-web.chatSessions";
  const ACTIVE_CHAT_KEY = "rag-web.activeChatSession";

  const state = {
    kbs: [],
    docs: [],
    providers: [],
    presets: [],
    currentKbId: readSelection(),
    scope: new Set(),
    results: null,
    kbListError: null,
    activeTab: "chat",
    llm: null,
    chatScope: new Set(),
    chatSessions: readChatSessions(),
    activeChatSessionId: readActiveChatSession(),
    chatBusy: false,
  };

  function readSelection() {
    try { return localStorage.getItem(STORAGE_KEY) || null; } catch (_) { return null; }
  }
  function saveSelection() {
    try {
      if (state.currentKbId) localStorage.setItem(STORAGE_KEY, state.currentKbId);
      else localStorage.removeItem(STORAGE_KEY);
    } catch (_) { /* 隐私模式下忽略 */ }
  }
  function readChatSessions() {
    try {
      const value = JSON.parse(localStorage.getItem(CHAT_STORAGE_KEY) || "[]");
      return Array.isArray(value) ? value.filter((s) => s && s.id && s.kbId && Array.isArray(s.messages)) : [];
    } catch (_) { return []; }
  }
  function readActiveChatSession() {
    try { return localStorage.getItem(ACTIVE_CHAT_KEY) || null; } catch (_) { return null; }
  }
  function saveChatSessions() {
    try {
      localStorage.setItem(CHAT_STORAGE_KEY, JSON.stringify(state.chatSessions.slice(-40)));
      if (state.activeChatSessionId) localStorage.setItem(ACTIVE_CHAT_KEY, state.activeChatSessionId);
      else localStorage.removeItem(ACTIVE_CHAT_KEY);
    } catch (_) { /* 存储不可用或超限时忽略 */ }
  }
  function makeId() {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
  }

  const esc = (value) => String(value == null ? "" : value).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
  const ico = (name, cls) => `<svg class="${cls || "icon"}"><use href="#i-${name}"/></svg>`;
  const currentKb = () => state.kbs.find((kb) => kb.kb_id === state.currentKbId) || null;

  function formatBytes(bytes) {
    const n = Number(bytes) || 0;
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    return `${(n / 1024 / 1024).toFixed(1)} MB`;
  }
  function formatDate(value) {
    if (!value) return "—";
    const d = new Date(value);
    return isNaN(d.getTime()) ? "—" : `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  }
  function formatScore(value) {
    const n = Number(value);
    return Number.isFinite(n) ? n.toFixed(3) : "—";
  }

  /* ---------- 反馈与弹窗 ---------- */
  function toast(message, type) {
    const kind = type === "error" ? "is-error" : type === "success" ? "is-success" : "";
    const symbol = type === "error" ? "alert" : type === "success" ? "check" : "sparkle";
    const el = document.createElement("div");
    el.className = `toast ${kind}`;
    el.innerHTML = `${ico(symbol, "icon")}<span></span>`;
    el.querySelector("span").textContent = message;
    $("toastStack").appendChild(el);
    setTimeout(() => {
      el.style.opacity = "0";
      el.style.transition = "opacity .16s";
      setTimeout(() => el.remove(), 180);
    }, 2800);
  }

  /* ---------- 弹窗 ---------- */
  let lastFocused = null;
  function focusables(root) {
    return Array.from(root.querySelectorAll(
      'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
    )).filter((el) => el.offsetParent !== null);
  }
  function openModal(id, focusId) {
    const el = $(id);
    if (!lastFocused) lastFocused = document.activeElement;
    el.classList.add("is-open");
    el.setAttribute("aria-hidden", "false");
    const target = focusId ? $(focusId) : null;
    setTimeout(() => {
      if (target) target.focus();
      else {
        const items = focusables(el);
        if (items.length) items[0].focus();
      }
    }, 0);
  }
  function closeModal(id) {
    const el = $(id);
    el.classList.remove("is-open");
    el.setAttribute("aria-hidden", "true");
    if (!anyModalOpen()) {
      if (lastFocused && lastFocused.isConnected && lastFocused.focus) lastFocused.focus();
      lastFocused = null;
    }
  }
  function anyModalOpen() {
    return Array.from(document.querySelectorAll(".modal-layer")).some((el) => el.classList.contains("is-open"));
  }

  function confirmDialog({ title, message, okText, danger }) {
    $("confirmTitle").textContent = title || "确认操作";
    $("confirmMessage").textContent = message || "";
    $("confirmOk").textContent = okText || "确认";
    $("confirmOk").className = `btn ${danger === false ? "btn-primary" : "btn-danger"}`;
    openModal("confirmModal", "confirmCancel");
    return new Promise((resolve) => {
      function finish(value) {
        closeModal("confirmModal");
        $("confirmOk").onclick = null;
        $("confirmCancel").onclick = null;
        resolve(value);
      }
      $("confirmOk").onclick = () => finish(true);
      $("confirmCancel").onclick = () => finish(false);
    });
  }

  function setLoading(btn, loading, loadingText) {
    if (!btn) return;
    if (loading) {
      if (!btn.dataset.label) btn.dataset.label = btn.innerHTML;
      btn.disabled = true;
      btn.classList.add("is-loading");
      btn.setAttribute("aria-busy", "true");
      btn.innerHTML = `${ico("spinner", "icon spin")}<span>${esc(loadingText || "处理中…")}</span>`;
    } else if (btn.dataset.label) {
      btn.innerHTML = btn.dataset.label;
      delete btn.dataset.label;
      btn.disabled = false;
      btn.classList.remove("is-loading");
      btn.removeAttribute("aria-busy");
    }
  }

  /* ---------- 服务状态 ---------- */
  async function loadHealth() {
    const chip = $("healthChip");
    try {
      await api.health();
      chip.className = "health-chip is-ok";
      chip.title = "服务正常";
      $("healthText").textContent = "服务正常";
    } catch (err) {
      chip.className = "health-chip is-bad";
      chip.title = err.message || "服务异常";
      $("healthText").textContent = "服务异常";
    }
  }

  /* ---------- Embedding provider ---------- */
  async function loadProviders() {
    state.providers = await api.providers();
    renderProviderOptions();
    renderProviderList();
  }
  function renderProviderOptions() {
    const select = $("kbProvider");
    const selected = select.value;
    select.innerHTML = state.providers.length
      ? state.providers.map((p) => `<option value="${esc(p.id)}">${esc(p.name || p.id)} · ${esc(p.dim)} 维</option>`).join("")
      : '<option value="">暂无可用模型</option>';
    if (state.providers.some((p) => p.id === selected)) select.value = selected;
  }
  function renderProviderList() {
    const el = $("providerList");
    $("providerCount").textContent = state.providers.length;
    if (!state.providers.length) {
      el.innerHTML = '<div class="empty-inline">还没有配置 provider</div>';
      return;
    }
    el.innerHTML = state.providers.map((p) => {
      const meta = `${esc(p.type === "HashEmbeddingProvider" ? "内置" : "OpenAI 兼容")} · ${esc(p.model || "本地哈希")} · ${esc(p.dim)} 维${p.has_key ? " · 已配置 Key" : ""}`;
      const removable = p.source !== "builtin" && p.id !== "local-hash";
      return `<div class="provider-row">
        <span class="provider-name">${esc(p.name || p.id)} <span class="muted mono">${esc(p.id)}</span></span>
        <span class="provider-meta">${meta}</span>
        ${removable ? `<button class="icon-btn" data-remove="${esc(p.id)}" title="删除 provider" aria-label="删除 ${esc(p.id)}">${ico("trash")}</button>` : ""}
      </div>`;
    }).join("");
    el.querySelectorAll("button[data-remove]").forEach((btn) => {
      btn.onclick = async () => {
        const id = btn.dataset.remove;
        const ok = await confirmDialog({ title: "删除 Embedding 模型？", message: `删除「${id}」后无法恢复；已有知识库正在使用它时会被拒绝。`, okText: "删除" });
        if (!ok) return;
        try {
          await api.removeProvider(id);
          toast("已删除 provider", "success");
          await loadProviders();
        } catch (err) { toast(err.message, "error"); }
      };
    });
  }
  async function loadPresets() {
    state.presets = await api.presets();
    $("presetSelect").innerHTML = state.presets.map((p, i) => `<option value="${i}">${esc(p.name)}</option>`).join("");
    if (state.presets.length) applyPreset(0);
  }
  function applyPreset(index) {
    const p = state.presets[index];
    if (!p) return;
    $("pId").value = p.id || "";
    $("pName").value = p.name || "";
    $("pBaseUrl").value = p.base_url || "";
    $("pModel").value = p.model || "";
    $("pDim").value = p.dim || "";
    $("pDimensions").value = p.dimensions == null ? "" : p.dimensions;
    $("presetNote").textContent = p.note || "";
    setTestResult("修改配置后可测试连接", "");
  }
  function providerPayload() {
    const dim = parseInt($("pDim").value, 10);
    const dimsRaw = $("pDimensions").value.trim();
    return {
      id: $("pId").value.trim(),
      name: $("pName").value.trim(),
      base_url: $("pBaseUrl").value.trim(),
      model: $("pModel").value.trim(),
      api_key: $("pKey").value.trim(),
      dim: Number.isFinite(dim) ? dim : 0,
      dimensions: dimsRaw === "" ? null : parseInt(dimsRaw, 10),
    };
  }
  function validateProvider(p) {
    if (!p.id) return "请填写 Provider ID";
    if (p.id === "local-hash") return "local-hash 是内置 provider，不能覆盖";
    if (!p.base_url) return "请填写 Base URL";
    if (!p.model) return "请填写模型名称";
    if (!Number.isInteger(p.dim) || p.dim <= 0) return "请填写正确的向量维度";
    if (p.dimensions != null && (!Number.isInteger(p.dimensions) || p.dimensions <= 0)) return "dimensions 必须是正整数";
    return null;
  }
  async function saveProvider(p) {
    const saved = await api.addProvider(p);
    await loadProviders();
    if ($("kbProvider")) $("kbProvider").value = saved.id;
    return saved;
  }
  function setTestResult(text, kind) {
    const el = $("providerTest");
    el.textContent = text;
    el.className = `test-result${kind ? ` is-${kind}` : ""}`;
  }

  /* ---------- 知识库 ---------- */
  async function loadKbs() {
    try {
      state.kbs = await api.kbs();
      state.kbListError = null;
    } catch (err) {
      state.kbs = [];
      state.kbListError = err.message;
      renderKbList();
      toast(err.message, "error");
      return;
    }
    if (state.currentKbId && !state.kbs.some((kb) => kb.kb_id === state.currentKbId)) state.currentKbId = null;
    if (!state.currentKbId && state.kbs.length) state.currentKbId = state.kbs[0].kb_id;
    saveSelection();
    renderKbList();
    renderPageHead();
    resetScope();
    resetChatScope();
    ensureChatSession();
    await loadDocs();
  }
  function selectKb(id) {
    if (state.currentKbId === id) return;
    state.currentKbId = id;
    saveSelection();
    renderKbList();
    renderPageHead();
    resetScope();
    resetChatScope();
    ensureChatSession();
    loadDocs();
    closeSidebar();
  }
  function renderKbList() {
    const el = $("kbList");
    $("kbCount").textContent = state.kbs.length;
    if (state.kbListError) {
      el.innerHTML = `<div class="empty-inline">加载失败：${esc(state.kbListError)}</div>`;
      return;
    }
    if (!state.kbs.length) {
      el.innerHTML = '<div class="empty-inline">还没有知识库，点击上方按钮创建</div>';
      return;
    }
    el.innerHTML = state.kbs.map((kb) => {
      const active = kb.kb_id === state.currentKbId;
      return `
      <div class="kb-item ${active ? "is-active" : ""}" role="option" tabindex="0"
        aria-selected="${active}" data-id="${esc(kb.kb_id)}">
        <span class="kb-emoji">${ico("layers")}</span>
        <span class="kb-item-main">
          <span class="kb-item-name">${esc(kb.kb_name)}</span>
          <span class="kb-item-meta">${Number(kb.doc_count) || 0} 文档 · ${Number(kb.chunk_count) || 0} 块 · ${esc(kb.embedding_provider_id)}</span>
        </span>
        <span class="kb-actions">
          <button class="icon-btn" data-kb-delete="${esc(kb.kb_id)}" title="删除知识库"
            aria-label="删除知识库「${esc(kb.kb_name)}」">${ico("trash")}</button>
        </span>
      </div>`;
    }).join("");
    el.querySelectorAll(".kb-item").forEach((item) => {
      const open = () => selectKb(item.dataset.id);
      item.onclick = open;
      item.onkeydown = (e) => {
        if (e.target !== item) return;
        if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open(); }
      };
    });
    el.querySelectorAll("button[data-kb-delete]").forEach((btn) => {
      btn.onclick = (e) => { e.stopPropagation(); confirmDeleteKb(btn.dataset.kbDelete); };
    });
  }
  async function confirmDeleteKb(kbId) {
    const kb = state.kbs.find((item) => item.kb_id === kbId);
    if (!kb) return;
    const ok = await confirmDialog({
      title: "删除整个知识库？",
      message: `「${kb.kb_name}」的全部文档与向量索引都会被删除，此操作不可撤销。`,
      okText: "删除知识库",
    });
    if (!ok) return;
    try {
      await api.deleteKb(kb.kb_id);
      if (state.currentKbId === kb.kb_id) state.currentKbId = null;
      saveSelection();
      toast("知识库已删除", "success");
      await loadKbs();
    } catch (err) { toast(err.message, "error"); }
  }
  // 页面头部元信息已移除，这里只同步仍依赖当前知识库的操作状态。
  function renderPageHead() {
    const kb = currentKb();
    const zone = $("dropZone");
    zone.classList.toggle("is-disabled", !kb);
    zone.setAttribute("aria-disabled", String(!kb));
    $("dropHint").textContent = kb ? `将文件入库到「${kb.kb_name}」` : "先选择知识库，再上传文档";
    renderLlmStatus();
  }

  /* ---------- 文档 ---------- */
  async function loadDocs() {
    const kbId = state.currentKbId;
    if (!kbId) {
      state.docs = [];
      renderDocs();
      return;
    }
    try {
      const docs = await api.documents(kbId);
      if (state.currentKbId !== kbId) return; // 期间切换了知识库，丢弃过期响应
      state.docs = docs;
      renderDocs();
    } catch (err) {
      renderDocsError(err.message);
    }
  }
  function renderDocs() {
    const el = $("docList");
    $("docCount").textContent = state.docs.length;
    if (!state.currentKbId) {
      el.innerHTML = `<div class="empty-state">${ico("layers", "empty-icon")}<p>还没有选择知识库</p><span>在左侧选择一个知识库，或先新建一个</span></div>`;
      return;
    }
    if (!state.docs.length) {
      el.innerHTML = `<div class="empty-state">
        <svg class="empty-icon"><use href="#i-file" /></svg><p>还没有文档</p><span>上传文件后即可在这里管理</span>
      </div>`;
      return;
    }
    el.innerHTML = `<div class="doc-table">
      <div class="doc-table-head"><span>文件名</span><span>分块</span><span>大小</span><span>上传时间</span><span></span></div>
      ${state.docs.map((doc) => `
        <div class="doc-row">
          <span class="doc-main">${ico("file")}<span class="doc-name" title="${esc(doc.doc_name)}">${esc(doc.doc_name)}</span></span>
          <span class="doc-cell doc-chunks">${Number(doc.chunk_count) || 0} 块</span>
          <span class="doc-cell doc-size">${formatBytes(doc.file_size)}</span>
          <span class="doc-cell doc-date">${formatDate(doc.created_at)}</span>
          <button class="icon-btn" data-doc="${esc(doc.doc_id)}" title="删除文档" aria-label="删除 ${esc(doc.doc_name)}">${ico("trash")}</button>
        </div>`).join("")}
    </div>`;
    el.querySelectorAll("button[data-doc]").forEach((btn) => {
      btn.onclick = async () => {
        const doc = state.docs.find((d) => d.doc_id === btn.dataset.doc);
        const ok = await confirmDialog({ title: "删除文档？", message: `「${doc ? doc.doc_name : "该文档"}」及其向量索引会被一并删除。`, okText: "删除" });
        if (!ok) return;
        try {
          await api.deleteDocument(state.currentKbId, btn.dataset.doc);
          toast("文档已删除", "success");
          await loadKbs();
        } catch (err) { toast(err.message, "error"); }
      };
    });
  }
  function renderDocsError(message) {
    $("docCount").textContent = "0";
    $("docList").innerHTML = `<div class="empty-state">${ico("alert", "empty-icon")}<p>文档加载失败</p><span>${esc(message)}</span></div>`;
  }
  async function uploadFiles(files) {
    if (!state.currentKbId || !files.length) return;
    const kbId = state.currentKbId;
    const zone = $("dropZone");
    const status = $("uploadStatus");
    const nameEl = status.querySelector(".upload-name");
    const countEl = status.querySelector(".upload-count");
    zone.classList.add("is-busy");
    zone.setAttribute("aria-busy", "true");
    status.hidden = false;
    let ok = 0;
    let index = 0;
    const failures = [];
    for (const file of files) {
      index += 1;
      nameEl.textContent = file.name;
      countEl.textContent = `${index}/${files.length}`;
      try {
        const doc = await api.uploadDocument(kbId, file);
        ok += 1;
        toast(`已入库「${doc.doc_name}」· ${doc.chunk_count} 块`, "success");
      } catch (err) {
        failures.push(`${file.name}：${err.message}`);
      }
    }
    zone.classList.remove("is-busy");
    zone.removeAttribute("aria-busy");
    status.hidden = true;
    nameEl.textContent = "";
    countEl.textContent = "";
    if (failures.length) toast(failures[0] + (failures.length > 1 ? `（另有 ${failures.length - 1} 个失败）` : ""), "error");
    if (ok) await loadKbs();
  }

  /* ---------- 检索 ---------- */
  function resetScope() {
    state.scope.clear();
    if (state.currentKbId) state.scope.add(state.currentKbId);
    renderScopeChips();
  }
  function renderScopeChips() {
    const el = $("scopeChips");
    if (!state.kbs.length) {
      el.innerHTML = '<span class="muted">暂无知识库</span>';
      return;
    }
    el.innerHTML = state.kbs.map((kb) => `
      <label class="chip">
        <input type="checkbox" value="${esc(kb.kb_id)}" ${state.scope.has(kb.kb_id) ? "checked" : ""} />
        <span class="chip-mark">${ico("check")}</span>${esc(kb.kb_name)}
      </label>`).join("");
    el.querySelectorAll("input").forEach((input) => {
      input.onchange = () => {
        if (input.checked) state.scope.add(input.value);
        else state.scope.delete(input.value);
        syncSelectAllLabel();
      };
    });
    syncSelectAllLabel();
  }
  function syncSelectAllLabel() {
    const all = state.kbs.length > 0 && state.scope.size === state.kbs.length;
    $("selectAllKbBtn").textContent = all ? "取消全选" : "全选知识库";
  }
  async function runSearch() {
    const query = $("queryInput").value.trim();
    if (!query) {
      toast("请输入问题或关键词", "error");
      $("queryInput").focus();
      return;
    }
    const names = state.kbs.filter((kb) => state.scope.has(kb.kb_id)).map((kb) => kb.kb_name);
    const btn = $("searchBtn");
    setLoading(btn, true, "检索中…");
    $("results").innerHTML = '<div class="empty-inline">正在检索…</div>';
    $("contextPanel").hidden = true;
    try {
      const data = await api.retrieve(query, names);
      state.results = data;
      renderResults(data);
    } catch (err) {
      state.results = null;
      $("resultCount").textContent = "0";
      $("clearResultsBtn").hidden = true;
      $("results").innerHTML = `<div class="empty-state">${ico("alert", "empty-icon")}<p>检索失败</p><span>${esc(err.message)}</span></div>`;
      toast(err.message, "error");
    } finally {
      setLoading(btn, false);
    }
  }
  function renderResults(data) {
    const results = Array.isArray(data.results) ? data.results : [];
    $("resultCount").textContent = results.length;
    $("clearResultsBtn").hidden = results.length === 0;
    if (!results.length) {
      $("results").innerHTML = `<div class="empty-state">${ico("search", "empty-icon")}<p>没有检索到相关内容</p><span>换个问法或扩大知识库范围试试</span></div>`;
      $("contextPanel").hidden = true;
      return;
    }
    $("results").innerHTML = results.map((r, i) => `
      <div class="result">
        <div class="result-head">
          <span class="result-rank">#${i + 1}</span>
          <span class="result-source"><strong>${esc(r.kb_name)}</strong> / ${esc(r.doc_name)} · 块 ${Number(r.chunk_index) || 0}</span>
          <span class="score">${formatScore(r.score)}</span>
        </div>
        <div class="result-body md"></div>
      </div>`).join("");
    // renderMarkdown 内部先转义 HTML，再解析语法，不会有注入风险
    $("results").querySelectorAll(".result-body").forEach((el, i) => {
      const content = results[i].content || "";
      el.innerHTML = window.renderMarkdown ? window.renderMarkdown(content) : esc(content);
    });
    $("contextText").textContent = data.context_text || "";
    $("contextPanel").hidden = false;
  }
  async function copyText(text, okMessage) {
    try {
      await navigator.clipboard.writeText(text);
      toast(okMessage || "已复制", "success");
      return true;
    } catch (_) {
      const ta = document.createElement("textarea");
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand("copy");
      ta.remove();
      toast(ok ? (okMessage || "已复制") : "复制失败，请手动选择文本", ok ? "success" : "error");
      return ok;
    }
  }
  function copyContext() {
    return copyText($("contextText").textContent, "已复制上下文");
  }

  /* ---------- LLM 配置 ---------- */
  async function loadLlmConfig() {
    state.llm = await api.llmConfig();
    renderLlmProviderList();
    renderLlmSettings();
    renderLlmStatus();
  }
  function renderLlmStatus() {
    const active = state.llm && state.llm.providers.find((p) => p.is_active);
    const hint = $("chatProviderHint");
    if (active) {
      hint.textContent = `LLM：${active.name} · ${active.model}`;
      hint.classList.remove("is-link");
      hint.title = "打开设置";
    } else {
      hint.textContent = "未配置 LLM · 去设置";
      hint.classList.add("is-link");
      hint.title = "打开设置，配置并启用对话模型";
    }
    const canChat = Boolean(active && state.currentKbId && state.chatScope.size);
    $("chatSendBtn").disabled = !canChat || state.chatBusy;
    $("chatInput").disabled = !canChat || state.chatBusy;
    $("chatInput").placeholder = active ? "基于所选知识库提问…" : "请先在设置中启用模型";
  }
  function renderLlmProviderList() {
    const el = $("llmProviderList");
    const providers = (state.llm && state.llm.providers) || [];
    $("llmProviderCount").textContent = providers.length;
    if (!providers.length) {
      el.innerHTML = '<div class="empty-inline">还没有配置 LLM，选一个预设开始</div>';
      return;
    }
    el.innerHTML = providers.map((p) => `
      <div class="provider-row">
        <span class="provider-name">${esc(p.name || p.id)} <span class="muted mono">${esc(p.id)}</span>${p.is_active ? '<span class="active-badge">启用中</span>' : ""}</span>
        <span class="provider-meta">${esc(p.model || "—")}${p.has_key ? " · 已配置 Key" : ""}</span>
        <span class="llm-actions">
          ${p.is_active ? "" : `<button class="text-btn" data-llm-activate="${esc(p.id)}">启用</button>`}
          <button class="text-btn" data-llm-edit="${esc(p.id)}">编辑</button>
          <button class="icon-btn" data-llm-remove="${esc(p.id)}" title="删除模型" aria-label="删除 ${esc(p.id)}">${ico("trash")}</button>
        </span>
      </div>`).join("");
    el.querySelectorAll("button[data-llm-activate]").forEach((btn) => {
      btn.onclick = async () => {
        try {
          await api.activateLlmProvider(btn.dataset.llmActivate);
          await loadLlmConfig();
          toast("已切换对话模型", "success");
        } catch (err) { toast(err.message, "error"); }
      };
    });
    el.querySelectorAll("button[data-llm-edit]").forEach((btn) => {
      btn.onclick = () => {
        const p = providers.find((item) => item.id === btn.dataset.llmEdit);
        if (!p) return;
        $("llmId").value = p.id;
        $("llmName").value = p.name || "";
        $("llmBaseUrl").value = p.base_url || "";
        $("llmModel").value = p.model || "";
        $("llmKey").value = "";
        $("llmClearKey").checked = false;
        $("llmPresetNote").textContent = "编辑已有模型：API Key 留空表示保留原值。";
        setLlmTestResult("修改后可保存或测试连接", "");
      };
    });
    el.querySelectorAll("button[data-llm-remove]").forEach((btn) => {
      btn.onclick = async () => {
        const id = btn.dataset.llmRemove;
        const ok = await confirmDialog({ title: "删除 LLM 模型？", message: `删除「${id}」后无法恢复；若它是当前启用模型，将自动切换或清空启用状态。`, okText: "删除" });
        if (!ok) return;
        try {
          await api.removeLlmProvider(id);
          await loadLlmConfig();
          toast("已删除 LLM 模型", "success");
        } catch (err) { toast(err.message, "error"); }
      };
    });
  }
  function renderLlmSettings() {
    const s = (state.llm && state.llm.settings) || {};
    $("llmTemperature").value = s.temperature == null ? 0.2 : s.temperature;
    $("llmMaxTokens").value = s.max_tokens == null ? 1024 : s.max_tokens;
    $("llmSystemPrompt").value = s.system_prompt || "";
  }
  function switchSettingsTab(tab) {
    const target = tab === "embedding" ? "embedding" : "llm";
    document.querySelectorAll("[data-settings-tab]").forEach((btn) => {
      const active = btn.dataset.settingsTab === target;
      btn.classList.toggle("is-active", active);
      btn.setAttribute("aria-selected", String(active));
    });
    $("pane-llm").hidden = target !== "llm";
    $("pane-embedding").hidden = target !== "embedding";
  }
  const panelLoaded = { llm: false, embedding: false };
  function loadLlmPanel() {
    if (panelLoaded.llm) return Promise.resolve();
    panelLoaded.llm = true;
    return loadLlmConfig()
      .then(() => {
        const presets = (state.llm && state.llm.presets) || [];
        $("llmPresetSelect").innerHTML = presets.map((p, i) => `<option value="${i}">${esc(p.name)}</option>`).join("");
        if (presets.length) applyLlmPreset(0);
      })
      .catch((err) => { panelLoaded.llm = false; toast(err.message, "error"); });
  }
  function loadEmbeddingPanel() {
    if (panelLoaded.embedding) return Promise.resolve();
    panelLoaded.embedding = true;
    return Promise.all([loadPresets(), loadProviders()])
      .catch((err) => { panelLoaded.embedding = false; toast(err.message, "error"); });
  }
  function selectSettingsTab(tab) {
    const target = tab === "embedding" ? "embedding" : "llm";
    switchSettingsTab(target);
    if (target === "llm") loadLlmPanel();
    else loadEmbeddingPanel();
  }
  function openSettings(tab) {
    closeSidebar();
    panelLoaded.llm = false;
    panelLoaded.embedding = false;
    openModal("settingsModal");
    selectSettingsTab(tab);
  }
  function applyLlmPreset(index) {
    const p = state.llm && state.llm.presets && state.llm.presets[index];
    if (!p) return;
    $("llmId").value = p.id || "";
    $("llmName").value = p.name || "";
    $("llmBaseUrl").value = p.base_url || "";
    $("llmModel").value = p.model || "";
    $("llmKey").value = "";
    $("llmClearKey").checked = false;
    $("llmPresetNote").textContent = p.note || "";
    setLlmTestResult("填写配置后可测试连接", "");
  }
  function llmPayload() {
    return {
      id: $("llmId").value.trim(),
      name: $("llmName").value.trim(),
      base_url: $("llmBaseUrl").value.trim(),
      model: $("llmModel").value.trim(),
      api_key: $("llmKey").value.trim(),
      clear_api_key: $("llmClearKey").checked,
    };
  }
  function validateLlmConfig(p) {
    if (!p.id) return "请填写 Provider ID";
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$/.test(p.id)) return "ID 只能用字母、数字、下划线和连字符";
    if (!p.base_url.startsWith("http://") && !p.base_url.startsWith("https://")) return "Base URL 需以 http:// 或 https:// 开头";
    if (!p.model) return "请填写模型名称";
    return null;
  }
  function setLlmTestResult(text, kind) {
    const el = $("llmTestResult");
    el.textContent = text;
    el.className = `test-result${kind ? ` is-${kind}` : ""}`;
  }
  async function saveLlmProvider(p) {
    const saved = await api.addLlmProvider(p);
    await loadLlmConfig();
    return saved;
  }

  /* ---------- 知识库对话与会话管理 ---------- */
  const NEW_SESSION_TITLE = "新会话";

  function activeSession() {
    return state.chatSessions.find((s) => s.id === state.activeChatSessionId) || null;
  }
  function sessionsForKb(kbId) {
    return state.chatSessions
      .filter((s) => s.kbId === kbId)
      .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  }
  function touchSession(session) {
    if (!session) return;
    session.updatedAt = Date.now();
    if (session.title === NEW_SESSION_TITLE) {
      const first = (session.messages || []).find((m) => m.role === "user");
      const text = first ? String(first.content || "") : "";
      if (text) session.title = text.slice(0, 24) + (text.length > 24 ? "…" : "");
    }
    saveChatSessions();
  }
  function createChatSession() {
    if (state.chatBusy) { toast("请等待当前回答完成", "error"); return null; }
    if (!state.currentKbId) { toast("请先选择知识库", "error"); return null; }
    const session = {
      id: makeId(), kbId: state.currentKbId, title: NEW_SESSION_TITLE,
      messages: [], updatedAt: Date.now(),
    };
    state.chatSessions.push(session);
    state.activeChatSessionId = session.id;
    saveChatSessions();
    renderChatSessions();
    renderChat();
    renderLlmStatus();
    return session;
  }
  function ensureChatSession() {
    if (!state.currentKbId) {
      state.activeChatSessionId = null;
      saveChatSessions();
      renderChatSessions();
      renderChat();
      renderLlmStatus();
      return;
    }
    let active = activeSession();
    if (!active || active.kbId !== state.currentKbId) {
      active = sessionsForKb(state.currentKbId)[0] || null;
      if (!active) {
        active = {
          id: makeId(), kbId: state.currentKbId, title: NEW_SESSION_TITLE,
          messages: [], updatedAt: Date.now(),
        };
        state.chatSessions.push(active);
      }
      state.activeChatSessionId = active.id;
      saveChatSessions();
    }
    renderChatSessions();
    renderChat();
    renderLlmStatus();
  }
  function switchChatSession(id) {
    if (state.chatBusy) { toast("请等待当前回答完成", "error"); return; }
    if (id === state.activeChatSessionId) return;
    state.activeChatSessionId = id;
    saveChatSessions();
    renderChatSessions();
    renderChat();
    renderLlmStatus();
  }
  function formatSessionTime(ts) {
    const d = new Date(ts || Date.now());
    if (isNaN(d.getTime())) return "刚刚";
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const yesterday = new Date(today); yesterday.setDate(yesterday.getDate() - 1);
    const time = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
    if (d >= today) return `今天 ${time}`;
    if (d >= yesterday) return `昨天 ${time}`;
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  }
  function renameChatSession(id) {
    const session = state.chatSessions.find((s) => s.id === id);
    if (!session) return Promise.resolve(null);
    $("sessionTitleInput").value = session.title || "";
    openModal("sessionModal", "sessionTitleInput");
    return new Promise((resolve) => {
      function finish(value) {
        closeModal("sessionModal");
        $("sessionSave").onclick = null;
        $("sessionCancel").onclick = null;
        $("sessionTitleInput").onkeydown = null;
        resolve(value);
      }
      $("sessionSave").onclick = () => {
        const value = $("sessionTitleInput").value.trim();
        if (!value) return toast("请输入会话名称", "error");
        finish(value);
      };
      $("sessionCancel").onclick = () => finish(null);
      $("sessionTitleInput").onkeydown = (e) => {
        if (e.key === "Enter") { e.preventDefault(); $("sessionSave").click(); }
      };
    });
  }
  async function deleteChatSession(id) {
    if (state.chatBusy) { toast("请等待当前回答完成", "error"); return; }
    const session = state.chatSessions.find((s) => s.id === id);
    if (!session) return;
    const ok = await confirmDialog({
      title: "删除会话？",
      message: `「${session.title}」及其消息会从本机删除，此操作不可撤销。`,
      okText: "删除",
    });
    if (!ok) return;
    state.chatSessions = state.chatSessions.filter((s) => s.id !== id);
    if (state.activeChatSessionId === id) state.activeChatSessionId = null;
    saveChatSessions();
    ensureChatSession();
    toast("会话已删除", "success");
  }
  function renderChatSessions() {
    const el = $("chatSessionList");
    if (!state.currentKbId) {
      el.innerHTML = '<div class="empty-inline">请选择知识库</div>';
      return;
    }
    const sessions = sessionsForKb(state.currentKbId);
    if (!sessions.length) {
      el.innerHTML = '<div class="empty-inline">还没有会话，点击上方 + 新建</div>';
      return;
    }
    el.innerHTML = sessions.map((s) => {
      const last = [...(s.messages || [])].reverse().find((m) => !m.pending && !m.error);
      const preview = last ? stripMd(last.content).slice(0, 26) : "暂无消息";
      const isActive = s.id === state.activeChatSessionId;
      return `<div class="session-item ${isActive ? "is-active" : ""}" data-session="${esc(s.id)}">
        <button class="session-open" title="${esc(s.title)}">
          <span class="session-title">${esc(s.title)}</span>
          <span class="session-meta">${formatSessionTime(s.updatedAt)} · ${esc(preview)}</span>
        </button>
        <span class="session-actions">
          <button class="icon-btn" data-rename="${esc(s.id)}" title="重命名会话" aria-label="重命名 ${esc(s.title)}">${ico("edit")}</button>
          <button class="icon-btn" data-delete="${esc(s.id)}" title="删除会话" aria-label="删除 ${esc(s.title)}">${ico("trash")}</button>
        </span>
      </div>`;
    }).join("");
    el.querySelectorAll(".session-open").forEach((btn) => {
      btn.onclick = () => switchChatSession(btn.closest(".session-item").dataset.session);
    });
    el.querySelectorAll("button[data-rename]").forEach((btn) => {
      btn.onclick = async () => {
        const title = await renameChatSession(btn.dataset.rename);
        if (!title) return;
        const session = state.chatSessions.find((s) => s.id === btn.dataset.rename);
        if (session) session.title = title;
        saveChatSessions();
        renderChatSessions();
        toast("会话已重命名", "success");
      };
    });
    el.querySelectorAll("button[data-delete]").forEach((btn) => {
      btn.onclick = () => deleteChatSession(btn.dataset.delete);
    });
  }
  function resetChatScope() {
    state.chatScope.clear();
    if (state.currentKbId) state.chatScope.add(state.currentKbId);
    renderChatScope();
    renderLlmStatus();
  }
  function renderChatScope() {
    const el = $("chatScopeChips");
    if (!state.kbs.length) {
      el.innerHTML = '<span class="muted">暂无知识库</span>';
      return;
    }
    el.innerHTML = state.kbs.map((kb) => `
      <label class="chip">
        <input type="checkbox" value="${esc(kb.kb_id)}" ${state.chatScope.has(kb.kb_id) ? "checked" : ""} />
        <span class="chip-mark">${ico("check")}</span>${esc(kb.kb_name)}
      </label>`).join("");
    el.querySelectorAll("input").forEach((input) => {
      input.onchange = () => {
        if (input.checked) state.chatScope.add(input.value);
        else state.chatScope.delete(input.value);
        renderLlmStatus();
      };
    });
  }

  let sourcePopoverTimer = null;
  function hideSourcePopover(delay) {
    clearTimeout(sourcePopoverTimer);
    sourcePopoverTimer = setTimeout(() => {
      const pop = $("sourcePopover");
      if (pop) pop.remove();
    }, delay || 0);
  }
  function showSourcePopover(anchor, source) {
    if (!source) return;
    clearTimeout(sourcePopoverTimer);
    let pop = $("sourcePopover");
    if (!pop) {
      pop = document.createElement("div");
      pop.id = "sourcePopover";
      pop.className = "source-popover";
      pop.onmouseenter = () => clearTimeout(sourcePopoverTimer);
      pop.onmouseleave = () => hideSourcePopover(0);
      document.body.appendChild(pop);
    }
    const index = Number(source.index) || 0;
    pop.innerHTML = `
      <div class="source-popover-head">
        <strong>[${index}]</strong><span>${esc(source.kb_name)} / ${esc(source.doc_name)}</span><span>块 ${Number(source.chunk_index) || 0}</span>
      </div>
      <div class="source-popover-body md"></div>`;
    const body = pop.querySelector(".source-popover-body");
    const content = source.content || "";
    if (content && window.renderMarkdown) body.innerHTML = window.renderMarkdown(content);
    else body.textContent = content || "（该分块没有正文）";
    const rect = anchor.getBoundingClientRect();
    pop.style.visibility = "hidden";
    pop.style.left = "0px";
    pop.style.top = "0px";
    const width = pop.offsetWidth || 360;
    const height = pop.offsetHeight || 200;
    const left = Math.max(12, Math.min(rect.left, window.innerWidth - width - 12));
    let top = rect.bottom + 8;
    if (top + height > window.innerHeight - 12) top = Math.max(12, rect.top - height - 8);
    pop.style.left = `${left}px`;
    pop.style.top = `${top}px`;
    pop.style.visibility = "visible";
  }

  /* 会话列表预览：去掉 Markdown 标记，避免出现 ## / ** 这类原文 */
  function stripMd(text) {
    return String(text || "")
      .replace(/```[\s\S]*?```/g, " ")
      .replace(/`([^`]*)`/g, "$1")
      .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(/^\s{0,3}(#{1,6}|>|[-*+]|\d+[.)])\s+/gm, "")
      .replace(/[*_~]{1,3}/g, "")
      .replace(/\s+/g, " ")
      .trim();
  }

  /* 来源按文档聚合：[1][2] note.md，不再每条重复知识库与文档名 */
  function groupSources(sources) {
    const groups = new Map();
    (sources || []).forEach((s) => {
      const key = `${s.kb_name}||${s.doc_name}`;
      if (!groups.has(key)) groups.set(key, { kb_name: s.kb_name, doc_name: s.doc_name, items: [] });
      groups.get(key).items.push(s);
    });
    return Array.from(groups.values());
  }
  function renderSourceGroups(sources) {
    const groups = groupSources(sources);
    if (!groups.length) return "";
    return `<div class="chat-sources">${groups.map((g) => `
      <span class="source-group" title="${esc(g.kb_name)} / ${esc(g.doc_name)}">
        ${g.items.map((s) => `<button type="button" class="source-chip" data-source-index="${Number(s.index) || 0}"
          title="${esc(g.kb_name)} / ${esc(g.doc_name)} · 块 ${Number(s.chunk_index) || 0}">${Number(s.index) || 0}</button>`).join("")}
        <span class="source-doc">${esc(g.doc_name)}</span>
      </span>`).join("")}</div>`;
  }

  /* 把正文里的 [1] 变成可点的角标：点一下定位到对应来源 */
  function decorateCitations(root) {
    if (!root) return;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        if (!/\[\d{1,2}\]/.test(node.nodeValue)) return NodeFilter.FILTER_REJECT;
        const parent = node.parentElement;
        if (!parent || parent.closest("code, pre, a")) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    const nodes = [];
    let node = walker.nextNode();
    while (node) { nodes.push(node); node = walker.nextNode(); }
    nodes.forEach((textNode) => {
      const frag = document.createDocumentFragment();
      const re = /\[(\d{1,2})\]/g;
      let last = 0;
      let match = re.exec(textNode.nodeValue);
      while (match) {
        if (match.index > last) frag.appendChild(document.createTextNode(textNode.nodeValue.slice(last, match.index)));
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "cite";
        btn.dataset.cite = match[1];
        btn.textContent = match[1];
        btn.title = `查看来源 ${match[1]}`;
        frag.appendChild(btn);
        last = match.index + match[0].length;
        match = re.exec(textNode.nodeValue);
      }
      if (last < textNode.nodeValue.length) frag.appendChild(document.createTextNode(textNode.nodeValue.slice(last)));
      textNode.parentNode.replaceChild(frag, textNode);
    });
  }

  function renderChat() {
    const el = $("chatMessages");
    const messages = activeSession() ? activeSession().messages || [] : [];
    $("clearChatBtn").hidden = messages.length === 0;
    if (!messages.length) {
      el.innerHTML = `
        <div class="chat-welcome">
          <span class="chat-welcome-icon">${ico("sparkle")}</span>
          <strong>基于知识库内容回答</strong>
          <p>回答只会引用所选知识库中的资料，点引用角标可查看原文；资料不足时会明确告知。</p>
        </div>`;
      return;
    }
    el.innerHTML = messages.map((m) => `
      <div class="chat-msg ${esc(m.role)}${m.error ? " error" : ""}${m.pending ? " pending" : ""}">
        <span class="chat-avatar">${ico(m.role === "user" ? "user" : m.error ? "alert" : "bot")}</span>
        <div class="chat-bubble-main">
          <div class="chat-bubble md"></div>
          ${renderSourceGroups(m.sources)}
          ${m.provider ? `<div class="chat-meta">模型：${esc(m.provider)}${m.usage && m.usage.total_tokens ? ` · ${m.usage.total_tokens} tokens` : ""}</div>` : ""}
          ${m.role === "assistant" && !m.pending && !m.error && m.content
            ? `<div class="msg-actions"><button class="icon-btn" data-copy-msg title="复制回答" aria-label="复制回答">${ico("copy", "icon icon-sm")}</button></div>`
            : ""}
        </div>
      </div>`).join("");
    el.querySelectorAll(".chat-msg").forEach((msgEl, i) => {
      const message = messages[i];
      const bubble = msgEl.querySelector(".chat-bubble");
      if (bubble) {
        if (message.pending) {
          bubble.innerHTML = '<span class="typing"><i></i><i></i><i></i></span><span class="sr-only">正在生成回答</span>';
        } else if (message.role === "assistant" && !message.error && message.content) {
          bubble.innerHTML = window.renderMarkdown
            ? window.renderMarkdown(message.content)
            : esc(message.content);
          decorateCitations(bubble);
        } else {
          bubble.textContent = message.content || "";
        }
      }
      msgEl.querySelectorAll(".source-chip").forEach((chip) => {
        const source = (message.sources || []).find((s) => String(s.index) === chip.dataset.sourceIndex);
        chip.onmouseenter = () => showSourcePopover(chip, source);
        chip.onmouseleave = () => hideSourcePopover(120);
        chip.onfocus = () => showSourcePopover(chip, source);
        chip.onblur = () => hideSourcePopover(120);
        chip.onclick = (e) => { e.stopPropagation(); showSourcePopover(chip, source); };
      });
      msgEl.querySelectorAll(".cite").forEach((cite) => {
        cite.onclick = (e) => {
          e.stopPropagation();
          const chip = msgEl.querySelector(`.source-chip[data-source-index="${cite.dataset.cite}"]`);
          if (!chip) return;
          msgEl.querySelectorAll(".is-target").forEach((n) => n.classList.remove("is-target"));
          cite.classList.add("is-target");
          chip.classList.add("is-target");
          const source = (message.sources || []).find((s) => String(s.index) === cite.dataset.cite);
          showSourcePopover(chip, source);
          setTimeout(() => cite.classList.remove("is-target"), 2400);
          setTimeout(() => chip.classList.remove("is-target"), 2400);
        };
      });
      const copyBtn = msgEl.querySelector("[data-copy-msg]");
      if (copyBtn) copyBtn.onclick = () => copyText(message.content);
    });
    el.scrollTop = el.scrollHeight;
  }
  async function sendChat() {
    if (state.chatBusy) return;
    const text = $("chatInput").value.trim();
    if (!text) { toast("请输入问题", "error"); $("chatInput").focus(); return; }
    if (!state.chatScope.size) { toast("请至少选择一个知识库", "error"); return; }
    if (!state.llm || !state.llm.active_id) { toast("请先配置并启用 LLM 模型", "error"); openSettings("llm"); return; }

    const session = activeSession() || createChatSession();
    if (!session) return;
    const kbNames = state.kbs.filter((kb) => state.chatScope.has(kb.kb_id)).map((kb) => kb.kb_name);
    session.messages.push({ role: "user", content: text });
    touchSession(session);
    $("chatInput").value = "";
    session.messages.push({ role: "assistant", content: "正在检索知识库并生成回答…", pending: true });
    renderChat();
    renderChatSessions();

    state.chatBusy = true;
    renderLlmStatus();
    setLoading($("chatSendBtn"), true, "回答中…");
    try {
      const history = session.messages
        .filter((m) => !m.pending && !m.error)
        .map((m) => ({ role: m.role, content: m.content }));
      const data = await api.chat(history, kbNames);
      session.messages.pop();
      session.messages.push({
        role: "assistant",
        content: data.answer || "（模型未返回内容）",
        sources: data.sources || [],
        usage: data.usage || {},
        provider: data.provider_id,
      });
      touchSession(session);
      renderChat();
      renderChatSessions();
    } catch (err) {
      session.messages.pop();
      session.messages.push({ role: "assistant", content: `生成失败：${err.message}`, error: true });
      touchSession(session);
      renderChat();
      renderChatSessions();
      toast(err.message, "error");
    } finally {
      state.chatBusy = false;
      setLoading($("chatSendBtn"), false);
      renderLlmStatus();
    }
  }

  /* ---------- 视图切换与侧边栏 ---------- */
  function switchTab(tab) {
    state.activeTab = tab;
    document.querySelectorAll(".tab").forEach((btn) => {
      const active = btn.dataset.tab === tab;
      btn.classList.toggle("is-active", active);
      btn.setAttribute("aria-selected", String(active));
    });
    $("view-docs").hidden = tab !== "docs";
    $("view-search").hidden = tab !== "search";
    $("view-chat").hidden = tab !== "chat";
    if (tab === "chat") {
      renderChatScope();
      ensureChatSession();
    }
  }
  function openSidebar() { $("sidebar").classList.add("is-open"); $("sidebarScrim").classList.add("is-open"); }
  function closeSidebar() { $("sidebar").classList.remove("is-open"); $("sidebarScrim").classList.remove("is-open"); }

  /* ---------- 事件绑定 ---------- */
  function bindEvents() {
    const tabs = Array.from(document.querySelectorAll("[data-tab]"));
    tabs.forEach((btn, index) => {
      btn.onclick = () => switchTab(btn.dataset.tab);
      btn.onkeydown = (e) => {
        if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
        e.preventDefault();
        const offset = e.key === "ArrowRight" ? 1 : tabs.length - 1;
        const next = tabs[(index + offset) % tabs.length];
        switchTab(next.dataset.tab);
        next.focus();
      };
    });
    const settingsTabs = Array.from(document.querySelectorAll("[data-settings-tab]"));
    settingsTabs.forEach((btn, index) => {
      btn.onkeydown = (e) => {
        if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
        e.preventDefault();
        const offset = e.key === "ArrowRight" ? 1 : settingsTabs.length - 1;
        const next = settingsTabs[(index + offset) % settingsTabs.length];
        selectSettingsTab(next.dataset.settingsTab);
        next.focus();
      };
    });
    $("menuBtn").onclick = openSidebar;
    $("sidebarScrim").onclick = closeSidebar;

    $("settingsBtn").onclick = () => openSettings("llm");
    $("chatProviderHint").onclick = () => openSettings("llm");
    document.querySelectorAll("[data-settings-tab]").forEach((btn) => {
      btn.onclick = () => selectSettingsTab(btn.dataset.settingsTab);
    });
    document.querySelectorAll("[data-reveal]").forEach((btn) => {
      btn.onclick = () => {
        const input = $(btn.dataset.reveal);
        if (!input) return;
        const show = input.type === "password";
        input.type = show ? "text" : "password";
        btn.innerHTML = ico(show ? "eye-off" : "eye");
        btn.setAttribute("aria-label", show ? "隐藏 API Key" : "显示 API Key");
      };
    });

    $("llmPresetSelect").onchange = (e) => applyLlmPreset(Number(e.target.value));
    $("saveLlmBtn").onclick = async () => {
      const p = llmPayload();
      const invalid = validateLlmConfig(p);
      if (invalid) return setLlmTestResult(invalid, "bad");
      try {
        const saved = await saveLlmProvider(p);
        setLlmTestResult(`已保存「${saved.id}」${saved.is_active ? "，当前已启用" : ""}`, "ok");
        toast("LLM 模型已保存", "success");
      } catch (err) { setLlmTestResult(err.message, "bad"); }
    };
    $("testLlmBtn").onclick = async () => {
      const p = llmPayload();
      const invalid = validateLlmConfig(p);
      if (invalid) return setLlmTestResult(invalid, "bad");
      const btn = $("testLlmBtn");
      setLoading(btn, true, "测试中…");
      setLlmTestResult("正在保存并测试连接…", "");
      try {
        const saved = await saveLlmProvider(p);
        const result = await api.testLlmProvider(saved.id);
        const reply = String(result.reply || "").trim();
        if (reply) {
          setLlmTestResult(`连接成功，模型回复：${reply.slice(0, 80)}`, "ok");
          toast("LLM 连接测试通过", "success");
        } else {
          setLlmTestResult("连接成功，但模型没有返回文本", "bad");
          toast("模型返回为空", "error");
        }
      } catch (err) {
        setLlmTestResult(`测试失败：${err.message}`, "bad");
        toast(err.message, "error");
      } finally { setLoading(btn, false); }
    };
    $("resetLlmSystemBtn").onclick = () => {
      $("llmSystemPrompt").value = "你是知识库问答助手。只依据提供的知识库片段回答问题；如果片段不足以回答，明确说明当前知识库没有相关信息，不要编造。回答简洁、条理清晰，并在使用到某条资料时用 [编号] 标注来源。";
    };
    $("saveLlmSettingsBtn").onclick = async () => {
      const temperature = Number($("llmTemperature").value);
      const maxTokens = Number($("llmMaxTokens").value);
      if (!Number.isFinite(temperature) || temperature < 0 || temperature > 2) return toast("温度需在 0 ~ 2 之间", "error");
      if (!Number.isInteger(maxTokens) || maxTokens < 1 || maxTokens > 8192) return toast("最大 tokens 需在 1 ~ 8192 之间", "error");
      try {
        await api.updateLlmSettings({
          temperature,
          max_tokens: maxTokens,
          system_prompt: $("llmSystemPrompt").value,
        });
        await loadLlmConfig();
        toast("生成参数已保存", "success");
      } catch (err) { toast(err.message, "error"); }
    };

    $("chatSendBtn").onclick = sendChat;
    $("chatInput").onkeydown = (e) => {
      if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendChat(); }
    };
    $("newChatSessionBtn").onclick = () => createChatSession();
    $("clearChatBtn").onclick = () => {
      if (state.chatBusy) { toast("请等待当前回答完成", "error"); return; }
      const session = activeSession();
      if (!session) return;
      session.messages = [];
      touchSession(session);
      renderChat();
      renderChatSessions();
      toast("当前会话已清空", "success");
    };
    document.addEventListener("click", (e) => {
      const target = e.target instanceof Element ? e.target : null;
      if (!target || (!target.closest(".source-chip") && !target.closest("#sourcePopover"))) hideSourcePopover(0);
    });
    document.querySelectorAll("[data-close]").forEach((btn) => {
      btn.onclick = () => closeModal(btn.dataset.close);
    });
    document.querySelectorAll(".modal-layer").forEach((layer) => {
      layer.onclick = (e) => { if (e.target === layer) closeModal(layer.id); };
    });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        if (anyModalOpen()) {
          document.querySelectorAll(".modal-layer.is-open").forEach((el) => closeModal(el.id));
        } else closeSidebar();
        return;
      }
      if (e.key === "Tab") {
        const layer = document.querySelector(".modal-layer.is-open");
        if (!layer) return;
        const items = focusables(layer);
        if (!items.length) return;
        const first = items[0];
        const last = items[items.length - 1];
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
      }
    });

    $("createKbBtn").onclick = () => {
      closeSidebar();
      $("kbName").value = "";
      $("kbDesc").value = "";
      $("kbNameError").textContent = "";
      $("kbName").parentElement.classList.remove("has-error");
      $("kbChunkSize").value = "512";
      $("kbChunkOverlap").value = "50";
      renderProviderOptions();
      openModal("kbModal", "kbName");
    };
    $("submitKbBtn").onclick = async () => {
      const name = $("kbName").value.trim();
      const nameField = $("kbName").parentElement;
      if (!name) {
        $("kbNameError").textContent = "请输入知识库名称";
        nameField.classList.add("has-error");
        $("kbName").focus();
        return;
      }
      if (state.kbs.some((kb) => kb.kb_name === name)) {
        $("kbNameError").textContent = "同名知识库已存在";
        nameField.classList.add("has-error");
        return;
      }
      nameField.classList.remove("has-error");
      const chunkSize = parseInt($("kbChunkSize").value, 10);
      const overlap = parseInt($("kbChunkOverlap").value, 10);
      if (!Number.isInteger(chunkSize) || chunkSize < 64 || !Number.isInteger(overlap) || overlap < 0 || overlap >= chunkSize) {
        toast("分块大小需 ≥64，且重叠字符数要小于分块大小", "error");
        return;
      }
      const btn = $("submitKbBtn");
      setLoading(btn, true, "创建中…");
      try {
        const kb = await api.createKb({
          kb_name: name,
          description: $("kbDesc").value.trim(),
          embedding_provider_id: $("kbProvider").value,
          chunk_size: chunkSize,
          chunk_overlap: overlap,
        });
        closeModal("kbModal");
        state.currentKbId = kb.kb_id;
        saveSelection();
        toast(`已创建「${kb.kb_name}」`, "success");
        await loadKbs();
        switchTab("docs");
      } catch (err) { toast(err.message, "error"); }
      finally { setLoading(btn, false); }
    };
    $("kbName").oninput = () => {
      $("kbNameError").textContent = "";
      $("kbName").parentElement.classList.remove("has-error");
    };
    $("kbName").onkeydown = (e) => {
      if (e.key === "Enter") { e.preventDefault(); $("submitKbBtn").click(); }
    };

    $("refreshDocsBtn").onclick = () => loadDocs().catch((err) => toast(err.message, "error"));

    const zone = $("dropZone");
    let dragDepth = 0;
    zone.onclick = () => { if (state.currentKbId) $("fileInput").click(); };
    zone.onkeydown = (e) => {
      if ((e.key === "Enter" || e.key === " ") && state.currentKbId) { e.preventDefault(); $("fileInput").click(); }
    };
    zone.ondragenter = (e) => { e.preventDefault(); dragDepth += 1; zone.classList.add("is-over"); };
    zone.ondragover = (e) => e.preventDefault();
    zone.ondragleave = () => { dragDepth -= 1; if (dragDepth <= 0) { dragDepth = 0; zone.classList.remove("is-over"); } };
    zone.ondrop = (e) => {
      e.preventDefault();
      dragDepth = 0;
      zone.classList.remove("is-over");
      uploadFiles(Array.from(e.dataTransfer.files));
    };
    $("fileInput").onchange = (e) => {
      uploadFiles(Array.from(e.target.files));
      e.target.value = "";
    };

    $("presetSelect").onchange = (e) => applyPreset(Number(e.target.value));
    $("saveProviderBtn").onclick = async () => {
      const p = providerPayload();
      const invalid = validateProvider(p);
      if (invalid) return setTestResult(invalid, "bad");
      try {
        const saved = await saveProvider(p);
        setTestResult(`已保存「${saved.id}」`, "ok");
        toast("Provider 已保存", "success");
      } catch (err) { setTestResult(err.message, "bad"); }
    };
    $("testProviderBtn").onclick = async () => {
      const p = providerPayload();
      const invalid = validateProvider(p);
      if (invalid) return setTestResult(invalid, "bad");
      const btn = $("testProviderBtn");
      setLoading(btn, true, "测试中…");
      setTestResult("正在保存并测试连接…", "");
      try {
        const saved = await saveProvider(p);
        const result = await api.testProvider(saved.id);
        if (result.match) {
          setTestResult(`连接成功：返回 ${result.actual_dim} 维，与配置一致。`, "ok");
          toast("Embedding 连接测试通过", "success");
        } else {
          setTestResult(`连接成功但维度不一致：返回 ${result.actual_dim} 维，配置为 ${result.expected_dim} 维。`, "bad");
          toast("维度不匹配", "error");
        }
      } catch (err) {
        setTestResult(`测试失败：${err.message}`, "bad");
        toast(err.message, "error");
      } finally { setLoading(btn, false); }
    };

    $("selectAllKbBtn").onclick = () => {
      if (state.scope.size === state.kbs.length) state.scope.clear();
      else state.kbs.forEach((kb) => state.scope.add(kb.kb_id));
      renderScopeChips();
    };
    $("searchBtn").onclick = runSearch;
    $("queryInput").onkeydown = (e) => {
      if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); runSearch(); }
    };
    $("clearResultsBtn").onclick = () => {
      state.results = null;
      $("queryInput").value = "";
      $("resultCount").textContent = "0";
      $("clearResultsBtn").hidden = true;
      $("contextPanel").hidden = true;
      $("results").innerHTML = `<div class="empty-state">${ico("sparkle", "empty-icon")}<p>输入问题开始检索</p><span>结果会按相关度从高到低排列</span></div>`;
    };
    $("copyContextBtn").onclick = copyContext;
  }

  /* ---------- 启动 ---------- */
  async function init() {
    bindEvents();
    await loadHealth();
    setInterval(loadHealth, 30000);
    try {
      await loadProviders();
      await loadKbs();
    } catch (err) { toast(err.message, "error"); }
    try {
      await loadLlmConfig();
    } catch (err) { toast(`LLM 配置加载失败：${err.message}`, "error"); }
    ensureChatSession();
  }
  init();
})();
