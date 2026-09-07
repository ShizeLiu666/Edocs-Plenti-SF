/**
 * Legacy.gs —— info 模型专有逻辑,不在 Plenti 路径中调用,保留供参考。
 *
 * 本文件中的函数全部是 handoff 模板 Code.gs 的**原文**(逐行抽取,未改一字),
 * 保留它们是为了不丢失踩坑信息;隔离它们是为了消除误触发风险。
 *
 *   - src/Code.gs 与 src/Plenti.gs 中**不得出现**本文件定义的任何函数名。
 *     这条约束由 test/offline.cjs 的静态守卫强制检查,不靠人自觉 ——
 *     Apps Script 是单一全局作用域,没有守卫很容易误调。
 *   - 这些函数仍可在 Apps Script 编辑器中手动调用(排查历史行为用),
 *     但主流程 plProcess_ 一次也不引用它们。
 *   - src/Tests.gs 继续测试其中的 ivClassify_ / ivExtract_。它跑绿就等于
 *     证明本文件是原文未被改动。
 *
 * 为什么每个函数在这里(详见 docs/DECISIONS.md D-008 三分类表):
 *   extractSender_       发件人=客户,规格 §5.2 最危险的一处
 *   ivTop_               在 From/引用边界截断,会截掉 Plenti 表单资料
 *                        (PLENTI_ADAPTATION.md 第 2 条)
 *   ivClassify_          后半段是 purchase/product/fault 购买意图猜测,
 *                        规格 §2 明确不继承。函数不可拆,整体保留。
 *                        L60 那两处"擦除"补丁(no issues with... /
 *                        website ... didn't work)是防误判的踩坑补丁,
 *                        唯一消费者是同函数内的 fault 正则,随函数留在这里
 *                        (DECISIONS D-008 疑问 ①)
 *   ivContactMatch_      老客户 Account/CRN 匹配,阻塞于 Q7
 *   ivResolve_           reply / Opportunity 分支
 *   ivExtract_           从自由文本猜电话地址;Plenti 是结构化字段。
 *                        Phase 3 写字段归一化时从这里借正则
 *   ivCreateCandidate_   Account 文案 + 老客户 Completed Task 分支
 *   ivTarget_            已转换 Lead → Opportunity,规格 §5.10 明确禁止
 *   ivRecordReply_       回复补录;触发方式依赖 In-Reply-To,
 *                        Plenti 的更新路径阻塞于 Q6(referral ID 存哪)
 *   ivProcess_           已由 Plenti.gs 的 plProcess_ 取代
 *   ivRefreshReview_     依赖 Lead_Category__c 作为审核信号,
 *                        Plenti 不复用该字段(DECISIONS D-011 / Q9)
 */
