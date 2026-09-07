# Salesforce 沙箱配置手册

**执行人** Jack(在沙箱中以 `jack.liu` 登录配置)
**日期** 2026-09-07 · **阶段** Phase 4 前置准备

这份手册由 Jack 手工执行,**不提供任何自动化脚本** —— 本项目的脚本不创建
Salesforce 字段、不部署 Flow、不改配置(规格 §5.3 / §5.9)。

它同时是之后照搬到生产的清单,所以每一步都写"改了什么",而不只是"点哪里"。

---

## 关于格式

Jack 要求每步四栏:**操作 / 改了什么 / 怎么验证 / 生产环境的差异**。

四项内容按纵向排列而不是表格 —— 表格单元格塞不下命令和字段清单,打印出来
也没法读。每一步都完整包含这四项。

## 关于准确性

Salesforce 的 **External Client App** 相关界面在近几个版本改过菜单位置和标签
(旧的 Connected App 路径也仍然存在)。我**按功能**描述每一步要达成什么、
并列出可能的替代路径,**不假装知道你们 org 那个版本的精确点击路径**。
若实际界面与描述不符,以"改了什么"那一栏为准 —— 那一栏描述的是目标状态,
不会随版本变化。

标注约定:

- 🟢 **现在就能做** —— 不依赖任何未决问题
- 🔴 **阻塞中** —— 等 Q2 / Q6 确认后才能做,现在做了会返工
- ⚠️ 需要判断或有坑的地方

---

## 0. 开始之前

### 0.1 这份手册不碰什么

