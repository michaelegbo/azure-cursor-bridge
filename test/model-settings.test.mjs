import test from 'node:test';import assert from 'node:assert/strict';import {settings,resolveEffort,outputLimit,EFFORTS} from '../src/model-settings.mjs';
test('Each provider accepts all supported effort modes and persists independently',()=>{for(const effort of EFFORTS){const p=settings({'azure-astra':{effort},'azure-opus':{effort:'low'}});assert.equal(resolveEffort({}, {id:'azure-astra'},p),effort);assert.equal(resolveEffort({}, {id:'azure-opus'},p),'low');}assert.throws(()=>settings({'azure-opus':{effort:'ultra'}}));});
test('Explicit client effort wins, invalid modes fail',()=>{assert.equal(resolveEffort({reasoning_effort:'max'},{id:'azure-opus'}),'max');assert.throws(()=>resolveEffort({reasoning_effort:'invalid'},{id:'azure-astra'}));});
test('Full model allowance, smaller client output limits preserved',()=>{assert.equal(settings()['azure-astra'].contextWindow,1050000);assert.equal(settings()['azure-opus'].contextWindow,1000000);assert.equal(outputLimit({},{}),128000);assert.equal(outputLimit({max_tokens:1024},{}),1024);assert.throws(()=>outputLimit({max_tokens:128001},{}));});
test('Built-in context stays fixed while TPM and output caps persist',()=>{
 const configured=settings({'azure-astra':{contextWindow:2000000,tokensPerMinute:3000000,maxOutputTokens:8192},'azure-opus':{tokensPerMinute:120000,maxOutputTokens:4096}});
 assert.equal(configured['azure-astra'].contextWindow,1050000);
 assert.equal(configured['azure-astra'].tokensPerMinute,3000000);
 assert.equal(configured['azure-opus'].tokensPerMinute,120000);
 assert.equal(settings()['azure-astra'].tokensPerMinute,2000000);
 assert.equal(outputLimit({},configured['azure-astra']),8192);
 assert.equal(outputLimit({max_output_tokens:12000},configured['azure-astra']),8192);
 assert.equal(outputLimit({max_tokens:1024},configured['azure-opus']),1024);
 assert.throws(()=>settings({'azure-astra':{tokensPerMinute:-1}}));
 assert.throws(()=>settings({'azure-astra':{maxOutputTokens:128001}}));
});
test('Azure Sol has its published context, output and deployed TPM defaults',()=>{
 const sol=settings()['azure-sol'];
 assert.equal(sol.contextWindow,1050000);
 assert.equal(sol.maxInputTokens,922000);
 assert.equal(sol.maxOutputTokens,128000);
 assert.equal(sol.tokensPerMinute,2000000);
 assert.equal(sol.effort,'medium');
});
