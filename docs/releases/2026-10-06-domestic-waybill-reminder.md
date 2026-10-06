# JTTH 单号提醒与首页统计简化

日期：2026-10-06，Asia/Bangkok。已在 [pdd404.app](https://pdd404.app) 正式上线并完成本次网页验收。

- 用户确认常见误填单号以 `JTTH` 开头。两种查询模式先去空白、统一字母大小写，再检查这个前缀；命中后显示“请填写国内快递单号”，指导从拼多多物流详情或包裹面单查找中国境内快递单号。提醒在查询凭证、请求编号及网络调用之前执行，不产生查询日志或本机队列项。
- “返回修改单号”、关闭及Escape沿用既有弹窗行为，原输入保留，焦点回到输入框。手输和扫码填入后共用查询入口。此项是客户端查询提醒，仅采用已确认的JTTH格式，没有更改历史登记或服务器号码合同。
- 首页移除用户指定的统计口径说明段落，继续显示三项真实数字。统计去重、匹配及实际交还的数据规则保留。

## 运行版本与检查

- 运行源码 `be64248a1b144429e9c43b89af66af4ef9a3a264`；[PR #25](https://github.com/CMI-Community/cmi-find-my-pdd/pull/25) 已合并，[CI 37483859349](https://github.com/CMI-Community/cmi-find-my-pdd/actions/runs/37483859349) 成功。CI包含207项Vitest、27项Deno/Edge、TypeScript、构建和既有真实PostgreSQL/范围恢复检查。本机检查206项通过，既有范围恢复1项未重复运行；本机常规及生产公开配置构建均通过。
- 独立Vercel项目 `prj_2ZsOkEmm84ZwOKOgtR5ZGYq8vwcp`，部署 `dpl_5RtQvAG6UmXAUQeEcCVr9XttoLLs`，地址 `pdd404-34ov30t2z-guanchao71-gmailcoms-projects.vercel.app`，READY于15:06:07.649 UTC（22:06:07.649曼谷时间）。实际域名别名已绑定。采用已构建静态文件，安装和构建命令显式为空，输出目录为根；[Vercel 静态项目配置](https://vercel.com/docs/builds/configure-a-build)说明了空构建命令的用途。较早一次未清空项目默认安装命令的部署失败，没有接管正式域名。
- Supabase项目 `fogncjjsnakbhfdbfvdi`。只更新公开APP_SHA版本配置和数据库runtime，并写运行版本审计；没有新迁移或重新打包Edge函数。平台最终报告API20、worker20均ACTIVE，API bundle仍为 `9c6009a146510834ae2bc7d9f42b657370ed89466812aa7271e6e06a17bb9de7`。
- Edge APP_SHA保存于15:06:37 UTC，摘要 `b344ec41206f3e7e1e35fe059626d197812a257f220d4534dc5c32f61067ea8a`；数据库runtime于15:06:59.256 UTC保存相同运行SHA。15:07:09.564 UTC核对正式HTTPS、五个发布文件哈希及大小、WASM类型、www的308跳转和 `production/ready=true` health。同源码JS为 `assets/index-BlJmZ0Q5.js`，SHA-1 `af2adcbe6d3d17fab66f136139359be4c47b44ff`。

## 实际网页验收

在正式域名实际输入两个独立合成JTTH号码，分别使用错收和丢件模式，均先显示提醒；其中一个输入带小写字母和两端空格。关闭后可见原输入仍在，焦点回到 `waybill-input`。360×640视口下完整返回按钮可见，高49px，弹窗不需滚动，页面没有横向溢出。截图仅保留在忽略的本机output目录。

15:08:25.546 UTC核对这两个合成号码在查询日志和单号主表均为0条，不需要清理；已有本机两条待提交草稿保持原样。首页不再含指定说明段落，仍读取真实统计及社区二维码。未再次提交真实登记或联系任何登记人。

此前[统计、备注、反馈与疑似线索验收](2026-10-06-stats-notes-feedback-fuzzy.md)仍适用，本次仅修改前端查询提醒与展示。已有21表790行加密业务快照及独立恢复结果保留；没有把前端提醒改动宣称为新数据库迁移或原生全项目备份。后续文档提交不是新的运行部署。

新版WASM/拍照扫码在真实面单及原物理摄像头上的复测仍待反馈，本次共用查询入口和响应式检查不构成真实扫码验收。没有实际包裹交还证明，不创建运行标签。
