import { MutationExecutor } from '../src/frontend/mutations/executor'
const nativeMap = Array.prototype.map
let passes = 0
Array.prototype.map = function (this: any[], cb: any, t?: any) {
  const out = nativeMap.call(this, cb, t)
  const h = out[0]
  if (h && typeof h === 'object' && 'mutationId' in h) passes++
  return out
}
async function run(n: number) {
  const b = passes
  const muts = Array.from({length: n}, (_, i) => ({
    mutationId: `m${i}`, characterId: `c${i}`, characterName: `c${i}`, op: 'remove' as const,
    tag: 'Dragon', sourceTags: ['Dragon'], addedTags: [], removedTags: ['Dragon'],
    targetTags: [], beforeTags: ['Dragon'], intendedChange: 'remove Dragon',
  }))
  const preview: any = { opId:`op-${n}`, op:'remove', label:'x', tags:['Dragon'], mutations: muts, skipped: [], affectedCharacterIds: muts.map((m:any)=>m.characterId), affectedCharacterCount: n, changeCount: n }
  const server = new Map(muts.map((m:any)=>[m.characterId, {id:m.characterId,name:m.characterId,description:'',personality:'',scenario:'',creator:'',creator_notes:'',system_prompt:'',tags:['Dragon'],image_id:null,created_at:0,updated_at:0}]))
  const port: any = {
    async getCharacter(id:string){return server.get(id)??null},
    async updateTags(id:string,t:string[]){const c={...server.get(id),tags:t};server.set(id,c);return c},
    async getTagsBatch(){return new Map()},
    async updateTagsBatch(us:any[]){return {updated:us.map((u:any)=>{server.set(u.characterId,{...server.get(u.characterId),tags:u.tags});return {id:u.characterId,tags:u.tags}}),failures:[]}},
  }
  await new MutationExecutor(port, {now:()=>1000}).execute(preview)
  return passes - b
}
for (const n of [100,200,400]) { const p = await run(n); console.log(`M=${n} passes=${p} objects=${p*n} objects/M=${p}`) }
Array.prototype.map = nativeMap