- **不碰 info 邮箱的 Apps Script 项目**,不 clone、不 push、不读它的
  Script Properties(规格 §3 禁止 #1)
- **不碰生产 Salesforce**。涉及生产的内容本手册只写"差异说明",
  实际操作由 Jack 自己在生产执行
- 本阶段**不创建 Apps Script 项目**,也不设触发器 —— `sf-intake` 账号还没建

### 0.2 全程保持关闭的两道开关

Script Properties 里的 `INTAKE_V2_ENABLED` 和 `EDOCS_ADAPTATION_VALIDATED`
在整个沙箱配置期间**保持 `false`**(规格 §3 禁止 #3)。这份手册配的是
Salesforce 那一端,和开关无关,但不要顺手打开。

### 0.3 凭据处置

- **Consumer Secret 绝不写进仓库、不发在聊天或邮件里**(规格 §3 禁止 #7)
- 仓库 `.gitignore` 已屏蔽 `*.local.json` / `*.secret*` /
  `script-properties.json` / `.env*`,但**最安全的做法是根本不落盘**
- 沙箱凭据与生产凭据**必须各建一套,不可复用**(见 §2.6)

### 0.4 沙箱的两个基本事实

| | 沙箱 | 生产 |
|---|---|---|
| 登录用户名 | `jack.liu@<域>.<沙箱名>`(自动追加后缀) | `jack.liu@<域>` |
| My Domain | `https://<mydomain>--<沙箱名>.sandbox.my.salesforce.com` | `https://<mydomain>.my.salesforce.com` |

⚠️ **沙箱刷新会清空这份手册做的所有配置**,并重置密码。开始前确认这个沙箱
近期不会被刷新。

⚠️ **所有记录 ID 在沙箱和生产之间不同。** 用户 ID、字段 ID 都要在生产重新取一次。

---

# 第一部分:现在就能做 🟢

---

## 1. 确认 My Domain 与登录 URL

**操作**
Setup → 快速查找 `My Domain` → 记下 "Current My Domain URL"。

**改了什么**
什么都没改,只是取值。这个值将来会填进 Script Property `SF_LOGIN_URL`。

**怎么验证**
浏览器打开该 URL,能正常跳到沙箱登录页,且地址栏含 `--<沙箱名>.sandbox`。

**生产环境的差异**
生产的 URL 没有 `--<沙箱名>.sandbox` 那一段,形如
`https://<mydomain>.my.salesforce.com`。
⚠️ **client credentials 流必须用 My Domain URL,不能用 `login.salesforce.com`
或 `test.salesforce.com`。** 这是 Salesforce 的要求,不是本项目的选择。

---

## 2. External Client App(client credentials 流)

这一整节是 Phase 4 的主要阻塞项。做完才能跑通任何 Salesforce 调用。

### 2.1 允许创建 External Client App

**操作**
Setup → 快速查找 `External Client App` → `External Client App Settings` →
勾选允许创建(标签近似 "Allow creation of external client apps")。

**改了什么**
org 级开关,允许在本 org 创建新版 External Client App。不影响已有的
Connected App。

**怎么验证**
`External Client App Manager` 里出现 "New External Client App" 按钮。

**生产环境的差异**
同样要开。⚠️ 生产开这个开关**建议先问 Salesforce 管理员** —— 它是 org 级
设置,不是本项目独有。

> ⚠️ 若你们 org 的版本没有 External Client App,退回用 **Connected App**
> (Setup → App Manager → New Connected App)。client credentials 流两者都支持,
> 后面每一步的"改了什么"完全相同,只是界面位置不同。

### 2.2 新建 App 并启用 OAuth

**操作**
新建 External Client App:
- Name:`eDocs Plenti Intake (Sandbox)` —— 名字里带 Sandbox,避免和生产那套混淆
- Contact Email:你的邮箱
- 启用 OAuth
- Callback URL:`https://login.salesforce.com/services/oauth2/success`
  ⚠️ client credentials 流**不会用到**这个回调,但表单要求必填。填一个不可
  被利用的占位值即可,不要填能接收数据的地址。

**改了什么**
新建一个 OAuth 客户端。此时它还**不能**用 client credentials 换 token ——
那要 2.4 才启用。

**怎么验证**
App 出现在 External Client App Manager 列表里。

**生产环境的差异**
Name 改成不带 Sandbox 的名字。**必须是新建的一套,不是把沙箱那套改名**
(见 2.6)。

### 2.3 OAuth Scope —— 只给 `api`

**操作**
Selected OAuth Scopes 只勾:
- **Manage user data via APIs (`api`)**

**不要勾**:`full`、`web`、`refresh_token / offline_access`、`chatter_api`、
`custom_permissions`。

**改了什么**
限定这个客户端能请求的权限范围。`api` 足够做 Lead 的增删改查和文件上传;
`full` 会把范围扩到该用户能做的一切。

`refresh_token` 对 client credentials 流无意义 —— 该流程不发 refresh token,
每次直接用 client id/secret 换 access token(见 `src/Code.gs` 的
`getSalesforceClientCredentialsToken_`)。

**怎么验证**
2.7 拿到的 token 能读 `/services/data/`,且**不能**做超出 Run As 用户权限的事。

**生产环境的差异**
一样,只给 `api`。⚠️ 生产更要守住 —— README_CN 明确写了"不要为了运行本包
授予全员管理员权限"。

### 2.4 启用 Client Credentials Flow

**操作**
在 App 的 Flow Enablement(或 OAuth Policies)区域,勾选启用
**Client Credentials Flow**,并指定 **Run As 用户**。

**改了什么**
这是关键一步:它允许该客户端**不经过用户登录**直接换取 access token,
拿到的 token 以 Run As 用户的身份行事。

⚠️ **Run As 用户的权限就是这个集成的权限上限。** 见 2.5。

**怎么验证**
2.7 的 token 请求返回 200 且带 `access_token` 和 `instance_url`。
若返回 `unsupported_grant_type` 或 `invalid_client`,通常就是这一步没生效。

**生产环境的差异**
⚠️ **生产的 Run As 用户不能是 `jack.liu`。** 见 2.5 的说明。

### 2.5 Run As 用户与权限 ⚠️

**操作(沙箱)**

这里要区分两个不同的角色,别混:

| 角色 | 沙箱用谁 | 说明 |
|---|---|---|
| **配置者** | `jack.liu` | 你登录做这些设置。完全没问题 |
| **Run As 用户** | ⚠️ **建议另建一个专用用户,不要用 `jack.liu`** | 集成实际以这个身份写数据 |

**为什么建议沙箱也另建**:如果沙箱的 Run As 用户是你(系统管理员),那么
沙箱测试只能验证"连得通",**验证不了权限最小集够不够用** —— 管理员什么都能做,
测试必然通过,到生产换成受限用户时才会集中暴露问题。

若你决定沙箱先用 `jack.liu` 图快,请在 DECISIONS 里记一笔:**权限最小集在
沙箱未经验证**,生产上线前必须补测。

**给 Run As 用户的权限(用一个专用 Permission Set,不要直接改 Profile)**

需要:
- **API Enabled**(系统权限)—— 没有它任何 API 调用都会被拒
- **Lead**:Read / Create / Edit
- **Lead 字段级安全(FLS)**:对下列字段可见且可编辑
  - `LastName` / `FirstName` / `Email` / `Phone` / `Company` / `Status` /
    `LeadSource` / `Description` / `OwnerId`
  - `Street` / `City` / `StateCode` / `PostalCode` / `CountryCode`
  - `Contact_Attempt_Count__c`
  - `Plenti_Received_At__c`(🔴 第 6 节建完之后回来补)
  - referral ID 字段(🔴 第 7 节建完之后回来补)

**明确不要给**(规格 §5.10 / DECISIONS D-007,本项目是 Lead-only):
- ❌ Account、Contact、Opportunity、Task 的任何权限
- ❌ "Modify All Data" / "View All Data"
- ❌ 任何管理员权限

**可选、且当前不需要**:
- `ContentVersion` Create / `ContentDocumentLink` Read —— 只有
  `ATTACH_RAW_EMAIL=true` 时才用得上。该开关默认 `false`(规格 §5.6,Q5 未决),
  **现在不要给**。等 Jack 拍板数据留存范围之后再加。

**改了什么**
创建了一个权限集并指派给 Run As 用户,把集成的能力限制在"只对 Lead 做增改查"。

**怎么验证**
用 Run As 用户的身份登录(或用 2.7 的 token)尝试读一个 Account ——
**应该失败**。能成功说明权限给多了。

**生产环境的差异**
⚠️ **生产的 Run As 用户必须是专用集成用户,绝不能是 `jack.liu`。** 三条理由:

1. token 以该用户身份行事,所有 Lead 的创建者都会是你,审计线索失去意义
2. 你的账号一旦停用、改权限或离职,集成立刻断
3. 你大概率是系统管理员 —— 那等于把管理员权限交给这个集成

生产建议用 **Salesforce Integration 许可证**的用户(多数 org 自带几个免费的),
配同一个 Permission Set。用户名要能一眼看出用途,例如
`edocs-plenti-integration@<域>`。

### 2.6 取 Consumer Key 与 Secret ⚠️

**操作**
在 App 的 Settings → "Consumer Key and Secret" → 需要二次验证后显示。

**改了什么**
什么都没改,取值。

**处置方式**:
- Consumer Key(client_id)不算机密,但也没必要到处贴
- **Consumer Secret 是机密。** 只在 2.7 验证时用一次,之后直接填进
  Apps Script 的 Script Properties(`SF_CLIENT_SECRET`)
- ❌ 不写进本仓库任何文件
- ❌ 不发聊天、不发邮件
- ❌ 不直接打进 shell 命令(会进 shell history)—— 2.7 用 `read -s` 读入

**怎么验证**
2.7。

**生产环境的差异**
⚠️ **沙箱和生产必须各建一套 App、各有一套凭据,不可复用。**
沙箱凭据泄露不应该能碰生产数据。同理,**也不要复用 info 邮箱项目的凭据**
(规格 §4 明确要求新建)。

### 2.7 验证 token 能换出来

**为什么用 curl 而不是 Apps Script**:我们的
`testSalesforceClientCredentials()` 在 Apps Script 里,而 Apps Script 项目要等
`sf-intake` 账号建好才能创建。所以这一步在你自己机器上用 curl 验证。

**也不要用 Workbench 之类的第三方站点**验证 —— 那需要把 Consumer Secret
贴进别人的网页。curl 在本机执行,secret 不出你的机器。

**操作**

先把 secret 读进环境变量(`-s` 不回显,命令本身不含 secret,不进 history):

```bash
read -rs -p "Consumer Secret: " SF_SECRET && echo
```

然后换 token(替换掉两个尖括号占位):

```bash
curl -s -X POST "https://<mydomain>--<沙箱名>.sandbox.my.salesforce.com/services/oauth2/token" -d grant_type=client_credentials -d client_id="<Consumer Key>" --data-urlencode "client_secret=$SF_SECRET"
```

用完清掉:

```bash
unset SF_SECRET
```

**改了什么**
什么都没改。这是只读验证。

**怎么验证**
返回 JSON 含 `access_token` 和 `instance_url` 即成功。

常见失败:

| 返回 | 大概率原因 |
|---|---|
| `unsupported_grant_type` | 2.4 的 Client Credentials Flow 没启用 |
| `invalid_client` / `invalid_client_id` | Consumer Key 抄错,或 App 刚建还没生效(等几分钟) |
| `invalid_grant` | Run As 用户没设,或该用户被停用 / 无 API Enabled |
| 连不上 | My Domain URL 写错(见第 1 节) |

拿到 token 后再验一次它**只能**做该做的事:

```bash
curl -s "<instance_url>/services/data/" -H "Authorization: Bearer <access_token>"
```

**生产环境的差异**
URL 换成生产 My Domain,凭据换成生产那套。
⚠️ 这一步只证明**只读 API 连得通**,不证明写权限正确,也不证明 Flow 不会
被触发 —— 那是第 5 节和 Phase 4 沙箱端到端测试的事。

---

## 3. LeadSource picklist 加 `Plenti` 值(Q3)

**操作**
Setup → Object Manager → **Lead** → Fields & Relationships → **Lead Source**
→ Values → New → 输入 `Plenti` → Save。

⚠️ **如果 Lead 启用了 Record Type**:新增的值默认不会自动分配给各 Record Type。
必须再到该字段的 Record Type 区域,把 `Plenti` 加进本项目会用到的 Record Type
的可选值里。**这一步最容易漏,漏了会在创建 Lead 时报错。**

**改了什么**
Lead 对象的 LeadSource picklist 多了一个值 `Plenti`。

代码里 `src/Plenti.gs` 的 `plLeadPayload_` 写的就是 `LeadSource:'Plenti'`
(规格 §5.9)。**值必须精确匹配,大小写敏感。**

**怎么验证**
两种都做:
1. UI:手工新建一个 Lead(用虚构数据),LeadSource 下拉里能选到 `Plenti`
2. API:用 2.7 的 token 查

```bash
curl -s "<instance_url>/services/data/v67.0/sobjects/Lead/describe" -H "Authorization: Bearer <access_token>"
```

在返回里找 `LeadSource` 的 `picklistValues`,确认有 `"value":"Plenti"` 且
`"active":true`。

**生产环境的差异**
操作相同。⚠️ 生产多两件事要想:
1. **Record Type 分配**在生产可能更复杂(生产的 Record Type 通常更多)
2. Lead 转换时 LeadSource 会映射到 Opportunity / Contact / Account 的
   LeadSource —— 那些是**独立的 picklist**,不会因为 Lead 上加了值就自动有。
   本项目是 Lead-only 不做转换,但人工转换 Plenti 线索时可能撞到,提前知道

---

## 4. 确认 `Contact_Attempt_Count__c` 已存在(不新建)

**操作**
Setup → Object Manager → Lead → Fields & Relationships → 搜
`Contact_Attempt_Count`。

**改了什么**
**什么都不改。** 这是 Lily 已经建好的字段(规格 §5.9),只需确认它存在、
类型是数字、且允许写 `0`。

⚠️ **不要新建同名字段。** 规格 §5.9 明确说这是"复用 Lily 已建字段"。

要记下来的:
- 精确 API 名(确认就是 `Contact_Attempt_Count__c`)
- 类型和小数位(代码写的是整数 `0`)
- 是否 Required、有没有 Default —— 如果它是 Required 且我们不写会报错;
  我们会写 `0`,所以没问题

**怎么验证**
在第 3 节那个 describe 返回里找 `Contact_Attempt_Count__c`,确认
`"createable":true`。

**生产环境的差异**
⚠️ **生产要确认它确实存在。** 沙箱是从生产刷新来的,理论上一致,但如果这个
沙箱刷新得早、字段是之后建的,就会不一致。生产上线前重新确认一次。

---

## 5. 确认新建 Lead 不会被自动分配或触发客户邮件 ⚠️

这一节对应规格 §5.9 的 Owner 未决风险和 PLENTI_ADAPTATION 第 12 条。
**它比前面几节更容易被忽略,但影响更大。**

**操作**

先取 `INTAKE_ADMIN_ID`(审核人的 Salesforce User ID):
Setup → Users → 点开该用户 → 浏览器地址栏里那段 `005` 开头的 ID。
代码要求 15 位或 18 位、`005` 开头(`src/Code.gs` 的 `ivAdmin_` 有正则校验)。

然后用 2.7 的 token 建一条**虚构数据**的测试 Lead:

```bash
curl -s -X POST "<instance_url>/services/data/v67.0/sobjects/Lead" -H "Authorization: Bearer <access_token>" -H "Content-Type: application/json" -d '{"LastName":"Fixture Example","Company":"Individual / Residential","Email":"fixture.example@example.net","Status":"New","LeadSource":"Plenti","OwnerId":"<005 开头的 ID>","Contact_Attempt_Count__c":0,"Description":"[Sandbox setup verification] 虚构数据,验证完请删除"}'
```

⚠️ **一律用虚构数据**(规格 §3 禁止 #5)。上面 `example.net` /
`Fixture Example` 都是编的,不要换成真实客户信息。

**改了什么**
在沙箱里创建了一条测试 Lead。**验证完请删掉。**

**怎么验证**

建完立刻查回来,逐条确认:

| 要确认的 | 为什么 |
|---|---|
| `OwnerId` **仍然是**你传的那个 ID | 若被改了,说明有 Assignment Rule 或 Flow 在抢分配。REST API 默认**不**跑分配规则(除非传 `Sforce-Auto-Assign` 头),所以被改了就是 Flow 干的 |
| `LeadSource` 是 `Plenti` | 第 3 节生效 |
| **没有邮件发出去** | 检查该 Lead 的 Activity History,以及有没有触发 Auto-Response Rule。规格 §9 明确写了本脚本不发首次回应邮件,但 Salesforce 既有 Flow 可能被创建动作触发 |
| POST 没有被 **Duplicate Rule** 拦下 | 若返回 `DUPLICATE_VALUE` 或 `DUPLICATES_DETECTED`,说明有重复规则设成了 Block。这会让真实转介创建失败 |
| POST 没有被 **Validation Rule** 拦下 | 若返回 `FIELD_CUSTOM_VALIDATION_EXCEPTION`,记下是哪条规则,可能要调整字段映射 |

⚠️ **只看某个 Flow 显示 Active 就认定安全是不够的**(PLENTI_ADAPTATION 第 12 条)
—— 要实际建一条看结果。

删除测试 Lead:

```bash
curl -s -X DELETE "<instance_url>/services/data/v67.0/sobjects/Lead/<新建的 Lead Id>" -H "Authorization: Bearer <access_token>"
```

**生产环境的差异**
⚠️ **这一节在生产的风险高得多。**

- 生产的 Assignment Rule / Auto-Response Rule / Flow 比沙箱多,而且**沙箱刷新
  之后新加的生产 Flow 不会出现在沙箱里**
- 生产建测试 Lead 会真的发邮件给真实销售、真的进真实报表
- **生产的用户 ID 与沙箱不同**,`INTAKE_ADMIN_ID` 要重新取
- 建议生产用一个明显是测试的虚构地址,并且**先确认能立刻删除**

⚠️ 还有一件不是 Salesforce 配置的事:**Plenti 线索到底由谁跟进目前仍未确定
(Q1)**。指派给审核人意味着 SLA 时钟开始跑但无人联系客户。这是业务未决项,
不是这份手册能解决的,但在生产开触发器之前必须解决。

---

# 第二部分:阻塞中 🔴 —— 等 Q2 / Q6 确认后

**这两节现在做会返工,不要提前做。**

---

## 6. 🔴 `Plenti_Received_At__c`(阻塞于 Q2)

### 做之前必须先定的

| 待定 | 谁定 | 说明 |
|---|---|---|
| **字段名是否就叫 `Plenti_Received_At__c`** | Jack | 规格 §5.3 写"字段命名需先与 Jack 确认" |
| **org 里有没有可复用的现成字段** | Jack | 规格 §5.3 要求先检查。README_CN 也写了"优先复用已有字段并修改映射",不要为了跑通就新建 |

⚠️ **先做检查再决定建不建。** 在 Object Manager → Lead → Fields 里搜
`Received`、`Referral`、`Plenti`,看有没有语义相近的现成字段。

**操作(Q2 定了之后)**
Setup → Object Manager → Lead → Fields & Relationships → New:
- Data Type:**Date/Time**(不是 Date —— SLA 要精确到时刻)
- Field Label:`Plenti Received At`
- Field Name:`Plenti_Received_At`(API 名自动成为 `Plenti_Received_At__c`)
- Required:**否**
- Default:**留空**(绝不能有默认值,否则会掩盖"没取到时间"这个错误)
- Description 填清楚:`Plenti 转介邮件的实际接收时间(message.getDate())。
  PLT001 SLA 按此字段计算,不用 CreatedDate。`
- FLS:对第 2.5 节那个 Permission Set **可见且可编辑**
- Page Layout:加到审核人能看到的 Lead 布局上

**改了什么**
Lead 多一个 Date/Time 字段,承载 PLT001 SLA 的计时起点。

**为什么不能用 `CreatedDate`**(规格 §5.3):Apps Script 是定时轮询
(10–15 分钟),Lead 创建时间必然晚于邮件实际接收时间;而且模板"有 error
未清理则 watermark 不前移"的逻辑可能把延迟放大。SLA 未达标 Plenti 可**立即
终止合同,没有补救期**,这个差值不能靠估。

**怎么验证**
1. describe 里出现该字段且 `"createable":true`、`"type":"datetime"`
2. 建一条测试 Lead 时带上这个字段,查回来确认值**没有被时区偏移改掉** ——
   代码写入的是 `message.getDate().toISOString()`(UTC),
   查回来应该是同一时刻

⚠️ **时区**:`appsscript.json` 已设 `Australia/Adelaide`,但写入 Salesforce 的
是 UTC ISO 字符串。显示时区由查看者的 Salesforce 个人设置决定 —— 显示成本地
时间是正常的,**只要它代表同一时刻**。

⚠️ 顺带记一下:org 的 **Business Hours 目前是 Los Angeles 时区 + 24/7**
(规格 §4),必须改成 Adelaide 时区、正确营业时间并加入南澳公共假期。
**那是本项目之外的配置任务,但在它修好之前任何"工作日"计算都是错的。**
本项目只负责准确记录时间戳,不负责算工作日差值。

**生产环境的差异**
操作相同,但:
- ⚠️ 生产要**再检查一次有没有可复用字段** —— 沙箱刷新之后生产可能新加了字段
- FLS 要配给生产的那个专用集成用户的 Permission Set
- Page Layout 在生产通常更多,要确认加到了正确的那几个

---

## 7. 🔴 referral ID 字段(阻塞于 Q6 + 样本)

### 做之前必须先定的

| 待定 | 阻塞于 | 说明 |
|---|---|---|
| **存 Lead 字段还是 Script Properties** | Q6 | 倾向 Lead 字段 —— Properties 有 500KB 上限且不可靠(规格 §5.4) |
| **ID 的格式与长度** | 2026-09-09 样本 | 决定字段类型和长度 |
| **同一转介重发时 ID 是否不变** | 2026-09-09 样本 | ⚠️ **这是第三层去重能否成立的前提**。若 ID 会变,整个方案要重想 |

⚠️ **在这三项定下来之前不要建字段。** 长度和唯一性一旦定错,改起来比重建麻烦。

**操作(Q6 + 样本都定了之后)**

建议配置(**待样本确认后再定稿**):
- Data Type:**Text**(长度按样本定,留余量)
- Field Label / Name:待 Jack 定,例如 `Plenti Referral ID`
- ⚠️ **Unique**:建议勾。勾了之后 Salesforce 会在**数据库层**拒绝重复 ——
  同一 referral ID 建第二条 Lead 会直接返回 `DUPLICATE_VALUE`。
  这是比"先查询再创建"更强的保证,因为查询和创建之间存在竞态窗口,
  而我们**无法跨 info / eDocs 两个项目做原子去重**(规格 §5.5 的已知限制)。
- ⚠️ **External ID**:建议勾。勾了会建索引(查询更快),而且让
  **upsert by External ID** 成为可能 —— 那是解决"API 超时结果不确定"
  (§7 验收表)最干净的办法:upsert 天然幂等,不需要先查再建。

  **这两条是给 Q6 的输入,不是我替你决定。** 若采纳 upsert 方案,
  `src/Plenti.gs` 的 `plFindReferral_` / `plCreateLead_` 要相应重写 ——
  那是 Phase 3 的事。

- Case Sensitive:⚠️ Unique 文本字段默认**大小写不敏感**。若 Plenti 的 ID
  区分大小写(样本确认),要勾上 Case Sensitive,否则 `ABC123` 和 `abc123`
  会被当成同一个。
- FLS + Page Layout:同第 6 节

**改了什么**
Lead 多一个承载 Plenti 业务主键的字段。若勾了 Unique,同时获得一条**数据库层
的去重约束** —— 这是规格 §5.4 第三层去重的最强实现形式。

**怎么验证**
1. describe 确认字段存在、类型和长度正确
2. ⚠️ **专门验证 Unique 约束真的生效**:用虚构数据建两条带同一个 referral ID
   的 Lead,第二条**必须失败**并返回 `DUPLICATE_VALUE`。
   建完记得两条都删掉。
3. 若勾了 Case Sensitive,再用大小写不同的同一个 ID 试一次,确认行为符合预期

**生产环境的差异**
⚠️ **生产上勾 Unique 之前,必须先确认现有 Lead 里没有会冲突的值。**
如果生产已经有历史数据在这个字段上重复,加 Unique 约束会失败或需要先清洗。
沙箱数据量小,不一定能暴露这个问题。

---

# 完成后要记录什么

配置完把下列值记下来,Phase 4 建 Apps Script 项目时填进 Script Properties。

## ✅ 可以记在安全的地方

| 值 | 来源 | 对应 Script Property |
|---|---|---|
| 沙箱 My Domain URL | 第 1 节 | `SF_LOGIN_URL` |
| Consumer Key | 第 2.6 节 | `SF_CLIENT_ID` |
| 审核人 User ID(`005…`) | 第 5 节 | `INTAKE_ADMIN_ID` |
| Run As 用户的用户名 | 第 2.5 节 | (不入属性,记档用) |
| `Plenti_Received_At__c` 最终 API 名 | 第 6 节 | (改代码用) |
| referral ID 字段最终 API 名 | 第 7 节 | (改代码用) |

## ❌ 绝不记进仓库

- **Consumer Secret** —— 只在 2.7 用一次,之后直接填进 Script Properties
  (`SF_CLIENT_SECRET`)。不写文件、不发聊天、不发邮件(规格 §3 禁止 #7)

## 配置完之后回填哪里

- Q2 / Q3 / Q6 的结论 → `docs/DECISIONS.md` 的开放问题表
- 第 5 节验证结果(Owner 有没有被改、有没有发邮件、有没有被规则拦)
  → `docs/DECISIONS.md`,这直接关系 Q1
- 若沙箱的 Run As 用户用了 `jack.liu` → 记一笔"权限最小集在沙箱未经验证"

---

# 这份手册**没有**覆盖的

避免误以为做完这些就可以上线:

- ❌ **Apps Script 项目本身** —— 要等 `sf-intake` 账号建好,且必须用该账号登录
  创建(GmailApp 操作的是实际执行用户的邮箱,不由 `INTAKE_MAILBOX` 决定)
- ❌ **触发器** —— 必须用 `sf-intake` 账号创建,且要等两道安全开关打开之后
- ❌ **eDocs 组的投递设置** —— Lily 已确认 moderation 那一层通了,
  但**外部发件人能否直接投递仍未确认**。这一条会直接影响 §5.1 的
  `X-Original-Sender` 和 `X-Original-Authentication-Results` 是否存在
- ❌ **Plenti 字段解析** —— 等 2026-09-09 样本(Phase 3)
- ❌ **Business Hours 修正** —— 见第 6 节的提醒,本项目之外的任务
- ❌ **Q1:谁跟进 Plenti 线索** —— 业务未决,上线前必须解决
