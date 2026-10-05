; Установщик xlamBOT.
;
; Собирается из уже готовой папки dist\xlamBOT, поэтому порядок такой:
;   1. PyInstaller собирает программу      -> dist\xlamBOT
;   2. этот скрипт собирает установщик     -> dist\xlamBOT-Setup-x.y.z.exe
; Скрипт install.ps1 делает обе части сам.

#define AppName "xlamBOT"
; Версия обязана совпадать с XLAMBOT_VERSION в utils.py, иначе exe и
; установщик будут называть сборку разными числами.
#define AppVersion "0.8.16"
#define AppPublisher "xlamBOT"
#define AppExeName "xlamBOT.exe"

[Setup]
AppId={{7C2E1B4A-9F3D-4A61-8B0C-5D6E7F8A9B01}
AppName={#AppName}
AppVersion={#AppVersion}
AppPublisher={#AppPublisher}
DefaultDirName={autopf}\{#AppName}
DefaultGroupName={#AppName}
DisableProgramGroupPage=yes
OutputDir=dist
OutputBaseFilename=xlamBOT-Updates-Setup-{#AppVersion}
Compression=lzma2/max
SolidCompression=yes
WizardStyle=modern
; Без прав администратора: ставим в профиль пользователя.
PrivilegesRequiredOverridesAllowed=dialog
PrivilegesRequired=lowest
ArchitecturesInstallIn64BitMode=x64compatible
; Программа держит именованный мьютекс, и по нему установщик находит
; запущенный экземпляр и закрывает его сам. Без этой строки переустановка
; поверх работающей программы упирается в ошибку "Setup was unable to
; automatically close all applications".
AppMutex=xlamBOT_single_instance
CloseApplications=yes
RestartApplications=no
UninstallDisplayIcon={app}\{#AppExeName}
; Подсказка на случай, если у человека нет эмулятора
ChangesAssociations=no

[Languages]
Name: "ru"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "Создать значок на рабочем столе"; GroupDescription: "Дополнительно:"
Name: "quicklaunchicon"; Description: "Создать значок в области быстрого запуска"; GroupDescription: "Дополнительно:"; Flags: unchecked

[Files]
; Собранная программа целиком: exe, _internal, модели, переносимый Tesseract.
Source: "dist\xlamBOT\*"; DestDir: "{app}"; Excludes: "_internal\cfg\*,_internal\models\*,_internal\playstyles\*,_internal\latest_brawler_data.json"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "dist\xlamBOT\_internal\cfg\*"; DestDir: "{app}\_internal\cfg"; Flags: onlyifdoesntexist recursesubdirs createallsubdirs
Source: "dist\xlamBOT\_internal\models\*"; DestDir: "{app}\_internal\models"; Flags: onlyifdoesntexist recursesubdirs createallsubdirs
Source: "dist\xlamBOT\_internal\playstyles\*"; DestDir: "{app}\_internal\playstyles"; Flags: onlyifdoesntexist recursesubdirs createallsubdirs
Source: "dist\xlamBOT\_internal\latest_brawler_data.json"; DestDir: "{app}\_internal"; Flags: onlyifdoesntexist

[Icons]
Name: "{group}\{#AppName}"; Filename: "{app}\{#AppExeName}"
Name: "{group}\Удалить {#AppName}"; Filename: "{uninstallexe}"
Name: "{autodesktop}\{#AppName}"; Filename: "{app}\{#AppExeName}"; Tasks: desktopicon
Name: "{userappdata}\Microsoft\Internet Explorer\Quick Launch\{#AppName}"; Filename: "{app}\{#AppExeName}"; Tasks: quicklaunchicon

; Existing per-device profiles are preserved on upgrade.

[UninstallDelete]
; И то же самое при удалении, иначе личные файлы остаются на диске.
Type: files; Name: "{app}\_internal\cfg\match_history*.csv"
Type: files; Name: "{app}\_internal\cfg\cfg.zip"
Type: filesandordirs; Name: "{app}\_internal\devices"

[Run]
Filename: "{app}\{#AppExeName}"; Description: "Запустить {#AppName}"; Flags: nowait postinstall skipifsilent

[Code]
// После установки говорим, что делать дальше: без эмулятора и включённой
// отладки по ADB программа работать не с чем.
procedure CurStepChanged(CurStep: TSetupStep);
begin
  if CurStep = ssPostInstall then
    if DirExists(ExpandConstant('{app}\vendor\tesseract')) then
      MsgBox('Готово.' + #13#10 +
             'При первом запуске мастер сам найдёт устройство.' + #13#10 +
             'Если устройство не найдено - проверьте, что в эмуляторе включена отладка по ADB.',
             mbInformation, MB_OK);
end;
