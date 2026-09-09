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

# 第二部分:Plenti 自定义字段 🟡 —— 大部分已解锁

**2026-09-08 更新**:Jack 已确定全部字段名与长度(DECISIONS **D-013**),
Q2 / Q6 标为「已定,待沙箱建字段验证」。原来标 🔴 的两节现在可以做了,
**只剩一处仍需样本**(第 7 节的字段长度与大小写敏感)。

⚠️ **这四个字段今天的链路实测用不到** —— 当前解析骨架恒返回低置信度,
不会创建 Lead。先做实测立基线还是先建字段,顺序随你。

---

## 6. 🟢 `Plenti_Received_At__c`(Q2 已定)

### 做之前仍必须做的一步 ⚠️

字段名定了,但**规格 §5.3 要求的"检查 org 中是否已有可复用字段"照做,
不能跳过**。README_CN 也写了"优先复用已有字段并修改映射",不要为了跑通就新建。

Object Manager → Lead → Fields 里搜 `Received`、`Referral`、`Plenti`、`Source_Date`,
看有没有语义相近的现成字段。**有的话先告诉 Jack,不要直接新建。**

**操作**
Setup → Object Manager → Lead → Fields & Relationships → New:

| 项 | 值 |
|---|---|
| Data Type | **Date/Time**(不是 Date —— SLA 要精确到时刻) |
| Field Label | `Plenti Received At` |
| Field Name | `Plenti_Received_At` → API 名 `Plenti_Received_At__c` |
| Required | 否 |
| Default | **留空**(有默认值会掩盖"没取到时间"这个错误) |
| Description | `Plenti 转介邮件的实际接收时间(message.getDate())。PLT001 SLA 按此字段计算,不用 CreatedDate。` |

FLS:对第 2.5 节那个 Permission Set **可见且可编辑**。
Page Layout:加到审核人能看到的 Lead 布局。

**改了什么**
Lead 多一个 Date/Time 字段,承载 PLT001 SLA 的计时起点。

**为什么不能用 `CreatedDate`**(规格 §5.3):Apps Script 是定时轮询(10–15 分钟),
Lead 创建时间必然晚于邮件实际接收时间;"有 error 未清理则 watermark 不前移"
的逻辑还可能把延迟放大。SLA 未达标 Plenti 可**立即终止合同,没有补救期**,
这个差值不能靠估。

**怎么验证**
1. describe 里出现该字段,`"createable":true`、`"type":"datetime"`
2. 建一条测试 Lead 带上该字段,查回来确认值**没有被时区偏移改掉**

⚠️ **时区**:`appsscript.json` 已设 `Australia/Adelaide`,但写入 Salesforce 的是
UTC ISO 字符串。显示时区由查看者的个人设置决定 —— 显示成本地时间是正常的,
**只要代表同一时刻**。

⚠️ 顺带:org 的 **Business Hours 目前是 Los Angeles 时区 + 24/7**(规格 §4),
必须改成 Adelaide 时区、正确营业时间并加入南澳公共假期。**那是本项目之外的任务,
但在它修好之前任何"工作日"计算都是错的。** 本项目只负责准确记录时间戳。

**生产环境的差异**
操作相同,但:
- ⚠️ 生产要**再检查一次有没有可复用字段** —— 沙箱刷新后生产可能新加了字段
- FLS 配给生产那个专用集成用户的 Permission Set
- Page Layout 在生产通常更多,确认加到了正确的那几个

---

## 7. 🟡 `Plenti_Lead_ID__c`(Q6 已定,长度与大小写仍需样本)

这是规格 §5.4 第三层去重的载体,也是 D-013 任务 B 的 upsert 目标。

**操作**

| 项 | 值 | 说明 |
|---|---|---|
| Data Type | **Text** | |
| Field Label | `Plenti Lead ID` | |
| Field Name | `Plenti_Lead_ID` → `Plenti_Lead_ID__c` | |
| Length | **255** | ⚠️ 见下方说明 |
| **Unique** | ✅ **勾** | |
| **External ID** | ✅ **勾** | |
| Case Sensitive | ⬜ **不勾**(默认) | ⚠️ 见下方说明 |
| Required | 否 | 非 Plenti 来源的 Lead 不会有这个值 |

FLS + Page Layout:同第 6 节。

**⚠️ 关于 Length = 255 —— 2026-09-09 更新**

ID 格式**已确定**:Plenti 用 Customer.io 发信,browser view 链接末段那串
base64 就是 delivery token,形如 `dgSEywoBABYVAaCDQ6WGk5mjxvpUM8VINQ==`
(36 字符,含 `=` 补位)。每封邮件唯一。

Text 上限就是 255,取满仍是最优:真实 token 远短于此,而**加长容易、缩短难**。

