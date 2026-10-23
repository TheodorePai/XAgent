"""Server-side Studio releases. Does not deploy or restart the task service.

Run as the existing non-root deployment user; all state lives under ROOT.
"""
import argparse,contextlib,datetime,hashlib,json,os,re,sqlite3,subprocess,time,urllib.request
from pathlib import Path
from runtime_identity import from_directory

ROOT=Path('/home/ubuntu/xagent-studio')
NAME='xagent-studio'
ENV=Path('/home/ubuntu/xagent-mastra-lab/.env')
BASE='http://127.0.0.1:4411'

def run(args,timeout=900):
    result=subprocess.run([str(x) for x in args],capture_output=True,text=True,timeout=timeout)
    if result.returncode:
        # No environment or provider headers are included in the command or error.
        raise RuntimeError(f'{args[0]} failed (exit {result.returncode}): {result.stderr[-1400:]}')
    return result.stdout.strip()

def inspect(name=NAME):
    fmt='{"id":{{json .Id}},"image":{{json .Image}},"status":{{json .State.Status}},"labels":{{json .Config.Labels}},"mounts":{{json .Mounts}}}'
    value=subprocess.run(['docker','inspect','--format',fmt,name],capture_output=True,text=True)
    if value.returncode:
        if 'No such' in value.stderr: return None
        raise RuntimeError('Cannot inspect Docker container')
    return json.loads(value.stdout)

def request(path='/xagent/status'):
    with urllib.request.urlopen(BASE+path,timeout=8) as response: return json.load(response)

def save(path,value):
    path=Path(path); path.parent.mkdir(parents=True,exist_ok=True)
    temporary=path.with_suffix(path.suffix+'.tmp')
    temporary.write_text(json.dumps(value,ensure_ascii=False,indent=2)+'\n'); temporary.replace(path)

def backup(source,target):
    source,target=Path(source),Path(target)
    if not source.is_file(): raise RuntimeError('Studio database not found')
    target.parent.mkdir(parents=True,exist_ok=True)
    if target.exists(): raise RuntimeError('Backup destination already exists')
    with contextlib.closing(sqlite3.connect('file:'+str(source)+'?mode=ro',uri=True)) as src,contextlib.closing(sqlite3.connect(target)) as dst:
        src.backup(dst)
        if dst.execute('pragma integrity_check').fetchone()[0]!='ok': raise RuntimeError('Backup integrity check failed')
    os.chmod(target,0o600)

def production_snapshot():
    path=Path('/home/ubuntu/xagent-mastra-lab/data/meeting-tasks.sqlite')
    with contextlib.closing(sqlite3.connect('file:'+str(path)+'?mode=ro',uri=True)) as db:
        return {table:hashlib.sha256(json.dumps(db.execute(f'select document from {table} order by id').fetchall()).encode()).hexdigest()
            for table in ['tasks','meeting_runs']}

@contextlib.contextmanager
def lock():
    import fcntl
    if ROOT.is_symlink() or ROOT.resolve()!=ROOT or ROOT==ENV.parent: raise RuntimeError('Unsafe Studio root')
    ROOT.mkdir(mode=0o700,parents=True,exist_ok=True)
    os.chmod(ROOT,0o700)
    with (ROOT/'operations.lock').open('a') as handle:
        try: fcntl.flock(handle,fcntl.LOCK_EX|fcntl.LOCK_NB)
        except BlockingIOError: raise RuntimeError('Another deploy, rollback or verification is active')
        try: yield
        finally: fcntl.flock(handle,fcntl.LOCK_UN)

def state():
    return json.loads((ROOT/'state.json').read_text()) if (ROOT/'state.json').exists() else {}

def status():
    value={'desired':state().get('current'),'container':inspect()}
    try: value['service']=request()
    except Exception: value['service']=None
    return value

