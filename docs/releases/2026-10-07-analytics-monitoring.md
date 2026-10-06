# 页面统计与容量监控正式启用

日期：2026-10-07，Asia/Bangkok。目标为独立 [PDD404](https://pdd404.app)，不涉及旧交换网站。用户授权页面、流量、操作、停留统计及服务/数据库预警，并确认 Codex 与账户邮箱两处都要；未购买付费升级。

## 已上线内容

- `/admin` 的“数据与监控”显示真实收到的页面/动作计数、每日浏览图、可见停留区间、采集日预算与数据库压力。汇总按 UTC 日保留30天，没有访客身份、UV、留存或跨访问路径。
- 公共页面只发送固定枚举及计数；不发送单号、联系、备注、原始 URL、查询参数、fragment 或管理凭证。管理/分享/未知路由不采集，遵守 DNT/GPC。每文档最多四个8KiB批次，不持续心跳、不重试；生产初始每日事件预算20000，独立于业务计数。
- Vercel Web Analytics 原生页面流量与 Speed Insights 免费性能采集已验收。付费自定义事件、Speed Insights Plus、Observability Plus 与原生付费 Alerts 未启用。Hobby 平台本月实际账单流量/请求用量未能读取，不能写成零。
- 私有服务探测验证业务就绪、数据库真实空间/连接/锁等待/长事务/死锁及采集预算；数据库/配置失效时 health 返回503。公众无法读取监控资源。固定结构日志记录安全路由、状态及耗时，成功采样10%，错误和慢请求全部记录。
- 三个允许公开的配置/计数 DTO 使用实例内30秒缓存，减少数据库读取及限流写入；该缓存不减少 Edge 请求次数，不是全局 CDN 缓存。

## 运行源码与发布证据

- [PR #31](https://github.com/CMI-Community/cmi-find-my-pdd/pull/31) 合并后运行源码 `fc6354b38b9774c898b9d3b89166adb5bd886818`；[PR CI 37506090033](https://github.com/CMI-Community/cmi-find-my-pdd/actions/runs/37506090033) 与 [main CI 37506287000](https://github.com/CMI-Community/cmi-find-my-pdd/actions/runs/37506287000) 均通过。
- 本机 `npm run check`、`npm run build`、真实隔离 PostgreSQL 事务/并发预算/权限与加密恢复检查通过。12个并发写入任务没有越过50事件测试预算；旧21/20表备份与新23表恢复均验证。浏览器合成 API 验证私有路由关闭统计、DNT、批处理及停留逻辑，不连接业务数据。
- 独立 Vercel 项目 `prj_2ZsOkEmm84ZwOKOgtR5ZGYq8vwcp`，部署 `dpl_9me1g66ZRu6ZCLEdccaqUwJRoUje` READY，并绑定 `pdd404.app`。公开 JS `index-DcRTP4RU.js`、CSS `index-Dy1gE_7W.css`。构建服务端密钥扫描通过。
- 专属 Supabase `fogncjjsnakbhfdbfvdi`，迁移 `20261006173511_pdd_telemetry`、`20261006173529_private_service_monitor_v2` 已生效，实际迁移注册版本与仓库一致。运行标识事务更新并写 `pdd404_monitoring_release` 审计，OCR仍关闭。
- API24 ACTIVE，bundle SHA-256 `66505380b3c21e7bac7ab67101746e23722d4cebfad93ed52b8ee040cb2356e2`；worker24 ACTIVE，bundle `5434f789bc1a1f42b14d3fa21fef97049f782e4b3884c2d9374be973b25c8ccc`。17:53:21 UTC实际 health 返回 `ok=true, ready=true` 与上述源码 SHA；无监控密钥的 ops 返回403，未登录 admin system/analytics 返回401。

本记录描述该次运行版本的上线验收。并行合入的国内运单保护等后续发布各自以对应记录为准；文档/工作流改动不代表重新部署前端或后端，未创建运行标签。

## 实际统计验收

真实公开首页→帮助页访问：Vercel Web Analytics 两次 POST200，Speed Insights vitals POST200，第一方 telemetry 两次 POST202。原生 payload 的页面地址为无查询参数的规范化路径。验收浏览器使用明确记录的普通 headed Chrome UA 与 `webdriver=false`，因为原生 SDK 会主动忽略自动化浏览器；没有伪造平台响应。

授权只读 SQL 随后确认当天正式汇总包含首页/帮助页各一次 page view、一次 help open，以及首页30–59秒/帮助页1–2分钟可见停留，合计五事件。这些是维护者的验收访问，不是新增真实用户或包裹恢复。DNT=1 新文档不加载 SDK、不发第一方事件。随后通过现有真实管理员会话只读验收“数据与监控”：服务正常、数据库14.7MB、连接9/57、无等待，采集22事件/6批次；每日浏览图、停留分布和明细实际显示，7/30天范围可切换。没有修改任何登记资料。

## 并行发布后的采集修复及最终版本

后续国内运单保护静态发布省略了可选统计构建标志，18:06左右实际公开页面未加载采集脚本。没有补造该窗口的历史访问。[PR #36](https://github.com/CMI-Community/cmi-find-my-pdd/pull/36) 修复为仅在生产构建的两个正式主机默认采集，显式false仍关闭，开发/预览/其他主机默认关闭，付费自定义事件仍单独opt-in；隐私和批预算边界保持。

- PR CI [37509001987](https://github.com/CMI-Community/cmi-find-my-pdd/actions/runs/37509001987)、合并main CI [37509188046](https://github.com/CMI-Community/cmi-find-my-pdd/actions/runs/37509188046) 成功；本机完整检查234项Vitest、44项Edge及构建通过，一项既有可选恢复测试条件性跳过，真实迁移/恢复检查见前述结果。
- 最终前端源码 `6bc97521e92bff7f905c35daefefc16fbe0457ea`，包含已合入的运单保护与首页双模式改动。不提供三个可选统计标志重新构建，公开端点为独立生产项目，服务端密钥扫描通过。部署 `dpl_GAEfX9pNs9y4kLaBCEFBFc8eFRFZ`，18:11:49.117 UTC READY，主域与www绑定；JS `index-CLrbj8j8.js`、CSS `index-B9Lzqg-U.css`。六个线上文件HTTP200，大小与SHA-1逐一符合本机构建。
- 最终真实首页→帮助页访问：两个SDK脚本HTTP200，Web Analytics两次POST200，第一方三事件批POST202，管理员配额从19增至22，确认入库。DNT新隐私文档不加载SDK、不新增采集请求。本次10%性能抽样未看到vitals POST，不强制或伪造样本；部署平台metadata确认Web Analytics及Speed Insights均`hasData=true`，此前真实vitals200证据保留。
- 后端保持独立运单保护运行SHA `90a23bce538518e85311fa7bd8db3572f822c714`，API26 bundle `92d2d90f684b117a91b3d32fda7173d1189564b05ce2a3ec91338cdc55299340`、worker25 bundle与前述监控worker相同。本次默认采集修复没有重新部署后端代码，也未回退并行修复；前端与后端源码标识分别记录，不冒称同一部署。
- 18:12:36 UTC最终探测网站200、服务就绪、697ms；数据库14,735,027 bytes、连接7/57、无等待/死锁，CPU采样约3.2%、内存约57.7%、无告警。记录及通知设置说明的后续文档提交不是新运行部署，未创建运行标签。

## 定时检查、通知及备份

- [PR #34](https://github.com/CMI-Community/cmi-find-my-pdd/pull/34) 的连续采样缓存已合入main，CI 37508336998通过。本机完整检查228项Vitest、44项Edge及构建通过。云端首样本[37508592132](https://github.com/CMI-Community/cmi-find-my-pdd/actions/runs/37508592132) 正确报告尚无基线，仍保存并验证安全状态；后续[37508717637](https://github.com/CMI-Community/cmi-find-my-pdd/actions/runs/37508717637) 实际恢复缓存、计算CPU约2.8%、无告警，重新保存并验证缓存。这不是站点停机。
- GitHub `ENABLE_SERVICE_MONITOR=true`；[首次独立云检查 37507252437](https://github.com/CMI-Community/cmi-find-my-pdd/actions/runs/37507252437) 成功，检查网站、就绪、数据库及 Supabase Metrics API。计划每五分钟执行，GitHub schedule 可能排队。
- Codex 当前线程心跳 `pdd404` ACTIVE，每五分钟执行私有采样并核查云监控/备份；新增或升级告警、恢复、监控失败才通知，并向认证 Gmail `me` 发送同一安全摘要。邮箱通道测试实际发送成功；发送成功不代表用户已经阅读。健康及相同持续告警不反复发信。
- 17:56:21 UTC两次服务探测约2.49/2.88秒触发 `SERVICE_SLOW`，真实告警信已发送；17:57:19 UTC探测回落至576ms并发送恢复信。该时段无锁等待/死锁、CPU约2.5%，没有证据认定数据库过载。一次沙盒网络阻断的探测被标记为本机检查故障并立即联网复核，没有对外误报网站停机。
- Codex/Gmail详细告警与恢复通知依赖本机与应用运行；独立云工作流不依赖本机。已只读核查当前GitHub账户设置：Actions Email及Failed workflows only均开启，原生失败邮件走GitHub默认通知邮箱（与Gmail可能不同）。没有修改账户设置；实际失败邮件收件仍未验证，不承诺本机关闭时详细Gmail即时送达。平台月额度尚无可用自动读取，需要核查 Usage 页，不能用数据库网卡字节冒充账单出站流量。
- 迁移前加密范围备份离线恢复通过：21表、2023行、4个 Storage 哈希。上线后的[云端范围备份及恢复 37507407414](https://github.com/CMI-Community/cmi-find-my-pdd/actions/runs/37507407414) 成功：23表、2128行、4个 Storage 哈希；两次读取一致，加密 artifact 保留7天。该工作流快照使用并行已合入的 main `90a23bce538518e85311fa7bd8db3572f822c714`，不代表本记录的前端/后端已重新发布该版本。范围备份不是原生 Auth/Vault 全库恢复；持续统计写入可能打破安静窗口，失败必须告警。

## 容量判断与已知边界

18:02:48 UTC复查服务运行标识已经由独立的国内运单保护发布推进至 `90a23bce538518e85311fa7bd8db3572f822c714`，监控接口继续就绪，探测438ms、CPU采样约4.9%、内存约59.1%、无告警；本记录未回退该后续版本。

当前计划实核为 Vercel Hobby + Supabase Free/Nano（最多0.5GB内存、60数据库连接）。17:57:19 UTC快照数据库14,726,835 bytes，约500MB阈值的2.9%；客户端连接9，可用非保留上限57；没有锁等待或死锁。

按已测首页两张公共图片179,122 bytes，Free 5GB缓存出站额度、预留30%计算，约19,500次全冷图片对加载/月、平均650次/天。这是预算模型，不是保证PV或同时在线人数。精确未命中后的模糊扫描随登记数增长，隔离本机合成实验不能折算为 Nano 的生产 RPS。没有进行生产压测，也没有证据保证成百上千人同时查询。

集中推广前优先处理图片出站、模糊查询成本及 Supabase 配额，并考虑独立同规格云环境阶梯测试；Supabase Pro基础从USD25/月起，Vercel Pro是另一个独立决定。详细平台口径、测量及建议在 [CAPACITY.md](../CAPACITY.md)，操作和规则在 [MONITORING.md](../MONITORING.md)。
