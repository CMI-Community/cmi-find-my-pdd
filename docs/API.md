# API 开发交接：v0.1.0

本文件描述当前实现，接口源为 `supabase/functions/api/index.ts`，客户端与服务端共同类型以 [`shared/contracts.ts`](../shared/contracts.ts) 为准。修改字段时同步更新类型、API、前端调用和验收；不要依靠旧聊天中的字段名开发。

## 地址、响应与请求头

前端 `VITE_API_BASE_URL` 配置为 `https://<project-ref>.supabase.co/functions/v1/api`。本文件所有业务路径均在其后追加 `/v1`，例如 `GET /v1/stats`。页面 `/p/:code`、`/m/:code` 和 `/search/:scanId` 是前端路由，不是 API 路径。

JSON 成功响应为 `ApiResponse<T>` 中的 `{ "data": T }`。失败响应统一为：

```json
{
  "error": {
    "code": "VERSION_CONFLICT",
    "message": "内容已更新或请求重复，请刷新后重试。",
    "requestId": "由服务器生成的请求编号",
    "retryable": false
  }
}
```

JSON 写请求使用 `Content-Type: application/json`；请求体最多 32 KiB。接口严格检查字段白名单，不接受客户端提交运单号、收件人、物品名、标签或 OCR 结果。`OPTIONS` 预检成功返回 `204`；仅允许配置中的网站 Origin。API 的 JSON 及已审核图片响应使用 `Cache-Control: no-store`；私密原图另用短期签名链接，客户端上传设置 `cacheControl=0`。

三种业务权限：

| 标记 | 请求方式与权限 |
|---|---|
| 公开 | 无需普通用户账号或管理凭证，只返回公开白名单 |
| 本人 | `Authorization: Bearer <capability>`，凭证只管理它关联的扫描及记录 |
| 管理员 | `Authorization: Bearer <Supabase Auth access_token>`；服务器验证用户并检查 `ADMIN_USER_IDS` 名单 |

普通用户不注册、不登录。客户端在首次请求前生成并保存 32 字节安全随机凭证，编码为 43 字符 base64url，或 64 字符十六进制。服务器只存 SHA-256 摘要。凭证不得出现在公开 URL、二维码、截图、日志或普通查询参数中；私密链接使用前端 fragment `/m/:code#key=...`，由前端读取后放入授权头。分享只复制 `/p/:code`。

数据库业务表与 RPC 不开放给 `anon`/普通 `authenticated`；浏览器不得用数据库直连代替此 API。服务端密钥与 worker 密钥不得进入 `VITE_*`。图片上传只使用 API 返回的限定签名槽位。

## 公开读接口

| 方法及路径 | 返回 `data` | 行为 |
|---|---|---|
| `GET /v1/health` | `Health` | `ok` 表示基础数据库与社区配置可读取；`ready` 还要求提交开关、有效群资料、识别配置及管理员名单齐备 |
| `GET /v1/stats` | `Stats` | 真实有效误收包裹数、按微信去重的活跃寻件人数；实际交还次数不大于 5 时为 `null` |
| `GET /v1/community` | `Community` | 群二维码、小助手、公众号、开源地址、`submissionsEnabled`、`ready`；缺项为 `null`，不用伪造入口 |
| `GET /v1/records/:code` | `PublicRecord` | 编号、脱敏品名与收件线索、号码类型及尾号、进度、更新时间、公开 URL 和已审核图片地址 |
| `GET /v1/records/:code/image` | 图片二进制 | 只有当前有效记录的 `image_approved=true` 安全副本可读取；未审核、撤回或不存在返回 `404` |

公开记录绝不返回双方微信、其他联系方式、完整单号、原始 OCR、原图路径或凭证。`withdrawn` 记录保留编号与最新状态，内容显示“记录已撤回”。交还后公开地址仍显示最新状态。`health.ok=true` 或一次图片上传成功都不能当作“识别已验收”或“已经上线可收录”的依据。

## 扫描、上传、识别与选择

