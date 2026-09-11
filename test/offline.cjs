'use strict';
// 离线回归测试入口。只用 Node 内置模块,无任何 npm 依赖。
// 不连接 Gmail 或 Salesforce:UrlFetchApp 与 GmailApp 都是抛错的桩。
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');

const SRC = path.join(__dirname, '..', 'src');
const FIXTURE_DIR = path.join(__dirname, 'fixtures');
const HANDOFF = path.join(__dirname, '..', 'docs', 'edocs-plenti-handoff', 'Code.gs');
const read = (...p) => fs.readFileSync(path.join(...p), 'utf8');

// ──────────────────────────────────────────────────────────────
// 1. 静态守卫:Code.gs / Plenti.gs 不得引用 Legacy.gs 的任何函数
//
// Apps Script 是单一全局作用域,Legacy.gs 的函数在运行时随处可调。
// 文件头的声明靠人自觉,这道检查是强制的。
// ──────────────────────────────────────────────────────────────

// 去掉注释再匹配,这样文档里可以正常提到 Legacy 函数名。
// `//` 前面是冒号时不当作注释,避免误伤字符串里的 https:// 。
const stripComments = (src) =>
  src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1');

const definedFunctions = (src) => {
  const names = [];
  const re = /^function\s+([A-Za-z0-9_$]+)\s*\(/gm;
  for (let m = re.exec(src); m; m = re.exec(src)) names.push(m[1]);
  return names;
};

const findReferences = (names, src) => {
  const body = stripComments(src);
  return names.filter((n) => new RegExp(`\\b${n}\\b`).test(body));
};

// 守卫自测:一道永远不会失败的检查等于没有检查。
assert.deepEqual(
  findReferences(['ivClassify_'], 'function x(){return ivClassify_(a,b,c);}'),
  ['ivClassify_'], 'guard must catch a real call');
assert.deepEqual(
  findReferences(['ivClassify_'], '// mentions ivClassify_ in a line comment\nfunction x(){return 1;}'),
  [], 'guard must ignore line comments');
assert.deepEqual(
  findReferences(['ivTop_'], '/**\n * mentions ivTop_ in a block comment\n */\nfunction x(){return 1;}'),
  [], 'guard must ignore block comments');
assert.deepEqual(
  findReferences(['ivTop_'], "var u='https://a.example/'; // ivTop_ mentioned after a URL\n"),
  [], 'guard must not be confused by :// inside a string');
assert.deepEqual(
  findReferences(['ivProcess_'], 'function x(){return plProcess_(m,false);}'),
  [], 'guard must not match on a different function with a similar name');

const legacyNames = definedFunctions(read(SRC, 'Legacy.gs'));
assert.ok(legacyNames.length > 0, 'Legacy.gs must define functions, otherwise the guard is vacuous');
for (const file of ['Code.gs', 'Plenti.gs', 'script.gs']) {
  const hits = findReferences(legacyNames, read(SRC, file));
  assert.deepEqual(hits, [], `${file} must not reference Legacy.gs functions: ${hits.join(', ')}`);
}
console.log(`PASS: static guard — ${legacyNames.length} Legacy functions, zero references from Code.gs/Plenti.gs/script.gs`);

// [R10] 测试用发件人覆盖属性:主流程绝不能读它。
// 这道检查连同下面 PlentiTests 里的行为检查一起,构成"主流程不受影响"的双保险。
{
  const prop = 'PLENTI_TEST_SENDER_OVERRIDE';
  const codeHits = (stripComments(read(SRC, 'Code.gs')).match(new RegExp(prop, 'g')) || []).length;
  assert.equal(codeHits, 0,
    `${prop} must never appear in Code.gs — runIntakeV2 must not be able to read a test-only override`);
  const plenti = stripComments(read(SRC, 'Plenti.gs'));
  assert.equal((plenti.match(new RegExp(prop, 'g')) || []).length, 3,
    `${prop} is expected only inside the R10 temporary block (one getProperty plus two guard messages)`);
  // 读取器只能被测试入口调用,不能渗进主流程
  const readers = (plenti.match(/plTestSenderOverride_/g) || []).length;
  assert.equal(readers, 2, 'plTestSenderOverride_ must be defined once and called exactly once (from the test entry point)');
  console.log('PASS: R10 sender override is confined to the test entry point');
}

// ──────────────────────────────────────────────────────────────
// 2. Legacy.gs 必须是 handoff 模板的原文,一个字都没改
// ──────────────────────────────────────────────────────────────
{
  const original = read(HANDOFF).split('\n');
  const legacyLines = read(SRC, 'Legacy.gs').split('\n');
  const start = legacyLines.findIndex((l) => /^function\s/.test(l));
  assert.ok(start > 0, 'Legacy.gs must start with a header comment followed by functions');
  let cursor = 0;
  let checked = 0;
  for (const line of legacyLines.slice(start)) {
    if (!line.trim()) continue;
    const at = original.indexOf(line, cursor);
    assert.ok(at >= 0, `Legacy.gs is not verbatim from the handoff template: ${line.slice(0, 70)}`);
    cursor = at + 1;
    checked += 1;
  }
  console.log(`PASS: Legacy.gs is verbatim from the handoff template (${checked} lines, in original order)`);
}

// ──────────────────────────────────────────────────────────────
// 3. Fixture:必须是虚构的 .json,禁止 .eml(DECISIONS D-005)
// ──────────────────────────────────────────────────────────────
const fixtureFiles = fs.readdirSync(FIXTURE_DIR);
assert.deepEqual(fixtureFiles.filter((f) => f.toLowerCase().endsWith('.eml')), [],
  'fixtures must never be stored in .eml format, even when the content is invented');
const fixtures = {};
for (const file of fixtureFiles.filter((f) => f.endsWith('.json'))) {
  fixtures[path.basename(file, '.json')] = JSON.parse(read(FIXTURE_DIR, file));
}
assert.ok(Object.keys(fixtures).length > 0, 'no fixtures were loaded');

// ──────────────────────────────────────────────────────────────
// 4. Apps Script 运行时的桩
// ──────────────────────────────────────────────────────────────
const props = new Map();
const scriptProperties = {
  getProperty: (k) => (props.has(k) ? props.get(k) : null),
  setProperty(k, v) { props.set(k, String(v)); return this; },
  deleteProperty(k) { props.delete(k); return this; },
  getProperties: () => Object.fromEntries(props)
};

const gmail = {
  search() { throw new Error('GMAIL CALL BLOCKED IN OFFLINE TEST'); },
  getMessageById() { throw new Error('GMAIL CALL BLOCKED IN OFFLINE TEST'); },
  getUserLabelByName() { throw new Error('GMAIL CALL BLOCKED IN OFFLINE TEST'); },
  createLabel() { throw new Error('GMAIL CALL BLOCKED IN OFFLINE TEST'); }
};

// [R2] Google Sheet 桩。默认抛错(和其他外部服务一致),需要时按用例替换。
const sheets = {
  openById() { throw new Error('SPREADSHEET CALL BLOCKED IN OFFLINE TEST'); }
};

const context = vm.createContext({
  console,
  PLENTI_FIXTURES: fixtures,
  PropertiesService: { getScriptProperties: () => scriptProperties },
  UrlFetchApp: { fetch: () => { throw new Error('NETWORK CALL BLOCKED IN OFFLINE TEST'); } },
  GmailApp: gmail,
  SpreadsheetApp: sheets,
  LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock: () => {} }) },
  Utilities: {
    Charset: { UTF_8: 'UTF-8' },
    DigestAlgorithm: { SHA_256: 'SHA-256' },
    base64Encode: (s) => Buffer.from(String(s), 'utf8').toString('base64'),
    base64EncodeWebSafe: (b) => Buffer.from(b).toString('base64url'),
    computeDigest: (_alg, value) => Array.from(crypto.createHash('sha256').update(String(value)).digest())
  }
});

