import test from "node:test";
import assert from "node:assert/strict";
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,existsSync,rmSync,utimesSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {DatabaseSync} from "node:sqlite";
import {acquireWorkerLock,WORKER_LOCK_DATABASE} from "../worker-lock.mjs";

function fixture(t) {
  const root=mkdtempSync(join(tmpdir(),"z-title-worker-lock-")),dataDir=join(root,"state");
  mkdirSync(dataDir);
  t.after(()=>rmSync(root,{recursive:true,force:true}));
  return {dataDir,legacyPath:join(dataDir,"worker.lock"),dbPath:join(dataDir,WORKER_LOCK_DATABASE)};
}

async function seedStale(dataDir) {
  const setup=await acquireWorkerLock({dataDir,command:"run"});
  await setup.release();
  const db=new DatabaseSync(join(dataDir,WORKER_LOCK_DATABASE));
  db.prepare("INSERT INTO worker_lock(id,token,pid,started_at,command) VALUES(1,'stale',32123,0,'run')").run();
  db.close();
}

function heldToken(dbPath) {
  const db=new DatabaseSync(dbPath);
  const row=db.prepare("SELECT token,pid,command FROM worker_lock WHERE id=1").get();
  db.close();
  return row;
}

test("新锁互斥，正常释放后可重新获取",async t=>{
  const {dataDir,dbPath}=fixture(t);
  const first=await acquireWorkerLock({dataDir,command:"run"});
  assert.equal(first.acquired,true);
  const second=await acquireWorkerLock({dataDir,command:"probe"});
  assert.equal(second.acquired,false);
  assert.equal(second.reason,"busy");
  await first.release();
  assert.equal(heldToken(dbPath),undefined);
  const third=await acquireWorkerLock({dataDir,command:"probe"});
  assert.equal(third.acquired,true);
  await third.release();
});

test("超龄死进程锁被回收，新锁写入当前进程身份",async t=>{
  const {dataDir,dbPath}=fixture(t);
  await seedStale(dataDir);
  const lock=await acquireWorkerLock({dataDir,command:"run",now:()=>120000,isProcessAlive:()=>false});
  assert.equal(lock.acquired,true);
  const held=heldToken(dbPath);
  assert.equal(held.pid,process.pid);
  assert.equal(held.command,"run");
  assert.equal(held.token,lock.token);
  await lock.release();
  assert.equal(heldToken(dbPath),undefined);
});

test("活进程锁即使超龄也不回收",async t=>{
  const {dataDir,dbPath}=fixture(t);
  await seedStale(dataDir);
  const lock=await acquireWorkerLock({dataDir,command:"probe",now:()=>120000,isProcessAlive:()=>true});
  assert.equal(lock.acquired,false);
  assert.equal(lock.reason,"busy");
  assert.equal(heldToken(dbPath).token,"stale");
});

test("旧版新损坏锁保持 busy，超龄损坏锁可以回收",async t=>{
  const {dataDir,legacyPath}=fixture(t);
  writeFileSync(legacyPath,"{}");
  const now=Date.now();
  const options={dataDir,command:"probe",now:()=>now,isProcessAlive:()=>false};
  assert.equal((await acquireWorkerLock(options)).acquired,false);
  utimesSync(legacyPath,new Date(now-60000),new Date(now-60000));
  const lock=await acquireWorkerLock(options);
  assert.equal(lock.acquired,true);
  assert.equal(existsSync(legacyPath),false);
  await lock.release();
});

test("释放时校验 token，不误删后来接管的锁",async t=>{
  const {dataDir,dbPath}=fixture(t);
  const first=await acquireWorkerLock({dataDir,command:"run"});
  assert.equal(first.acquired,true);
  const db=new DatabaseSync(dbPath);
  db.prepare("UPDATE worker_lock SET token='another-owner' WHERE id=1").run();
  db.close();
  await first.release();
  assert.equal(heldToken(dbPath).token,"another-owner");
});

test("并发回收同一个失效锁时只有一个调用获得锁",async t=>{
  const {dataDir,dbPath}=fixture(t);
  await seedStale(dataDir);
  const attempts=await Promise.all(Array.from({length:8},()=>acquireWorkerLock({
    dataDir,command:"run",now:()=>120000,isProcessAlive:()=>false,
  })));
  const winners=attempts.filter(item=>item.acquired);
  assert.equal(winners.length,1);
  await winners[0].release();
  assert.equal(heldToken(dbPath),undefined);
});

test("释放遇事务竞争时有界让位，并可在竞争结束后重试",async t=>{
  const {dataDir,dbPath}=fixture(t);
  const first=await acquireWorkerLock({dataDir,command:"run"});
  const blocker=new DatabaseSync(dbPath);
  blocker.exec("PRAGMA busy_timeout=0;BEGIN IMMEDIATE");
  await first.release();
  assert.equal(heldToken(dbPath).token,first.token,"释放失败不应误删当前锁");
  blocker.exec("ROLLBACK");blocker.close();
  await first.release();
  assert.equal(heldToken(dbPath),undefined);
});

test("时钟回拨不会保护已死进程留下的未来时间锁",async t=>{
  const {dataDir,dbPath}=fixture(t);
  await seedStale(dataDir);
  const db=new DatabaseSync(dbPath);
  db.prepare("UPDATE worker_lock SET started_at=200000 WHERE id=1").run();
  db.close();
  const lock=await acquireWorkerLock({dataDir,command:"probe",now:()=>100000,isProcessAlive:()=>false});
  assert.equal(lock.acquired,true);
  await lock.release();
});
