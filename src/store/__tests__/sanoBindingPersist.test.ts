// Regression fixture: actual persist/runs/gateway with fake IndexedDB, media and host tokens.
import { afterAll, beforeAll, expect, it, vi } from 'vitest'
const db = vi.hoisted(() => ({ values: new Map<string, any>(), writes: [] as string[], reads: [] as string[] }))
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

it.each(['warm-A','stale-A-click-B'] as const)('%s queued ownership survives project switch before fresh token resolves',async(scenario)=>{
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
 if(scenario==='stale-A-click-B')current='B'
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
 await vi.advanceTimersByTimeAsync(600) // fresh account at Run finishes while X is open; original project's take is absent
 expect(p.account()).toBe(accountKey(`fixture-${intended}`))
 expect(useProject.getState().project.name).toBe('Edited other project while binding')
 const savedAfter=structuredClone(db.values.get(`runs:${project.id}`))
 expect(savedAfter.takes[0].account).toBe(accountKey(`fixture-${intended}`))
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