// Legacy.gs 在 Code.gs 之后加载:主流程不依赖它,顺序只影响可读性。
for (const file of ['Code.gs', 'Legacy.gs', 'Plenti.gs', 'Tests.gs', 'PlentiTests.gs', 'script.gs']) {
  new vm.Script(read(SRC, file), { filename: `src/${file}` }).runInContext(context);
}

// ──────────────────────────────────────────────────────────────
// 4b. [R11] 自定义字段白名单 —— 这一道是长期守卫,不随临时代码删除
//
// Salesforce 是全有全无:代码引用一个 org 里不存在的字段,整个请求就失败,
// 表现是运行时 400,排查成本高。这里在测试期就把它挡住。
//
// 用运行时字段集(plLeadFieldsUsed_)而不是文本扫描 —— 它由 plLeadFields_
// 和 plLeadPayload_ 实际推导出来,改了代码自动跟着变,不会漂移。
// ──────────────────────────────────────────────────────────────
{
  // Sunterra org 里**确认已建**的自定义字段。代码无条件写这些,缺一个整个请求就失败。
  const REQUIRED_CUSTOM_FIELDS = [
    'Contact_Attempt_Count__c',
    'Plenti_Browser_View_HTML__c',
    'Plenti_Lead_ID__c',
    'Plenti_Parsed_JSON__c',
    'Plenti_Raw_Email__c'
  ];
  // 可选字段:org 里没有时按 D-023 的 describe 探测自动跳过,不会让请求失败。
  // 它们允许暂时不存在,但**必须列在这里**,否则等于没人审过就混进了写入路径。
  const OPTIONAL_CUSTOM_FIELDS = [
    'Plenti_Received_At__c',   // [R12] 沙箱已建,生产未建
    'Plenti_Systems__c'        // [R13] 待建;未建时 Description 里有备份
  ];

  props.set('INTAKE_ADMIN_ID', '005000000000000AAA');
  props.set('PLENTI_LEAD_SOURCE', 'Plenti Referrals');
  const used = context.plLeadFieldsUsed_();
  context.plLeadFieldMap_.cache = null;   // 探测缓存不能渗进后面的用例
  props.clear();

  const custom = used.filter((f) => f.name.endsWith('__c'));
  const optional = custom.filter((f) => f.optional).map((f) => f.name).sort();
  const required = custom.filter((f) => !f.optional).map((f) => f.name).sort();

  assert.deepEqual([...required], REQUIRED_CUSTOM_FIELDS,
    `unconditionally-written custom fields must all exist in the org. Unexpected: ${required.filter((n) => !REQUIRED_CUSTOM_FIELDS.includes(n)).join(', ') || '(none)'}`);
  assert.deepEqual([...optional], OPTIONAL_CUSTOM_FIELDS,
    `every optional custom field must be declared here, so a new one cannot slip into the write path unreviewed. Unexpected: ${optional.filter((n) => !OPTIONAL_CUSTOM_FIELDS.includes(n)).join(', ') || '(none)'}`);
  console.log(`PASS: custom-field allowlist — ${required.length} required (must exist), ${optional.length} optional (degrade if absent)`);
}

