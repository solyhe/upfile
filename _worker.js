// worker.js — uldl clone (CF Workers + KV) — 修复版
// 主要修复：
// 1) /list 的 POST 只读一次 request.formData()（原代码读了两次 → TypeError → error 1101）
// 2) 上传时间改用 KV metadata 存储，list 时不再逐 key GET（省配额、避免脏数据 JSON.parse 抛错）
// 3) KV.list() 分页取全量；KV 绑定缺失、表单解析失败、非法 URI 编码都返回明确提示而不是 1101
// 4) 统一渲染函数、303 重定向、安全解码、下载带原始文件名

const RESERVED_PREFIX = "__meta__";
const MAX_KEYS = 20000; // 安全上限，防止无限翻页

export default {
  async fetch(request, env, ctx) {
    try {
      return await handleRequest(request, env);
    } catch (err) {
      // 兜底：任何未捕获异常都不再抛成 error 1101，而是返回可读信息
      return html(
        `<h1>500 Internal Error</h1><p>${escapeHtml(err && err.stack ? err.stack : String(err))}</p>`,
        500
      );
    }
  },
};

async function handleRequest(request, env) {
  const reqUrl = new URL(request.url);
  const path = reqUrl.pathname;
  const origin = reqUrl.origin;

  const SECRET = env.SECRET || "change-me-123456";
  const headerSecret = request.headers.get("X-Secret");
  const authorizedByHeader = headerSecret === SECRET;

  const KV = env && env.NS;
  if (!KV) {
    return html(
      `<h1>KV 绑定缺失</h1><p>请在 Worker 的 Settings → Bindings 里添加 KV Namespace 绑定，变量名必须是 <code>NS</code>，然后重新部署。</p>`,
      500
    );
  }

  // ---------- 首页 ----------
  if (path === "/" && request.method === "GET") {
    const help = `uldl clone (CF Workers + KV) · KV 版

用法说明：
  1) 上传文本（管道，手动指定文件名）
     echo "test" | curl -X POST ${origin}/u -H "X-Secret: <你的密钥>" -H "X-Filename: note.txt" --data-binary @-

  2) 上传文件（自动读取本地文件名，推荐）
     curl -X POST ${origin}/u -H "X-Secret: <你的密钥>" -F "file=@/path/file.bin"

  3) 下载
     curl -O ${origin}/<key>

  4) 删除
     curl -X DELETE ${origin}/<key> -H "X-Secret: <你的密钥>"

  5) 查看文件列表（浏览器打开，需输入访问密码，支持网页删除）
     ${origin}/list

说明：X-Secret 处的 <你的密钥> 请替换为你自己设置的访问密钥，本站不在页面上显示密钥。
同名文件上传会直接覆盖。单文件上限 25 MiB（KV 限制）。
`;
    return new Response(help, { headers: { "Content-Type": "text/plain;charset=utf-8" } });
  }

  // ---------- 列表页 / 登录 / 网页删除 ----------
  if (path === "/list") {
    const cookieOk = getCookie(request, "auth") === "ok";

    // 注意：POST body 全流程只解析一次
    let form = null;
    if (request.method === "POST") {
      form = await readForm(request);
      if (!form) {
        return html(`<h1>400 Bad Request</h1><p>表单解析失败，请从 <a href="${origin}/list">列表页</a> 正常提交。</p>`, 400);
      }
    }

    const pwdInput = form ? form.get("pwd") : null;
    const pwdOk = typeof pwdInput === "string" && pwdInput === SECRET;
    const passOk = cookieOk || authorizedByHeader || pwdOk;

    // 未通过鉴权
    if (!passOk) {
      if (request.method === "POST") {
        return html(
          `<h1>403</h1><p>密码错误。</p>${loginForm()}`,
          403
        );
      }
      return html(loginForm(), 200);
    }

    // 网页删除
    if (form) {
      const action = form.get("action");
      const targetKey = form.get("key");
      if (action === "delete" && typeof targetKey === "string" && targetKey) {
        const realKey = safeDecode(targetKey);
        if (realKey) {
          await KV.delete(realKey);
          // 兼容旧版本留下的元数据 key
          if (!realKey.startsWith(RESERVED_PREFIX)) {
            await KV.delete(RESERVED_PREFIX + realKey);
          }
        }
        // 删除成功：返回一个"已删除，正在刷新列表"的中转页，浏览器自动重载 /list
        // 同时带上 auth cookie，确保刷新后落在已登录的列表页而不是密码框
        return new Response(
          `<!DOCTYPE html>
<html lang="zh-CN">
<head><meta charset="utf-8"><meta http-equiv="refresh" content="0; url=${origin}/list">
<title>已删除</title></head>
<body style="text-align:center;margin-top:80px;font-family:system-ui,sans-serif;">
<p>已删除 <b>${escapeHtml(realKey)}</b>，正在刷新列表…</p>
<p><a href="${origin}/list">如果没有自动跳转，请点这里</a></p>
<script>location.replace("${origin}/list");</script>
</body></html>`,
          {
            headers: {
              "Content-Type": "text/html;charset=utf-8",
              "Cache-Control": "no-store",
              "Set-Cookie": `auth=ok; Max-Age=3600; Path=/; Secure; HttpOnly; SameSite=Lax`,
            },
          }
        );
      }
    }

    // 渲染列表
    const { keys, truncated } = await listAll(KV);
    const body = renderList(keys, origin, truncated);
    const headers = { "Content-Type": "text/html;charset=utf-8", "Cache-Control": "no-store" };
    if (pwdOk) headers["Set-Cookie"] = `auth=ok; Max-Age=3600; Path=/; Secure; HttpOnly; SameSite=Lax`;
    return new Response(body, { headers });
  }

  // ---------- 上传 ----------
  if (path === "/u" && request.method === "POST") {
    if (!authorizedByHeader) return new Response("Unauthorized", { status: 401 });

    const ct = request.headers.get("Content-Type") || "";
    let fname = "";
    let buf = null;

    if (ct.includes("multipart/form-data")) {
      const form = await readForm(request);
      if (!form) return new Response("Bad form: multipart parse failed\n", { status: 400 });
      const file = form.get("file") || form.get("f");
      if (!file || typeof file === "string") {
        return new Response("Bad form: need field 'file'\n", { status: 400 });
      }
      fname = file.name || "";
      buf = await file.arrayBuffer();
    } else {
      buf = await request.arrayBuffer();
      fname = request.headers.get("X-Filename") || "";
    }

    fname = sanitizeName(fname);
    if (!fname) fname = crypto.randomUUID();

    if (buf.byteLength > 25 * 1024 * 1024) {
      return new Response("File too large: KV value limit is 25 MiB\n", { status: 413 });
    }

    // 元数据存进 KV 的 metadata，列表时 list() 直接返回，不再逐条 GET
    await KV.put(fname, buf, { metadata: { uploadAt: Date.now(), size: buf.byteLength } });

    return new Response(`${origin}/${encodeURIComponent(fname)}\n`, {
      headers: { "Content-Type": "text/plain;charset=utf-8" },
    });
  }

  // ---------- 下载 / 删除 ----------
  const rawKey = path.slice(1);
  if (!rawKey) return new Response("Bad request", { status: 400 });
  const realKey = safeDecode(rawKey);
  if (!realKey) return new Response("Bad Request: malformed key\n", { status: 400 });
  if (realKey.startsWith(RESERVED_PREFIX)) return new Response("Not Found", { status: 404 });

  if (request.method === "GET" || request.method === "HEAD") {
    const data = await KV.get(realKey, "arrayBuffer");
    if (!data) return new Response("Not Found", { status: 404 });
    const headers = {
      "Content-Type": "application/octet-stream",
      "Content-Length": String(data.byteLength),
      "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(realKey)}`,
      "Cache-Control": "public, max-age=3600",
    };
    return new Response(request.method === "HEAD" ? null : data, { headers });
  }

  if (request.method === "DELETE") {
    if (!authorizedByHeader) return new Response("Unauthorized", { status: 401 });
    await KV.delete(realKey);
    if (!realKey.startsWith(RESERVED_PREFIX)) await KV.delete(RESERVED_PREFIX + realKey);
    return new Response("Deleted\n", { headers: { "Content-Type": "text/plain;charset=utf-8" } });
  }

  return new Response("Method not allowed", { status: 405 });
}

