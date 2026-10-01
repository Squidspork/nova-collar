function appendInlines(el, text) {
  const re = /(\*\*[^*]+\*\*|`[^`]+`)/g;
  let last = 0;
  let match;
  while ((match = re.exec(text))) {
    if (match.index > last) el.appendChild(document.createTextNode(text.slice(last, match.index)));
    if (match[0].startsWith("**")) {
      const strong = document.createElement("strong");
      strong.textContent = match[0].slice(2, -2);
      el.appendChild(strong);
    } else {
      const code = document.createElement("code");
      code.textContent = match[0].slice(1, -1);
      el.appendChild(code);
    }
    last = match.index + match[0].length;
  }
  if (last < text.length) el.appendChild(document.createTextNode(text.slice(last)));
}

function renderMd(text) {
  const wrap = document.createElement("div");
  wrap.className = "md";
  const lines = String(text || "").replace(/\r\n/g, "\n").split("\n");
  let i = 0;
  let para = [];

  const flushPara = () => {
    if (!para.length) return;
    const p = document.createElement("p");
    appendInlines(p, para.join(" "));
    wrap.appendChild(p);
    para = [];
  };

  while (i < lines.length) {
    const line = lines[i];
    if (/^```/.test(line)) {
      flushPara();
      const pre = document.createElement("pre");
      const code = document.createElement("code");
      const buf = [];
      i += 1;
      while (i < lines.length && !/^```/.test(lines[i])) {
        buf.push(lines[i]);
        i += 1;
      }
      if (i < lines.length) i += 1;
      code.textContent = buf.join("\n");
      pre.appendChild(code);
      wrap.appendChild(pre);
      continue;
    }

    const heading = /^(#{1,3})\s+(.+)$/.exec(line);
    if (heading) {
      flushPara();
      const node = document.createElement(`h${heading[1].length}`);
      appendInlines(node, heading[2]);
      wrap.appendChild(node);
      i += 1;
      continue;
    }

    if (/^[-*]\s+/.test(line)) {
      flushPara();
      const list = document.createElement("ul");
      while (i < lines.length) {
        const item = /^[-*]\s+(.+)$/.exec(lines[i]);
        if (!item) break;
        const li = document.createElement("li");
        appendInlines(li, item[1]);
        list.appendChild(li);
        i += 1;
      }
      wrap.appendChild(list);
      continue;
    }

    if (/^\|/.test(line) && i + 1 < lines.length && /^\|?\s*:?-+:?/.test(lines[i + 1] || "")) {
      flushPara();
      const rows = [];
      while (i < lines.length && /^\|/.test(lines[i])) {
        const cells = lines[i].split("|").slice(1, -1).map((cell) => cell.trim());
        if (!cells.every((cell) => /^:?-+:?$/.test(cell))) rows.push(cells);
        i += 1;
      }
      if (rows.length) {
        const table = document.createElement("table");
        rows.forEach((cells, index) => {
          const tr = document.createElement("tr");
          for (const cell of cells) {
            const td = document.createElement(index === 0 ? "th" : "td");
            appendInlines(td, cell);
            tr.appendChild(td);
          }
          table.appendChild(tr);
        });
        wrap.appendChild(table);
      }
      continue;
    }

    if (/^\d+\.\s+/.test(line)) {
      flushPara();
      const list = document.createElement("ol");
      while (i < lines.length) {
        const item = /^\d+\.\s+(.+)$/.exec(lines[i]);
        if (!item) break;
        const li = document.createElement("li");
        appendInlines(li, item[1]);
        list.appendChild(li);
        i += 1;
      }
      wrap.appendChild(list);
      continue;
    }

    if (!line.trim()) {
      flushPara();
      i += 1;
      continue;
    }

    para.push(line.trim());
    i += 1;
  }

  flushPara();
  if (wrap.firstElementChild) wrap.firstElementChild.classList.add("lead");
  return wrap;
}

function fillMessage(el, text, markdown) {
  el.replaceChildren();
  const body = String(text || "");
  if (markdown && body.trim()) {
    el.classList.add("rich");
    el.appendChild(renderMd(body));
  } else {
    el.classList.remove("rich");
    el.textContent = body;
  }
}
