# PDD404 v0.2.0 运行与发布手册

本产品独立于旧的 Chiang Mai Swap，开源仓库为 `CMI-Community/cmi-find-my-pdd`。用户已授权把本产品已有专属 Supabase 项目 `fogncjjsnakbhfdbfvdi` 从测试用途转为生产；执行转换后，它不再是云端测试库。不得部署到旧站 Vercel 项目 `prj_gMEhOL3gRSNKTvATClpNbcJKIT3k` 或旧站数据库 `osqyplgctlzdlpqmzfud`，也不得为释放配额暂停无关项目。

正式数据库、前端部署、域名、提交开关、真机验收和备份启用是不同状态，逐项写入 `docs/releases/`。本手册给出操作要求，不证明生产已可用。

## 配置与环境

1. 在 `codex/…` 分支准备改动，运行检查、真实本地数据库事务和恢复验证，PR 审查后合并 main。迁移应用前保存加密备份与真实恢复证据。
2. 生产只使用上述专属 Supabase 和新建的独立 Vercel 项目；先核对项目 ID、现存扫描/登记、存储与管理员，保留旧测试事实，不 reset 或清零账单来转换环境。
3. 配置 `APP_ENVIRONMENT=production`、Edge secret `OCR_ENABLED=false`、`APP_PUBLIC_URL=https://pdd404.app`；`ALLOWED_ORIGINS` 只含明确授权的生产网站。开发和预览不得接入生产登记，不为预览测试扩充生产 CORS。
4. 三项 `VITE_` 配置指向同一个项目：API 函数 URL、Supabase URL、publishable/anon key。service-role、数据库密码和其他密钥只保存在服务端及忽略的私有文件。
5. Supabase Auth 关闭公开 signup；维护者创建管理员，实际 Auth UUID 写入 `ADMIN_USER_IDS`。服务端同时核验 token 和白名单，不以邮箱、客户端 role 或普通登录身份授权。
6. 默认 `submissionsEnabled=false`；真实社区资料、管理员与端到端流程验证后才开启。单号服务不要求 OpenAI 余额，首发不启用图像识别。

本机配置面板 `npm run setup` 绑定 `http://localhost:5180`，使用 Host/Origin 检查及随机请求令牌，配置和真实二维码只保存到被忽略的 `.private/`。旧的 `.private/test.env` 反映历史测试设置，生产转换后不能把它继续当作云端测试部署目标。

Supabase 两函数 `verify_jwt=false` 由函数正文执行权限检查：api 使用查询/管理 capability 或管理员 JWT，worker 使用内部密钥及 OCR 开关。删除 JWT 平台校验不代表接口匿名可写数据库。

## 服务端配置与旧 OCR

优先使用 Supabase Edge secrets。连接器无法设置环境时，可使用 Vault 与 `site_settings` 备用配置：

- `site_settings` 的 `key='runtime'`：`APP_ENVIRONMENT,APP_PUBLIC_URL,ALLOWED_ORIGINS,ADMIN_USER_IDS,APP_SHA`。迁移 `20261006090315_pdd404_runtime_flag.sql` 将 `OCR_ENABLED` 纳入服务器专用备用配置，默认 false；显式 Edge secret 优先，启用前须核对实际运行值。
- `runtime_config` 仅 service_role 可调用；运行缓存每 60 秒刷新，已设 Edge 环境优先。不得由浏览器读取备用配置。
- 保留的 Vault `cmi_openai_api_key,cmi_worker_secret,cmi_worker_url` 只服务旧 OCR；首发关闭 OCR，不要求新增 key 或补充额度。
- 设置私密值从安全文件/密钥服务读取，工具只输出状态，不回显值。轮换先验证新值，再撤销旧值。Vault 不在数据库备份内，恢复时从安全保管资料另配。

`OCR_ENABLED=false` 阻断旧扫描、追踪、旧管理/管理员业务写入及候选匹配副作用；历史受权限保护的读取保留，不触发匹配写入。worker 继续核验内部密钥并清理旧资料，返回 HTTP 202 cleanup 模式，不租用/处理 OCR 任务、不发送微信消息。本版独立 `pdd404-retention` 每小时第 17 分钟清理单号资料，无需 worker 或模型额度。旧图片、预算、重试、租约 fencing 规则继续保留，不能为了新流程降低权限或预算。

重新启用旧 OCR 是单独变更：需要恢复真实虚构图片 API 验收、预算与三次重试限制。额度不足不是瞬时限速，不循环重试、不清零历史尝试，不擅自换模型规避限制。

## 社区入口

管理员录入本人提供的真实 HTTPS 群二维码、小助手和公众号。`community-assets` 只存社区入口，公开读取、无匿名写入；面单、用户照片与生产数据不得进入此 bucket。保留的 `parcel-originals`、`parcel-public` 均继续私有。

