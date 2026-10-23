import contextlib,json,sqlite3,sys,tarfile,tempfile,unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0,str(Path(__file__).resolve().parent.parent/'scripts'))
import studioctl as ctl

class OperationsTest(unittest.TestCase):
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

if __name__=='__main__': unittest.main()