// ──────────────────────────────────────────────────────────────
// 4c. 每个测试函数都必须被入口调用
//
// 定义了却没接进 runPlentiRegressionTests 的用例是**静默失效**的:套件照常
// 全绿,但那部分根本没跑。加用例时漏接一行入口很容易发生,这里强制检查。
// ──────────────────────────────────────────────────────────────
{
  const src = read(SRC, 'PlentiTests.gs');
  const defined = [...src.matchAll(/^function (testPlenti\w+)/gm)].map((m) => m[1]);
  const entry = src.slice(src.indexOf('function runPlentiRegressionTests'));
  const called = [...entry.matchAll(/(testPlenti\w+)\(\)/g)].map((m) => m[1]);
  const orphans = defined.filter((n) => !called.includes(n));
  assert.deepEqual([...orphans], [],
    `these test functions are defined but never called from runPlentiRegressionTests, so they silently do not run: ${orphans.join(', ')}`);
  assert.ok(defined.length > 0, 'the scan must actually find test functions, otherwise this guard is vacuous');
  console.log(`PASS: all ${defined.length} Plenti test functions are wired into the entry point`);
}

// ──────────────────────────────────────────────────────────────
// 5. 回归测试
// ──────────────────────────────────────────────────────────────
context.runOfflineRegressionTests();   // 模板基线(测的是 Legacy.gs + Code.gs 的原文函数)
context.runPlentiRegressionTests();    // Plenti 主干

// ──────────────────────────────────────────────────────────────
// 6. 安全门槛:两道开关默认关闭,缺配置即抛错
// ──────────────────────────────────────────────────────────────
props.clear();
context.runIntakeV2(); // 默认停用,不触碰 Gmail 或 Salesforce
props.set('INTAKE_V2_ENABLED', 'true');
assert.throws(() => context.runIntakeV2(), /adaptation has not been validated/);
assert.throws(() => context.enableIntakeV2AfterValidation(), /cannot auto-enable/);
assert.throws(() => context.ivAdmin_(), /valid INTAKE_ADMIN_ID/);
assert.throws(() => context.getSalesforceClientCredentialsToken_(), /SF_LOGIN_URL/);
console.log('PASS: safe export guards; no Gmail/Salesforce connection or records changed');

