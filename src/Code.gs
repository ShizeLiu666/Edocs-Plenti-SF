/**
 * Code.gs —— 基础设施工具库。
 *
 * 定位(DECISIONS D-007):本项目的主干是 src/Plenti.gs,不是本文件。
 * 本文件只保留与 Plenti 业务无关的基础设施:Salesforce REST 封装、
 * Script Properties 存取、处理状态、Gmail 标签、定时入口与两道安全开关。
 *
 * 绝大部分函数是 handoff 模板 Code.gs 的原文。本次(Phase 2)有意修改的
 * 位置全部标了 [Phase 2] 注释,逐条如下:
 *   - INTAKE_V2.version 字符串
 *   - 新增属性读取器 ivInternalDomain_ / ivGroupAddress_ / ivAttachRawEmail_
 *   - ivAttachSource_:加 ATTACH_RAW_EMAIL 开关(默认 false),改文件标题
 *   - runIntakeV2:收窄检索范围(规格 §5.7),改调 plProcess_ / plRefreshReview_
 *   - ivRefreshOutstanding_:改调 plProcess_ / plRefreshReview_
 *   - [R1] runIntakeV2:收件人白名单过滤 + 本轮统计
 *   - [R2] 新增 ivLogRun_:每轮追加一行到 Google Sheet(可选,失败不影响主流程)
 *   - [R3 临时] runIntakeV2:强制创建模式的告警与标注 —— Phase 4 后删(D-017)
 *   - [R7] 新增 ivLogMessages_:每封邮件一行写入 Sheet 的 Messages 页(可选,失败不影响主流程)
 *
 * info 模型专有的逻辑已移至 src/Legacy.gs,本文件不引用其中任何函数。
 */