此组接口均需本人凭证。`ScanCreate`、`ScanStart`、`ScanSubmit`、`ScanProgress`、`Contact` 和 `UploadSlot` 使用共享类型。

| 方法及路径 | JSON 请求 | 返回与状态 |
|---|---|---|
| `POST /v1/scans` | `ScanCreate`: `{requestId, intent, imageRoles}` | `201`，`ScanStart` |
| `POST /v1/scans/:id/submit` | `ScanSubmit`: `{imageVersion, imageIds, contact?, selectedIdentifierId?}`；首次识别提交带 `Idempotency-Key` | 初次提交 `202`，`ScanProgress`；已识别号码选择兼容分支为 `200` |
| `GET /v1/scans/:id` | 无 | `200`，本人完整识别结果、当前进度及脱敏候选 `ScanProgress` |
| `GET /v1/scans/:id/candidates` | 查询参数 `imageVersion=N&offset=20&selectedIdentifierId=ID`；未选号码时省略 `selectedIdentifierId` | `200`，`CandidatePage`；固定每页最多 20 条 |
| `POST /v1/scans/:id/select` | `{imageVersion, selectedIdentifierId}` | `200`，重新匹配后的 `ScanProgress`；不重新调用 OCR |
| `POST /v1/scans/:id/revisions` | `{expectedVersion, imageRoles}` | `201`，新版本 `ScanStart` |
| `POST /v1/scans/:id/retry` | `{imageVersion}` | `202`，`ScanProgress`；符合服务器重试条件才受理 |

`requestId` 为客户端预先生成并保存的 UUID。`intent` 为 `received` 或 `search`，图像角色为：

| intent | 必需角色 | 可选角色 |
|---|---|---|
| `received` | `label`：面单 | `item`：已拆开的物品 |
| `search` | `logistics`：物流截图 | `product`：商品截图 |

每次只接受 1–2 个不重复角色。创建接口不接收图片字节：返回的 `uploads` 含 `id`、`role`、`uploadUrl`、`path`、`token`、`bucket`；客户端使用 Supabase `uploadToSignedUrl(path, token, file)` 或等价签名上传，把文件传至指定槽位。完成全部上传后，再提交当前版本及全部 `imageIds`。

客户端先重新编码图片、移除定位元数据；格式为 JPEG、PNG、WebP，最长边不超过 2048px，单张不超过 5 MiB。提交时服务器实际下载槽位文件，校验归属、版本、角色、数量、文件存在、真实字节格式、尺寸及大小，不能以客户端 MIME/尺寸声明代替验证。

误收的 `submit` 必须携带本人 `Contact`，建立一个包裹对应的正式 `received` 记录及持久化任务。纯 `search` 查询不收联系方式，`contact` 不得传入；上传与识别只保留临时扫描，不自动建立追踪记录。

`Contact` 格式如下。`wechat` 必须为本人微信号，字母开头，6–64 字符，后续允许英文字母、数字、下划线与连字符；不能填昵称。`other` 可省略或为空，最多 160 字符。`groupDeclaration` 必须为 `true`，只是加群/加小助手声明，不授权访问他人联系方式。

```ts
const contact: Contact = {
  wechat: 'fictional_user',
  other: '',
  groupDeclaration: true,
};
```

`ScanProgress.state` 为 `draft | queued | running | succeeded | needs_photo | deferred | failed | cancelled`。上传状态由客户端上传队列维护，识别状态由服务器返回。`202` 只代表接收与排队，不能显示“信息已收录”；页面轮询本人扫描结果。`quality` 为 `complete | partial | unusable`，与 `state` 分开处理；`needs_photo`、`deferred`、`failed` 都不是“没有匹配”。

一个查询截图识别出多个不同的包裹运单线索时，`requiresSelection=true` 且暂不展示该次匹配结果。用户只可选择 `extraction.identifiers` 中现有的包裹运单 `id`；订单号、未知编号和手填编号都不可选。相同类型及规范值重复出现不会造成重复选择。推荐调用独立 `/select`；选中后保留完整只读提取结果，匹配仅使用所选运单。改选会使旧候选失效并重新比较；已确认归属或交还后不能改选。`submit` 的 `selectedIdentifierId` 分支兼容已识别扫描的选择操作，不应与首次图片提交混用。

