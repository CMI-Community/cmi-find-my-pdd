# PDD404 统计与监控

上线状态以 `docs/releases/` 记录为准。本文描述代码、配置和操作方法。

管理员进入 `/admin` → **数据与监控**。可查看页面浏览、查询/登记/扫码/反馈等动作、可见停留区间以及数据库压力。站内汇总不采集身份，因此没有UV、跨访问留存或用户路径追踪；它显示真实收到的事件次数，不是平台完整访问总量。UTC日期聚合保留30天，界面探测时间显示曼谷时间。

## 配置

- 前端的 `VITE_FIRST_PARTY_ANALYTICS_ENABLED`、`VITE_WEB_ANALYTICS_ENABLED`、`VITE_SPEED_INSIGHTS_ENABLED` 未设置或为空时，仅在生产构建且实际主机为 `pdd404.app` / `www.pdd404.app` 时默认启用，避免并发静态发布遗漏构建标志而丢失采集。开发环境、预览域名和其他域名默认关闭；显式 `true` 可为隔离测试启用，显式 `false` 始终关闭。`.env.example` 的三个示例值均为 `false`，复制到生产配置会覆盖上述默认值，应按真实部署意图设置。服务端仍需 `TELEMETRY_ENABLED=true`；预览测试使用隔离假API。
- `TELEMETRY_DAILY_LIMIT` 为每日事件数量上限，最高100000；生产初始采用20000。另有每日20000批硬上限。每次页面文档最多四批，最多每60秒或离开/隐藏时批量发送，不重试。超过预算不写入、返回明确 `accepted=false`，不假报成功。
- `MONITOR_SECRET` 为32随机字节hex，仅服务器/维护者私有环境保存，调用时使用 `x-monitor-secret` 请求头；`MONITOR_DATABASE_LIMIT_BYTES=500000000` 为目前Free套餐保守空间阈值，升级后按实际限制修改。
- Vercel Web Analytics、Speed Insights还要求对应项目服务可用；前端启用遵循上述主机/构建标志规则。`VITE_ANALYTICS_CUSTOM_EVENTS` 始终要求显式 `true`，只用于支持自定义事件的Vercel Pro；站内动作与停留汇总不要求Pro。代码默认值不能证明平台成功收到数据，每次生产发布仍需以真实公开页面访问验收脚本及采集请求。

上述默认规则适用于包含PR #36的最新main构建。当前首页任务的`a85c6d7`静态运行版本采用显式开关，已单独验证采集；下一次应从包含默认修复的最新main构建，具体版本见发布记录。

原生Web Analytics的项目开关已通过官方API启用。Speed Insights脚本在当前Hobby上返回有效JavaScript；官方切换接口尝试开启Plus返回402（要求Pro/Enterprise），因此未开启Plus或购买升级。免费性能采集已取得真实vitals POST200及平台`hasData=true`证据，按10%抽样；某一次访问未产生性能请求不能据此判断采集关闭。每次后续发布仍需核查。

## 健康检查与告警

`GET /v1/health` 的数据库/配置失败返回503。`GET /v1/ops/status` 用监控密钥读取资源；`GET /v1/admin/system` 用既有管理员JWT读取。公众不能读资源、私密事件汇总或管理资料。

容量修正迁移的`databaseBytes`为`pg_database`内全部数据库大小之和，包含模板库，与Supabase项目数据库配额口径一致；它不是WAL或整个磁盘占用。500,000,000字节阈值保持，70%/85%告警按该总量计算。监控状态的固定`databaseScope=cluster-v1`使旧单库或未知口径的增长基线重新建立，保留可用CPU/延迟历史，避免把口径变化误报为数据暴涨。应用迁移后再启用新版监控脚本；恢复或更换实例后同样需重建增长基线。

```sh
node --env-file=.private/cloud.env --env-file=.private/monitor.env scripts/monitor.mjs
```

脚本并行读取正式网站、私密服务/数据库探测，以及已实测HTTP200的Supabase Metrics API。只解析CPU累计计数、可用内存和负载数字，丢弃Exporter全部标签，不能记录含SQL的指标标签。私有 `.private/monitor-state.json` 保存上次资源及告警状态，不保存凭据、联系或输入。