// ──────────────────────────────────────────────────────────────
// 7. 收信范围收窄(规格 §5.7)
// ──────────────────────────────────────────────────────────────
props.set('EDOCS_ADAPTATION_VALIDATED', 'true');

// INTAKE_V2_START 的三条校验(DECISIONS TODO-3)。这三条锁住的是一个修好的
// 行为:模板原写法在属性缺失时会静默回扫到 1970-01-01,在属性非法时会先抛
// RangeError 使那句写好的提示永远不可达。以后重构 runIntakeV2 不能把它改回去。
assert.throws(() => context.runIntakeV2(), /Configure INTAKE_V2_START/,
  'a missing start time must stop before any mailbox access, not silently scan from 1970');
props.set('INTAKE_V2_START', 'not-a-timestamp');
let thrown = null;
try { context.runIntakeV2(); } catch (e) { thrown = e; }
assert.ok(thrown, 'an unparsable start time must throw');
assert.match(String(thrown.message), /Configure INTAKE_V2_START with a parsable ISO timestamp/,
  'an unparsable start time must raise a recognisable error');
// instanceof 跨 vm realm 不可靠,按 name 和 message 判定。
assert.notEqual(thrown.name, 'RangeError',
  'the start-time check must run before any Date method call, so no RangeError can pre-empt it');
assert.doesNotMatch(String(thrown.message), /Invalid time value/,
  'the template RangeError must no longer surface');

props.set('INTAKE_V2_START', '2026-09-07T00:00:00+09:30');
props.set('INTAKE_V2_WATERMARK', 'not-a-timestamp');
assert.throws(() => context.runIntakeV2(), /Missing valid intake start\/watermark/,
  'a valid start with an unparsable watermark still hits the original check');
props.delete('INTAKE_V2_WATERMARK');
console.log('PASS: 3 intake start-time validation cases (template fail-open gaps closed)');

assert.throws(() => context.runIntakeV2(), /EDOCS_GROUP_ADDRESS/,
  'the group address must be configured before any mailbox is scanned');

props.set('EDOCS_GROUP_ADDRESS', 'edocs@example.org');

// [R1] 白名单未配置必须抛错停止 —— 一个本意为"收窄范围"的开关,
// 缺失时不能反而变成最宽,而且不能是静默的。
assert.throws(() => context.runIntakeV2(), /INTAKE_RECIPIENT_ALLOWLIST/,
  'a missing recipient allowlist must stop the run, never fall back to processing everything');

props.set('INTAKE_RECIPIENT_ALLOWLIST', 'edocs@example.org, jack.fixture@example.com');
let observedQuery = null;
gmail.search = (q) => { observedQuery = q; throw new Error('GMAIL SEARCH BLOCKED IN OFFLINE TEST'); };
assert.throws(() => context.runIntakeV2(), /GMAIL SEARCH BLOCKED/);
assert.match(observedQuery, /^list:edocs@example\.org /, 'the scan must be limited to the eDocs group');
assert.match(observedQuery, /-in:spam -in:trash/, 'spam and trash stay excluded');
assert.match(observedQuery, /after:\d+ before:\d+/, 'the watermark window is still applied');
assert.doesNotMatch(observedQuery, /in:inbox|is:unread/,
  'the query must not depend on inbox location — the mailbox owner may auto-archive');
console.log(`PASS: intake query narrowed to the eDocs group — ${observedQuery}`);

// ──────────────────────────────────────────────────────────────
// 8. [R1] + [R2] 循环接线的集成测试
//    一个 thread、两封邮件:一封在白名单内,一封不在。
// ──────────────────────────────────────────────────────────────
const makeMessage = (id, to, when, body, html) => ({
  getId: () => id,
  getSubject: () => 'New customer referral',
  getFrom: () => 'eDocs Group <edocs@example.org>',
  getDate: () => new Date(when),
  getPlainBody: () => (body === undefined ? 'Referral reference: FIXTURE-9001\n' : body),
  getBody: () => html || '',
  getHeader: (name) => ({
    To: to,
    'X-Original-Sender': 'referrals@plenti.example',
    'X-Original-Authentication-Results': 'mx.example.org; dkim=pass; spf=pass; dmarc=pass header.from=plenti.example'
  })[name] || '',
  getRawContent: () => { throw new Error('getRawContent must not be called'); },
  getThread: () => thread
});

