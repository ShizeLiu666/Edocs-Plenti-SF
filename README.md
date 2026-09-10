# eDocs Plenti Intake

读取 eDocs 群组投递到 `sf-intake@sunterra.com.au` 的邮件副本,识别其中来自
Plenti 的转介线索,在 Salesforce 建 Lead,并记录 SLA 所需的时间戳。

一个**全新的、独立的** Google Apps Script 项目。**它不是**对现有 info 邮箱
项目的修改 —— info 那个项目继续独立运行,本项目不碰它。

完整规格见 [docs/eDocs-Plenti-Intake-开发规格.md](docs/eDocs-Plenti-Intake-开发规格.md)。
决策记录与待办见 [docs/DECISIONS.md](docs/DECISIONS.md)。
Salesforce 沙箱配置手册见 [docs/SANDBOX_SETUP.md](docs/SANDBOX_SETUP.md)(Jack 手工执行,同时是照搬到生产的清单)。

---

## 当前状态:Phase 2 完成 —— 不可上线

**定位**(DECISIONS D-007):`src/Plenti.gs` 是主干,本项目只处理 Plenti
转介线索;`src/Code.gs` 是基础设施工具库;`src/Legacy.gs` 隔离 info 模型
专有逻辑,主干一次也不引用它(由离线测试的静态守卫强制检查)。

已完成:

- 仓库、目录结构、`.gitignore`、`appsscript.json`(Phase 1)
- 模板函数三分类,info 专有逻辑隔离进 `Legacy.gs`(D-008)
- 发件人可信验证 `isPlentiSource_`(规格 §5.1)
- 三样可继承的东西:排除规则、`review` 兜底、创建前防重锁(规格 §2)
- 解析骨架 `parsePlentiReferral_`,**字段正则留空**
- 收信范围收窄到 eDocs 群组(规格 §5.7)
- `.eml` 留存开关,默认关闭(规格 §5.6)

### ⚠️ 数据源是 browser view 页面,不是邮件正文(D-019)

2026-09-09 实测确认:**Plenti 邮件正文的客户字段是空的**(Lily 直接收到的
原件也一样)。Plenti 是上市金融机构,让他们改模板不现实,我们只能自适应。

**邮件只负责两件事:触发处理,提供 View in Browser 链接。** 真实数据由脚本
抓取该链接指向的页面得到 —— 纯静态页,不需要 cookie、不需要执行 JS。

页面上**只有三项**:客户姓名 / 客户地址 / 可再生系统。**没有电话,没有客户
邮箱**(已全文搜索确认,包括注释、meta 与隐藏元素)。因此 Lead 上不会有
`Email`,`Phone` 也拿不到 —— 这不是缺陷,是数据源就没有。

**尚未完成**:

- **组投递识别与发件人可信验证尚未验证**。eDocs 组还没建好,拿不到经过组投递
  的邮件:`list:<组地址>` 查询、`X-Original-Sender` 与
  `X-Original-Authentication-Results` 这三样都没有真实样本可测。
  其余环节靠 `plTestFromMessageId` 这个**临时**测试入口验证(D-020),
  配合 `PLENTI_TEST_SENDER_OVERRIDE` 伪造身份头(D-021)。
  ⚠️ **开着那个属性时规格 §5.1 的可信验证整个是假的** —— 它是本项目安全性
  最关键的控制,进组之后必须单独补测,不能因为测试通过就认为它验证过了。
  两者都在 Phase 4 后删除。
- **`Plenti_Received_At__c` 在生产上尚未建出来**(D-023)。沙箱已建并写入。
  代码会用 describe 探测该字段是否存在:**不存在就跳过,不会阻断建 Lead**,
  收件时间仍留在 `Plenti_Parsed_JSON__c` 的 `receivedAt` 里。但在生产建好
  之前,**PLT001 SLA 无法从专用字段统计**(规格 §5.3 要求按该字段计算而非
  `CreatedDate`)。
- **任务 B upsert**(D-013)。当前是 `POST` + 事前 SOQL 查重,尚未切到
  `PATCH /sobjects/Lead/Plenti_Lead_ID__c/{token}`
- **补充资料更新已有 Lead 的路径**。`kind==='supplement'` 目前只转 review
- **review 状态的自动解除**(Q9,阻塞于 Q1)。`plRefreshReview_` 是空操作桩,
  `SF-Lead-Review` 标签需人工处理
- 任何 Salesforce 连接与字段映射验证(Phase 4)

