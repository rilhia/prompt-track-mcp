// smoke.js — end to end test of the simplified pull-only server.
//
// Exercises the Docker path: HTTP MCP in through /internal-rpc, real WebSocket
// player pages out. Nothing is stubbed. The point is to prove the two halves meet
// correctly, so it drives the same endpoints the stdio bridge does and connects
// real sockets rather than faking sessions.
//
//   Start a server on the test port, then:  node smoke.js
//
// Port 3055 by default, deliberately not 3044, so a running Prompt Track is not
// disturbed by a test run.
//
// WHAT IT COVERS
//   * initialize / tools/list handshake and the tool count
//   * the zero-page case, which must advise rather than error
//   * automatic targeting with exactly one page open, no fingerprint needed
//   * disambiguation when several pages are open
//   * state reporting: track load, cue firing, learner calibration
//   * pushes reaching the right page
//
// Failures set a non-zero exit code, so this works as a CI gate.

import WebSocket from 'ws';
import http from 'http';

const PORT = Number(process.env.PORT || 3055);

// Collected and printed as a table at the end, so one failure does not hide the
// rest of the run.
const results = [];
const ok = (name, pass, extra='') => { results.push([pass?'PASS':'FAIL', name, extra]); if(!pass) process.exitCode = 1; };

/**
 * Post one JSON-RPC message to /internal-rpc, exactly as the stdio bridge does.
 * Resolves null on 202, which is the server's "that was a notification".
 */
function rpc(msg, key='test-bridge-1'){
  return new Promise((resolve,reject)=>{
    const body = JSON.stringify(msg);
    const req = http.request({host:'127.0.0.1',port:PORT,path:'/internal-rpc',method:'POST',
      headers:{'Content-Type':'application/json','Content-Length':Buffer.byteLength(body),'x-bridge-key':key}},
      res=>{ let d=''; res.on('data',c=>d+=c); res.on('end',()=>{ if(res.statusCode===202||!d) return resolve(null); try{resolve(JSON.parse(d))}catch(e){reject(e)} }); });
    req.on('error',reject); req.write(body); req.end();
  });
}
// Used after socket sends. The server processes frames asynchronously, so a short
// wait is needed before asserting on the state they produced.
const sleep = ms => new Promise(r=>setTimeout(r,ms));

// Every tool returns a single text block; this pulls it out.
const textOf = r => r.result.content[0].text;

