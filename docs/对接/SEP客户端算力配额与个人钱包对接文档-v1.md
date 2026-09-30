# SEP 客户端算力配额与个人钱包对接文档

- **版本**：v1.0
- **更新日期**：2026-09-23
- **适用对象**：SEP 桌面客户端开发者
- **功能范围**：成员查看企业算力额度与个人钱包、查看消费记录、个人充值；企业管理员查看和管理成员算力额度。

---

## 1. 接口结论

当前算力额度与个人钱包接口已经提供，无需客户端另行实现一套 Token 配额逻辑。客户端应使用以下接口族：

- 企业人民币口径算力：`/api/compute-credit/*`
- 成员个人钱包：`/api/personal-wallet/*`
- 客户端专用登录与令牌：`/api/client/auth/*`
- 客户端模型调用：`/api/gateway/v1/chat/completions`

**不要将旧的 `/api/compute-quota/*` 用作当前余额或额度接口。** 该路由属于迁移期遗留的 Token 配额查询，只用于历史对账，不代表可用余额。

### 生产环境地址（客户端开发使用）

```text
普通 API 根地址：https://longdaoSEP.cn/api
模型网关根地址：https://longdaoSEP.cn/api/gateway/v1
```

本文以下 API 路径均相对于普通 API 根地址。例如：

```text
GET https://longdaoSEP.cn/api/compute-credit/my-allowance
```

普通业务 API 的 `SEP_BASE_URL` 配置为 `https://longdaoSEP.cn/api`，不要在调用路径里再次添加 `/api`。模型网关使用 `https://longdaoSEP.cn/api/gateway/v1`。

> 这是部署在服务器上的生产环境地址，不是本地开发地址，也不是 `https://sep-dev.longdaoSEP.cn/api` 共享联调环境。客户端开发和验收请按项目约定使用生产环境；涉及真实账号、企业额度和个人充值时，请谨慎操作。仅在本机启动服务做本地开发时才使用 `http://localhost:3001/api`，不要把 localhost 写入交付给客户端的生产配置。

---

## 2. 鉴权和令牌

除明确标注免鉴权的登录/刷新接口外，请求均携带：

```http
Authorization: Bearer <accessToken>
Content-Type: application/json
```

### 2.1 桌面客户端认证流程

1. 调用 `POST /client/auth/login`，获得 `accessToken` 和 `refreshToken`。
2. 使用 `accessToken` 调用本文档中的额度、钱包、用量接口及客户端订阅接口。
3. `accessToken` 过期后，调用 `POST /client/auth/refresh` 刷新普通访问令牌。
4. 选择订阅调用 `POST /client/auth/token`，使用返回的 `employmentToken` 调用模型 Gateway。

| 令牌 | 用途 | 不可替代的令牌 |
|---|---|---|
| `accessToken` | `/compute-credit/*`、`/personal-wallet/*`、`/client/subscriptions` 等普通业务 API | 不能用 `employmentToken` 替代 |
| `refreshToken` | 刷新普通 `accessToken`，或换取指定订阅的 `employmentToken` | 不是普通 API 的 Bearer token |
| `employmentToken` | `/gateway/v1/chat/completions` 模型网关 | 不能用来查询额度、钱包或管理成员额度 |

客户端应按桌面应用的安全存储方案保护令牌；不要把 `refreshToken` 当成短期访问令牌使用。客户端登录凭据字段以当前服务端 DTO 为准：`email`、`password`、`fingerprint`、`platform`（`darwin` / `win32` / `linux`）以及可选 `clientVersion`。

---

## 3. 成员端接口

成员接口基于当前登录身份确定数据范围；不需要、也不应传入 `userId` 来指定查看对象。

### 3.1 我的企业算力额度

```http
GET /compute-credit/my-allowance
```

返回当前成员在当前企业的企业承担额度视图。典型响应：

```json
{
  "userId": "usr_xxx",
  "name": "张三",
  "email": "zhangsan@example.com",
  "departmentName": "研发部",
  "limitCNY": "300.00",
  "period": "MONTH",
  "periodLabel": "每月",
  "carryOver": true,
  "enabled": true,
  "carriedInCNY": "0.00",
  "usedCNY": "35.4200",
  "remainingCNY": "264.5800",
  "topUpRemainingCNY": "50.00",
  "totalRemainingCNY": "264.5800",
  "usedPct": 12,
  "periodStart": "2026-09-01T00:00:00.000Z",
  "resetAt": "2026-10-01T00:00:00.000Z",
  "dailyLimitCNY": null,
  "dailyUsedCNY": "0.0000",
  "dailyRemainingCNY": null,
  "monthlyLimitCNY": "300.00",
  "monthlyUsedCNY": "35.4200",
  "monthlyRemainingCNY": "264.5800",
  "dailyBypassUntil": null,
  "dailyBypassActive": false,
  "topUpAmountCNY": "50.00",
  "topUpConsumedCNY": "0.00"
}
```

