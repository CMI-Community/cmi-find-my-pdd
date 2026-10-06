# 横向取景与 WASM 条码识别

## 原因与实现

用户对运行版本 `359730089bbab3f3f13b591db6b2559235794418` 的真实快递复测报告：竖屏相机画面在窄窗口内缩成很小的竖框，拍照后提示未识别到，识别率仍低。之前合成相机中测得81×144的预览保持了比例，但不满足实际使用；本次明确替换该布局和解码引擎，不把之前的软件测试当作真机通过。

- 使用 `zxing-wasm@3.1.5` 的 reader 入口，网页打开时下载并编译本域名WASM；加载任务共享，不提前申请相机权限，不依赖外部CDN。
- WASM 首先解码，浏览器原生条码能力仅在未识别时作为后备；限制线性条码格式，完整单号验证与前导零规则保持。
- 使用横向16:9取景窗和宽条码框；竖屏视频按比例放大、居中显示。解码仍读取未裁切原始相机帧，预览镜像不改变识别像素。
- 固定拍照、自动扫码开关、关闭及状态；拍照即时反馈、冻结当前帧，失败恢复取景。加载失败明确提示刷新重试或手动输入，相机停止。
- 发布配置仅为本机WASM编译添加 `wasm-unsafe-eval`；没有允许JavaScript `unsafe-eval`、外部脚本或云端图片识别。随静态文件保留第三方许可证。

## 验证及发布状态

本机 `npm run check` 已通过 TypeScript / Deno检查、150项Vitest及17项Edge测试（1项需隔离PostgreSQL环境的测试留至CI）；`npm run build` 成功。真实WASM验证使用固定版本reader二进制及生产读取参数，覆盖前导零、旋转、斜放、不同位置、冻结照片及坏Code128校验码。

本机浏览器确认：尚未申请相机时WASM已加载；720×1280相机源在360×480视口展示约300×168横向画面，原始帧保留；失败即时反馈可重拍，展开设置仍可直接拍照；合成 `PDD404TEST000001` 拍照与自动扫码均可填号、停止轨道，无自动查询；识别中关闭后不回填。截图在忽略的 `output/scanner/wasm-horizontal-360.png`。

## 生产部署事实

- 运行源码：`1848fe115f20e9cda7ee5d7d2101cd4048040fea`；[PR #18](https://github.com/CMI-Community/cmi-find-my-pdd/pull/18)，检查源头 `cf36908104d7e10f1334dffa24b456b53a8ebae7` 的 [CI 37466873084](https://github.com/CMI-Community/cmi-find-my-pdd/actions/runs/37466873084) 成功（151项Vitest、17项Edge），含真实PostgreSQL事务及加密恢复检查。合入后构建同一源码，未把后续文档提交当作运行版本。
- 独立Vercel项目 `prj_2ZsOkEmm84ZwOKOgtR5ZGYq8vwcp`；部署 `dpl_CF2VXG4knou3jWaF8ZaH8mvs6LoE`，2026-10-06 19:58:18曼谷时间进入READY；地址 `pdd404-3erx68wa1-guanchao71-gmailcoms-projects.vercel.app`。正式域名为 https://pdd404.app，www有效HTTPS 308重定向到根域名。默认部署保护保留。
- 正式HTML、JS、CSS与第三方声明均200且对应此次构建；HTML meta显示运行SHA。WASM `/assets/zxing_reader-_HcWiliU.wasm` 返回200、`application/wasm`、966895字节；SHA1 `a1b373f7b53fcb64c8dcb4c5bc1591cd50a781ca` 与本机发布文件一致。正式CSP已允许WASM编译。
- Supabase独立生产项目 `fogncjjsnakbhfdbfvdi`；API15、worker16 ACTIVE，代码bundle摘要未改。Edge公开APP_SHA在2026-10-06 12:59:02UTC保存为本次源码；摘要 `e7fd1de0200f5c4ff036896bc982868a7de6ed59d2557c876ff26400e39eaef1`。数据库runtime同一SHA，通过受保护事务更新并写审计；没有数据库迁移。
- 生产合成接口验收在2026-10-06 12:59:58.377UTC通过10项：生产身份、查询重试日志一次、双向联系与匹配优先、公有投影与错凭证拒绝、提交时重匹配、收件先登记、真实查询时间、匿名数据库拒绝、旧创建入口关闭、精确CORS。仅清理本次创建的3个随机合成测试单号，没有清理已有用户记录。
- 实际浏览器加载本次运行SHA，首页真实公众号/微信群图片成功加载，帮助入口与返回查询可用；管理员既有登录保持，查询日志页实际加载8条记录。用户的本机待提交列表保留。静态页面检查没有WASM/CSP错误。
- 正式站截图保存在忽略的 `output/pdd404-wasm-release-home.png` 与 `output/pdd404-wasm-release-help.png`。已请用户刷新正式站，用手机和电脑实际面单复测窗口大小、拍照正确单号/耗时和相机关闭；回复尚未收到。合成条码读取成功不证明真实面单或物理摄像头效果，本版没有运行标签。
