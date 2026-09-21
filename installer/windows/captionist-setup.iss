; Inno Setup script for the Captionist .exe installer.
; Build with: iscc /DSourceRoot=..\.. captionist-setup.iss
;
; Installs into the per-user CEP extension folder, so no admin rights and no
; UAC prompt. The panel shows up under Window > Extensions after a restart.

#ifndef SourceRoot
  #define SourceRoot "..\.."
#endif
#ifndef AppVersion
  #define AppVersion "0.1.1"
#endif

#define AppName     "Captionist"
#define AppPublisher "NiteRix"
#define ExtensionId "com.niterix.captionist"

[Setup]
AppId={{41C2E7B5-8D3A-4F16-9B72-0E5A4C1D8F93}
AppName={#AppName}
AppVersion={#AppVersion}
AppVerName={#AppName} {#AppVersion}
AppPublisher={#AppPublisher}
DefaultDirName={userappdata}\Adobe\CEP\extensions\{#ExtensionId}
DisableDirPage=yes
DisableProgramGroupPage=yes
UsePreviousAppDir=no
PrivilegesRequired=lowest
OutputDir={#SourceRoot}\dist
OutputBaseFilename=Captionist-{#AppVersion}-Setup
Compression=lzma2/max
SolidCompression=yes
WizardStyle=modern
UninstallDisplayName={#AppName} for Premiere Pro
AppSupportURL=https://github.com/NiteRix/Captionist
AppUpdatesURL=https://github.com/NiteRix/Captionist/releases

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Files]
Source: "{#SourceRoot}\extension\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "{#SourceRoot}\README.md"; DestDir: "{app}"; Flags: ignoreversion

[Registry]
; CEP refuses to load unsigned extensions unless debug mode is on. One key per
; CEP generation, covering Premiere Pro CC 2015 through current releases.
Root: HKCU; Subkey: "Software\Adobe\CSXS.6";  ValueType: string; ValueName: "PlayerDebugMode"; ValueData: "1"; Flags: uninsdeletevalue
Root: HKCU; Subkey: "Software\Adobe\CSXS.7";  ValueType: string; ValueName: "PlayerDebugMode"; ValueData: "1"; Flags: uninsdeletevalue
Root: HKCU; Subkey: "Software\Adobe\CSXS.8";  ValueType: string; ValueName: "PlayerDebugMode"; ValueData: "1"; Flags: uninsdeletevalue
Root: HKCU; Subkey: "Software\Adobe\CSXS.9";  ValueType: string; ValueName: "PlayerDebugMode"; ValueData: "1"; Flags: uninsdeletevalue
Root: HKCU; Subkey: "Software\Adobe\CSXS.10"; ValueType: string; ValueName: "PlayerDebugMode"; ValueData: "1"; Flags: uninsdeletevalue
Root: HKCU; Subkey: "Software\Adobe\CSXS.11"; ValueType: string; ValueName: "PlayerDebugMode"; ValueData: "1"; Flags: uninsdeletevalue
Root: HKCU; Subkey: "Software\Adobe\CSXS.12"; ValueType: string; ValueName: "PlayerDebugMode"; ValueData: "1"; Flags: uninsdeletevalue

[UninstallDelete]
Type: filesandordirs; Name: "{app}\bin"
Type: dirifempty; Name: "{app}"

[Code]
function InitializeSetup(): Boolean;
var
  Running: Boolean;
  ResultCode: Integer;
begin
  Result := True;
  Running := Exec('cmd.exe',
    '/c tasklist /fi "imagename eq Adobe Premiere Pro.exe" | find /i "Adobe Premiere Pro.exe"',
    '', SW_HIDE, ewWaitUntilTerminated, ResultCode) and (ResultCode = 0);
  if Running then
    MsgBox('Premiere Pro is currently open.' + #13#10 + #13#10 +
           'Captionist will install fine, but the panel only appears after you ' +
           'restart Premiere Pro.', mbInformation, MB_OK);
end;

procedure CurStepChanged(CurStep: TSetupStep);
begin
  if CurStep = ssPostInstall then
    MsgBox('Captionist is installed.' + #13#10 + #13#10 +
           'Restart Premiere Pro and open it from:' + #13#10 +
           '    Window  >  Extensions  >  Captionist' + #13#10 + #13#10 +
           'Then pick a speech model in the Models tab. Models are downloaded ' +
           'separately because they run to hundreds of megabytes, and they are ' +
           'kept outside the extension folder so updates do not delete them.',
           mbInformation, MB_OK);
end;