const labelCalls = [];
const LONG_BODY = 'x'.repeat(60000);
const thread = {
  getMessages: () => [
    makeMessage('wire-in-scope', 'eDocs <edocs@example.org>', '2026-09-08T01:00:00Z', LONG_BODY),
    makeMessage('wire-html-only', 'eDocs <edocs@example.org>', '2026-09-08T01:02:00Z', '', '<table><tr><td>Ref</td></tr></table>'),
    makeMessage('wire-out-of-scope', 'someone@elsewhere.example', '2026-09-08T01:05:00Z')
  ],
  addLabel: (l) => labelCalls.push(['add', l.name]),
  removeLabel: (l) => labelCalls.push(['remove', l.name])
};

let searchCalls = 0;
gmail.search = () => (searchCalls++ === 0 ? [thread] : []);
gmail.getUserLabelByName = (name) => ({ name });

const sheetRows = [];
const messageRows = [];
let setValuesCalls = 0;
let insertedAtIndex = null;
const makeTab = (rows) => ({
  getLastRow: () => rows.length,
  appendRow: (r) => rows.push(r),
  getRange: (row, col, numRows) => ({
    setValues: (values) => {
      setValuesCalls += 1;
      assert.equal(row, rows.length + 1, 'writes append below the last row');
      assert.equal(values.length, numRows, 'range height matches the data');
      values.forEach((v) => rows.push(v));
    }
  })
});
const summaryTab = makeTab(sheetRows);
let messagesTab = null;
sheets.openById = (id) => {
  assert.equal(id, 'fixture-sheet-id', 'the sheet id comes from Script Properties');
  return {
    getSheets: () => [summaryTab],
    getNumSheets: () => (messagesTab ? 2 : 1),
    getSheetByName: (name) => (name === 'Messages' ? messagesTab : null),
    insertSheet: (name, index) => {
      assert.equal(name, 'Messages');
      insertedAtIndex = index;
      messagesTab = makeTab(messageRows);
      return messagesTab;
    }
  };
};

props.set('INTERNAL_DOMAIN', 'example.org');
props.set('PLENTI_TRUSTED_SENDERS', '@plenti.example');
props.set('INTAKE_MAILBOX', 'edocs-copy@example.org');
props.set('PLENTI_LEAD_SOURCE', 'Plenti Referrals');
props.set('INTAKE_LOG_SHEET_ID', 'fixture-sheet-id');
context.runIntakeV2();

// R1:只有白名单内那封被处理并落状态
assert.ok(props.has('IV2_MSG_wire-in-scope'), 'the allowlisted message must be processed');
assert.ok(!props.has('IV2_MSG_wire-out-of-scope'),
  'an out-of-scope message must be skipped entirely — no state, no Properties footprint');
const inScope = JSON.parse(props.get('IV2_MSG_wire-in-scope'));
assert.equal(inScope.state, 'review', 'the parser skeleton routes it to review');
assert.ok(labelCalls.length > 0, 'labels are synced for a thread that is in scope');

// R2:表头 + 数据各一行,列序与约定一致
assert.equal(sheetRows.length, 2, 'an empty sheet gets a header row plus the run row');
// appendRow 的实参来自 vm 沙箱,是另一个 realm 的 Array —— deepStrictEqual 会
// 比较原型而失败。展开成宿主数组再比(与前面 RangeError 那处同一类问题)。
assert.deepEqual([...sheetRows[0]],
  ['Run at', 'Threads scanned', 'Messages processed', 'Leads created', 'Failures', 'Error summary', 'Duration (s)']);
const [runAt, threadsScanned, processed, created, failures, errorSummary, duration] = [...sheetRows[1]];
assert.match(runAt, /^\d{4}-\d{2}-\d{2}T/, 'run timestamp is ISO 8601');
assert.equal(threadsScanned, 1, 'one thread scanned');
assert.equal(processed, 2, 'two in-scope messages processed — the third was out of scope');
assert.equal(created, 0, 'the parser skeleton never creates a Lead');
assert.equal(failures, 0, 'no failures');
assert.equal(errorSummary, '', 'no error summary');
assert.equal(typeof duration, 'number', 'duration is a number of seconds');
console.log(`PASS: allowlist filters the loop; run logged to sheet — ${JSON.stringify(sheetRows[1])}`);