| 信号 | 实现规则 |
| --- | --- |
| 站点/服务/配置/登记 | 探测失败或登记未就绪为告警，恢复后给一次恢复通知 |
| 数据库空间 | 70%预警、85%严重；跨至少一天的增长基线预测七天内到顶 |
| 数据库连接 | 可用非保留连接80%预警、90%严重 |
| CPU | 相邻两段采样均70%预警或85%严重；首样本没有CPU比例 |
| 内存 | 90%使用为严重；连续两样本80%为预警 |
| 数据库异常 | 锁等待、空闲事务、事务超30秒、新增死锁 |
| 延迟 | 数据库探测1500ms告警；连续两次站点/服务探测2000ms告警 |
| 采集不可用 | 明确报告指标未知，不将读取失败当作正常或零用量 |

脚本的耗时是单次探测，CPU是采样间平均；均不冒充业务查询p95。业务日志记录安全的固定路由、响应状态、耗时、数据库调用次数/累计耗时，成功采样10%，错误及慢调用全部记录。请求体、完整路径/参数、单号、联系、JWT和凭证不进入诊断日志。使用Supabase日志平台查看实际请求错误率及延迟分布。

Codex线程心跳每五分钟运行该脚本，只在新增/升级告警、恢复、监控故障或需操作时通知；按维护者要求同样发送到其已连接Gmail账户 `me`。相同未变化告警不重复发邮件。Codex本地调度依赖当前主机/应用可运行。另有GitHub Actions `PDD404 service monitor` 五分钟定时云检查，不需要本机开着；检查失败以失败运行呈现。已只读核实当前GitHub账户的Actions Email与Failed workflows only开启，发送到GitHub默认通知邮箱；该邮箱与已连接Gmail可能不同。配置已验证，实际原生失败邮件收件未验证，不冒称送达。GitHub schedule可能排队或延迟。Vercel原生付费Alerts/Observability Plus目前不购买。平台基本流量与日志控制台已存在，新增应用日志覆盖Supabase后端。