⚠️ **这个字段现在是主键路径上的必需品,不再是可选项。** `plFindReferral_`
按它做 SOQL 查询做业务级去重。**字段不存在 → `INVALID_FIELD` → error 状态
→ 触发 L-01(防重锁不回滚,要人工删 Script Property 才能恢复)。**
启用前必须先建好。

**⚠️ 关于 Case Sensitive —— 现在建议**勾上**

原先建议不勾(fail-closed 偏向去重)。**token 是 base64,大小写有意义**:
`dgSE...` 和 `DGSE...` 是不同的 token。不勾会让两个不同 delivery 被误判成
同一个,直接导致漏建 Lead。

原先"不勾"的推理基于"referral ID 大小写差异不太可能有意义" —— base64 推翻了
这个前提。

⚠️ **在已有数据的字段上改 Unique / Case Sensitive 是受限操作**,
所以这一条要在正式收数据之前定掉。

(以下为原先的分析,保留备查)
Unique 文本字段默认大小写**不敏感**,即 `ABC123` 和 `abc123` 视为同一个。

这是**更安全的失败方向**:它偏向"认为是同一个转介"→ 拒绝重复创建;
勾上则偏向"认为是两个不同转介"→ 可能建出重复 Lead。在没有样本的情况下,
偏向去重是对的(fail-closed)。

样本到手后若发现 Plenti 的 ID 确实区分大小写,再评估是否要改 —— ⚠️ 但**在已有
数据的字段上改 Unique / Case Sensitive 设置是受限操作**,所以这一条要在
2026-09-09 之后、正式收数据之前确认掉。

**改了什么**
Lead 多一个承载 Plenti 业务主键的字段。勾了 Unique 之后同时获得一条**数据库层
的去重约束**。

这比"先查询再创建"强:查询和创建之间存在竞态窗口,而我们**无法跨 info / eDocs
两个项目做原子去重**(规格 §5.5 的已知限制)。External ID 则让 **upsert by
External ID** 成为可能 —— 那是解决"API 超时结果不确定"(§7 验收表)最干净的
办法,天然幂等,不需要先查再建。

**怎么验证**
1. describe 确认字段存在、`"externalId":true`、`"unique":true`
2. ⚠️ **专门验证 Unique 约束真的生效**:用虚构数据建两条带同一个 ID 的 Lead,
   第二条**必须失败**并返回 `DUPLICATE_VALUE`。两条都记得删掉。
3. ⚠️ **验证 upsert 的响应体形态**(D-013 里标为存疑的那一点)。分两次:

   ```bash
   curl -s -i -X PATCH "<instance_url>/services/data/v67.0/sobjects/Lead/Plenti_Lead_ID__c/FIXTURE-UPSERT-1" -H "Authorization: Bearer <access_token>" -H "Content-Type: application/json" -d '{"LastName":"Fixture Example","Company":"Individual / Residential","Status":"New","LeadSource":"Plenti","OwnerId":"<005 开头的 ID>"}'
   ```

   第一次应返回 **201** 带 `{"id":"...","created":true}`。
   **把完全相同的命令再跑一次**,记下第二次的**状态码和响应体** —— 是 204 空体
   还是 200 带体。这个结果直接决定 D-013 里那个"回落查询"要不要保留。
   把结果告诉我。

   验证完删掉那条 Lead。

**生产环境的差异**
⚠️ **生产上勾 Unique 之前,必须先确认现有 Lead 在这个字段上没有冲突值。**
若生产已有历史数据重复,加 Unique 会失败或需要先清洗。沙箱数据量小,
不一定能暴露这个问题。

---

## 8. 🟢 三个长文本字段(D-013 / D-019)

这三个字段把**审计留底**和**解析结果**从 Description 里搬出来,
让邮件与页面格式变化只影响解析、不影响存储。

⚠️ **`Plenti_Browser_View_HTML__c` 是 2026-09-09 新增的**(D-019)——
客户数据不在邮件正文里,在 browser view 页面上,那一份也要留底。
它与邮件原文**分开存**,不合并:两份 HTML 各约 40K+,合并可能撑破上限,
而被截断掉的正是审计原件。

**操作** —— 建三个 Long Text Area 字段:

| 项 | `Plenti_Raw_Email__c` | `Plenti_Browser_View_HTML__c` | `Plenti_Parsed_JSON__c` |
|---|---|---|---|
| Data Type | Long Text Area | Long Text Area | Long Text Area |
| Field Label | `Plenti Raw Email` | `Plenti Browser View HTML` | `Plenti Parsed JSON` |
| **Length** | **131072** | **131072** | **32768** |
| Visible Lines | 10 左右 | 10 左右 | 10 左右 |
| Description | `Plenti 转介邮件的原始 HTML(message.getBody()),审计留底。超长截断并标注 [TRUNCATED]。` | `View in Browser 页面的原始 HTML,客户数据的真实来源。空 = 抓取失败,人工可点邮件里的链接查看。` | `解析结果 JSON,含 browserView 抓取元数据与时间戳。解析不到任何字段时为 {}。` |