重新拍照会递增 `imageVersion`，使旧任务与旧匹配失效；返回的是新槽位，旧图不能跨版本复用。客户端重新上传当前包所需的 1–2 张图；正式公开编号保持不变。原识别字段不能通过 PATCH 更正。重试不会清零三次总调用限制，预算暂停也不能靠连点绕过；耗尽重试或无效照片需补图/重拍。

## 主动追踪与本人管理

| 方法及路径 | JSON 请求 | 返回与状态 |
|---|---|---|
| `POST /v1/trackers` | `{scanId, imageVersion, selectedIdentifierId?, contact}`，带 `Idempotency-Key` | `201`，`{record: PublicRecord}` |
| `GET /v1/manage/:code` | 无 | `200`，`PrivateRecord` |
| `PATCH /v1/manage/:code` | `{revision, contact}` | `200`，更新后的 `PrivateRecord` |
| `POST /v1/manage/:code/withdraw` | `{revision}` | `200`，`{withdrawn: true}` |

均需对应扫描的本人凭证。追踪仅接受已完成有效识别的 `search` 扫描，完整或部分有效线索均可；要求号码选择尚未完成时不能登记。提交后再次比较当前误收资料，覆盖查询后新出现的包裹；既有扫描与凭证沿用，产生独立公开编号，不生成虚构联系任务。

`PrivateRecord` 包含本人联系方式、当前提取字段、照片、结果、`imageVersion`、`revision` 和 `canRevise`。私密原图签名 URL 有效期 120 秒，过期后重新读取管理 API，不永久保存或公开。`canRevise=false` 时来源图片更正交由管理员；本人联系方式仍可更新。撤回取消任务、失效匹配，公开旧链接显示撤回状态。凭证丢失不能凭编号/微信自动恢复，只能通过小助手人工核实后由管理员轮换。

## 管理员接口

此组均需有效管理员 JWT 与服务器白名单授权。列表使用 `?offset=0`，每页最多 50 条；继续加载增加 offset，直到返回不足 50 条。当前任务列表由前端按 `state` 分配待核实、待联系、待交还视图。

| 方法及路径 | JSON 请求 / 返回 `data` |
|---|---|
| `GET /v1/admin/records` | `AdminRecord[]`，全部登记 |
| `GET /v1/admin/duplicates` | `AdminRecord[]`，已标记重复的登记 |
| `GET /v1/admin/records/:code` | 单条 `AdminRecord`，含私密证据及本人联系方式 |
| `GET /v1/admin/tasks` | `AdminTask[]`，包括自动匹配任务与群内人工核实任务 |
| `GET /v1/admin/recognition` | 异常/处理中扫描数组：`id,intent,input_version,state,quality,error_code,updated_at,recordCode,contact`；无正式记录时后两项为 `null` |
| `GET /v1/admin/scans/:id` | `{scan: ScanProgress, images: {id,role,url}[], contact: Contact|null, recordCode: string|null}`，可查看尚无正式记录的异常扫描 |
| `POST /v1/admin/scans/:id/retry` | 请求 `{imageVersion}`；`202`，`ScanProgress` |
| `GET /v1/admin/community` | `Community` |
| `PATCH /v1/admin/community` | 可选更新 `groupQrUrl,assistantWechat,assistantQrUrl,officialAccountName,officialAccountQrUrl,submissionsEnabled`；`200`，`Community` |
| `GET /v1/admin/audit` | 数组元素为 `id,action,actor_id,record_id,created_at`，不返回私密审计 payload |
| `POST /v1/admin/tasks` | `{receivedCode,trackingCode?,notes?}`；`201`，管理员操作回执 |
| `PATCH /v1/admin/tasks/:id` | `{action,notes?}`；`200`，管理员操作回执 |

