# PDD404 发布界面快照状态清单

此清单从当前 `src/PddApp.tsx`、`src/pdd-*.tsx`、`src/PddMonitoring.tsx`、`shared/waybill.ts`、`shared/recipient.ts` 与 `docs/ACCEPTANCE.md` 的用户可见分支推导。它是拍摄合同，不是已完成截图或生产验收证据。

机器清单为 [pdd404-cases.json](pdd404-cases.json)，共有 **414 个状态、961 个必需状态×视口组合**。JSON 固定 case id、中文名称、脱敏 route、必需视口和全页图要求；原生表面另标可选 `captureType: native-surface`；本文件补充真实触发方法。状态名称不得冒充当前生产状态。

## 版本与覆盖规则

1. 在界面第一次修改前，用当前运行版真实前端 SHA 与相同生产构建拍 baseline；发布前拍 candidate，生产验收后拍 production。分别保存身份与数据来源。
2. 初始化归档后冻结 cases JSON。每个状态×视口必须写 `captured`、`not_applicable`、`pending` 或 `blocked`。以后版本确实不存在某分支时，保留 id 并写不适用的代码/规格/开关依据；不能静默删 case，不能把难拍、超时、设备/认证缺失当不适用。
3. 这里枚举不同用户可见状态；相同校验文案的字母、空格、长度等 API 输入边界不重复截图，但仍按工程验收合同测试。新功能、文案/状态分支、额外响应结果须增加 case，不覆盖历史包。
4. `route` 是安全模板，不含真实 code、邮箱、查询参数、fragment 或 token。使用具体合成 code 访问后，归档仍写模板。4 个首页 scope 均为 `/`；`received` 和 `recipient` 通过实际 UI 切换，不能用不存在的 URL 参数制造状态。
5. 主要页覆盖 320×844、390×844、1280×900；其他状态至少 390×844 和 1280×900。窄屏风险弹窗/相机/反馈列入320。每项先拍实际视口；`fullPageRequired=true` 还需全页图。弹窗不能靠全页图代替内部滚动，清单中的 `*-bottom` 为单独必需状态。
6. 普通 case 省略 `captureType`，按 `viewport` 捕获；浏览器 CSS viewport 使用清单宽高、DPR=1，PNG 像素尺寸按清单核对。原生 `window.confirm` 和浏览器 constraint validation 的8个 case 标为 `captureType: native-surface`、`fullPageRequired=false`，需真实浏览器/系统截图；不得用 HTML/JSX 替身。原生图可能含浏览器/系统边框或设备像素缩放，PNG 实际宽高由 manifest 记录，不强求等于 CSS viewport。其 `observed` 必须说明操作系统、浏览器、该次 CSS viewport、DPR 和截图范围（整个屏幕/应用窗口/实际保留区域），并人工/agent 检查真实提示内容。仍须在每个列出的 CSS viewport 下分别触发；尺寸差异不是允许复用一张图的理由。网页图不含原生提示时不能声称捕获，需用可捕获原生表面的工具补拍；不支持时保留 blocked。原生确认动作仍在隔离 mock 中触发，不代表在生产执行撤回、归属确认、交还、结案或认证写入。
7. UI 快照不证明扫描生命周期、事务、登录、生产计数或业务成功。关闭/成功/切后台等状态另外保存轨道停止/未自动POST的合成运行证据。真机 Safari/微信测试与模拟视口分别标注。

## 安全且可复现的状态准备

- 全状态用当前 SHA 的本地生产构建、隔离浏览器存储、合成 DTO、合成认证/相机；固定时间和输入，不能改 JSX/CSS 来展示不存在的状态。标记 `synthetic` / `mock`，不把 mock 结果当生产事实。
- 阻断生产 API、Supabase Auth、业务 Storage 与埋点出站。查询本身会写查询日志；batch、queryContact、feedback、update/withdraw、adminAction、社区配置、密码/重置邮件都写数据，不能为拍摄在生产执行。线上仅补拍不含私密信息的公开只读界面。
- 只用明确合成姓名、国内单号、微信号、电话和备注；capability/session 只用于隔离替身，不保存凭证、真实 profile、响应正文或含 key 的 URL。图片不能含真实个人数据。
- 社区 QR/联系使用已授权公开资源或真实缺配置状态，不能编造有效二维码或联系人。统计的 mock 数值标合成；生产缺失就拍缺失。
- 每个 case 通过真实按钮/表单和受控网络响应进入；加载状态挂起对应 promise，错误状态使用明确失败响应；查看截图确认语义，不仅看文件存在。

## 首页四组合展开方式

实际首页按钮是“找包裹 / 找失主”，对应 `lost / received`；线索按钮为“快递单号 / 收件人名”，对应 `waybill / recipient`。“我丢件了 / 我错收件了”出现在回执/管理等模式标签，不应写成当前首页按钮。

四个 `LookupScope` 是 `lost:waybill`、`received:waybill`、`lost:recipient`、`received:recipient`。下面每组独立列初始、输入、查找禁用、单/多队列、微信/电话/备注、登记禁用、原批次重试、失败、恢复、重复、满额、移除等，不允许只拍一个组合并推断其他三个。

恢复用例：先给四 scope 分别填不同合成输入、联系人、备注、队列，再切换四组合并刷新；每一 `*-restored` 只记录对应组合的实际恢复结果。恢复请求保留各 scope 原幂等键，不能串 mode/lookupType；IDB `pdd404-domestic-waybills-v1` 的 `drafts` store 保存 `state`。

## 代码和数据依赖

| 依赖 | 定位 |
|---|---|
| 路由与页面骨架 | `src/PddApp.tsx` 的 `PddApp` / `Routes`；未知路径为 `MissingPage` |
| 首页、单号查询、回执、单号管理 | `Home`、`QueryDialog`、`BatchReceipt`、`LocalPage`、`PublicPage`、`ManagePage` |
| 姓名结果、回执、本人和管理员 | `src/pdd-recipient.tsx` 的 `RecipientQueryResults`、`RecipientBatchReceipt`、`RecipientManagePage`、`AdminRecipientPanel` |
| 相机 | `Scanner`、`ScannerCameraControls`、`ScannerReadControls`；`src/pdd-camera.ts` 和 `src/pdd-barcode-reader.ts` |
| 反馈 | `src/pdd-feedback.tsx` 的 `FeedbackForm` / `AdminFeedbackPanel` |
| 管理与恢复 | `AdminPage`、`AdminClueLookupForm`、`AdminCommunity`、`createAdminAuthObserver` |
| 监控 | `src/PddMonitoring.tsx` 的 `PddMonitoring` |
| API 响应 | `src/pdd-api.ts`、`shared/waybill.ts`、`shared/recipient.ts`、`shared/feedback.ts`；遵守 allowlist |
| API mock 路径 | `/v1/community`、`/v1/waybill-stats`、`/v1/waybill-queries`、`/v1/recipient-queries`、对应 batches/manage/admin 系列；监控另有 `/v1/admin/system` / `/v1/admin/analytics` |
| 本机状态和私管链接 | `src/waybill-drafts.ts` 的 `lookupScope`、`pendingForScope`、`readWaybillDrafts`、`privateWaybillUrl`、`privateRecipientUrl` |

单号状态：`matched / possible / duplicate / not_found / closed`；batch 再有 `registered`。公开 resolution：`open / verifying / claimed / resolved`，withdrawn 独立 visibility。姓名查询：`leads_found / not_found`；姓名登记：`active / reviewing / closed / withdrawn`，不增加包裹计数。

当前单号本人管理按 active visibility 显示撤回按钮，即使 resolution 为 claimed/resolved；拍真实界面和拒绝响应，不预设按钮应隐藏。姓名没有公开分享页，不制造 `/rp/:code`。

## 逐状态拍摄清单

以下表格是 JSON 的中文执行说明。视口 `320/390/1280` 分别对应机器 id；捕获 `viewport` 为普通 DPR=1 的网页图；`native-surface` 为真实原生表面图，按上述规则记录实际尺寸和环境。全页“是”表示视口图外还要求 full-page。“否”不免除单独列出的底部/原生提示证据。

### 首页 lost:waybill

| Case id | 用户可见状态 | 安全路由 | 视口 | 捕获 | 全页 | 触发 / 观察 |
|---|---|---|---|---|---|---|
| `home-lost-waybill-initial` | 找包裹 · 快递单号 · 初始页 | `/` | 320/390/1280 | `viewport` | 是 | 清空隔离浏览器草稿；选择对应 mode/lookupType；姓名模式必须无扫码按钮。 |
| `home-lost-waybill-input` | 找包裹 · 快递单号 · 输入已填写 | `/` | 390/1280 | `viewport` | 是 | 填写完整合成线索但不点击查找。 |
| `home-lost-waybill-querying` | 找包裹 · 快递单号 · 正在查找与模式禁用 | `/` | 390/1280 | `viewport` | 是 | 挂起对应 POST query，保留输入；捕获查找 spinner 和 disabled mode/lookup picker。 |
| `home-lost-waybill-queue-single` | 找包裹 · 快递单号 · 单条待提交 | `/` | 320/390/1280 | `viewport` | 是 | 返回 not_found，让真实前端加入当前队列；其他 scope 均空。 |
| `home-lost-waybill-queue-multiple` | 找包裹 · 快递单号 · 多条待提交 | `/` | 390/1280 | `viewport` | 是 | 当前 scope 放入 3 条合成线索；至少包含一个长线索，验证换行和删除按钮。 |
| `home-lost-waybill-queue-wechat` | 找包裹 · 快递单号 · 微信联系方式 | `/` | 390/1280 | `viewport` | 是 | 有队列；选择 wechat，填写合成微信号；检查相应披露说明。 |
| `home-lost-waybill-queue-phone` | 找包裹 · 快递单号 · 电话联系方式 | `/` | 390/1280 | `viewport` | 是 | 有队列；选择 phone，填写虚构国家区号电话号码；检查 tel 输入与披露说明。 |
| `home-lost-waybill-queue-note` | 找包裹 · 快递单号 · 补充说明及字数 | `/` | 390/1280 | `viewport` | 是 | 有队列；填合成说明到 500 字，捕获 500/500 与长文本滚动。 |
| `home-lost-waybill-submitting` | 找包裹 · 快递单号 · 正在确认登记与禁用 | `/` | 320/390/1280 | `viewport` | 是 | 挂起 POST batch；显示正在确认登记、冻结队列/模式/联系字段。 |
| `home-lost-waybill-pending-retry` | 找包裹 · 快递单号 · 原批次等待确认与重试 | `/` | 390/1280 | `viewport` | 是 | 种入对应 pendingBatches；显示原批次冻结说明和“重试并确认上次登记”。 |
| `home-lost-waybill-registration-error` | 找包裹 · 快递单号 · 登记失败保留草稿 | `/` | 390/1280 | `viewport` | 是 | 原批次 POST 返回失败；内容、请求、备注保留；不得显示成功回执。 |
| `home-lost-waybill-restored` | 找包裹 · 快递单号 · 切换和刷新后恢复 | `/` | 390/1280 | `viewport` | 是 | 四 scope 各设置独特输入、联系、备注和队列；切换四组合并刷新，再回到当前 scope；记录不串项。 |
| `home-lost-waybill-registration-disabled` | 找包裹 · 快递单号 · 登记暂未开放 | `/` | 390/1280 | `viewport` | 是 | community.submissionsEnabled=false；有队列；提交 disabled，展示本机保留说明。 |
| `home-lost-waybill-duplicate-queue` | 找包裹 · 快递单号 · 线索已在待提交列表 | `/` | 390/1280 | `viewport` | 是 | 重复查询同一合成线索，mock not_found；保留单条，不重复添加，展示 duplicate notice。 |
| `home-lost-waybill-queue-capacity` | 找包裹 · 快递单号 · 待提交列表已满 | `/` | 390/1280 | `viewport` | 是 | 当前 scope 50 条，查询第 51 条 not_found；展示每批最多50条错误，当前输入保留。 |
| `home-lost-waybill-queue-removed` | 找包裹 · 快递单号 · 移除最后一条 | `/` | 390/1280 | `viewport` | 是 | 删除最后一条后队列隐藏，捕获返回输入区的布局。 |

