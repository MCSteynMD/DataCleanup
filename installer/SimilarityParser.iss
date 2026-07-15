; Inno Setup script for Similarity Parser
; Compiled by build_package.ps1 after PyInstaller assembles dist\SimilarityParser\

#define MyAppName "Similarity Parser"
#define MyAppVersion "1.0.0"
#define MyAppPublisher "Similarity Parser"
#define MyAppExeName "Similarity Review.exe"
[Setup]
; Doubled brace is Inno escaping for a literal {GUID}
AppId={{A7C4E2B1-9F3D-4E8A-B2C1-5D6E7F809123}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppPublisher={#MyAppPublisher}
DefaultDirName={autopf}\{#MyAppName}
DefaultGroupName={#MyAppName}
DisableProgramGroupPage=yes
OutputDir=..\dist
OutputBaseFilename=SimilarityParser_Setup
Compression=lzma2/fast
SolidCompression=yes
WizardStyle=modern
PrivilegesRequired=admin
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
UninstallDisplayIcon={app}\Review\{#MyAppExeName}
SetupLogging=yes
CloseApplications=yes
RestartApplications=no

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; GroupDescription: "{cm:AdditionalIcons}"; Flags: unchecked

[Files]
; Full portable layout produced by build_package.ps1
Source: "..\dist\SimilarityParser\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{group}\{#MyAppName}"; Filename: "{app}\Review\{#MyAppExeName}"; WorkingDir: "{app}\Review"
Name: "{group}\Uninstall {#MyAppName}"; Filename: "{uninstallexe}"
Name: "{autodesktop}\{#MyAppName}"; Filename: "{app}\Review\{#MyAppExeName}"; WorkingDir: "{app}\Review"; Tasks: desktopicon

[Run]
Filename: "{app}\Review\{#MyAppExeName}"; Description: "{cm:LaunchProgram,{#StringChange(MyAppName, '&', '&&')}}"; WorkingDir: "{app}\Review"; Flags: nowait postinstall skipifsilent

[UninstallDelete]
; Leave LocalAppData results/progress alone so reinstall keeps review progress
Type: filesandordirs; Name: "{app}\input\*"
