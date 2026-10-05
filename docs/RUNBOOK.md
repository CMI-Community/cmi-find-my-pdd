# 首版运行、检查与版本维护

本项目独立于旧的 Chiang Mai Swap。仓库 `CMI-Community/cmi-find-my-pdd`。2026-10-06 用户通过本机配置表单明确选择把尚无用户资料的 `fogncjjsnakbhfdbfvdi` 改作测试数据库；运行配置为 `APP_ENVIRONMENT=test`，正式上线时另建独立生产库。任何发布先核对这些身份；旧站 Vercel 项目 `prj_gMEhOL3gRSNKTvATClpNbcJKIT3k` 和其他 Supabase 库禁止作为本项目目标。

## 环境建立

交互配置可运行 `npm run setup`，打开 `http://localhost:5180`。面板仅绑定本机，检查Host/Origin和随机请求令牌，配置及二维码写入已忽略的`.private/`；不会回显密钥或自动开启生产提交。OpenAI key使用安全连接器单独写入`.private/test.env`。表单选择测试环境、管理员邮箱和社区资料；保存后由维护者核对目标资源、创建管理员并接入后端。免费配额不足时，是否把尚未开放的空项目改为测试环境需本人明确选择；不能擅自暂停其他项目。

1. 测试与生产分开配置资源。免费配额不足时使用本地独立 PostgreSQL 事务测试，记录其限制，不能把它写成真实云端 OCR 验收。
2. `npm ci`，按 `.env.example` 创建私有配置。前端 `VITE_API_BASE_URL` 为 `https://项目.supabase.co/functions/v1/api`，helper再加`/v1`。其余为同项目的公开 URL 和 publishable/anon key。
3. 本地 Supabase 完整服务需要 Docker：`npx supabase start`，`npx supabase db reset`仅用于本地测试。PGlite测试会保留真实数据库逻辑、用stub替代网络/定时/对象存储，不替代线上储存和OCR测试。
4. 云端逐个应用版本迁移，再部署 `api` 与 `worker`。两函数设 `verify_jwt=false` 是因为正文内分别检查capability/管理员JWT和内部密钥；不能省略这些检查。前端缺key不能推导管理员身份。
5. Supabase Auth 关闭公开signup；由维护者创建管理员账号，确认UUID写入 `ADMIN_USER_IDS`。不要以邮箱、客户端role字段或一般认证身份自动授权。
6. 配置固定模型服务密钥、随机worker内部密钥及公共地址，确认CORS只允许产品与明确测试地址。

## 服务端配置

优先使用 Supabase Edge secrets；禁止密钥 `VITE_` 前缀或写入Git。连接器部署无法设置Edge环境时，可用Vault备用配置：

- Vault `cmi_openai_api_key`：OpenAI服务端key；`cmi_worker_secret`：32字节以上安全随机值。
- Vault `cmi_worker_url`：`https://项目.supabase.co/functions/v1/worker`，供定时唤醒使用。
- `site_settings`的`key='runtime'`：JSON包含 `APP_ENVIRONMENT`（`prod`或`test`）、`APP_PUBLIC_URL`、`ALLOWED_ORIGINS`、`ADMIN_USER_IDS`、`APP_SHA`。
- `runtime_config`只对service_role开放，不得由浏览器直接调用。API/worker每60秒刷新备用配置，不覆盖已设置的Edge环境。

设置私密值时从已授权的本地文件或安全密钥服务读取，工具只输出是否完成，不输出值。轮换后验证新值，再撤销旧值。备份排除Vault，恢复时需另行从安全保管的密钥配置恢复服务。

