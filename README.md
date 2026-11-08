# upfile · Cloudflare Workers + KV 个人文件中转站

一个部署在 Cloudflare Workers 上的极简私人文件上传 / 下载 / 删除工具，数据存于 KV，自带网页文件列表与密码保护。

## 特性

- **上传**：一条 curl 命令即可上传，支持 multipart 表单（自动读取本地文件名）和管道二进制两种方式。
- **下载**：直接 `GET /<文件名>`，支持 `HEAD`，响应带原始文件名，浏览器访问自动弹下载。
- **删除**：支持 curl `DELETE`，也支持在网页列表页点按钮删除。
- **网页列表**：访问 `/list`，密码登录后展示文件名、上传时间、大小、链接，可在线删除。
- **安全**：所有写操作需 `X-Secret` 请求头；列表页需密码登录，登录态 Cookie 1 小时有效，`HttpOnly + SameSite=Lax`。
- **其他**：上传时间统一按北京时间（UTC+8）显示；文件名 HTML 转义防 XSS；自动分页拉取全部 KV key；单文件上限 25 MiB（KV 限制）。

## 部署

### 1. 创建 KV 命名空间

1. 登录 [Cloudflare Dashboard](https://dash.cloudflare.com/)，左侧菜单进入 **Storage & Databases → KV**（旧版界面叫 "Workers KV"）。
2. 点 **Create a namespace**，名字随意，例如 `uldl-kv`，点 Add。

### 2. 创建并部署 Worker

1. 左侧菜单进入 **Compute (Workers)**（旧版叫 "Workers & Pages"）。
2. 点 **Create**，选 **Hello World** 模板，点 Deploy。
3. 进入刚创建的 Worker，点 **Edit code**（在线编辑器），把 `worker.js` 的全部内容粘贴覆盖默认代码，点 **Deploy**。
4. 回到 Worker 的 **Settings** 页面，记下你的访问域名，形如 `https://uldl.xxxx.workers.dev`。

### 3. 绑定 KV 命名空间

进入 Worker 的 **Settings → Bindings**，点 **Add**：

- 类型选 **KV Namespace**
- **Variable name** 必须填 `NS`（和代码里 `env.NS` 一致，写错会报 500）
- **KV namespace** 下拉选第 1 步创建的 `uldl-kv`

### 4. 设置访问密钥 SECRET

在同一个 **Bindings** 面板再点 **Add**：

- 类型选 **Secret**（加密存储，比普通 Environment Variable 安全）
- **Variable name** 填 `SECRET`
- **Value** 填你自己的访问密码，例如 `MyStrongPass_2026`

### 5. 重新部署使绑定生效

Bindings 修改后必须再点一次 **Deploy**（或回到代码页点 Deploy），然后访问：

```
https://uldl.xxxx.workers.dev
```

打开 `/list` 会提示输入密码，密码就是第 4 步设置的 `SECRET`。

## 使用

### 上传

**方式一：上传本地文件（推荐，自动读取文件名）**

```bash
curl -X POST https://uldl.xxx.workers.dev/u \
  -H "X-Secret: 你的密钥" \
  -F "file=@/path/to/file.bin"
```

**方式二：管道 / 标准输入，手动指定文件名**

```bash
echo "test" | curl -X POST https://uldl.xxx.workers.dev/u \
  -H "X-Secret: 你的密钥" \
  -H "X-Filename: note.txt" \
  --data-binary @-
```

成功后返回可直接下载的链接。同名文件会覆盖。

### 下载

```bash
curl -O https://uldl.xxx.workers.dev/<文件名>
```

浏览器直接打开链接也会自动下载（带原始文件名）。

### 删除

```bash
curl -X DELETE https://uldl.xxx.workers.dev/<文件名> \
  -H "X-Secret: 你的密钥"
```

### 查看文件列表

浏览器打开：

```
https://uldl.xxx.workers.dev/list
```

输入访问密码后看到全部文件，支持在线删除。

## 目录结构

```
.
├── _worker.js      # Cloudflare Workers 入口
└── README.md
```

## 注意事项

- 单文件上限 **25 MiB**（Workers KV 的 value 限制）。
- KV 单次调用操作数上限 1000，列表页已通过 metadata 方案规避，几千个文件也只需 1~2 次 list 操作。
- 上传时间存于 KV metadata，历史旧数据若没有 metadata，时间列显示 `-`，重新上传一次即可补齐。
- 该服务是私人工具，请保管好密钥，不要公开分享。

