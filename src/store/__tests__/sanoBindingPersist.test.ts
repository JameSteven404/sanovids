// Regression fixture: actual persist/runs/gateway with fake IndexedDB, media and host tokens.
import { afterAll, beforeAll, expect, it, vi } from 'vitest'
const db = vi.hoisted(() => ({ values: new Map<string, any>(), writes: [] as string[], reads: [] as string[], abort: false }))
vi.mock('idb-keyval', () => ({
  get: async (key: string) => { db.reads.push(key); return db.values.get(key) },
  set: async (key: string, value: unknown) => { db.values.set(key, structuredClone(value)) },
  update: async (key: string, fn: (value: unknown) => unknown) => { db.values.set(key, fn(db.values.get(key))) },
  createStore: () => (_mode: string, callback: (store: unknown) => unknown) => {
    let pending = 0
    const writes: [string, unknown][] = []
    const transaction = { oncomplete: () => {}, onerror: () => {}, onabort: () => {}, error: new Error('fixture DB') }
    const store = {
      transaction,
      get(key: string) {
        pending++
        const request = { result: db.values.get(key), onsuccess: () => {} }
        queueMicrotask(() => {
          request.onsuccess()
          if (--pending === 0) queueMicrotask(() => {
            if(db.abort){transaction.onabort();return}
            for (const [k, v] of writes) { db.values.set(k, v); db.writes.push(k) }
            transaction.oncomplete()
          })
        })
        return request
      },
      put(value: unknown, key: string) { writes.push([key, structuredClone(value)]) },
    }
    return callback(store)
  },
}))
vi.mock('../../lib/imageStore', () => ({ putBlob: vi.fn(async()=> 'fixture'), getBlob: vi.fn(async()=>null), getUrl: vi.fn(async()=>null), cachedUrl:()=>null, deleteMedia:vi.fn(async()=>undefined), dataUrlToBlob:()=>new Blob(), useMediaUrl:()=>null, revokeUnusedUrls:vi.fn() }))
vi.mock('../../lib/saveFolders', () => ({ copyFolderHandle: vi.fn() }))
import { jwt } from '../../providers/__tests__/insideSano'
import { createSanoGatewayProvider } from '../../providers/sano/gateway'
import { getProvider, registerProvider, bumpProviderLimits, useProviderPrefs } from '../../providers'
import { accountKey } from '../../providers/canvasapp/adapter'
import { useRuns, setEngineLockManager, setEngineHooks } from '../runs'
import { useProject } from '../project'
import { bootstrap, switchProject, flush } from '../persist'

const original=getProvider('sano-gateway')
const tokens={A:jwt({sub:'fixture-A',exp:4_000_000_000}),B:jwt({sub:'fixture-B',exp:4_000_000_000})}
const settings={model:'seedance_2_5',mode:'t2v',duration:5,resolution:'480p',ratio:'16:9'} as const
const models=[{id:'seedance_2_5',label:'Fixture',ratios:['16:9'],resolutions:['480p'],durations:[5],maxRefs:4}]
const project:any={id:'binding-project-A',name:'Fixture A',schemaVersion:2,createdAt:0,updatedAt:0,settings:{autoRenumber:true},assets:[],presets:[],scenes:[{id:'s1',order:1,title:'Scene',prompt:'Walk',refs:[],videoRefs:[],presetId:null,settings,firstFrame:null,lastFrame:null,color:null,position:{x:0,y:0},note:''}]}
const other={...project,id:'binding-project-X',name:'Fixture X'}
let p:ReturnType<typeof createSanoGatewayProvider>|undefined
beforeAll(async()=>{
 vi.stubGlobal('fetch',()=>{throw new Error('External HTTP forbidden')});vi.stubGlobal('BroadcastChannel',undefined);vi.useFakeTimers();vi.stubEnv('VITE_SANO_GATEWAY','1')
 const storage=new Map<string,string>([['bdp:active',project.id]])
 vi.stubGlobal('localStorage',{getItem:(k:string)=>storage.get(k)??null,setItem:(k:string,v:string)=>storage.set(k,v),removeItem:(k:string)=>storage.delete(k),length:0})
 vi.stubGlobal('window',{location:{origin:'https://sano.example'},parent:{location:{origin:'https://sano.example'}},addEventListener:vi.fn()})
 vi.stubGlobal('document',{addEventListener:vi.fn(),visibilityState:'visible'});vi.stubGlobal('navigator',{})
 setEngineLockManager(null)
 db.values.set('index',[project,other].map(p=>({id:p.id,name:p.name,scenes:1,updatedAt:0})))
 for(const obj of [project,other]){db.values.set(`project:${obj.id}`,obj);db.values.set(`runs:${obj.id}`,{takes:[],credits:100,spent:0})}
 await bootstrap()
 expect(db.reads).toContain('index')
})
afterAll(()=>{useRuns.getState().loadRuns({takes:[],credits:100,spent:0});p?.reset();registerProvider(original);setEngineHooks({});setEngineLockManager(undefined);vi.useRealTimers();vi.unstubAllEnvs();vi.unstubAllGlobals()})

