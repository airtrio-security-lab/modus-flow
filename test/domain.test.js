import test from 'node:test';import assert from 'node:assert/strict';import {validateSubmission,canTransition,transition} from '../src/domain.js';
test('valid submission is normalized',()=>assert.deepEqual(validateSubmission({title:'  Новая идея  ',description:'  Улучшим процесс работы  ',kind:'idea'}),{title:'Новая идея',description:'Улучшим процесс работы',kind:'idea'}));
test('invalid kind rejected',()=>assert.throws(()=>validateSubmission({title:'Новая идея',description:'Описание достаточно длинное',kind:'secret'})));
test('employee cannot resolve',()=>assert.equal(canTransition('submitted','resolved','employee',true),false));
test('employee cannot reopen another author case',()=>assert.equal(canTransition('resolved','reopened','employee',false),false));
test('author may reopen resolved case',()=>assert.equal(canTransition('resolved','reopened','employee',true),true));
test('manager may progress case',()=>assert.equal(canTransition('submitted','in_review','manager'),true));
test('status cannot jump from resolved to submitted',()=>assert.equal(canTransition('resolved','submitted','admin'),false));
test('transition rejects unauthorized actor',()=>assert.throws(()=>transition({authorId:'a',status:'submitted'},'in_review',{id:'a',role:'employee'})));