// ──────────────────────────────────────────────────────────────
// 9. [R7] 消息级日志(Messages 标签页)
// ──────────────────────────────────────────────────────────────
assert.equal(insertedAtIndex, 1,
  'the Messages tab must be inserted last — ivLogRun_ uses getSheets()[0] and would otherwise write into the wrong tab');
assert.equal(setValuesCalls, 2, 'one setValues for the header, one batch for the rows — never row-by-row append');
assert.equal(messageRows.length, 3, 'header plus two in-scope messages');
assert.deepEqual([...messageRows[0]],
  ['Processed at', 'Message date', 'Gmail message ID', 'Sender', 'Matched recipient', 'Subject',
   'Final state', 'Parse confidence', 'Parsed JSON', 'SF Lead ID', 'Notes / error', 'Body']);

const ids = messageRows.slice(1).map((r) => r[2]);
assert.deepEqual([...ids], ['wire-in-scope', 'wire-html-only'],
  'out-of-scope messages must never reach the Messages tab');

const [, msgDate, msgId, sender, recipient, subject, finalState, confidence, parsedJson, leadId, notes, body] = [...messageRows[1]];
assert.match(msgDate, /^2026-09-08T01:00:00/, 'message date is the real received time');
assert.equal(msgId, 'wire-in-scope');
assert.equal(sender, 'referrals@plenti.example', 'sender comes from X-Original-Sender');
assert.equal(recipient, 'edocs@example.org', 'the matched allowlist address is recorded');
assert.equal(subject, 'New customer referral');
assert.equal(finalState, 'review', 'the parser skeleton routes to review');
assert.equal(confidence, 'unknown / low', 'kind and confidence are recorded honestly');
assert.equal(JSON.parse(parsedJson).kind, 'unknown', 'parsed JSON is the future Plenti_Parsed_JSON__c content');
assert.equal(leadId, '', 'no Lead was created');

// 超长正文:截断 + 在 Notes 列标注,且整行仍写得进去
assert.ok(body.length <= 45000, `body must be truncated below the Sheets cell cap, got ${body.length}`);
assert.ok(body.endsWith('… [TRUNCATED]'), 'truncation is marked in the cell itself');
assert.match(notes, /\[BODY TRUNCATED from 60000 chars\]/, 'truncation is also flagged in the notes column');