云工作流仅在`main`运行，用官方`actions/cache/restore@v4`和`actions/cache/save@v4`跨运行保留`/tmp/pdd404-monitor-state.json`。每次保存使用唯一运行ID/重试次数键，下一次用前缀恢复最新状态；即使本次监控因告警退出1，也保存新状态。因此在主机关闭时，云端也能比较CPU计数、连续延迟/内存和死锁变化；数据库增长预测在保存的基线跨至少一天后才具备数据。缓存只含明确白名单的数值资源、日期、公开发布SHA及固定告警枚举，不含凭据、单号、联系、SQL或Exporter标签；缓存不是私密存储，能读取仓库缓存的人可以看到这些资源汇总。[GitHub缓存的可见性与键匹配](https://docs.github.com/en/actions/reference/workflows-and-actions/dependency-caching)

首次运行、缓存缺失/损坏/超过30分钟未更新，或CPU计数重置时，云检查报告`MONITOR_BASELINE_UNAVAILABLE`，继续探测网站/数据库/内存并保存新样本；下一次有效采样后恢复比较。CPU持续高占用仍需要两段有效增量，不能从首个累计值推出使用率。缓存恢复失败另报`MONITOR_CACHE_RESTORE_FAILED`。官方保存动作可能只写警告而返回成功，所以保存后再按本次唯一键只读查找并断言命中；未真正保存会使工作流失败，不将丢失监控历史标为正常。GitHub可能清除缓存或延迟调度；此状态仍不是托管时序数据库，也不保证通知到达。[官方保存实现](https://github.com/actions/cache/blob/v4/src/saveImpl.ts)

Vercel月用量接口受到平台功能限制，账单接口不可用不是零用量；已实际读取标准Usage页面的团队所选30天汇总，以及Supabase组织当前账期用量，具体时间、范围与数值见CAPACITY.md。不能用Prometheus数据库网卡字节冒充账单出站流量。Codex在本机及登录态可用时每天只读核查两家Usage页，比较实际Edge、出站/CDN及采集额度60/80%阈值；失败保留未知状态，不写成零。资源压力由独立云检查覆盖，但月额度页面核查仍依赖本机，尚无独立全天候自动账单查询。需要该覆盖时优先接平台用量告警或可用账单接口，账户创建、条款和费用须另行完成。

## 可逆维护

每日范围备份要求两次读取相同。新增统计汇总也受该检查保护；持续流量可能造成备份失败。定时监控应同时检查最近备份工作流成功时间，失败时告警，并安排安静窗口或受审查的维护方案；不能把失败备份称为已保存。

设置 `TELEMETRY_ENABLED=false` 可停止站内写入；将上述三个前端标志显式设为 `false` 并重新构建发布可停止对应浏览器采集，保留既有汇总。删除生产前端标志会恢复正式域名默认采集。生产数据库不reset。站内匿名采集预算与注册/匹配统计完全独立；每日上限不是整个平台月调用额度的保证，被限流/拒绝的Edge请求仍可能计费。

公开配置与统计有实例内30秒缓存，管理员配置修改清除当前实例缓存。它减少数据库读取/限流写入，不减少到达Edge的调用次数，也不是全局缓存。容量模型及尚未实测的并发见 [CAPACITY.md](CAPACITY.md)。

## 每日晚间公开观察与发表

公开 `/insights` 与 `/share` 使用正式累计统计和独立已发表内容目录，不公开管理员埋点、资源压力或原始业务行。新 `pdd404-evening-public-stats` 数据库任务每日UTC13:00（曼谷20:00）保存当日首次六数快照；函数以服务器实际采样时间归入Asia/Bangkok日期，重复执行保留首次sampledAt及数字；20点是任务计划时刻，RPC没有20点前拒绝守卫。启动生产调度前核对实际pg_cron时区为UTC/GMT、job命令与权限，并在首个计划时刻之后核对真实采样；代码或job已建立不能证明该任务已经运行。原有五分钟告警、匿名UTC日汇总预算和保留任务不改。

历史开始于新采样，不从过去有效登记报告回填。漏日、采样延迟、口径不一致或缺今日文章分别呈现；缺日不当零，跨多日增长不称昨日增量。20点采样不是完整自然日，报告必须写明各来源时间窗口。仍可按现有只读分析核查扫码、查件、登记等卡点，操作次数与正式记录分开；匿名事件含维护/重复且可能漏计，不能冒充人数、个人成功率或改版因果。没有原文的新闻不写成事实，已有帮助负责解法。

本地晚间心跳准备公开候选及分析证据，保存到Git忽略output的带日期/时间目录，保留历史，不能自动上传、发表文字或更新二维码。维护者在本聊天查看具体候选内容与SHA后明确批准，再使用管理员JWT及该审核SHA发表；每日快照采集与每日文章发表是两种状态。缺开发者码、新闻或公开视频时保持缺项，不能改用找货群或草稿视频。公网页面显示已发表版本、源日期及码更新时间，已知过期群码不继续声称可用。

CLI默认只读本地预览，不需要管理员凭据，也不发送网络请求。内容文件遵循 `shared/public-content.ts`，必须先核对当前修订，审完完整规范化SHA后才能提交。管理员JWT只放私有环境 `PDD_ADMIN_JWT`，URL通过独立 `SUPABASE_URL` 核验；不能用service-role替代本次发表授权、不能放进VITE变量或命令文本。

```sh
# 本地预览：输出确切内容及批准SHA，未发表。
node --experimental-strip-types scripts/publications.mjs output/content-review/example/outreach-candidate.json
# 管理员只读当前修订；撤回后的修订仍可核查。
node --env-file=.private/publication.env --experimental-strip-types scripts/publications.mjs --status --kind=outreach --key=main
# 本地预览公开副本的真实字节SHA，未上传。
node --experimental-transform-types scripts/public-assets.mjs output/content-review/example/image.png
```

实际提交额外使用 `--publish --approved-sha=<已在本聊天批准的SHA> --expected-revision=<该候选的修订>`；素材上传使用 `--upload --approved-sha=<已批准公开副本字节SHA>`。flag不是审批的替代品，自动心跳不能自行添加。原图不覆盖，图片只去隐藏元数据后按新字节审核；ZIP整包审核其内容和原字节，最多5MiB。PNG/JPEG/WebP与ZIP对象均以hash命名、禁止覆盖。先上传已批素材，再发表引用这些实际存在素材的目录；预定URL不证明上传已完成。

提交只尝试一次，超时/中断标为结果未知；用只读status对照kind/key/revision/action/SHA，不从错误推断未发表。409修订冲突不能静默改expectedRevision重发，须重新核对新候选并审核。撤回也经具体审核SHA追加一个版本，保留旧正文、管理员及时间审计；存储旧hash对象保持，删除公开对象是另一个需明确授权的操作。

新迁移范围快照包含 `pdd_stats_daily`、`pdd_content_revisions` 与 `pdd-public-assets`。两次表读一致及加密认证规则保持；新增版本发表时可能使安静窗口备份失败，不作无限重试。旧迁移manifest既不要求新表，也不读取新bucket。离线恢复在真实隔离PostgreSQL核对行值、RLS/RPC权限和bucket配置，存储字节SHA与hash文件名核对；它不提取公用文件到磁盘、不连接云，也不宣称恢复Auth凭据或完成素材重新部署。范围备份/恢复失败仍按原监控规则处置。