响应字段会随额度配置而变化；可选的每日/月度字段可能不存在或为 `null`。主要字段：

| 字段 | 类型 | 说明 |
|---|---|---|
| `limitCNY` | `string \| null` | 当前周期额度上限；`null` 表示不限额 |
| `period` / `periodLabel` | `string` | 周期枚举 / 展示名称 |
| `carryOver` | `boolean` | 是否结转未用额度 |
| `carriedInCNY` | `string` | 从上一周期结转的金额 |
| `usedCNY` | `string` | 本周期企业承担消费，不包括个人钱包自费部分 |
| `remainingCNY` | `string \| null` | 常规额度剩余；`null` 表示不限额 |
| `topUpRemainingCNY` | `string` | 管理员额外发放的企业算力余额，跨周期保留 |
| `totalRemainingCNY` | `string \| null` | 常规周期额度剩余（包含结转，不包含追加余额）；`null` 表示不限额 |
| `usedPct` | `number \| null` | 已用百分比；不限额时为 `null` |
| `periodStart` / `resetAt` | ISO 时间字符串 | 当前周期起始 / 重置时间 |
| `dailyLimitCNY` / `monthlyLimitCNY` | `string \| null` | 每日 / 每月上限（若已配置） |
| `dailyRemainingCNY` / `monthlyRemainingCNY` | `string \| null` | 每日 / 每月剩余；`null` 可表示该维度未设限 |

> `totalRemainingCNY` 只表示常规周期额度剩余，不包含 `topUpRemainingCNY`；追加余额跨周期保留，但仍受成员当日/当月（或配置周期）企业承担上限约束，不能用于绕过额度上限。企业资金余额、成员周期额度和个人钱包是不同概念；实际能否继续对话由扣费闸门判定。

### 3.2 我的个人钱包

```http
GET /personal-wallet
```

```json
{
  "balanceCNY": "20.00",
  "totalDepositCNY": "50.00",
  "totalConsumeCNY": "30.0000"
}
```

| 字段 | 类型 | 说明 |
|---|---|---|
| `balanceCNY` | `string` | 当前个人钱包余额 |
| `totalDepositCNY` | `string` | 累计个人充值金额 |
| `totalConsumeCNY` | `string` | 累计个人消费金额 |

成员端额度页面建议同时请求 `my-allowance` 与 `personal-wallet`：前者展示公司本周期愿意承担的额度，后者展示成员自己的钱。

### 3.3 个人钱包流水

```http
GET /personal-wallet/transactions?page=1&pageSize=20
```

目前实际生效的查询参数只有分页：`page` 最小为 1；`pageSize` 范围 1–100，默认 20。虽然服务端 DTO 还接受 `type`、`startDate`、`endDate`，当前接口实现没有将它们用于筛选，客户端不要依赖这些过滤参数。

响应结构：

```json
{
  "total": 1,
  "page": 1,
  "pageSize": 20,
  "totalPages": 1,
  "records": [
    {
      "id": "txn_xxx",
      "type": "CONSUME",
      "amountCNY": "-0.3500",
      "balanceAfterCNY": "19.6500",
      "description": "对话消费",
      "relatedType": "compute",
      "relatedId": "usage_xxx",
      "createdAt": "2026-09-23T08:00:00.000Z"
    }
  ]
}
```

`amountCNY` 正数表示入账，负数表示出账；金额可能保留到 4 位小数，不应在解析或展示前截断成整数分。

### 3.4 算力用量账单

```http
GET /compute-credit/usage-records?page=1&pageSize=20&startDate=2026-09-01&endDate=2026-09-23
```

可选查询参数：`page`、`pageSize`、`employeeId`、`memberId`、`startDate`、`endDate`。成员身份下，服务端强制限定为本人记录，即使请求中带了其他 `memberId` 也不会扩大数据范围。

响应为分页对象：`total`、`page`、`pageSize`、`totalPages`、`records`。账单包含模型/员工、Token 用量及人民币成本和各扣费来源，例如 `costCNY`、`creditPaidCNY`、`memberWalletPaidCNY`、`walletPaidCNY`、`personalPaidCNY`、`unpaidCNY`。金额字段为元的字符串。

### 3.5 用量分析

```http
GET /compute-credit/usage-breakdown?days=7
```

`days` 支持 `7`、`30`、`90`；不传时使用默认区间。返回汇总、趋势、按模型/员工等维度的统计。成员视角只聚合本人数据；管理维度由服务端按角色返回。

---

## 4. 个人充值接口

