# 1回だけ実行：GitHub にリポジトリを作って上げ、Pages を有効にして、i / i.ps1 の __OWNER__ を自分の名前にする
# 使い方：  .\publish.ps1 あなたのGitHub名     （gh が入っていてログイン済みのこと：winget install GitHub.cli → gh auth login）
param([Parameter(Mandatory)][string]$Owner)
Set-Location $PSScriptRoot
foreach ($f in 'i','i.ps1','README.md') { (Get-Content $f -Raw).Replace('__OWNER__', $Owner).Replace('<owner>', $Owner) | Set-Content $f -NoNewline }
git add -A; git commit -m "公開用に名前を入れる" | Out-Null
gh repo create "$Owner/ryota-mods" --public --source . --push
gh api -X POST "repos/$Owner/ryota-mods/pages" -f "source[branch]=master" -f "source[path]=/" | Out-Null
Write-Host "公開しました。ほかの人に送る1行："
Write-Host "  Windows:   irm $Owner.github.io/ryota-mods/i.ps1 | iex"
Write-Host "  Mac/Linux: curl -fsSL $Owner.github.io/ryota-mods/i | sh"