// 纯 HTML 邮件:回落 getBody(),标签原样保留,并在 Notes 里标注
const htmlRow = [...messageRows[2]];
assert.match(htmlRow[11], /<table>/, 'HTML is kept verbatim — no stripping this round');
assert.match(htmlRow[10], /\[BODY IS RAW HTML/, 'the HTML fallback is flagged');
console.log(`PASS: message log — ${messageRows.length - 1} rows, truncation and HTML fallback flagged`);

// R2:Sheet 写入失败不能拖垮本轮 —— 邮件此时已处理完
sheetRows.length = 0;
messageRows.length = 0;
searchCalls = 0;
props.delete('IV2_MSG_wire-in-scope');
props.delete('IV2_MSG_wire-html-only');
props.delete('INTAKE_V2_WATERMARK');
sheets.openById = () => { throw new Error('SHEET PERMISSION DENIED'); };
assert.doesNotThrow(() => context.runIntakeV2(),
  'a logging failure must not fail the run: the mail is already processed and its state is saved');
assert.ok(props.has('IV2_MSG_wire-in-scope'), 'the message state survives a run-log failure');
assert.ok(props.has('IV2_MSG_wire-html-only'), 'the message state survives a message-log failure too');

// R2:未配置 Sheet ID → 跳过,不报错
props.delete('INTAKE_LOG_SHEET_ID');
searchCalls = 0;
props.delete('IV2_MSG_wire-in-scope');
props.delete('IV2_MSG_wire-html-only');
// [Q17] 上一轮把 watermark 推到了现在,lower 随之变成 now−48h,而这些 fixture
// 的日期是 2026-09-08 —— 不删的话主循环会按窗口跳过它们,这条用例就成了空转。
props.delete('INTAKE_V2_WATERMARK');
sheets.openById = () => { throw new Error('openById must not be called when no sheet is configured'); };
assert.doesNotThrow(() => context.runIntakeV2(), 'no sheet configured means no logging, not an error');
assert.ok(props.has('IV2_MSG_wire-in-scope'), 'the messages were really processed in this run, so the no-sheet path was exercised');
console.log('PASS: sheet logging is optional and never fails the run');

// ──────────────────────────────────────────────────────────────
// 10. [Q17] 扫描窗口对齐 + out-of-scope 状态清理(D-032)
//
// 固定 watermark = 2026-09-10T00:00Z → lower = 2026-09-08T00:00Z。
// ──────────────────────────────────────────────────────────────
{
  const WATERMARK = '2026-09-10T00:00:00.000Z';
  const LOWER = '2026-09-08T00:00:00.000Z';
  const OLD = '2026-09-07T01:00:00.000Z';        // lower 之前,但在 INTAKE_V2_START 之后
  const IN_WINDOW = '2026-09-08T12:00:00.000Z';  // lower 之后,但早于任何 now−48h
  const recent = new Date(Date.now() - 3600e3).toISOString();
  const noiseMessage = (id, when) => ({
    getId: () => id,
    getSubject: () => 'Monthly newsletter',
    getFrom: () => 'eDocs Group <edocs@example.org>',
    getDate: () => new Date(when),
    getPlainBody: () => 'An ordinary newsletter with no referral link.\n',
    getBody: () => '',
    getHeader: (name) => ({
      To: 'eDocs <edocs@example.org>',
      'X-Original-Sender': 'news@elsewhere.example',
      'X-Original-Authentication-Results': 'mx.example.org; dmarc=pass header.from=elsewhere.example'
    })[name] || '',
    getRawContent: () => { throw new Error('getRawContent must not be called'); },
    getThread: () => { throw new Error('getThread must not be called'); }
  });
  // 同一条 thread:一封早已滑出窗口的旧邮件(状态已被清理 = 没有状态),
  // 加一封新到的。Gmail 检索因为新邮件命中而返回整条 thread。
  const grownThread = {
    getMessages: () => [noiseMessage('q17-old-in-thread', OLD), noiseMessage('q17-new', recent)],
    addLabel: () => {}, removeLabel: () => {}
  };
  const rows = [];
  const tab = { getLastRow: () => rows.length, appendRow: (r) => rows.push(r),
    getRange: () => ({ setValues: (v) => v.forEach((r) => rows.push(r)) }) };
  const summary = { getLastRow: () => 1, appendRow: () => {} };
  const book = { getSheets: () => [summary], getNumSheets: () => 2, getSheetByName: () => tab, insertSheet: () => tab };
  const runOnce = () => {
    let calls = 0;
    gmail.search = () => (calls++ === 0 ? [grownThread] : []);
    context.runIntakeV2();
  };

  props.clear();
  for (const [k, v] of Object.entries({
    INTAKE_V2_ENABLED: 'true', EDOCS_ADAPTATION_VALIDATED: 'true',
    INTAKE_V2_START: '2026-09-07T00:00:00+09:30', INTAKE_V2_WATERMARK: WATERMARK,
    EDOCS_GROUP_ADDRESS: 'edocs@example.org', INTAKE_RECIPIENT_ALLOWLIST: 'edocs@example.org',
    INTERNAL_DOMAIN: 'example.org', PLENTI_TRUSTED_SENDERS: '@plenti.example',
    INTAKE_MAILBOX: 'edocs-copy@example.org', PLENTI_LEAD_SOURCE: 'Plenti Referrals',
    INTAKE_LOG_SHEET_ID: 'fixture-sheet-id'
  })) props.set(k, v);
  const seed = {
    'q17-purge-min': { state: 'review', scope: 'out-of-scope', date: OLD },
    'q17-purge-legacy': { state: 'review', kind: 'review', scope: 'out-of-scope', leadCandidate: false,
      reason: 'Out of scope: fictional pre-Q17 full-size state. '.repeat(6), date: OLD, at: OLD },
    'q17-keep-in-window': { state: 'review', scope: 'out-of-scope', date: IN_WINDOW },
    'q17-keep-error': { state: 'error', scope: 'out-of-scope', leadCandidate: true, reason: 'fictional', date: OLD },
    'q17-keep-created': { state: 'review', kind: 'referral', created: true, record: '00Qq17000000001AAA', leadCandidate: true, date: OLD },
    'q17-keep-with-link': { state: 'review', scope: 'unlisted-sender-with-link', leadCandidate: true, date: OLD },
    'q17-keep-internal': { state: 'done', kind: 'internal', reason: 'Internal sender', date: OLD }
  };
  for (const [id, s] of Object.entries(seed)) props.set(`IV2_MSG_${id}`, JSON.stringify(s));
  props.set('IV2_MSG_q17-keep-unparsable', 'not json');
  props.set('IV2_CREATE_q17-keep-created', JSON.stringify({ state: 'created', id: '00Qq17000000001AAA' }));
  gmail.getMessageById = () => null;   // ivRefreshOutstanding_ 会去拿 error / review 的消息
  gmail.getUserLabelByName = (name) => ({ name });
  sheets.openById = () => book;

  // ── 第一轮:watermark 被 error 冻结 ──
  runOnce();
  assert.ok(!props.has('IV2_MSG_q17-purge-min'), 'a minimal out-of-scope state outside the window is purged');
  assert.ok(!props.has('IV2_MSG_q17-purge-legacy'), 'a pre-Q17 full-size out-of-scope state outside the window is purged too');
  for (const id of ['q17-keep-in-window', 'q17-keep-error', 'q17-keep-created', 'q17-keep-with-link', 'q17-keep-internal', 'q17-keep-unparsable'])
    assert.ok(props.has(`IV2_MSG_${id}`), `${id} must survive the purge`);
  assert.ok(props.has('IV2_CREATE_q17-keep-created'), 'create locks are never touched');
  assert.equal(props.get('INTAKE_V2_WATERMARK'), WATERMARK, 'pending errors keep the watermark frozen (unchanged behaviour)');

  // 第 1 步:thread 带回来的旧邮件不再被处理
  assert.ok(!props.has('IV2_MSG_q17-old-in-thread'),
    'an old message brought back by its thread must not be reprocessed — this is what makes the purge safe');
  assert.ok(props.has('IV2_MSG_q17-new'), 'the new message in the same thread is processed');
  const loggedIds = rows.filter((r) => r[2] !== 'Gmail message ID').map((r) => r[2]);
  assert.deepEqual([...loggedIds], ['q17-new'], 'only the new message reaches the Messages tab — no duplicate row for the old one');

  // 第 2 步:落盘最小,Messages 行仍带完整 reason
  const stored = props.get('IV2_MSG_q17-new');
  assert.ok(stored.length <= 80, `minimal state expected, got ${stored.length} bytes: ${stored}`);
  const newRow = rows.find((r) => r[2] === 'q17-new');
  assert.match(newRow[10], /Out of scope: no Plenti browser-view link/, 'the Messages row still carries the full reason');

  // ── 第二轮:watermark 仍冻结。按 now−48h 清理的话 IN_WINDOW 会被误删 ──
  runOnce();
  assert.ok(props.has('IV2_MSG_q17-keep-in-window'),
    'with the watermark frozen, lower stays at the old value — a state still inside that window must not be purged');
  assert.equal(rows.filter((r) => r[2] === 'q17-new').length, 1, 'an already-processed message is not logged twice');

  // ── 第三轮:清掉 error,watermark 推进到现在,IN_WINDOW 滑出窗口 ──
  props.delete('IV2_MSG_q17-keep-error');
  props.delete('IV2_MSG_q17-keep-unparsable');   // 无法解析的也被当作 error、冻结 watermark
  runOnce();
  assert.notEqual(props.get('INTAKE_V2_WATERMARK'), WATERMARK, 'with no errors pending the watermark advances');
  runOnce();                                      // 新 lower = now−48h 的这一轮才会清掉它
  assert.ok(!props.has('IV2_MSG_q17-keep-in-window'), 'once the window moves past it, the state is purged');
  assert.ok(props.has('IV2_MSG_q17-new'), 'a recent state is still inside the new window');
  for (const id of ['q17-keep-created', 'q17-keep-with-link', 'q17-keep-internal'])
    assert.ok(props.has(`IV2_MSG_${id}`), `${id} is never purged, no matter how old`);
  console.log(`PASS: Q17 — window-aligned loop, minimal out-of-scope state (${stored.length} bytes), purge bounded by the same lower`);
}

props.clear();
