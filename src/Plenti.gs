/**
 * Plenti 专用解析路径。
 *
 * 本期(Phase 1 — 本地地基)不实现任何逻辑,本文件仅为占位。
 *
 * 接口定义见规格 §6 Phase 3,本期不实现:
 *   isPlentiSource_(message)      → {trusted, reason}
 *   parsePlentiReferral_(message) → {referralId, customer, kind, confidence}
 *
 * Phase 3 实现时需遵守的约束(规格 §5.1 / §5.2 / §5.8):
 *   - 来源可信性只能由 X-Original-Sender 与
 *     X-Original-Authentication-Results 判定;显示名、主题、正文自称
 *     来自 Plenti 都不构成证据。验证不通过 → review,不建 Lead。
 *   - 客户身份必须从正文明确字段提取,不得以发件人邮箱兜底。
 *   - 字段缺失或多个候选 → review,绝不静默丢弃。
 *
 * 代码风格:Apps Script V8 运行时,但保持 ES5 —— 只用 var 和 function
 * 声明,不用箭头函数 / let / const / async,与 Code.gs 一致。
 */
