export const STATUSES = Object.freeze(['submitted','in_review','in_progress','resolved','rejected','reopened']);
export const ROLES = Object.freeze(['employee','manager','admin']);
const allowed = {
  submitted: {in_review:['manager','admin'],rejected:['manager','admin']},
  in_review: {in_progress:['manager','admin'],resolved:['manager','admin'],rejected:['manager','admin']},
  in_progress: {resolved:['manager','admin'],rejected:['manager','admin']},
  resolved: {reopened:['employee','manager','admin']},
  rejected: {reopened:['employee','manager','admin']},
  reopened: {in_review:['manager','admin'],in_progress:['manager','admin']}
};
export function canTransition(current,next,role,isAuthor=false) {
  if (!STATUSES.includes(current)||!STATUSES.includes(next)||!ROLES.includes(role)) return false;
  if (next==='reopened' && role==='employee' && !isAuthor) return false;
  return (allowed[current]?.[next]||[]).includes(role);
}
export function validateSubmission(input) {
  if (!input||typeof input!=='object'||Array.isArray(input)) throw new Error('Invalid payload');
  if (typeof input.title!=='string'||input.title.trim().length<5||input.title.length>160) throw new Error('Title must contain 5-160 characters');
  if (typeof input.description!=='string'||input.description.trim().length<10||input.description.length>5000) throw new Error('Description must contain 10-5000 characters');
  if (!['problem','idea'].includes(input.kind)) throw new Error('Kind must be problem or idea');
  return {title:input.title.trim(),description:input.description.trim(),kind:input.kind};
}
export function transition(item,next,actor) {
  const isAuthor=item.authorId===actor.id;
  if (!canTransition(item.status,next,actor.role,isAuthor)) throw new Error('Forbidden transition');
  return {...item,status:next,updatedAt:new Date().toISOString()};
}