### 首页 lost:recipient

| Case id | 用户可见状态 | 安全路由 | 视口 | 捕获 | 全页 | 触发 / 观察 |
|---|---|---|---|---|---|---|
| `home-lost-recipient-initial` | 找包裹 · 收件人名 · 初始页 | `/` | 320/390/1280 | `viewport` | 是 | 清空隔离浏览器草稿；选择对应 mode/lookupType；姓名模式必须无扫码按钮。 |
| `home-lost-recipient-input` | 找包裹 · 收件人名 · 输入已填写 | `/` | 390/1280 | `viewport` | 是 | 填写完整合成线索但不点击查找。 |
| `home-lost-recipient-querying` | 找包裹 · 收件人名 · 正在查找与模式禁用 | `/` | 390/1280 | `viewport` | 是 | 挂起对应 POST query，保留输入；捕获查找 spinner 和 disabled mode/lookup picker。 |
| `home-lost-recipient-queue-single` | 找包裹 · 收件人名 · 单条待提交 | `/` | 320/390/1280 | `viewport` | 是 | 返回 not_found，让真实前端加入当前队列；其他 scope 均空。 |
| `home-lost-recipient-queue-multiple` | 找包裹 · 收件人名 · 多条待提交 | `/` | 390/1280 | `viewport` | 是 | 当前 scope 放入 3 条合成线索；至少包含一个长线索，验证换行和删除按钮。 |
| `home-lost-recipient-queue-wechat` | 找包裹 · 收件人名 · 微信联系方式 | `/` | 390/1280 | `viewport` | 是 | 有队列；选择 wechat，填写合成微信号；检查相应披露说明。 |
| `home-lost-recipient-queue-phone` | 找包裹 · 收件人名 · 电话联系方式 | `/` | 390/1280 | `viewport` | 是 | 有队列；选择 phone，填写虚构国家区号电话号码；检查 tel 输入与披露说明。 |
| `home-lost-recipient-queue-note` | 找包裹 · 收件人名 · 补充说明及字数 | `/` | 390/1280 | `viewport` | 是 | 有队列；填合成说明到 500 字，捕获 500/500 与长文本滚动。 |
| `home-lost-recipient-submitting` | 找包裹 · 收件人名 · 正在确认登记与禁用 | `/` | 320/390/1280 | `viewport` | 是 | 挂起 POST batch；显示正在确认登记、冻结队列/模式/联系字段。 |
| `home-lost-recipient-pending-retry` | 找包裹 · 收件人名 · 原批次等待确认与重试 | `/` | 390/1280 | `viewport` | 是 | 种入对应 pendingBatches；显示原批次冻结说明和“重试并确认上次登记”。 |
| `home-lost-recipient-registration-error` | 找包裹 · 收件人名 · 登记失败保留草稿 | `/` | 390/1280 | `viewport` | 是 | 原批次 POST 返回失败；内容、请求、备注保留；不得显示成功回执。 |
| `home-lost-recipient-restored` | 找包裹 · 收件人名 · 切换和刷新后恢复 | `/` | 390/1280 | `viewport` | 是 | 四 scope 各设置独特输入、联系、备注和队列；切换四组合并刷新，再回到当前 scope；记录不串项。 |
| `home-lost-recipient-registration-disabled` | 找包裹 · 收件人名 · 登记暂未开放 | `/` | 390/1280 | `viewport` | 是 | community.submissionsEnabled=false；有队列；提交 disabled，展示本机保留说明。 |
| `home-lost-recipient-duplicate-queue` | 找包裹 · 收件人名 · 线索已在待提交列表 | `/` | 390/1280 | `viewport` | 是 | 重复查询同一合成线索，mock not_found；保留单条，不重复添加，展示 duplicate notice。 |
| `home-lost-recipient-queue-capacity` | 找包裹 · 收件人名 · 待提交列表已满 | `/` | 390/1280 | `viewport` | 是 | 当前 scope 50 条，查询第 51 条 not_found；展示每批最多50条错误，当前输入保留。 |
| `home-lost-recipient-queue-removed` | 找包裹 · 收件人名 · 移除最后一条 | `/` | 390/1280 | `viewport` | 是 | 删除最后一条后队列隐藏，捕获返回输入区的布局。 |

### 首页 received:waybill

| Case id | 用户可见状态 | 安全路由 | 视口 | 捕获 | 全页 | 触发 / 观察 |
|---|---|---|---|---|---|---|
| `home-received-waybill-initial` | 找失主 · 快递单号 · 初始页 | `/` | 320/390/1280 | `viewport` | 是 | 清空隔离浏览器草稿；选择对应 mode/lookupType；姓名模式必须无扫码按钮。 |
| `home-received-waybill-input` | 找失主 · 快递单号 · 输入已填写 | `/` | 390/1280 | `viewport` | 是 | 填写完整合成线索但不点击查找。 |
| `home-received-waybill-querying` | 找失主 · 快递单号 · 正在查找与模式禁用 | `/` | 390/1280 | `viewport` | 是 | 挂起对应 POST query，保留输入；捕获查找 spinner 和 disabled mode/lookup picker。 |
| `home-received-waybill-queue-single` | 找失主 · 快递单号 · 单条待提交 | `/` | 320/390/1280 | `viewport` | 是 | 返回 not_found，让真实前端加入当前队列；其他 scope 均空。 |
| `home-received-waybill-queue-multiple` | 找失主 · 快递单号 · 多条待提交 | `/` | 390/1280 | `viewport` | 是 | 当前 scope 放入 3 条合成线索；至少包含一个长线索，验证换行和删除按钮。 |
| `home-received-waybill-queue-wechat` | 找失主 · 快递单号 · 微信联系方式 | `/` | 390/1280 | `viewport` | 是 | 有队列；选择 wechat，填写合成微信号；检查相应披露说明。 |
| `home-received-waybill-queue-phone` | 找失主 · 快递单号 · 电话联系方式 | `/` | 390/1280 | `viewport` | 是 | 有队列；选择 phone，填写虚构国家区号电话号码；检查 tel 输入与披露说明。 |
| `home-received-waybill-queue-note` | 找失主 · 快递单号 · 补充说明及字数 | `/` | 390/1280 | `viewport` | 是 | 有队列；填合成说明到 500 字，捕获 500/500 与长文本滚动。 |
| `home-received-waybill-submitting` | 找失主 · 快递单号 · 正在确认登记与禁用 | `/` | 320/390/1280 | `viewport` | 是 | 挂起 POST batch；显示正在确认登记、冻结队列/模式/联系字段。 |
| `home-received-waybill-pending-retry` | 找失主 · 快递单号 · 原批次等待确认与重试 | `/` | 390/1280 | `viewport` | 是 | 种入对应 pendingBatches；显示原批次冻结说明和“重试并确认上次登记”。 |
| `home-received-waybill-registration-error` | 找失主 · 快递单号 · 登记失败保留草稿 | `/` | 390/1280 | `viewport` | 是 | 原批次 POST 返回失败；内容、请求、备注保留；不得显示成功回执。 |
| `home-received-waybill-restored` | 找失主 · 快递单号 · 切换和刷新后恢复 | `/` | 390/1280 | `viewport` | 是 | 四 scope 各设置独特输入、联系、备注和队列；切换四组合并刷新，再回到当前 scope；记录不串项。 |
| `home-received-waybill-registration-disabled` | 找失主 · 快递单号 · 登记暂未开放 | `/` | 390/1280 | `viewport` | 是 | community.submissionsEnabled=false；有队列；提交 disabled，展示本机保留说明。 |
| `home-received-waybill-duplicate-queue` | 找失主 · 快递单号 · 线索已在待提交列表 | `/` | 390/1280 | `viewport` | 是 | 重复查询同一合成线索，mock not_found；保留单条，不重复添加，展示 duplicate notice。 |
| `home-received-waybill-queue-capacity` | 找失主 · 快递单号 · 待提交列表已满 | `/` | 390/1280 | `viewport` | 是 | 当前 scope 50 条，查询第 51 条 not_found；展示每批最多50条错误，当前输入保留。 |
| `home-received-waybill-queue-removed` | 找失主 · 快递单号 · 移除最后一条 | `/` | 390/1280 | `viewport` | 是 | 删除最后一条后队列隐藏，捕获返回输入区的布局。 |

### 首页 received:recipient

| Case id | 用户可见状态 | 安全路由 | 视口 | 捕获 | 全页 | 触发 / 观察 |
|---|---|---|---|---|---|---|
| `home-received-recipient-initial` | 找失主 · 收件人名 · 初始页 | `/` | 320/390/1280 | `viewport` | 是 | 清空隔离浏览器草稿；选择对应 mode/lookupType；姓名模式必须无扫码按钮。 |
| `home-received-recipient-input` | 找失主 · 收件人名 · 输入已填写 | `/` | 390/1280 | `viewport` | 是 | 填写完整合成线索但不点击查找。 |
| `home-received-recipient-querying` | 找失主 · 收件人名 · 正在查找与模式禁用 | `/` | 390/1280 | `viewport` | 是 | 挂起对应 POST query，保留输入；捕获查找 spinner 和 disabled mode/lookup picker。 |
| `home-received-recipient-queue-single` | 找失主 · 收件人名 · 单条待提交 | `/` | 320/390/1280 | `viewport` | 是 | 返回 not_found，让真实前端加入当前队列；其他 scope 均空。 |
| `home-received-recipient-queue-multiple` | 找失主 · 收件人名 · 多条待提交 | `/` | 390/1280 | `viewport` | 是 | 当前 scope 放入 3 条合成线索；至少包含一个长线索，验证换行和删除按钮。 |
| `home-received-recipient-queue-wechat` | 找失主 · 收件人名 · 微信联系方式 | `/` | 390/1280 | `viewport` | 是 | 有队列；选择 wechat，填写合成微信号；检查相应披露说明。 |
| `home-received-recipient-queue-phone` | 找失主 · 收件人名 · 电话联系方式 | `/` | 390/1280 | `viewport` | 是 | 有队列；选择 phone，填写虚构国家区号电话号码；检查 tel 输入与披露说明。 |
| `home-received-recipient-queue-note` | 找失主 · 收件人名 · 补充说明及字数 | `/` | 390/1280 | `viewport` | 是 | 有队列；填合成说明到 500 字，捕获 500/500 与长文本滚动。 |
| `home-received-recipient-submitting` | 找失主 · 收件人名 · 正在确认登记与禁用 | `/` | 320/390/1280 | `viewport` | 是 | 挂起 POST batch；显示正在确认登记、冻结队列/模式/联系字段。 |
| `home-received-recipient-pending-retry` | 找失主 · 收件人名 · 原批次等待确认与重试 | `/` | 390/1280 | `viewport` | 是 | 种入对应 pendingBatches；显示原批次冻结说明和“重试并确认上次登记”。 |
| `home-received-recipient-registration-error` | 找失主 · 收件人名 · 登记失败保留草稿 | `/` | 390/1280 | `viewport` | 是 | 原批次 POST 返回失败；内容、请求、备注保留；不得显示成功回执。 |
| `home-received-recipient-restored` | 找失主 · 收件人名 · 切换和刷新后恢复 | `/` | 390/1280 | `viewport` | 是 | 四 scope 各设置独特输入、联系、备注和队列；切换四组合并刷新，再回到当前 scope；记录不串项。 |
| `home-received-recipient-registration-disabled` | 找失主 · 收件人名 · 登记暂未开放 | `/` | 390/1280 | `viewport` | 是 | community.submissionsEnabled=false；有队列；提交 disabled，展示本机保留说明。 |
| `home-received-recipient-duplicate-queue` | 找失主 · 收件人名 · 线索已在待提交列表 | `/` | 390/1280 | `viewport` | 是 | 重复查询同一合成线索，mock not_found；保留单条，不重复添加，展示 duplicate notice。 |
| `home-received-recipient-queue-capacity` | 找失主 · 收件人名 · 待提交列表已满 | `/` | 390/1280 | `viewport` | 是 | 当前 scope 50 条，查询第 51 条 not_found；展示每批最多50条错误，当前输入保留。 |
| `home-received-recipient-queue-removed` | 找失主 · 收件人名 · 移除最后一条 | `/` | 390/1280 | `viewport` | 是 | 删除最后一条后队列隐藏，捕获返回输入区的布局。 |