it.each(['warm-A','stale-A-click-B','stale-A-click-B-other-tab-saved'] as const)('%s queued ownership survives project switch before fresh token resolves',async(scenario)=>{
 p?.reset();useRuns.getState().loadRuns({takes:[],credits:100,spent:0});await flush()
 if(useProject.getState().project.id!==project.id)await switchProject(project.id)
 let current:'A'|'B'='A',slow=false,ready=false;const calls:any[]=[]
 p=createSanoGatewayProvider({available:()=>true,getBlob:async()=>null,token:()=>{
  const captured=tokens[current]
  return slow?new Promise(resolve=>setTimeout(()=>resolve(captured),500)):Promise.resolve(captured)
 },onLimitsChange:()=>{if(ready)bumpProviderLimits('sano-gateway')},fetch:async(url,init)=>{
  const owner=(init.headers as Record<string,string>).Authorization===`Bearer ${tokens.A}`?'A':'B';calls.push({url,method:init.method??'GET',owner})
  if(url.endsWith('/capabilities'))return Response.json({mode:'simulator',models})
  if(url==='/api/video/jobs'&&init.method==='POST'){const body=JSON.parse(String(init.body));return Response.json({id:`${owner}_${body.idempotencyKey}`,status:'running',mode:'simulator'},{status:202})}
  return Response.json({status:'running',progress:20,mode:'simulator'})
 }})
 await p.refreshLimits({force:true});registerProvider(p);ready=true;useProviderPrefs.setState({provider:'sano-gateway'})
 expect(useProject.getState().project.id).toBe(project.id)
 expect(p.account()).toBe(accountKey('fixture-A'))
 if(scenario!=='warm-A')current='B'
 const intended=current
 slow=true
 expect(useRuns.getState().enqueue(['s1']).queued).toBe(1)
 const queued=structuredClone(useRuns.getState().takes[0])
 expect(queued.account).toBe(accountKey('fixture-A'))
 await switchProject(other.id) // actual flush writes queued take, then actual loadRuns replaces it
 expect(useProject.getState().project.id).toBe(other.id)
 useProject.setState(s=>({project:{...s.project,name:'Edited other project while binding'}}))
 const savedBefore=structuredClone(db.values.get(`runs:${project.id}`))
 expect(savedBefore.takes[0]).toMatchObject({id:queued.id,status:'queued'})
 expect(savedBefore.takes[0].account).toBe(accountKey('fixture-A'))
 // Another tab saves the original project before the fresh account resolves: the binding still reaches its take.
 if(scenario==='stale-A-click-B-other-tab-saved'){const rev=db.values.get(`rev:${project.id}`);db.values.set(`rev:${project.id}`,{rev:(rev?.rev??0)+1,tab:'fixture-other-tab',at:0});db.values.set(`runs:${project.id}`,{...savedBefore,spent:7})}
 await vi.advanceTimersByTimeAsync(600) // fresh account at Run finishes while X is open; original project's take is absent
 expect(p.account()).toBe(accountKey(`fixture-${intended}`))
 expect(useProject.getState().project.name).toBe('Edited other project while binding')
 const savedAfter=structuredClone(db.values.get(`runs:${project.id}`))
 expect(savedAfter.takes[0].account).toBe(accountKey(`fixture-${intended}`))
 if(scenario==='stale-A-click-B-other-tab-saved')expect(savedAfter.spent).toBe(7) // the other tab's save is kept
 expect(calls.filter(c=>c.method==='POST')).toHaveLength(0)
 slow=false;current=intended==='A'?'B':'A';await p.refreshLimits({force:true})
 await switchProject(project.id)
 await vi.advanceTimersByTimeAsync(1_000)
 const final=structuredClone(useRuns.getState().takes[0])
 await flush()
 expect(final).toMatchObject({id:queued.id,status:'queued',account:accountKey(`fixture-${intended}`),remoteId:null})
 expect(calls.filter(c=>c.method==='POST')).toHaveLength(0)
})

