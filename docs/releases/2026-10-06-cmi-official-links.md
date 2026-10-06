# CMI 官网入口与社区 logo 正式发布

日期：2026-10-06，Asia/Bangkok。沿用用户已确认的正式发布授权，此次网站修改已在 [PDD404](https://pdd404.app/) 上线。

## 变更

- [帮助页](https://pdd404.app/help)正文顶部增加“了解更多关于 CMI 社区”。
- 共用页脚使用用户提供的完整彩图 logo，替换文字模拟标识；logo本身可点击，并增加“访问 CMI Community”文字入口。
- 三处统一在新标签打开已核对的 [CMI 官网](https://cmi.community/)，带有可访问名称和 `noopener noreferrer`；原有六步帮助、必读提醒及真实社区配置继续显示。

原图800×800、58,043字节，未经重绘、裁切或压缩；原始提供文件、Git品牌资源及线上图片的SHA-256均为 `8d66bdf38f058182b3e8f397bf68fd28207e77f1a8edd5847a2fe7bb1f9686ef`。Vite将其打包为 `assets/cmi-community-logo-B6wTBKGd.jpg`。

## 正式源码与部署

- [PR #29](https://github.com/CMI-Community/cmi-find-my-pdd/pull/29)的精确提交 `4bc2f69a5ec5493830e2e7dcf48c7173ab7e0232`通过 [CI 37497947851](https://github.com/CMI-Community/cmi-find-my-pdd/actions/runs/37497947851)，合入main的运行源码为 `8b64a05471886fbb3e6f437a266860215f3360b1`，其 [CI 37498223364](https://github.com/CMI-Community/cmi-find-my-pdd/actions/runs/37498223364)同样成功。
- 本机 `npm run check`通过：206项Vitest与27项Edge测试，1项可选隔离恢复测试跳过；`npm run build`通过。合并后以精确main源码和独立PDD404公开端点重建正式产物，服务端密钥扫描通过。
- 独立Vercel项目 `prj_2ZsOkEmm84ZwOKOgtR5ZGYq8vwcp`，部署 `dpl_Ddu9S39vJYRi55SKKtL8Bx8s6nc1`，地址 `pdd404-7y8p3r80t-guanchao71-gmailcoms-projects.vercel.app`，于16:48:36.479 UTC（23:48:36.479曼谷时间）达到READY；正式主域与www均指向此部署。只上传七个经校验的公开静态文件，含路由与安全头配置。
- 16:49:47.772 UTC核对首页、帮助页及六个公开资源的大小与SHA-1，均与构建清单一致；WASM类型正确，许可文件可读，www帮助页308跳转到相同路径主域。页面构建标识为上述运行源码。

专属Supabase生产项目仍为 `fogncjjsnakbhfdbfvdi`。APP_SHA于16:49:59 UTC通过现有已登录管理会话保存，数据库runtime于16:51:27.995472 UTC同步；数据库修改以事务锁定runtime行、校验生产环境与原SHA，并同时写入 `pdd404_runtime_version`审计，仅记录旧/新SHA、前端部署ID及发布范围。16:51:38.784 UTC实际health返回 `version=0.2.0`、新SHA、`environment=production`、`ok=true`、`ready=true`，前端、接口与数据库版本标识一致，OCR仍关闭。

API22、worker22均ACTIVE，配置保存后的平台版本递增，代码包未变：API `9c6009a146510834ae2bc7d9f42b657370ed89466812aa7271e6e06a17bb9de7`，worker `f78d9c64fbc0fe9b8a0e8e1b0fb9cb998ae114b31b9d21ba1781ee3cb25ca232`。

## 页面验收与边界

实际浏览器逐一点击帮助页顶部、主页logo、页脚文字入口，三个新标签均到达 `https://cmi.community/`，显示“CMI Community”主标题。帮助页新入口位于标题上方，logo按原比例加载；正式帮助页与主页360×800视口均为 `scrollWidth=clientWidth=360`，社区二维码与新logo完整显示，文字入口可操作。没有提交单号查询、登记或修改用户资料。

本次无数据库迁移、业务数据清理或接口源码更改。未创建运行标签；发布记录文档合并不产生新运行部署。需要回退时，前一正式部署为 `dpl_Ab8ZhFKhViicpPhGqYwxkePnidun`，对应运行SHA `2fff31974d324aae4d01506e30a41adb9084e126`；回退部署后应同步公开运行标识并记录审计。