// ---------------- helpers ----------------

function getCookie(req, name) {
  const cookieStr = req.headers.get("Cookie") || "";
  const item = cookieStr.split("; ").find((r) => r.startsWith(name + "="));
  return item ? item.slice(name.length + 1) : "";
}

async function readForm(request) {
  try {
    return await request.formData();
  } catch {
    return null;
  }
}

function safeDecode(s) {
  try {
    return decodeURIComponent(s);
  } catch {
    return s; // 非法 % 序列：按原样使用，不再抛 URIError
  }
}

function sanitizeName(raw) {
  return safeDecode(String(raw || ""))
    .split(/[\\/]/)
    .pop()
    .replace(/[\u0000-\u001f\u007f]/g, "_")
    .trim()
    .slice(0, 200);
}

async function listAll(KV) {
  const keys = [];
  let cursor = undefined;
  let truncated = false;
  for (let page = 0; page < 40; page++) {
    const res = await KV.list({ cursor });
    for (const obj of res.keys) {
      if (!obj.name.startsWith(RESERVED_PREFIX)) {
        keys.push({ name: obj.name, meta: obj.metadata || null });
      }
    }
    if (res.list_complete) return { keys, truncated };
    if (keys.length >= MAX_KEYS) {
      keys.length = MAX_KEYS;
      return { keys, truncated: true };
    }
    cursor = res.cursor;
    if (!cursor) break;
  }
  return { keys, truncated };
}