个人充值通过真实支付渠道创建订单，**创建订单本身不会增加钱包余额**。仅在支付通知成功或对账确认已支付后入账。

### 4.1 创建充值订单

```http
POST /personal-wallet/recharge
Content-Type: application/json

{
  "amountCNY": 20.00,
  "returnUrl": "https://client.example.com/recharge/result"
}
```

- `amountCNY` 必填，人民币元，必须为正数且最多两位小数，最大 100,000。
- `returnUrl` 可选，必须为合法 URL；不传时使用服务端默认结果页。

成功响应（HTTP 201）：

```json
{
  "orderId": "order_xxx",
  "orderNo": "PRC20260923080000123456",
  "amountCNY": "20.00",
  "payUrl": "https://alipay.example.com/pay?order=..."
}
```

客户端按支付渠道要求打开 `payUrl` 完成支付。不要根据下单成功就显示余额已到账。

### 4.2 查询充值订单与主动对账

```http
GET  /personal-wallet/recharge/{orderNo}
POST /personal-wallet/recharge/{orderNo}/reconcile
```

订单查询返回 `orderNo`、`amountCNY`、`status`、`payChannel`、`paidAt`、`createdAt`。`status` 当前为 `PENDING`、`PAID` 或 `CLOSED`。支付结果页可在用户返回后查询订单，并在适当时机调用 reconcile；对账接口会向支付渠道核实，已履约订单具有幂等性。确认 `PAID` 后再刷新钱包和额度信息。

---

## 5. 企业管理员接口

以下接口要求当前用户是企业管理员；成员调用会被拒绝。客户端可以复用现有管理员界面，也可按需提供管理功能。

### 5.1 企业算力概览

```http
GET /compute-credit/overview
GET /compute-credit/subscription-credits
```

前者返回企业钱包、赠送余额及消费汇总；后者返回订阅赠送算力列表。这里是企业范围财务信息，不应在成员界面展示。

### 5.2 查询成员额度

```http
GET /compute-credit/allowances
```

返回企业成员额度数组，项目结构与 `my-allowance` 类似，并带成员 `userId`、姓名、邮箱和部门。

### 5.3 设置成员额度

```http
PUT /compute-credit/allowances/{userId}
Content-Type: application/json

{
  "dailyLimitCNY": 20,
  "monthlyLimitCNY": 300,
  "carryOver": true,
  "note": "研发成员日/月额度"
}
```

DTO 支持 `limitCNY`、`dailyLimitCNY`、`monthlyLimitCNY`、`dailyBypassUntil`、`period`、`carryOver`、`note`。金额为人民币元，必须为正数且最多两位小数。

- 单一周期模式使用 `limitCNY` + `period`；`limitCNY: null` 清除单一周期额度。`period` 可选 `DAY`、`WEEK`、`MONTH`、`QUARTER`、`YEAR`。若成员当前已有日/月双限额，单独发送 `limitCNY` 不会清除旧的日/月字段；切换模式需先清除双限额（两个字段都传 `null`，该操作会删除当前额度配置），再单独设置单一周期额度。
- 日/月双限额模式只使用 `dailyLimitCNY` 与 `monthlyLimitCNY`。只要请求中出现其中任意一个字段，服务端就按这对字段更新双限额配置；未传的另一个字段会按 `null` 处理。因此编辑时请总是发送完整目标状态，例如只保留月限额时传 `{ "dailyLimitCNY": null, "monthlyLimitCNY": 300 }`；清除双限额时传 `{ "dailyLimitCNY": null, "monthlyLimitCNY": null }`。
- 不要在同一请求混用 `limitCNY` 与日/月字段；不要用只传一个 `null` 的方式假设“仅清除某一项并保留另一项”。

### 5.4 给成员追加企业算力余额

```http
POST /compute-credit/allowances/{userId}/top-up
Content-Type: application/json

{
  "amountCNY": 100,
  "note": "项目临时追加"
}
```

追加会从企业钱包扣款并记入该成员企业算力余额；该余额跨额度周期保留，但消费仍受成员的当日/当月及配置周期企业承担上限约束。`topUpRemainingCNY` 是追加余额，不会加进 `totalRemainingCNY`；额度耗尽后追加余额不能绕过额度闸门。

### 5.5 查询管理留痕

```http
GET /compute-credit/allowance-top-ups
GET /compute-credit/allowance-top-ups?userId={userId}
GET /compute-credit/allowance-changes
GET /compute-credit/allowance-changes?userId={userId}
```

两类记录均返回最近最多 50 条。`userId` 可选，用于筛选单个成员。

管理员还可调用成员端的用量账单和用量分析接口；管理员视角按企业返回，成员视角由服务端收窄为本人数据。

---

## 6. 对话扣费与错误处理

