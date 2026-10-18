# 部署 fast-changyi

本项目使用你自己的 OSS Bucket 和 RAM 权限，不包含原部署的配置或凭证。Web/API 固定挂在 `/transfer/`，应用默认绑定本机 `127.0.0.1:8810`。

## 1. 准备云资源

1. 在目标 Region 建立私有 OSS Bucket，保留阻止公共访问和服务端加密。
2. 为 ECS 绑定实例 RAM Role，允许读取、删除应用 `transfer/v1/*` 对象及取消 Multipart，并允许 AssumeRole 到专用上传角色。权限模板见 `deploy/ram-ecs-role-permission.json`。
3. 上传角色只允许对指定前缀 PutObject、AbortMultipartUpload、ListParts。模板见 `deploy/ram-upload-role-policy.json`、`deploy/ram-upload-role-trust.json`。应用会进一步通过 STS session policy 将临时凭证收窄到单对象。
4. 替换模板中的 `<account-id>`、角色名称和 `your-oss-bucket`。不要直接提交真实配置到公共仓库。
5. 配置 `deploy/oss-cors.xml.example`，把 Origin 换成自己的 HTTPS 站点。ExposeHeader 至少包括 `ETag`、`Content-Range`、`x-oss-hash-crc64ecma`，允许上传及条件 Range 请求。
6. 如果文件需要永久保留，确认 OSS 生命周期没有自动删除 `transfer/v1/` 已完成对象的规则。未完成 Multipart 的清理策略可另行配置。

源代码默认使用实例元数据获取 ECS Role 凭证。上传角色的有效期短，权限按单文件收窄。不要向浏览器提供实例角色或长期管理密钥。

## 2. 配置环境

```bash
cp .env.example .env
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
```

将生成结果填入私有 `.env` 的 `SHARE_SECRET`，并填写真实 Bucket、Region、Endpoints 和 `STS_ROLE_ARN`。Share secret 必须在重新发布时保持不变，否则已有分享链接和取件码会失效。

生产环境需要：

```dotenv
NODE_ENV=production
HOST=127.0.0.1
PORT=8810
DATA_DIR=/var/lib/fast-changyi
PUBLIC_BASE_URL=https://files.example.com/transfer
OSS_REGION=oss-cn-beijing
OSS_BUCKET=your-real-private-bucket
OSS_EXTERNAL_ENDPOINT=https://oss-cn-beijing.aliyuncs.com
OSS_INTERNAL_ENDPOINT=https://oss-cn-beijing-internal.aliyuncs.com
STS_ENDPOINT=https://sts.cn-beijing.aliyuncs.com
STS_ROLE_ARN=acs:ram::<account-id>:role/<upload-role-name>
SHARE_SECRET=<your-random-secret-of-at-least-32-characters>
MAX_FILE_BYTES=2199023255552
```

以上仍是示例值。生产启动会拒绝默认开发 secret、空/示例 Bucket、占位 Role ARN 和非 HTTPS 公开地址。

内网 OSS Endpoint 只用于同 Region ECS。开发机或其他网络应把 `OSS_INTERNAL_ENDPOINT` 设置为可访问的公网 OSS Endpoint；它是后端读取/HEAD 的地址，不要求字面上必须是内网。

本地运行 `npm start` 自动加载 `.env`。systemd 使用 `EnvironmentFile`，不依赖 Node 读取 `.env`。本地云联调可设置自己的短期 `ALIYUN_ACCESS_KEY_ID/SECRET` 与 `ALIYUN_SECURITY_TOKEN`；生产优先使用 ECS 角色，不把真实凭证写进部署脚本或源码。

## 3. systemd 示例

以下步骤用于你自行管理的空白主机。根据自己的 Node 可执行文件路径调整服务模板。

