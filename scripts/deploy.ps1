$ErrorActionPreference = 'Stop'
$labRoot = Split-Path -Parent $PSScriptRoot
$remoteLab = '/home/ubuntu/xagent-mastra-lab'
Push-Location -LiteralPath $labRoot
try {
  New-Item -ItemType Directory -Path '.cache' -Force | Out-Null
  & tar -czf .cache/xagent-mastra-lab.tgz --exclude=__pycache__ package.json package-lock.json tsconfig.json src tests scripts docs Dockerfile compose.yaml .env.example .dockerignore README.md
  if ($LASTEXITCODE -ne 0) { throw 'Archive creation failed' }
  & ssh -o BatchMode=yes -o StrictHostKeyChecking=yes tencent-server 'test ! -L /home/ubuntu/xagent-mastra-lab && install -d -m 700 /home/ubuntu/xagent-mastra-lab'
  if ($LASTEXITCODE -ne 0) { throw 'Remote directory preparation failed' }
  & scp -o BatchMode=yes .cache/xagent-mastra-lab.tgz "tencent-server:$remoteLab/source.tgz"
  if ($LASTEXITCODE -ne 0) { throw 'Upload failed' }
  & ssh -o BatchMode=yes tencent-server 'cd /home/ubuntu/xagent-mastra-lab && tar -xzf source.tgz && bash scripts/deploy-server.sh'
  if ($LASTEXITCODE -ne 0) { throw 'Deployment or verification failed' }
} finally { Pop-Location }
