/* RAG Web 前端交互。数据只从 api.js 来，DOM 只在这里更新。 */
(function () {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const STORAGE_KEY = "rag-web.currentKb";

  const state = {
    kbs: [],
    docs: [],
    providers: [],
    presets: [],
    currentKbId: readSelection(),
    scope: new Set(),
    results: null,
    kbListError: null,
    activeTab: "docs",
    llm: null,
    chatScope: new Set(),
    chatMessages: [],
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

  function openModal(id, focusId) {
    const el = $(id);
    el.classList.add("is-open");
    el.setAttribute("aria-hidden", "false");
    if (focusId) setTimeout(() => $(focusId) && $(focusId).focus(), 0);
  }
  function closeModal(id) {
    const el = $(id);
    el.classList.remove("is-open");
    el.setAttribute("aria-hidden", "true");
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
      btn.dataset.label = btn.innerHTML;
      btn.disabled = true;
      btn.innerHTML = `${ico("sparkle")}<span>${esc(loadingText || "处理中…")}</span>`;
    } else if (btn.dataset.label) {
      btn.innerHTML = btn.dataset.label;
      delete btn.dataset.label;
      btn.disabled = false;
    }
  }

  /* ---------- 服务状态 ---------- */
  async function loadHealth() {
    const chip = $("healthChip");
    try {
      await api.health();
      chip.className = "health-chip is-ok";
      $("healthText").textContent = "服务正常";
    } catch (err) {
      chip.className = "health-chip is-bad";
      $("healthText").textContent = err.message;
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
    const previousKbId = state.currentKbId;
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
    resetChatScope(previousKbId !== state.currentKbId);
    await loadDocs();
  }
  function selectKb(id) {
    if (state.currentKbId === id) return;
    state.currentKbId = id;
    saveSelection();
    renderKbList();
    renderPageHead();
    resetScope();
    resetChatScope(true);
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
    el.innerHTML = state.kbs.map((kb) => `
      <button class="kb-item ${kb.kb_id === state.currentKbId ? "is-active" : ""}" role="option"
        aria-selected="${kb.kb_id === state.currentKbId}" data-id="${esc(kb.kb_id)}">
        <span class="kb-emoji">${esc(kb.emoji || "📚")}</span>
        <span class="kb-item-main">
          <span class="kb-item-name">${esc(kb.kb_name)}</span>
          <span class="kb-item-meta">${Number(kb.doc_count) || 0} 文档 · ${Number(kb.chunk_count) || 0} 块 · ${esc(kb.embedding_provider_id)}</span>
        </span>
      </button>`).join("");
    el.querySelectorAll(".kb-item").forEach((item) => {
      item.onclick = () => selectKb(item.dataset.id);
    });
  }
  function renderPageHead() {
    const kb = currentKb();
    $("crumbName").textContent = kb ? kb.kb_name : "—";
    $("pageTitle").textContent = kb ? kb.kb_name : "未选择知识库";
    $("pageDesc").textContent = kb ? (kb.description || "暂无描述") : "从左侧选择或新建一个知识库开始";
    $("statDocs").textContent = kb ? Number(kb.doc_count) || 0 : 0;
    $("statChunks").textContent = kb ? Number(kb.chunk_count) || 0 : 0;
    $("statProvider").textContent = kb ? kb.embedding_provider_id : "—";
    $("deleteKbBtn").disabled = !kb;
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
      el.innerHTML = '<div class="empty-state">请选择知识库</div>';
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
    const zone = $("dropZone");
    zone.classList.add("is-over");
    zone.setAttribute("aria-busy", "true");
    let ok = 0;
    const failures = [];
    for (const file of files) {
      try {
        const doc = await api.uploadDocument(state.currentKbId, file);
        ok += 1;
        toast(`已入库「${doc.doc_name}」· ${doc.chunk_count} 块`, "success");
      } catch (err) {
        failures.push(`${file.name}：${err.message}`);
      }
    }
    zone.classList.remove("is-over");
    zone.removeAttribute("aria-busy");
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
        <div class="result-body"></div>
      </div>`).join("");
    // textContent 写入正文，避免任何 HTML 注入
    $("results").querySelectorAll(".result-body").forEach((el, i) => { el.textContent = results[i].content || ""; });
    $("contextText").textContent = data.context_text || "";
    $("contextPanel").hidden = false;
  }
  async function copyContext() {
    const text = $("contextText").textContent;
    try {
      await navigator.clipboard.writeText(text);
      toast("已复制上下文", "success");
    } catch (_) {
      const ta = document.createElement("textarea");
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand("copy");
      ta.remove();
      toast(ok ? "已复制上下文" : "复制失败，请手动选择文本", ok ? "success" : "error");
    }
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
    $("chatProviderHint").textContent = active ? `LLM：${active.name} · ${active.model}` : "未配置 LLM";
    const canChat = Boolean(active && state.currentKbId && state.chatScope.size);
    $("chatSendBtn").disabled = !canChat || state.chatBusy;
    $("chatInput").disabled = !canChat || state.chatBusy;
    $("chatInput").placeholder = active ? "基于所选知识库提问…" : "请先在 LLM 配置中启用模型";
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
  function openLlmModal() {
    closeSidebar();
    openModal("llmModal", "llmPresetSelect");
    loadLlmConfig()
      .then(() => {
        const presets = (state.llm && state.llm.presets) || [];
        $("llmPresetSelect").innerHTML = presets.map((p, i) => `<option value="${i}">${esc(p.name)}</option>`).join("");
        if (presets.length) applyLlmPreset(0);
      })
      .catch((err) => toast(err.message, "error"));
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

  /* ---------- 知识库对话 ---------- */
  function resetChatScope(clearHistory) {
    state.chatScope.clear();
    if (state.currentKbId) state.chatScope.add(state.currentKbId);
    renderChatScope();
    if (clearHistory) {
      state.chatMessages = [];
      renderChat();
    }
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
  function renderChat() {
    const el = $("chatMessages");
    $("clearChatBtn").hidden = state.chatMessages.length === 0;
    if (!state.chatMessages.length) {
      el.innerHTML = `
        <div class="chat-welcome">
          <span class="chat-welcome-icon">${ico("sparkle")}</span>
          <strong>基于知识库内容回答</strong>
          <p>回答只会引用所选知识库中的资料，并标注来源；资料不足时会明确告知。</p>
        </div>`;
      return;
    }
    el.innerHTML = state.chatMessages.map((m) => `
      <div class="chat-msg ${esc(m.role)}${m.error ? " error" : ""}">
        <span class="chat-avatar">${ico(m.role === "user" ? "user" : m.error ? "alert" : "bot")}</span>
        <div class="chat-bubble-main">
          <div class="chat-bubble"></div>
          ${m.sources && m.sources.length ? `<div class="chat-sources">${m.sources.map((s) => `<span class="source-chip">[${Number(s.index) || 0}] ${esc(s.kb_name)} / ${esc(s.doc_name)} · ${formatScore(s.score)}</span>`).join("")}</div>` : ""}
          ${m.provider ? `<div class="chat-meta">模型：${esc(m.provider)}${m.usage && m.usage.total_tokens ? ` · ${m.usage.total_tokens} tokens` : ""}</div>` : ""}
        </div>
      </div>`).join("");
    el.querySelectorAll(".chat-bubble").forEach((node, i) => {
      node.textContent = state.chatMessages[i].content || "";
    });
    el.scrollTop = el.scrollHeight;
  }
  async function sendChat() {
    if (state.chatBusy) return;
    const text = $("chatInput").value.trim();
    if (!text) { toast("请输入问题", "error"); $("chatInput").focus(); return; }
    if (!state.chatScope.size) { toast("请至少选择一个知识库", "error"); return; }
    if (!state.llm || !state.llm.active_id) { toast("请先配置并启用 LLM 模型", "error"); openLlmModal(); return; }

    const kbNames = state.kbs.filter((kb) => state.chatScope.has(kb.kb_id)).map((kb) => kb.kb_name);
    state.chatMessages.push({ role: "user", content: text });
    $("chatInput").value = "";
    state.chatMessages.push({ role: "assistant", content: "正在检索知识库并生成回答…", pending: true });
    renderChat();

    state.chatBusy = true;
    renderLlmStatus();
    setLoading($("chatSendBtn"), true, "回答中…");
    try {
      const history = state.chatMessages
        .filter((m) => !m.pending && !m.error)
        .map((m) => ({ role: m.role, content: m.content }));
      const data = await api.chat(history, kbNames);
      state.chatMessages.pop();
      state.chatMessages.push({
        role: "assistant",
        content: data.answer || "（模型未返回内容）",
        sources: data.sources || [],
        usage: data.usage || {},
        provider: data.provider_id,
      });
      renderChat();
    } catch (err) {
      state.chatMessages.pop();
      state.chatMessages.push({ role: "assistant", content: `生成失败：${err.message}`, error: true });
      renderChat();
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
      renderChat();
      renderLlmStatus();
    }
  }
  function openSidebar() { $("sidebar").classList.add("is-open"); $("sidebarScrim").classList.add("is-open"); }
  function closeSidebar() { $("sidebar").classList.remove("is-open"); $("sidebarScrim").classList.remove("is-open"); }

  /* ---------- 事件绑定 ---------- */
  function bindEvents() {
    document.querySelectorAll("[data-tab]").forEach((btn) => {
      btn.onclick = () => switchTab(btn.dataset.tab);
    });
    $("menuBtn").onclick = openSidebar;
    $("sidebarScrim").onclick = closeSidebar;

    $("manageProvidersBtn").onclick = async () => {
      closeSidebar();
      openModal("providerModal");
      try {
        await Promise.all([loadPresets(), loadProviders()]);
      } catch (err) { toast(err.message, "error"); }
    };
    $("manageLlmBtn").onclick = openLlmModal;
    $("configLlmBtn").onclick = openLlmModal;

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
    $("clearChatBtn").onclick = () => {
      state.chatMessages = [];
      renderChat();
      toast("对话已清空", "success");
    };
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
    $("deleteKbBtn").onclick = async () => {
      const kb = currentKb();
      if (!kb) return;
      const ok = await confirmDialog({ title: "删除整个知识库？", message: `「${kb.kb_name}」的全部文档与向量索引都会被删除，此操作不可撤销。`, okText: "删除知识库" });
      if (!ok) return;
      try {
        await api.deleteKb(kb.kb_id);
        state.currentKbId = null;
        saveSelection();
        toast("知识库已删除", "success");
        await loadKbs();
      } catch (err) { toast(err.message, "error"); }
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
    try {
      await loadProviders();
      await loadKbs();
    } catch (err) { toast(err.message, "error"); }
    try {
      await loadLlmConfig();
    } catch (err) { toast(`LLM 配置加载失败：${err.message}`, "error"); }
  }
  init();
})();
