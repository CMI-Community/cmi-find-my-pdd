# PDD404 容量与预警基线

核查日期：2026-10-07（曼谷）。仅针对独立 `pdd404.app` / Vercel `pdd404` / Supabase `fogncjjsnakbhfdbfvdi`。本文件是配置审计和容量预算，不是生产压测验收，也不是新部署记录。

## 现在的真实状态

本次通过管理接口、只读 SQL 和平台 Usage 页面核实：

| 项目 | 实测状态 |
| --- | --- |
| Supabase 组织计划 | Free |
| 数据库区域 / 版本 | `ap-southeast-1` / PostgreSQL 17.11 |
| 服务状态 | Healthy |
| 业务数据库大小 | 本次只读SQL为14,735,027 bytes，约14.74 MB；`postgres`单库，不包含模板数据库 |
| 平台数据库配额口径 | Usage页面为28.62 MB、约500 MB额度的6%；只读SQL全部数据库总和30,011,253 bytes，折合28.62 MiB，与页面一致，包含两个模板库。不能把单库14.74 MB当作整项目配额占用 |
| `max_connections` | 60 |
| 数据库活动快照 | 共 23 个活动条目、1 个 active；包含平台后台连接，不能当作 23 名访问者 |
| 业务行数 | 151 条正式登记、151 个单号、178 条查询日志；这些不是 UV、PV 或实际交还人数 |
| Vercel 计划 | 已登录 CLI 团队 API 核实 `billing.plan=hobby`、`billing.status=active`；独立项目 `pdd404` |
| Supabase Metrics API | 当前 Free 项目实测 HTTP 200，可读取 CPU、内存等 Prometheus 指标 |
| Vercel Usage页面 | 团队All Projects、Last 30 Days显示9月6日12:00至10月6日12:00（页面时区未核实）：Fast Data Transfer 294.37 MB / 100 GB；CDN请求6,388 / 1,000,000；Web Analytics 7 / 50,000；Speed Insights 6 / 10,000。是团队所选窗口汇总，不是PDD404单项目或已核实账期用量 |
| Vercel 账期/项目用量接口 | 指标汇总要求Observability Plus，billing usage未返回Hobby账期数据；所选窗口的Usage UI汇总已另行取得，接口不可用不等于零 |
| Supabase Usage页面 | 组织All projects、当前账期9月19日至10月19日：Edge调用1,849 / 500,000；缓存出站0.052 / 5 GB；非缓存出站0.012 / 5 GB。页面提示最多一小时刷新延迟；这是组织用量，不是网页访问人数 |

上述额度均未接近限额，Vercel所选窗口传输/CDN约0.29%/0.64%，Supabase缓存出站约1%。这些累计用量不能用于推算PV、UV或同时查询人数。数据库目前没有接近容量限额，但仍需要观察 CPU、内存、查询延迟、锁等待和流量增长。数据库大小低不代表瞬时查询可以无限并发。

## 平台额度与实例资源

2026-10-07 核对的官方资料：

| 资源 | Supabase Free | Supabase Pro 基础方案 |
| --- | --- | --- |
| 数据库 / 磁盘 | 每项目 500 MB 数据库限额 | 每项目含 8 GB 磁盘 |
| Edge Function 调用 | 组织每月 500,000 次 | 组织每月 2,000,000 次，超额按包计费 |
| 非缓存出站流量 | 每月 5 GB | 每月 250 GB |
| 缓存出站流量 | 每月 5 GB | 每月 250 GB |
| 基础计算规格 | Nano，共享 CPU，最多 0.5 GB 内存 | Micro，共享 CPU，1 GB 内存 |
| 数据库连接 / pooler 客户端 | 60 / 200 | Micro 仍为 60 / 200 |
| 持续磁盘 IOPS 基线 | 250 | Micro 为 500 |
| 平台日志保留 | 1 天 | 7 天 |
| 原生自动数据库备份 | 不包含 | 每日备份、保留 7 天 |

