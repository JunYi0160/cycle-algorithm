import test from 'node:test';
import assert from 'node:assert/strict';
import {CONFIG,Controller,shape,envelope,emptyControllerState} from '../src/strategy.js';

const move=(c,x)=>{const target=c.observeMonthEnd(x);c.activatePendingTarget();return target;};

test('20% -> 76.5% -> 50% -> 76.5% enters the interior and retains non-extreme path memory',()=>{
  const c=new Controller();move(c,.2);
  const first=move(c,.765);
  assert.ok(first>1+.75*envelope(.765)[0]+.001);
  move(c,.5);assert.equal(c.state.pivot_x,.765);
  const returned=move(c,.765);assert.equal(c.state.pivot_x,.5);
  assert.ok(Math.abs(returned-first)>.0001);
});

test('a stationary 40%-60% loop closes and has positive signed area without visiting extremes',()=>{
  const b=.4,a=.6,A=shape((a-b)/(1-b)),B=shape((a-b)/a),z=B/(A+B-A*B);
  const c=new Controller(CONFIG,{...emptyControllerState(),initialized:true,entered:true,z,
    previous_x:b,pivot_x:b,pivot_z:z,current_target:1+.75*z});
  const rows=[[b,c.state.current_target]];
  for(const [left,right] of [[b,a],[a,b]])for(let i=1;i<=400;i++){
    const x=left+(right-left)*i/400;rows.push([x,move(c,x)]);
  }
  assert.ok(Math.abs(c.state.z-z)<1e-12);
  const area=rows.slice(1).reduce((s,[x,l],i)=>s+(x-rows[i][0])*(l+rows[i][1])/2,0);
  assert.ok(area>0);
  assert.ok(rows.every(([x,l])=>x>0&&x<1&&l>=1&&l<=1.75));
});

test('2,000 reversals stay in the envelope and reach the exact endpoint targets',()=>{
  const c=new Controller();move(c,.2);
  for(let i=0;i<2000;i++){
    const x=((37*i)%101)/100,l=move(c,x),[lo,hi]=envelope(x);
    assert.ok(l>=1+.75*lo-1e-12&&l<=1+.75*hi+1e-12);
    if(x===0)assert.equal(l,1.75);if(x===1)assert.equal(l,1);
  }
});

test('constant and sub-tolerance signals preserve reversal pivots',()=>{
  const c=new Controller();move(c,.2);move(c,.6);
  const before=structuredClone(c.state);move(c,.6);
  assert.deepEqual(c.state,before);
  move(c,.6+1e-13);
  assert.equal(c.state.pivot_x,before.pivot_x);assert.equal(c.state.pivot_z,before.pivot_z);
});
