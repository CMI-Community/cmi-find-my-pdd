# PDD404

CMI Community 的公益包裹互助项目，域名为 `pdd404.app`。输入拼多多 App 或包裹面单上的完整国内运输单号，选择“我丢件了”或“我多收件了”，查询相同单号的另一侧登记。匹配弹窗直接提供对方自填的微信号或电话；核实归属与实际交还仍由双方完成。

没有匹配的单号先加入本机待提交列表，填写一次联系方式后批量正式登记。手机摄像头在浏览器内识别条形码，识别后只填入号码，用户再点击查询。v0.2.0 不上传面单、不调用图片 OCR、不自动发送微信或短信。

Connect · Make · Impact.

## 开发

要求 Node.js 22.12+；Deno 随开发依赖安装。

```sh
npm ci
cp .env.example .env.local
npm run dev
npm run check
npm run build
node scripts/verify-postgres.mjs
```

最后一项需要已安装的 PostgreSQL 服务端工具；必要时通过 `PDD_PG_BIN` 指定工具目录。它创建并销毁临时本地数据库，验证真实事务、并发与加密数据库恢复，不连接生产数据库。

前端三个 `VITE_` 配置必须指向同一个独立 Supabase 项目；开发和预览不得接入生产登记。普通用户不注册、不登录；业务数据通过 Edge API 访问。查询、批量登记与本人管理使用 32 字节随机凭证，管理员使用单独的 Supabase Auth 登录。

## 工程结构

| 位置 | 责任 |
|---|---|
| `src/PddApp.tsx`、`src/pdd-api.ts` | 双模式查询、结果弹窗、登记、回执与管理员页面 |
| `src/waybill-drafts.ts`、`src/pdd-camera.ts` | 本机待提交队列、请求恢复与摄像头生命周期 |
| `shared/waybill.ts` | PDD404 接口类型、单号与联系方式校验 |
| `supabase/functions/_shared/waybill-api.ts` | 新接口白名单投影与权限检查 |
| `supabase/migrations/` | 单号唯一主记录、两侧登记、查询日志、事务、RLS 与定时清理 |
| `tests/`、`scripts/verify-postgres.mjs` | 虚构数据的规则、API、前端与真实数据库验证 |
| `scripts/` | 部署目标核对、加密备份与隔离恢复 |
| `docs/` | 产品合同、接口、验收与真实发布记录 |

原开源 React/TypeScript/Vite 客户端、图片模块与旧数据库保留。旧图片识别入口在 `OCR_ENABLED=false` 时只允许受权限保护的历史读取，停止业务写入、匹配副作用和 OCR 处理；经内部鉴权的 worker 继续清理旧资料，不租用识别任务。旧模块不作为当前产品入口。

开发以 [产品合同](docs/PRODUCT.md) 和 [API 合同](docs/API.md) 为准，遵循 [工程规则](AGENTS.md)。配置、DNS、备份和故障处理见 [运行手册](docs/RUNBOOK.md)，验收见 [验收表](docs/ACCEPTANCE.md)，实际部署状态见 [发布记录](docs/releases/)。文档和构建成功不代表已经上线。

## 配置与上线目标

产品独立于旧的 Chiang Mai Swap。用户已明确授权把原先用于本产品测试的专属 Supabase 项目 `fogncjjsnakbhfdbfvdi` 转为本产品生产资源；不复用旧站数据库。测试改用本地隔离 PostgreSQL，不再把同一云端生产库当测试库。

上线需要真实社区二维码、小助手、管理员 UUID 白名单、独立 Vercel 项目与正确 CORS。`OCR_ENABLED=false`，OpenAI 额度不是单号服务的启用条件。`submissionsEnabled` 默认关闭，验收后才开启。`pdd404.app` 的 Cloudflare DNS 必须使用独立 Vercel 项目 Domains 页面给出的实际记录值；本文件不预设 IP，也不宣称 DNS 已通过验证。

联系方式保存在服务器，供完整相同单号的另一方查询及管理员处理问题；不会出现在公开记录卡或分享 URL。私密链接以 `/m/:registrationCode#key=…` 保存权限，分享只能使用 `/p/:parentCode`。草稿与回执保存在当前浏览器，清理浏览器资料可能导致丢失。

## 开源范围

代码与虚构测试资料使用 MIT。真实面单、联系方式、聊天归档、生产数据、环境文件、密钥和备份不得进入 Git。安全问题私下联系维护者，勿在公开 issue 上传个人资料或管理凭证。
