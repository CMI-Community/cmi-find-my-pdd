# 帮助入口名称更新

页头右上角可见名称与无障碍名称统一为“帮助 Help”，仍打开 `/help`。中英文统一16px，保持44px点击高度；产品规格同步。扫码逻辑、数据库和既有登记没有更改。

- 运行源码 `4f45c65167ae5059040c08300b18e1e36504b711`；[PR #20](https://github.com/CMI-Community/cmi-find-my-pdd/pull/20)，精确检查提交 `bfb08efd2309d6ff32c8227500c182b599b59084` 的 [CI 37468240650](https://github.com/CMI-Community/cmi-find-my-pdd/actions/runs/37468240650) 成功（check、build及真实PostgreSQL/加密恢复检查）。本机check、生产配置构建也通过。
- 独立Vercel项目 `prj_2ZsOkEmm84ZwOKOgtR5ZGYq8vwcp`；部署 `dpl_AKuRnSAnrEdutKNsvMBFbmWqaHGt` 在2026-10-06 20:08:52曼谷时间READY，地址 `pdd404-qn1aksbqy-guanchao71-gmailcoms-projects.vercel.app`，正式别名 https://pdd404.app。有效HTTPS 200及HTML源码身份已核对。
- 正式浏览器360px验收：入口文本“帮助 Help”，16px、44px点击高度，点击打开“如何使用 PDD404”，返回查询正常；本机待提交列表保留，公众号/微信群图片均加载。截图在忽略的 `output/pdd404-help-label-live.png`。
- Supabase项目 `fogncjjsnakbhfdbfvdi`，API16/worker17 ACTIVE，代码bundle未改。Edge公开APP_SHA在2026-10-06 13:10:05UTC更新为本次源码，摘要 `2594fe9953fde909aa9559045400b4f1bc756edaacc1adaf26e270c9adceffa0`。数据库runtime经受保护事务及审计同步；生产health返回同一SHA、production、ready=true。没有迁移或新增测试登记。

后续文档提交与运行SHA分开记录。本次为入口文字发布，不代表此前WASM扫描的真实面单验收完成；仍无运行标签。
