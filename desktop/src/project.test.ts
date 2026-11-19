import { describe, it, expect } from 'vitest';
import { makeProject, readProject, SaveQueue, defaultOptions } from './project';
import { defaultView, normalizeTranscript } from './transcript';
const transcript=normalizeTranscript({segments:[{start:1,end:3,speaker:'SPEAKER_00',words:[{word:'edited',originalText:'original',start:1,end:2,probability:0.6,reviewed:true}]}], mediaName:'interview.mov'});
describe('editable projects',()=>{
  it('restores recording, corrections, speakers, timing and display choices',()=>{
    const view={...defaultView,pauses:true,reviewed:true,timestamps:false};
    const project=readProject(JSON.parse(JSON.stringify(makeProject(transcript,{path:'/recordings/interview.mov',name:'interview.mov'},view,{...defaultOptions,language:'sv',model:'turbo',followPlayback:false}))));
    expect(project.legacy).toBe(false);
    expect(project.recording?.path).toBe('/recordings/interview.mov');
    expect(project.transcript?.segments[0].words[0]).toMatchObject({text:'edited',originalText:'original',reviewed:true,start:1,confidence:0.6});
    expect(project.transcript?.segments[0].speaker).toBe('SPEAKER_00');
    expect(project.view).toEqual(view);
    expect(project.options).toMatchObject({model:'turbo',language:'sv',followPlayback:false});
  });
  it('can save a recording before transcription',()=>{
    const project=readProject(makeProject(null,{path:'interview.mov',name:'interview.mov'},defaultView,defaultOptions));
    expect(project.transcript).toBeNull(); expect(project.recording?.path).toBe('interview.mov');
  });
  it('imports legacy transcripts without treating their original file as an autosave target',()=>{
    const project=readProject(transcript);expect(project.legacy).toBe(true);expect(project.recording).toBeNull();
  });
  it('rejects future projects and broken recording references',()=>{
    expect(()=>readProject({format:'transcript-studio-project',version:2})).toThrow('newer');
    expect(()=>readProject({...makeProject(transcript,null,defaultView,defaultOptions),recording:{path:2}})).toThrow('recording');
  });
});
describe('autosave ordering',()=>{
  it('waits for an earlier write before starting an explicit save',async()=>{
    const queue=new SaveQueue(); const events:string[]=[];let finish!:()=>void;
    const first=queue.run(async()=>{events.push('old');await new Promise<void>(resolve=>finish=resolve);events.push('old complete');});
    const second=queue.run(async()=>{events.push('new');});
    await Promise.resolve();expect(events).toEqual(['old']); finish();await Promise.all([first,second]);
    expect(events).toEqual(['old','old complete','new']);
  });
  it('allows retry after a failed save',async()=>{
    const queue=new SaveQueue();await expect(queue.run(async()=>{throw new Error('Disk full');})).rejects.toThrow('Disk full');
    await expect(queue.run(async()=> 'saved')).resolves.toBe('saved');
  });
});