群资料图片地址只接受 HTTPS 或 `null`，提交开关必须为布尔值。管理员自行提供有效群资料，API 不生成二维码替代真实入口。

`POST /admin/tasks` 用于群内截图线索的人工核实：`receivedCode` 必须是有效且尚未确认交还的误收包裹；`trackingCode` 可省略，只有真实追踪登记才填写。管理员应通过编号打开记录，不为一次未登记查询伪造失主联系记录。备注最多 2000 字符。

`PATCH /admin/tasks/:id` 的 action 与效果：

| action | 效果 |
|---|---|
| `verify` | 核实候选，进入 `ready_to_contact` |
| `contact_received` | 记录已联系误收者时间 |
| `contact_tracking` | 记录已联系登记失主时间 |
| `mark_claimed` | 确认归属，双方进入 `claimed`，任务进入 `awaiting_handover`；不增加交还数 |
| `confirm_handover` | 必须已确认归属；双方进入 `resolved`，任务关闭，实际交还幂等计数 |
| `reject` | 排除错误匹配/关闭人工核实；已确认归属的任务不能直接当普通候选排除 |

数据库进一步检查状态、记录类型、版本与是否已被其他任务认领。管理员操作回执为 `{ok: true, action: string, followupId: string|null}`；它不是完整详情 DTO，操作后重新加载任务与记录。

单条记录操作均为 `POST /v1/admin/records/:code/:action`，成功 `200`：

| action | 请求 | 行为 |
|---|---|---|
| `retry` | `{revision}` | 按当前图片版本重新处理，受重试/预算限制 |
| `withdraw` | `{revision}` | 管理员撤回 |
| `duplicate` | `{revision,duplicateOf}` | `duplicateOf` 是另一条同类型有效原始登记的数据库 UUID，不是公开编号；当前重复记录撤回，排除统计 |
| `rotate` | `{revision}` | 核实后重新签发本人管理凭证；返回 `{rotated:true,privateLink:string}`，仅当场交付给本人，旧凭证失效 |
| `imageapproval` | `{revision,imageId,confirmedSafe:true}` | 仅限当前版本 `item/product`；管理员实际查看并确认无面单、地址、联系方式后，服务器移除隐藏元数据并保存安全副本 |

`imageapproval` 不接受面单，且不自动判断原图中的可见隐私；有敏感内容时先让本人提交已遮挡的物品图，再批准。重拍会取消旧图审批，原公开图片地址不能继续访问旧副本。除 `rotate` 特殊回执外，记录操作返回上述管理员操作回执。

## 幂等、版本与重试合同

`POST /scans` 的 `requestId` 兼作幂等标识：同 ID、同凭证、同 intent 和同顺序 `imageRoles` 复用扫描及槽位；改变内容返回 `409`。已开始处理的扫描不能再次创建，改读 GET 进度。请求前持久保存 ID、凭证及照片，超时后不要立刻生成新 ID。

首次识别 `submit` 和正式 `/trackers` 必须携带稳定 `Idempotency-Key`。同标识同内容返回原处理结果；同标识不同内容返回 `409`。JSON 对象字段顺序不影响摘要，数组顺序仍参与摘要。网络失败重试保留请求体、ID 和凭证；查询实际进度后再决定重发。`202` 后服务器的持久化任务继续运行，页面关闭不会取消已经上传并接收的任务。

`imageVersion/expectedVersion` 保护来源图片版本；`revision` 保护联系方式、撤回与管理员记录操作。版本必须为正整数。`409` 时读取最新状态，让用户确认当前照片/记录后再操作，不能改成新版本号静默覆盖。已过期临时查询为 `410 SCAN_EXPIRED`，须重新上传。

