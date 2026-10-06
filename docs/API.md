# PDD404 v0.2.0 API 合同

实现入口为 `supabase/functions/api/index.ts`、`_shared/waybill-api.ts` 和 `_shared/feedback-api.ts`，共享类型为 `shared/waybill.ts` 与 `shared/feedback.ts`；社区、历史统计、健康检查和统一响应沿用 `shared/contracts.ts`。修改字段必须同时更新服务端、类型、前端调用和验收。

## 地址、响应与权限

`VITE_API_BASE_URL=https://<project-ref>.supabase.co/functions/v1/api`，以下路径在其后追加 `/v1`。前端 `/p/:parentCode`、`/m/:registrationCode` 是页面路由。

成功响应为 `{data:T}`，失败为 `{error:{code,message,requestId,retryable}}`。写请求使用 `Content-Type: application/json`，请求体最多 32 KiB；字段严格白名单。CORS 只允许配置的网站 Origin，`OPTIONS` 返回 204，响应使用 `Cache-Control: no-store`。除 health 外，一级业务路由按来源指纹限流：每分钟 GET 120 次、写请求 20 次。

| 权限 | 请求方式 |
|---|---|
| 公开读取 | 无普通用户账号；只返回公开白名单 |
| 查询、登记、本人管理 | `Authorization: Bearer <capability>`；安全随机 32 字节，43 字符 base64url 或 64 字符十六进制 |
| 管理员 | `Authorization: Bearer <Supabase Auth access_token>`；服务端核验 Auth 用户及 `ADMIN_USER_IDS` |

capability 仅保存 SHA-256 摘要。查询凭证关联本次 queryId；批量凭证关联本批创建的本人登记。管理 URL 使用 fragment `/m/:registrationCode#key=…`，前端把它放进请求头；公开链接只含 `/p/:parentCode`。凭证不得写入查询参数、公开二维码或诊断日志。

业务表与 RPC 对 `anon`、普通 `authenticated` 全部拒绝直接访问；浏览器不能绕过 Edge API。service-role、数据库密码和 worker 密钥不得进入 `VITE_*`。

## 输入与结果

`mode` 为 `lost | received`，分别表示丢件和错收件；`source` 为 `manual | barcode`。`number` 仅接受完整国内运输单号：删除空白、转大写，保留前导零；规范结果为 6–40 位 ASCII 字母或数字。不推测缺位、不转换全角字符，不以尾号、拼多多订单号、商品条码或集运总单代替国内运单。

```ts
type PddContact = { kind: 'wechat' | 'phone'; value: string };
```

微信号字母开头，6–64 字符，后续为字母、数字、下划线或连字符；不接受昵称。电话最多 32 字符，至少 7 个数字，可包含开头 `+`、空格、括号和连字符。表单明确说明：相同完整单号的另一方可查看这项自填联系方式；不要求注册或额外互相批准。

查询依次判断：有效对侧登记 → `matched`；否则同侧已有登记 → `duplicate`；否则 → `not_found`。已实际交还为 `closed`。已撤回、联系资料已清理或已知承运商冲突不能返回对侧联系方式。服务失败必须是错误，不能当作 `not_found`。

**专用完整单号查询是直接联系方式及用户自填备注的明确例外。** `matched` 结果允许返回 `{kind,value}` 及对侧 `note`，不提供地址字段、原图、OCR、凭证、管理 URL 或管理员功能。普通公开记录始终不含联系方式、备注和完整单号；不存在通过公开编号、尾号或 query flag 解锁这些资料的接口。单号匹配不证明归属或交还。

## 公开与本人接口

| 方法及路径 | 请求 | 返回 data |
|---|---|---|
| `GET /v1/health` | 无 | `Health`：`service=pdd404`、版本、SHA、环境、ok、ready |
| `GET /v1/community` | 无 | `Community`；缺项为 null，不使用假二维码 |
| `GET /v1/stats` | 无 | `Stats`：有效误收包裹数、按联系方式规范值去重的未完成寻件人数；实际交还数不大于 5 时为 null |
| `GET /v1/waybill-stats` | 无 | `{lostRegistered,receivedRegistered,matchedParcels}`，三个非负安全整数 |
| `POST /v1/waybill-queries` | 本人头；`{queryId,number,mode,source}` | `PddQueryResult`；HTTP 200 |
| `POST /v1/waybill-queries/:queryId/contact` | 查询凭证、稳定 `Idempotency-Key`；`{contact}` | `PddQueryContactResult`；HTTP 200 |
| `POST /v1/waybill-batches` | 本批凭证、稳定 `Idempotency-Key`；`{mode,contact,note?,items:[{requestId,number,source}]}` | `PddBatchResult`；HTTP 200 |
| `POST /v1/feedback` | 稳定UUID `Idempotency-Key`；`{message,contact?}`，无需账号或包裹凭证 | `{submitted:true,feedbackId,submittedAt}`；HTTP 201 |
| `GET /v1/waybills/:parentCode` | 公开 | `PddPublicRecord` |
| `GET /v1/waybill-manage/:registrationCode` | 本人凭证 | `PddRegistration` |
| `PATCH /v1/waybill-manage/:registrationCode` | 本人凭证；`{revision,contact}` | 更新后的 `PddRegistration` |
| `POST /v1/waybill-manage/:registrationCode/withdraw` | 本人凭证；`{revision}` | 撤回后的 `PddRegistration` |

