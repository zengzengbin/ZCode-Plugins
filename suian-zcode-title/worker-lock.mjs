import {mkdir,readFile,stat,unlink} from "node:fs/promises";
import {randomUUID} from "node:crypto";
import {join} from "node:path";
import process from "node:process";
import {DatabaseSync} from "node:sqlite";

export const STALE_WORKER_LOCK_MS=30000;
export const WORKER_LOCK_DATABASE="worker-lock.sqlite";

const defaultAlive=pid=>{
  if(pid===process.pid)return true;
  try {process.kill(pid,0);return true;}
  catch(error) {return error.code!=="ESRCH";}
};
const busy=()=>({acquired:false,reason:"busy"});
const sqliteBusy=error=>error?.errcode===5||(error?.code==="ERR_SQLITE_ERROR"&&/database is locked|database is busy/i.test(error.message));

async function clearLegacyLock({dataDir,now,isProcessAlive,staleAfterMs}) {
  const path=join(dataDir,"worker.lock");
  let raw,info;
  try {raw=await readFile(path,"utf8");info=await stat(path);}
  catch(error) {if(error.code==="ENOENT")return true;throw error;}
  let held;
  try {held=JSON.parse(raw);} catch {}
  const startedAt=Date.parse(held?.startedAt);
  const rawAge=now()-(Number.isFinite(startedAt)?startedAt:info.mtimeMs);
  const age=Number.isFinite(startedAt)?rawAge:Math.max(0,rawAge);
  const validPid=Number.isInteger(held?.pid)&&held.pid>0;
  if((age>=0&&age<=staleAfterMs)||(validPid&&isProcessAlive(held.pid)))return false;
  await unlink(path).catch(error=>{if(error.code!=="ENOENT")throw error;});
  return true;
}

export async function acquireWorkerLock({dataDir,command,sessionId,now=Date.now,isProcessAlive=defaultAlive,staleAfterMs=STALE_WORKER_LOCK_MS}) {
  await mkdir(dataDir,{recursive:true});
  if(!await clearLegacyLock({dataDir,now,isProcessAlive,staleAfterMs}))return busy();

  const db=new DatabaseSync(join(dataDir,WORKER_LOCK_DATABASE));
  db.exec("PRAGMA busy_timeout=0");
  const token=randomUUID();
  let transaction=false;
  try {
    db.exec("BEGIN IMMEDIATE");
    transaction=true;
    db.exec(`CREATE TABLE IF NOT EXISTS worker_lock (
      id INTEGER PRIMARY KEY CHECK(id=1), token TEXT NOT NULL, pid INTEGER NOT NULL,
      started_at INTEGER NOT NULL, command TEXT, session_id TEXT
    )`);
    const held=db.prepare("SELECT token,pid,started_at FROM worker_lock WHERE id=1").get();
    if(held) {
      const age=now()-held.started_at;
      if((age>=0&&age<=staleAfterMs)||isProcessAlive(held.pid)) {
        db.exec("ROLLBACK");transaction=false;
        db.close();
        return busy();
      }
      db.prepare("DELETE FROM worker_lock WHERE id=1 AND token=?").run(held.token);
    }
    db.prepare("INSERT INTO worker_lock(id,token,pid,started_at,command,session_id) VALUES(1,?,?,?,?,?)")
      .run(token,process.pid,now(),command,sessionId??null);
    db.exec("COMMIT");transaction=false;
  } catch(error) {
    if(transaction)try{db.exec("ROLLBACK");}catch{}
    db.close();
    if(sqliteBusy(error))return busy();
    throw error;
  }

  let released=false;
  return {acquired:true,token,release:async()=>{
    if(released)return;
    for(let attempt=0;attempt<5;attempt++) {
      let transaction=false;
      try {
        db.exec("BEGIN IMMEDIATE");transaction=true;
        db.prepare("DELETE FROM worker_lock WHERE id=1 AND token=?").run(token);
        db.exec("COMMIT");transaction=false;
        released=true;
        db.close();
        return;
      } catch(error) {
        if(transaction)try{db.exec("ROLLBACK");}catch{}
        if(!sqliteBusy(error)){db.close();throw error;}
        if(attempt===4)return;
        await new Promise(resolve=>setTimeout(resolve,10*(attempt+1)));
      }
    }
  }};
}
