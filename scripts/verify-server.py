"""Server-side bounded suites. Always uses isolated task data and managed Studio."""
import argparse,datetime,json,re,subprocess,time
from pathlib import Path
from studioctl import ROOT,NAME,ENV,BASE,lock,inspect,request,run,save,state,production_snapshot

AGENTS={'meeting-prep','information-watch','travel-assistant'}

def verify(spec,run_id):
    if not re.fullmatch('[0-9]{8}T[0-9]{6}-[0-9]{6}',run_id): raise ValueError('Invalid verification ID')
    agents=spec['agents'].split(',')
    if spec['suite'] not in ['agent-api','task-api','all'] or spec['mode'] not in ['mock','deepseek']: raise ValueError('Invalid suite or mode')
    if not agents or len(agents)>3 or len(set(agents))!=len(agents) or not set(agents)<=AGENTS: raise ValueError('Invalid agent selection')
    before=production_snapshot(); started=time.monotonic(); directory=ROOT/'reports'/run_id; directory.mkdir(parents=True)
    report={'runId':run_id,'sourceCommit':spec['commit'],'mode':spec['mode'],'suite':spec['suite'],
        'startedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'passed':False,'uiVerified':False,
        'limitations':['API verification does not verify Studio browser chat.','Events and note libraries are synthetic; no real phone or notification.'],
        'checks':[],'cleanup':{}}
    task_name='xagent-verify-'+run_id.lower(); task_created=False
    try:
        service=request(); container=inspect()
        if not container or container['labels'].get('io.xagent.managed')!='true': raise RuntimeError('Use a managed Studio release')
        expected=spec.get('runtimeDigest')
        if expected:
            if service['build'].get('runtimeDigest')!=expected: raise RuntimeError('Running source differs from requested runtime inputs')
        elif service['build']['commit']!=spec['commit']: raise RuntimeError('Running source differs from requested commit')
        report['repositoryCommit']=spec['commit']; report['sourceCommit']=service['build']['commit']
        if service['draining'] or service['activeRuns']: raise RuntimeError('Studio is draining or already running; no model request sent')
        report['service']=service
        if spec['mode']=='deepseek' and not service['deepseekConfigured']: raise RuntimeError('Server DeepSeek key is missing')
        if spec['suite'] in ['agent-api','all']:
            location='/app/data/verify-'+run_id+'.json'
            try:
                run(['docker','exec',NAME,'node','scripts/verify-agent-api.mjs','--mode',spec['mode'],
                    '--agents',','.join(agents),'--commit',service['build']['commit'],'--output',location],timeout=600)
            finally:
                # Copy only the explicit sanitized report, never logs or environment.
                copied=subprocess.run(['docker','cp',NAME+':'+location,str(directory/'agent-api.json')],capture_output=True)
                if not copied.returncode: report['checks'].append(json.loads((directory/'agent-api.json').read_text()))
            if not report['checks'][-1]['passed']: raise RuntimeError('Agent API verification failed')
        if spec['suite'] in ['task-api','all']:
            data=directory/'task-data'; data.mkdir(mode=0o700)
            existing=subprocess.run(['ss','-H','-ltn','sport = :4491'],capture_output=True,text=True)
            if existing.returncode or existing.stdout.strip(): raise RuntimeError('Cannot prove isolated port 4491 is free')
            run(['docker','run','-d','--name',task_name,'--init','--network','host','--user','1000:1000',
                '--memory','512m','--memory-swap','768m','--cpus','1','--pids-limit','128','--read-only','--no-healthcheck',
                '--tmpfs','/tmp:size=64m,mode=1777','--cap-drop','ALL','--security-opt','no-new-privileges',
                '--env-file',str(ENV),'-e','HOST=127.0.0.1','-e','PORT=4491','-e','DATA_DIR=/app/data',
                '-e','NODE_OPTIONS=--max-old-space-size=320','-v',str(data)+':/app/data',container['image'],'node','dist/server.js'])
            task_created=True
            deadline=time.monotonic()+40
            import urllib.request
            while time.monotonic()<deadline:
                try:
                    with urllib.request.urlopen('http://127.0.0.1:4491/health',timeout=3): break
                except OSError: time.sleep(.5)
            # Node runtime images need not ship Python; execute the image's verifier with host Python.
            verifier=directory/'verify-notes-task-real.py'
            run(['docker','cp',task_name+':/app/scripts/verify-notes-task-real.py',str(verifier)])
            task_report=directory/'task-api.json'
            try:
                run(['python3',str(verifier),'--data',str(data),'--mode',spec['mode'],
                    '--source-commit',service['build']['commit'],'--output',str(task_report)],timeout=400)
            finally:
                if task_report.exists(): report['checks'].append(json.loads(task_report.read_text()))
            if not report['checks'][-1]['passed']: raise RuntimeError('Task API verification failed')
        report['passed']=True
    except Exception as error:
        report['error']={'type':type(error).__name__,'message':str(error)}
    finally:
        if task_created:
            try:
                run(['docker','stop','--time','20',task_name],45); run(['docker','rm',task_name]); report['cleanup']['taskContainerRemoved']=True
            except Exception: report['cleanup']['taskContainerRemoved']=False; report['passed']=False
        report['productionDataUnchanged']=production_snapshot()==before
        if not report['productionDataUnchanged']: report['passed']=False
        report['elapsedSeconds']=round(time.monotonic()-started,3)
        save(directory/'report.json',report)
    return report

def main():
    p=argparse.ArgumentParser(description=__doc__); p.add_argument('--request',required=True); p.add_argument('--run-id',required=True); a=p.parse_args()
    path=Path(a.request).resolve()
    if not path.is_relative_to(ROOT/'requests'): raise ValueError('Request must be inside the managed request directory')
    with lock(): report=verify(json.loads(path.read_text()),a.run_id)
    print(json.dumps({'passed':report['passed'],'runId':a.run_id,'error':report.get('error')}))
    if not report['passed']: raise SystemExit(1)

if __name__=='__main__': main()
