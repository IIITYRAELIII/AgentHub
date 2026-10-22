import assert from 'node:assert/strict';
import {createServer} from 'node:net';
import test from 'node:test';
import {HubMcpServer} from '../../../src/interfaces/mcp/hub-mcp-server.mjs';

function fixture() {
  let mutations = 0;
  const context = {streamId:'synthetic-stream',threadId:'synthetic-thread'};
  const server = new HubMcpServer({secret:'synthetic-mcp-secret',
    service:{tools:()=>[{name:'hub_context_get',inputSchema:{type:'object'}}],
      call:(name,args)=>{assert.equal(args.context_token,'synthetic-context');
        if(name==='synthetic_mutation'){mutations+=1;return {operationId:'same-original'};}
        assert.equal(name,'hub_context_get');return context;}},
    logger:{log(){},error(){}},
  });
  return {server,context,mutationCount:()=>mutations};
}

function fixedClient(url) {
  let request = 0;
  return async (method,params={}) => {
    const response=await fetch(url,{method:'POST',headers:{'content-type':'application/json'},
      signal:AbortSignal.timeout(1000),
      body:JSON.stringify({jsonrpc:'2.0',id:++request,method,params})});
    assert.equal(response.status,200);
    const reply=await response.json();assert.equal(reply.error,undefined);return reply.result;
  };
}

test('failed replacement recovery preserves the endpoint advertised to a live MCP client',async t=>{
  const {server,context,mutationCount}=fixture();t.after(()=>server.close());
  await server.start();const url=server.url;const args=server.codexArgs();
  // Existing App Server children retain this endpoint in their launch arguments.
  const client=fixedClient(url);
  await client('tools/call',{name:'synthetic_mutation',arguments:{context_token:'synthetic-context',request_id:'same-original'}});
  for(let recovery=0;recovery<2;recovery+=1){
    await server.close();await server.start();
    assert.equal(server.url,url);assert.deepEqual(server.codexArgs(),args);
    const tools=await client('tools/list');assert.equal(tools.tools[0].name,'hub_context_get');
    const read=await client('tools/call',{name:'hub_context_get',arguments:{context_token:'synthetic-context'}});
    assert.deepEqual(read.structuredContent,context);
    assert.equal(mutationCount(),1,'recovery must not replay a prior mutation');
    const foreign=await fetch(new URL('/mcp/foreign-capability',url),{method:'POST',body:'{}'});
    assert.equal(foreign.status,404);
  }
});

test('recovery refuses a stolen advertised port instead of silently rebinding the client',async t=>{
  const {server,mutationCount}=fixture();t.after(()=>server.close());
  await server.start();const url=server.url;const endpoint=new URL(url);await server.close();
  const foreign=createServer(socket=>socket.end());
  await new Promise((resolve,reject)=>{foreign.once('error',reject);foreign.listen(Number(endpoint.port),endpoint.hostname,resolve);});
  t.after(()=>new Promise(resolve=>foreign.close(resolve)));
  await assert.rejects(server.start(),{code:'EADDRINUSE'});
  assert.equal(server.running,false);assert.equal(mutationCount(),0);
  await new Promise(resolve=>foreign.close(resolve));
  await server.start();assert.equal(server.url,url);
  const result=await fixedClient(url)('tools/list');assert.equal(result.tools[0].name,'hub_context_get');
});