OpenAI 的 429 需要检查响应中的结构化错误码：`OPENAI_RATE_LIMIT` 属于临时限速，按持久任务退避重试；`OPENAI_CREDIT_EXHAUSTED`、`OPENAI_SPEND_LIMIT`、`OPENAI_USAGE_LIMIT` 和 `OPENAI_QUOTA_EXCEEDED` 属于额度或账单状态，需要账户持有人处理，不能靠重复调用恢复。Worker 只保存白名单错误码，不记录供应商原始消息、请求图片或识别内容。恢复额度后，在三次尝试范围内重试；已耗尽的扫描通过重拍建立新输入版本，不清零既有账单或改写旧任务尝试次数。[官方错误说明](https://developers.openai.com/api/docs/guides/error-codes)

## 社区配置与上线开关

管理员社区设置录入真实 HTTPS 群二维码、小助手微信/二维码、公众号名称/二维码。经本人授权公开的社区二维码上传至独立 `community-assets` bucket；这个公开库只装社区入口，不放面单、商品截图或提交者照片，且没有匿名写入权限。包裹原图与审核副本所在的两个 bucket 继续保持私有。替换二维码使用新文件名，验证可读取后再更新设置，避免缓存旧图。不得使用占位QR。`submissionsEnabled=false`为默认；资料和识别未配置时正式登记被拒绝，页面仍可显示说明。只有现场验证入口后才能打开。

二维码过期、群满或停止受理时立即更新；切换群资料不改变旧记录URL。点击已入群声明不释放任何私人资料。公众号关注是邀请，正式提交需要加群或小助手声明。

## 测试与上线

```sh
npm run check
npm run build
npm audit
```

关键验收表在`docs/ACCEPTANCE.md`。真实OCR只用虚构面单/订单截图。记录请求ID、版本、任务状态和费用，不把图/号码/微信写公开issue。必须实际验证iPhone、微信浏览器及桌面上传；桌面模拟手机尺寸不能替代真机。

发布脚本要求干净commit、新项目绑定和明确目标：

```sh
node --env-file=.private/test.env scripts/deploy.mjs test
node --env-file=.private/production.env scripts/deploy.mjs production
```

生产需要`DEPLOY_TARGET_CONFIRM`等于Supabase项目ID、`TEST_ACCEPTANCE_SHA`等于本次SHA、`.vercel/project.json`对应新Vercel项目。脚本不自动认定成功：检查Vercel部署、API health版本/SHA、数据库迁移及线上流程之后填写发布记录。

## 每日维护

管理员先处理识别异常、积压/超时/预算暂缓，再处理待核实、待联系和待交还。看每日spent/reserved、storage用量与备份；检查群二维码、小助手、公众号、health。只看请求/任务标识和错误码的日志；不得记录凭证、原OCR或个人联系。

定时器每分钟检查有任务才唤醒；已保存图片在页面关闭后继续处理。人工重试不重置费用账单；不通过修改次数绕过3次限制。预算按曼谷日期：prod4.90、test0.10，预留0.02，未知费用不释放。配置错误先修配置，不盲目重试。

未提交/纯查询24小时内清理，正式活跃证据保留。结案/撤回30天后清除图、个人联系和私密备注，匿名交还事实保留。定时清理删除对象后再删路径，失败可续跑；不要用匿名批量清库。

## 备份与恢复

`pg_dump`、`pg_restore`来自PostgreSQL17+客户端。配置私有`SUPABASE_DB_URL`、同项目service-role key和至少24字符`BACKUP_PASSWORD`。

```sh
node --env-file=.private/production.env scripts/backup.mjs
node --env-file=.private/restore-test.env scripts/restore.mjs backups/指定.cmibak
```

备份包含public/Auth数据库、两个私有包裹图片bucket及独立社区入口bucket，先打包后scrypt派生AES-256-GCM加密，滚动最近7份；临时明文目录完成或失败后删除。backups目录不进Git。恢复目标先应用完整迁移以建立三个bucket。把加密文件存到独立可靠存储，并私下保管密码；仅本机目录不足以保障主机丢失恢复。

仓库提供每日曼谷02:15执行的backup workflow。先配其列出的GitHub secrets和vars，再把`ENABLE_ENCRYPTED_BACKUP`设为`true`；加密artifact保留7天。首次手动执行、下载并独立恢复成功后才标记已启用备份。未配置时不会假报每天已有备份。

恢复只允许`APP_ENVIRONMENT=test`和`RESTORE_TARGET_CONFIRM`明确等于独立测试项目ID。先关闭目标API/worker并设置`RESTORE_OFFLINE_CONFIRMED=true`；脚本取消目标cron，恢复后取消待处理任务、把扫描环境改test、关闭提交并替换runtime为测试配置，避免生产预算/地址/任务随备份进入测试环境自动执行。恢复前确认目标空库或可销毁，验证记录/图片/统计/权限/任务后记录结果。数据库备份保留ACL；不能使用`--no-acl`丢弃RPC的PUBLIC执行权限撤销。Auth用户还需核对项目JWT配置与管理员名单；Vault配置单独恢复。测试恢复成功前不能写“备份可用”。

## 故障处理与回滚

先关闭新正式提交，保留已接收资料与持久任务；必要时暂停识别，继续显示社区联系。记录事故SHA/迁移/时间/错误码。页面/API/worker一起恢复上一已验证部署，确认schema向后兼容；数据库迁移默认前向修复，不执行生产reset。

首发没有旧部署时维持关闭入口和社区联系。若已进入新版本schema无法回退旧API，使用兼容热修复并保留数据；不要直接删除用户资料。恢复后处理积压，再打开提交。回滚具体部署ID写入发布记录。

## 版本和协作

`codex/…`分支→CI→PR→`main`。Patch修复0.1.x，新增功能下一minor。每次记录版本、SHA、资源身份、迁移、预览与生产URL、测试结果、线上验收、备份、回滚身份及未完成项。Git tag只指实际验证运行代码；文档修订不冒充部署版本。

Issue描述问题触发、预期、实际、脱敏请求ID和环境。PR写具体行为与验证，不上传真实样本。迁移已应用后不可改同名历史文件，新增迁移前向修复。依赖通过锁文件复现，改依赖后跑checks和实际受影响流程。
