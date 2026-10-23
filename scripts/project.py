"""Unified local checks, isolated server verification, and Studio release commands."""
import argparse,datetime,json,os,re,shlex,subprocess,sys,time
from pathlib import Path
from runtime_identity import from_git

REPO=Path(__file__).resolve().parent.parent
REMOTE='/home/ubuntu/xagent-studio'

def command(args,timeout=1200,capture=False):
    result=subprocess.run([str(x) for x in args],cwd=REPO,text=True,encoding='utf-8',stdout=subprocess.PIPE if capture else None,
        stderr=subprocess.PIPE if capture else None,timeout=timeout)
    if result.returncode: raise RuntimeError(f'{args[0]} exited {result.returncode}')
    return result.stdout.strip() if capture else None

def revision():
    if command(['git','status','--porcelain'],capture=True): raise RuntimeError('Commit changes before server deployment or verification')
    return command(['git','rev-parse','HEAD'],capture=True)

def remote(host,args,timeout=1200,capture=False):
    if host!='tencent-server': raise ValueError('Only configured tencent-server is supported')
    return command(['ssh','-o','BatchMode=yes','-o','StrictHostKeyChecking=yes',host,shlex.join([str(x) for x in args])],timeout,capture)

def verify_remote(args,commit):
    request={'suite':args.suite,'mode':args.mode,'agents':args.agents,'commit':commit,'runtimeDigest':from_git(REPO)}
    run_id=datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%S')+'-'+str(time.time_ns())[-6:]
    target=REPO/'.cache'/f'verify-{run_id}.json'; target.parent.mkdir(exist_ok=True)
    target.write_text(json.dumps(request),encoding='utf-8'); destination=REMOTE+'/requests/'+run_id+'.json'
    fallback={'passed':False,'uiVerified':False,'runId':run_id,'requestedCommit':commit,'suite':args.suite,'mode':args.mode,'checks':[]}
    try:
        remote(args.host,['mkdir','-p',REMOTE+'/requests'])
        command(['scp',str(target),args.host+':'+destination])
        remote(args.host,['python3',REMOTE+'/controller/verify-server.py','--request',destination,'--run-id',run_id],timeout=900)
    except Exception as error:
        fallback['error']={'type':type(error).__name__,'message':str(error)}
        raise
    finally:
        # A failing verification still leaves a report. Do not hide the original exit code.
        saved=subprocess.run(['scp',args.host+':'+REMOTE+'/reports/'+run_id+'/report.json',str(args.output)],cwd=REPO,capture_output=True)
        if saved.returncode:
            Path(args.output).write_text(json.dumps(fallback,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
            print('No remote report could be retrieved; inspect the verification host.',file=sys.stderr)

def main():
    p=argparse.ArgumentParser(description=__doc__); sub=p.add_subparsers(dest='action',required=True)
    v=sub.add_parser('verify'); v.add_argument('--suite',choices=['local','agent-api','workflow-api','task-api','all'],default='local')
    v.add_argument('--mode',choices=['mock','deepseek'],default='mock')
    v.add_argument('--agents',default='meeting-prep,information-watch,travel-assistant,reference-summary')
    v.add_argument('--host',default='tencent-server'); v.add_argument('--output',default='.cache/verification-latest.json')
    d=sub.add_parser('studio'); d.add_argument('operation',choices=['deploy','status','rollback']); d.add_argument('--host',default='tencent-server')
    d.add_argument('--adopt-legacy',action='store_true')
    a=p.parse_args()
    if a.action=='verify':
        commit=revision() if a.suite!='local' else None
        output=Path(a.output); output=output if output.is_absolute() else REPO/output
        output.parent.mkdir(parents=True,exist_ok=True); a.output=output
        if a.suite in ['local','all']:
            started=time.monotonic(); passed=False
            try:
                command(['npm.cmd' if os.name=='nt' else 'npm','test']); passed=True
            finally:
                local={'type':'local','passed':passed,'elapsedSeconds':round(time.monotonic()-started,3),'realModelCalled':False,'uiVerified':False}
                output.write_text(json.dumps(local,indent=2)+'\n',encoding='utf-8')
            if a.suite=='local': return
        try: verify_remote(a,commit)
        finally:
            if a.suite=='all':
                result=json.loads(output.read_text(encoding='utf-8')); result['local']=local; output.write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
        return
    if a.operation=='status':
        remote(a.host,['python3',REMOTE+'/controller/studioctl.py','status']); return
    if a.operation=='rollback':
        remote(a.host,['python3',REMOTE+'/controller/studioctl.py','rollback']); return
    commit=revision(); release=commit[:12]+'-'+str(time.time_ns())
    archive=REPO/'.cache'/f'studio-{release}.tgz'; archive.parent.mkdir(exist_ok=True)
    command(['git','-c','core.autocrlf=false','archive','--format=tar.gz','-o',str(archive),commit])
    # Controller tools are source from exactly the archived commit, uploaded separately for bootstrap.
    remote(a.host,['mkdir','-p',REMOTE+'/controller',REMOTE+'/incoming'])
    for name in ['studioctl.py','verify-server.py','runtime_identity.py']:
        command(['scp',str(REPO/'scripts'/name),a.host+':'+REMOTE+'/controller/'+name])
    destination=REMOTE+'/incoming/'+release+'.tgz'
    command(['scp',str(archive),a.host+':'+destination])
    deployment=['python3',REMOTE+'/controller/studioctl.py','deploy','--archive',destination,'--commit',commit]
    if a.adopt_legacy: deployment.append('--adopt-legacy')
    remote(a.host,deployment,timeout=1800)

if __name__=='__main__':
    try: main()
    except (RuntimeError,subprocess.TimeoutExpired,ValueError) as error:
        print(str(error),file=sys.stderr); sys.exit(1)
