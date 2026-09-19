import { BridgeError } from './errors.mjs';
import { resolveEffort, outputLimit } from './model-settings.mjs';

export const MODELS = [
  { id: 'azure-astra', deployment: 'gpt-6-astra', label: 'Azure · GPT-6 Astra', protocol: 'responses' },
  { id: 'azure-opus', deployment: 'claude-opus-5', label: 'Azure · Claude Opus 5', protocol: 'anthropic' },
];
export function routeModel(id) {
  const s = String(id || '');
  // Effort-suffixed aliases (azure-astra-high, azure-opus-max, ...) let clients
  // without a reasoning selector, like Cursor, pick the effort by model name.
  const match = /^(.*)-(low|medium|high|xhigh|max)$/.exec(s);
  if (match) {
    const base = MODELS.find(m => m.id === match[1] || m.deployment === match[1]);
    if (base) return { ...base, effort: match[2] };
  }
  const route = MODELS.find(m => m.id === s || m.deployment === s);
  if (!route) throw new BridgeError(`Unknown model: ${s.slice(0,80)}. Choose azure-astra or azure-opus, optionally with an effort suffix such as azure-astra-high.`, 400);
  return route;
}
const text = v => typeof v === 'string' ? v : JSON.stringify(v ?? '');
function parts(content, assistant = false) {
  if (typeof content === 'string') return [{ type: assistant ? 'output_text' : 'input_text', text: content }];
  return (content || []).map(p => {
    if (['text','input_text','output_text'].includes(p.type)) return { type: assistant ? 'output_text' : 'input_text', text: p.text };
    if (p.type === 'image_url' || p.type === 'input_image') return { type: 'input_image', image_url: p.image_url?.url || p.image_url, ...(p.detail ? { detail:p.detail } : {}) };
    throw new BridgeError(`Unsupported content type: ${p.type}`, 400);
  });
}
export function chatToResponses(body) {
  const input = [];
  for (const m of body.messages || []) {
    if (m.role === 'tool') { input.push({ type:'function_call_output', call_id:m.tool_call_id, output:text(m.content) }); continue; }
    if (m.content?.length) input.push({ role:m.role, content:parts(m.content,m.role==='assistant') });
    for (const call of m.tool_calls || []) input.push({ type:'function_call', call_id:call.id, name:call.function.name, arguments:call.function.arguments });
  }
  const out = { input, store:false };
  if (body.tools?.length) out.tools = body.tools.map(t => {
    if(t.type !== 'function') throw new BridgeError(`Unsupported tool type: ${t.type}`,400);
    return { type:'function', ...t.function, strict:false };
  });
  if (body.tool_choice) out.tool_choice = typeof body.tool_choice === 'string' ? body.tool_choice : { type:'function', name:body.tool_choice.function.name };
  if (body.parallel_tool_calls !== undefined) out.parallel_tool_calls = body.parallel_tool_calls;
  return out;
}
export function responsesToChat(body) {
  const messages = [];
  if(body.instructions) messages.push({role:'system',content:body.instructions});
  const input = typeof body.input === 'string' ? [{role:'user',content:body.input}] : body.input || [];
  for(const item of input) {
    if(item.type==='reasoning') continue;
    if(item.type==='function_call_output') {messages.push({role:'tool',tool_call_id:item.call_id,content:text(item.output)});continue;}
    if(item.type==='function_call') {messages.push({role:'assistant',content:null,tool_calls:[{id:item.call_id,type:'function',function:{name:item.name,arguments:item.arguments}}]});continue;}
    messages.push({role:item.role||'user',content:typeof item.content==='string'?item.content:(item.content||[]).map(p=>p.type==='input_image'?{type:'image_url',image_url:{url:p.image_url}}:{type:'text',text:p.text})});
  }
  return {messages,tools:body.tools?.map(t=>({type:'function',function:{name:t.name,description:t.description,parameters:t.parameters}})),tool_choice:typeof body.tool_choice==='object'?{type:'function',function:{name:body.tool_choice.name}}:body.tool_choice,max_tokens:body.max_output_tokens};
}
export function chatToAnthropic(body) {
  const messages=[],system=[];
  const contentParts = content => {
    if(typeof content==='string') return content ? [{type:'text',text:content}] : [];
    return (content||[]).map(p=>{
      if(p.type==='text')return {type:'text',text:p.text};
      if(p.type==='image_url') {
        const url=p.image_url?.url||p.image_url;
        const match=/^data:([^;]+);base64,(.*)$/s.exec(url);
        return {type:'image',source:match?{type:'base64',media_type:match[1],data:match[2]}:{type:'url',url}};
      }
      throw new BridgeError(`Unsupported Anthropic content: ${p.type}`,400);
    });
  };
  const push=(role,content)=>{if(!content.length)return; const last=messages.at(-1);if(last?.role===role)last.content.push(...content);else messages.push({role,content});};
  for(const m of body.messages||[]) {
    if(['system','developer'].includes(m.role)){system.push(...contentParts(m.content));continue;}
    if(m.role==='tool'){push('user',[{type:'tool_result',tool_use_id:m.tool_call_id,content:text(m.content)}]);continue;}
    const content=contentParts(m.content);
    for(const call of m.tool_calls||[]) {
      let input;try{input=JSON.parse(call.function.arguments||'{}');}catch{throw new BridgeError('Invalid tool arguments JSON',400);}
      content.push({type:'tool_use',id:call.id,name:call.function.name,input});
    }
    push(m.role==='assistant'?'assistant':'user',content);
  }
  const out={messages,max_tokens:Math.min(body.max_completion_tokens||body.max_tokens||16384,32768)};
  if(system.length)out.system=system;
  if(body.tools?.length)out.tools=body.tools.map(t=>({name:t.function.name,description:t.function.description||'',input_schema:t.function.parameters||{type:'object',properties:{}}}));
  if(body.tool_choice) out.tool_choice=typeof body.tool_choice==='string'?{type:body.tool_choice==='required'?'any':body.tool_choice}:{type:'tool',name:body.tool_choice.function.name};
  return out;
}
export async function* sseEvents(stream) {
  const decoder=new TextDecoder();let buffer='';
  for await(const chunk of stream) {
    buffer+=decoder.decode(chunk,{stream:true}).replace(/\r/g,'');
    let pos;
    while((pos=buffer.indexOf('\n\n'))>=0) {
      const block=buffer.slice(0,pos);buffer=buffer.slice(pos+2);
      const data=block.split('\n').filter(l=>l.startsWith('data:')).map(l=>l.slice(5).trimStart()).join('\n');
      if(data&&data!=='[DONE]')yield JSON.parse(data);
    }
  }
}
export async function runAzure({body,protocol,route,key,endpoint,signal,sink,preferences={}}) {
  let payload=route.protocol==='responses' ? (protocol==='chat'?chatToResponses(body):{...body,store:false}) : chatToAnthropic(protocol==='chat'?body:responsesToChat(body));
  payload.model=route.deployment;payload.stream=true;
  const effort=resolveEffort(body,route,preferences);
  if(route.protocol==='anthropic'){payload.output_config={effort};payload.thinking={type:'adaptive'};payload.max_tokens=outputLimit(body,route);}
  if(route.protocol==='responses') {
    payload.max_output_tokens=outputLimit(body,route);
    payload.reasoning={effort};
    delete payload.previous_response_id;
  }
  const url=endpoint+(route.protocol==='responses'?'/openai/responses?api-version=2025-04-01-preview':'/anthropic/v1/messages');
  const upstream=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json',...(route.protocol==='responses'?{'api-key':key}:{'x-api-key':key,'anthropic-version':'2023-06-01'})},body:JSON.stringify(payload),signal});
  if(!upstream.ok){let e=await upstream.json().catch(()=>({}));throw new BridgeError(e.error?.message||`Azure HTTP ${upstream.status}`,upstream.status);}
  sink.open({model:route.id,upstreamModel:route.deployment,provider:'azure',routeMode:route.protocol,responseId:`resp_${crypto.randomUUID().replaceAll('-','')}`});
  let hasTools=false,completed=false;const blocks=new Map();
  for await(const event of sseEvents(upstream.body)) {
    if(event.type==='error'||event.type==='response.failed')throw new BridgeError(event.error?.message||event.response?.error?.message||'Azure stream failed',502);
    if(event.type==='response.output_text.delta')sink.text(event.delta);
    if(event.type==='response.output_item.done'&&event.item?.type==='function_call'){hasTools=true;sink.tool({callId:event.item.call_id,name:event.item.name,arguments:JSON.parse(event.item.arguments)});}
    if(event.type==='response.completed') {completed=true;const u=event.response.usage;sink.session.usage={inputTokens:u?.input_tokens||0,outputTokens:u?.output_tokens||0,cachedTokens:u?.input_tokens_details?.cached_tokens||0};}
    if(event.type==='response.incomplete')throw new BridgeError(`Azure response incomplete: ${event.response?.incomplete_details?.reason||'output limit'}`,502);
    if(event.type==='message_start'){const u=event.message.usage;sink.session.usage={inputTokens:(u?.input_tokens||0)+(u?.cache_read_input_tokens||0)+(u?.cache_creation_input_tokens||0),outputTokens:0,cachedTokens:u?.cache_read_input_tokens||0};}
    if(event.type==='content_block_start') {blocks.set(event.index,{...event.content_block,json:''});if(event.content_block.type==='text')sink.text(event.content_block.text);}
    if(event.type==='content_block_delta') {if(event.delta.type==='text_delta')sink.text(event.delta.text);if(event.delta.type==='input_json_delta')blocks.get(event.index).json+=event.delta.partial_json;}
    if(event.type==='content_block_stop'){const b=blocks.get(event.index);if(b?.type==='tool_use'){hasTools=true;sink.tool({callId:b.id,name:b.name,arguments:b.json?JSON.parse(b.json):b.input});}}
    if(event.type==='message_delta'){if(event.usage)sink.session.usage.outputTokens=event.usage.output_tokens;if(event.delta?.stop_reason==='max_tokens')throw new BridgeError('Azure Opus reached the output token limit',502);}
    if(event.type==='message_stop')completed=true;
  }
  if(!completed)throw new BridgeError('Azure stream ended before completion',502);
  if(hasTools)sink.completeForTool();else sink.complete();
}