⚠️ `isPlentiSource_` 的实现**必须用 2026-09-09 拿到的真实样本验证**。不能假设
Google Groups 一定保留了 `X-Original-Sender` 和 `X-Original-Authentication-Results`
这两个头。拿到样本第一件事是打印全部邮件头确认。

---

## ⚠️ 未决风险:新建 Lead 无人跟进(规格 §5.9)

**这是本项目目前最重要的业务未决项,上线前必须由 Jack 解决。**

模板逻辑把新建 Lead 全部指派给审核管理员 `INTAKE_ADMIN_ID`。在 Plenti
模型下这意味着:

> **SLA 时钟(PLT001,1 个工作日内尝试联系)开始跑,但没有任何人被分配
> 去联系客户。**

合同 SLA 未达标时 Plenti **可立即终止合同,没有补救期**。目前 Plenti 线索
的跟进人尚未确定(Graham Bottomley 出现过但角色未定义)。

**这是业务未决项,不是代码问题。** 代码先按 `INTAKE_ADMIN_ID` 实现,
但在跟进人确定并配置好之前**不得启用本项目的触发器**。

---

## ⚠️ 运行日志 Sheet 含 PII —— 分享设置必须限制为指定人员

`INTAKE_LOG_SHEET_ID` 指向的 Google Sheet 有两个标签页:

| 标签页 | 内容 |
|---|---|
| 第一页(汇总) | 每轮执行一行:时间、线程数、处理数、建 Lead 数、失败数、错误摘要、耗时 |
| `Messages` | **每封邮件一行,含完整邮件正文** |

**`Messages` 页会包含真实客户的姓名、邮箱、电话、安装地址,以及邮件原文里
的任何其他内容。**

因此:

- ❌ **绝不可设为「知道链接的人可查看」**(anyone with the link)
- ❌ 不可设为对整个域可见
- ✅ 分享设置必须限制为**逐个指定的人员**
- ✅ Sheet ID 本身不写进本仓库,只放 Script Properties

这张表存在的理由是排查和调解析正则(Apps Script 日志保留期短),
**不是长期客户数据仓库**。解析规则稳定之后应当评估保留期与清理策略 ——
这一条和 Q5(数据留存范围)是同一个问题。

---

## 安全开关:两道锁,默认全关

`runIntakeV2()` 在任何 Gmail / Salesforce 调用之前检查两个 Script Property,
任一为 `false` 就不执行任何写操作:

| 属性 | 默认 | 含义 |
|---|---|---|
| `INTAKE_V2_ENABLED` | `false` | 上线开关。为 false 时直接返回 |
| `EDOCS_ADAPTATION_VALIDATED` | `false` | 交接安全锁。为 false 时抛错 |

第二把锁**不是**自动检测 Plenti 适配是否完成,只是一道人工闸门 ——
只有负责人逐条验收(规格 §7)之后才手动改为 true。

本仓库**不提供**任何"验收通过后自动打开"的辅助函数。
`enableIntakeV2AfterValidation()` 被有意实现为直接抛错。

---

## 字段自检 —— 改字段映射或切生产前先跑

```
plTestDescribeLead()
```

取 Salesforce 的 Lead describe,和代码实际用到的字段比对,列出「代码要用但
这个 org 里没有」的字段。只读,不写任何记录。

⚠️ **Salesforce 是全有全无:一个字段不存在,整个请求就失败。** 这类错误的
表现是运行时 400,排查成本高 —— 切生产之前务必先跑一次,生产的字段和沙箱
不一定一样(D-022)。

离线测试里还有一道对应的守卫:代码触及的自定义字段必须**恰好等于**已确认
存在的那五个,多一个就红。

---

## 本地测试

无任何 npm 依赖,只用 Node 内置模块(`node:vm`、`node:assert`)。

```bash
node test/offline.cjs
```

测试在 `node:vm` 沙箱中加载 `src/Code.gs` 与 `src/Tests.gs`,
`UrlFetchApp.fetch` 被替换为直接抛错的桩 —— **测试不会连接 Gmail 或
Salesforce,不会读写任何真实记录**。

测试内容分三层:

1. **静态守卫** —— 断言 `Code.gs` / `Plenti.gs` 去掉注释后不出现 `Legacy.gs`
   定义的任何函数名,并断言 `Legacy.gs` 的每一行都按原顺序出现在 handoff
   原件里。Apps Script 是单一全局作用域,文件头声明靠人自觉,这道检查是强制的。
   守卫自身带正反向自测。