(async ()=>{
  // handshake + surface
  const init = await rpc({jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2025-03-26',capabilities:{extensions:{'io.modelcontextprotocol/ui':{mimeTypes:['text/html;profile=mcp-app']}}},clientInfo:{name:'smoke',version:'0'}}});
  ok('initialize', init && init.result.serverInfo.name==='prompt-track' && init.result.serverInfo.version==='0.70.0');
  await rpc({jsonrpc:'2.0',method:'notifications/initialized'});
  const list = await rpc({jsonrpc:'2.0',id:2,method:'tools/list'});
  ok('tools/list has 9 tools', list && list.result.tools.length===9, String(list && list.result.tools.map(t=>t.name)));

  // zero pages open
  const none = await rpc({jsonrpc:'2.0',id:4,method:'tools/call',params:{name:'get_state',arguments:{}}});
  ok('no pages guidance', /No player page is open/.test(textOf(none)));

  // one page: automatic targeting, no pairing
  const ws1 = new WebSocket('ws://127.0.0.1:'+PORT+'/ws');
  let fp1=null; const pushes1=[];
  ws1.on('message',raw=>{const m=JSON.parse(raw.toString()); if(m.type==='hello')fp1=m.sessionFingerprint; else pushes1.push(m);});
  await sleep(300);
  ok('hello carries fingerprint, no pair code', !!fp1 && fp1.split(' ').length===2, fp1);
  ws1.send(JSON.stringify({type:'track_loaded',track:{meta:{title:'Track One',video:{provider:'youtube',id:'aqz-KE-bpKQ'}},cues:[{id:'sec-a',t:2,type:'context',title:'Section: javascript basics',intro:'js part',topics:['javascript']},{id:'c1',t:5,type:'do',title:'Step one',intro:'do it',artifacts:{any:'echo hi'},deeper:'because',completion:'ran it'},{id:'sec-b',t:60,type:'context',title:'Section: docker',intro:'docker part',topics:['docker']},{id:'br-1',t:70,type:'branch',title:'Funny bits',intro:'pick one',choices:[{label:'Ludicrous Speed clip',video:'sb1987',t:300,until:330},{label:'Desert combing clip',video:'sb1987',t:400,until:430}]}]}}));
  ws1.send(JSON.stringify({type:'learner',os:'mac',comfort:'mid'}));
  ws1.send(JSON.stringify({type:'variables',variables:{PORT:'8080'}}));
  await sleep(200);
  const st1 = await rpc({jsonrpc:'2.0',id:5,method:'tools/call',params:{name:'get_state',arguments:{}}});
  const parsed = JSON.parse(textOf(st1));
  ok('single page auto-targeted', parsed.track && parsed.track.title==='Track One');
  ok('state carries learner + variables', parsed.learner.os==='mac' && parsed.variables.PORT==='8080');
  ws1.send(JSON.stringify({type:'playback', time:10, state:'playing'}));
  await sleep(200);
  const stSec = JSON.parse(textOf(await rpc({jsonrpc:'2.0',id:50,method:'tools/call',params:{name:'get_state',arguments:{}}})));
  ok('currentSection tracks playback', stSec.currentSection && stSec.currentSection.id==='sec-a', stSec.currentSection && stSec.currentSection.title);
  const gtNav = await rpc({jsonrpc:'2.0',id:51,method:'tools/call',params:{name:'get_track',arguments:{}}});
  ok('sections searchable in track', /javascript basics/.test(textOf(gtNav)) && /docker/.test(textOf(gtNav)));

  // two pages: ambiguity then fingerprint targeting
  const ws2 = new WebSocket('ws://127.0.0.1:'+PORT+'/ws');
  let fp2=null; const pushes2=[];
  ws2.on('message',raw=>{const m=JSON.parse(raw.toString()); if(m.type==='hello')fp2=m.sessionFingerprint; else pushes2.push(m);});
  await sleep(300);
  ws2.send(JSON.stringify({type:'track_loaded',track:{meta:{title:'Track Two',video:{provider:'youtube',id:'aqz-KE-bpKQ'}},cues:[{id:'c9',t:9,type:'do',title:'Other step',intro:'x',artifacts:{},completion:'y'}]}}));
  await sleep(200);
  ok('fingerprints differ', fp1 !== fp2, fp1+' vs '+fp2);
  const ambi = await rpc({jsonrpc:'2.0',id:6,method:'tools/call',params:{name:'get_state',arguments:{}}});
  ok('ambiguity asks the user', /Several player pages are open/.test(textOf(ambi)) && textOf(ambi).includes(fp1) && textOf(ambi).includes(fp2));
  const pick = await rpc({jsonrpc:'2.0',id:7,method:'tools/call',params:{name:'get_state',arguments:{session:fp2}}});
  ok('fingerprint targets the right page', JSON.parse(textOf(pick)).track.title==='Track Two');
  const bad = await rpc({jsonrpc:'2.0',id:8,method:'tools/call',params:{name:'get_state',arguments:{session:'walrus mauve'}}});
  ok('unknown fingerprint lists pages', /No open page matches/.test(textOf(bad)));

  // cue flow + control targeting
  ws1.send(JSON.stringify({type:'cue_fired',cueId:'c1'}));
  await sleep(200);
  const st2 = await rpc({jsonrpc:'2.0',id:9,method:'tools/call',params:{name:'get_state',arguments:{session:fp1}}});
  ok('active cue visible', JSON.parse(textOf(st2)).activeCue.id==='c1');
  await rpc({jsonrpc:'2.0',id:10,method:'tools/call',params:{name:'resume_video',arguments:{session:fp1}}});
  await sleep(200);
  ok('resume reached the right page only', pushes1.some(p=>p.type==='resume') && !pushes2.some(p=>p.type==='resume'));
  const gt = await rpc({jsonrpc:'2.0',id:11,method:'tools/call',params:{name:'get_track',arguments:{session:fp1}}});
  ok('get_track returns ground truth', /Step one/.test(textOf(gt)));

  // clips and cross-video seeks reach the page
  await rpc({jsonrpc:'2.0',id:20,method:'tools/call',params:{name:'play_clip',arguments:{session:fp1, video:'sb1987', t:120, until:150, return_video:'main', return_t:20}}});
  await sleep(200);
  const clip = pushes1.find(p=>p.type==='clip');
  ok('play_clip pushed with bounds and return', clip && clip.video==='sb1987' && clip.seconds===120 && clip.until===150 && clip.ret.video==='main' && clip.ret.t===20);
  await rpc({jsonrpc:'2.0',id:21,method:'tools/call',params:{name:'seek_video',arguments:{session:fp1, seconds:42, video:'sb1987'}}});
  await sleep(200);
  ok('cross-video seek pushed', pushes1.some(p=>p.type==='seek' && p.seconds===42 && p.video==='sb1987'));
  const badclip = await rpc({jsonrpc:'2.0',id:22,method:'tools/call',params:{name:'play_clip',arguments:{session:fp1, t:100, until:90}}});
  ok('clip bounds validated', /until greater than t/.test(textOf(badclip)));

  // go_to: by name, any time
  ws1.send(JSON.stringify({type:'playback', time:33, state:'playing', video:'main'}));
  await sleep(150);
  const nav1 = await rpc({jsonrpc:'2.0',id:30,method:'tools/call',params:{name:'go_to',arguments:{session:fp1, name:'ludicrous speed'}}});
  ok('go_to plays named clip', /Playing "Ludicrous Speed clip"/.test(textOf(nav1)));
  await sleep(200);
  const navClip = pushes1.filter(p=>p.type==='clip').pop();
  ok('go_to clip returns to current spot', navClip && navClip.ret && navClip.ret.video==='main' && navClip.ret.t===33, JSON.stringify(navClip && navClip.ret));
  const nav2 = await rpc({jsonrpc:'2.0',id:31,method:'tools/call',params:{name:'go_to',arguments:{session:fp1, name:'docker section'}}});
  ok('go_to jumps to section', /Jumped to "Section: docker"/.test(textOf(nav2)));
  const nav3 = await rpc({jsonrpc:'2.0',id:32,method:'tools/call',params:{name:'go_to',arguments:{session:fp1, name:'clip'}}});
  ok('go_to ambiguity asks', /Several destinations match/.test(textOf(nav3)));
  const nav4 = await rpc({jsonrpc:'2.0',id:33,method:'tools/call',params:{name:'go_to',arguments:{session:fp1, name:'zzz nonexistent'}}});
  ok('go_to unknown lists targets', /Nothing in the track matches/.test(textOf(nav4)) && /Ludicrous Speed clip/.test(textOf(nav4)));

  // closing a page removes it
  ws2.close();
  await sleep(250);
  const after = await rpc({jsonrpc:'2.0',id:12,method:'tools/call',params:{name:'get_state',arguments:{}}});
  ok('closed page drops out, single targeting returns', JSON.parse(textOf(after)).track.title==='Track One');

  ws1.close();
  for(const [s,n,e] of results) console.log(s.padEnd(5), n, e?(' -> '+e):'');
  console.log(results.every(r=>r[0]==='PASS') ? 'ALL PASS' : 'FAILURES PRESENT');
  process.exit();
})();
