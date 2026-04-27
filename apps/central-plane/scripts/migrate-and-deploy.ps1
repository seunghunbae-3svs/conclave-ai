# Apply pending D1 migrations + deploy the central-plane Worker.
# Run this from C:\Users\ADMIN\.conclave\conclave-ai\apps\central-plane
# with CLOUDFLARE_API_TOKEN already set in $env:.
#
#   .\scripts\migrate-and-deploy.ps1
#
# Avoids the PowerShell paste-line-break issue with long inline commands.

$ErrorActionPreference = "Stop"

Write-Host "==> 1/3 wrangler whoami"
pnpm exec wrangler whoami

Write-Host ""
Write-Host "==> 2/3 apply D1 migrations (you'll be prompted to confirm 0008)"
pnpm exec wrangler d1 migrations apply conclave-ai --remote

Write-Host ""
Write-Host "==> 3/3 build + deploy worker"
pnpm build
pnpm exec wrangler deploy

Write-Host ""
Write-Host "✓ migrate-and-deploy.ps1 complete"
