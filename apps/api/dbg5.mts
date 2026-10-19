process.env.NODE_ENV = "test";
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? "postgresql://genze:genze@localhost:5432/genze_test";
process.env.JWT_ACCESS_SECRET = "test-access-secret-made-of-words-only-one";
process.env.JWT_REFRESH_SECRET = "test-refresh-secret-made-of-words-only-two";
process.env.REDIS_URL = "";
process.env.SEARCH_PROVIDER = "stub";
process.env.ANTHROPIC_API_KEY = "test-anthropic-key-words-only";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
const server = createServer((req, res) => {
  const url = req.url ?? "/";
  if (url === "/robots.txt") { res.writeHead(200, {"content-type":"text/plain"}); res.end("User-agent: *\nDisallow: /blocked\n"); return; }
  if (url === "/page1" || url === "/page2") {
    setTimeout(() => { res.writeHead(200, {"content-type":"text/html"}); res.end(`<html><head><title>T</title></head><body><article><p>${"word ".repeat(100)}</p></article></body></html>`); }, 150);
    return;
  }
  res.writeHead(404); res.end("nope");
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
const { buildApp } = await import("./src/index.ts");
const { getPool, closePool } = await import("./src/db.ts");
const { closeRedis } = await import("./src/redis.ts");
const { setStubResults } = await import("./src/search/stub.ts");
function sseWithText(text: string): string {
  const data = (o: unknown) => `data: ${JSON.stringify(o)}\n`;
  return "event: message_start\n" + data({type:"message_start",message:{id:"m",usage:{input_tokens:10,output_tokens:0}}}) + "\n"
    + "event: content_block_delta\n" + data({type:"content_block_delta",index:0,delta:{type:"text_delta",text}})+"\n"
    + "event: message_delta\n" + data({type:"message_delta",delta:{stop_reason:"end_turn"},usage:{output_tokens:5}})+"\n"
    + "event: message_stop\n" + data({type:"message_stop"})+"\n";
}
const REPORT = ["## Summary","x [1].","","## Key findings","- a [1].","- b [2].","","## Where sources disagree","z [2].","","## Open questions","- q [1].","","## Sources","[1] one","[2] two"].join("\n");
const realFetch = globalThis.fetch;
globalThis.fetch = (async (url: unknown, init?: any) => {
  const u = String(url);
  if (u.includes("api.anthropic.com")) {
    await new Promise(r => setTimeout(r, 50));
    const body = JSON.parse(String(init?.body ?? "{}"));
    const system = String(body.system ?? "");
    let text = "hi";
    if (system.includes("research planner")) text = JSON.stringify({steps:["s1","s2","s3"]});
    else if (system.includes("search query generator")) text = JSON.stringify(["q1","q2"]);
    else if (system.includes("research analyst")) text = REPORT;
    return new Response(sseWithText(text), {status:200, headers:{"content-type":"text/event-stream"}});
  }
  return realFetch(url as string, init);
}) as typeof fetch;
setStubResults([{title:"P1",url:`${base}/page1`,snippet:"a"},{title:"P2",url:`${base}/page2`,snippet:"b"}]);
const app = await buildApp({ disableRateLimit: true });
// signup
const em = `dbg5-${Date.now()}@example.com`;
let res = await app.inject({method:"POST",url:"/api/v1/auth/signup",payload:{email:em,password:"password123",country:"PK"}});
console.log("signup", res.statusCode);
const { testEmailOutbox } = await import("./src/email.ts");
const tok = testEmailOutbox[testEmailOutbox.length-1].text.match(/token=([0-9a-f]+)/)![1];
await app.inject({method:"POST",url:"/api/v1/auth/verify-email",payload:{token:tok}});
res = await app.inject({method:"POST",url:"/api/v1/auth/login",payload:{email:em,password:"password123"}});
const access = res.json().data.tokens.accessToken;
const h = { authorization: `Bearer ${access}` };
await app.inject({method:"POST",url:"/api/v1/chat/consent",headers:h,payload:{providerIds:["anthropic"]}});
res = await app.inject({method:"POST",url:"/api/v1/research/jobs",headers:h,payload:{topic:"debug topic"}});
console.log("create", res.statusCode, res.body.slice(0,200));
const jobId = res.json().data.job.id;
const t0 = Date.now();
for (let i=0;i<100;i++) {
  await new Promise(r=>setTimeout(r,200));
  const jr = await app.inject({method:"GET",url:`/api/v1/research/jobs/${jobId}`,headers:h});
  const j = jr.json().data.job;
  if (j.plan) { console.log(`plan ready after ${Date.now()-t0}ms`); break; }
}
res = await app.inject({method:"POST",url:`/api/v1/research/jobs/${jobId}/start`,headers:h});
console.log("start", res.statusCode);
for (let i=0;i<150;i++) {
  await new Promise(r=>setTimeout(r,200));
  const jr = await app.inject({method:"GET",url:`/api/v1/research/jobs/${jobId}`,headers:h});
  const j = jr.json().data.job;
  if (j.status === "done" || j.status === "failed") {
    console.log(`terminal ${j.status} after ${Date.now()-t0}ms phase=${j.progress.phase} error=${j.error}`);
    break;
  }
  if (i%10===0) console.log(`... ${Date.now()-t0}ms status=${j.status} phase=${j.progress.phase}`);
}
// events
res = await app.inject({method:"GET",url:`/api/v1/research/jobs/${jobId}/events`,headers:h});
console.log("events status", res.statusCode, "frames:", res.body.split("\n\n").filter((b:string)=>b.trim().startsWith("data:")).length);
await app.close(); await closePool(); await closeRedis(); server.close();
