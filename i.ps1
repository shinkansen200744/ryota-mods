# usage-meter を入れる（Windows PowerShell）：irm https://shinkansen200744.github.io/ryota-mods/i.ps1 | iex
$repo = if ($env:REPO) { $env:REPO } else { 'shinkansen200744/ryota-mods' }
claude plugin marketplace add $repo 2>$null; if ($LASTEXITCODE -ne 0) { claude plugin marketplace update ryota-mods }
claude plugin install usage-meter@ryota-mods
Write-Host '入りました。Claude Code を開き直すと、使用量のパネルが出ます（/um でも開けます）'
