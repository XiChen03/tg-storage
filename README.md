# TG Storage Worker 部署指南

## 一、前置准备

### 1. 创建 Telegram Bot
1. 打开 Telegram，搜索 `@BotFather`
2. 发送 `/newbot`
3. 按提示设置名称，获得 **BOT_TOKEN**（格式：`123456:ABC-xxx`）

### 2. 创建 Telegram 私有频道
1. 创建一个新频道，设为**私有**
2. 进入频道 → 频道管理 → 把你的 bot 设为**管理员**（需要发消息权限）
3. 获取频道 ID：
   - 往频道发一条消息
   - 搜索 `@VersaToolsBot`，把那条消息转发给它
   - 它会回复一个数字 ID，格式 `-100xxxxxxxxxx`，这就是 **CHAT_ID**

### 3. Cloudflare 账号
1. 注册/登录 [Cloudflare Dashboard](https://dash.cloudflare.com)
2. 你的域名 xywm.ltd 已在 CF 上 ✓

## 二、部署 Worker

### 方式 A：用 Wrangler CLI（推荐）

```bash
# 安装 wrangler
npm install -g wrangler

# 登录
wrangler login

# 进入 tg-storage 目录
cd tg-storage

# 部署
wrangler deploy
```

### 方式 B：Dashboard 手动创建

1. 进入 [Workers & Pages](https://dash.cloudflare.com/?to=/:account/workers)
2. 点「Create application」→「Create Worker」
3. 名字填 `tg-storage`
4. 把 `worker.js` 的内容粘贴进编辑器
5. 点「Deploy」

## 三、配置环境变量和 Secrets

在 Worker 详情页 → Settings → Variables and Secrets：

### Secrets（加密，不会回显）
| 名称 | 值 | 说明 |
|---|---|---|
| `BOT_TOKEN` | `123456:ABC-xxx` | TG Bot Token |
| `CHAT_ID` | `-100xxxxxxxxxx` | TG 频道 ID |
| `STORE_KEY` | 自定义一个随机密钥 | 上传/删除鉴权密钥 |

### 环境变量（明文）
| 名称 | 值 | 说明 |
|---|---|---|
| `ORIGIN_URL` | `https://xywm.ltd` | 你的 XingyueBot 域名 |
| `TG_API_URL` | `https://api.telegram.org` | TG API 地址（可改为反代域名）|
| `DOWNLOAD_MAX_MB` | `20` | **单次响应最多吐多少 MB**（默认 20，范围 2–64）。必须保持在 20 左右，见下方「为什么下载要分段」 |

> ⚠️ `DOWNLOAD_MAX_MB` 不要调大。实测下行约 1.2MB/s，而 Cloudflare 会在响应开始
> 约 60 秒时掐断连接；20MB 大约 17 秒，安全。调到 64MB 就必然被掐断，客户端会拿到
> 半截文件。

## 四、绑定自定义域名

1. Worker 详情页 → Settings → Triggers → Custom Domains
2. 添加自定义域名：`tg.xywm.ltd`
3. 等待 DNS 生效（通常几秒）

## 五、验证部署

浏览器访问 `https://tg.xywm.ltd/` 应显示 `TG Storage Worker - OK`

## 六、XingyueBot 端配置

在图床设置页面填写：
- **TG 云储存开关**：开启
- **Worker 地址**：`https://tg.xywm.ltd`
- **存储密钥**：和你设置的 STORE_KEY 一致

## 七、API 参考

### POST /upload
上传文件到 TG。需要 `X-Store-Key` 头。

请求：multipart/form-data，字段名 `file`

响应：
```json
{
  "ok": true,
  "file_id": "BAACAgIAAxk...",
  "file_path": "photos/file_0.jpg",
  "message_id": 1024,
  "mime": "image/jpeg",
  "filename": "photo.jpg",
  "size": 204800
}
```

### GET /f/<id>
下载文件。支持 Range/206/ETag/304/HEAD。

**分页行为**：单次响应最多 `DOWNLOAD_MAX_MB` 字节，超过就按分片边界截断并回 206，
`Content-Range` 与实际字节严格一致；客户端用 `Range: bytes=N-` 续取即可拿完整个文件。

**`?info=1`** 返回分片布局，方便前端规划进度与断点续传：
```json
{
  "ok": true,
  "size": 209024140,
  "mime": "application/zip",
  "filename": "包.zip",
  "etag": "\"209024140-10\"",
  "chunks": [{"index":0,"start":0,"end":20971519,"size":20971520}, ...]
}
```

### 为什么下载必须分段
199MB 的文件按实测 1.2MB/s 需要 160 秒以上，而 Cloudflare 在响应开始约 60 秒时
会掐断仍在传输的连接。早先「一个请求整包推完」的实现会在这时被截断，但响应头里
已经写死 `Content-Length: 209024140` / `Content-Range: 0-209024139/...`，无法回滚，
于是浏览器/下载器判定「文件不完整、下载失败」，且每次断点不同（取决于当时网速）。
现在的实现保证：**任何响应声明的字节数一定等于实际发出的字节数**，超出预算就回 206
让客户端接着要。

### DELETE /del/<id>?msgIds=1,2,3
删除 TG 频道中的消息。需要 `X-Store-Key` 头。

## 注意事项

- 单文件上限 700MB（免费档子请求限制）
- GIF 走 sendAnimation（避免 TG 转码）；**WebP 走 sendDocument**（TG 不接受 animation 形式的 WebP，会退回 document 导致取不到结果，报 `unexpected response`）
- 分片响应不走边缘缓存（CDN 对 Range 缓存不可靠）
- Bot 被封 = 文件全灭，重要内容建议双写备份

## 更新本 Worker 前务必确认「线上跑的是哪一版」

改了代码却没重新 `wrangler deploy`，线上仍是旧逻辑，症状会非常迷惑（比如「明明
修了却还是一样失败」）。以下命令可判断线上版本：

```bash
# 旧版（整包流式推送，会被 60s 掐断）：返回 200，且没有 Content-Range
curl -sI https://tg.xywm.ltd/f/<id> | grep -i "content-range\|transfer-encoding"

# 新版（分段）：无 Range 请求也应返回 206 + 精确的 Content-Range
curl -s -o /dev/null -D - -H "Range: bytes=0-99" https://tg.xywm.ltd/f/<id>
```

新版还应支持 `?info=1`（返回分片布局）。旧版本没有这个参数。
