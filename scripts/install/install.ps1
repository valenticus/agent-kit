param(
  [Parameter(Mandatory=$true)][string]$ProjectRoot,
  [string[]]$Tools = @('codex'),
  [string[]]$Skills = @('safe-change','debugging','final-audit','product-ux','mobile-design','design-critique','security','ui'),
  [string[]]$OptionalSkills = @(),
  [switch]$CopilotAuditor
)
$ErrorActionPreference = 'Stop'
$kitRoot = Resolve-Path (Join-Path $PSScriptRoot '..\..')
$project = Resolve-Path $ProjectRoot
$Tools = @($Tools | ForEach-Object { $_ -split ',' } | ForEach-Object { $_.Trim() } | Where-Object { $_ })
$Skills = @($Skills | ForEach-Object { $_ -split ',' } | ForEach-Object { $_.Trim() } | Where-Object { $_ })
$OptionalSkills = @($OptionalSkills | ForEach-Object { $_ -split ',' } | ForEach-Object { $_.Trim() } | Where-Object { $_ })
$allowedTools = @('codex','cline','kilo','copilot','claude')
foreach ($tool in $Tools) { if ($tool -notin $allowedTools) { throw "Unknown tool: $tool" } }
function Install-Skill([string]$skill, [string]$source) {
  if (@('codex','kilo','copilot','claude') | Where-Object { $_ -in $Tools }) {
    $destination = Join-Path $project ".agents\skills\$skill"
    if (Test-Path -LiteralPath $destination) { throw "Refusing to overwrite $destination" }
    New-Item -ItemType Directory -Force -Path (Split-Path $destination) | Out-Null
    Copy-Item -Recurse -LiteralPath $source -Destination $destination
  }
  if ('cline' -in $Tools) {
    $destination = Join-Path $project ".cline\skills\$skill"
    if (Test-Path -LiteralPath $destination) { throw "Refusing to overwrite $destination" }
    New-Item -ItemType Directory -Force -Path (Split-Path $destination) | Out-Null
    Copy-Item -Recurse -LiteralPath $source -Destination $destination
  }
}

if ($CopilotAuditor -and 'copilot' -notin $Tools) { throw '-CopilotAuditor requires copilot in -Tools' }
$claudeAdapter = Join-Path $kitRoot 'scripts/install/claude-adapter.mjs'
function Invoke-ClaudeAdapter([string]$command) {
  & node $claudeAdapter $command --project $project.Path
  if ($LASTEXITCODE -ne 0) { throw "Claude adapter $command failed (exit $LASTEXITCODE)" }
}
if ('claude' -in $Tools) {
  if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw 'The Claude adapter requires Node.js (also used by its SessionStart bootstrap) on PATH' }
  Invoke-ClaudeAdapter 'preflight'
}
if ('copilot' -in $Tools) {
  $instructionsDestination = Join-Path $project '.github\copilot-instructions.md'
  if (Test-Path -LiteralPath $instructionsDestination) { throw ('Refusing to overwrite ' + $instructionsDestination) }
  New-Item -ItemType Directory -Force -Path (Split-Path $instructionsDestination) | Out-Null
  Copy-Item -LiteralPath (Join-Path $kitRoot 'adapters\copilot\copilot-instructions.md') -Destination $instructionsDestination
  if ($CopilotAuditor) {
    $auditorDestination = Join-Path $project '.github\agents\project-auditor.agent.md'
    if (Test-Path -LiteralPath $auditorDestination) { throw ('Refusing to overwrite ' + $auditorDestination) }
    New-Item -ItemType Directory -Force -Path (Split-Path $auditorDestination) | Out-Null
    Copy-Item -LiteralPath (Join-Path $kitRoot 'adapters\copilot\project-auditor.agent.md') -Destination $auditorDestination
  }
}

foreach ($skill in $Skills) {
  $source = Join-Path $kitRoot "core\skills\$skill"
  if (!(Test-Path -LiteralPath $source)) { throw "Unknown core skill: $skill" }
  Install-Skill $skill $source
}

$catalog = Get-Content -Raw -LiteralPath (Join-Path $kitRoot 'optional\catalog.json') | ConvertFrom-Json
foreach ($skill in $OptionalSkills) {
  $property = $catalog.PSObject.Properties[$skill]
  if ($null -eq $property) { throw "Unknown optional skill: $skill" }
  $module = $property.Value
  if ($module.kind -eq 'referenced') {
    Write-Warning "$skill is referenced, not vendored. $($module.installHint)"
    continue
  }
  if ($module.kind -ne 'vendored') { throw "Unsupported optional module kind for $skill" }
  $source = Join-Path $kitRoot $module.path
  if (!(Test-Path -LiteralPath $source)) { throw "Missing vendored optional skill: $skill" }
  Install-Skill $skill $source
}
if ('kilo' -in $Tools) {
  $agentDestination = Join-Path $project '.kilo\agents\project-designer.md'
  if (Test-Path -LiteralPath $agentDestination) { throw "Refusing to overwrite $agentDestination" }
  New-Item -ItemType Directory -Force -Path (Split-Path $agentDestination) | Out-Null
  Copy-Item -LiteralPath (Join-Path $kitRoot 'agents\designer\agent.md') -Destination $agentDestination
}
if ('claude' -in $Tools) { Invoke-ClaudeAdapter 'install' }
Write-Output "Installed approved core/vendored optional files. Referenced modules were not fetched. Project hooks and root instructions still require reviewed project-specific authoring."
