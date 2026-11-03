"""Compile NSIS without executing an installer or touching user settings."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import pytest

ROOT=Path(__file__).resolve().parents[1]


def test_options_silent_upgrade_and_opt_in_data_removal_contract():
    source=(ROOT/"packaging/installer.nsi").read_text(encoding="utf-8")
    assert 'Page custom OptionsCreate OptionsLeave' in source
    assert 'MUI_FINISHPAGE_RUN_TEXT "Launch SC2 Tools now"' in source
    assert 'CreateShortCut "${APP_STARTUP_LINK}"' not in source
    init=source.split('Function .onInit',1)[1].split('FunctionEnd',1)[0]
    assert 'StrCpy $StartOnLogin ${BST_CHECKED}' in init
    assert 'ReadRegStr $1 HKCU "${APP_RUN_KEY}" "${APP_RUN_VALUE}"' in init
    assert 'StrCpy $StartOnLogin ${BST_UNCHECKED}' in init
    install=source.split('Section "Install"',1)[1].split('SectionEnd',1)[0]
    assert install.index('WriteRegStr HKCU "${APP_RUN_KEY}"')<install.index('Delete "${APP_STARTUP_LINK}"')
    assert 'IfSilent 0 silent_relaunch_done' in install
    assert "--start-minimized'" in install
    uninstall=source.split('Section "Uninstall"',1)[1].split('SectionEnd',1)[0]
    assert 'DeleteRegValue HKCU "${APP_RUN_KEY}" "${APP_RUN_VALUE}"' in uninstall
    assert 'StrCpy $DeleteUserData ${BST_UNCHECKED}' in source
    data=uninstall.split('${If} $DeleteUserData == ${BST_CHECKED}',1)[1].split('${EndIf}',1)[0]
    assert 'agent.json' in data and 'player_handle.json' in data
    for folder in ('logs','data','streaming','replay-observations'):
        assert f'RMDir /r "$LOCALAPPDATA\\sc2tools\\{folder}"' in data
    commands=[line.strip() for line in uninstall.splitlines() if line.strip() and not line.strip().startswith(';')]
    assert 'RMDir /r "$INSTDIR"' not in commands
    assert not any('replay_folders' in line or 'Documents' in line for line in commands)


def test_nsis_compiles_options_and_uninstall_pages_in_fixture_bundle(tmp_path):
    tool=shutil.which('makensis')
    if tool is None and os.name=='nt':
        candidate=Path('C:/Program Files (x86)/NSIS/makensis.exe')
        tool=str(candidate) if candidate.exists() else None
    if tool is None:pytest.skip('NSIS is not installed on this runner')
    packaging=tmp_path/'packaging';packaging.mkdir()
    shutil.copy2(ROOT/'packaging/installer.nsi',packaging/'installer.nsi')
    bundle=tmp_path/'dist/sc2tools-agent';bundle.mkdir(parents=True)
    (bundle/'sc2tools-agent.exe').write_bytes(b'fixture, never executed')
    result=subprocess.run([tool,'/V2','/DAGENT_VERSION=0.19.0',str(packaging/'installer.nsi')],cwd=tmp_path,capture_output=True,text=True,timeout=30)
    assert result.returncode==0,result.stdout+result.stderr
    output=tmp_path/'dist/SC2ToolsAgent-Setup-0.19.0.exe'
    assert output.read_bytes().startswith(b'MZ') and output.stat().st_size>10000


@pytest.mark.parametrize('status,signer,timestamp,ok',[
    ('Valid',True,True,True),('NotSigned',False,False,False),
    ('HashMismatch',True,True,False),('Valid',True,False,False),('Valid',False,True,False),
])
def test_signature_verifier_requires_trust_and_timestamp(tmp_path,status,signer,timestamp,ok):
    powershell=shutil.which('pwsh')
    if not powershell:pytest.skip('PowerShell not installed')
    script=r"""
