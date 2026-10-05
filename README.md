# CMI-Find my pdd

CMI 社区公益包裹互助项目。误收者拍照登记，失主上传物流截图查询；系统保留图片识别线索并双向核对，联系人信息由管理员在群内核实后协助交换。

Connect, Make, Impact.

## 开发

要求 Node.js 22.12+。Deno 随开发依赖安装。

```sh
npm ci
cp .env.example .env.local
npm run dev
npm run check
npm run build
```

前端三个 `VITE_` 配置必须指向同一个独立 Supabase 项目。普通用户不登录；浏览器只访问 API 与限定签名上传，数据库和图片不直接开放。

## 工程结构

| 位置 | 责任 |
|---|---|
| `src/` | React 页面、图片编辑、持久化草稿和上传队列 |
| `shared/` | 接口合同、识别校验、匹配和公开投影 |
| `supabase/functions/api/` | capability / 管理员鉴权、图片验证、业务 API |
| `supabase/functions/worker/` | 固定模型识别、持久化任务处理和清理 |
| `supabase/migrations/` | 私有数据、事务 RPC、预算、租约、RLS、定时补偿 |
| `tests/` | 虚构资料的关键规则及数据库事务测试 |
| `scripts/` | 加密备份、独立环境恢复和目标核对 |
| `docs/` | 产品、接口、运行与发布记录 |

先读 [产品规格](docs/PRODUCT.md) 和 [接口合同](docs/API.md)，开发遵循 [工程规则](AGENTS.md)，发布和维护遵循 [运行手册](docs/RUNBOOK.md)。当前状态见 [首版交付记录](docs/releases/v0.1.0.md)。

## 服务配置

部署前准备有效寻货群、小助手、公众号、管理员 Auth 用户和 OpenAI key；未准备好的入口保持关闭。服务端密钥可以通过 Supabase Edge secrets 配置；运行手册说明 Vault 备用配置。只在服务端使用 OpenAI 和 service-role 密钥。

本地草稿和管理凭证保存在当前浏览器。分享入口只复制公开 URL。管理链接有权限，保存时请妥善保管。

## 开源范围

代码使用 MIT。真实面单、联系方式、聊天归档、生产数据、环境文件和备份不在开源范围。仓库仅允许虚构验收样本。安全问题请私下联系仓库维护者，勿在公开 issue 上传真实面单或凭证。
