import test from 'node:test';
import assert from 'node:assert/strict';
import {chatToResponses,chatToAnthropic,normalizeResponsesCallIds,routeModel,runAzure,sseEvents} from '../src/azure-adapter.mjs';
const body={messages:[{role:'system',content:'Instruction'},{role:'user',content:'Check'},{role:'assistant',content:null,tool_calls:[{id:'call_1',type:'function',function:{name:'read_file',arguments:'{"path":"test.txt"}'}}]},{role:'tool',tool_call_id:'call_1',content:'file contents'}],tools:[{type:'function',function:{name:'read_file',parameters:{type:'object',properties:{path:{type:'string'}}}}}]};
test('Responses preserves assistant tool calls and matching outputs',()=>{const r=chatToResponses(body);assert.equal(r.input[2].call_id,'call_1');assert.equal(r.input[3].call_id,'call_1');assert.equal(r.input[3].output,'file contents');assert.equal(r.input[0].role,'system');assert.equal(r.tools[0].name,'read_file');});
test('Responses shortens long Cursor call IDs without breaking tool result linkage',()=>{
  const longId='call_'+ 'x'.repeat(81);
  const input=Array.from({length:212},(_,i)=>({role:'user',content:`message ${i}`}));
  input.push({type:'function_call',call_id:longId,name:'read_file',arguments:'{}'});
  input.push({type:'function_call_output',call_id:longId,output:'file contents'});
  const converted=normalizeResponsesCallIds(input);
  assert.equal(input[212].call_id,longId);
  assert.equal(converted[212].call_id,converted[213].call_id);
  assert.equal(converted[212].call_id.length,64);
  assert.equal(normalizeResponsesCallIds(input)[212].call_id,converted[212].call_id);
  assert.equal(normalizeResponsesCallIds([{type:'function_call',call_id:'call_1'}])[0].call_id,'call_1');
  assert.notEqual(normalizeResponsesCallIds([{type:'function_call',call_id:longId+'y'}])[0].call_id,converted[212].call_id);
});
test('Azure request receives normalized IDs for both Responses and chat clients',async()=>{
  const longId='call_'+ 'x'.repeat(81);
  const input=[{type:'function_call',call_id:longId,name:'read_file',arguments:'{}'},{type:'function_call_output',call_id:longId,output:'ok'}];
  const requests=[];
  const originalFetch=globalThis.fetch;
  globalThis.fetch=async(_url,options)=>{
    requests.push(JSON.parse(options.body));
    return new Response('data: {"type":"response.completed","response":{"usage":{}}}\n\n',{status:200});
  };
  const sink={open(session){this.session=session;},complete(){},completeForTool(){},text(){},tool(){}};
  try {
    const route=routeModel('azure-astra');
    await runAzure({body:{model:'azure-astra',input},protocol:'responses',route,key:'test',endpoint:'https://example.test',sink});
    await runAzure({body:{model:'azure-astra',messages:[{role:'assistant',tool_calls:[{id:longId,function:{name:'read_file',arguments:'{}'}}]},{role:'tool',tool_call_id:longId,content:'ok'}]},protocol:'chat',route,key:'test',endpoint:'https://example.test',sink});
  } finally { globalThis.fetch=originalFetch; }
  assert.equal(requests.length,2);
  for(const request of requests){
    const calls=request.input.filter(item=>item.type==='function_call'||item.type==='function_call_output');
    assert.equal(calls.length,2);
    assert.equal(calls[0].call_id,calls[1].call_id);
    assert.ok(calls[0].call_id.length<=64);
  }
  assert.equal(requests[0].input[0].call_id,requests[1].input[0].call_id);
});
test('Anthropic preserves tool call arguments and result linkage',()=>{const r=chatToAnthropic(body);assert.equal(r.system[0].text,'Instruction');assert.deepEqual(r.messages[1].content[0].input,{path:'test.txt'});assert.equal(r.messages[2].content[0].tool_use_id,'call_1');});
test('route selection fails closed and never falls back to a different model',()=>{assert.equal(routeModel('azure-opus').deployment,'claude-opus-5');assert.equal(routeModel('azure-astra').deployment,'gpt-6-astra');assert.equal(routeModel('azure-sol').deployment,'gpt-6-sol');assert.equal(routeModel('azure-sol-max').effort,'max');assert.throws(()=>routeModel('gpt-4.1'));});
test('SSE parser handles split UTF8 and frame boundaries',async()=>{const b=new TextEncoder().encode('event: test\ndata: {"text":"héllo"}\n\ndata: [DONE]\n\n');async function* chunks(){for(let i=0;i<b.length;i++)yield b.slice(i,i+1);}const rows=[];for await(const x of sseEvents(chunks()))rows.push(x);assert.deepEqual(rows,[{text:'héllo'}]);});
