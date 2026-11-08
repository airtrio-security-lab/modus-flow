import test from 'node:test';import assert from 'node:assert/strict';import {mkdtemp,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';import {createStore} from '../src/storage.js';
test('state survives restart and failed transaction is not persisted',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'modus-test-'));const file=join(dir,'state.json');
 try{const a=await createStore(file);await a.transact(s=>{s.drafts.push({id:'d1',ownerId:'e1',state:'private'})});await assert.rejects(a.transact(()=>{throw Error('abort')}));const b=await createStore(file);assert.equal(b.state.drafts.length,1);assert.equal(b.state.drafts[0].ownerId,'e1');}
 finally{await rm(dir,{recursive:true,force:true})}
});
test('concurrent commits are serialized',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'modus-test-'));const file=join(dir,'state.json');
 try{const s=await createStore(file);await Promise.all(Array.from({length:8},(_,i)=>s.transact(x=>{x.requests.push({id:String(i)})})));const loaded=await createStore(file);assert.equal(loaded.state.requests.length,8);}
 finally{await rm(dir,{recursive:true,force:true})}
});
