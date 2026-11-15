import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {appendFile} from 'node:fs/promises';
import {prepareTaskWorktreeDependencies} from '../../../src/infrastructure/filesystem/task-worktree-dependencies.mjs';
async function fixture(t,scriptName=null,npmrc=false){
 const parent=await mkdtemp(path.join(os.tmpdir(),'s3-deps-context-'));t.after(()=>rm(parent,{recursive:true,force:true}));
 const root=path.join(parent,'task');await mkdir(root);
 const manifest={name:'source-specific-fixture',private:true,dependencies:{tiny:'1.0.0'},...(scriptName?{scripts:{[scriptName]:'node ./project-hook.cjs'}}:{})};
 const entry={version:'1.0.0',resolved:'https://registry.example.invalid/tiny.tgz',integrity:'sha512-fixture'};
 const lock={name:manifest.name,lockfileVersion:3,packages:{'':manifest,'node_modules/tiny':entry}};
 await writeFile(path.join(root,'package.json'),JSON.stringify(manifest));await writeFile(path.join(root,'package-lock.json'),JSON.stringify(lock));
 await writeFile(path.join(root,'project-hook.cjs'),'// Only exists in the real Task source; no execution needed to check the npm cwd contract.\n');
 if(npmrc)await writeFile(path.join(root,'.npmrc'),'ignore-scripts=true\n');
 const lease={assertOwned:async()=>{}};
 const sharedDependencies=(key,operation)=>operation({root:path.join(parent,'inputs',key),lease});
 const runNpm=async(args,{cwd})=>{
  if(process.env.S3_OBSERVATIONS)await appendFile(process.env.S3_OBSERVATIONS,JSON.stringify({test:scriptName??'npmrc',taskRoot:root,npmCwd:cwd,rootConfig:npmrc,command:args})+'\n');
  if(scriptName)assert.equal(cwd,root,'A source-specific npm lifecycle must execute in the owning Task project, with its source files');
  if(npmrc)assert.equal(await readFile(path.join(cwd,'.npmrc'),'utf8'),'ignore-scripts=true\n','Normal npm must retain the project config selected by its cwd');
  await mkdir(path.join(cwd,'node_modules/tiny'),{recursive:true});
  await writeFile(path.join(cwd,'node_modules/tiny/package.json'),JSON.stringify({name:'tiny',version:'1.0.0'}));
  await writeFile(path.join(cwd,'node_modules/.package-lock.json'),JSON.stringify({lockfileVersion:3,packages:{'node_modules/tiny':entry}}));
 };
 await prepareTaskWorktreeDependencies({projectRoot:root,lockfiles:[path.join(root,'package-lock.json')],lease,runNpm,sharedDependencies});
 assert.equal(JSON.parse(await readFile(path.join(root,'node_modules/tiny/package.json'),'utf8')).version,'1.0.0');
}
for(const script of ['prepublish','preprepare','postprepare'])test('source-local lifecycle '+script+' keeps its source cwd',t=>fixture(t,script));
test('project npm config reaches the existing npm runner',t=>fixture(t,null,true));
test('existing postinstall hook remains local control',t=>fixture(t,'postinstall'));