Pro 基础计划从 USD 25/月起，含 USD 10/月计算额度，可覆盖一台 Micro。升级组织计划不会自动把已有 Nano 改成 Micro；计算规格变更需要单独核实，并可能有短暂服务中断。连接数也不是允许访问网站的人数。[Supabase 价格与额度](https://supabase.com/pricing)、[计算与磁盘规格](https://supabase.com/docs/guides/platform/compute-and-disk)

Edge Function 对失败请求也计调用额度，CORS `OPTIONS` 预检不计费。额度按组织统计，监控、管理员请求、重试及同组织其他项目都需计入。[Edge Function 调用用量](https://supabase.com/docs/guides/platform/manage-your-usage/edge-function-invocations)

当前 Vercel Hobby 每月含 100 GB Fast Data Transfer、1,000,000 次 CDN 请求；不是 1,000,000 次完整页面访问。静态资源也算请求。多数免费额度耗尽后会暂停相应服务，不能假设自动付费扩容。[Vercel Hobby](https://vercel.com/docs/plans/hobby)、[CDN 用量口径](https://vercel.com/docs/manage-cdn-usage)

Vercel 的基础 Observability 已对所有计划提供。Hobby 的基础观察数据保留 12 小时、运行日志 1 小时；原生异常 Alerts 需要 Pro 和 Observability Plus。Web Analytics Hobby 含每月 50,000 个事件，不支持自定义操作事件；Speed Insights 免费额度是团队共用的滚动 30 天 10,000 个事件。分析采集达到额度会停止采集，不能把分析图没有新数据误判成网站没有流量。[Observability Plus](https://vercel.com/docs/observability/observability-plus)、[Alerts](https://vercel.com/docs/alerts)、[Web Analytics](https://vercel.com/docs/analytics/limits-and-pricing)、[Speed Insights](https://vercel.com/docs/speed-insights/limits-and-pricing)

## 怎样把额度换算成访问预算

先区分三种数字：月额度、瞬时请求吞吐、同时打开网页的人数。月额度可以按资源消耗预算；后两项需要有代表性的端到端测试，不能由计划名称直接推算。

当前客户端每次初次打开至少请求 `community` 和 `waybill-stats` 两个 Edge 接口；回到窗口焦点会重读统计，查询后及登记后也可能刷新统计。以下前三行是业务接口预算，第四行加入本次匿名埋点方案；均忽略额外刷新、管理员、重试、监控及其他项目，故是偏乐观的月额度上限：

| 使用场景 | 每次访问的 Edge 请求假设 | Free 500,000 次调用额度对应预算 |
| --- | --- | --- |
| 只初次浏览 | 2 次 | 约 250,000 次访问/月 |
| 初次浏览并查询一次 | 3 次 | 约 166,000 次访问/月 |
| 初次浏览、查询三次、批量登记一次 | 6 次 | 约 83,000 次访问/月，平均约 2,800 次/天 |
| 上一行加匿名统计批次 | 7–10 次 | 约 50,000–71,000 次访问/月；留 30% 余量后约 35,000–50,000 次/月 |

正式容量预算应留至少 30% 余量；实际以平台账单用量为准。本次匿名统计客户端以 60 秒、页面隐藏或路由退出为批量发送点，每次页面载入最多四批，不持续发送停留心跳，也不重试失败批次。服务端按 UTC 日聚合有限枚举维度，避免逐访客日志膨胀。日事件/批次上限用于防止无限写入，不能替代月 Edge 调用预算；例如每天 20,000 批持续 30 天已经是 600,000 次调用，应观察接收批次并提前预警。

本次发布前的线上资源只读快照如下，未保存页面内容、图片地址或联系信息。最终前端构建资源大小已变化，Vercel静态流量模型仅作该快照的估算；首页两张Supabase图片保持相同：

| 冷加载资源 | 实测传输字节 | 响应缓存状态 |
| --- | --- | --- |
| Vercel HTML | 803 | `HIT`，`max-age=0, must-revalidate` |
| Vercel JavaScript | 195,220 | gzip、`HIT`，`max-age=0, must-revalidate` |
| Vercel CSS | 8,328 | gzip、`HIT`，`max-age=0, must-revalidate` |
| Vercel 自动预热 WASM | 418,511 | gzip、`HIT`，`max-age=0, must-revalidate` |
| Supabase 群二维码图 | 138,712 | `cf-cache-status=HIT`，`max-age=300` |
| Supabase 公众号二维码图 | 40,410 | `cf-cache-status=HIT`，`max-age=300` |

Vercel 四项合计 **622,862 bytes，约 0.623 MB**；100 GB 对应约 **160,000 次全冷资源加载/月**。按四个 CDN 请求计算，1,000,000 次 CDN 请求额度约对应 250,000 次这类加载，故这两项中流量预算先到。这里未计分析脚本、额外页面、HTTP 开销、刷新及团队其他项目，实际缓存复用与重新验证也会改变消耗，不能解释为已验证承载能力。

首页两张 Supabase 图片合计 **179,122 bytes，约 0.179 MB**，不在 Vercel 预算内。测量当次均命中 Storage CDN，属于缓存出站流量；5 GB 缓存额度仅对应约 **27,900 次无浏览器缓存的图片对加载/月**，预留 30% 后约 **19,500 次/月，平均约 650 次/天**。这是当前比 Vercel 静态文件更早达到的预算约束，不是瞬时性能上限。API 响应、其他图片、同组织流量和不同地区的缓存未命中仍需分别统计；缓存与非缓存额度独立，不能把两者合并当作同一池。压缩公共图片和改善浏览器缓存可降低消耗，单纯 CDN 命中仍会产生缓存出站流量。[Supabase 出站流量口径](https://supabase.com/docs/guides/platform/manage-your-usage/egress)、[Storage 缓存状态](https://supabase.com/docs/guides/storage/cdn/fundamentals)

留在网页上且没有网络操作的访客不持续占用数据库连接。本产品没有普通用户 Auth 或 Realtime 订阅，所以 50,000 Auth MAU 和 200 Realtime 连接不应作为本网站访问人数上限。

## 代码中的主要瓶颈

1. **模糊查询随登记量增长。** 客户端所有查询发送 `allowPossible=true`。精确匹配、重复或结案会优先返回；精确未命中时扫描长度接近的全部活跃对侧登记，逐条执行 PL/pgSQL 编辑距离并筛选前五名。最多五条返回值不代表最多比较五条记录。当前 2 秒期限保证超时不会伪装成完整未找到，却不能保证高并发性能。现有 B-tree 唯一索引保障精确单号查找，不能加速编辑距离全表扫描。
2. **公开浏览也会写数据库。** 原有入口在 GET 前 `rate_limit_tick` UPSERT。首页两个请求原本都落到数据库，统计又执行两次 `count(distinct waybill_id)` 和一次匹配记录计数。本次发布已为三个脱敏公开 DTO 增加 30 秒运行实例缓存；缓存减少重复计数与配置读取，不减少到达 Edge 的调用次数，也不能把实例内缓存当作全局 CDN 缓存。云端生效验收见发布记录。
3. **限流与共享网络。** 每 IP、每一级路由、每分钟 GET 120 / 写请求 20，反馈另限 5；这是单来源保护，不是全站每分钟上限。酒店、学校、办公室共享公网 IP 的用户可能共享配额。超过限额的请求本身仍会调用 Edge 和写限流计数。
4. **日志和清理会持续增长。** 查询日志保留 30 天；每次查询都有日志及索引写入。当前查询时间线全局排序和到期删除没有专用 `queried_at` 首列索引；保留清理还会对所有到期单号持有事务锁。登记量/查询量增大后需要重新检查分页、清理与锁等待，而不能只删除记录期待磁盘立即缩小。

Supabase Free 数据库超过 500 MB 会进入只读状态。由于限流和查询日志需要写入，达到此限制时会影响核心查询，原来依赖写限流的公开 GET 也可能失败；静态 HTML 正常加载不能代表业务可用。删除行后 PostgreSQL 也不会立刻回收全部物理文件大小，应监控真实增长和 autovacuum。[数据库与磁盘大小](https://supabase.com/docs/guides/platform/database-size)

## 轻量本机合成验证

2026-10-07 在隔离临时 PostgreSQL 16.13、只监听 Unix socket 的集群中应用生产已有的九份迁移；只生成虚构单号和 `synthetic_holder` 联系值，未连接生产。默认 `fsync=on`、`shared_buffers=128 MB`。测试后删除整个临时集群。

| 活跃对侧合成登记 | 精确匹配，三次范围 | 完整单号未命中再扫描，三次范围 | 尾部三个未知字符，单次 |
| --- | --- | --- | --- |
| 151 | 2.25–2.51 ms | 11.66–12.63 ms | 18.73 ms |
| 1,000 | 2.29–2.90 ms | 65.50–66.41 ms | 101.28 ms |
| 5,000 | 2.32–3.20 ms | 318.79–321.29 ms | 405.78 ms |

模糊候选查询执行计划均为双表顺序扫描加 Hash Join。这支持“模糊未命中的成本随候选量增长”的代码判断。另以四个本机连接、五秒运行精确查询加限流组件验证，完成 12,779 次事务、零失败；该数据只说明本机该组件可运行，**不作为 Supabase Nano 的 RPS、并发或全天稳定性指标**。本机 CPU、存储、数据分布、连接池、HTTP/Edge 延迟及配额均与生产不同；样本也不足以提供 p95/p99。

## 应设置的预警线

这些是建议起始阈值，应在真实流量下调校；实际已启用哪些规则、通知渠道及外部监控由发布/运维记录确认。

| 信号 | 预警 | 严重 |
| --- | --- | --- |
| Free 数据库大小 | 达 350 MB（70%），或按近期增长七天内到顶 | 达 425 MB（85%） |
| 月 Edge / 出站 / CDN / 分析额度 | 60%，或预计七天内用完 | 80%，或预计三天内用完 |
| 数据库 CPU | 持续十分钟超过 70% | 持续五分钟超过 85% |
| 数据库连接 | 可用客户端连接额度的 70% | 85%；保留平台/管理员连接空间 |
| 内存压力 | 持续低可用内存或开始 swap | 持续 swap、OOM 或重启 |
| 查询 HTTP 延迟 | 五分钟 p95 超过 1 秒 | p95 超过 2 秒、出现 `QUERY_TIMEOUT` |
| 业务 API 5xx | 足量请求下五分钟超过 1% | 连续失败或五分钟超过 5% |
| 网站 / readiness | 连续两次失败 | 连续三次失败、域名/HTTPS错误、DB不可写 |
| 锁等待 / 长事务 | 等待超过五秒或异常增长 | 登记/查询受阻、死锁增长 |

CPU、内存、IOPS 和实例连接等可以在 Supabase Reports 查看，Free 能看最近 24 小时。数据库只读 SQL 快照不能替代 CPU/内存曲线。本次已实测当前 Free 项目的 Prometheus Metrics API 返回 HTTP 200，并包含 CPU、内存指标；仍需外部定时采集与告警规则，端点可读不等于已经保存长期曲线或成功送达警告。[Supabase Reports](https://supabase.com/docs/guides/observability/reports)、[Metrics API](https://supabase.com/docs/guides/observability/metrics)

预警应来自业务数据库之外的调度器；如果把通知和监控历史完全写回同一数据库，数据库耗尽时可能同时失去告警。若检查来自本地 Codex 定时任务，需要本机和应用在线，不能据此承诺全天监控；云端工作流也须核实实际运行和通知送达。第三方收集不得包含完整单号、联系方式、备注、管理凭证、请求正文或 URL fragment；状态快照只输出白名单汇总。

## 流量前的决策与后续验证

当前配置可以做小规模真实开放与观察；尚无证据支持保证成百上千人同时查询。按当前公共图片大小和 30% 余量，月流量预算应先以约 19,500 次全冷图片对加载为观察基线；不能用平均每天 650 次推导集中推广时的同时查询数。若已预期集中推广，优先在上线监控后处理图片流量、模糊查询与重复公开读取，并预留升级时间。

Supabase Pro 从 USD 25/月起，Micro 可增加内存、持续 IOPS、空间、日志和备份保障，但不会自动解决模糊扫描或提升 Micro 的 60 个数据库连接上限。Vercel Pro 从 USD 20/月起，是独立的前端平台升级；升级 Vercel 不增加 Supabase 的图片/数据库/Edge 额度，原生异常 Alerts 还要求 Observability Plus。两项需分别按实际瓶颈决策，本次审计没有启用付费方案。[Vercel 价格](https://vercel.com/pricing)

获得可信并发数字的下一步，应在独立非生产环境用合成数据和与生产相同的计算规格测试：登记量 151 / 1,000 / 5,000 / 20,000，分别包含精确匹配、精确未命中加模糊查询、未知字符和批量登记。以 1、2、5、10 请求/秒阶梯运行，每阶三到五分钟，观察 p95/p99、错误、CPU、连接与锁等待；每个来源仍保留真实限流规则。p95 超过两秒、5xx 超过 1% 或 CPU 持续超过 85% 即停止该阶，不把已经超时的结果写成查询成功。稳定通过后以最后通过阶梯的 50% 作为初始流量预算，再按实际监控调整。

生产只做低频健康读取和必要的合成验收，不进行无上限压测。没有独立云端测试资源时，本机实验只能用于比较算法趋势，不能替代生产相同规格的容量验收。
