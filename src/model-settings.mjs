import { BridgeError } from './errors.mjs';
export const EFFORTS=['low','medium','high','xhigh','max'];
export const LIMITS={'azure-astra':{contextWindow:1050000,maxInputTokens:922000,maxOutputTokens:128000},'azure-opus':{contextWindow:1000000,maxOutputTokens:128000}};
export function settings(value={}) { const result={}; for(const id of Object.keys(LIMITS)){const effort=value[id]?.effort??(id==='azure-astra'?'medium':'high');if(!EFFORTS.includes(effort))throw new BridgeError('Unsupported reasoning mode',400);result[id]={effort,...LIMITS[id]};}return result; }
export function resolveEffort(body,route,prefs={}) {const effort=route.effort??body.reasoning?.effort??body.reasoning_effort??body.output_config?.effort??settings(prefs)[route.id]?.effort??route.defaultEffort??'medium';if(!EFFORTS.includes(effort))throw new BridgeError('Choose low, medium, high, xhigh, or max reasoning effort',400);return effort;}
export function outputLimit(body,route){const n=body.max_output_tokens??body.max_completion_tokens??body.max_tokens??128000;if(!Number.isInteger(n)||n<1||n>128000)throw new BridgeError('Output limit must be between 1 and 128000 tokens',400);return n;}
