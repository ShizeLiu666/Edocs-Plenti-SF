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
for (const file of ['Code.gs', 'Plenti.gs']) {
  const hits = findReferences(legacyNames, read(SRC, file));
  assert.deepEqual(hits, [], `${file} must not reference Legacy.gs functions: ${hits.join(', ')}`);
}
console.log(`PASS: static guard — ${legacyNames.length} Legacy functions, zero references from Code.gs/Plenti.gs`);

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

const context = vm.createContext({
  console,
  PLENTI_FIXTURES: fixtures,
  PropertiesService: { getScriptProperties: () => scriptProperties },
  UrlFetchApp: { fetch: () => { throw new Error('NETWORK CALL BLOCKED IN OFFLINE TEST'); } },
  GmailApp: gmail,
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
for (const file of ['Code.gs', 'Legacy.gs', 'Plenti.gs', 'Tests.gs', 'PlentiTests.gs']) {
  new vm.Script(read(SRC, file), { filename: `src/${file}` }).runInContext(context);
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
let observedQuery = null;
gmail.search = (q) => { observedQuery = q; throw new Error('GMAIL SEARCH BLOCKED IN OFFLINE TEST'); };
assert.throws(() => context.runIntakeV2(), /GMAIL SEARCH BLOCKED/);
assert.match(observedQuery, /^list:edocs@example\.org /, 'the scan must be limited to the eDocs group');
assert.match(observedQuery, /-in:spam -in:trash/, 'spam and trash stay excluded');
assert.match(observedQuery, /after:\d+ before:\d+/, 'the watermark window is still applied');
console.log(`PASS: intake query narrowed to the eDocs group — ${observedQuery}`);
props.clear();
