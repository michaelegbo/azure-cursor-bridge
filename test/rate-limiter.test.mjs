import test from 'node:test';
import assert from 'node:assert/strict';
import { createRateLimiter } from '../src/rate-limiter.mjs';

test('TPM budget limits requests per deployment and refills over time',()=>{
 let now=0;
 const limiter=createRateLimiter(()=>now);
 limiter.take('astra',2000,1500);
 assert.throws(()=>limiter.take('astra',2000,600),{status:429});
 limiter.take('opus',2000,1500);
 now+=30000;
 limiter.take('astra',2000,600);
 assert.throws(()=>limiter.take('astra',2000,2001),{status:429});
 limiter.take('astra',0,1000000);
});