**改了什么**
Lead 多两个长文本字段。`Plenti_Raw_Email__c` 存的是**原始 HTML**,
不是转换后的文本(DECISIONS **D-014**)。

**为什么留底存 HTML 而不是纯文本**(Jack 的理由):Gmail 的 HTML→文本转换是
有损的,尤其表格布局的邮件,label 和 value 可能被拆到不相邻的位置。留底若存
转换后的文本,等于把审计原件变成了一个我们不控制的派生物 —— 将来发现解析漏了
字段,原文已经没了。

⚠️ **FLS 要单独想一下,不能照抄前面几个字段。**
`Plenti_Raw_Email__c` 与 `Plenti_Browser_View_HTML__c` 里是**完整原件**,
后者必定含客户姓名与安装地址(规格 §5.6 / **Q5**)。建议:

- 对第 2.5 节那个集成用的 Permission Set:**可见 + 可编辑**(脚本要写)
- 对普通销售用户:**建议不可见**,除非 Jack 明确要开
- Page Layout:⚠️ **建议先不要**加到通用 Lead 布局上;需要看的人通过字段级
  权限单独开

这条比其他字段更需要你拍板,因为它决定谁能看到客户的完整申请资料。

**怎么验证**
1. describe 确认两个字段存在、`"length"` 分别是 131072 和 32768
2. 用虚构数据写一段超过 131072 的文本进 `Plenti_Raw_Email__c`,确认 Salesforce
   按预期拒绝(证明上限是真的)—— 之后代码会在客户端先截断,不依赖服务端行为
3. 用一个非管理员测试用户登录,确认 `Plenti_Raw_Email__c` 的可见性符合你的决定

**生产环境的差异**
⚠️ **FLS 在生产更要收紧。** 生产的 Lead 布局和 Profile 更多,
逐个确认哪些角色能看到 `Plenti_Raw_Email__c`。
这一项和 **Q5**(数据留存范围)绑在一起 —— Q5 没拍板之前,
生产上建议只给集成用户和你自己可见。

---

## 9. 🟢 运行日志 Google Sheet ⚠️ 含 PII

**操作**

1. 新建一个 Google Sheet(或用现有的)
2. 从地址栏取 ID:`https://docs.google.com/spreadsheets/d/<这一段就是 ID>/edit`
3. 填进 Script Property `INTAKE_LOG_SHEET_ID`

⚠️ **Sheet ID 不写进本仓库**,只放 Script Properties。本文件一律用
`<SHEET_ID>` 占位。

**改了什么**

脚本会往这个 Sheet 写两个标签页:

| 标签页 | 内容 | 谁建 |
|---|---|---|
| 第一页(默认那个) | 每轮执行一行汇总(D-016) | 用现成的第一页,不新建 |
| `Messages` | **每封邮件一行,含完整邮件正文**(D-018) | 脚本首次运行时自动建,插在最后 |

⚠️ **不要手工调整标签页顺序,也不要把 `Messages` 拖到第一位。**
汇总日志写的是 `getSheets()[0]`,顺序变了会静默写错页。

### ⚠️ 分享设置 —— 这一步不能跳

**`Messages` 页会包含真实客户的姓名、邮箱、电话、安装地址和邮件原文。**

- ❌ **绝不可设为「知道链接的人可查看」**(anyone with the link)
- ❌ 不可设为对整个 Workspace 域可见
- ✅ 分享设置必须限制为**逐个指定的人员**
- ✅ 生产环境更要收紧,并与 **Q5**(数据留存范围)一并评估保留期

**怎么验证**

1. 跑一次 `runIntakeV2`(需要两道安全开关都打开),确认两个标签页都出现
2. 打开 Sheet 的分享设置,确认「常规访问权限」**不是**"知道链接的任何人"
3. 用一个不在分享名单里的账号打开链接,**应该被拒绝**

**生产环境的差异**

⚠️ 生产建议**另建一个 Sheet**,不要和沙箱共用 —— 沙箱那张表在测试期间可能
分享给更多人看过。生产那张表的分享名单要单独审一遍。

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
| upsert 第二次 PATCH 的**状态码与响应体** | 第 7 节 | ⚠️ 决定 D-013 的回落查询要不要保留 |
| 运行日志 Sheet ID | 第 9 节 | `INTAKE_LOG_SHEET_ID`。⚠️ 含 PII,不入仓库 |
| 第 6 节可复用字段检查的结果 | 第 6 节 | 规格 §5.3 要求 |

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
