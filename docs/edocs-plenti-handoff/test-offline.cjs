'use strict';
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const props = new Map();
const context = vm.createContext({
  console,
  PropertiesService: {getScriptProperties: () => ({getProperty: k => props.get(k) ?? null})},
  UrlFetchApp: {fetch: () => {throw new Error('NETWORK CALL BLOCKED IN OFFLINE TEST');}}
});
for (const file of ['Code.gs', 'Tests.gs']) {
  new vm.Script(fs.readFileSync(path.join(__dirname, file), 'utf8'), {filename: file}).runInContext(context);
}
context.runOfflineRegressionTests();
context.runIntakeV2(); // Default is disabled, without Gmail or Salesforce calls.
props.set('INTAKE_V2_ENABLED', 'true');
assert.throws(() => context.runIntakeV2(), /adaptation has not been validated/);
assert.throws(() => context.enableIntakeV2AfterValidation(), /cannot auto-enable/);
assert.throws(() => context.ivAdmin_(), /valid INTAKE_ADMIN_ID/);
assert.throws(() => context.getSalesforceClientCredentialsToken_(), /SF_LOGIN_URL/);
console.log('PASS: safe export guards; no Gmail/Salesforce connection or records changed');