it('control: cancelling while the first account binding is pending sends no job after the token resolves',async()=>{
 p?.reset();useRuns.getState().loadRuns({takes:[],credits:100,spent:0});await flush()
 let slow=false;const calls:any[]=[]
 p=createSanoGatewayProvider({available:()=>true,getBlob:async()=>null,token:()=>slow?new Promise(resolve=>setTimeout(()=>resolve(tokens.A),500)):Promise.resolve(tokens.A),fetch:async(url,init)=>{
  calls.push({url,method:init.method??'GET'})
  if(url.endsWith('/capabilities'))return Response.json({mode:'simulator',models})
  throw new Error(`Unexpected job request ${url}`)
 }})
 await p.refreshLimits({force:true});registerProvider(p)
 slow=true;expect(useRuns.getState().enqueue(['s1']).queued).toBe(1)
 const id=useRuns.getState().takes[0].id
 useRuns.getState().cancel(id)
 await vi.advanceTimersByTimeAsync(1_000)
 const final=structuredClone(useRuns.getState().takes[0])
 expect(final).toMatchObject({id,status:'cancelled',remoteId:null,account:accountKey('fixture-A')})
 expect(calls.filter(c=>!c.url.endsWith('/capabilities'))).toHaveLength(0)
})

it('cold initial account is refused without creating an ownerless take; retry after identity arrives works', async()=>{
 p?.reset();useRuns.getState().loadRuns({takes:[],credits:100,spent:0});await flush()
 if(useProject.getState().project.id!==project.id)await switchProject(project.id)
 p=createSanoGatewayProvider({available:()=>true,getBlob:async()=>null,token:()=>new Promise(resolve=>setTimeout(()=>resolve(tokens.A),500)),fetch:async()=>{throw new Error('No job allowed')}})
 registerProvider(p);useProviderPrefs.setState({provider:'sano-gateway'})
 expect(p.account()).toBeNull()
 expect(useRuns.getState().enqueue(['s1'])).toMatchObject({queued:0,error:expect.stringContaining('Đang xác định tài khoản')})
 expect(useRuns.getState().takes).toHaveLength(0)
 await vi.advanceTimersByTimeAsync(600)
 expect(useRuns.getState().enqueue(['s1']).queued).toBe(1)
 const t=useRuns.getState().takes[0];expect(t.account).toBe(accountKey('fixture-A'))
 useRuns.getState().cancel(t.id);await vi.advanceTimersByTimeAsync(600)
 expect(useRuns.getState().takes[0].status).toBe('cancelled')
})

it('a save containing an older pending snapshot retains the committed binding and cancellation', async()=>{
 p?.reset();useRuns.getState().loadRuns({takes:[],credits:100,spent:0});await flush()
 if(useProject.getState().project.id!==project.id)await switchProject(project.id)
 let slow=false
 p=createSanoGatewayProvider({available:()=>true,getBlob:async()=>null,token:()=>slow?new Promise(resolve=>setTimeout(()=>resolve(tokens.B),500)):Promise.resolve(tokens.A),fetch:async(url)=>{
  if(url.endsWith('/capabilities'))return Response.json({mode:'simulator',models})
  throw new Error(`Unexpected job request ${url}`)
 }})
 await p.refreshLimits({force:true});registerProvider(p);useProviderPrefs.setState({provider:'sano-gateway'})
 slow=true;useRuns.getState().enqueue(['s1']);useRuns.getState().cancel(useRuns.getState().takes[0].id)
 const captured=structuredClone({takes:useRuns.getState().takes,credits:100,spent:0})
 await flush();await vi.advanceTimersByTimeAsync(600)
 expect(db.values.get(`runs:${project.id}`).takes[0].account).toBe(accountKey('fixture-B'))
 // A delayed writer captured this snapshot before the binding transaction committed.
 useRuns.getState().loadRuns(captured);await flush()
 const saved=db.values.get(`runs:${project.id}`).takes[0]
 expect(saved).toMatchObject({status:'cancelled',account:accountKey('fixture-B'),remoteId:null})
 expect(saved.accountBindingPending).toBeUndefined()
})

