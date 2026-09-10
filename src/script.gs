/**
 * script.gs —— ⚠️ [R9 临时] 手动运行的快捷入口,Phase 4 后与 R3/R9/R10 一起删除。
 *
 * 存在理由:Apps Script 编辑器的 Run 下拉框只列出**无参数**的顶层函数。
 * plTestFromMessageId 需要一个消息 ID,直接点不了;这两个包装函数是为了
 * 能在编辑器里一键运行。
 *
 * ⚠️ 之前每次 clasp push 都被删,是因为它只存在于线上、不在仓库里。
 * 现在纳入 src/,push 会带上它,不会再丢。
 *
 * ⚠️ 里面写死了一个测试邮件的 Gmail 消息 ID。这是临时测试脚手架,不是主流程
 * 配置 —— 主流程的所有环境值仍然一律走 Script Properties(规格 §3 禁止 #2)。
 * 换一封邮件测试时,用 plTestFindMessages('subject:"..." newer_than:7d')
 * 取新的 ID 改这里。
 *
 * 删除清单见 DECISIONS D-020 / D-028。
 */

/** 字段自检:列出代码要用但这个 org 里没有的字段。只读,不写任何记录。 */
function describeIt(){ plTestDescribeLead(); }

/** 跑完整链路。第二个参数 true = 强制重跑已处理过的邮件。 */
function runIt(){ plTestFromMessageId('1a08358cc6f72de8', true); }
