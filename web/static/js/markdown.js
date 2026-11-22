/* 轻量 Markdown 渲染：先转义 HTML，再解析常见语法，避免模型输出注入页面。
   支持的块级：标题、列表、引用、代码块、表格、分隔线、段落；
   支持的行内：粗体、斜体、删除线、行内代码、链接。 */
(function (global) {
  "use strict";

  function escapeHtml(value) {
    return String(value == null ? "" : value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function safeUrl(url) {
    const raw = String(url || "").trim();
    if (/^(https?:\/\/|mailto:|\/|#)/i.test(raw)) return raw;
    return "";
  }

  function inline(text) {
    const codes = [];
    let value = String(text).replace(/`([^`]+)`/g, (_, code) => {
      codes.push(`<code>${code}</code>`);
      return `\u0002${codes.length - 1}\u0002`;
    });

    value = value.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (match, label, url) => {
      const href = safeUrl(url);
      if (!href) return label;
      return `<a href="${href}" target="_blank" rel="noopener noreferrer">${label}</a>`;
    });
    value = value
      .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
      .replace(/__([^_]+)__/g, "<strong>$1</strong>")
      .replace(/~~([^~]+)~~/g, "<del>$1</del>")
      .replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>")
      .replace(/(^|[^_])_([^_\n]+)_/g, "$1<em>$2</em>");

    return value.replace(/\u0002(\d+)\u0002/g, (_, i) => codes[Number(i)] || "");
  }

  function splitRow(line) {
    return line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((cell) => cell.trim());
  }
  function isTableSeparator(line) {
    const cells = splitRow(line);
    return cells.length > 1 && cells.every((cell) => /^:?-{3,}:?$/.test(cell));
  }

  function renderMarkdown(source) {
    const blocks = [];
    let value = String(source == null ? "" : source).replace(/\r\n?/g, "\n");
    value = escapeHtml(value);

    value = value.replace(/```([^\n`]*)\n([\s\S]*?)```/g, (_, lang, code) => {
      const language = String(lang).trim().replace(/[^A-Za-z0-9_+-]/g, "");
      const cls = language ? ` class="language-${language}"` : "";
      blocks.push(`<pre><code${cls}>${String(code).replace(/\n$/, "")}</code></pre>`);
      return `\u0001${blocks.length - 1}\u0001`;
    });

    const lines = value.split("\n");
    const out = [];
    let i = 0;

    while (i < lines.length) {
      const line = lines[i];

      if (!line.trim()) { i += 1; continue; }

      const codePlaceholder = line.match(/^\u0001(\d+)\u0001$/);
      if (codePlaceholder) {
        out.push(blocks[Number(codePlaceholder[1])] || "");
        i += 1;
        continue;
      }

      const heading = line.match(/^(#{1,6})\s+(.*)$/);
      if (heading) {
        const level = heading[1].length;
        out.push(`<h${level}>${inline(heading[2])}</h${level}>`);
        i += 1;
        continue;
      }

      if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
        out.push("<hr>");
        i += 1;
        continue;
      }

      if (/^&gt;\s?/.test(line)) {
        const quote = [];
        while (i < lines.length && /^&gt;\s?/.test(lines[i])) {
          quote.push(lines[i].replace(/^&gt;\s?/, ""));
          i += 1;
        }
        out.push(`<blockquote>${inline(quote.join("<br>"))}</blockquote>`);
        continue;
      }

      if (i + 1 < lines.length && line.includes("|") && isTableSeparator(lines[i + 1])) {
        const header = splitRow(line);
        i += 2;
        const rows = [];
        while (i < lines.length && lines[i].includes("|") && lines[i].trim()) {
          rows.push(splitRow(lines[i]));
          i += 1;
        }
        out.push(
          "<div class=\"md-table-wrap\"><table><thead><tr>" +
          header.map((cell) => `<th>${inline(cell)}</th>`).join("") +
          "</tr></thead><tbody>" +
          rows.map((row) => `<tr>${row.map((cell) => `<td>${inline(cell)}</td>`).join("")}</tr>`).join("") +
          "</tbody></table></div>"
        );
        continue;
      }

      if (/^\s*[-*+]\s+/.test(line)) {
        const items = [];
        while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i])) {
          items.push(lines[i].replace(/^\s*[-*+]\s+/, ""));
          i += 1;
        }
        out.push(`<ul>${items.map((item) => `<li>${inline(item)}</li>`).join("")}</ul>`);
        continue;
      }

      if (/^\s*\d+[.)]\s+/.test(line)) {
        const items = [];
        while (i < lines.length && /^\s*\d+[.)]\s+/.test(lines[i])) {
          items.push(lines[i].replace(/^\s*\d+[.)]\s+/, ""));
          i += 1;
        }
        out.push(`<ol>${items.map((item) => `<li>${inline(item)}</li>`).join("")}</ol>`);
        continue;
      }

      const paragraph = [];
      while (
        i < lines.length && lines[i].trim() &&
        !/^\u0001\d+\u0001$/.test(lines[i]) &&
        !/^(#{1,6})\s+/.test(lines[i]) &&
        !/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(lines[i]) &&
        !/^&gt;\s?/.test(lines[i]) &&
        !/^\s*[-*+]\s+/.test(lines[i]) &&
        !/^\s*\d+[.)]\s+/.test(lines[i]) &&
        !(i + 1 < lines.length && lines[i].includes("|") && isTableSeparator(lines[i + 1]))
      ) {
        paragraph.push(lines[i]);
        i += 1;
      }
      out.push(`<p>${inline(paragraph.join("<br>"))}</p>`);
    }

    return out.join("").replace(/\u0001(\d+)\u0001/g, (_, idx) => blocks[Number(idx)] || "");
  }

  global.renderMarkdown = renderMarkdown;
})(typeof window !== "undefined" ? window : globalThis);