`PddQueryResult={queryId,result,queriedAt,record,registeredAt,contact,note}`。`result` 为 `matched | duplicate | not_found | closed`；未匹配时 `contact` 和 `note` 均为 null。每次用户明确查询产生新 UUID；网络重试保留 queryId、请求体和凭证，只记一次日志。日志记录规范单号、类型、来源、服务器具体时间和原始查询结果，保留 30 天。输入、扫码填号和逐字编辑不自动发查询。

首页累计登记按历史正式登记的 `(waybill_id,mode)` 去重，包括已撤回/已结案，不含查询日志与本机草稿。`matchedParcels` 按主记录首次成功查询/批量重查匹配时间去重；幂等重放读到新匹配时也仅标记一次。首次匹配标记永久保留，30天查询日志清理不减少累计数字。历史仅按已有 `matched` 查询日志回填，不推测丢失历史。旧 `/stats` 的实际交还计数与此独立。

批量 `note` 可省略、null或字符串，去两端空白，空串为null；最多500个Unicode字符，保留换行，拒绝非法控制字符。每个新登记复制同一备注，重复项不覆盖原值；旧客户端省略该字段与旧幂等请求继续兼容。非匹配的普通公开DTO不返回备注。

反馈 `message` 去两端空白后为1–2000个Unicode字符，可换行；可选 `contact` 与包裹联系校验相同。反馈写接口额外每分钟5次限流。相同请求编号/内容幂等，不同内容为409；公开响应只含提交回执，不返回任何反馈内容或联系方式。无公开列表或详情接口。

未匹配列表是本机草稿，查询日志不等于正式登记。批量每次 1–50 个不同单号，事务内重新核对当前状态，返回逐条 `registered | matched | duplicate | closed`；不会因查询与提交之间出现新登记而丢掉匹配。一个规范单号只有一条主记录，每侧最多一条有效登记，重复不会覆盖原联系方式或授予其管理权。

`PddBatchResult={submittedAt,items}`，每项为 `{requestId,number,result,record,registration,contact,note,registeredAt}`。新建的本人登记在 `registration`；重复为 null，匹配可附当前对侧联系方式及备注。

匹配后可选留自己的联系方式：自己的这一侧尚无有效登记时创建登记；已有登记时只把此次联系方式追加到查询历史，`registration=null`，不覆盖原联系人。返回 `{saved:true,registration}`。首次留联系要求查询未超过 24 小时，且提交时仍能匹配。

`PddPublicRecord` 只包含 `code,tail,resolution,visibility,revision,lostRegistered,receivedRegistered,createdAt,updatedAt`。`PddRegistration` 再包含本人 `registrationCode,number,mode,source,contact,note,revision,visibility,createdAt,updatedAt,record`，不含凭证摘要；清理后 `contact=null,note=null` 且管理凭证失效。确认归属或交还后，本人不能撤回；有效登记的联系方式仍可在保留期内修改，修改联系方式保留已有备注。

`health.ok` 要求数据库/社区配置可读取且 PDD 表可用；`ready` 另要求有效社区资料、开启提交和管理员白名单，不依赖 OpenAI。两者都不能替代域名、真机或完整生产验收。

## 管理员接口