2. **模板基线** —— 规格 §6 Phase 1 第 4 项列出的那些用例,一条不少:
   11 分类 + 2 字段提取 + 3 边界 + 8 标签 + 6 短询问 + 6 购买意图 +
   3 回复地址 + 多行地址 + 6 去重 + 安全门槛。
3. **Plenti 路径** —— 可信验证、域名边界绕过、排除规则、空发件人、解析骨架、
   fail-closed 去重、防重锁、字段映射、`.eml` 开关、端到端分流。

> 输出中 `8 Lead-only label cases` 出现两次,是 `testPurchaseIntentUpgrade`
> 与 `testMultilineReplyRepair` 各自嵌套调用了一次 `testLeadOnlyLabels()`,
> 不是多出来的测试用例。

---

## 目录结构

```
├── appsscript.json       Apps Script manifest(时区 Australia/Adelaide)
├── .clasp.json           本地生成,已 gitignore,Phase 4 才创建
├── src/
│   ├── Plenti.gs         **主干** —— plProcess_ 及全部 Plenti 逻辑
│   ├── Code.gs           基础设施工具库(SF REST / 属性 / 状态 / 标签 / 定时入口)
│   ├── Legacy.gs         info 模型专有逻辑,原文隔离,主干不引用
│   ├── Tests.gs          模板回归测试(原文未改,兼作 Legacy 未被改动的守卫)
│   └── PlentiTests.gs    Plenti 路径回归测试
├── test/
│   ├── offline.cjs       沙箱测试入口 + 静态守卫
│   └── fixtures/         虚构样本邮件 .json(规则见该目录 README)
└── docs/
    ├── eDocs-Plenti-Intake-开发规格.md   项目规格
    ├── DECISIONS.md                      决策记录与待办
    └── edocs-plenti-handoff/             Lily 交接的参考包(冻结,不再同步)
```

`docs/edocs-plenti-handoff/` 是**一次性模板**,复制之后两边再无关系。
保留在仓库内仅供 diff 比对,**不是上游依赖**,不需要同步或合并。

---

## Script Properties

所有环境相关值一律走 Script Properties,**代码中不硬编码**,缺失即抛错停止。
Phase 2 新增四项:`INTERNAL_DOMAIN`、`EDOCS_GROUP_ADDRESS`、
`PLENTI_TRUSTED_SENDERS`、`ATTACH_RAW_EMAIL`(默认关闭)。
完整清单与格式说明见 [docs/DECISIONS.md](docs/DECISIONS.md)。

凭据**不写进仓库**,只通过获准的安全方式配置,不发在聊天或邮件中。

---

## OAuth Scopes

`appsscript.json` 声明三个 scope:

| Scope | 用途 |
|---|---|
| `https://mail.google.com/` | GmailApp:读邮件、加标签 |
| `.../auth/script.external_request` | UrlFetchApp:调 Salesforce REST API |
| `.../auth/script.storage` | PropertiesService:去重与处理状态 |
| `.../auth/spreadsheets` | SpreadsheetApp:运行日志与消息级日志(D-016 / D-018)|

⚠️ `spreadsheets` 是 R2 新加的 scope。**加 scope 会使现有授权失效,Apps Script
会要求重新授权。**

`https://mail.google.com/` 是 Gmail 的**完全权限**(读 + 写 + 删),而本项目
实际只需要读邮件和加标签。**这个 scope 大概率收不窄** —— Apps Script 的内置
GmailApp 服务就是绑定该 scope 的,要收窄基本得改用 Gmail 高级服务直接调
REST API,那是另一套写法、另一次重写。Phase 4 会实测确认,但不要按"能收窄"
来规划。

因此:**必须使用专用账号(`sf-intake`),并由 Workspace 管理员审核授权。**
触发器必须用 `sf-intake` 账号登录创建 —— GmailApp 操作的是**实际执行用户**
的邮箱,不由 `INTAKE_MAILBOX` 属性决定,该属性只是记录来源文字。

---

## 已知限制(规格 §9,本期不解决)

- 规则是**正则匹配,不是语义理解**。没见过的邮件格式会落到 review,
  不会被静默丢弃,但也不会被自动处理。
- **跨项目无法原子去重。** info 与 eDocs 两个 Apps Script 项目写入同一个
  Salesforce,彼此的 Properties、锁和 Gmail ID 互不可见。建 Lead 前查询
  同邮箱活跃 Lead 只能挡住绝大多数情况,不是完备方案。
- **Script Properties 有 500KB 上限**,长期运行需迁移到外部状态存储。
- **Apps Script 锁只保护单项目**,不保证跨系统 exactly-once。标签失败、
  文件失败、Lead 已写入等中间状态必须逐一测试。