function getSalesforceClientCredentialsToken_() {
  var p = PropertiesService.getScriptProperties();
  var base = p.getProperty('SF_LOGIN_URL');
  if (!base) throw new Error('Configure SF_LOGIN_URL first');
  var response = UrlFetchApp.fetch(base + '/services/oauth2/token', {
    method: 'post', payload: {grant_type: 'client_credentials', client_id: p.getProperty('SF_CLIENT_ID'), client_secret: p.getProperty('SF_CLIENT_SECRET')}, muteHttpExceptions: true
  });
  var status = response.getResponseCode(), body = JSON.parse(response.getContentText() || '{}');
  if (status !== 200 || !body.access_token || !body.instance_url) throw new Error('Salesforce token request failed (' + status + '): ' + (body.error_description || body.error || 'Unknown error'));
  return body;
}
function testSalesforceClientCredentials() {
  var token = getSalesforceClientCredentialsToken_();
  var response = UrlFetchApp.fetch(token.instance_url + '/services/data/', {method:'get', headers:{Authorization:'Bearer ' + token.access_token}, muteHttpExceptions:true});
  console.log('Salesforce read-only API connection status: ' + response.getResponseCode());
  return response.getResponseCode();
}
// [Phase 2] version 字符串更新;labels 三个标签 Plenti 路径继续复用。
var INTAKE_V2={version:'2026-09-07-plenti-phase2',labels:['SF-Lead-Created','SF-Lead-Review','SF-Lead-Updated']};
function ivAdmin_(){var id=PropertiesService.getScriptProperties().getProperty('INTAKE_ADMIN_ID');if(!/^005[A-Za-z0-9]{12}(?:[A-Za-z0-9]{3})?$/.test(id||''))throw new Error('Configure valid INTAKE_ADMIN_ID');return id;}
function ivSource_(){var email=PropertiesService.getScriptProperties().getProperty('INTAKE_MAILBOX');if(!email)throw new Error('Configure INTAKE_MAILBOX');return email;}
function ivRecordUrl_(type,id){return ivReq_.token.instance_url+'/lightning/r/'+type+'/'+id+'/view';}
// [Phase 2] 新增属性读取器。规格 §3 禁止事项 #2:环境相关值一律走
// Script Properties,不硬编码,缺失即抛错停止。
// INTERNAL_DOMAIN 取代模板 ivClassify_ 里写死的生产域名(DECISIONS TODO-1)。
function ivInternalDomain_(){var d=PropertiesService.getScriptProperties().getProperty('INTERNAL_DOMAIN');if(!d)throw new Error('Configure INTERNAL_DOMAIN');return String(d).replace(/^@/,'').trim().toLowerCase();}
// EDOCS_GROUP_ADDRESS 用于收窄 Gmail 检索范围,规格 §5.7。
function ivGroupAddress_(){var a=PropertiesService.getScriptProperties().getProperty('EDOCS_GROUP_ADDRESS');if(!a)throw new Error('Configure EDOCS_GROUP_ADDRESS');return String(a).trim().toLowerCase();}
// ATTACH_RAW_EMAIL 默认 false,规格 §5.6:Plenti 转介邮件可能含融资申请
// 资料与身份证明,无条件全量留存需业务/合规拍板(Q5),不是技术决定。
// 属性缺失即视为 false —— 这里刻意不抛错,默认关闭才是安全方向。
function ivAttachRawEmail_(){return PropertiesService.getScriptProperties().getProperty('ATTACH_RAW_EMAIL')==='true';}
function ivReq_(path,method,data){
 if(!ivReq_.token)ivReq_.token=getSalesforceClientCredentialsToken_();
 var t=ivReq_.token,opt={method:method||'get',headers:{Authorization:'Bearer '+t.access_token},muteHttpExceptions:true};
 if(data!==undefined){opt.contentType='application/json';opt.payload=JSON.stringify(data);}
 var r=UrlFetchApp.fetch(t.instance_url+'/services/data/v67.0/'+path,opt),body=r.getContentText();
 if(r.getResponseCode()>=300)throw new Error('SF '+r.getResponseCode()+' '+body.slice(0,1800));
 return body?JSON.parse(body):{};
}
function ivQuote_(s){return String(s).replace(/\\/g,'\\\\').replace(/'/g,"\\'");}
function ivQuery_(q){var d=ivReq_('query?q='+encodeURIComponent(q));if(!d.done)throw new Error('Ambiguous result exceeds query page');return d.records;}
function ivKey_(id){return 'IV2_MSG_'+id;}
function ivGet_(id){var s=PropertiesService.getScriptProperties().getProperty(ivKey_(id));return s?JSON.parse(s):null;}
function ivSave_(id,s){s.at=new Date().toISOString();PropertiesService.getScriptProperties().setProperty(ivKey_(id),JSON.stringify(s));}
function ivLabel_(th,name,add){var l=GmailApp.getUserLabelByName(name);if(!l&&add)l=GmailApp.createLabel(name);if(l){if(add)th.addLabel(l);else th.removeLabel(l);}}
function ivLeadFields_(){return 'Id,Name,Email,Phone,MobilePhone,Street,City,State,StateCode,PostalCode,Country,CountryCode,OwnerId,Status,IsConverted,ConvertedOpportunityId,ConvertedContactId,ConvertedAccountId,Lead_Category__c,Description';}
// [Phase 2] 原模板无条件上传 .eml 原件。现加 ATTACH_RAW_EMAIL 开关,
// 默认关闭:代码路径写好但不启用(规格 §5.6)。返回值表示是否实际上传。
// 文件标题由 'Info email ' 改为 'eDocs email ' —— 本项目不是 info 邮箱。
function ivAttachSource_(message,target){
 if(!ivAttachRawEmail_())return false;
 var title='eDocs email '+message.getId(),links=ivQuery_("SELECT ContentDocumentId,ContentDocument.Title FROM ContentDocumentLink WHERE LinkedEntityId='"+target.id+"'");
 if(!links.some(function(x){return x.ContentDocument.Title===title})){
 var raw=message.getRawContent();if(raw.length>12000000)throw new Error('Source email over 12 MB; manual attachment handling required');
 ivReq_('sobjects/ContentVersion','post',{Title:title,PathOnClient:title+'.eml',VersionData:Utilities.base64Encode(raw,Utilities.Charset.UTF_8),FirstPublishLocationId:target.id});
 }
 return true;
}
function ivSupplementDescription_(existing,m,body){
 var current=String(existing||''),marker='[Gmail:'+m.getId()+']';
 if(current.indexOf(marker)>=0||current.indexOf('[Intake: '+m.getId()+']')>=0)return current;
 var block=marker+' Received '+m.getDate().toISOString()+'\nFrom: '+m.getFrom()+'\nSubject: '+m.getSubject()+'\n'+String(body||'').trim();
 var result=current+(current?'\n\n':'')+block;
 if(result.length>32000)throw new Error('Lead Description capacity exceeded; original email retained, manual review required');
 return result;
}
function ivLeadLabelFlags_(states){
 var lead=states.filter(function(x){return x&&((x.record&&/^00Q/.test(x.record))||(!x.record&&(x.kind==='sales'||x.kind==='reply'||x.leadCandidate===true)));});
 var review=lead.some(function(x){return x.state==='review'||x.state==='error';});
 return {created:lead.some(function(x){return !!(x.created&&x.record);}),review:review,updated:!review&&lead.some(function(x){return !x.created&&x.record&&x.state==='done'&&x.verifiedFields&&x.verifiedFields.length>0;})};
}
function ivSyncLabels_(thread){
 var flags=ivLeadLabelFlags_(thread.getMessages().map(function(m){return ivGet_(m.getId());}));
 ivLabel_(thread,'SF-Lead-Created',flags.created);ivLabel_(thread,'SF-Lead-Review',flags.review);ivLabel_(thread,'SF-Lead-Updated',flags.updated);
}
// [R2] 每轮执行往 Google Sheet 追加一行,供长期留底与将来跟 Plenti 月度对账。
// Apps Script 的执行日志保留期短,console.log 不能当长期记录用。
//
// INTAKE_LOG_SHEET_ID 未配置 → 直接跳过,不报错:这是可选的观测手段,
// 没配不等于配置错误。
//
// 写入失败 → 记 console.log 后继续,**绝不让观测失败拖垮主流程**。到这一步
// 邮件已经处理完、状态已经落盘;此时再抛错会把整轮落成失败,进而冻结
// watermark 并触发 L-01 那条渐进劣化路径 —— 代价远大于丢一行日志。
function ivLogRun_(began,stats){
 var id=PropertiesService.getScriptProperties().getProperty('INTAKE_LOG_SHEET_ID');
 if(!id)return false;
 try{
  var sheet=SpreadsheetApp.openById(id).getSheets()[0];
  if(sheet.getLastRow()===0)sheet.appendRow(['Run at','Threads scanned','Messages processed','Leads created','Failures','Error summary','Duration (s)']);
  // 强制模式写进错误摘要列(唯一的自由文本列),不新增列 —— 几个月后翻这张表
  // 必须一眼看得出哪几轮是绕过判定写进去的。
  var summary=(stats.forced?'[PLENTI_FORCE_CREATE ENABLED] ':'')+stats.errors.join(' | ');
  sheet.appendRow([new Date(began).toISOString(),stats.threads,stats.processed,stats.created,stats.failed,summary.slice(0,2000),Math.round((Date.now()-began)/1000)]);
  return true;
 }catch(e){
  console.log('Run log could not be written to the sheet: '+String(e.message||e).slice(0,300));
  return false;
 }
}
// ============================================================
// R7 消息级日志(Messages 标签页)
// ============================================================

// Google Sheets 单个单元格上限 50,000 字符。**超长会导致整行写入失败,
// 不只是那一格**,所以留足余量截到 45,000(含 [TRUNCATED] 标记本身)。
var IV_SHEET_CELL_LIMIT=45000;
var IV_MESSAGE_LOG_SHEET='Messages';
var IV_MESSAGE_LOG_HEADER=['Processed at','Message date','Gmail message ID','Sender','Matched recipient','Subject','Final state','Parse confidence','Parsed JSON','SF Lead ID','Notes / error','Body'];

/** 截到上限并标注;返回 {text, truncatedFrom}(未截断时 truncatedFrom 为 0)。 */
function ivTruncateCell_(value){
 var text=String(value||''),marker='… [TRUNCATED]';
 if(text.length<=IV_SHEET_CELL_LIMIT)return {text:text,truncatedFrom:0};
 return {text:text.slice(0,IV_SHEET_CELL_LIMIT-marker.length)+marker,truncatedFrom:text.length};
}

/**
 * 组装 Messages 页的一行。列序见 IV_MESSAGE_LOG_HEADER。
 * detail 是 plProcess_ 填的出参(解析结果、发件人、可信与否)。
 */
function ivMessageLogRow_(message,recipient,state,detail){
 var notes=[],body=plMessageBody_(message),cell=ivTruncateCell_(body.text);
 var sender=detail.sender||'';
 if(!sender){sender=String(message.getFrom()||'')+' [From fallback: X-Original-Sender missing]';}
 if(cell.truncatedFrom)notes.push('[BODY TRUNCATED from '+cell.truncatedFrom+' chars]');
 if(body.isHtml)notes.push('[BODY IS RAW HTML: getPlainBody() was empty]');
 if(state.state==='error')notes.push(String(state.reason||''));
 else if(state.forced)notes.push('[FORCED]');
 var parsed=detail.parsed||null;
 return [
  new Date().toISOString(),
  state.date||'',
  message.getId(),
  sender,
  recipient||'',
  ivTruncateCell_(message.getSubject()).text,
  state.created?'created':state.state,
  parsed?(parsed.kind+' / '+parsed.confidence):'',
  parsed?ivTruncateCell_(JSON.stringify(parsed)).text:'{}',
  state.record||'',
  ivTruncateCell_(notes.join(' ')).text,
  cell.text
 ];
}

/**
 * 一次 setValues 批量写入,不逐行 append —— 一轮可能有多封邮件。
 *
 * Messages 页不存在就建,**显式插到最后一个位置**:ivLogRun_ 用的是
 * getSheets()[0],新页若插到最前面会让汇总日志静默写错标签页。
 *
 * 与 ivLogRun_ 相同的失败策略:未配置 → 跳过;写入失败 → 记日志继续。
 * 到这一步邮件已处理完、状态已落盘,绝不让日志问题阻断建 Lead。
 */
function ivLogMessages_(rows){
 var id=PropertiesService.getScriptProperties().getProperty('INTAKE_LOG_SHEET_ID');
 if(!id||!rows.length)return false;
 try{
  var book=SpreadsheetApp.openById(id),sheet=book.getSheetByName(IV_MESSAGE_LOG_SHEET);
  if(!sheet){sheet=book.insertSheet(IV_MESSAGE_LOG_SHEET,book.getNumSheets());}
  if(sheet.getLastRow()===0)sheet.getRange(1,1,1,IV_MESSAGE_LOG_HEADER.length).setValues([IV_MESSAGE_LOG_HEADER]);
  sheet.getRange(sheet.getLastRow()+1,1,rows.length,IV_MESSAGE_LOG_HEADER.length).setValues(rows);
  return true;
 }catch(e){
  console.log('Message log could not be written to the sheet: '+String(e.message||e).slice(0,300));
  return false;
 }
}
function runIntakeV2(){
 var p=PropertiesService.getScriptProperties();if(p.getProperty('INTAKE_V2_ENABLED')!=='true'){console.log('Intake v2 held pending validation.');return;}
 if(p.getProperty('EDOCS_ADAPTATION_VALIDATED')!=='true')throw new Error('Plenti adaptation has not been validated. Read handoff instructions.');
 var lock=LockService.getScriptLock();if(!lock.tryLock(1000)){console.log('Another intake execution is running.');return;}
 try{
 // [Phase 2] 修复模板既有的 fail-open 缺口(DECISIONS TODO-3),不是行为变更:
 // 原写法是 cut=new Date(p.getProperty('INTAKE_V2_START')) 后再 isNaN 检查。
 //   缺口一:属性未设置时 getProperty 返回 null,new Date(null) 得到
 //           1970-01-01 而不是 NaN,isNaN 检查静默通过 → 回扫全部历史邮件。
 //   缺口二:属性是非法字符串时,同一行的 cut.toISOString() 先抛 RangeError,
 //           下面那句写好的错误提示永远不可达。
 // 现在按其他必填属性的一致做法处理:缺失即抛错,不可解析即抛错,
 // 且两项校验都在任何 Date 方法调用之前完成。watermark 的校验保持原样。
 var began=Date.now(),start=p.getProperty('INTAKE_V2_START');
 if(!start)throw new Error('Configure INTAKE_V2_START');
 var cut=new Date(start);
 if(isNaN(cut.getTime()))throw new Error('Configure INTAKE_V2_START with a parsable ISO timestamp');
 var cursor=new Date(p.getProperty('INTAKE_V2_WATERMARK')||cut.toISOString());
 if(isNaN(cursor.getTime()))throw new Error('Missing valid intake start/watermark');
 ivRefreshOutstanding_(began+30000);
 var lower=Math.max(cut.getTime(),cursor.getTime()-172800000),before=Math.floor(began/1000)+1,query='list:'+ivGroupAddress_()+' after:'+Math.floor(lower/1000)+' before:'+before+' -in:spam -in:trash',offset=0,count=0,done=false;
 // [R1] 收件人白名单。故意读在 query 构造之后:EDOCS_GROUP_ADDRESS 仍是第一个
 // 被要求的属性,缺配置时的报错顺序不变。未配置即抛错停止(规格 §3 禁止 #2)——
 // 一个本意为"收窄范围"的开关,缺失时不能反而变成最宽。
 var allow=plRecipientAllowlist_();
 // [R2] 本轮统计,执行结束后追加一行到 Google Sheet。
 var stats={threads:0,skipped:0,processed:0,created:0,failed:0,errors:[],forced:plForceCreate_()},messageRows=[];
 // ⚠️ [R3 临时] 强制创建会绕过置信度判定直接写 Lead。每轮都喊一次,避免忘了关。
 // D-017,Phase 4 结束后连同 plForceCreate_ / plForcedParse_ 一起删。
 if(stats.forced){
  console.log('⚠️⚠️ PLENTI_FORCE_CREATE is ENABLED — the confidence gate is bypassed and Leads will be written. Turn this off after Phase 4 validation.');
  // 只告警不拦截:sandbox 域名形态不是本项目能担保的判据,拦错了会挡住正常验收。
  if(String(p.getProperty('SF_LOGIN_URL')||'').indexOf('.sandbox.my.salesforce.com')<0)console.log('⚠️⚠️⚠️ PLENTI_FORCE_CREATE is enabled but SF_LOGIN_URL does not look like a sandbox. Confirm the target org before continuing.');
 }
 while(Date.now()-began<220000){
 var threads=GmailApp.search(query,offset,50);if(!threads.length){done=true;break;}
 for(var i=0;i<threads.length;i++){
 stats.threads++;
 var msgs=threads[i].getMessages(),inScope=false;
 for(var j=0;j<msgs.length;j++){
  if(msgs[j].getDate().getTime()<cut.getTime())continue;
  // [R1] 不命中白名单 → 整条跳过,不写状态、不打标签、不占 Properties。
  // [R7] 这类邮件也**不写进 Messages 页** —— 共用邮箱里它们占多数,全记会把表
  // 撑爆,而且我们没有理由留存这些邮件的内容。
  var recipient=plMatchedRecipient_(msgs[j],allow);
  if(!recipient){stats.skipped++;continue;}
  inScope=true;
  plRefreshReview_(msgs[j]);
  var old=ivGet_(msgs[j].getId());
  if(!old||old.state==='error'){
   var detail={},result=plProcess_(msgs[j],false,detail);count++;stats.processed++;
   messageRows.push(ivMessageLogRow_(msgs[j],recipient,result,detail));
   if(result&&result.created&&result.record)stats.created++;
   // 摘要带上消息 ID:L-01 触发后要删的键是 IV2_CREATE_<消息 ID>,
   // Sheet 是长期留底,不带 ID 的话事后无从下手(console.log 保留期短)。
   if(result&&result.state==='error'){stats.failed++;if(stats.errors.length<5)stats.errors.push(msgs[j].getId()+': '+String(result.reason||'').slice(0,200));}
  }
 }
 // [R1] 整条 thread 都不在范围内就不同步标签 —— 共用邮箱里这类 thread 占多数,
 // 每条省下 3 次 Gmail API 调用。代价:若日后把某地址移出白名单,那些 thread
 // 的旧标签不会被自动清除,需人工处理。
 if(inScope)ivSyncLabels_(threads[i]);
 if(Date.now()-began>=220000)break;}
 if(i<threads.length)break;offset+=threads.length;if(threads.length<50){done=true;break;}}
 var all=p.getProperties(),errors=Object.keys(all).some(function(k){if(k.indexOf('IV2_MSG_')!==0)return false;try{return JSON.parse(all[k]).state==='error'}catch(e){return true}});
 if(done&&!errors)p.setProperty('INTAKE_V2_WATERMARK',new Date(began).toISOString());
 console.log(JSON.stringify({reviewed:count,skippedOutOfScope:stats.skipped,threads:stats.threads,created:stats.created,failed:stats.failed,forceCreate:stats.forced,scanComplete:done,errorsPending:errors,watermark:p.getProperty('INTAKE_V2_WATERMARK')}));
 ivLogRun_(began,stats);
 ivLogMessages_(messageRows);
 }finally{lock.releaseLock();}
}
function runSalesforceLeadIntake(){return runIntakeV2();}
function enableIntakeV2AfterValidation(){
 throw new Error('Share package cannot auto-enable. Complete PLENTI_ADAPTATION.md and explicitly configure properties and trigger in the new project.');
}
function ivRefreshOutstanding_(deadline){
 var p=PropertiesService.getScriptProperties(),all=p.getProperties(),keys=Object.keys(all).filter(function(k){if(k.indexOf('IV2_MSG_')!==0)return false;try{var s=JSON.parse(all[k]);return s.state==='error'||(s.state==='review'&&s.record&&/^00Q/.test(s.record)&&!(s.conflicts||[]).length)}catch(e){return false}}).sort();
 if(!keys.length){p.deleteProperty('IV2_REVIEW_CURSOR');return;}
 var start=Number(p.getProperty('IV2_REVIEW_CURSOR')||0)%keys.length,n=0;
 while(n<Math.min(keys.length,10)&&Date.now()<deadline){var key=keys[(start+n)%keys.length],id=key.slice(8);n++;try{var m=GmailApp.getMessageById(id);if(!m)continue;var s=ivGet_(id);if(s.state==='error')plProcess_(m,false);else plRefreshReview_(m);ivSyncLabels_(m.getThread());}catch(e){console.log('Outstanding intake item '+id+' needs review: '+String(e.message||e).slice(0,180));}}
 p.setProperty('IV2_REVIEW_CURSOR',String((start+n)%keys.length));
}