### 首页共享加载、统计与社区

| Case id | 用户可见状态 | 安全路由 | 视口 | 捕获 | 全页 | 触发 / 观察 |
|---|---|---|---|---|---|---|
| `home-drafts-loading` | 本机草稿读取中 | `/` | 320/390/1280 | `viewport` | 是 | 挂起 IndexedDB 初始化；输入和查找尚不可用。 |
| `home-storage-read-error` | 浏览器无法保存记录 | `/` | 390/1280 | `viewport` | 是 | IndexedDB 读取拒绝；显示存储错误，查找 disabled。 |
| `home-storage-write-error` | 本机记录保存失败 | `/` | 390/1280 | `viewport` | 是 | 保存草稿时拒绝；显示“记录没有保存成功”，不得继续写服务端。 |
| `home-api-unconfigured` | 查询服务尚未配置 | `/` | 390/1280 | `viewport` | 是 | 用无 API_BASE 配置的同 SHA 构建；输入后查询显示 API_NOT_CONFIGURED 对应中文状态。 |
| `home-query-network-error` | 查询网络失败 | `/` | 390/1280 | `viewport` | 是 | 完整合成单号的 query 拒绝；不能冒充 not_found 或加入队列。 |
| `home-recipient-query-network-error` | 姓名查询网络失败 | `/` | 390/1280 | `viewport` | 是 | 完整合成姓名的 query 拒绝，保留输入。 |
| `home-query-invalid-response` | 单号查询响应异常 | `/` | 390/1280 | `viewport` | 是 | 返回无效 possible DTO；展示“疑似线索返回异常”。 |
| `home-recipient-query-invalid-response` | 姓名查询响应异常 | `/` | 390/1280 | `viewport` | 是 | 返回无效姓名 DTO；展示“姓名线索返回异常”。 |
| `home-waybill-empty-error` | 未填单号提示 | `/` | 390/1280 | `viewport` | 是 | 空输入点击查找；“请先输入国内快递单号”。 |
| `home-waybill-format-error` | 国内单号格式错误 | `/` | 390/1280 | `viewport` | 是 | 输入含不允许字符；展示统一格式错误，不穷举所有字符边界。 |
| `home-recipient-empty-error` | 未填姓名提示 | `/` | 390/1280 | `viewport` | 是 | 姓名模式空输入点击查找。 |
| `home-recipient-format-error` | 收件人名格式错误 | `/` | 390/1280 | `viewport` | 是 | 实际输入81个字符的一行合成姓名（input maxLength=160，业务上限80）；捕获统一错误。单行 input 会去掉换行，不能靠键入换行触发此状态。 |
| `home-contact-wechat-error` | 微信联系方式格式错误 | `/` | 390/1280 | `viewport` | 是 | 有队列，填不合法微信号并确认登记。 |
| `home-contact-phone-error` | 电话号码格式错误 | `/` | 390/1280 | `viewport` | 是 | 有队列，选 phone，填不合法号码并确认登记。 |
| `home-incomplete-not-found` | 不完整单号未找到且不入队列 | `/` | 390/1280 | `viewport` | 是 | 含 ? 或 * 的合法 query 返回 not_found；展示需核对完整号码的 notice。 |
| `home-complete-not-found` | 完整单号未找到且进入待提交 | `/` | 390/1280 | `viewport` | 是 | 完整 query 返回 not_found；捕获加入队列 notice。 |
| `home-recipient-not-found` | 姓名未找到且进入待提交 | `/` | 390/1280 | `viewport` | 是 | recipient query 返回 not_found；捕获姓名入队 notice。 |
| `home-barcode-filled` | 扫码成功只填号提示 | `/` | 390/1280 | `viewport` | 是 | 合成条码识别后 scanner 关闭，输入显示号码和“已扫描单号，请核对后点击查找”；无自动 POST。 |
| `home-stats-loading` | 首次读取真实登记统计 | `/` | 390/1280 | `viewport` | 是 | 挂起 stats；无数字，只展示读取提示。 |
| `home-stats-success` | 读取到登记统计 | `/` | 320/390/1280 | `viewport` | 是 | 合成整数 stats；外部 manifest 标 synthetic，不作为真实生产计数。 |
| `home-stats-updating` | 统计更新中保留最近数字 | `/` | 390/1280 | `viewport` | 是 | 首次成功后挂起刷新，显示旧值和“正在更新统计”。 |
| `home-stats-error-empty` | 统计失败且没有旧数字 | `/` | 390/1280 | `viewport` | 是 | 首次 stats 请求拒绝，不显示假零。 |
| `home-stats-error-stale` | 统计失败且保留最近数字 | `/` | 390/1280 | `viewport` | 是 | 首次成功后刷新失败，显示旧数字来源提示和重试。 |
| `home-stats-invalid-response` | 统计响应异常 | `/` | 390/1280 | `viewport` | 是 | mock 非法统计值导致 INVALID_RESPONSE；捕获实际状态。 |
| `home-community-loading` | 社区配置正在读取 | `/` | 390/1280 | `viewport` | 是 | 挂起 community，有队列；显示“正在读取登记服务状态…”及未配置入口。 |
| `home-community-error` | 社区配置读取失败 | `/` | 390/1280 | `viewport` | 是 | community 拒绝；捕获社区错误和登记服务状态。 |
| `home-community-configured` | 真实社区入口展示 | `/` | 320/390/1280 | `viewport` | 是 | 当前版本已有的公开配置只读拍摄，或使用现有公开资源的合成配置；无伪造 QR/联系人。 |
| `home-community-missing` | 公众号和找货群入口缺配置 | `/` | 390/1280 | `viewport` | 是 | QR URLs 与 assistantWechat=null，展示尚未配置。 |
| `home-community-image-error` | 社区二维码无法读取 | `/` | 390/1280 | `viewport` | 是 | 现有 URL 的图片请求失败；展示“二维码暂时无法读取 / 请联系小助手”。 |
| `home-community-helper-qr` | 可查看小助手二维码入口 | `/` | 390/1280 | `viewport` | 是 | assistantQrUrl 已配置；捕获公开链接，不点击外部私密资源。 |
| `home-footer` | 页脚入口和社区品牌 | `/` | 320/390/1280 | `viewport` | 是 | 全页覆盖本机记录、隐私说明、建议与反馈、开源代码、社区官网。 |
| `home-keyboard-focus` | 键盘跳到内容和焦点 | `/` | 320/390/1280 | `viewport` | 是 | 键盘 Tab 至“跳到内容”，激活后捕获主要操作 focus；不能仅从 DOM 推断。 |

### 国内单号提醒

| Case id | 用户可见状态 | 安全路由 | 视口 | 捕获 | 全页 | 触发 / 观察 |
|---|---|---|---|---|---|---|
| `waybill-jtth-reminder` | 请填写国内快递单号弹窗 | `/` | 320/390/1280 | `viewport` | 否 | JTTH 开头输入触发 DomesticWaybillReminder；关闭后回到输入。 |

### 单号查询结果

