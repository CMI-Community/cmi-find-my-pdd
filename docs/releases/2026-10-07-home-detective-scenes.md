# 原版首页恢复与社区侦探团插画（2026-10-07，曼谷）

状态：已通过PR检查、合并并发布到独立 `pdd404.app`，真实生产页面与静态资源验收完成。不创建运行时发布标签；本记录随后通过文档PR归档，不代表再部署。

基线：最新主线 `58cf12a`；实施分支：`codex/pdd404-detective-scenes`。仅选择性恢复 `90a23bce` 的首页视觉，不回退后续统计、监控、配额、扫码或登记修复。目标为独立 PDD404。

## 改动

- 恢复主标题、紧凑模式入口、一体搜索条及原字号与间距。标题两行分别为“我的拼多多快递 / 去哪了？”、“你的拼多多包裹 / 在我这儿！”。
- 入口为放大镜“找包裹”和手托爱心“找失主”；两模式统一“查找”和原输入占位提示，扫码说明及帮助页同步名称。模糊字符提示明确拆为两行。
- 四个本域名透明WebP资源分别提供桌面与手机构图，共享同组虚构人物和道具，表达社区自嘲与协作。[制作说明与提示词摘要](../design/home-detectives.md)。
- 两组背景常驻、按模式淡化切换，装饰图层不拦截操作，支持减少动态效果；查询、扫码填号、登记和服务端确认感谢逻辑保留。

## 本机验证

- `npm run check`：236个Vitest测试与44个Edge测试通过；1个真实PostgreSQL检查按既有条件跳过，本次没有数据库迁移。
- `npm run build`：最终构图版本通过。
- 浏览器模拟320、390、561、768、801、1280像素，两种模式标题完整、表情和动作可辨认，无横向溢出；切换前后标题与搜索框的位置及高度一致。两幕手机截图逐张检查并经独立复核。
- 装饰图层不接收指针操作；减少动态效果时过渡为0秒。手机使用独立构图，桌面人物避开页眉。
- 合成单号验证：输入不自动查询，点击“查找”才发请求；JTTH提醒阻止查询；未匹配只进入本机待提交队列，不出现正式登记感谢。
- 本机预览使用回环地址及浏览器拦截的合成统计/社区响应，不提交生产单号或联系方式。
- 本次不修改相机与解码代码；真机及微信浏览器扫码验收不由模拟视口截图代替。

## PR与真实生产发布

- [实现PR #39](https://github.com/CMI-Community/cmi-find-my-pdd/pull/39) 已合并；运行代码为主线 `4d2bc4ba2ee1ea0e2f789e1354c73309b6669266`。PR [Check 37517514970](https://github.com/CMI-Community/cmi-find-my-pdd/actions/runs/37517514970) 和合并主线 [Check 37517760002](https://github.com/CMI-Community/cmi-find-my-pdd/actions/runs/37517760002) 均成功，包括真实PostgreSQL事务与加密备份恢复验证。
- Vercel独立项目 `pdd404` / `prj_2ZsOkEmm84ZwOKOgtR5ZGYq8vwcp`；部署 `dpl_4DeeNgDJL7J1ULAVGzVd6yLhQaDD`，`READY` / `production`；ready时间 `2026-10-06T19:17:40.968Z`（曼谷2026-10-07 02:17:40）。部署地址：[pdd404-jh6w0678d-guanchao71-gmailcoms-projects.vercel.app](https://pdd404-jh6w0678d-guanchao71-gmailcoms-projects.vercel.app)；正式别名包含 `pdd404.app`、`www.pdd404.app`。
- 从上述合并SHA构建，沿用已验证的完整 `dist` 静态上传包装：10个公开文件及 `vercel.json`，部署级 `buildCommand=""`、`installCommand=""`、`outputDirectory="."`、`framework=null`；安全响应头、SPA路由及生产统计构建开关保留。未使用 `--prebuilt` 或全栈 `ops:deploy`，未改变项目全局构建设置。
- 2026-10-06T19:18:20Z只读验收：正式首页meta、部署metadata均为运行SHA；10个公开文件（包含全部4张透明WebP）的大小与SHA256逐一匹配本机构建。`www`的 `/help?release=...` 以308跳转正式域名，路径与参数保留。
- 生产浏览器实际检查320、390、1280两种模式，图片全部加载，手机/桌面分别使用对应构图，无横向溢出；两种模式标题、搜索框的位置及高度一致，减少动态设置为0秒。分别保存两幕手机首页截图，逐张确认标题及人物表情清晰、动作能接上故事。首页→帮助→首页运行无page error，帮助文案为“查找”。
- `/_vercel/insights/script.js` 和 `/_vercel/speed-insights/script.js` 均HTTP200、`application/javascript`，真实浏览器也加载成功。本轮仅确认脚本服务和页面运行，不据此宣称统计报表或新的性能样本已生成。
- 生产API `/health` HTTP200，`service=pdd404`、`environment=production`、`ok=true`、`ready=true`；实际后端SHA仍为 `90a23bce538518e85311fa7bd8db3572f822c714`。本次只发布前端，未部署API/worker、迁移数据库或改密钥/群码；线上验收不查询或登记测试业务资料。
- 上一可恢复前端部署：`dpl_6r64BXmwTPKzxByAxzw6fof5MAWU`（运行SHA `a85c6d71c0088e42d1136914a880783851f8cddf`）；保留用于回滚，没有执行回滚。
