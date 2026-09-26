import { BridgeError } from './errors.mjs';
export const EFFORTS=['low','medium','high','xhigh','max'];
export const LIMITS={'azure-astra':{contextWindow:1050000,maxInputTokens:922000,maxOutputTokens:128000,tokensPerMinute:2000000},'azure-sol':{contextWindow:1050000,maxInputTokens:922000,maxOutputTokens:128000,tokensPerMinute:2000000},'azure-opus':{contextWindow:1000000,maxOutputTokens:128000,tokensPerMinute:0}};
export function settings(value={}) {
  const result={};
  for(const [id,limits] of Object.entries(LIMITS)){
    const chosen=value[id]||{};
    const effort=chosen.effort??(id==='azure-opus'?'high':'medium');
    if(!EFFORTS.includes(effort))throw new BridgeError('Unsupported reasoning mode',400);
    const contextWindow=limits.contextWindow;
    const maxOutputTokens=chosen.maxOutputTokens??limits.maxOutputTokens;
    const tokensPerMinute=chosen.tokensPerMinute??limits.tokensPerMinute;
    if(!Number.isInteger(maxOutputTokens)||maxOutputTokens<256||maxOutputTokens>limits.maxOutputTokens)
      throw new BridgeError(`${id} max output must be between 256 and ${limits.maxOutputTokens.toLocaleString()} tokens`,400);
    if(!Number.isInteger(tokensPerMinute)||(tokensPerMinute!==0&&tokensPerMinute<1000)||tokensPerMinute>100000000)
      throw new BridgeError(`${id} tokens per minute must be 0 (off) or between 1,000 and 100,000,000`,400);
    result[id]={effort,contextWindow,...(limits.maxInputTokens?{maxInputTokens:limits.maxInputTokens}:{}),maxOutputTokens,tokensPerMinute};
  }
  return result;
}
export function resolveEffort(body,route,prefs={}) {const effort=route.effort??body.reasoning?.effort??body.reasoning_effort??body.output_config?.effort??settings(prefs)[route.id]?.effort??route.defaultEffort??'medium';if(!EFFORTS.includes(effort))throw new BridgeError('Choose low, medium, high, xhigh, or max reasoning effort',400);return effort;}
export function outputLimit(body,route){const n=body.max_output_tokens??body.max_completion_tokens??body.max_tokens??route.maxOutputTokens??128000;if(!Number.isInteger(n)||n<1||n>128000)throw new BridgeError('Output limit must be between 1 and 128000 tokens',400);return Math.min(n,route.maxOutputTokens??128000);}
