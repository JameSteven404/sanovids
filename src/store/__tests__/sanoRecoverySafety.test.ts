import { jwt } from '../../providers/__tests__/insideSano'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
const saved = vi.hoisted(()=>({blobs:[] as {prefix:string,size:number}[]}))
vi.mock('../../lib/imageStore',()=>({putBlob:vi.fn(async(b:Blob,prefix='img')=>{saved.blobs.push({prefix,size:b.size});return prefix+'-fixture'}),getBlob:vi.fn(async()=>null),getUrl:vi.fn(async()=>null),cachedUrl:()=>null,deleteMedia:vi.fn(async()=>undefined),dataUrlToBlob:()=>new Blob(),useMediaUrl:()=>null}))
import { createSanoGatewayProvider } from '../../providers/sano/gateway'
import { getProvider,registerProvider } from '../../providers'
import { useRuns,setEngineLockManager,setEngineHooks,requestInFlight } from '../runs'
import { useProject } from '../project'
import { putBlob } from '../../lib/imageStore'

const original=getProvider('sano-gateway')
const settings={model:'seedance_2_5',mode:'t2v',duration:5,resolution:'480p',ratio:'16:9'} as const
const models=[{id:'seedance_2_5',label:'Fixture',ratios:['16:9'],resolutions:['480p'],durations:[5],maxRefs:4}]
const project:any={id:'fixture-supplement',name:'Fixture',schemaVersion:2,createdAt:0,updatedAt:0,settings:{autoRenumber:true},assets:[],presets:[],scenes:[{id:'s1',order:1,title:'Scene',prompt:'Walk',refs:[],videoRefs:[],presetId:null,settings,firstFrame:null,lastFrame:null,color:null,position:{x:0,y:0},note:''}]}
const take=(id:string,extra:any={}):any=>({id,sceneId:'s1',number:1,status:'queued',progress:0,createdAt:1,startedAt:null,finishedAt:null,promptSnapshot:'Walk',rawPromptSnapshot:'Walk',refsSnapshot:[],videoRefsSnapshot:[],imageKeysSnapshot:[],settings,cost:4,starred:false,posterId:null,videoId:null,error:null,position:null,provider:'sano-gateway',remoteId:null,charged:false,...extra})
beforeEach(()=>{vi.stubGlobal('fetch',()=>{throw new Error('External HTTP forbidden')});vi.useFakeTimers();vi.stubEnv('VITE_SANO_GATEWAY','1');vi.stubGlobal('window',{location:{origin:'https://sano.example'},parent:{location:{origin:'https://sano.example'}}});setEngineLockManager(null);setEngineHooks({});useProject.getState().loadProject(project);useRuns.getState().loadRuns({takes:[],credits:100,spent:0});saved.blobs=[]})
afterEach(()=>{useRuns.getState().loadRuns({takes:[],credits:100,spent:0});vi.advanceTimersByTime(250);vi.useRealTimers();registerProvider(original);setEngineLockManager(undefined);setEngineHooks({});vi.unstubAllEnvs();vi.unstubAllGlobals()})

it.each(['submit','recover'])('stopping a pending %s cancels the queued SANO job once its id arrives',async(kind)=>{
 const id='cancel-pending-'+kind;let answer:(r:Response)=>void=()=>{};const calls:any[]=[]
 const pending=new Promise<Response>(resolve=>{answer=resolve})
 const p=createSanoGatewayProvider({token:async()=>jwt({sub:'fixture-A',exp:4_000_000_000}),available:()=>true,getBlob:async()=>null,fetch:async(url,init)=>{
  calls.push({url,method:init.method??'GET'})
  if(url.endsWith('/capabilities'))return Response.json({mode:'simulator',models})
  if(url.endsWith('/cancel'))return Response.json({id:'late-queued-job',status:'cancelled',mode:'simulator'})
  if((kind==='submit'&&url.endsWith('/jobs')&&init.method==='POST')||(kind==='recover'&&url.includes('?idempotencyKey=')))return pending
  return Response.json({id:'late-queued-job',status:'queued',mode:'simulator'})
 }})
 try {
  await p.refreshLimits({force:true});registerProvider(p)
  useRuns.getState().loadRuns({takes:[take(id,{...(kind==='recover'?{status:'processing',startedAt:1}:{}),account:p.account()})],credits:100,spent:0})
  await vi.advanceTimersByTimeAsync(250)
  expect(requestInFlight(id)).toBe(true)
  useRuns.getState().cancel(id)
  expect(calls.filter(c=>c.url.endsWith('/cancel'))).toHaveLength(0)
  answer(Response.json({id:'late-queued-job',status:'queued',mode:'simulator'},{status:kind==='submit'?202:200}))
  await vi.advanceTimersByTimeAsync(1_000)
  const final=structuredClone(useRuns.getState().takes[0]);const cancels=calls.filter(c=>c.url.endsWith('/cancel'))
  expect(final).toMatchObject({status:'cancelled',remoteId:'late-queued-job',simulated:true})
  expect(cancels).toHaveLength(1)
  expect(cancels[0].method).toBe('POST')
 }finally{p.reset()}
})

