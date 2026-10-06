# 首页双模式入口调整（2026-10-07，曼谷）

状态：实现已通过 PR #33 合并，首页前端已于2026-10-07 01:14（曼谷）发布到独立 PDD404 生产项目，线上页面、资源与原生统计脚本已核对。真实手机/微信扫码及用户登记验收仍待进行，不创建运行时发布标签。

实现基线：`fc6354b`；分支：`codex/pdd404-home-mode-ux`。目标产品为独立 PDD404。

## 生产发布

- 实现 PR：[CMI-Community/cmi-find-my-pdd#33](https://github.com/CMI-Community/cmi-find-my-pdd/pull/33)，合并提交 `da0b585e83339bc1eeb77918e1db20d168d43ff0`。
- 实际前端运行时 SHA：`a85c6d71c0088e42d1136914a880783851f8cddf`，包含已合并的首页入口调整、既有 JTTH 单号保护，以及随后合并的云端监控记录改动。使用最新已通过 CI 的 main 构建。
- Vercel 项目：`pdd404` / `prj_2ZsOkEmm84ZwOKOgtR5ZGYq8vwcp`；最终部署：`dpl_6r64BXmwTPKzxByAxzw6fof5MAWU`，`READY`，`production`，ready 时间为2026-10-07 01:14:07（曼谷）。
- 正式地址：[https://pdd404.app/](https://pdd404.app/)；最终部署地址：[pdd404-mhbs5cu51-guanchao71-gmailcoms-projects.vercel.app](https://pdd404-mhbs5cu51-guanchao71-gmailcoms-projects.vercel.app)。Vercel 返回的正式域名别名包括 `pdd404.app`、`www.pdd404.app`。
- 执行 `vercel build --prod` 生成生产产物，最终沿用此前的静态上传包装：六个公开文件及 `vercel.json`，部署级 `buildCommand=""`、`installCommand=""`、`outputDirectory="."`、`framework=null`，保留安全响应头、SPA 路由及原有生产统计构建开关。未改项目设置，未部署 API/worker，未修改数据库、密钥或群码配置。
- 首次 `--prebuilt` 部署 `dpl_5FbTiwiSbou3sDMynZE5uXqDVXQh` 的两个原生统计脚本被 SPA fallback 覆盖，返回首页 HTML；浏览器因 MIME 类型拒绝执行。与上一部署真实 JavaScript 响应对比后，将同一产物改用原静态上传包装重新发布，恢复原生统计路由；应用源码与六文件 SHA256 未改变。
- 2026-10-07 01:10:53（曼谷）生产 API health：HTTP 200，`service=pdd404`、`environment=production`、`ok=true`、`ready=true`；后端实际 SHA 为 `90a23bce538518e85311fa7bd8db3572f822c714`。本次只发布前端，前后端 SHA 分别记录。
- 回滚参考：上一生产前端部署 `dpl_24nTLXmF2SY9MBsjqBb3LpCz86Gx`（运行时 SHA `90a23bce538518e85311fa7bd8db3572f822c714`）。

## 线上核验

- 正式首页 HTTPS 200，HTML `pdd404-build` 与前端运行时 SHA 相符；六个公开文件的线上 SHA256 全部与本机生产构建一致。
- `www.pdd404.app/help?mode=received` 返回308到 `pdd404.app/help?mode=received`，路径和参数保持；生产 API health 正常。
- 最终部署的 `/_vercel/insights/script.js` 与 `/_vercel/speed-insights/script.js` 均返回 HTTP 200、`application/javascript`，已恢复此前发布的原生脚本服务。
- 恢复后的真实生产浏览器访问首页及帮助页：Web Analytics 的 `/_vercel/insights/view` POST 返回200，未产生 console error；本轮仅确认 Speed Insights 脚本服务，未据此宣称性能报告已经生成。
- Playwright 访问真实生产首页：320、390、1280像素两模式均显示准确标题、输入提示、查询按钮及选中状态；没有水平溢出。手机选项高度48px，桌面52px，文字完整。
- 生产浏览器使用合成 JTTH 编号验证客户端提示；没有向正式查询接口发送请求，没有提交登记、真实单号或联系方式。
- 找失主登记感谢的各类服务器回执分支在本机合成响应中验证；未为本次发布创建生产登记。真机摄像头、微信内置浏览器及真实用户完整登记流程待用户测试。

## 变更

- 首页改为“找包裹”（放大镜）与“找失主”（手托爱心）；统一线条图标、完整文字、明确选中边框与勾选。
- 入口上方加入用户指定的帮忙提示；标题、说明、输入引导、查询按钮按模式切换；帮助页同步入口与查询名称。
- 小屏显示完整输入引导，查询按钮独占一行，选项文字允许换行。
- 找失主登记感谢依据服务器返回的正式 `received` 登记；覆盖批量、新匹配时登记、匹配后可选联系提交及本机重试，不把暂存、重复、结案、失败或仅保存联系方式当成登记成功。
- 保留两侧队列、单号匹配、扫码和登记处理；扫码成功仍只填号，等待手动点击查询。

## 验证

- `npm run check`：通过，228 个 Vitest 测试与42个 Edge 测试通过；本机1个真实 PostgreSQL 检查按既有条件跳过。本次无迁移。
- PR #33 CI、首页合并提交 CI 和实际运行时 SHA 的 main CI 均成功；CI 包含真实 PostgreSQL 事务检查与加密备份恢复检查。实际运行时 CI：[37508588900](https://github.com/CMI-Community/cmi-find-my-pdd/actions/runs/37508588900)。
- `npm run build` 与 `git diff --check`：通过。
- Playwright 本机浏览器：320、390、1280像素两模式无水平溢出，完整入口文字，触控高度至少44px。
- 仅浏览器拦截的合成API响应验证：未匹配暂存不显示感谢；正式登记及新匹配登记显示感谢；重复、已结案与503失败不显示登记感谢。
- 相机及解码代码未修改，未在本次工作中执行真实手机/桌面摄像头的物理验收；不据此宣称镜头清晰度或识别速度改善。
- 本机合成流程验证的API指向本机回环地址。上线后的浏览器读取正式公开统计与社区配置；未进行生产业务写入。截图及测试产物保留在Git忽略的`output/playwright/`。
