import {randomUUID} from 'node:crypto';
const lead=a=>['manager','admin'].includes(a?.role);
const valid=s=>{if(typeof s!=='string'||!s.trim()||s.length>3000)throw Error('Invalid review text');return s.trim()};
export function addReview(item,actor,input){
 if(!input||!['comment','request_changes','positive','negative'].includes(input.kind))throw Error('Invalid review kind');
 if(input.kind==='request_changes'&&!lead(actor))throw Error('Forbidden');
 if(['positive','negative'].includes(input.kind)&&item.status!=='in_progress')throw Error('Pilot feedback requires in_progress');
 if(['resolved','rejected'].includes(item.status))throw Error('Review closed');
 const now=new Date().toISOString(),r={id:randomUUID(),authorId:actor.id,kind:input.kind,text:valid(input.text),createdAt:now,resolved:false};
 return {...item,updatedAt:now,reviews:[...(item.reviews||[]),r],history:[...item.history,{at:now,actorId:actor.id,event:'review',reviewId:r.id,kind:r.kind}]};
}
export function resolveReview(item,actor,id){
 if(!lead(actor))throw Error('Forbidden');
 const r=(item.reviews||[]).find(x=>x.id===id);if(!r||r.kind!=='request_changes')throw Error('Review not found');
 if(r.resolved)throw Error('Already resolved');
 const now=new Date().toISOString();
 return {...item,updatedAt:now,reviews:item.reviews.map(x=>x.id===id?{...x,resolved:true,resolvedBy:actor.id,resolvedAt:now}:x),history:[...item.history,{at:now,actorId:actor.id,event:'review_resolved',reviewId:id}]};
}
export function assertDecision(item,next,actor){
 if(next==='resolved'&&lead(actor)&&(item.reviews||[]).some(x=>x.kind==='request_changes'&&!x.resolved))throw Error('Unresolved requested changes');
}
