import {mkdir,readFile,writeFile,rename,open,unlink} from 'node:fs/promises';
import {dirname,resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
const empty=()=>({version:1,requests:[],contributions:[],drafts:[]});
export async function createStore(path){
 const file=resolve(path);let state;
 try{state=JSON.parse(await readFile(file,'utf8'))}catch(error){if(error.code!=='ENOENT')throw error;state=empty()}
 if(state.version!==1||!['requests','contributions','drafts'].every(k=>Array.isArray(state[k])))throw Error('Invalid state format');
 let queue=Promise.resolve();
 const store={get state(){return state},transact(change){
   const task=queue.then(async()=>{
     const next=structuredClone(state);
     const result=change(next);
     if(next.version!==1)throw Error('Invalid version');
     await mkdir(dirname(file),{recursive:true,mode:0o700});
     const temp=file+'.'+randomUUID()+'.tmp';
     try{
       const handle=await open(temp,'wx',0o600);
       try{await handle.writeFile(JSON.stringify(next));await handle.sync()}finally{await handle.close()}
       await rename(temp,file);
       const dir=await open(dirname(file),'r');try{await dir.sync()}finally{await dir.close()}
     }catch(e){await unlink(temp).catch(()=>{});throw e}
     state=next;return result;
   });
   queue=task.catch(()=>{});
   return task;
 }};
 return store;
}
