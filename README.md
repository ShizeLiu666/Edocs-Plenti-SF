# eDocs Plenti Intake

读取 eDocs 群组投递到 `sf-intake@sunterra.com.au` 的邮件副本,识别其中来自
Plenti 的转介线索,在 Salesforce 建 Lead,并记录 SLA 所需的时间戳。

一个**全新的、独立的** Google Apps Script 项目。**它不是**对现有 info 邮箱
项目的修改 —— info 那个项目继续独立运行,本项目不碰它。

完整规格见 [docs/eDocs-Plenti-Intake-开发规格.md](docs/eDocs-Plenti-Intake-开发规格.md)。
决策记录与待办见 [docs/DECISIONS.md](docs/DECISIONS.md)。

---

## 当前状态:Phase 1(本地地基)—— 不可上线

已完成:仓库、目录结构、`.gitignore`、`appsscript.json`、离线测试入口。

**尚未完成**:Plenti 解析(Phase 3)、发件人可信验证(Phase 3)、
业务级去重(Phase 3)、任何 Salesforce 连接验证(Phase 4)。

`src/Code.gs` 与 `src/Tests.gs` 目前是 info 邮箱模板的**原样导入**,
针对 Plenti 的适配一项都还没做。详见 `docs/DECISIONS.md` 的待办清单。

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

## 本地测试

无任何 npm 依赖,只用 Node 内置模块(`node:vm`、`node:assert`)。

```bash
node test/offline.cjs
```

测试在 `node:vm` 沙箱中加载 `src/Code.gs` 与 `src/Tests.gs`,
`UrlFetchApp.fetch` 被替换为直接抛错的桩 —— **测试不会连接 Gmail 或
Salesforce,不会读写任何真实记录**。

当前基线(规格 §6 Phase 1 第 4 项):11 分类 + 2 字段提取 + 3 边界 +
8 标签 + 6 短询问 + 6 购买意图 + 3 回复地址 + 多行地址 + 6 去重 + 安全门槛。

> 输出中 `8 Lead-only label cases` 出现两次,是 `testPurchaseIntentUpgrade`
> 与 `testMultilineReplyRepair` 各自嵌套调用了一次 `testLeadOnlyLabels()`,
> 不是多出来的测试用例。

---

## 目录结构

```
├── appsscript.json       Apps Script manifest(时区 Australia/Adelaide)
├── .clasp.json           本地生成,已 gitignore,Phase 4 才创建
├── src/
│   ├── Code.gs           主流程(Phase 1 为模板原样导入)
│   ├── Plenti.gs         Plenti 专用解析(Phase 3 实现,当前仅占位)
│   └── Tests.gs          回归测试(Phase 1 为模板原样导入)
├── test/
│   ├── offline.cjs       沙箱测试入口
│   └── fixtures/         虚构样本邮件(规则见该目录 README)
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
完整清单(含 Phase 2/3 才引入的属性)见 [docs/DECISIONS.md](docs/DECISIONS.md)。

凭据**不写进仓库**,只通过获准的安全方式配置,不发在聊天或邮件中。

---

## OAuth Scopes

`appsscript.json` 声明三个 scope:

| Scope | 用途 |
|---|---|
| `https://mail.google.com/` | GmailApp:读邮件、加标签 |
| `.../auth/script.external_request` | UrlFetchApp:调 Salesforce REST API |
| `.../auth/script.storage` | PropertiesService:去重与处理状态 |

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
- 并非每条 review 都对应一条 Salesforce 记录 —— `SF-Lead-Review` 标签既
  可能是已创建的待审核 Lead,也可能是尚未唯一匹配的邮件。
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