it('deleting one pending take does not discard the surviving takes committed binding', async()=>{
 p?.reset();useRuns.getState().loadRuns({takes:[],credits:100,spent:0});await flush()
 if(useProject.getState().project.id!==project.id)await switchProject(project.id)
 useProject.setState(s=>({project:{...s.project,scenes:[...project.scenes,{...project.scenes[0],id:'s2',order:2}]}}))
 let slow=false
 p=createSanoGatewayProvider({available:()=>true,getBlob:async()=>null,token:()=>slow?new Promise(resolve=>setTimeout(()=>resolve(tokens.B),500)):Promise.resolve(tokens.A),fetch:async(url,init)=>{
  if(url.endsWith('/capabilities'))return Response.json({mode:'simulator',models})
  expect((init.headers as Record<string,string>).Authorization).toBe(`Bearer ${tokens.B}`)
  return Response.json({id:'B_survivor',status:'running',mode:'simulator'},{status:202})
 }})
 await p.refreshLimits({force:true});registerProvider(p);useProviderPrefs.setState({provider:'sano-gateway'})
 slow=true;expect(useRuns.getState().enqueue(['s1','s2']).queued).toBe(2)
 const [removed,survivor]=useRuns.getState().takes.slice(-2)
 useRuns.getState().removeTakes([removed.id])
 await vi.advanceTimersByTimeAsync(600)
 const remaining=useRuns.getState().takes.find(t=>t.id===survivor.id)!
 expect(remaining.account).toBe(accountKey('fixture-B'))
 expect(remaining.accountBindingPending).toBeUndefined()
 useRuns.getState().cancel(survivor.id);await flush()
 await switchProject(other.id);await switchProject(project.id)
 expect(useRuns.getState().takes.some(t=>t.id===removed.id)).toBe(false)
 expect(useRuns.getState().takes.find(t=>t.id===survivor.id)?.account).toBe(accountKey('fixture-B'))
 useProject.setState(s=>({project:{...s.project,scenes:project.scenes}}))
})

it.each(['null','reject','storage-abort'] as const)('unverified identity stays parked after reopen (%s)', async(failure)=>{
 p?.reset();useRuns.getState().loadRuns({takes:[],credits:100,spent:0});await flush()
 if(useProject.getState().project.id!==project.id)await switchProject(project.id)
 let slow=false;const calls:string[]=[]
 p=createSanoGatewayProvider({available:()=>true,getBlob:async()=>null,token:()=>slow?new Promise((resolve,reject)=>setTimeout(()=>failure==='reject'?reject(new Error('fixture host failure')):resolve(failure==='null'?null:tokens.B),500)):Promise.resolve(tokens.A),fetch:async(url)=>{
  if(url.endsWith('/capabilities'))return Response.json({mode:'simulator',models})
  calls.push(url);throw new Error(`Unexpected job request ${url}`)
 }})
 await p.refreshLimits({force:true});registerProvider(p);useProviderPrefs.setState({provider:'sano-gateway'})
 slow=true;expect(useRuns.getState().enqueue(['s1']).queued).toBe(1)
 const id=useRuns.getState().takes[0].id
 await switchProject(other.id)
 try {
  db.abort=failure==='storage-abort';await vi.advanceTimersByTimeAsync(600)
 } finally {db.abort=false}
 slow=false;await p.refreshLimits({force:true})
 await switchProject(project.id);await vi.advanceTimersByTimeAsync(1_000)
 expect(useRuns.getState().takes[0]).toMatchObject({id,status:'queued',account:accountKey('fixture-A'),accountBindingPending:true,remoteId:null})
 expect(calls).toEqual([])
 useRuns.getState().cancel(id);await flush()
})

it('a late identity never replaces the owner of a job already submitted by another build', async()=>{
 p?.reset();useRuns.getState().loadRuns({takes:[],credits:100,spent:0});await flush()
 if(useProject.getState().project.id!==project.id)await switchProject(project.id)
 let slow=false
 p=createSanoGatewayProvider({available:()=>true,getBlob:async()=>null,token:()=>slow?new Promise(resolve=>setTimeout(()=>resolve(tokens.B),500)):Promise.resolve(tokens.A),fetch:async(url)=>{
  if(url.endsWith('/capabilities'))return Response.json({mode:'simulator',models})
  throw new Error(`Unexpected job request ${url}`)
 }})
 await p.refreshLimits({force:true});registerProvider(p);useProviderPrefs.setState({provider:'sano-gateway'})
 slow=true;useRuns.getState().enqueue(['s1']);await switchProject(other.id)
 const key=`runs:${project.id}`,saved=structuredClone(db.values.get(key)),take=saved.takes[0]
 Object.assign(take,{status:'processing',remoteId:'A_existing',startedAt:1,accountBindingPending:undefined})
 db.values.set(key,saved)
 const rev=db.values.get(`rev:${project.id}`);db.values.set(`rev:${project.id}`,{rev:(rev?.rev??0)+1,tab:'fixture-other-tab',at:0})
 await vi.advanceTimersByTimeAsync(600)
 expect(db.values.get(key).takes[0]).toMatchObject({account:accountKey('fixture-A'),remoteId:'A_existing',status:'processing'})
})

