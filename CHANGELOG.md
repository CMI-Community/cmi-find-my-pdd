# Changes

## 小时数据与简短观察 — 候选（2026-10-09，尚未部署）

- 数据页改为六项累计数、小时新增表、分色折线图和带时间戳的观察流；最近24小时及按日期查看，较早观察留在本页折叠并分页读取。可见页面自动刷新，采样缺口保持空格和断线。
- 新增同口径小时快照、与原日汇总共享预算和事务的小时埋点、公开白名单接口，以及管理员公开素材与独立项目群发表入口。已提供的真实群码留在忽略目录，尚未上传或发表。
- 新增规则筛选、只允许事实ID的模型选择与独立调用预算。现有密钥一次合成验收返回429，用户选择之后换可用密钥，AI本次保持disabled；小时数据采样独立运行。完整候选界面和最终检查仍在进行，五分钟监控保持原样。见[候选记录](docs/releases/2026-10-09-hourly-insights.md)及[观察规则与提示词](docs/HOURLY_INSIGHTS.md)。

## 微信号填写与就近纠错 — 已上线（2026-10-09）

- 各处联系方式入口共用虚拟个人主页示意与字段旁错误，提交无效输入时定位并聚焦；提示可能误填昵称，保留草稿。
- 修正前端/API/数据库的下划线开头微信号限制，保留历史长度兼容；完整检查、构建、实际PG事务/恢复通过；数据库/API30/前端已发布，13份真实静态产物与手机联系方式检查通过，候选/生产各1183组合完整封存。详见[验收记录](docs/releases/2026-10-08-wechat-contact.md)。

## 数据洞察与传播工具 — 已上线（2026-10-08，验收跨至10月9日）

- 实现 `/insights`、`/share` 与官网导航：六项累计统计、7/30 天真实快照、审核日报/共用来源目录、帮助问题索引、独立项目讨论群，以及文案复制、漫画和素材包下载。
- 新增服务器日采样、不可变审核发布版本、管理员批准 SHA/乐观版本核对、独立公共素材 bucket 和范围恢复支持。草稿不自动公开，缺少二维码/新闻/视频如实展示；原查件统计与五分钟监控保留。
- PR #47通过CI并合并，数据库→API29→前端已发布，实际运行SHA `0150ff9`。15项真实接口/路由与12份静态文件核对通过；完整本机检查、实际PG事务/并发和28表加密恢复通过。生产界面归档、内容审核及定时任务状态分别记录于[发布记录](docs/releases/2026-10-08-insights-outreach.md)。

## 首页六项统计 — 已上线（2026-10-07）

- 按已接受方案上线“快递单号／收件人名”各三项统计，原三项累计口径保留；增加按正式登记记录累计的两侧姓名线索及已匹配姓名线索。首次姓名保存、实际返回前20条的首次命中标记跨更名、撤回与隐私清理保留，分页探测及未返回记录不计，历史匹配不推测回填。
- 公开统计响应限制为六个计数字段；内部记录引用及时间标记不进入公开DTO。保留既有公开统计最长30秒服务端缓存，不把缺少字段或失败响应当作真实零值。
- 真实PostgreSQL事务、并发、回填、ACL和新旧测试dump恢复、迁移前实际生产范围恢复，以及完整 `npm run check` / `npm run build` 通过；PR #45已合并。数据库→API28→前端已发布，运行SHA `fbb6e99`，姓名匹配统计于2026-10-07启用。基线961项、候选987项和生产987项均完整封存；真实线上四组合及三种宽度通过只读验收。
- 迁移后生产范围导出被自动审批在启动前拒绝，仍待用户对本机加密备份及恢复的明确授权；未重试或导出。实际版本、快照与验证边界见[发布记录](docs/releases/2026-10-07-home-six-stats.md)。

## 工作流变更 — 2026-10-07（未产生应用部署）

- 新建并自动应用 [release-ui-snapshots skill](docs/skills/release-ui-snapshots/SKILL.md)：界面修改前保存当前版本全状态，发布前保存候选版，验收后保存生产版。固定归档到 `output/playwright/releases/`，分别记录实际前端/API SHA、状态覆盖、离线图集及文件哈希；历史快照不覆盖，缺口不冒充完成。
- 增加归档校验脚本和 PDD404 用户可见状态清单，并将先拍后改规则写入 `AGENTS.md`。涉及私密结果、管理、认证和相机的状态用隔离合成数据拍摄，不为截图写入生产资料。
- 整理既有发布总索引及下述历史变更。此次没有应用界面变动或新运行部署，也没有补拍或追认历史全状态快照。

## 已核对正式发布变更 — 2026-10-06 至 2026-10-07

本节于 2026-10-07 根据现有 14 份发布记录及本地 Git 历史整理；本次未重新查询云平台或验收线上版本。没有补编版本号、发布时间或缺失部署身份。完整运行 SHA、部署 ID、CI、验收及剩余限制见 [发布记录总索引](docs/releases/README.md)。本次更新仅归档历史，不产生新的运行部署。