### 6.1 扣费概念

正常扣费顺序为：订阅赠送额度 → 成员企业成员专属追加余额（如有；普通成员不会自动动用企业公共钱包）→ 成员个人钱包 → 欠费。企业资金可承担金额受成员额度上限约束；追加余额不能绕过成员额度上限。成员额度并不等同于个人钱包余额。

- 企业额度仍可用时，按企业资金策略扣费。
- 企业资金受额度限制或不可用、但个人钱包可用时，对话可能继续，费用由个人承担。
- 企业资金和个人钱包都无法承担时，对话被阻止。
- 个人自费金额不计入 `my-allowance.usedCNY`，可在个人钱包流水或算力用量账单中查看。个人钱包流水 `type` 当前可能为 `DEPOSIT`、`CONSUME`、`REFUND`、`ADJUSTMENT`；充值流水类型是 `DEPOSIT`（不是 `RECHARGE`）。

### 6.2 Web SSE 与桌面 Gateway 的协议区别（重要）

Web 对话 `POST /conversations/{conversationId}/messages` 在额度闸门处可发送结构化 SSE 事件：

```text
event: error
data: {"message":"...","code":"COMPUTE_BLOCKED","blockedBy":"ALLOWANCE","personalBalanceCNY":"0.00"}
```

个人余额可继续支付时，Web 会发送 `notice` 事件 `COMPUTE_SELF_PAID`，这不是错误，客户端不得因此中断对话。

**桌面客户端目前通过 `/gateway/v1/chat/completions` 调用模型，使用 `employmentToken`。Gateway 在转发上游请求前检查是否仍有企业资金或个人余额可承担；两者都不可用时返回 HTTP 403，而不是上述 Web SSE `COMPUTE_BLOCKED` 事件。若企业额度不可用但个人余额足够，Gateway 可继续请求并在后续记账时由个人钱包承担，但当前 Gateway 不发送 `COMPUTE_SELF_PAID` notice。** 因此桌面客户端：

1. 不要假设 Gateway 会返回 `COMPUTE_SELF_PAID` notice。
2. 对 HTTP 403 按 Gateway 当前错误响应处理，不要从 Web SSE 协议推断结构化字段一定存在。
3. 若产品要求桌面端与 Web 完全一致地展示 `COMPUTE_SELF_PAID` 提示、并对阻止原因提供结构化 `COMPUTE_BLOCKED` 字段，需要后端另行对齐 Gateway 的事件/错误契约；客户端可先通过额度查询接口展示额度与个人余额，但不能将查询结果当作实时扣费保证。

---

## 7. 金额、空值和兼容性约定

- 所有 `*CNY` 金额均为人民币“元”，多数后端 Decimal 响应为字符串，例如 `"35.4200"`；输入金额 DTO 使用 JSON number。
- 展示时可格式化为两位小数；用量和流水明细应保留后端精度，不要先四舍五入再做合计。
- `limitCNY: null` 表示未设限/不限额；剩余额度字段为 `null` 时不要当成 0，应按对应接口语义显示“不限额”或“未设此项限制”。
- `usedCNY` 是企业资金承担口径，不包含成员个人自费。
- 查询权限由后端根据登录用户角色和企业归属执行；前端隐藏管理按钮不构成权限控制。
- 旧 `/compute-quota/*` 响应中的 Token 数值属于遗留数据，不得与人民币余额相加或展示为可消费配额。

---

## 8. 推荐客户端页面请求组合

### 成员「我的算力」页

并发调用：

```text
GET /compute-credit/my-allowance
GET /personal-wallet
```

展开流水时调用：

```text
GET /personal-wallet/transactions?page=1&pageSize=20
```

展示用量账单时调用：

```text
GET /compute-credit/usage-records?page=1&pageSize=20
```

充值完成确认后重新请求额度与钱包；必要时刷新个人钱包流水。

### 管理员「企业算力/成员额度」页

```text
GET /compute-credit/overview
GET /compute-credit/subscription-credits
GET /compute-credit/allowances
```

管理员修改或追加额度成功后，以接口响应更新目标成员行，或重新拉取 `allowances`；查看操作留痕时再请求对应记录接口。

---

## 9. 相关服务端实现位置

```text
backend/src/modules/client/client.controller.ts
backend/src/modules/compute-credit/compute-credit.controller.ts
backend/src/modules/compute-credit/compute-credit.service.ts
backend/src/modules/compute-credit/member-allowance-query.service.ts
backend/src/modules/personal-wallet/personal-wallet.controller.ts
backend/src/modules/payment/personal-recharge.controller.ts
backend/src/modules/gateway/gateway.controller.ts
backend/src/modules/gateway/gateway.service.ts
backend/src/modules/conversation/conversation-stream.service.ts
```