def wait_ready(release,seconds=50):
    deadline=time.monotonic()+seconds
    while time.monotonic()<deadline:
        try:
            result=request()
            if result.get('service')=='xagent-studio' and result['build']['release']==release and not result['draining']:
                agents=request('/api/agents')
                capabilities=result.get('capabilities',{'agents':['travel-assistant','meeting-prep','information-watch'],'workflows':[]})
                workflows=request('/api/workflows') if capabilities.get('workflows') else {}
                if set(capabilities['agents'])<=set(agents) and set(capabilities.get('workflows',[]))<=set(workflows): return result
        except (OSError,KeyError,ValueError): pass
        time.sleep(1)
    raise RuntimeError('New Studio failed readiness or version check')

def drain(seconds=180):
    flag=ROOT/'control/draining'; flag.touch()
    deadline=time.monotonic()+seconds; idle=None
    while time.monotonic()<deadline:
        value=request()
        if not value['draining']: raise RuntimeError('Running Studio does not observe drain flag')
        if value['activeRuns']==0:
            idle=idle or time.monotonic()
            if time.monotonic()-idle>=2: return
        else: idle=None
        time.sleep(1)
    raise RuntimeError('Studio drain timed out; current release kept running')

def start(image,release):
    run(['docker','run','-d','--name',NAME,'--init','--network','host','--user','1000:1000',
        '--memory','1280m','--memory-swap','1792m','--cpus','1','--pids-limit','256','--shm-size','128m',
        '--read-only','--tmpfs','/tmp:rw,nosuid,size=192m,uid=1000,gid=1000','--cap-drop','ALL',
        '--security-opt','no-new-privileges','--restart','unless-stopped','--log-opt','max-size=8m','--log-opt','max-file=3',
        '--env-file',str(ENV),'-e','STUDIO_PORT=4411','-e','STUDIO_DATA_DIR=/app/data',
        '-v',str(ROOT/'data')+':/app/data','-v',str(ROOT/'control')+':/app/control:ro',
        '--label','io.xagent.managed=true','--label','io.xagent.release='+release,image])

def switch(image,release,adopt=False,smoke=True):
    previous=inspect(); current=state(); stopped=False; archived=None; candidate=False
    (ROOT/'control').mkdir(exist_ok=True); (ROOT/'data').mkdir(exist_ok=True)
    try:
        if previous:
            managed=previous['labels'].get('io.xagent.managed')=='true'
            if managed:
                if previous['status']!='running': raise RuntimeError('Managed Studio is not running; inspect before deploying')
                drain()
            elif not adopt: raise RuntimeError('Legacy Studio requires explicit --adopt-legacy maintenance switch')
            elif previous['labels'].get('xagent.role')!='studio-dev': raise RuntimeError('Refusing to adopt unknown container')
            run(['docker','stop','--time','30',NAME],60); stopped=True
            source=ROOT/'data/mastra.db'
            if not managed:
                mount=next(m for m in previous['mounts'] if m['Destination']=='/app')
                source=Path(mount['Source'])/'data/studio/mastra.db'
                if (ROOT/'data/mastra.db').exists(): raise RuntimeError('Managed data already exists; will not overwrite it')
            stamp=datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%S%f')
            copy=ROOT/'backups'/f'{stamp}.sqlite'; backup(source,copy)
            if not managed: backup(copy,ROOT/'data/mastra.db')
            archived=NAME+'-saved-'+stamp
            run(['docker','rename',NAME,archived])
            (ROOT/'control/draining').unlink(missing_ok=True)
        candidate=True
        start(image,release); result=wait_ready(release)
        if smoke:
            report=ROOT/'reports'/f'{release}-smoke.json'; report.parent.mkdir(exist_ok=True)
            agent_ids='meeting-prep,information-watch'
            if 'reference-summary' in result.get('capabilities',{}).get('agents',[]): agent_ids+=',reference-summary'
            run(['docker','exec',NAME,'node','scripts/verify-agent-api.mjs','--mode','mock',
                '--agents',agent_ids,'--output','/app/data/deploy-smoke.json'])
            run(['docker','cp',NAME+':/app/data/deploy-smoke.json',str(report)])
            if 'meeting-brief' in result.get('capabilities',{}).get('workflows',[]):
                run(['docker','exec',NAME,'node','scripts/verify-workflow-api.mjs','--mode','mock',
                    '--output','/app/data/deploy-workflow-smoke.json'])
                run(['docker','cp',NAME+':/app/data/deploy-workflow-smoke.json',str(ROOT/'reports'/f'{release}-workflow-smoke.json')])
        record={'release':release,'image':inspect()['image'],'commit':result['build']['commit'],
            'runtimeDigest':result['build'].get('runtimeDigest')}
        save(ROOT/'state.json',{'current':record,'previous':current.get('current'),
            'legacyContainer':archived if adopt else current.get('legacyContainer')})
        return {'passed':True,'current':record,'legacyMaintenance':bool(previous and adopt),
            'backup':str(copy) if previous else None,'archivedContainer':archived}
    except Exception:
        if candidate and inspect():
            run(['docker','stop','--time','15',NAME],40)
            run(['docker','rename',NAME,NAME+'-failed-'+str(time.time_ns())])
        (ROOT/'control/draining').unlink(missing_ok=True)
        if archived:
            run(['docker','rename',archived,NAME]); run(['docker','start',NAME])
        elif stopped: run(['docker','start',NAME])
        raise