param($Helper,$Status,$Signer,$Timestamp)
function Get-AuthenticodeSignature {
    [pscustomobject]@{Status=$Status;SignerCertificate=$(if ($Signer -eq 'True') {[pscustomobject]@{Subject='Fixture signer'}} else {$null});TimeStamperCertificate=$(if ($Timestamp -eq 'True') {[pscustomobject]@{Subject='Fixture timestamp'}} else {$null})}
}
try { & $Helper -Path 'fixture.exe'; exit 0 } catch { exit 17 }
"""
    file=tmp_path/'check.ps1';file.write_text(script,encoding='utf-8')
    result=subprocess.run([powershell,'-NoProfile','-NonInteractive','-File',str(file),str(ROOT/'packaging/verify-signature.ps1'),status,str(signer),str(timestamp)],capture_output=True,text=True,timeout=15)
    assert result.returncode==(0 if ok else 17),result.stdout+result.stderr


def test_signing_order_keeps_inner_signature_and_hashes_only_final_setup():
    workflow=(ROOT.parents[1]/'.github/workflows/agent-installer.yml').read_text(encoding='utf-8')
    steps=['Build agent bundle','Sign inner executable with SignPath Foundation','Verify and place signed inner executable','Package installer without rebuilding signed bundle','Sign setup executable with SignPath Foundation','Verify and place signed setup executable','Generate SHA-256 sidecar','Upload installer artifact']
    positions=[workflow.index('- name: '+name) for name in steps]
    assert positions==sorted(positions)
    assert '-Installer -PackageOnly' in workflow
    assert workflow.count("if: vars.SIGNPATH_ENABLED == 'true'")==6
    assert workflow.count('draft: true')==2


SIGNPATH_FIXTURE_NAMES=(
    'SIGNPATH_API_TOKEN','SIGNPATH_ORGANIZATION_ID','SIGNPATH_PROJECT_SLUG',
    'SIGNPATH_POLICY_SLUG','SIGNPATH_AGENT_CONFIG','SIGNPATH_INSTALLER_CONFIG',
)
SIGNING_TRIGGERS=[('refs/tags/agent-v0.24.9','tagged'),('refs/heads/fixture-manual','manual')]
UNSIGNED_NOTICE='**Unsigned Windows installer:** this build has no verified publisher or code-signing signature.'


def _workflow_run_block(step_name):
    workflow=(ROOT.parents[1]/'.github/workflows/agent-installer.yml').read_text(encoding='utf-8')
    marker='      - name: '+step_name+'\n'
    assert workflow.count(marker)==1
    step=workflow.split(marker,1)[1].split('\n      - name: ',1)[0]
    block=step.split('        run: |\n',1)[1]
    lines=[]
    for line in block.splitlines():
        if line.strip() and not line.startswith('          '):break
        lines.append(line[10:] if line else '')
    assert lines
    return '\n'.join(lines)+'\n'


def _run_workflow_fixture(tmp_path,step_name,variables):
    powershell=shutil.which('pwsh')
    if not powershell:pytest.skip('PowerShell not installed')
    script=_workflow_run_block(step_name)
    # Evaluate the workflow's actual commands with fixture-only inputs, never Actions or signing providers.
    script=script.replace("'${{ steps.ver.outputs.version }}'","'0.24.9'")
    file=tmp_path/'workflow-step.ps1'
    file.write_text("$ErrorActionPreference = 'Stop'\n"+script,encoding='utf-8')
    environment={name:value for name,value in os.environ.items() if not name.upper().startswith('SIGNPATH_')}
    environment.update(variables)
    return subprocess.run([powershell,'-NoProfile','-NonInteractive','-File',str(file)],cwd=tmp_path,env=environment,capture_output=True,text=True,timeout=15)


@pytest.mark.parametrize('ref,kind',SIGNING_TRIGGERS)
@pytest.mark.parametrize('enabled',[None,'false'])
def test_disabled_signing_allows_tag_and_manual_with_unsigned_summary(tmp_path,ref,kind,enabled):
    summary=tmp_path/'summary.md'
    variables={'GITHUB_REF':ref,'GITHUB_STEP_SUMMARY':str(summary)}
    if enabled is not None:variables['SIGNPATH_ENABLED']=enabled
    result=_run_workflow_fixture(tmp_path,'Check signing configuration',variables)
    assert result.returncode==0,result.stdout+result.stderr
    assert summary.read_text(encoding='utf-8-sig').strip()==f'Unsigned {kind} installer build; no verified publisher or signed-release claim.'


@pytest.mark.parametrize('ref,kind',SIGNING_TRIGGERS)
@pytest.mark.parametrize('missing',[None,*SIGNPATH_FIXTURE_NAMES])
def test_enabled_signing_requires_every_configuration_value(tmp_path,ref,kind,missing):
    summary=tmp_path/'summary.md'
    variables={name:'fixture-only-'+name.lower() for name in SIGNPATH_FIXTURE_NAMES}
    variables.update({'SIGNPATH_ENABLED':'true','GITHUB_REF':ref,'GITHUB_STEP_SUMMARY':str(summary)})
    if missing is not None:del variables[missing]
    result=_run_workflow_fixture(tmp_path,'Check signing configuration',variables)
    if missing is None:
        assert result.returncode==0,result.stdout+result.stderr
    else:
        assert result.returncode!=0
        assert 'Missing signing configuration: '+missing in result.stdout+result.stderr
    assert not summary.exists()


@pytest.mark.parametrize('enabled',[None,'false','true'])
def test_tagged_release_notes_disclose_unsigned_only_when_signing_disabled(tmp_path,enabled):
    (tmp_path/'CHANGELOG.md').write_text('## 0.24.9\n\nFixture release notes.\n\n## 0.24.8\n\nOlder fixture notes.\n',encoding='utf-8')
    variables={}
    if enabled is not None:variables['SIGNPATH_ENABLED']=enabled
    result=_run_workflow_fixture(tmp_path,'Extract release notes from CHANGELOG',variables)
    assert result.returncode==0,result.stdout+result.stderr
    notes=(tmp_path/'RELEASE_NOTES.generated.md').read_text(encoding='utf-8-sig').strip()
    if enabled=='true':
        assert notes=='Fixture release notes.'
        assert not notes.startswith(UNSIGNED_NOTICE)
    else:
        assert notes==UNSIGNED_NOTICE+'\n\nFixture release notes.'