### 2026-10-07

- 增加[收件人名查询与独立姓名线索](docs/releases/2026-10-07-recipient-name.md)：四种首页组合独立保存输入及队列，姓名查询/登记/本人更正与撤回/管理员处理，严格公开投影及原包裹计数隔离。数据库、API和首次前端为 `43ea784`（PR #41）；随后悬停颜色补丁仅发布前端 `f645f26`（PR #42），API保持 `43ea784`，不能把两者或后续归档提交当作同一运行版本。
- [恢复紧凑首页并加入社区侦探团两幕插画](docs/releases/2026-10-07-home-detective-scenes.md)，按手机/桌面采用对应构图，查询文字统一为“查找”；前端 `4d2bc4b`（PR #39）。
- [调整找包裹/找失主入口](docs/releases/2026-10-07-home-mode-entries.md)，完善选中态、输入引导和正式登记感谢。实现 PR #33，最终前端构建 `a85c6d7`；此前统计路由异常的中间部署经静态重发恢复，两个阶段分别记录。
- [补全 JTTH 集运单号全栈拦截](docs/releases/2026-10-07-domestic-waybill-guard.md)，覆盖查询、批量登记、历史补联系及幂等入口；运行源码 `90a23bc`（PR #32）。
- [启用页面统计及私有容量监控](docs/releases/2026-10-07-analytics-monitoring.md)，记录真实采集、停留区间、服务/数据库探测与通知边界；初次运行 `fc6354b`（PR #31）。修复生产主机默认采集，前端 `6bc9752`（PR #36）；连续监控历史为 PR #34，整项目容量口径修正为 PR #38，后者只更新数据库函数，未重新发布前端或 API/worker。

### 2026-10-06

- [正式部署完整国内单号主流程](docs/releases/v0.2.0.md)：本机条码解码/手输、精确对侧查询、批量登记、能力回执、管理员日志与实际交还单次计数。核心 `85b4080`（PR #8），主流程保持不依赖 OpenAI、OCR写入关闭。扫码反馈与密码恢复改进为 `442b7be`（PR #9）；桌面相机选择、镜像、调焦和恢复为 `df8e686`（PR #11）。
- [帮助页、拍照条码识别与首页简化](docs/releases/2026-10-06-help-photo-scan.md)先发布 `64bd091`（PR #13–#14），保留用户复测失败报告；随后固定拍照/关闭/状态操作栏修复发布 `3597300`（PR #16）。
- [横向取景与预加载 WASM 解码](docs/releases/2026-10-06-wasm-horizontal-scanner.md)发布 `1848fe1`（PR #18）；[帮助入口统一“帮助 Help”](docs/releases/2026-10-06-help-entry-label.md)发布 `4f45c65`（PR #20）。
- [新增真实首页统计、登记说明、管理员反馈及严格疑似线索](docs/releases/2026-10-06-stats-notes-feedback-fuzzy.md)。业务冲突超时通过新增迁移修复；最终源码 `8955ce1`（PR #22–#23），疑似线索不公开联系/说明、不计入匹配统计。
- [查询前显示 JTTH 国内单号提醒并简化统计展示](docs/releases/2026-10-06-domestic-waybill-reminder.md)，源码 `be64248`（PR #25）；此阶段只有客户端拦截，完整服务器限制在次日发布。
- [帮助页改为六步操作和四条必读提醒](docs/releases/2026-10-06-help-clear-steps.md)，源码 `2fff319`（PR #27）；[新增 CMI 官网入口并使用用户提供的原始社区 logo](docs/releases/2026-10-06-cmi-official-links.md)，源码 `8b64a05`（PR #29）。

### 覆盖与验收限制

- 发布归档包含成功、故障修复、中间异常及待验收状态；尚未与平台全部历史部署逐项对账，不能声称每次部署已完整覆盖。
- 此前历史截图散落于忽略Git的 `output/` 等目录，未保存逐版本完整用例状态矩阵；此前姓名发布的16张图只覆盖所列首页组合/视口/悬停。本次六项统计的完整基线、候选及生产矩阵另行归档。
- 新版真实面单、物理相机及微信扫码验收限制按原记录保留。本次本地未发现运行标签，不因补日志宣布完整验收。

## v0.1.0 — in development (2026-10-05)

- Independent photo-only package assistance application and MIT repository.
- Durable uploads, private evidence, typed matching, capability management.
- Administrator verification, contact follow-ups and actual handover accounting.
- Atomic OCR budgets, lease fencing, RLS and retention jobs.
- Versioned specification, acceptance tests and encrypted backup tooling.
- Separate public community QR storage, private parcel buckets, and community-asset backup coverage.
- Explicitly reclassify the empty cloud resource as test after the local setup form selection.
- Classify OpenAI credit and spending errors separately from transient throttling; stop automatic retries for exhausted quota.

This entry describes source changes, not a completed production deployment.