替换二维码用新文件名，验证真实 GET 后通过有审计的设置更新；群满、过期或停止受理时及时更换。缺资料显示尚未配置，不生成占位 QR。关注公众号、加群和小助手是社区入口，不是访问他人资料的授权动作。本版提交表单告知直接匹配联系用途，不要求加群声明。

## Cloudflare DNS 与域名

目标主域名为 `https://pdd404.app`。截至本手册编写，DNS、域名证书和最终 HTTPS 验证尚未在本文件确认；只在发布记录有证据后更新状态。

1. 在**本产品独立 Vercel 项目**的 Settings → Domains 添加 `pdd404.app`。复制该项目实际显示的 DNS 类型、名称和目标，不使用旧 Swap 项目记录，不凭经验填通用 IP。
2. Cloudflare 打开 `pdd404.app` 的 DNS → Records。主域 `@` 按 Vercel 实际要求设置记录；如果 Domains 页面给出 A 值，完整复制该值。若启用 `www`，先在同一 Vercel 项目添加，再复制其实际 CNAME 目标并设置跳转到主域。要求所有权验证时，再添加其指定 TXT 名称与值。
3. A/AAAA/CNAME 先使用 **DNS only（灰云）**，TTL 可用 Auto；只修改本产品对应的网站记录，保留 MX、邮件和其他验证记录。Cloudflare 继续管理 DNS，无须迁移其余记录到 Vercel。
4. 等 Vercel 显示有效配置及 HTTPS 证书，分别检查权威/公共 DNS、浏览器 HTTPS、首页和深层路由刷新、API CORS 与真实群入口。Cloudflare“已保存”或 Vercel“已添加域名”都不是传播及证书完成的证明。

