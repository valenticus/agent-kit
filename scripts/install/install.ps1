param(
  [Parameter(Mandatory=$true)][string]$ProjectRoot,
  [string[]]$Tools = @('codex'),
  [string[]]$Skills = @('safe-change','debugging','final-audit','product-ux','mobile-design','design-critique','security','ui'),
  [string[]]$OptionalSkills = @(),
  [switch]$CopilotAuditor,
  [switch]$NoSkills,
  [switch]$UpdatePolicies,
  [switch]$UpdateSkills,
  [switch]$DryRun,
  [switch]$RecoverSkillUpdate
)
$ErrorActionPreference = 'Stop'
$kitRoot = Resolve-Path (Join-Path $PSScriptRoot '..\..')
$project = Resolve-Path $ProjectRoot
if ($DryRun -and -not $UpdateSkills) { throw '-DryRun requires -UpdateSkills' }
if ($UpdateSkills -or $RecoverSkillUpdate) {
  # Standalone update of installed Agent Kit skills, or recovery of an interrupted one. The Node modules plan, verify,
  # and apply every change; this script only validates arguments. Nothing is installed, removed, or committed.
  $operation = if ($UpdateSkills) { '-UpdateSkills' } else { '-RecoverSkillUpdate' }
  $incompatible = @('Tools','NoSkills','CopilotAuditor','UpdatePolicies')
  if ($RecoverSkillUpdate) { $incompatible += @('UpdateSkills','Skills','OptionalSkills') }
  foreach ($name in $incompatible) {
    if ($PSBoundParameters.ContainsKey($name)) { throw "$operation is a standalone operation and cannot be combined with -$name" }
  }
  if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw "$operation requires Node.js on PATH" }
  if ($RecoverSkillUpdate) {
    & node (Join-Path $kitRoot 'scripts/install/skill-apply.mjs') recover --project $project.Path
    if ($LASTEXITCODE -ne 0) { throw "-RecoverSkillUpdate stopped (exit $LASTEXITCODE); see the messages above." }
    return
  }
  # -Skills has a default value, so only explicitly passed names narrow the selection. As for installation, -Skills
  # names core skills and -OptionalSkills names vendored optional modules.
  $catalog = Get-Content -Raw -LiteralPath (Join-Path $kitRoot 'optional\catalog.json') | ConvertFrom-Json
  $selected = @()
  foreach ($name in @('Skills','OptionalSkills')) {
    if (-not $PSBoundParameters.ContainsKey($name)) { continue }
    foreach ($skill in @($PSBoundParameters[$name] | ForEach-Object { $_ -split ',' } | ForEach-Object { $_.Trim() } | Where-Object { $_ })) {
      if ($skill -cnotmatch '^[a-z0-9]+(-[a-z0-9]+)*$') { throw "Invalid skill name: $skill" }
      if ($name -eq 'Skills' -and -not (Test-Path -LiteralPath (Join-Path $kitRoot "core\skills\$skill") -PathType Container)) { throw "Unknown core skill: $skill (optional modules are selected with -OptionalSkills)" }
      if ($name -eq 'OptionalSkills') {
        $property = $catalog.PSObject.Properties[$skill]
        if ($null -eq $property) { throw "Unknown optional skill: $skill (core skills are selected with -Skills)" }
        if ($property.Value.kind -ne 'vendored') { throw "$skill is a referenced optional module; Agent Kit does not install or update it" }
      }
      $selected += $skill
    }
  }
  $arguments = @('--project', $project.Path)
  if ($PSBoundParameters.ContainsKey('Skills') -or $PSBoundParameters.ContainsKey('OptionalSkills')) {
    if ($selected.Count -eq 0) { throw '-Skills or -OptionalSkills was given without skill names' }
    $arguments += @('--skills', ($selected -join ','))
  }
  if ($DryRun) {
    & node (Join-Path $kitRoot 'scripts/install/skill-update.mjs') plan @arguments
    if ($LASTEXITCODE -ne 0) { throw "-UpdateSkills -DryRun: the plan has conflicts or blockers (exit $LASTEXITCODE); nothing was changed." }
    return
  }
  & node (Join-Path $kitRoot 'scripts/install/skill-apply.mjs') apply @arguments
  if ($LASTEXITCODE -ne 0) { throw "-UpdateSkills stopped (exit $LASTEXITCODE); see the messages above for what, if anything, was changed." }
  return
}
if ($UpdatePolicies) {
  # Standalone, explicit upgrade of the managed policy blocks in an existing project's AGENTS.md.
  foreach ($name in @('Tools','Skills','OptionalSkills','CopilotAuditor','NoSkills')) {
    if ($PSBoundParameters.ContainsKey($name)) { throw "-UpdatePolicies is a standalone operation and cannot be combined with -$name" }
  }
  if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw '-UpdatePolicies requires Node.js on PATH' }
  $policyBlock = Join-Path $kitRoot 'scripts/install/policy-block.mjs'
  foreach ($command in @('preflight-update','update')) {
    & node $policyBlock $command --project $project.Path
    if ($LASTEXITCODE -ne 0) { throw "Policy $command failed (exit $LASTEXITCODE)" }
  }
  return
}
# A skill update that is running or was interrupted owns parts of .agents and .cline; never install around it.
foreach ($leftover in @('.agent-kit-update.lock', '.agents\.agent-kit-update', '.cline\.agent-kit-update')) {
  if ($null -ne (Get-Item -LiteralPath (Join-Path $project $leftover) -Force -ErrorAction SilentlyContinue)) {
    throw "An Agent Kit skill update is running or was interrupted ($leftover exists). Run install.ps1 -ProjectRoot <project> -RecoverSkillUpdate first; nothing was changed."
  }
}
$Tools = @($Tools | ForEach-Object { $_ -split ',' } | ForEach-Object { $_.Trim() } | Where-Object { $_ })
if ($NoSkills -and ($PSBoundParameters.ContainsKey('Skills') -or $PSBoundParameters.ContainsKey('OptionalSkills'))) { throw '-NoSkills cannot be combined with -Skills or -OptionalSkills' }
if ($NoSkills) { $Skills = @() }
$Skills = @($Skills | ForEach-Object { $_ -split ',' } | ForEach-Object { $_.Trim() } | Where-Object { $_ })
$OptionalSkills = @($OptionalSkills | ForEach-Object { $_ -split ',' } | ForEach-Object { $_.Trim() } | Where-Object { $_ })
$allowedTools = @('codex','cline','kilo','copilot','claude')
foreach ($tool in $Tools) { if ($tool -notin $allowedTools) { throw "Unknown tool: $tool" } }
if ($CopilotAuditor -and 'copilot' -notin $Tools) { throw '-CopilotAuditor requires copilot in -Tools' }
$claudeAdapter = Join-Path $kitRoot 'scripts/install/claude-adapter.mjs'
function Invoke-ClaudeAdapter([string]$command) {
  & node $claudeAdapter $command --project $project.Path
  if ($LASTEXITCODE -ne 0) { throw "Claude adapter $command failed (exit $LASTEXITCODE)" }
}

