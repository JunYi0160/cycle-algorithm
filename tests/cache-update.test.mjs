import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,copyFileSync,cpSync,readFileSync,writeFileSync,appendFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {resolve,join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {runInNewContext} from 'node:vm';
import {fileURLToPath} from 'node:url';
import {releaseURL,fetchRelease} from '../src/bootstrap.js';

test('build versions the full import graph and changes release when a dependency changes',()=>{
  const root=fileURLToPath(new URL('../',import.meta.url));
  const prefix=resolve(tmpdir(),'cycle-cache-test-');
  const workspace=mkdtempSync(prefix);
  try{
    cpSync(join(root,'src'),join(workspace,'src'),{recursive:true});
    cpSync(join(root,'public'),join(workspace,'public'),{recursive:true});
    cpSync(join(root,'data'),join(workspace,'data'),{recursive:true});
    mkdirSync(join(workspace,'scripts'));
    copyFileSync(join(root,'scripts/build.mjs'),join(workspace,'scripts/build.mjs'));
    copyFileSync(join(root,'scripts/project-files.mjs'),join(workspace,'scripts/project-files.mjs'));
    const build=()=>{
      const result=spawnSync(process.execPath,[join(workspace,'scripts/build.mjs')],{encoding:'utf8'});
      assert.equal(result.status,0,result.stderr);
      return JSON.parse(readFileSync(join(workspace,'dist/release.json'),'utf8')).version;
    };
    const version=build();
    assert.match(version,/^[a-f0-9]{16}$/);
    assert.equal(build(),version,'an identical build must keep its release');
    for(const path of ['scripts/build.mjs','src/strategy.js','public/index.html','public/style.css']){
      const file=join(workspace,path);
      writeFileSync(file,readFileSync(file,'utf8').replaceAll('\r\n','\n').replaceAll('\n','\r\n'));
    }
    assert.equal(build(),version,'Windows and Linux line endings must share a release');
    const html=readFileSync(join(workspace,'dist/index.html'),'utf8');
    assert.ok(html.includes(`src/bootstrap.js?v=${version}`));
    assert.ok(html.includes(`style.css?v=${version}`));
    assert.ok(html.includes(`data-release="${version}"`));
    for(const name of ['bootstrap','app','preview','model','storage']){
      const code=readFileSync(join(workspace,'dist/src',name+'.js'),'utf8');
      const imports=[...code.matchAll(/['"](\.\/[^'"\s]+\.js(?:\?[^'"\s]*)?)['"]/g)].map(m=>m[1]);
      assert.ok(imports.length,`${name} has imports`);
      for(const specifier of imports)assert.ok(specifier.endsWith(`?v=${version}`),specifier);
      assert.ok(!code.includes('__BUILD_VERSION__'));
    }
    appendFileSync(join(workspace,'src/strategy.js'),'\n// changed dependency\n');
    assert.notEqual(build(),version,'changes below app.js must invalidate the whole graph');
    const changedCode=build();
    appendFileSync(join(workspace,'data/prices/NVDA.csv'),'\n');
    assert.notEqual(build(),changedCode,'market data changes must also publish a new release');
  }finally{
    assert.ok(resolve(workspace).startsWith(prefix));
    assert.equal(resolve(workspace,'..'),resolve(tmpdir()));
    rmSync(workspace,{recursive:true,force:true});
  }
});

test('release navigation preserves existing query parameters and section',()=>{
  assert.equal(releaseURL('https://example.org/cycle-algorithm/?mode=local&v=old#research','abcdef0123456789'),
    'https://example.org/cycle-algorithm/?mode=local&v=abcdef0123456789#research');
});

test('release check bypasses cache and rejects failures and malformed manifests',async()=>{
  const base='https://example.org/cycle-algorithm/';
  assert.equal(await fetchRelease(base,async(url,options)=>{
    assert.equal(new URL(url).pathname,'/cycle-algorithm/release.json');
    assert.ok(new URL(url).searchParams.has('check'));
    assert.equal(options.cache,'no-store');
    assert.ok(options.signal instanceof AbortSignal);
    return {ok:true,json:async()=>({version:'abcdef0123456789'})};
  }),'abcdef0123456789');
  await assert.rejects(fetchRelease(base,async()=>({ok:false})),/unavailable/);
  await assert.rejects(fetchRelease(base,async()=>({ok:true,json:async()=>({version:'wrong'})})),/Invalid/);
});

function simulatedPage({latest,offline=false}){
  const built='1111111111111111',navigation=[],timers=[],notice={hidden:true},button={};
  let appLoads=0;
  const location={href:'https://example.org/cycle-algorithm/?mode=local#research',
    replace:url=>navigation.push(url),assign:url=>navigation.push(url)};
  const context={URL,AbortSignal,Date,Promise,console,navigator:{},location,
    document:{visibilityState:'visible',addEventListener(){},getElementById:id=>id==='release-update'?notice:button},
    window:{addEventListener(){}},setInterval:fn=>timers.push(fn),
    fetch:async()=>{if(offline)throw new Error('offline');return {ok:true,json:async()=>({version:latest})};},
    loadApp:async()=>{appLoads++;},
    localStorage:{clear(){assert.fail('must preserve user data');},removeItem(){assert.fail('must preserve user data');}}};
  const source=readFileSync(new URL('../src/bootstrap.js',import.meta.url),'utf8')
    .replace(/^export /gm,'').replaceAll('__BUILD_VERSION__',built)
    .replace('import.meta.url',JSON.stringify('https://example.org/cycle-algorithm/src/bootstrap.js'))
    .replace("await import('./app.js')",'await loadApp()')
    .replace(/if\(typeof window!=='undefined'\)[\s\S]*$/,'');
  return {boot:runInNewContext(source+'\nboot;',context),navigation,timers,notice,button,
    loaded:()=>appLoads,setLatest:value=>{latest=value;}};
}

test('cached page upgrades before launching app; an unavailable network still launches app',async()=>{
  const stale=simulatedPage({latest:'2222222222222222'});
  await stale.boot();
  assert.equal(stale.loaded(),0);
  assert.deepEqual(stale.navigation,['https://example.org/cycle-algorithm/?mode=local&v=2222222222222222#research']);
  const offline=simulatedPage({offline:true});
  await offline.boot();
  assert.equal(offline.loaded(),1);
  assert.equal(offline.navigation.length,0);
});

test('a running page offers an update without automatically discarding edits',async()=>{
  const page=simulatedPage({latest:'1111111111111111'});
  await page.boot();
  assert.equal(page.loaded(),1);
  page.setLatest('2222222222222222');
  await page.timers[0]();
  assert.equal(page.notice.hidden,false);
  assert.equal(page.navigation.length,0);
  page.button.onclick();
  assert.equal(page.navigation.length,1);
  assert.match(page.navigation[0],/v=2222222222222222/);
});