it.each([null,'A_legacy'])('legacy unknown owner with remoteId=%s stays unbound after B404 and recovers under A',async(remoteId)=>{
 let owner='B';const calls:any[]=[]
 const p=createSanoGatewayProvider({available:()=>true,getBlob:async()=>null,token:async()=>jwt({sub:owner,exp:4_000_000_000}),fetch:async(url,init)=>{
  calls.push({url,method:init.method??'GET',owner})
  if(url.endsWith('/capabilities'))return Response.json({mode:'simulator',models})
  if(url.includes('?idempotencyKey='))return owner==='A'?Response.json({id:'A_legacy',status:'running',mode:'simulator'}):Response.json({error:'not found'},{status:404})
  if(url.endsWith('/jobs/A_legacy'))return owner==='A'?Response.json({id:'A_legacy',status:'running',mode:'simulator',progress:40}):Response.json({error:'not found'},{status:404})
  throw new Error('Unexpected request '+url)
 }})
 try{
  await p.refreshLimits({force:true});registerProvider(p)
  useRuns.getState().loadRuns({takes:[take('legacy',{status:'processing',startedAt:1,remoteId})],credits:100,spent:0})
  await vi.advanceTimersByTimeAsync(1000)
  expect(useRuns.getState().takes[0]).toMatchObject({id:'legacy',status:'processing',remoteId})
  expect(useRuns.getState().takes[0].account).toBeUndefined()
  expect(calls.filter(c=>c.url.endsWith('/jobs/A_legacy'))).toHaveLength(0)
  owner='A';await p.refreshLimits({force:true});await vi.advanceTimersByTimeAsync(16_000)
  expect(useRuns.getState().takes[0]).toMatchObject({id:'legacy',status:'processing',remoteId:'A_legacy',account:p.account()})
  expect(calls.filter(c=>c.method==='POST')).toHaveLength(0)
 }finally{p.reset()}
})

it('late recovered queued job is not cancelled under a different account', async () => {
  let owner = 'A'
  let answer!: (response: Response) => void
  const pending = new Promise<Response>((resolve) => { answer = resolve })
  const calls: { url: string; method: string; owner: string }[] = []
  const p = createSanoGatewayProvider({
    available: () => true, getBlob: async () => null,
    token: async () => jwt({ sub: owner, exp: 4_000_000_000 }),
    fetch: async (url, init) => {
      calls.push({ url, method: init.method ?? 'GET', owner })
      if (url.endsWith('/capabilities')) return Response.json({ mode: 'simulator', models })
      if (url.includes('?idempotencyKey=')) return pending
      throw new Error('Unexpected request ' + url)
    },
  })
  try {
    await p.refreshLimits({ force: true }); registerProvider(p)
    useRuns.getState().loadRuns({ takes: [take('late-account', { status: 'processing', startedAt: 1, account: p.account() })], credits: 100, spent: 0 })
    await vi.advanceTimersByTimeAsync(250)
    useRuns.getState().cancel('late-account')
    owner = 'B'; await p.refreshLimits({ force: true })
    answer(Response.json({ id: 'A_late-account', status: 'queued', mode: 'simulator' }))
    await vi.advanceTimersByTimeAsync(1000)
    expect(useRuns.getState().takes[0]).toMatchObject({ status: 'cancelled', remoteId: 'A_late-account' })
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(0)
  } finally { p.reset() }
})

it.each(['complete', 'cancel', 'error'])('keeps the result lease through persistence, releasing it on %s', async (outcome) => {
  const release = vi.fn()
  let finish!: (id: string) => void
  let fail!: (error: Error) => void
  const pending = new Promise<string>((resolve, reject) => { finish = resolve; fail = reject })
  vi.mocked(putBlob).mockImplementation(async (_blob, prefix) => prefix === 'video' ? pending : 'poster-fixture')
  const p = createSanoGatewayProvider({
    available: () => true, getBlob: async () => null,
    token: async () => jwt({ sub: 'A', exp: 4_000_000_000 }),
    fetch: async (url) => url.endsWith('/capabilities')
      ? Response.json({ mode: 'simulator', models })
      : Response.json({ id: 'A_video', status: 'done', mode: 'simulator' }),
  })
  p.fetchResult = async () => ({ video: new Blob(['video']), poster: new Blob(['poster']), release })
  try {
    await p.refreshLimits({ force: true }); registerProvider(p)
    useRuns.getState().loadRuns({ takes: [take('video', { status: 'processing', startedAt: 1, remoteId: 'A_video', account: p.account() })], credits: 100, spent: 0 })
    await vi.advanceTimersByTimeAsync(1000)
    expect(putBlob).toHaveBeenCalledWith(expect.any(Blob), 'video')
    expect(release).not.toHaveBeenCalled()
    if (outcome === 'cancel') useRuns.getState().cancel('video')
    if (outcome === 'error') fail(new Error('Fixture persistence failure'))
    else finish('video-fixture')
    await vi.advanceTimersByTimeAsync(100)
    expect(release).toHaveBeenCalledTimes(1)
    expect(useRuns.getState().takes[0].status).toBe(outcome === 'complete' ? 'completed' : outcome === 'cancel' ? 'cancelled' : 'processing')
  } finally {
    p.reset()
    vi.mocked(putBlob).mockImplementation(async (_blob, prefix = 'img') => prefix + '-fixture')
  }
})