记录值以[当前 Vercel Domains 指引](https://vercel.com/docs/domains/working-with-domains/add-a-domain)及项目界面为准；DNS 操作见 [Cloudflare 管理记录](https://developers.cloudflare.com/dns/manage-dns-records/how-to/create-dns-records/)。首发使用 DNS only，避免增加未验收的反向代理层，参见 [Vercel 对 Cloudflare 代理的说明](https://vercel.com/kb/guide/cloudflare-with-vercel)。

## 检查与部署

```sh
npm run check
npm run build
node scripts/verify-postgres.mjs
```

真实数据库验证器自建临时 PostgreSQL，跑所有迁移、旧 schema 回归、同侧/对侧竞争、单号联系人投影、查询日志、权限、交还与清理。双会话屏障确认：已认证但等锁的管理请求在清理撤销凭证后不得恢复联系方式。再执行 pg_dump、加密/解密、独立数据库 pg_restore 和权限复核；结束销毁临时服务。它不连接生产，也不证明云端对象存储/Auth 的完整恢复。

部署使用干净且已审查的提交、新 Vercel 绑定和私有配置：

```sh
node --env-file=.private/production.env scripts/deploy.mjs production
```

脚本要求 `DEPLOY_TARGET_CONFIRM` 等于生产 Supabase 项目 ID，`.vercel/project.json` 与 `VERCEL_PROJECT_ID/VERCEL_ORG_ID` 一致。生产部署须提供隔离云验收的 `TEST_ACCEPTANCE_SHA`，或本地真实验收的 `LOCAL_ACCEPTANCE_SHA` 和 `LOCAL_POSTGRES_ACCEPTED=true`；所选 SHA 必须等于当前提交，标记只能在实际完成检查后填写。本轮使用本地 PostgreSQL及独立前端测试，不虚构额外云端测试项目。`EDGE_SECRET_FILE` 必须是私有文件，且设置 `OCR_ENABLED=false`。执行前核对 CLI 当前帮助和部署目标。

脚本会应用迁移、设置 Edge secrets、部署 api/worker 和 Vercel；发送部署命令并不证明已成功。核对实际函数版本、health 的版本/SHA/environment、迁移历史、独立前端地址、DNS/TLS、匿名拒绝、真实双向流程后，写入发布记录。iPhone Safari、微信内置浏览器与桌面需实际验证；桌面模拟手机不替代真机。尚未完成项目明确标待验，不创建正式 runtime tag。

## 日常维护与隐私清理

管理员按单号查看两侧登记、查询日志、补充联系、核实状态与审计。普通双方直接联系；平台不发微信、短信或邮件，不把领取消息成功当作实际交还。仅管理员记录 `return` 才增加独立交还事实，重复一次不重复计数。

查看 health、登记开关、群码有效期、异常/限流、数据库与备份用量。诊断只保存请求 ID、操作标识和白名单错误码，不输出完整单号、联系或管理凭证。业务查询日志本身是私有数据，只供管理员。

查询日志和幂等元数据保留 30 天；正式登记活跃时保留。结案/撤回 30 天后清除联系方式、管理凭证、关联私密备注；保留必要匿名状态和交还统计。清理使用与登记相同的有序单号锁，撤销凭证时递增版本；不得跳过锁或把清理后的字段用旧请求写回。旧图片流程的既有清理规则继续保留，不混为本版查询日志周期。

## 加密备份与恢复

准备与数据库版本兼容的 `pg_dump/pg_restore`、私有 `SUPABASE_DB_URL`、同项目 service-role 和至少 24 字符 `BACKUP_PASSWORD`。

```sh
node --env-file=.private/production.env scripts/backup.mjs
```

备份包含 public/Auth schema、两个保留的私有图片 bucket 和社区 bucket；新增 `pdd_*` 表随 public schema 自动纳入。打包后使用 scrypt 派生 AES-256-GCM 密钥，保留最近 7 份，临时明文结束或失败后删除。`backups/` 不进入 Git；密文和密码分别保管，密文还应存放到独立可靠位置。兼容归档 manifest 的 product 标识仍为 `cmi-find-my-pdd`，不是部署到旧站。

本轮已有的范围限定备份覆盖迁移前 14 张 public 业务表和 3 个存储 bucket，已加密并完成隔离恢复检查；Auth 仅有部分元数据。它不包含完整原生 public/Auth dump，不构成完整灾难恢复证明。完整 `scripts/backup.mjs` 备份仍需私有 `SUPABASE_DB_URL`，随后重新做全量恢复；具体归档与检查结果写入发布记录，不在公开文档披露资料或密钥。

范围备份命令为 `npm run ops:backup:scoped -- backups/filename.cmibak` 与 `npm run ops:verify:scoped -- backups/filename.cmibak`。它覆盖20张固定业务表和3个存储 bucket，直接写 AES-GCM 密文；运行配置只保留安全字段，不读取 Auth/Vault。两轮完整业务表读取必须一致，变更时失败并要求在安静时段重试；即使两轮一致，也不保证数据库快照隔离或期间存储不变。恢复只用独立本机 PostgreSQL，验证全部约束、RLS、行值和存储哈希。

`backup-scoped.yml` 定于曼谷02:30执行，避开每小时第17分钟清理；只有 `ENABLE_SCOPED_BACKUP=true` 才运行。恢复验证通过后上传7天保留的加密 artifact。启用前配置其中的项目 vars、服务端密钥和单独备份密码，完成一次实际执行与下载恢复；不要只因 YAML 存在就称自动备份可用。

GitHub backup workflow 定于曼谷 02:15 执行，只有 `ENABLE_ENCRYPTED_BACKUP=true` 才运行。先配置工作流列出的 secrets/vars，实际执行、下载、独立恢复后才能记录自动备份已启用；本地数据库恢复不冒充此工作流已运行或云端全量备份已完成。

`scripts/restore.mjs` 只接受 `APP_ENVIRONMENT=test`、明确 `RESTORE_TARGET_CONFIRM` 和 `RESTORE_OFFLINE_CONFIRMED=true` 的隔离恢复目标。不得将已转换生产的 `fogncjjsnakbhfdbfvdi` 作为可清空测试目标。没有独立恢复云项目时，只运行本地验证器，不绕过脚本保护把备份回灌生产。

完整云恢复先停目标 API/worker，应用迁移建立存储 bucket，再还原。脚本取消 `cmi-durable-worker` 和 `pdd404-retention`，取消旧待处理任务，改 test runtime、关闭提交及 OCR，替换测试地址/管理员名单，再恢复白名单 bucket。核对数据、联系人、群图、统计、管理凭证与权限后才恢复测试服务。保留 ACL，不使用 `--no-acl` 丢弃 PUBLIC 执行权限撤销；Auth/JWT/管理员名单和 Vault 另行核对。生产灾难恢复需受审查的维护程序，不能直接用 test 清空流程。

## 故障、回滚与版本

故障先关闭新增登记，保留已接收资料、已可读取的联系线索与有效社区入口，记录事故 SHA、资源 ID、迁移、时间和错误码。前端与 API 回滚到上一已验证且 schema 兼容的源码；OCR 继续关闭。数据库迁移默认前向修复，永不生产 reset。

首发没有已验证旧部署时显示维护状态；无法兼容旧 API 时做保留数据的热修复，不删除用户记录。修复后重验查询、登记、权限、清理与当前联系人，再打开提交。运行标签只在生产接受后创建，文档改动不产生新部署。已应用的迁移不改原文件，后续修复增加迁移。
