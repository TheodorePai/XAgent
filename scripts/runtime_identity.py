"""Identify runtime inputs independently of report-only/documentation commits."""
import hashlib,subprocess
from pathlib import Path

PATHS=['src','scripts','package.json','package-lock.json','tsconfig.json','studio-presets.json','Dockerfile.studio','docs/vendor']

def digest(entries):
    return hashlib.sha256(''.join(f'{path}\0{blob}\n' for path,blob in sorted(entries)).encode()).hexdigest()

def from_git(root):
    output=subprocess.check_output(['git','ls-tree','-rz','--full-tree','HEAD','--',*PATHS],cwd=root,text=True,encoding='utf-8')
    entries=[]
    for line in filter(None,output.split('\0')):
        metadata,path=line.split('\t',1)
        if metadata.split()[1]!='blob': raise ValueError('Runtime inputs cannot contain submodules')
        entries.append((path,metadata.split()[2]))
    return digest(entries)

def from_directory(root):
    root=Path(root); entries=[]
    for name in PATHS:
        path=root/name
        files=sorted(path.rglob('*')) if path.is_dir() else [path]
        for file in files:
            if file.is_symlink(): raise ValueError('Runtime inputs cannot contain symlinks')
            if not file.is_file(): continue
            content=file.read_bytes()
            blob=hashlib.sha1(b'blob '+str(len(content)).encode()+b'\0'+content).hexdigest()
            entries.append((file.relative_to(root).as_posix(),blob))
    return digest(entries)