| Case id | 用户可见状态 | 安全路由 | 视口 | 捕获 | 全页 | 触发 / 观察 |
|---|---|---|---|---|---|---|
| `waybill-matched-lost-wechat` | 找到包裹登记 · 对方微信号 | `/` | 320/390/1280 | `viewport` | 否 | query.result=matched，contact.kind=wechat；合成联系人，registeredAt 已填。 |
| `waybill-matched-lost-phone` | 找到包裹登记 · 对方电话号码 | `/` | 320/390/1280 | `viewport` | 否 | query.result=matched，contact.kind=phone；合成号码。 |
| `waybill-matched-received-wechat` | 找到寻件登记 · 对方微信号 | `/` | 320/390/1280 | `viewport` | 否 | query.result=matched，contact.kind=wechat；合成联系人，registeredAt 已填。 |
| `waybill-matched-received-phone` | 找到寻件登记 · 对方电话号码 | `/` | 320/390/1280 | `viewport` | 否 | query.result=matched，contact.kind=phone；合成号码。 |
| `waybill-matched-note` | 精确匹配带对方备注 | `/` | 320/390/1280 | `viewport` | 否 | matched，note 包含多行较长合成说明。 |
| `waybill-matched-no-note` | 精确匹配没有备注 | `/` | 320/390/1280 | `viewport` | 否 | matched，note=null；不得显示空的备注框。 |
| `waybill-duplicate` | 这个单号已经登记过 | `/` | 320/390/1280 | `viewport` | 否 | query.result=duplicate；无对方联系/备注。 |
| `waybill-closed` | 包裹已经交还 | `/` | 320/390/1280 | `viewport` | 否 | query.result=closed；无对方联系/备注。 |
| `waybill-contact-copied` | 对方联系方式已复制 | `/` | 320/390/1280 | `viewport` | 否 | 允许 clipboard，点击复制，捕获成功状态。 |
| `waybill-contact-copy-error` | 对方联系方式复制失败 | `/` | 320/390/1280 | `viewport` | 否 | 拒绝 clipboard，点击复制，捕获长按手动复制说明或真实错误。 |
| `waybill-possible-one` | 找到一条疑似包裹线索 | `/` | 320/390/1280 | `viewport` | 否 | possible，1 个候选；仅 code/tail/similarity/registeredAt。 |
| `waybill-possible-five` | 找到五条疑似包裹线索 | `/` | 320/390/1280 | `viewport` | 否 | possible，5 个候选；长列表与底部操作，截图证据包括滚动末尾。 |
| `waybill-possible-complete` | 疑似线索允许登记完整单号 | `/` | 320/390/1280 | `viewport` | 否 | 查询值为完整号码，显示“仍要登记这个完整单号”。 |
| `waybill-possible-incomplete` | 疑似线索需先核对完整单号 | `/` | 320/390/1280 | `viewport` | 否 | 查询值含 ?/*，显示完整号码要求，无登记按钮。 |
| `waybill-possible-registering` | 疑似完整单号正在加入列表 | `/` | 320/390/1280 | `viewport` | 否 | 挂起本机草稿保存，显示“正在加入待提交列表…”。 |
| `waybill-possible-registration-error` | 疑似完整单号加入列表失败 | `/` | 320/390/1280 | `viewport` | 否 | 本机保存拒绝，弹窗显示错误且仍在当前线索。 |
| `waybill-optional-contact-wechat` | 可选留下我的微信号 | `/` | 320/390/1280 | `viewport` | 否 | matched 展开 showContact=true，wechat 表单和披露提示。 |
| `waybill-optional-contact-phone` | 可选留下我的电话号码 | `/` | 320/390/1280 | `viewport` | 否 | matched 展开，phone 表单。 |
| `waybill-optional-contact-invalid` | 可选联系方式校验失败 | `/` | 320/390/1280 | `viewport` | 否 | 展开后非法联系提交，捕获 ErrorNote。 |
| `waybill-optional-contact-saving` | 可选联系方式正在保存 | `/` | 320/390/1280 | `viewport` | 否 | 挂起 queryContact POST，捕获 disabled 表单和正在保存。 |
| `waybill-optional-contact-error` | 可选联系方式保存失败 | `/` | 320/390/1280 | `viewport` | 否 | queryContact 拒绝，保留表单与 pendingContacts。 |
| `waybill-optional-contact-saved-registration` | 可选联系方式保存并生成回执 | `/` | 320/390/1280 | `viewport` | 否 | queryContact.saved=true、registration 存在；展示已保存和查看本机回执。 |
| `waybill-optional-contact-saved-history` | 已有同侧只保存查询联系历史 | `/` | 320/390/1280 | `viewport` | 否 | queryContact.saved=true、registration=null；不创建管理权限。 |
| `waybill-optional-contact-received-thanks` | 保存错收登记后的感谢 | `/` | 320/390/1280 | `viewport` | 否 | saved registration.mode=received，显示 ReceivedRegistrationThanks。 |
| `waybill-possible-five-bottom` | 五条疑似线索内部滚动末尾 | `/` | 320/390/1280 | `viewport` | 否 | 使用同一合成 5 条线索，滚动弹窗到末尾；捕获社区入口与核对/登记主按钮。 |

### 姓名查询结果

| Case id | 用户可见状态 | 安全路由 | 视口 | 捕获 | 全页 | 触发 / 观察 |
|---|---|---|---|---|---|---|
| `recipient-leads-one-wechat` | 找到一条同名微信线索 | `/` | 320/390/1280 | `viewport` | 是 | leads_found，1 个 lead，contact.kind=wechat。 |
| `recipient-leads-one-phone` | 找到一条同名电话线索 | `/` | 390/1280 | `viewport` | 是 | leads_found，contact.kind=phone。 |
| `recipient-leads-note` | 同名线索带补充说明 | `/` | 390/1280 | `viewport` | 是 | lead.note 为合成多行说明。 |
| `recipient-leads-no-note` | 同名线索没有补充说明 | `/` | 390/1280 | `viewport` | 是 | lead.note=null。 |
| `recipient-leads-multiple` | 同名多人保持独立线索 | `/` | 320/390/1280 | `viewport` | 是 | 多个同名 lead，不合并、不当作包裹匹配。 |
| `recipient-leads-next-page` | 同名线索有后续分页 | `/` | 390/1280 | `viewport` | 是 | nextCursor 非空，显示“继续查看同名线索”。 |
| `recipient-leads-loading-page` | 正在读取后续同名线索 | `/` | 390/1280 | `viewport` | 是 | 挂起 recipientQueryPage，按钮“正在读取…”。 |
| `recipient-leads-page-error` | 后续同名线索读取失败 | `/` | 390/1280 | `viewport` | 是 | page 请求失败，保留已读取 lead。 |
| `recipient-leads-page-complete` | 后续线索追加且分页结束 | `/` | 390/1280 | `viewport` | 是 | 返回新 lead，nextCursor=null；append 列表，不再显示分页按钮。 |
| `recipient-leads-copied` | 同名线索联系方式已复制 | `/` | 390/1280 | `viewport` | 是 | clipboard 成功。 |
| `recipient-leads-copy-error` | 同名线索复制失败 | `/` | 390/1280 | `viewport` | 是 | clipboard 拒绝，ErrorNotice。 |
| `recipient-leads-registering` | 同名命中仍需登记正在入队 | `/` | 390/1280 | `viewport` | 是 | 挂起 onRegister 的本机保存，相关按钮 disabled。 |
| `recipient-leads-registration-error` | 同名命中加入队列失败 | `/` | 390/1280 | `viewport` | 是 | onRegister 保存拒绝；捕获错误。 |
| `recipient-leads-added-to-queue` | 同名命中后加入自己队列 | `/` | 390/1280 | `viewport` | 是 | 点击“仍需登记，加入待提交列表”；结果区关闭，姓名队列及尚未正式登记 notice。 |

### 单号队列附加姓名

| Case id | 用户可见状态 | 安全路由 | 视口 | 捕获 | 全页 | 触发 / 观察 |
|---|---|---|---|---|---|---|
| `waybill-queue-recipient-empty` | 单号每行可选填写收件人名 | `/` | 320/390/1280 | `viewport` | 是 | 有多条单号，姓名空。 |
| `waybill-queue-recipient-filled` | 单号每行分别填写姓名 | `/` | 390/1280 | `viewport` | 是 | 每条不同合成姓名；披露提示含单号或姓名。 |
| `waybill-queue-recipient-unsaved` | 单号已处理但姓名未保存 | `/` | 390/1280 | `viewport` | 是 | batch item.recipientNameSaved=false；保留队列行、错误和“转入姓名队列”。 |
| `waybill-queue-recipient-transfer` | 未保存姓名转入独立姓名队列 | `/` | 390/1280 | `viewport` | 是 | 点击转入，原单号行移除，切换同 mode 的 recipient scope，提示需单独提交。 |

### 单号批次回执

| Case id | 用户可见状态 | 安全路由 | 视口 | 捕获 | 全页 | 触发 / 观察 |
|---|---|---|---|---|---|---|
| `waybill-receipt-registered` | 本次登记已处理 · 登记成功 | `/` | 320/390/1280 | `viewport` | 否 | receipt.items=[registered]，有 registration 管理入口。 |
| `waybill-receipt-matched-wechat` | 提交时匹配 · 对方微信 | `/` | 320/390/1280 | `viewport` | 否 | items=[matched]，wechat 和对方备注。 |
| `waybill-receipt-matched-phone` | 提交时匹配 · 对方电话 | `/` | 320/390/1280 | `viewport` | 否 | items=[matched]，phone。 |
| `waybill-receipt-duplicate` | 回执 · 已有同侧登记 | `/` | 320/390/1280 | `viewport` | 否 | items=[duplicate]；没有取得原管理权限时 registration=null。 |
| `waybill-receipt-closed` | 回执 · 已交还 | `/` | 320/390/1280 | `viewport` | 否 | items=[closed]，无对方联系方式。 |
| `waybill-receipt-mixed` | 回执 · 四种处理结果混合 | `/` | 320/390/1280 | `viewport` | 否 | 同张回执含 registered/matched/duplicate/closed，至少一长备注；捕获顶部及内部滚动末尾。 |
| `waybill-receipt-my-note` | 回执带我的备注 | `/` | 320/390/1280 | `viewport` | 否 | registration.note 为合成说明。 |
| `waybill-receipt-received-thanks` | 错收登记回执感谢 | `/` | 320/390/1280 | `viewport` | 否 | 至少一项 registration.mode=received。 |
| `waybill-receipt-mixed-bottom` | 混合单号回执内部滚动末尾 | `/` | 320/390/1280 | `viewport` | 否 | 保持混合结果长回执，滚动到末尾，捕获最后结果、管理入口和知道了按钮。 |

### 姓名批次回执

| Case id | 用户可见状态 | 安全路由 | 视口 | 捕获 | 全页 | 触发 / 观察 |
|---|---|---|---|---|---|---|
| `recipient-receipt-registered` | 姓名线索登记已处理 · 登记成功 | `/` | 320/390/1280 | `viewport` | 否 | items=[registered]；有 /rm/:code 入口。 |
| `recipient-receipt-duplicate-managed` | 姓名回执 · 重复且有本人管理入口 | `/` | 320/390/1280 | `viewport` | 否 | duplicate 且 registration 存在，显示入口。 |
| `recipient-receipt-duplicate-unmanaged` | 姓名回执 · 重复且没有管理权限 | `/` | 320/390/1280 | `viewport` | 否 | duplicate 且 registration=null，显示未覆盖原资料说明。 |
| `recipient-receipt-mixed` | 姓名回执 · 新增和重复混合 | `/` | 320/390/1280 | `viewport` | 否 | 含多个 registered/duplicate、较长姓名/备注；捕获内部滚动末尾。 |
| `recipient-receipt-received-thanks` | 错收姓名登记回执感谢 | `/` | 320/390/1280 | `viewport` | 否 | 有新注册 received item。 |
| `recipient-receipt-mixed-bottom` | 混合姓名回执内部滚动末尾 | `/` | 320/390/1280 | `viewport` | 否 | 保持长姓名回执，滚动到末尾，捕获最后项和知道了按钮。 |

### 本机记录

| Case id | 用户可见状态 | 安全路由 | 视口 | 捕获 | 全页 | 触发 / 观察 |
|---|---|---|---|---|---|---|
| `local-loading` | 本机记录读取中 | `/local` | 390/1280 | `viewport` | 是 | 挂起 IndexedDB。 |
| `local-empty` | 本机没有正式登记回执 | `/local` | 320/390/1280 | `viewport` | 是 | receipts=[]，展示回到首页入口。 |
| `local-waybill-receipts` | 本机单号登记回执 | `/local` | 390/1280 | `viewport` | 是 | lost/received 合成 receipts，含可选姓名、自己的备注。 |
| `local-recipient-receipts` | 本机姓名登记回执 | `/local` | 390/1280 | `viewport` | 是 | recipient receipts，姓名管理入口。 |
| `local-mixed-receipts` | 本机单号和姓名混合记录 | `/local` | 320/390/1280 | `viewport` | 是 | 混合 receipts，各两种 mode；长内容。 |
| `local-pending-contact` | 联系方式提交等待确认 | `/local` | 390/1280 | `viewport` | 是 | pendingContacts 存在；展示重试入口。 |
| `local-pending-contact-retrying` | 正在确认联系方式提交 | `/local` | 390/1280 | `viewport` | 是 | 挂起重试 queryContact。 |
| `local-pending-contact-saved` | 联系方式确认保存后回执 | `/local` | 390/1280 | `viewport` | 是 | 重试成功；pending 移除，receipt 新增。 |
| `local-pending-contact-received-thanks` | 错收联系方式确认保存感谢 | `/local` | 390/1280 | `viewport` | 是 | 重试成功且 registration.mode=received。 |
| `local-pending-contact-error` | 联系方式等待确认重试失败 | `/local` | 390/1280 | `viewport` | 是 | 重试失败，pending 保留。 |
| `local-pending-entries` | 仍有线索待提交 | `/local` | 390/1280 | `viewport` | 是 | drafts.entries 非空，显示总条数和回首页链接。 |
| `local-management-link-copied` | 私密管理链接已复制 | `/local` | 390/1280 | `viewport` | 是 | clipboard 允许，仅使用 mock capability；不在 manifest 输出 key。 |
| `local-management-link-copy-error` | 私密管理链接复制失败 | `/local` | 390/1280 | `viewport` | 是 | clipboard 拒绝。 |
| `local-storage-error` | 本机记录存储错误 | `/local` | 390/1280 | `viewport` | 是 | 存储读取失败。 |

### 公开记录

| Case id | 用户可见状态 | 安全路由 | 视口 | 捕获 | 全页 | 触发 / 观察 |
|---|---|---|---|---|---|---|
| `public-record-open` | 公开记录 · 正在寻找 | `/p/:code` | 320/390/1280 | `viewport` | 是 | mock record.resolution=open，visibility=active；只显示公开 allowlist。 |
| `public-record-verifying` | 公开记录 · 正在核实 | `/p/:code` | 390/1280 | `viewport` | 是 | mock record.resolution=verifying，visibility=active；只显示公开 allowlist。 |
| `public-record-claimed` | 公开记录 · 已认领，待交还 | `/p/:code` | 390/1280 | `viewport` | 是 | mock record.resolution=claimed，visibility=active；只显示公开 allowlist。 |
| `public-record-resolved` | 公开记录 · 已交还 | `/p/:code` | 390/1280 | `viewport` | 是 | mock record.resolution=resolved，visibility=active；只显示公开 allowlist。 |
| `public-record-withdrawn` | 公开记录 · 登记已撤回 | `/p/:code` | 390/1280 | `viewport` | 是 | visibility=withdrawn；尾号不显示。 |
| `public-record-loading` | 公开记录 · 读取中 | `/p/:code` | 390/1280 | `viewport` | 是 | 挂起 publicRecord GET。 |
| `public-record-error` | 公开记录 · 记录读取失败 | `/p/:code` | 390/1280 | `viewport` | 是 | publicRecord 404 或网络失败，捕获错误。 |
| `public-record-copied` | 公开记录 · 公开链接已复制 | `/p/:code` | 390/1280 | `viewport` | 是 | clipboard 成功。 |
| `public-record-copy-error` | 公开记录 · 复制失败 | `/p/:code` | 390/1280 | `viewport` | 是 | clipboard 拒绝。 |

### 公开截图卡片

| Case id | 用户可见状态 | 安全路由 | 视口 | 捕获 | 全页 | 触发 / 观察 |
|---|---|---|---|---|---|---|
| `public-share-open` | 截图卡片 · 正在寻找 | `/p/:code/share` | 320/390/1280 | `viewport` | 是 | mock record.resolution=open，visibility=active；只显示公开 allowlist。 |
| `public-share-verifying` | 截图卡片 · 正在核实 | `/p/:code/share` | 390/1280 | `viewport` | 是 | mock record.resolution=verifying，visibility=active；只显示公开 allowlist。 |
| `public-share-claimed` | 截图卡片 · 已认领，待交还 | `/p/:code/share` | 390/1280 | `viewport` | 是 | mock record.resolution=claimed，visibility=active；只显示公开 allowlist。 |
| `public-share-resolved` | 截图卡片 · 已交还 | `/p/:code/share` | 390/1280 | `viewport` | 是 | mock record.resolution=resolved，visibility=active；只显示公开 allowlist。 |
| `public-share-withdrawn` | 截图卡片 · 登记已撤回 | `/p/:code/share` | 390/1280 | `viewport` | 是 | visibility=withdrawn；尾号不显示。 |
| `public-share-loading` | 截图卡片 · 读取中 | `/p/:code/share` | 390/1280 | `viewport` | 是 | 挂起 publicRecord GET。 |
| `public-share-error` | 截图卡片 · 记录读取失败 | `/p/:code/share` | 390/1280 | `viewport` | 是 | publicRecord 404 或网络失败，捕获错误。 |
| `public-share-copied` | 截图卡片 · 公开链接已复制 | `/p/:code/share` | 390/1280 | `viewport` | 是 | clipboard 成功。 |
| `public-share-copy-error` | 截图卡片 · 复制失败 | `/p/:code/share` | 390/1280 | `viewport` | 是 | clipboard 拒绝。 |

### 单号本人管理

| Case id | 用户可见状态 | 安全路由 | 视口 | 捕获 | 全页 | 触发 / 观察 |
|---|---|---|---|---|---|---|
| `manage-waybill-no-capability` | 单号管理缺少凭证 | `/m/:code` | 390/1280 | `viewport` | 是 | fragment 无 key、隔离 receipts 无对应 capability；显示原设备/私密链接提示。 |
| `manage-waybill-invalid-capability` | 单号管理凭证无效 | `/m/:code` | 390/1280 | `viewport` | 是 | mock 无效凭证对应的 FORBIDDEN；不真实探测生产凭证。 |
| `manage-waybill-loading` | 单号管理正在读取 | `/m/:code` | 390/1280 | `viewport` | 是 | 挂起 manage GET。 |
| `manage-waybill-read-error` | 单号管理读取失败 | `/m/:code` | 390/1280 | `viewport` | 是 | 合法 mock 凭证，GET 返回网络失败。 |
| `manage-waybill-lost` | 管理我的登记 · 我丢件了 | `/m/:code` | 320/390/1280 | `viewport` | 是 | active 登记，contact 保留。 |
| `manage-waybill-received` | 管理我的登记 · 我错收件了 | `/m/:code` | 320/390/1280 | `viewport` | 是 | active 登记，contact 保留。 |
| `manage-waybill-open` | 单号管理 · 正在寻找 | `/m/:code` | 390/1280 | `viewport` | 是 | record.resolution=open，registration.visibility=active；拍当前实际按钮，不假设被隐藏。 |
| `manage-waybill-verifying` | 单号管理 · 正在核实 | `/m/:code` | 390/1280 | `viewport` | 是 | record.resolution=verifying，registration.visibility=active；拍当前实际按钮，不假设被隐藏。 |
| `manage-waybill-claimed` | 单号管理 · 已认领，待交还 | `/m/:code` | 390/1280 | `viewport` | 是 | record.resolution=claimed，registration.visibility=active；拍当前实际按钮，不假设被隐藏。 |
| `manage-waybill-resolved` | 单号管理 · 已交还 | `/m/:code` | 390/1280 | `viewport` | 是 | record.resolution=resolved，registration.visibility=active；拍当前实际按钮，不假设被隐藏。 |
| `manage-waybill-withdrawn` | 单号管理 · 本人的登记已撤回 | `/m/:code` | 390/1280 | `viewport` | 是 | visibility=withdrawn，无编辑和撤回操作。 |
| `manage-waybill-counterpart-registered` | 单号管理 · 已有另一方登记 | `/m/:code` | 390/1280 | `viewport` | 是 | record.lostRegistered=receivedRegistered=true，active；显示返首页再查联系方式提示。 |
| `manage-waybill-contact-cleaned` | 单号管理 · 联系方式已清理 | `/m/:code` | 390/1280 | `viewport` | 是 | contact=null，无编辑表单。 |
| `manage-waybill-note` | 单号管理 · 我的备注 | `/m/:code` | 390/1280 | `viewport` | 是 | note 为较长合成说明。 |
| `manage-waybill-edit-wechat` | 更正收件人名与微信号 | `/m/:code` | 390/1280 | `viewport` | 是 | active+wechat，填写可选姓名，检查披露提示。 |
| `manage-waybill-edit-phone` | 更正收件人名与电话号码 | `/m/:code` | 390/1280 | `viewport` | 是 | active+phone。 |
| `manage-waybill-name-error` | 管理时姓名校验失败 | `/m/:code` | 390/1280 | `viewport` | 是 | 在真实 input 输入81个字符的可选合成姓名后提交（maxLength=160，业务上限80），显示姓名错误；不靠输入会过滤的换行。 |
| `manage-waybill-contact-error` | 管理时联系校验失败 | `/m/:code` | 390/1280 | `viewport` | 是 | 无效联系方式，显示错误。 |
| `manage-waybill-saving` | 管理修改正在保存 | `/m/:code` | 390/1280 | `viewport` | 是 | 挂起 PATCH，操作 disabled。 |
| `manage-waybill-saved` | 管理修改已更新 | `/m/:code` | 390/1280 | `viewport` | 是 | PATCH 成功且本机回执同步；显示“收件人名和联系方式已更新”。 |
| `manage-waybill-conflict` | 管理修改版本冲突 | `/m/:code` | 390/1280 | `viewport` | 是 | PATCH 返回 revision 冲突，保留当前输入，不覆盖。 |
| `manage-waybill-save-error` | 管理修改失败 | `/m/:code` | 390/1280 | `viewport` | 是 | PATCH 失败，保留输入。 |
| `manage-waybill-withdraw-confirm` | 撤回本人单号登记确认框 | `/m/:code` | 390/1280 | `native-surface` | 否 | 通过真实 click 触发 window.confirm；浏览器 native dialog 需工具支持，不能代造弹窗。 |
| `manage-waybill-withdraw-saving` | 正在撤回本人登记 | `/m/:code` | 390/1280 | `viewport` | 是 | confirm 接受、POST 挂起。 |
| `manage-waybill-withdraw-success` | 本人的登记已撤回及感谢 | `/m/:code` | 390/1280 | `viewport` | 是 | POST 成功，回执和 UI 更新。 |
| `manage-waybill-withdraw-denied` | 归属确认后本人撤回被拒绝 | `/m/:code` | 390/1280 | `viewport` | 是 | active+claimed/resolved 当前 UI 仍可能有按钮；mock API 拒绝，拍真实 ErrorNote。 |
| `manage-waybill-withdraw-error` | 本人登记撤回失败 | `/m/:code` | 390/1280 | `viewport` | 是 | POST 网络失败。 |
| `manage-waybill-link-copied` | 单号私密管理链接已复制 | `/m/:code` | 390/1280 | `viewport` | 是 | 合成 mock capability，clipboard 成功；URL 不进入记录。 |
| `manage-waybill-link-copy-error` | 单号私密管理链接复制失败 | `/m/:code` | 390/1280 | `viewport` | 是 | clipboard 拒绝。 |

### 姓名本人管理

| Case id | 用户可见状态 | 安全路由 | 视口 | 捕获 | 全页 | 触发 / 观察 |
|---|---|---|---|---|---|---|
| `manage-recipient-no-capability` | 姓名管理缺少凭证 | `/rm/:code` | 390/1280 | `viewport` | 是 | 无 key 且无本机 receipt。 |
| `manage-recipient-invalid-capability` | 姓名管理凭证无效 | `/rm/:code` | 390/1280 | `viewport` | 是 | mock FORBIDDEN。 |
| `manage-recipient-loading` | 姓名管理正在读取 | `/rm/:code` | 390/1280 | `viewport` | 是 | 挂起 recipientManage GET。 |
| `manage-recipient-read-error` | 姓名管理读取失败 | `/rm/:code` | 390/1280 | `viewport` | 是 | GET 失败。 |
| `manage-recipient-lost` | 管理我的姓名线索 · 我丢件了 | `/rm/:code` | 320/390/1280 | `viewport` | 是 | active 姓名，保留 contact。 |
| `manage-recipient-received` | 管理我的姓名线索 · 我错收件了 | `/rm/:code` | 320/390/1280 | `viewport` | 是 | active 姓名，保留 contact。 |
| `manage-recipient-active` | 姓名管理 · 正在寻找 | `/rm/:code` | 390/1280 | `viewport` | 是 | registration.state=active，观察编辑/撤回是否显示。 |
| `manage-recipient-reviewing` | 姓名管理 · 正在跟进 | `/rm/:code` | 390/1280 | `viewport` | 是 | registration.state=reviewing，观察编辑/撤回是否显示。 |
| `manage-recipient-closed` | 姓名管理 · 已结案 | `/rm/:code` | 390/1280 | `viewport` | 是 | registration.state=closed，观察编辑/撤回是否显示。 |
| `manage-recipient-withdrawn` | 姓名管理 · 已撤回 | `/rm/:code` | 390/1280 | `viewport` | 是 | registration.state=withdrawn，观察编辑/撤回是否显示。 |
| `manage-recipient-cleaned` | 姓名和联系方式已按保留期清理 | `/rm/:code` | 390/1280 | `viewport` | 是 | recipientName=null，contact=null。 |
| `manage-recipient-note` | 姓名管理带补充说明 | `/rm/:code` | 390/1280 | `viewport` | 是 | 较长合成 note。 |
| `manage-recipient-edit-wechat` | 更正姓名与微信联系方式 | `/rm/:code` | 390/1280 | `viewport` | 是 | active+wechat 表单。 |
| `manage-recipient-edit-phone` | 更正姓名与电话联系方式 | `/rm/:code` | 390/1280 | `viewport` | 是 | active+phone 表单。 |
| `manage-recipient-name-error` | 姓名管理校验失败 | `/rm/:code` | 390/1280 | `viewport` | 是 | 在真实 input 输入81个字符的一行合成姓名后提交，触发业务上限80的校验；不靠换行。 |
| `manage-recipient-contact-error` | 姓名管理联系校验失败 | `/rm/:code` | 390/1280 | `viewport` | 是 | 非法 contact 提交。 |
| `manage-recipient-saving` | 姓名线索修改正在保存 | `/rm/:code` | 390/1280 | `viewport` | 是 | 挂起 PATCH。 |
| `manage-recipient-saved` | 姓名和联系方式已更新 | `/rm/:code` | 390/1280 | `viewport` | 是 | PATCH 成功、本机 receipt 更新。 |
| `manage-recipient-conflict` | 姓名修改版本冲突 | `/rm/:code` | 390/1280 | `viewport` | 是 | PATCH revision conflict。 |
| `manage-recipient-save-error` | 姓名修改失败 | `/rm/:code` | 390/1280 | `viewport` | 是 | PATCH 网络失败。 |
| `manage-recipient-withdraw-confirm` | 撤回本人姓名线索确认框 | `/rm/:code` | 390/1280 | `native-surface` | 否 | 触发真实 window.confirm；不代造 native dialog。 |
| `manage-recipient-withdraw-saving` | 姓名线索正在撤回 | `/rm/:code` | 390/1280 | `viewport` | 是 | POST 挂起。 |
| `manage-recipient-withdraw-success` | 您的姓名线索已撤回 | `/rm/:code` | 390/1280 | `viewport` | 是 | POST 成功，state withdrawn。 |
| `manage-recipient-withdraw-error` | 本人姓名线索撤回失败 | `/rm/:code` | 390/1280 | `viewport` | 是 | POST 拒绝，保留登记。 |
| `manage-recipient-link-copied` | 姓名私密管理链接已复制 | `/rm/:code` | 390/1280 | `viewport` | 是 | 仅合成 capability，clipboard 允许。 |
| `manage-recipient-link-copy-error` | 姓名私密管理链接复制失败 | `/rm/:code` | 390/1280 | `viewport` | 是 | clipboard 拒绝。 |

### 扫码和相机

| Case id | 用户可见状态 | 安全路由 | 视口 | 捕获 | 全页 | 触发 / 观察 |
|---|---|---|---|---|---|---|
| `scanner-permission` | 正在申请摄像头权限 | `/` | 320/390/1280 | `viewport` | 否 | 挂起对应阶段，用合成摄像头替身，不拍真实私人面单。phase=permission。 |
| `scanner-opening` | 相机已开启正在准备识别 | `/` | 320/390/1280 | `viewport` | 否 | 挂起对应阶段，用合成摄像头替身，不拍真实私人面单。phase=opening。 |
| `scanner-switching` | 正在切换摄像头 | `/` | 320/390/1280 | `viewport` | 否 | 挂起对应阶段，用合成摄像头替身，不拍真实私人面单。phase=switching。 |
| `scanner-photo-ready` | 拍照识别默认就绪 | `/` | 320/390/1280 | `viewport` | 否 | phase=scanning、scanMode=photo；完整合成条码预览。 |
| `scanner-photo-busy` | 已拍照正在本机识别 | `/` | 320/390/1280 | `viewport` | 否 | 挂起 capture decode；真实渲染 photoBusy、冻结画面和按钮。 |
| `scanner-photo-not-found` | 照片未识别到条码 | `/` | 320/390/1280 | `viewport` | 否 | capture 返回 not_found；展示可重拍提示。 |
| `scanner-photo-error` | 拍照识别未完成 | `/` | 320/390/1280 | `viewport` | 否 | capture 抛普通错误；相机仍开。 |
| `scanner-photo-preview-error` | 相机画面未恢复 | `/` | 320/390/1280 | `viewport` | 否 | capture 完成后 video.play 拒绝，显示画面恢复失败。 |
| `scanner-realtime-ready` | 自动扫码就绪 | `/` | 320/390/1280 | `viewport` | 否 | scanMode=realtime、phase=scanning。 |
| `scanner-realtime-distance-help` | 自动扫码四秒距离提醒 | `/` | 320/390/1280 | `viewport` | 否 | 4 秒无结果，helpStage=1。 |
| `scanner-realtime-light-help` | 自动扫码十秒光线提醒 | `/` | 320/390/1280 | `viewport` | 否 | 10 秒无结果，helpStage=2。 |
| `scanner-permission-denied` | 摄像头权限未开启 | `/` | 320/390/1280 | `viewport` | 否 | getUserMedia NotAllowedError 或 SecurityError；同用户可见文案不重复字符边界。 |
| `scanner-camera-not-found` | 未找到摄像头 | `/` | 320/390/1280 | `viewport` | 否 | getUserMedia NotFoundError 或 OverconstrainedError。 |
| `scanner-camera-busy` | 摄像头被占用 | `/` | 320/390/1280 | `viewport` | 否 | NotReadableError。 |
| `scanner-unsupported-browser` | 当前浏览器无法使用摄像头 | `/` | 320/390/1280 | `viewport` | 否 | 无 navigator.mediaDevices.getUserMedia。 |
| `scanner-camera-start-error` | 相机未能启动 | `/` | 320/390/1280 | `viewport` | 否 | 其他启动错误。 |
| `scanner-reader-error` | 识别组件未能加载 | `/` | 320/390/1280 | `viewport` | 否 | 预加载/解码组件失败，readerUnavailable=true，显示刷新页面重试。 |
| `scanner-error-alternate-camera` | 启动失败可选择其他摄像头 | `/` | 320/390/1280 | `viewport` | 否 | phase=error、camera=null、devices>1；展开相机设置。 |
| `scanner-settings-collapsed` | 相机设置收起 | `/` | 320/390/1280 | `viewport` | 否 | scanning 默认 settings details 收起。 |
| `scanner-settings-multiple-devices` | 选择摄像头设置 | `/` | 320/390/1280 | `viewport` | 否 | 展开、至少两台 synthetic devices。 |
| `scanner-settings-mirrored` | 左右翻转画面已开启 | `/` | 320/390/1280 | `viewport` | 否 | mirrored=true，按钮 pressed 与预览方向。 |
| `scanner-settings-unmirrored` | 左右翻转画面未开启 | `/` | 320/390/1280 | `viewport` | 否 | mirrored=false。 |
| `scanner-focus-unsupported` | 当前摄像头不支持网页调焦 | `/` | 320/390/1280 | `viewport` | 否 | focusModes=[]，显示距离提示。 |
| `scanner-focus-auto` | 自动对焦可用并选中 | `/` | 320/390/1280 | `viewport` | 否 | continuous 或 single-shot 确认，pressed true。 |
| `scanner-focus-manual` | 手动对焦和滑块 | `/` | 320/390/1280 | `viewport` | 否 | manual 支持且已确认，显示距离 slider。 |
| `scanner-focus-busy` | 正在调整对焦相机保持开启 | `/` | 320/390/1280 | `viewport` | 否 | 挂起 applyConstraints，focusBusy=true。 |
| `scanner-focus-confirmed-auto` | 相机已确认自动对焦 | `/` | 320/390/1280 | `viewport` | 否 | 自动对焦请求成功，显示确认文案。 |
| `scanner-focus-confirmed-manual` | 相机已确认手动对焦 | `/` | 320/390/1280 | `viewport` | 否 | 手动请求成功，显示确认文案。 |
| `scanner-focus-not-switched` | 相机没有切换到所选对焦方式 | `/` | 320/390/1280 | `viewport` | 否 | 观测 focusMode 与 requested 不同。 |
| `scanner-focus-unconfirmed` | 调整对焦暂未确认当前方式 | `/` | 320/390/1280 | `viewport` | 否 | 观测无 focusMode。 |
| `scanner-focus-error` | 对焦调整没有成功 | `/` | 320/390/1280 | `viewport` | 否 | applyConstraints 拒绝，但相机保持开启。 |
| `scanner-close-manual` | 关闭扫码后手动输入 | `/` | 320/390/1280 | `viewport` | 是 | 关闭后捕获首页；附轨道停止证据，不凭截图宣称相机已释放。 |
| `scanner-decoded` | 条码识别成功填号 | `/` | 320/390/1280 | `viewport` | 是 | 真实本机 decoder 或标记 synthetic decoder；返回首页只填号，无自动查询。 |
| `scanner-hidden-closed` | 切到后台后扫码关闭 | `/` | 320/390/1280 | `viewport` | 是 | visibilitychange hidden 后再返回页面，scanner 不复开；附轨道停止证据。 |
| `scanner-settings-bottom` | 相机设置展开后内部滚动末尾 | `/` | 320/390/1280 | `viewport` | 否 | 展开多设备/手动对焦设置，滚动相机内部到末尾，确认拍照/切换/关闭按钮可见。 |

### 建议与反馈弹窗

| Case id | 用户可见状态 | 安全路由 | 视口 | 捕获 | 全页 | 触发 / 观察 |
|---|---|---|---|---|---|---|
| `feedback-empty` | 建议与反馈空表单 | `/` | 320/390/1280 | `viewport` | 否 | 从页脚打开。 |
| `feedback-wechat` | 反馈带选填微信号 | `/` | 320/390/1280 | `viewport` | 否 | 填写合成内容和微信号。 |
| `feedback-phone` | 反馈带选填电话号码 | `/` | 320/390/1280 | `viewport` | 否 | 切换 phone，填写合成电话。 |
| `feedback-no-contact` | 反馈不留下联系方式 | `/` | 320/390/1280 | `viewport` | 否 | 有说明、contact.value 空。 |
| `feedback-long-content` | 长反馈与可见提交按钮 | `/` | 320/390/1280 | `viewport` | 否 | 2000 字合成说明；拍顶部和内部滚动末尾，手机提交始终可见。 |
| `feedback-message-error` | 反馈说明校验失败 | `/` | 320/390/1280 | `viewport` | 否 | 非法长度/内容触发实际 message validator 错误。 |
| `feedback-wechat-error` | 反馈微信号校验失败 | `/` | 320/390/1280 | `viewport` | 否 | 非法选填微信；空值允许。 |
| `feedback-phone-error` | 反馈电话号码校验失败 | `/` | 320/390/1280 | `viewport` | 否 | 非法选填电话。 |
| `feedback-submitting` | 反馈正在提交 | `/` | 320/390/1280 | `viewport` | 否 | 挂起 POST /v1/feedback。 |
| `feedback-submit-error` | 反馈提交失败保留内容 | `/` | 320/390/1280 | `viewport` | 否 | POST 失败，正文、联系和原请求键保留。 |
| `feedback-unconfirmed` | 尚未收到反馈提交确认 | `/` | 320/390/1280 | `viewport` | 否 | response.submitted 不为 true；显示“尚未收到提交确认，请重试”。 |
| `feedback-success` | 反馈已收到谢谢你的帮助 | `/` | 320/390/1280 | `viewport` | 否 | submitted=true 的 mock 返回后才成功。 |
| `feedback-long-content-bottom` | 长反馈滚动末尾仍可提交 | `/` | 320/390/1280 | `viewport` | 否 | 滚动反馈内部内容到底，截图确认提交反馈按钮保持可见。 |

### 管理员认证

| Case id | 用户可见状态 | 安全路由 | 视口 | 捕获 | 全页 | 触发 / 观察 |
|---|---|---|---|---|---|---|
| `admin-auth-session-loading` | 正在验证管理员会话 | `/admin` | 390/1280 | `viewport` | 是 | 认证 getSession 挂起。 |
| `admin-auth-login` | 工作台登录 | `/admin` | 320/390/1280 | `viewport` | 是 | 无 session、auth 已配置，synthetic email；不得显示真实账号。 |
| `admin-auth-unconfigured` | 管理员认证服务尚未配置 | `/admin` | 390/1280 | `viewport` | 是 | auth=null 构建，登录与重置按钮 disabled。 |
| `admin-auth-session-error` | 管理员会话读取失败 | `/admin` | 390/1280 | `viewport` | 是 | getSession 拒绝，显示检查网络后重新登录。 |
| `admin-auth-login-busy` | 正在登录工作台 | `/admin` | 390/1280 | `viewport` | 是 | 挂起 signInWithPassword；不调用真实 auth。 |
| `admin-auth-login-error` | 管理员登录失败 | `/admin` | 390/1280 | `viewport` | 是 | synthetic signIn 错误。 |
| `admin-auth-reset-invalid-email` | 重置密码邮箱校验错误 | `/admin` | 390/1280 | `native-surface` | 否 | 真实键入无效非空邮箱后点击设置/重置；捕获浏览器 reportValidity 原生验证提示，不发送真实邮件、不以 JSX 代造。 |
| `admin-auth-reset-busy` | 正在发送密码设置邮件 | `/admin` | 390/1280 | `viewport` | 是 | auth reset 挂起；绝不发真实邮件。 |
| `admin-auth-reset-sent` | 密码设置邮件请求已确认 | `/admin` | 390/1280 | `viewport` | 是 | synthetic reset 成功，显示条件性发送提示。 |
| `admin-auth-reset-error` | 密码设置邮件请求失败 | `/admin` | 390/1280 | `viewport` | 是 | synthetic auth API 返回失败。 |
| `admin-auth-forbidden` | 非授权管理员读取被拒绝 | `/admin` | 390/1280 | `viewport` | 是 | synthetic session 但 API 返回 Forbidden；不得放松白名单。 |
| `admin-auth-recovery-pending` | 验证密码设置链接 | `/admin` | 390/1280 | `viewport` | 是 | recovery=pending，显示正在验证安全链接。 |
| `admin-auth-recovery-expired` | 密码设置链接已失效 | `/admin` | 320/390/1280 | `viewport` | 是 | recovery=expired；重申请入口。 |
| `admin-auth-recovery-unconfigured` | 密码恢复时认证服务未配置 | `/admin` | 390/1280 | `viewport` | 是 | recovery=expired + auth=null。 |
| `admin-auth-recovery-ready` | 设置管理员密码 | `/admin` | 320/390/1280 | `viewport` | 是 | recovery=ready + synthetic session，空新密码表单。 |
| `admin-auth-password-short` | 新密码不足十二字符 | `/admin` | 390/1280 | `native-surface` | 否 | 用真实键入填写不足12字符密码并点击保存，捕获浏览器 minLength/required 真实原生验证提示；不能绕过表单校验去代造 ErrorNote，不一致用例覆盖可触达的组件错误。 |
| `admin-auth-password-mismatch` | 两次新密码不一致 | `/admin` | 390/1280 | `viewport` | 是 | 提交不同的 synthetic passwords。 |
| `admin-auth-password-busy` | 正在保存管理员新密码 | `/admin` | 390/1280 | `viewport` | 是 | 挂起 auth.updateUser，密码字段可遮盖真实 UI，本身仅 synthetic。 |
| `admin-auth-password-error` | 管理员密码设置失败 | `/admin` | 390/1280 | `viewport` | 是 | synthetic updateUser 拒绝。 |
| `admin-auth-password-complete` | 密码设置成功进入工作台 | `/admin` | 390/1280 | `viewport` | 是 | recovery=complete，notice 及 admin 首屏。 |

### 管理员单号与跟进

| Case id | 用户可见状态 | 安全路由 | 视口 | 捕获 | 全页 | 触发 / 观察 |
|---|---|---|---|---|---|---|
| `admin-waybills-list` | 单号与跟进有记录 | `/admin` | 320/390/1280 | `viewport` | 是 | tab=waybills；synthetic session + /v1/admin/waybills 数据。 |
| `admin-waybills-loading` | 单号列表正在读取 | `/admin` | 390/1280 | `viewport` | 是 | 挂起 list。 |
| `admin-waybills-empty` | 单号列表目前没有记录 | `/admin` | 390/1280 | `viewport` | 是 | items=[]。 |
| `admin-waybills-error` | 单号列表读取失败 | `/admin` | 390/1280 | `viewport` | 是 | list 拒绝，authorizedToken 不成立。 |
| `admin-waybills-pagination` | 单号列表下一页 | `/admin` | 390/1280 | `viewport` | 是 | nextOffset 非空并 offset=50，上一页可用。 |
| `admin-clue-lookup-empty` | 按线索编号查看登记 | `/admin` | 390/1280 | `viewport` | 是 | 已获授权，空 lookup 表单。 |
| `admin-clue-lookup-invalid` | 线索编号格式错误 | `/admin` | 390/1280 | `viewport` | 是 | 填写非 PDD-12hex 的合成值。 |
| `admin-clue-lookup-loading` | 正在查看线索登记可取消 | `/admin` | 390/1280 | `viewport` | 是 | 挂起 adminDetail，显示“正在查看…”和“取消读取”。 |
| `admin-clue-lookup-not-found` | 没有找到这个线索编号 | `/admin` | 390/1280 | `viewport` | 是 | detail 返回 NOT_FOUND。 |
| `admin-clue-lookup-error` | 登记详情读取失败 | `/admin` | 390/1280 | `viewport` | 是 | detail 返回普通错误/Forbidden。 |
| `admin-waybill-detail-open` | 单号详情 · 正在寻找 | `/admin` | 320/390/1280 | `viewport` | 是 | detail.record.resolution=open；合成双方登记、查询时间线、管理操作事件，观察 verify/claim/return disabled 条件。 |
| `admin-waybill-detail-verifying` | 单号详情 · 正在核实 | `/admin` | 390/1280 | `viewport` | 是 | detail.record.resolution=verifying；合成双方登记、查询时间线、管理操作事件，观察 verify/claim/return disabled 条件。 |
| `admin-waybill-detail-claimed` | 单号详情 · 已认领，待交还 | `/admin` | 390/1280 | `viewport` | 是 | detail.record.resolution=claimed；合成双方登记、查询时间线、管理操作事件，观察 verify/claim/return disabled 条件。 |
| `admin-waybill-detail-resolved` | 单号详情 · 已交还 | `/admin` | 390/1280 | `viewport` | 是 | detail.record.resolution=resolved；合成双方登记、查询时间线、管理操作事件，观察 verify/claim/return disabled 条件。 |
| `admin-waybill-detail-one-side` | 单号详情仅一方登记 | `/admin` | 390/1280 | `viewport` | 是 | 仅 lost 或 received，真实完整同号主记录结构。 |
| `admin-waybill-detail-withdrawn` | 单号详情带已撤回登记 | `/admin` | 390/1280 | `viewport` | 是 | registration.visibility=withdrawn，撤回按钮不显示。 |
| `admin-waybill-detail-cleaned` | 单号详情联系方式已清理 | `/admin` | 390/1280 | `viewport` | 是 | registration.contact=null。 |
| `admin-waybill-detail-note` | 单号详情姓名和登记备注 | `/admin` | 390/1280 | `viewport` | 是 | registration.recipientName、note 合成；textarea 跟进备注填写。 |
| `admin-waybill-action-saving` | 管理员操作正在保存 | `/admin` | 390/1280 | `viewport` | 是 | 挂起 adminAction，显示 Busy 与 disabled。 |
| `admin-waybill-action-saved` | 管理员操作已保存并记录审计 | `/admin` | 390/1280 | `viewport` | 是 | 操作成功、detail 重新加载、notice。 |
| `admin-waybill-action-conflict` | 管理员单号操作版本冲突 | `/admin` | 390/1280 | `viewport` | 是 | adminAction 返回 conflict。 |
| `admin-waybill-action-error` | 管理员单号操作失败 | `/admin` | 390/1280 | `viewport` | 是 | adminAction 普通失败。 |
| `admin-waybill-return-confirm` | 确认包裹已实际交还对话框 | `/admin` | 390/1280 | `native-surface` | 否 | 触发真实 window.confirm，不代造 native dialog。 |
| `admin-waybill-withdraw-confirm` | 管理员撤回登记确认框 | `/admin` | 390/1280 | `native-surface` | 否 | 触发真实 window.confirm。 |

### 管理员姓名线索

| Case id | 用户可见状态 | 安全路由 | 视口 | 捕获 | 全页 | 触发 / 观察 |
|---|---|---|---|---|---|---|
| `admin-recipients-list` | 姓名线索有记录 | `/admin` | 320/390/1280 | `viewport` | 是 | tab=recipients，synthetic auth/API。 |
| `admin-recipients-loading` | 姓名线索正在读取 | `/admin` | 390/1280 | `viewport` | 是 | 挂起 list。 |
| `admin-recipients-empty` | 姓名线索目前没有记录 | `/admin` | 390/1280 | `viewport` | 是 | items=[]。 |
| `admin-recipients-error` | 姓名线索读取失败 | `/admin` | 390/1280 | `viewport` | 是 | list 拒绝。 |
| `admin-recipients-pagination` | 姓名线索下一页 | `/admin` | 390/1280 | `viewport` | 是 | offset=50,nextOffset 非空。 |
| `admin-recipient-detail-active` | 姓名详情 · 正在寻找 | `/admin` | 320/390/1280 | `viewport` | 是 | registration.state=active，带审计；观察 review/close/withdraw 按钮。 |
| `admin-recipient-detail-reviewing` | 姓名详情 · 正在跟进 | `/admin` | 390/1280 | `viewport` | 是 | registration.state=reviewing，带审计；观察 review/close/withdraw 按钮。 |
| `admin-recipient-detail-closed` | 姓名详情 · 已结案 | `/admin` | 390/1280 | `viewport` | 是 | registration.state=closed，带审计；观察 review/close/withdraw 按钮。 |
| `admin-recipient-detail-withdrawn` | 姓名详情 · 已撤回 | `/admin` | 390/1280 | `viewport` | 是 | registration.state=withdrawn，带审计；观察 review/close/withdraw 按钮。 |
| `admin-recipient-detail-cleaned` | 姓名详情姓名和联系已清理 | `/admin` | 390/1280 | `viewport` | 是 | recipientName=null,contact=null。 |
| `admin-recipient-detail-note` | 姓名详情补充说明 | `/admin` | 390/1280 | `viewport` | 是 | 合成较长 note。 |
| `admin-recipient-action-saving` | 姓名管理员操作正在保存 | `/admin` | 390/1280 | `viewport` | 是 | 挂起 recipientAction。 |
| `admin-recipient-action-conflict` | 姓名管理员操作版本冲突 | `/admin` | 390/1280 | `viewport` | 是 | POST conflict。 |
| `admin-recipient-action-error` | 姓名管理员操作失败 | `/admin` | 390/1280 | `viewport` | 是 | POST 失败。 |
| `admin-recipient-close-confirm` | 单条姓名结案确认框 | `/admin` | 390/1280 | `native-surface` | 否 | 真实 confirm；文案说明同名其他线索不受影响、包裹统计不变。 |
| `admin-recipient-withdraw-confirm` | 管理员撤回单条姓名确认框 | `/admin` | 390/1280 | `native-surface` | 否 | 真实 confirm。 |

### 管理员单号查询日志

| Case id | 用户可见状态 | 安全路由 | 视口 | 捕获 | 全页 | 触发 / 观察 |
|---|---|---|---|---|---|---|
| `admin-waybill-queries-list` | 单号查询日志有记录 | `/admin` | 320/390/1280 | `viewport` | 是 | tab=queries；合成服务端 queriedAt，涵盖不同 result；单号含 manual/barcode 和可选查询联系。 |
| `admin-waybill-queries-loading` | 单号查询日志读取中 | `/admin` | 390/1280 | `viewport` | 是 | 挂起 GET。 |
| `admin-waybill-queries-empty` | 单号查询日志没有记录 | `/admin` | 390/1280 | `viewport` | 是 | items=[]。 |
| `admin-waybill-queries-error` | 单号查询日志读取失败 | `/admin` | 390/1280 | `viewport` | 是 | GET 拒绝。 |
| `admin-waybill-queries-pagination` | 单号查询日志下一页 | `/admin` | 390/1280 | `viewport` | 是 | offset=50,nextOffset 非空。 |

### 管理员姓名查询日志

| Case id | 用户可见状态 | 安全路由 | 视口 | 捕获 | 全页 | 触发 / 观察 |
|---|---|---|---|---|---|---|
| `admin-recipient-queries-list` | 姓名查询日志有记录 | `/admin` | 320/390/1280 | `viewport` | 是 | tab=recipientQueries；合成服务端 queriedAt，涵盖不同 result；单号含 manual/barcode 和可选查询联系。 |
| `admin-recipient-queries-loading` | 姓名查询日志读取中 | `/admin` | 390/1280 | `viewport` | 是 | 挂起 GET。 |
| `admin-recipient-queries-empty` | 姓名查询日志没有记录 | `/admin` | 390/1280 | `viewport` | 是 | items=[]。 |
| `admin-recipient-queries-error` | 姓名查询日志读取失败 | `/admin` | 390/1280 | `viewport` | 是 | GET 拒绝。 |
| `admin-recipient-queries-pagination` | 姓名查询日志下一页 | `/admin` | 390/1280 | `viewport` | 是 | offset=50,nextOffset 非空。 |

### 管理员社区入口

| Case id | 用户可见状态 | 安全路由 | 视口 | 捕获 | 全页 | 触发 / 观察 |
|---|---|---|---|---|---|---|
| `admin-community-configured` | 真实社区入口配置表单 | `/admin` | 320/390/1280 | `viewport` | 是 | tab=community；使用已有公开配置或空配置，无假 QR。 |
| `admin-community-empty` | 社区入口缺配置 | `/admin` | 390/1280 | `viewport` | 是 | 所有可选配置空，登记关闭。 |
| `admin-community-registration-enabled` | 开放正式登记已勾选 | `/admin` | 390/1280 | `viewport` | 是 | synthetic settings submissionsEnabled=true，不 PATCH 生产。 |
| `admin-community-registration-disabled` | 开放正式登记未勾选 | `/admin` | 390/1280 | `viewport` | 是 | submissionsEnabled=false。 |
| `admin-community-loading` | 社区配置正在读取 | `/admin` | 390/1280 | `viewport` | 是 | GET 挂起。 |
| `admin-community-read-error` | 社区配置读取失败 | `/admin` | 390/1280 | `viewport` | 是 | GET 失败。 |
| `admin-community-saving` | 正在保存社区配置 | `/admin` | 390/1280 | `viewport` | 是 | PATCH mock 挂起，表单 disabled。 |
| `admin-community-saved` | 社区入口已保存并记录审计 | `/admin` | 390/1280 | `viewport` | 是 | PATCH mock 成功。 |
| `admin-community-save-error` | 社区入口保存失败 | `/admin` | 390/1280 | `viewport` | 是 | PATCH mock 失败。 |

### 管理员建议与反馈

| Case id | 用户可见状态 | 安全路由 | 视口 | 捕获 | 全页 | 触发 / 观察 |
|---|---|---|---|---|---|---|
| `admin-feedback-list` | 建议与反馈列表 | `/admin` | 320/390/1280 | `viewport` | 是 | tab=feedback，混合合成反馈。 |
| `admin-feedback-new` | 待查看反馈 | `/admin` | 390/1280 | `viewport` | 是 | status=new 的 item。 |
| `admin-feedback-reviewed` | 已查看反馈 | `/admin` | 390/1280 | `viewport` | 是 | status=reviewed。 |
| `admin-feedback-closed` | 已处理反馈 | `/admin` | 390/1280 | `viewport` | 是 | status=closed。 |
| `admin-feedback-contact-wechat` | 反馈带微信联系方式 | `/admin` | 390/1280 | `viewport` | 是 | contact.kind=wechat，合成。 |
| `admin-feedback-contact-phone` | 反馈带电话号码 | `/admin` | 390/1280 | `viewport` | 是 | contact.kind=phone，合成。 |
| `admin-feedback-no-contact` | 反馈未留下联系方式 | `/admin` | 390/1280 | `viewport` | 是 | contact=null。 |
| `admin-feedback-filtered` | 按处理状态筛选反馈 | `/admin` | 390/1280 | `viewport` | 是 | filter 非空，列表对应状态。 |
| `admin-feedback-empty` | 暂时没有符合条件的反馈 | `/admin` | 390/1280 | `viewport` | 是 | items=[]，total 按 mock。 |
| `admin-feedback-loading` | 正在读取反馈 | `/admin` | 390/1280 | `viewport` | 是 | list 挂起。 |
| `admin-feedback-error` | 反馈读取失败 | `/admin` | 390/1280 | `viewport` | 是 | list 拒绝。 |
| `admin-feedback-pagination` | 反馈下一页 | `/admin` | 390/1280 | `viewport` | 是 | offset=50，nextOffset 非空。 |
| `admin-feedback-changing` | 反馈状态正在保存 | `/admin` | 390/1280 | `viewport` | 是 | changing 当前 item id，按钮“正在保存…”。 |
| `admin-feedback-change-error` | 反馈处理状态保存失败 | `/admin` | 390/1280 | `viewport` | 是 | PATCH 拒绝。 |

### 管理员数据与监控

| Case id | 用户可见状态 | 安全路由 | 视口 | 捕获 | 全页 | 触发 / 观察 |
|---|---|---|---|---|---|---|
| `admin-monitor-loading` | 监控数据读取中 | `/admin` | 390/1280 | `viewport` | 是 | tab=monitoring，system+analytics 挂起。 |
| `admin-monitor-healthy` | 服务探测正常且可接收登记 | `/admin` | 320/390/1280 | `viewport` | 是 | system.ok=ready=true，有 synthetic db 与 analytics。 |
| `admin-monitor-unhealthy` | 服务异常 | `/admin` | 390/1280 | `viewport` | 是 | system.ok=false，有实际 code 对应的合成 warnings。 |
| `admin-monitor-not-ready` | 登记未就绪 | `/admin` | 390/1280 | `viewport` | 是 | system.ready=false。 |
| `admin-monitor-warnings` | 监控告警列表 | `/admin` | 390/1280 | `viewport` | 是 | 覆盖配置、连接、空间、锁/长事务、预算类已定义 warning 文案；至少一未知 code 的通用文案。 |
| `admin-monitor-no-database` | 监控没有数据库信息 | `/admin` | 390/1280 | `viewport` | 是 | system.database=null。 |
| `admin-monitor-quota-unconfigured` | 数据库容量上限未配置 | `/admin` | 390/1280 | `viewport` | 是 | databaseSizeLimitBytes=null。 |
| `admin-monitor-system-error` | 服务状态暂不可用 | `/admin` | 390/1280 | `viewport` | 是 | system 请求失败但 analytics 成功。 |
| `admin-monitor-analytics-error` | 部分站内统计读取失败 | `/admin` | 390/1280 | `viewport` | 是 | system 成功，analytics 失败。 |
| `admin-monitor-all-error` | 全部监控读取失败 | `/admin` | 390/1280 | `viewport` | 是 | 两个请求均失败，错误和服务不可用提示。 |
| `admin-monitor-seven-days` | 最近七天统计 | `/admin` | 390/1280 | `viewport` | 是 | days=7，有非空页面浏览与停留数据。 |
| `admin-monitor-thirty-days` | 最近三十天统计 | `/admin` | 390/1280 | `viewport` | 是 | days=30，重新请求并显示对应范围。 |
| `admin-monitor-analytics-disabled` | 站内埋点尚未启用 | `/admin` | 390/1280 | `viewport` | 是 | analytics.enabled=false。 |
| `admin-monitor-empty-analytics` | 尚未收到埋点数据 | `/admin` | 390/1280 | `viewport` | 是 | rows=[]，页面浏览/停留图均为空。 |
| `admin-monitor-view-chart` | 每日页面浏览图表 | `/admin` | 390/1280 | `viewport` | 是 | views 非零。 |
| `admin-monitor-dwell-chart` | 可见停留分布图表 | `/admin` | 390/1280 | `viewport` | 是 | dwell 非零，多个 bucket。 |
| `admin-monitor-events-table` | 操作明细和中文操作元信息 | `/admin` | 390/1280 | `viewport` | 是 | rows 含 waybill/recipient/scanner 等 events 与 metadata；不含真实线索或凭证。 |
| `admin-monitor-no-budget` | 今日尚无采集配额记录 | `/admin` | 390/1280 | `viewport` | 是 | budget 无 today entry。 |
| `admin-monitor-budget-active` | 今日统计采集正常配额 | `/admin` | 390/1280 | `viewport` | 是 | today budget，limitedAt=null。 |
| `admin-monitor-budget-limited` | 今日统计采集已暂停 | `/admin` | 390/1280 | `viewport` | 是 | limitedAt 非空，budget max；强调查询登记仍可使用。 |
| `admin-monitor-refreshing` | 正在刷新监控 | `/admin` | 390/1280 | `viewport` | 是 | 已有数据下挂起 refresh，按钮读取中。 |

### 静态页面与导航

| Case id | 用户可见状态 | 安全路由 | 视口 | 捕获 | 全页 | 触发 / 观察 |
|---|---|---|---|---|---|---|
| `help-page` | 如何使用 PDD404 帮助页 | `/help` | 320/390/1280 | `viewport` | 是 | 完整六步、必读提醒、FAQ、返回查询和社区官网。 |
| `community-help-alias` | 社区旧路径展示帮助页 | `/community` | 320/390/1280 | `viewport` | 是 | /community 直接访问并刷新，当前实现 HelpPage。 |
| `privacy-page` | 隐私与使用说明 | `/privacy` | 320/390/1280 | `viewport` | 是 | 全页含完整姓名、单号例外、扫码、反馈、统计和保留期说明。 |
| `missing-page` | 这个页面不存在 | `/not-a-page` | 320/390/1280 | `viewport` | 是 | 未知安全路径。 |
| `manage-waybill-alias` | 旧本人管理路径正确显示 | `/manage/:code` | 390/1280 | `viewport` | 是 | /manage/:code 与 /m/:code 同组件，使用 synthetic capability。 |
| `admin-login-alias` | 旧管理员登录路径正确显示 | `/admin/login` | 390/1280 | `viewport` | 是 | 直接访问并刷新；AdminPage。 |
| `redirect-received` | 旧错收入口跳到找失主 | `/received/example` | 390/1280 | `viewport` | 是 | Navigate to /?mode=received。 |
| `redirect-search` | 旧查询入口跳到首页 | `/search/example` | 390/1280 | `viewport` | 是 | Navigate to /。 |
| `redirect-queue` | 旧队列入口跳到本机记录 | `/queue` | 390/1280 | `viewport` | 是 | Navigate to /local。 |
| `redirect-success` | 旧成功入口跳到本机记录 | `/success` | 390/1280 | `viewport` | 是 | Navigate to /local。 |