```bash
npm ci
npm run check
npm test

sudo useradd --system --home /var/lib/fast-changyi --shell /usr/sbin/nologin fast-changyi
sudo install -d -o fast-changyi -g fast-changyi /var/lib/fast-changyi
sudo install -d /opt/fast-changyi/current /etc/fast-changyi
sudo cp -R server.mjs download-grant.mjs native-download.mjs package.json package-lock.json node_modules public /opt/fast-changyi/current/
sudo chown -R fast-changyi:fast-changyi /opt/fast-changyi/current
sudo install -m 600 .env /etc/fast-changyi/env
sudo cp deploy/fast-changyi.service /etc/systemd/system/fast-changyi.service
sudo systemctl daemon-reload
sudo systemctl enable --now fast-changyi
```

服务模板使用 `/usr/local/bin/node`、512 MiB 内存上限和独立数据目录。先确认 `/usr/local/bin/node --version` 为 22.13 或更新版本。应用无文件上传代理请求：上传数据从浏览器发往 OSS，控制面请求体无需调到大文件大小。

## 4. HTTPS 反向代理

把 `deploy/nginx.conf.example` 的 location 加入你自己的 HTTPS server block，保留其他站点的配置。先执行 `nginx -t`，通过后再 reload。

`proxy_buffering off`、`proxy_cache off` 和流式读取超时允许长下载持续传输。300 秒是请求无数据活动的等待边界，不是文件总时长限制。直连应用端口应只对受信任网络开放；应用信任 loopback 代理写入的 `X-Real-IP`。

## 5. 下载接口

| 请求 | 行为 |
| --- | --- |
| `POST /transfer/api/share/:token/download` + `{native:true}` | 固定同源 `nativeUrl` 和文件元数据，不签发 OSS URL |
| 同上 + `{direct:true}` | 为高级下载器生成受 STS 有效期限制的 OSS 直下 URL |
| 同上 + `{}` | 兼容旧页面，把固定地址放入 `url` |
| `GET /transfer/api/share/:token/content` | 校验上游内容并流式返回，支持单段 Range |
| `HEAD /transfer/api/share/:token/content` | 返回应用元数据与续传能力，不读取对象内容 |

直接访问对象的临时 OSS 链接仍有有效期。分享和原生续传应保存应用分享链接或固定下载地址。

## 6. 验证与运维

```bash
curl --fail http://127.0.0.1:8810/transfer/api/health
journalctl -u fast-changyi --since '10 minutes ago'
```

在自己的环境创建合成测试文件，验证上传完成、三个文件展示入口、中文文件名、公开分享、下载完整哈希、断流恢复及取消。不要以其他用户的真实文件作破坏性测试。

如果下载每次都会切换到浏览器下载，先检查 OSS 实际响应中的 `Access-Control-Expose-Headers` 是否包含 `Content-Range` 和 `ETag`。仅在 curl 或服务端看到 `Content-Range` 不足以证明浏览器 JavaScript 能读取它；缺少暴露配置时，即使 OSS 返回正确的 `206`，下载器也会因无法校验分段而回退。验证时应带上真实站点的 `Origin`、`Range` 和 `If-Match`，并分别检查预检与 GET 响应。

兼容通道经过应用服务器，受其公网出口带宽限制。原生下载管理器本身不代表传输缓慢；应先确认文件字节经过的是 OSS 直连还是服务器中转。浏览器不支持 File System Access API 或拒绝保存权限时，仍会使用兼容通道，这与上述 CORS 配置错误是两类问题。

备份 SQLite、SHARE_SECRET 和环境配置。SQLite 在线备份应使用一致性备份 API，不能只复制运行中的主文件而忽略 WAL。发布时先启动隔离数据目录的预检服务，再原子切换 release；正常代码回滚保留最新业务数据库。

`npm run hash-code` 和 `scripts/aliyun-rpc.mjs` 是原项目的历史辅助工具；前者不会自动给公开接口加访问控制，后者会按输入执行真实 RAM/ECS API 操作，默认部署流程不调用它们。

更完整的历史工程记录在 `docs/history/`，包含旧版本和已经脱敏的原部署细节；这些内容不是当前配置模板。已有上传生命周期问题见 [KNOWN_LIMITATIONS.md](KNOWN_LIMITATIONS.md)。