it.each([false,true])('a second tab cannot submit the cached owner while identity is pending (cancel=%s)', async(cancel)=>{
 p?.reset();useRuns.getState().loadRuns({takes:[],credits:100,spent:0});await flush()
 if(useProject.getState().project.id!==project.id)await switchProject(project.id)
 useRuns.getState().loadRuns({takes:[],credits:100,spent:0});await flush()
 let slow=false
 p=createSanoGatewayProvider({available:()=>true,getBlob:async()=>null,token:()=>slow?new Promise(resolve=>setTimeout(()=>resolve(tokens.B),5_000)):Promise.resolve(tokens.A),fetch:async(url)=>{
  if(url.endsWith('/capabilities'))return Response.json({mode:'simulator',models})
  throw new Error(`Origin tab must not send a job: ${url}`)
 }})
 await p.refreshLimits({force:true});registerProvider(p);useProviderPrefs.setState({provider:'sano-gateway'})
 slow=true;expect(useRuns.getState().enqueue(['s1']).queued).toBe(1)
 const id=useRuns.getState().takes[0].id
 await switchProject(other.id)

 // Fresh modules emulate another tab: the DB is shared, the binding Set / stores / provider are not.
 vi.resetModules()
 const tabRuns=await import('../runs'),tabPersist=await import('../persist'),tabProviders=await import('../../providers')
 const {createSanoGatewayProvider:createGateway}=await import('../../providers/sano/gateway')
 const calls:string[]=[]
 let secondToken=tokens.A
 const second=createGateway({available:()=>true,getBlob:async()=>null,token:async()=>secondToken,fetch:async(url,init)=>{
  if(url.endsWith('/capabilities'))return Response.json({mode:'simulator',models})
  calls.push(`${init.method??'GET'} ${url}`)
  if(init.method==='POST')return Response.json({id:`A_${id}`,status:'running',mode:'simulator'},{status:202})
  return Response.json({status:'running',progress:20,mode:'simulator'})
 }})
 try {
  await second.refreshLimits({force:true});tabProviders.registerProvider(second)
  tabProviders.useProviderPrefs.setState({provider:'sano-gateway'});tabRuns.setEngineLockManager(null)
  localStorage.setItem('bdp:active',project.id);await tabPersist.bootstrap()
  expect(tabRuns.useRuns.getState().takes[0]).toMatchObject({id,status:'queued',account:accountKey('fixture-A')})
  await vi.advanceTimersByTimeAsync(1_000)
  expect(calls).toEqual([])
  expect(tabRuns.parkedReason(tabRuns.useRuns.getState().takes[0])).toContain('xác minh')
  if(cancel)tabRuns.useRuns.getState().cancel(id)
  await tabPersist.flush()
  await vi.advanceTimersByTimeAsync(4_100)
  expect(db.values.get(`runs:${project.id}`).takes[0]).toMatchObject({id,account:accountKey('fixture-B'),remoteId:null})
  expect(db.values.get(`runs:${project.id}`).takes[0].accountBindingPending).toBeUndefined()
  expect(calls).toEqual([])
  secondToken=tokens.B;await second.refreshLimits({force:true})
  await tabPersist.switchProject(other.id);await tabPersist.switchProject(project.id)
  await vi.advanceTimersByTimeAsync(1_000)
  expect(calls.filter(c=>c.startsWith('POST'))).toHaveLength(cancel?0:1)
  if(cancel)expect(tabRuns.useRuns.getState().takes[0].status).toBe('cancelled')
 } finally {
  tabRuns.useRuns.getState().loadRuns({takes:[],credits:100,spent:0});second.reset()
  tabRuns.setEngineHooks({});tabRuns.setEngineLockManager(undefined)
  await vi.advanceTimersByTimeAsync(5_100)
 }
})