# Phase 1: read-only planning and preflight. Nothing is written until every predictable conflict is ruled out.
$directoryCopies = @()
$fileCopies = @()
function Add-SkillCopies([string]$skill, [string]$source) {
  if (@('codex','kilo','copilot','claude') | Where-Object { $_ -in $Tools }) {
    $script:directoryCopies += ,@($source, (Join-Path $project ".agents\skills\$skill"))
  }
  if ('cline' -in $Tools) {
    $script:directoryCopies += ,@($source, (Join-Path $project ".cline\skills\$skill"))
  }
}
if ('claude' -in $Tools) {
  if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw 'The Claude adapter requires Node.js (also used by its SessionStart bootstrap) on PATH' }
  Invoke-ClaudeAdapter 'preflight'
}
if ('copilot' -in $Tools) {
  $fileCopies += ,@((Join-Path $kitRoot 'adapters\copilot\copilot-instructions.md'), (Join-Path $project '.github\copilot-instructions.md'))
  if ($CopilotAuditor) {
    $fileCopies += ,@((Join-Path $kitRoot 'adapters\copilot\project-auditor.agent.md'), (Join-Path $project '.github\agents\project-auditor.agent.md'))
  }
}
# A new project gets the canonical root instructions (with the managed policy blocks). An existing AGENTS.md is never touched here.
$agentsDestination = Join-Path $project 'AGENTS.md'
if (Test-Path -LiteralPath $agentsDestination -PathType Container) { throw "$agentsDestination is a directory, not a file" }
if (-not (Test-Path -LiteralPath $agentsDestination)) {
  $fileCopies += ,@((Join-Path $kitRoot 'templates\project-rules\AGENTS.md'), $agentsDestination)
}
foreach ($skill in $Skills) {
  $source = Join-Path $kitRoot "core\skills\$skill"
  if (!(Test-Path -LiteralPath $source)) { throw "Unknown core skill: $skill" }
  Add-SkillCopies $skill $source
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
  Add-SkillCopies $skill $source
}
if ('kilo' -in $Tools) {
  $fileCopies += ,@((Join-Path $kitRoot 'agents\designer\agent.md'), (Join-Path $project '.kilo\agents\project-designer.md'))
}
if ('claude' -in $Tools -and -not (@($directoryCopies | Where-Object { $_[1].StartsWith((Join-Path $project '.agents\skills\'), [System.StringComparison]::OrdinalIgnoreCase) })) -and -not (Test-Path -LiteralPath (Join-Path $project '.agents\skills') -PathType Container)) {
  throw 'The Claude adapter exposes existing canonical skills, but .agents\skills is missing and no shared skills are selected'
}
# Every existing ancestor between the project root and a destination must be able to act as a directory.
# An ordinary file, or a link whose target is missing or not a directory, fails; a link to a valid directory is allowed.
function Assert-UsableAncestors([string]$destination) {
  $root = $project.Path.TrimEnd('\', '/')
  $current = Split-Path -Parent $destination
  while ($current -and $current.Length -gt $root.Length -and $current.StartsWith($root, [System.StringComparison]::OrdinalIgnoreCase)) {
    $item = Get-Item -LiteralPath $current -Force -ErrorAction SilentlyContinue
    if ($null -ne $item -and -not (Test-Path -LiteralPath $current -PathType Container)) {
      throw "Refusing to install $destination because $current exists but is not a usable directory"
    }
    $current = Split-Path -Parent $current
  }
}
$planned = @{}
foreach ($copy in @($directoryCopies) + @($fileCopies)) {
  $destination = $copy[1]
  Assert-UsableAncestors $destination
  if (Test-Path -LiteralPath $destination) { throw "Refusing to overwrite $destination" }
  if ($planned.ContainsKey($destination.ToLowerInvariant())) { throw "Refusing to write $destination twice in one invocation" }
  $planned[$destination.ToLowerInvariant()] = $true
}

# Phase 2: apply.
foreach ($copy in @($directoryCopies) + @($fileCopies)) {
  New-Item -ItemType Directory -Force -Path (Split-Path $copy[1]) | Out-Null
}
foreach ($copy in $fileCopies) { Copy-Item -LiteralPath $copy[0] -Destination $copy[1] }
foreach ($copy in $directoryCopies) { Copy-Item -Recurse -LiteralPath $copy[0] -Destination $copy[1] }
if ('claude' -in $Tools) { Invoke-ClaudeAdapter 'install' }
Write-Output "Installed approved core/vendored optional files. Referenced modules were not fetched. Project hooks and root instructions still require reviewed project-specific authoring."
