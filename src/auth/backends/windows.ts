import {
  CREDENTIAL_SERVICE,
  type CredentialBackend,
  CredentialBackendCommandError,
  CredentialBackendUnsupportedError,
  isCommandNotFound,
  type RunResult,
  redactStderr,
  runCommand,
} from '../backend.js';

// Stock Windows ships PowerShell which can call the CredentialManager API
// via P/Invoke. No extra modules to install. The password round-trips as
// hex bytes through the script body so a `ps` listing shows hex, not
// cleartext.

const PS_HEADER = `
$ErrorActionPreference = 'Stop';
Add-Type @"
using System;
using System.Runtime.InteropServices;

public class AitccCredApi {
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    public struct CREDENTIAL {
        public uint Flags;
        public uint Type;
        public IntPtr TargetName;
        public IntPtr Comment;
        public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
        public uint CredentialBlobSize;
        public IntPtr CredentialBlob;
        public uint Persist;
        public uint AttributeCount;
        public IntPtr Attributes;
        public IntPtr TargetAlias;
        public IntPtr UserName;
    }
    [DllImport("Advapi32.dll", SetLastError = true, EntryPoint = "CredWriteW", CharSet = CharSet.Unicode)]
    public static extern bool CredWrite([In] ref CREDENTIAL Credential, [In] uint Flags);
    [DllImport("Advapi32.dll", SetLastError = true, EntryPoint = "CredReadW", CharSet = CharSet.Unicode)]
    public static extern bool CredRead(string target, uint type, uint reservedFlag, out IntPtr CredentialPtr);
    [DllImport("Advapi32.dll", SetLastError = true, EntryPoint = "CredDeleteW", CharSet = CharSet.Unicode)]
    public static extern bool CredDelete(string target, uint type, uint flags);
    [DllImport("Advapi32.dll", SetLastError = true, EntryPoint = "CredFree")]
    public static extern void CredFree([In] IntPtr cred);
}
"@
`;

const MISSING_HINT_FULL =
  '`powershell.exe` is missing from PATH. Windows credential storage requires PowerShell.';
const MISSING_HINT_SHORT = '`powershell.exe` is missing from PATH.';

function targetName(account: string): string {
  return `${CREDENTIAL_SERVICE}/${account}`;
}

function powerShellArgs(script: string): readonly string[] {
  return ['-NoProfile', '-NonInteractive', '-Command', script];
}

function escapeSingleQuotes(s: string): string {
  return s.replace(/'/g, "''");
}

async function runPowerShell(script: string): Promise<RunResult> {
  try {
    return await runCommand('powershell.exe', { args: powerShellArgs(script) });
  } catch (err) {
    if (isCommandNotFound(err)) {
      throw new CredentialBackendUnsupportedError('win32', MISSING_HINT_FULL);
    }
    throw err;
  }
}

export const WINDOWS_BACKEND: CredentialBackend = {
  name: 'windows-credential-manager',
  async get(account) {
    const target = targetName(account);
    const script = `
${PS_HEADER}
$target = '${escapeSingleQuotes(target)}';
$ptr = [IntPtr]::Zero;
$ok = [AitccCredApi]::CredRead($target, 1, 0, [ref]$ptr);
if (-not $ok) { exit 0; }
$cred = [Runtime.InteropServices.Marshal]::PtrToStructure($ptr, [Type][AitccCredApi+CREDENTIAL]);
$blob = New-Object byte[] $cred.CredentialBlobSize;
[Runtime.InteropServices.Marshal]::Copy($cred.CredentialBlob, $blob, 0, $cred.CredentialBlobSize);
$pw = [System.Text.Encoding]::Unicode.GetString($blob);
[AitccCredApi]::CredFree($ptr);
[Console]::Out.Write($pw);
`;
    const result = await runPowerShell(script);
    if (result.exitCode !== 0) {
      throw new CredentialBackendCommandError(
        'powershell CredRead',
        result.exitCode,
        redactStderr(result.stderr),
      );
    }
    return result.stdout.length > 0 ? result.stdout : null;
  },
  async set(account, password) {
    const target = targetName(account);
    // Encode the password as hex so PowerShell's argv (visible in Task
    // Manager) shows hex, not cleartext. `account` is the email; it's
    // intentionally cleartext on argv since the email is not secret.
    const passwordHex = Buffer.from(password, 'utf8').toString('hex');
    const script = `
${PS_HEADER}
$target = '${escapeSingleQuotes(target)}';
$user = '${escapeSingleQuotes(account)}';
$pwHex = '${passwordHex}';
$pwBytes = New-Object byte[] ($pwHex.Length / 2);
for ($i = 0; $i -lt $pwBytes.Length; $i++) {
  $pwBytes[$i] = [Convert]::ToByte($pwHex.Substring($i * 2, 2), 16);
}
$pwUtf16 = [System.Text.Encoding]::Unicode.GetBytes([System.Text.Encoding]::UTF8.GetString($pwBytes));
$cred = New-Object AitccCredApi+CREDENTIAL;
$cred.Type = 1;
$cred.TargetName = [Runtime.InteropServices.Marshal]::StringToHGlobalUni($target);
$cred.CredentialBlobSize = [uint32]$pwUtf16.Length;
$cred.CredentialBlob = [Runtime.InteropServices.Marshal]::AllocHGlobal($pwUtf16.Length);
[Runtime.InteropServices.Marshal]::Copy($pwUtf16, 0, $cred.CredentialBlob, $pwUtf16.Length);
$cred.Persist = 2;
$cred.UserName = [Runtime.InteropServices.Marshal]::StringToHGlobalUni($user);
try {
  $ok = [AitccCredApi]::CredWrite([ref]$cred, 0);
  if (-not $ok) { Write-Error 'CredWrite failed'; exit 1; }
} finally {
  [Runtime.InteropServices.Marshal]::FreeHGlobal($cred.TargetName);
  [Runtime.InteropServices.Marshal]::FreeHGlobal($cred.UserName);
  [Runtime.InteropServices.Marshal]::FreeHGlobal($cred.CredentialBlob);
}
`;
    let result: RunResult;
    try {
      result = await runPowerShell(script);
    } catch (err) {
      if (err instanceof CredentialBackendUnsupportedError) {
        throw new CredentialBackendUnsupportedError('win32', MISSING_HINT_SHORT);
      }
      throw err;
    }
    if (result.exitCode !== 0) {
      throw new CredentialBackendCommandError(
        'powershell CredWrite',
        result.exitCode,
        redactStderr(result.stderr),
      );
    }
  },
  async clear(account) {
    const target = targetName(account);
    const script = `
${PS_HEADER}
$target = '${escapeSingleQuotes(target)}';
$ok = [AitccCredApi]::CredDelete($target, 1, 0);
if ($ok) { [Console]::Out.Write('deleted'); } else { [Console]::Out.Write('absent'); }
`;
    let result: RunResult;
    try {
      result = await runPowerShell(script);
    } catch (err) {
      if (err instanceof CredentialBackendUnsupportedError) {
        throw new CredentialBackendUnsupportedError('win32', MISSING_HINT_SHORT);
      }
      throw err;
    }
    if (result.exitCode !== 0) {
      throw new CredentialBackendCommandError(
        'powershell CredDelete',
        result.exitCode,
        redactStderr(result.stderr),
      );
    }
    return { existed: result.stdout.includes('deleted') };
  },
};
