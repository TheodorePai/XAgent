import contextlib,importlib.util,json,sqlite3,subprocess,sys,tarfile,tempfile,unittest
from types import SimpleNamespace
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0,str(Path(__file__).resolve().parent.parent/'scripts'))
import studioctl as ctl
import project
from runtime_identity import from_git,from_directory
spec=importlib.util.spec_from_file_location('verify_server',Path(__file__).resolve().parent.parent/'scripts/verify-server.py')
verifier=importlib.util.module_from_spec(spec); spec.loader.exec_module(verifier)

class OperationsTest(unittest.TestCase):
    def test_all_suite_preserves_chinese_utf8_report_when_merging_local_evidence(self):
        with tempfile.TemporaryDirectory() as path:
            output=Path(path)/'report.json'
            def remote(args,commit): output.write_text(json.dumps({'passed':True,'text':'中文验收证据'},ensure_ascii=False),encoding='utf-8')
            with patch.object(sys,'argv',['project.py','verify','--suite','all','--output',str(output)]),\
                patch.object(project,'revision',return_value='a'*40),patch.object(project,'command'),patch.object(project,'verify_remote',side_effect=remote):
                project.main()
            report=json.loads(output.read_text(encoding='utf-8'))
            self.assertEqual(report['text'],'中文验收证据'); self.assertTrue(report['local']['passed'])
    def test_unreachable_verification_cannot_reuse_a_previous_success_report(self):
        with tempfile.TemporaryDirectory() as path:
            root=Path(path); (root/'.cache').mkdir(); output=root/'report.json'; output.write_text('{"passed":true}')
            args=SimpleNamespace(suite='agent-api',mode='deepseek',agents='meeting-prep',host='tencent-server',output=output)
            with patch.object(project,'REPO',root),patch.object(project,'from_git',return_value='digest'),\
                patch.object(project,'remote',side_effect=RuntimeError('SSH unavailable')),\
                patch.object(project.subprocess,'run',return_value=SimpleNamespace(returncode=1)):
                with self.assertRaisesRegex(RuntimeError,'SSH unavailable'): project.verify_remote(args,'a'*40)
            report=json.loads(output.read_text()); self.assertFalse(report['passed']); self.assertIn('SSH unavailable',report['error']['message'])
    def test_runtime_identity_matches_git_archive_and_ignores_only_non_runtime_docs(self):
        repository=Path(__file__).resolve().parent.parent
        with tempfile.TemporaryDirectory() as path:
            archive=Path(path)/'source.tgz'; root=Path(path)/'source'; root.mkdir()
            subprocess.run(['git','-c','core.autocrlf=false','archive','--format=tar.gz','-o',str(archive),'HEAD'],cwd=repository,check=True)
            with tarfile.open(archive) as tar: tar.extractall(root,filter='data')
            original=from_git(repository); self.assertEqual(from_directory(root),original)
            (root/'README.md').write_text('documentation-only update')
            self.assertEqual(from_directory(root),original)
            with (root/'src/server.ts').open('a') as source: source.write('\n// runtime input changed\n')
            self.assertNotEqual(from_directory(root),original)
    def test_backup_includes_live_wal_and_refuses_overwrite(self):
        with tempfile.TemporaryDirectory() as path:
            source,target=Path(path)/'source.db',Path(path)/'backup.db'
            db=sqlite3.connect(source); db.execute('pragma journal_mode=WAL')
            db.execute('create table messages(text)'); db.execute('insert into messages values(?)',('keep-me',)); db.commit()
            ctl.backup(source,target)
            with contextlib.closing(sqlite3.connect(target)) as copy: self.assertEqual(copy.execute('select text from messages').fetchone()[0],'keep-me')
            with self.assertRaises(RuntimeError): ctl.backup(source,target)
            db.close()

    def test_unsafe_archive_cannot_run_docker(self):
        with tempfile.TemporaryDirectory() as path:
            root=Path(path)/'managed'; root.mkdir(); archive=Path(path)/'bad.tgz'
            with tarfile.open(archive,'w:gz') as tar:
                info=tarfile.TarInfo('../escape'); info.size=0; tar.addfile(info)
            with patch.object(ctl,'ROOT',root),patch.object(ctl.subprocess,'run') as docker:
                with self.assertRaises(RuntimeError): ctl.deploy(str(archive),'a'*40)
                docker.assert_not_called()
            self.assertFalse((root/'escape').exists())

    def test_drain_failure_keeps_original_service_and_clears_flag(self):
        with tempfile.TemporaryDirectory() as path:
            root=Path(path); previous={'labels':{'io.xagent.managed':'true'},'status':'running'}
            with patch.object(ctl,'ROOT',root),patch.object(ctl,'inspect',return_value=previous),patch.object(ctl,'state',return_value={}),\
                patch.object(ctl,'drain',side_effect=RuntimeError('timeout')),patch.object(ctl,'run') as run:
                with self.assertRaisesRegex(RuntimeError,'timeout'): ctl.switch('new-image','new-release')
                run.assert_not_called()
            self.assertFalse((root/'control/draining').exists())

    def test_failed_readiness_restores_original_container_without_replacing_chat_database(self):
        with tempfile.TemporaryDirectory() as path:
            root=Path(path); (root/'data').mkdir()
            with contextlib.closing(sqlite3.connect(root/'data/mastra.db')) as db, db:
                db.execute('create table messages(text)'); db.execute("insert into messages values('existing-chat')")
            previous={'labels':{'io.xagent.managed':'true'},'status':'running'}; calls=[]
            def run(args,*rest): calls.append(args); return ''
            with patch.object(ctl,'ROOT',root),patch.object(ctl,'inspect',return_value=previous),patch.object(ctl,'state',return_value={}),\
                patch.object(ctl,'drain'),patch.object(ctl,'run',side_effect=run),patch.object(ctl,'start'),\
                patch.object(ctl,'wait_ready',side_effect=RuntimeError('readiness failure')):
                with self.assertRaisesRegex(RuntimeError,'readiness failure'): ctl.switch('new-image','new-release')
            self.assertTrue(any(c[:2]==['docker','start'] for c in calls))
            self.assertTrue(any(c[:2]==['docker','rename'] and '-saved-' in c[2] and c[3]==ctl.NAME for c in calls))
            with contextlib.closing(sqlite3.connect(root/'data/mastra.db')) as db: self.assertEqual(db.execute('select text from messages').fetchone()[0],'existing-chat')
            self.assertEqual(len(list((root/'backups').glob('*.sqlite'))),1)

    def test_unknown_legacy_container_is_not_stopped(self):
        with tempfile.TemporaryDirectory() as path:
            with patch.object(ctl,'ROOT',Path(path)),patch.object(ctl,'inspect',return_value={'labels':{}}),\
                patch.object(ctl,'state',return_value={}),patch.object(ctl,'run') as run:
                with self.assertRaisesRegex(RuntimeError,'unknown container'): ctl.switch('new-image','new-release',adopt=True)
                run.assert_not_called()

    def test_readiness_supports_old_release_without_workflow_capabilities(self):
        responses={'/xagent/status':{'service':'xagent-studio','build':{'release':'old'},'draining':False},
            '/api/agents':{'meeting-prep':{},'information-watch':{},'travel-assistant':{}}}
        with patch.object(ctl,'request',side_effect=lambda path='/xagent/status':responses[path]):
            self.assertEqual(ctl.wait_ready('old')['build']['release'],'old')

    def test_readiness_checks_declared_workflow_registration(self):
        service={'service':'xagent-studio','build':{'release':'new'},'draining':False,
            'capabilities':{'agents':['reference-summary'],'workflows':['meeting-brief']}}
        responses={'/xagent/status':service,'/api/agents':{'reference-summary':{}},'/api/workflows':{}}
        with patch.object(ctl,'request',side_effect=lambda path='/xagent/status':responses[path]),patch.object(ctl.time,'monotonic',side_effect=[0,0,2]),patch.object(ctl.time,'sleep'):
            with self.assertRaisesRegex(RuntimeError,'readiness'): ctl.wait_ready('new',seconds=1)
        responses['/api/workflows']={'meeting-brief':{}}
        with patch.object(ctl,'request',side_effect=lambda path='/xagent/status':responses[path]):
            self.assertEqual(ctl.wait_ready('new')['build']['release'],'new')

    def test_version_mismatch_leaves_failed_report_without_model_request(self):
        with tempfile.TemporaryDirectory() as path:
            with patch.object(verifier,'ROOT',Path(path)),patch.object(verifier,'production_snapshot',return_value={'tasks':'same'}),\
                patch.object(verifier,'inspect',return_value={'labels':{'io.xagent.managed':'true'}}),\
                patch.object(verifier,'request',return_value={'build':{'commit':'old'}}),patch.object(verifier,'run') as run:
                report=verifier.verify({'suite':'agent-api','mode':'deepseek','agents':'meeting-prep','commit':'new'},'20261023T010203-123456')
                self.assertFalse(report['passed']); self.assertIn('source differs',report['error']['message'])
                run.assert_not_called(); self.assertEqual(report['checks'],[])
                self.assertTrue((Path(path)/'reports/20261023T010203-123456/report.json').is_file())

    def test_failed_task_verification_removes_only_its_container_and_retains_report(self):
        with tempfile.TemporaryDirectory() as path:
            calls=[]
            def run(args,*rest,**kwargs):
                calls.append(args)
                if args[0]=='python3':
                    Path(args[-1]).write_text(json.dumps({'passed':False,'checks':[]}))
                    raise RuntimeError('expected model failure')
                return ''
            with patch.object(verifier,'ROOT',Path(path)),patch.object(verifier,'production_snapshot',return_value={'tasks':'same'}),\
                patch.object(verifier,'inspect',return_value={'labels':{'io.xagent.managed':'true'},'image':'sha256:test'}),\
                patch.object(verifier,'request',return_value={'build':{'commit':'new'},'draining':False,'activeRuns':0}),\
                patch.object(verifier,'run',side_effect=run),patch.object(verifier.subprocess,'run',return_value=SimpleNamespace(returncode=0,stdout='')),\
                patch('urllib.request.urlopen',return_value=contextlib.nullcontext()):
                report=verifier.verify({'suite':'task-api','mode':'mock','agents':'meeting-prep','commit':'new'},'20261023T010204-123456')
            self.assertFalse(report['passed']); self.assertTrue(report['cleanup']['taskContainerRemoved'])
            self.assertTrue(report['productionDataUnchanged'])
            self.assertIn(['docker','rm','xagent-verify-20261023t010204-123456'],calls)
            self.assertFalse(any(ctl.NAME in c for c in calls))

if __name__=='__main__': unittest.main()
