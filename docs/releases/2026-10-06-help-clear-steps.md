# 帮助页六步操作与必读提醒

日期：2026-10-06，Asia/Bangkok。用户明确授权正式部署后，更新已在 [正式帮助页](https://pdd404.app/help) 上线，完成本次页面与公开资源验收。

## 本次内容

- 操作用六个编号步骤说明，每步只有一句话：选丢件或错收件、找完整国内单号、手输或扫码、核对后查询并联系、未匹配时正式提交、保存回执并跟进。
- 四条必读提醒集中突出显示：国内运输单号及 JTTH 限制、不再追查无需删除登记、正确联系方式，以及推荐平台并协助老人和孩子登记。
- 扫码失败、看不清字符、疑似线索及重复/失败结果保留简短操作提示；匹配原理、正式提交边界和隐私说明位于最后一个说明小节。

## 生产部署与源码

- 前端运行源码 `2fff31974d324aae4d01506e30a41adb9084e126`，来自已合并的 [PR #27](https://github.com/CMI-Community/cmi-find-my-pdd/pull/27)。精确 PR 提交 `a7dfdad72a0b4e67f77eb1a38e45d29c5587b554` 的 [CI 37485597555](https://github.com/CMI-Community/cmi-find-my-pdd/actions/runs/37485597555) 及该 main 提交的 [CI 37485857266](https://github.com/CMI-Community/cmi-find-my-pdd/actions/runs/37485857266) 均为 success；CI包含既有真实 PostgreSQL 与隔离恢复验证。本机对正式源码再次完成 `npm run check`（206项Vitest、27项Edge，1项可选隔离恢复测试跳过）和生产公开配置 `npm run build`。
- 独立 Vercel 项目 `prj_2ZsOkEmm84ZwOKOgtR5ZGYq8vwcp`，部署 `dpl_Ab8ZhFKhViicpPhGqYwxkePnidun`，地址 `pdd404-l357qxq3l-guanchao71-gmailcoms-projects.vercel.app`；于15:22:31.258 UTC（22:22:31.258曼谷时间）达到 READY。正式主域与 www 均已绑定本次部署。
- 仅上传六个已校验公开静态文件（含安全头与路由配置），安装、构建命令显式为空，输出目录为根。服务端凭据扫描通过。15:27:38.157 UTC实际核对 HTTPS首页、`/help`及五个公开发布资源的大小与 SHA-1：新脚本 `assets/index-Cesxzsxp.js` 为 `3b792f51a42e3d8720a2222a25bc1441395f068e`，样式 `assets/index-C3PqxsF6.css` 为 `ef46926fef9bdcf2a9166e4a53f0e764ca941b21`；WASM类型正确，第三方许可文件可读取。`https://www.pdd404.app/help` 以308跳转到同路径主域。

## 正式页面验收

实际浏览器读取正式页面的 `pdd404-build`，与上述前端源码一致；六步均为一句话，四条必读提醒完整，原理与隐私是最后一个说明小节。360×800视口下 `scrollWidth=clientWidth=360`，公众号和找货群两张真实图片均完整加载。点击“我错收件了”进入相应已选查询模式，再从“帮助 Help”返回本页；原有首页真实统计正常显示。只浏览和检查页面，没有新增登记、提交查询单号或更改用户资料。

## 接口状态与发布边界

本次运行代码只变更帮助页与样式；Supabase专属生产项目为 `fogncjjsnakbhfdbfvdi`。通过现有已登录管理会话，于15:33:22 UTC保存公开版本标识APP_SHA；随后实际读取API21、worker21均ACTIVE，API bundle仍为 `9c6009a146510834ae2bc7d9f42b657370ed89466812aa7271e6e06a17bb9de7`，worker bundle仍为 `f78d9c64fbc0fe9b8a0e8e1b0fb9cb998ae114b31b9d21ba1781ee3cb25ca232`。配置保存后平台版本递增，函数代码包未变。

数据库runtime的APP_SHA于15:34:15.224924 UTC同步到 `2fff31974d324aae4d01506e30a41adb9084e126`；同一事务锁定runtime行、校验原版本及production环境，并写入 `pdd404_runtime_version` 审计，只包含旧/新SHA、部署ID及发布范围。15:36:29.908 UTC再次读取正式health，确认 `version=0.2.0`、`sha=2fff31974d324aae4d01506e30a41adb9084e126`、`environment=production`、`ok=true`、`ready=true`；前端、接口及数据库版本标识一致，OCR仍关闭。

本次没有数据库迁移、用户数据清理或接口源码更改。此前正式登记、备份与恢复记录继续适用；帮助页排版验收不证明物理相机的扫码效果，也不证明实际包裹交还。没有创建运行标签；后续发布记录文档提交不是新运行部署。