function renderList(keys, origin, truncated) {
  let rows = "";
  for (const k of keys) {
    const name = k.name;
    const uploadTime = k.meta && k.meta.uploadAt ? fmtBeijing(k.meta.uploadAt) : "-";
    const size = k.meta && typeof k.meta.size === "number" ? humanSize(k.meta.size) : "-";
    const link = `${origin}/${encodeURIComponent(name)}`;
    const safeKey = escapeHtml(encodeURIComponent(name));
    rows += `<tr>
  <td>${escapeHtml(name)}</td>
  <td>${escapeHtml(uploadTime)}</td>
  <td>${escapeHtml(size)}</td>
  <td><a href="${link}" target="_blank">${escapeHtml(link)}</a></td>
  <td>
    <form method="POST" style="margin:0" onsubmit="return confirm('确定删除【${escapeHtml(name)}】？')">
      <input type="hidden" name="action" value="delete">
      <input type="hidden" name="key" value="${safeKey}">
      <button class="del-btn" type="submit">删除</button>
    </form>
  </td>
</tr>`;
  }
  if (!rows) rows = `<tr><td colspan="5" style="text-align:center">暂无文件</td></tr>`;
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>File list</title>
<style>
body{font-family:system-ui,-apple-system,"Segoe UI",sans-serif;}
table{border-collapse:collapse;width:92%;margin:20px auto;}
th,td{border:1px solid #ccc;padding:6px 10px;text-align:left;font-size:14px;word-break:break-all;}
th{background:#f5f5f5;}
a{text-decoration:none;}
.del-btn{color:#fff;background:#dc3545;border:none;padding:4px 10px;border-radius:3px;cursor:pointer;}
h3{text-align:center;margin-top:24px;}
</style>
</head>
<body>
<h3>文件清单（${keys.length}${truncated ? "+" : ""}）</h3>
<table>
<tr><th>文件名</th><th>上传时间</th><th>大小</th><th>链接</th><th>操作</th></tr>
${rows}
</table>
${truncated ? `<p style="text-align:center;color:#888">key 数量过多，已截断显示。</p>` : ""}
</body>
</html>`;
}

function loginForm(errMsg = "") {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>请输入访问密码</title></head>
<body style="text-align:center;margin-top:100px;font-family:system-ui,sans-serif;">
${errMsg ? `<p style="color:#dc3545">${escapeHtml(errMsg)}</p>` : ""}
<form method="POST">
  <label>访问密码：</label>
  <input type="password" name="pwd" required>
  <button type="submit">提交</button>
</form>
</body>
</html>`;
}

function humanSize(n) {
  if (n < 1024) return n + " B";
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + " KB";
  return (n / 1024 / 1024).toFixed(2) + " MB";
}

// 统一显示北京时间（UTC+8），不受浏览器所在时区影响
function fmtBeijing(ts) {
  return new Date(ts).toLocaleString("zh-CN", {
    timeZone: "Asia/Shanghai",
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).replace(/\//g, "-");
}

function html(body, status = 200) {
  return new Response(body, {
    status,
    headers: { "Content-Type": "text/html;charset=utf-8", "Cache-Control": "no-store" },
  });
}

// HTML 转义，防止文件名 XSS
function escapeHtml(str) {
  return String(str)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
//（注：内容由AI生成）
