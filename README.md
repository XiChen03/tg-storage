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

### DELETE /del/<id>?msgIds=1,2,3
删除 TG 频道中的消息。需要 `X-Store-Key` 头。

## 注意事项

- 单文件上限 700MB（免费档子请求限制）
- GIF/WebP 会自动转 sendAnimation（避免 TG 转码）
- 分片响应不走边缘缓存（CDN 对 Range 缓存不可靠）
- Bot 被封 = 文件全灭，重要内容建议双写备份