本人 `ScanProgress.results` 首次返回最多 20 个候选；满 20 条时可通过 `/scans/:id/candidates` 继续加载，返回 `{results,nextOffset,totalMatches,imageVersion,selectedIdentifierId}`。`offset` 默认为 0，必须为 0–100000 的整数；后续请求使用 `nextOffset`，为 `null` 时结束。结果按匹配依据强弱、更新时间、公开编号稳定排序。每次分页都必须发送页面显示的图片版本和所选号码 ID；未选时省略 ID。服务器在数据库行锁内再次校验二者，改选或重拍后的旧请求返回 `409`，GET 不会反向改选。前端变更版本/选择时清空旧分页结果，按公开编号去重，防止期间新增记录导致重复展示。联系人跟进由管理员通过微信执行，API 不自动发送微信消息。

## HTTP 错误处理

| HTTP | 常见 code | 客户端处理 |
|---|---|---|
| `400/422` | `INVALID_REQUEST`,`INVALID_IMAGE`,`NEEDS_PHOTO` | 显示具体问题并修改照片/本人表单；部分状态拒绝来自数据库校验，返回 422 |
| `401/403` | `FORBIDDEN` | 不泄露私密资料；检查本人凭证或管理员登录。缺授权头/格式错误通常 401，凭证不匹配/管理员不在名单为 403 |
| `404` | `NOT_FOUND` | 记录、操作或安全图片不存在；不要显示假空记录 |
| `409` | `VERSION_CONFLICT`,`IDEMPOTENCY_CONFLICT`,`UPLOAD_INCOMPLETE` | 拉取最新版本；上传未完成时保留原图并完成上传 |
| `410` | `SCAN_EXPIRED` | 本次临时查询过期，重新上传 |
| `413/415` | `INVALID_REQUEST` | 请求过大或不是 JSON |
| `429` | `RATE_LIMITED` | 暂停连点，稍后重试；不绕过限额 |
| `503` | `SERVICE_UNAVAILABLE` | 配置未完成、入口暂停或依赖暂不可用；保留草稿，依据 `retryable` 重试 |
| `500` | `INTERNAL_ERROR` | 保留草稿与请求编号，显示通用错误；不展示服务器异常/SQL 内容 |

个别客户端前置校验错误（例如图片槽位不完整）也可能是 `400 UPLOAD_INCOMPLETE`；按 code 与 `retryable` 联合处理，不仅依靠 HTTP。识别预算暂停/失败多数通过 `ScanProgress.state=deferred/failed` 与 `errorCode` 表达，不能因状态查询返回 HTTP 200 就显示识别成功。

除 health 外，每个业务一级路由按来源指纹进行一分钟限流：GET 120 次、写请求 20 次。缺省错误日志只记录请求编号及错误码；不记录凭证、照片、联系方式、完整号码或 OCR。

## 线上拒绝访问验收记录

2026-10-05 对隔离的新 Supabase 生产项目 API/worker v2 做只读及无效输入测试，未上传图片、未创建扫描/正式登记、未触发 OCR：

| 检查 | 实际结果 |
|---|---|
| health、stats、community | HTTP 200；`ok=true`、`ready=false`，提交关闭；统计为 0、0、null |
| 匿名直读 scans / records、调用 service-only public_stats RPC | HTTP 401，Postgres `42501` 拒绝权限 |
| 匿名查询私有 bucket | HTTP 400 `NoSuchBucket`；匿名列对象 HTTP 200 空数组，不泄露内容 |
| 私有存储配置证明 | 两个应用 bucket 均 `public=false`，storage.objects 无公开策略 |
| 错误 worker 内部密钥 | HTTP 401 |
| 缺管理员授权 / 伪造 token | HTTP 401 / 403 `FORBIDDEN` |
| 客户端手填 trackingNumber | HTTP 400 `INVALID_REQUEST` |
| 暂停期间创建误收扫描 | HTTP 503 `SERVICE_UNAVAILABLE` |
| 数据未受测试写入 | scans=0、records=0、jobs=0 |

此记录只证明上述接口与拒绝边界，不替代真实上传、真实 OCR、手机/微信浏览器或管理员交还验收。发布前 health 的 `sha` 必须更新为实际运行代码 SHA，并在发布记录中确认版本身份。