- **Lead Description 上限 32,000 字符**,超出报错。
- **本脚本不发送首次回应邮件。** Salesforce 既有的自动回复、分配和其他
  Flow 可能被创建动作触发,需单独验证。
- 标签的两态含义(D-024):`SF-Lead-Created` + `SF-Lead-Review` = **待补联系
  方式**;Review 熄灭、只剩 Created = **已补全**。解除信号是 Lead 上出现了
  `Email` / `Phone` / `MobilePhone` 任一项 —— Plenti 一条都不给,所以非空只
  可能是人填的。
- 并非每条 review 都对应一条 Salesforce 记录 —— `SF-Lead-Review` 标签既
  可能是已创建的待审核 Lead,也可能是尚未唯一匹配的邮件。
- **`SF-Lead-Review` 标签只留给带 Plenti browser-view 链接的邮件**(D-027)。
  没有链接的普通业务邮件仍会落 review 状态、在 Messages 表里留一整行(含完整
  正文和原因),但**不占标签** —— 否则进组当天真正的 lead 会被业务邮件淹掉。
  可见面从 Gmail 标签移到 Messages 表,可见性本身没有降低。
- **手动转发的 Plenti 邮件会被单独标为 `forwarded`**,不会被当成疑似伪造。
  判据是 `From` 在内部域上 —— ⚠️ `From` 可伪造,所以它**只影响 reason 措辞,
  不影响是否打标签**。
- **`SF-Lead-Updated` 在 Plenti 路径上永远不亮**(D-024)。它唯一的触发条件
  `verifiedFields` 只有 `Legacy.gs` 里的回复补录逻辑会写,而主干不调用它。
- **Plenti 不提供任何联系方式**,电话和邮箱只在 Plenti Portal 里,而 Portal
  每次登录都要双重验证、账号是个人账号,无法自动化。因此**每一条 Plenti 线索
  都必须有人去 Portal 取联系方式**,这是必经状态而非边缘情况(D-024)。
- `INTAKE_V2_START` 必须配置且可解析,否则 `runIntakeV2` 直接抛错停止 ——
  脚本**不会**在缺配置时回扫历史邮件(DECISIONS TODO-3 修复了模板的这个缺口)。
- **跨邮箱去重在 Plenti 路径上实际失效**(Q15)。规格 §5.5 那一层靠客户邮箱
  查询,而 Plenti 从不提供客户邮箱。info 与 eDocs 同时收到同一客户时不再能
  自动拦截,只能靠人工审核兜住。
- **browser view 链接可能有有效期。** 抓取时间戳记在 `Plenti_Parsed_JSON__c`
  的 `browserView.fetchedAt`;抓取失败时 Lead 照建并标记 `[DEGRADED]`,
  人工可以自己点邮件里的链接查看。
- **收件人白名单不命中的邮件不留任何痕迹**(D-015)—— 不写状态、不打标签。
  这是范围过滤,与 `list:` 查询同一性质,不是"静默丢弃"分类不确定的邮件。
  若日后把某地址移出白名单,相关 thread 的旧标签不会自动清除。
- **邮件正文这一轮不做任何清洗**(D-018)。`plCleanBody_` 是纯透传占位:
  Plenti 的邮件格式 2026-09-09 才第一次见到,此刻写的清洗规则都是猜的。
  回落到 HTML 时标签原样保留,不剥。
- **`IV2_CREATE_` 防重锁不回滚**(DECISIONS L-01):任何 Salesforce 写入失败
  ——包括明摆着可重试的 500——都需要人工去 Script Properties 删键才能继续,
  且会冻结 watermark 造成渐进劣化。
- **Business Hours 当前配置错误**(Los Angeles 时区 + 24/7),必须改为
  Adelaide 时区、正确营业时间并加入南澳公共假期。这是本项目之外的
  Salesforce 配置任务,但**在它修好之前任何"工作日"计算都是错的**。
  本项目只负责准确记录时间戳,不负责计算工作日差值。

---

## 停用

需要停止时:将本项目 `INTAKE_V2_ENABLED` 设为 `false`,并停用本项目触发器。
**不要改 info 项目。**

保留状态属性及已创建记录,先核对"API 成功但标签失败"等中间状态再重试。
`IV2_MSG_*`、`IV2_CREATE_*`、`IV2_REF_*` 参与去重和失败恢复,
**不要通过删除全部状态来强制重跑历史邮箱。**