def deploy(archive,commit,adopt=False):
    if not re.fullmatch('[0-9a-f]{40}',commit): raise ValueError('A full commit SHA is required')
    import tarfile
    release=commit[:12]+'-'+datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%S')
    directory=ROOT/'releases'/release; directory.mkdir(parents=True)
    with tarfile.open(archive) as tar:
        for member in tar.getmembers():
            if not member.isfile() and not member.isdir(): raise RuntimeError('Source archive contains links or special files')
            if not (directory/member.name).resolve().is_relative_to(directory): raise RuntimeError('Unsafe archive path')
        tar.extractall(directory,filter='data')
    image='xagent-studio:'+release
    log=ROOT/'reports'/f'{release}-build.log'; log.parent.mkdir(exist_ok=True)
    with log.open('w') as output:
        result=subprocess.run(['docker','build','-f',str(directory/'Dockerfile.studio'),
            '--build-arg','SOURCE_COMMIT='+commit,'--build-arg','RELEASE_ID='+release,
            '--build-arg','RUNTIME_DIGEST='+from_directory(directory),'-t',image,str(directory)],
            stdout=output,stderr=subprocess.STDOUT,timeout=1200)
    if result.returncode: raise RuntimeError('Studio image build failed; see '+str(log))
    return switch(image,release,adopt)

def main():
    p=argparse.ArgumentParser(description=__doc__); sub=p.add_subparsers(dest='action',required=True)
    d=sub.add_parser('deploy'); d.add_argument('--archive',required=True); d.add_argument('--commit',required=True); d.add_argument('--adopt-legacy',action='store_true')
    sub.add_parser('status'); sub.add_parser('rollback')
    a=p.parse_args()
    if os.getuid()!=1000: raise RuntimeError('Run as the established uid 1000 deployment user')
    if a.action=='status': print(json.dumps(status(),ensure_ascii=False,indent=2)); return
    with lock():
        before=production_snapshot()
        try:
            if a.action=='deploy': result=deploy(a.archive,a.commit,a.adopt_legacy)
            else:
                prior=state().get('previous')
                if not prior: raise RuntimeError('No managed previous release available')
                result=switch(prior['image'],prior['release'])
            if production_snapshot()!=before: raise RuntimeError('Original task data changed during Studio operation')
            result['productionDataUnchanged']=True
            save(ROOT/'reports'/(a.action+'-'+str(time.time_ns())+'.json'),result)
            print(json.dumps(result,ensure_ascii=False))
        except Exception as error:
            save(ROOT/'reports'/('failed-'+str(time.time_ns())+'.json'),{'passed':False,'action':a.action,'error':str(error)})
            raise

if __name__=='__main__': main()
