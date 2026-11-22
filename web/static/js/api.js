/* 后端接口封装：统一错误处理，业务代码只处理成功数据。 */
(function (global) {
  "use strict";

  async function request(path, options) {
    let res;
    try {
      res = await fetch(path, options);
    } catch (err) {
      throw new Error("无法连接到服务，请确认后端已启动");
    }
    let data = null;
    try {
      data = await res.json();
    } catch (_) {
      data = null;
    }
    if (!res.ok) {
      const detail = data && data.detail;
      throw new Error(typeof detail === "string" ? detail : `请求失败（${res.status}）`);
    }
    return data;
  }

  function jsonBody(payload) {
    return {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    };
  }

  global.api = {
    health: () => request("/api/health"),
    presets: () => request("/api/embedding-presets"),
    providers: () => request("/api/providers"),
    addProvider: (payload) => request("/api/providers", jsonBody(payload)),
    testProvider: (id) => request(`/api/providers/${encodeURIComponent(id)}/test`, { method: "POST" }),
    removeProvider: (id) => request(`/api/providers/${encodeURIComponent(id)}`, { method: "DELETE" }),
    kbs: () => request("/api/kbs"),
    createKb: (payload) => request("/api/kbs", jsonBody(payload)),
    deleteKb: (id) => request(`/api/kbs/${encodeURIComponent(id)}`, { method: "DELETE" }),
    documents: (kbId) => request(`/api/kbs/${encodeURIComponent(kbId)}/documents`),
    uploadDocument: (kbId, file) => {
      const form = new FormData();
      form.append("file", file);
      return request(`/api/kbs/${encodeURIComponent(kbId)}/documents`, { method: "POST", body: form });
    },
    deleteDocument: (kbId, docId) =>
      request(`/api/kbs/${encodeURIComponent(kbId)}/documents/${encodeURIComponent(docId)}`, { method: "DELETE" }),
    retrieve: (query, kbNames) => request("/api/retrieve", jsonBody({ query, kb_names: kbNames })),
  };
})(window);