| 方法及路径 | 请求 / 返回 |
|---|---|
| `GET /v1/admin/waybills?offset=0` | `PddAdminList={items,nextOffset}`，每页 50 条 |
| `GET /v1/admin/waybills/:parentCode` | `PddAdminDetail={record,registrations,queries,events}`；查询、审计各取最新 100 条 |
| `GET /v1/admin/waybill-queries?offset=0` | `PddQueryLogPage={items,nextOffset}`，含尚无正式登记的查询，每页 50 条 |
| `POST /v1/admin/waybills/:parentCode/actions` | `{revision,action,registrationCode?,notes?}`；返回最新 `PddAdminDetail` |
| `GET /v1/admin/community` | `Community` |
| `GET /v1/admin/feedback?offset=0&status=new` | `{items,total,nextOffset}`；可省略status；每项仅 `id,message,contact,status,createdAt,updatedAt` |
| `PATCH /v1/admin/feedback/:feedbackId` | `{status:'new'|'reviewed'|'closed'}`；返回更新后的反馈，管理员核验后记录编号及状态审计 |
| `PATCH /v1/admin/community` | 可选更新 `groupQrUrl,assistantWechat,assistantQrUrl,officialAccountName,officialAccountQrUrl,submissionsEnabled`；返回 `Community` |

offset 为 0–100000 整数，使用 nextOffset，null 时结束。社区图片仅 HTTPS 或 null；备注最多 2000 字符。

action：`verify` 开始核实；`claim` 确认归属，进入待交还；`return` 记录实际交还；`withdraw` 撤回指定 registrationCode。每项操作记录管理员、时间和备注。claim 必须有有效误收登记；若失主在站外完成核实，不伪造失主登记。仅 return 写入按包裹唯一的交还事实，重复确认不增加计数。返回最新 revision 后才能继续操作。

## 幂等、清理与错误

同幂等键、同请求体及同凭证重放读取当前登记投影；不同内容或凭证返回 409。幂等回执只存编号，不缓存对方联系方式，撤回或修改后重试不会返回旧联系快照。联系方式/撤回/管理员操作使用正整数 revision；409 时重新读取，不静默覆盖。

单号锁、主记录唯一键、有效侧唯一索引和事务 RPC 保证并发安全。清理先取得相同的有序单号锁，撤销联系及凭证时递增登记版本；等待锁的管理修改必须重新核验凭证，不能恢复已清理个人信息。

| HTTP | code / 处理 |
|---|---|
| `400/422` | `INVALID_REQUEST,INVALID_WAYBILL,INVALID_CONTACT`；修正号码或本人表单 |
| `401/403` | `FORBIDDEN`；检查凭证或管理员登录，不返回私人资料 |
| `404` | `NOT_FOUND`；记录或接口不存在 |
| `409` | `VERSION_CONFLICT,IDEMPOTENCY_CONFLICT,OWNERSHIP_LOCKED,NEEDS_RECEIVED,INVALID_ADMIN_STATE`；读取最新状态或完成必要核实 |
| `410` | `QUERY_EXPIRED`；重新查询后再留联系方式 |
| `413/415` | `INVALID_REQUEST`；请求过大或不是 JSON |
| `429` | `RATE_LIMITED`；稍后重试，不绕过限额 |
| `503/500` | `SERVICE_UNAVAILABLE/INTERNAL_ERROR`；保留草稿和请求编号，不显示查无此件 |

全体查询日志与幂等元数据保留 30 天；登记结案/撤回 30 天后清除联系、管理凭证和批量备注，累计登记、首次匹配及匿名交还事实保留。反馈标记closed后30天删除内容和联系方式，审计仅保留编号与状态。诊断日志只记录请求编号与白名单错误码，不输出完整单号、联系方式、凭证或 SQL 原始错误。

## 数据库与旧 OCR 边界

本版物理表：`pdd_waybills,pdd_registrations,pdd_query_events,pdd_write_requests,pdd_audit_events,pdd_handovers,pdd_feedback`。事务 RPC 包含 `pdd_query,pdd_query_contact,pdd_batch_register,pdd_manage,pdd_manage_update,pdd_public,pdd_admin_list,pdd_admin_detail,pdd_admin_queries,pdd_admin_action,pdd_stats,pdd_home_stats,pdd_feedback_submit,pdd_admin_feedback_list,pdd_admin_feedback_update,pdd_cleanup`。RPC 请求字段为 snake_case，Edge API 和 DTO 为 camelCase；RPC 仅 service_role 可调用。

首发配置 `OCR_ENABLED=false`。旧 `scans/trackers/manage` 及管理员识别/任务/记录写入口返回服务暂停；候选 GET 也停止，避免读取触发匹配写入。历史公开或有凭证/管理员保护的详情仍可读取，不触发匹配或识别写入。worker 仍核验内部密钥，关闭 OCR 时只执行旧资料清理，返回 HTTP 202 `{accepted:true,mode:'cleanup'}`，不租用识别任务、不调用 OpenAI；旧图、证据、预算、租约和安全校验保留。PDD404 每小时第 17 分钟的 `pdd404-retention` 独立运行，不依赖 worker、OCR 任务或额度。重新启用 OCR 需另行验收其旧合同，不能只切开关便宣称可用。