function extractSender_(message) {
  var from=String(message.getFrom()||'');
  var match=from.match(/<([^>]+)>/)||from.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
  var email=match?(match[1]||match[0]).trim().toLowerCase():'';
  var name=from.replace(/<[^>]+>/,'').replace(/["']/g,'').trim();
  return {email:email,name:name||(email?email.split('@')[0]:'Email Enquiry')};
}
function ivTop_(text){return String(text||'').replace(/\r/g,'').split(/\n\s*(?:From:|On .{0,200}wrote:|Begin forwarded message:|[-_]{5,}|>)/i)[0].trim();}
function ivClassify_(subject,plain,from){
 var top=ivTop_(plain),text=top.replace(/\s+/g,' ').toLowerCase(),sub=String(subject||'').toLowerCase();
 if(!from||/@sunterra\.com\.au$/i.test(from))return {kind:'internal',top:top};
 if(/(?:^|\.)(?:salesforce\.com|sfcustomeremail\.com)$/i.test(String(from).split('@').pop())&&/(?:a lead has been assigned|please follow up your unconverted lead)/i.test(sub))return {kind:'ignore',reason:'Salesforce automatic lead notification',top:top};
 if(/(?:salesforce could not create this lead)/i.test(sub))return {kind:'review',reason:'Web-to-Lead failure requires administrator review',top:top};
 if(/(?:\b(?:recruitment|hiring) (?:team|manager)\b|\b(?:job application|applying for|trade assistant|cover letter|resume attached)\b)/i.test(sub+' '+text))return {kind:'review',reason:'Employment enquiry - not a sales Lead',top:top};
 if(/\btest\d*\b/i.test(sub))return {kind:'review',reason:'Possible test email',top:top};
 var pitch=/\b(?:we|our company|[a-z ]+ energia)\s+(?:are |is )?(?:offering|offer|provide|supply|selling)\b/.test(text)||/(?:opportunities (?:are )?(?:offered|for)|for (?:investors|developers)|land .*option agreements|we can (?:help|improve|boost)|seo services|marketing services|guest post)/.test(text);
 if(pitch)return {kind:'promotion',reason:'Sender offering products, investment or services to Sunterra',top:top};
 if(/(?:mailer-daemon|postmaster|no-?reply)/i.test(from)||/(?:delivery status notification|out of office|automatic reply)/.test(sub))return {kind:'ignore',reason:'Automatic message',top:top};
 if(/(?:new voice message|voicemail)/.test(sub))return {kind:'review',reason:'Voice recording needs review',top:top};
 var clean=text.replace(/\bno\s+(?:issues?|problems?|faults?)(?:\s+with)?/g,' ').replace(/(?:website|button|form)[^.]{0,70}(?:not work|didn.t work|failed)/g,' ');
 var purchase=/(?:\b(?:i|we)(?:'m| am| are|'re)?\s+(?:enquir\w*|inquir\w*|looking|interested|want|need|would like)|\b(?:can|could) you\b.{0,70}(?:quote|install|supply|upgrade)|\b(?:please|request|requesting)\b.{0,35}(?:quote|quotation)|\bupgrade (?:my|our|the existing)|\bincrease battery capacity)/.test(text);
 purchase=purchase||/(?:^|\n)\s*(?:looking\s+for|seeking|after|need|want)\s+(?:(?:a|some)\s+)?(?:quotes?|quotations?|pricing|prices?)\b/i.test(top);
 purchase=purchase||/\b(?:can|could|would) you\b.{0,60}\b(?:cost|price|pricing|options|quotation)\b/.test(text)||/\b(?:want|interested|considering|looking|options)\b.{0,90}\b(?:add(?:ing)?|upgrad(?:e|ing)|expand(?:ing)?|install(?:ing)?)\b.{0,45}\b(?:battery|batteries|solar|panels|storage)\b/.test(text);
 var product=/\b(?:solar|battery|batteries|inverter|ev charger|charging|off.grid|panels)\b/.test(text+' '+sub);
 var fault=/(?:\b(?:inverter|battery|system|solar)\b.{0,45}(?:not working|failed|fault|offline|broken)|\b(?:repair|warranty claim|complaint|roof leak)\b)/.test(clean);
 if(purchase&&product&&fault)return {kind:'review',reason:'Both new purchase and service issue',top:top};
 if(purchase&&product)return {kind:'sales',reason:'Customer requests purchase, installation or upgrade',top:top};
 if(fault)return {kind:'service',reason:'Fault, repair or complaint',top:top};
 if(/^\s*(?:re|aw):/i.test(subject||''))return {kind:'reply',reason:'Reply requiring record association',top:top};
 if(/(?:newsletter|unsubscribe|invoice|statement|purchase order)/i.test(sub+' '+text)&&!purchase)return {kind:'ignore',reason:'Non-sales administrative or newsletter mail',top:top};
 if(product&&/\b(?:quote|quotation|pricing|cost options|battery add.on|battery upgrade)\b/.test(sub+' '+text)&&!/(?:invoice|payment|warranty|repair|installation date|installation schedule|reschedule)/.test(text))return {kind:'review',leadCandidate:true,reason:'Possible sales enquiry requires review',top:top};
 return {kind:'review',reason:'Insufficient evidence to classify',top:top};
}
function ivContactMatch_(email){
 var verified=PropertiesService.getScriptProperties().getProperty('IV2_VERIFIED_ACCOUNT_'+email);
 if(verified){var va=ivQuery_("SELECT Id,Name,PersonContactId,Customer_Reference_Number__c FROM Account WHERE Id='"+verified+"'")[0];if(va)return {account:va,contacts:[],ambiguous:false};}
 var e=ivQuote_(email),accounts=ivQuery_("SELECT Id,Name,PersonContactId,Customer_Reference_Number__c FROM Account WHERE PersonEmail='"+e+"' OR Account_Email__c='"+e+"'"),contacts=ivQuery_("SELECT Id,Name,AccountId FROM Contact WHERE Email='"+e+"'");
 var ids={};accounts.forEach(function(a){ids[a.Id]=true});contacts.forEach(function(c){if(c.AccountId)ids[c.AccountId]=true});
 var all=Object.keys(ids);if(all.length!==1)return {account:null,ambiguous:all.length>1};
 var a=accounts.filter(function(x){return x.Id===all[0]})[0]||ivQuery_("SELECT Id,Name,PersonContactId,Customer_Reference_Number__c FROM Account WHERE Id='"+all[0]+"'")[0];
 return {account:a,contacts:contacts.filter(function(c){return c.AccountId===a.Id}),ambiguous:false};
}
function ivResolve_(message,sender,classification){
 var e=ivQuote_(sender.email),leads=ivQuery_("SELECT "+ivLeadFields_()+" FROM Lead WHERE Email='"+e+"'"),open=leads.filter(function(l){return !l.IsConverted&&l.Status!=='Unqualified'});
 var source=leads.filter(function(l){return String(l.Description||'').indexOf('[Intake: '+message.getId()+']')>=0});if(source.length===1)return {lead:source[0],created:true};
 var parent=message.getHeader('In-Reply-To')||'',refs=message.getHeader('References')||'';
 var ids=(refs+' '+parent).match(/<[^>]+>/g)||[];
 for(var i=ids.length-1;i>=0;i--){var k='IV2_REF_'+Utilities.base64EncodeWebSafe(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256,ids[i])).slice(0,40);var rid=PropertiesService.getScriptProperties().getProperty(k);var linked=leads.filter(function(l){return l.Id===rid});if(linked.length===1&&classification.kind==='reply')return {lead:linked[0]};}
 if(classification.kind==='reply'){
  if(open.length===1)return {lead:open[0]};
  if(open.length>1)return {review:'Multiple active Leads for sender'};
  var converted=leads.filter(function(l){return l.IsConverted&&l.ConvertedOpportunityId});if(converted.length===1)return {lead:converted[0]};
  var match=ivContactMatch_(sender.email);
  if(match.account){var opps=ivQuery_("SELECT Id,Name,OwnerId,AccountId FROM Opportunity WHERE AccountId='"+match.account.Id+"' AND IsClosed=false");if(opps.length===1)return {opportunity:opps[0],contact:match.contacts.length===1?match.contacts[0].Id:match.account.PersonContactId};}
  return {review:'Reply has no unique active record match'};
 }
 if(open.length)return {review:'Existing active enquiry: confirm same request versus a new project'};
 var match=ivContactMatch_(sender.email);if(match.ambiguous)return {review:'Multiple matching customer Accounts'};
 return {account:match.account};
}
function ivExtract_(top){
 var text=top.replace(/\r/g,''),flat=text.replace(/[^\S\n]+/g,' '),p=flat.match(/(?:\+61|0)[2-478](?:[ -]?\d){8}\b/),fields={};
 if(p)fields.Phone=p[0].replace(/[ -]/g,'');
 var a=flat.match(/(?:\baddress\s*(?:is|:)\s*)?(\d+[a-z]?(?:\/\d+)?\s+[a-z][a-z '\-]{0,65}?\s(?:street|st|road|rd|crescent|cres|avenue|ave|drive|dr|way|court|ct|terrace|tce|lane|ln))\s*,?\s+([a-z][a-z '\-]{1,45}?)(?=\.|,|\s+(?:nsw|wa|sa|vic|qld|tas|act|nt)\b|\n|$)/i);
 if(a){fields.Street=a[1].trim();fields.City=a[2].trim();var tail=flat.slice(a.index+a[0].length);var s=tail.match(/^\s*,?\s*(NSW|WA|SA|VIC|QLD|TAS|ACT|NT)\b\s*(\d{4})?/i);if(s){fields.StateCode=s[1].toUpperCase();fields.CountryCode='AU';if(s[2])fields.PostalCode=s[2];}}
 return fields;
}
function ivCreateCandidate_(m,sender,c,match){
 var id=m.getId(),marker='[Intake: '+id+']',p=PropertiesService.getScriptProperties();
 var existing=ivQuery_("SELECT "+ivLeadFields_()+" FROM Lead WHERE Email='"+ivQuote_(sender.email)+"'").filter(function(l){return String(l.Description||'').indexOf(marker)>=0;});
 if(existing.length===1)return existing[0];if(existing.length>1)throw new Error('Multiple source-matched Leads require review');
 if(p.getProperty('IV2_CREATE_'+id))throw new Error('Earlier create outcome is uncertain; check Salesforce before retrying creation');
 var accountText=match.account?'Existing customer: '+match.account.Name+' | '+match.account.Customer_Reference_Number__c+'\nAccount: '+ivRecordUrl_('Account',match.account.Id)+'\nConversion: select this EXISTING Account; do not create another Account.\n':'';
 var payload={LastName:sender.name.slice(0,80),Email:sender.email,Company:'Individual / Residential',Status:'New',OwnerId:ivAdmin_(),LeadSource:'Other',Lead_Category__c:'Other',Contact_Attempt_Count__c:0,Description:(marker+'\nEMAIL SALES ENQUIRY - PENDING ADMIN REVIEW\nSource: '+ivSource_()+'\nSubject: '+m.getSubject()+'\n'+accountText+'\n'+c.top).slice(0,32000)};
 var extracted=ivExtract_(c.top);Object.keys(extracted).forEach(function(k){payload[k]=extracted[k]});
 p.setProperty('IV2_CREATE_'+id,JSON.stringify({state:'requested',at:new Date().toISOString()}));
 var result=ivReq_('sobjects/Lead','post',payload);
 p.setProperty('IV2_CREATE_'+id,JSON.stringify({state:'created',id:result.id,at:new Date().toISOString()}));
 if(match.account){p.setProperty('IV2_ACCOUNT_'+result.id,match.account.Id);var sub='Repeat business enquiry '+result.id;if(!ivQuery_("SELECT Id FROM Task WHERE Subject='"+sub+"'").length)ivReq_('sobjects/Task','post',{WhatId:match.account.Id,OwnerId:ivAdmin_(),Status:'Completed',Subject:sub,Description:'Confirmed/matched existing customer enquiry received from '+sender.email+'.\nLead: '+ivRecordUrl_('Lead',result.id)+'\nReuse this Account on Lead conversion. Original customer and jobs retained.'});}
 return ivQuery_("SELECT "+ivLeadFields_()+" FROM Lead WHERE Id='"+result.id+"'")[0];
}
function ivTarget_(resolved){
 if(resolved.opportunity)return {id:resolved.opportunity.Id,what:resolved.opportunity.Id,who:resolved.contact,owner:resolved.opportunity.OwnerId};
 var l=resolved.lead;if(l.IsConverted){if(!l.ConvertedOpportunityId)throw new Error('Converted Lead has no Opportunity to receive reply');var o=ivQuery_("SELECT Id,OwnerId FROM Opportunity WHERE Id='"+l.ConvertedOpportunityId+"'")[0];return {id:o.Id,what:o.Id,who:l.ConvertedContactId,owner:o.OwnerId};}
 return {id:l.Id,who:l.Id,owner:l.OwnerId,lead:l};
}
function ivRecordReply_(m,c,target){
 ivAttachSource_(m,target);
 var conflict=[];
 if(target.lead){
 var extracted=ivExtract_(c.top),patch={};
 Object.keys(extracted).forEach(function(k){if(!target.lead[k])patch[k]=extracted[k];else if(String(target.lead[k]).replace(/[^a-z0-9]/gi,'').toLowerCase()!==String(extracted[k]).replace(/[^a-z0-9]/gi,'').toLowerCase())conflict.push(k);});
 if(conflict.indexOf('CountryCode')>=0||conflict.indexOf('StateCode')>=0){['Street','City','StateCode','CountryCode','PostalCode'].forEach(function(k){delete patch[k]});}
 var description=ivSupplementDescription_(target.lead.Description,m,c.top);
 if(description!==String(target.lead.Description||''))patch.Description=description;
 if(Object.keys(patch).length)ivReq_('sobjects/Lead/'+target.id,'patch',patch);
 var check=ivQuery_("SELECT "+ivLeadFields_()+" FROM Lead WHERE Id='"+ivQuote_(target.id)+"'");if(check.length!==1)throw new Error('Lead read-back failed');
 target.verifiedFields=Object.keys(extracted).filter(function(k){return conflict.indexOf(k)<0&&String(check[0][k]||'').replace(/[^a-z0-9]/gi,'').toLowerCase()===String(extracted[k]).replace(/[^a-z0-9]/gi,'').toLowerCase();});
 if(String(check[0].Description||'')!==description)throw new Error('Lead Description verification failed');target.verifiedFields.push('Description');
 if(Object.keys(patch).some(function(k){return target.verifiedFields.indexOf(k)<0;}))throw new Error('Lead field update verification failed');
 }
 var ref=m.getHeader('Message-ID');if(ref&&target.lead){var key='IV2_REF_'+Utilities.base64EncodeWebSafe(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256,ref)).slice(0,40);PropertiesService.getScriptProperties().setProperty(key,target.lead.Id);}
 return conflict;
}
function ivProcess_(message,force){
 var id=message.getId(),prior=ivGet_(id);if(prior&&!force&&prior.state!=='error')return prior;
 var sender=extractSender_(message),c=ivClassify_(message.getSubject(),message.getPlainBody(),sender.email),state={state:'done',kind:c.kind,leadCandidate:!!c.leadCandidate,reason:c.reason||'',date:message.getDate().toISOString()},th=message.getThread();
 try{
 if(['internal','ignore','promotion'].indexOf(c.kind)>=0){ivSave_(id,state);return state;}
 if(c.kind==='service'||c.kind==='review'){state.state='review';ivSave_(id,state);return state;}
 var resolved=ivResolve_(message,sender,c);
 if(resolved.review){state.state='review';state.reason=resolved.review;ivSave_(id,state);return state;}
 if(!resolved.lead&&!resolved.opportunity){resolved.lead=ivCreateCandidate_(message,sender,c,resolved);resolved.created=true;}
 var target=ivTarget_(resolved);state.record=target.id;state.created=!!resolved.created;
 ivSave_(id,{state:'error',record:target.id,created:state.created,reason:'Processing in progress',date:state.date});
 var conflicts=ivRecordReply_(message,c,target);state.conflicts=conflicts;state.verifiedFields=target.verifiedFields||[];
 if(resolved.created||(target.lead&&target.lead.Lead_Category__c==='Other')||conflicts.length){state.state='review';state.reason=conflicts.length?'Conflicting fields: '+conflicts.join(', '):'New Lead awaiting administrator approval';}
 ivSave_(id,state);return state;
 }catch(e){state.state='error';state.reason=String(e.message||e).slice(0,1800);ivSave_(id,state);console.log('Intake error '+id+': '+state.reason);return state;}
}
function ivRefreshReview_(m){
 var state=ivGet_(m.getId());if(!state||state.state!=='review'||!state.record||!/^00Q/.test(state.record))return;
 var l=ivQuery_("SELECT Id,Lead_Category__c,Status,IsConverted FROM Lead WHERE Id='"+state.record+"'")[0];if(l&&(l.Lead_Category__c==='New Sales Enquiry'||l.Status==='Unqualified'||l.IsConverted)&&!(state.conflicts||[]).length){state.state='done';state.reason='Administrator reviewed Lead category/status';ivSave_(m.getId(),state);}
}
