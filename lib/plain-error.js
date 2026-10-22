'use strict';
/*
 * plain-error.js - raw error codes become plain words before they reach a page (lane mn-plainwords,
 * 2026-10-12). The user's bar: "No jargon or raw codes on screen, but still no silent failures."
 *
 * The sidecar and Node say why something failed in the terms a developer reads: "COMException
 * (0x8024401C)", "UnauthorizedAccessException: Access to the path ... is denied", "access denied (5)",
 * "EBUSY: resource busy or locked, rename ...", ".NET stack text". Those reach Settings, Files, Task
 * Manager and the bar through a reason/why/error field. This module turns the technical part of such a
 * text into words, from Microsoft's documented meaning of the code (HRESULTs, Win32 error codes, the
 * Windows Update WU_E_* list) or Node's errno names; the rest of the sentence is left as it was:
 *   "Windows Update Agent did not answer: COMException (0x8024402C)"
 *     -> "Windows Update Agent did not answer: the server could not be reached; check the internet connection"
 * An unknown code becomes a generic sentence (never nothing: no silent failures), and the code itself
 * is handed to the caller's log only (onCodes), never kept in the text.
 *
 *   plainText(s)            -> { text, codes, changed }   codes: the raw tokens found (type names,
 *                              hex codes, errno names, "win32:N"), safe to log: no message text, no path
 *   plain(s)                -> the plain text
 *   plainReply(v, onCodes)  -> v with every error-ish string field (reason, why, error, warn, note,
 *                              hint, refusal, *Reason, *Why, *Error, ...) made plain, at any depth up
 *                              to 6; copy-on-write (v itself is never changed; an untouched v comes
 *                              back as the same object). onCodes(codes) once if anything was found.
 *   meaning(code)           -> the words for one code ('0x80070005', 'win32:5', 'ENOENT', a type name), or null
 *   onceLogger(write)       -> (where, codes) => void, each distinct where+codes said once (bounded)
 * Main applies plainReply where a reply or a push crosses to a page (main.js mantle:call / broadcast /
 * replay, lib/features.js push). Pure: no Electron, no I/O.
 *
 * PAGES USE THE SAME TABLES (lane pagewords, 2026-10-14). Some errors start inside a page (a page's own
 * bug, an image that will not decode, a canvas that will not blur), so main never sees them. A page
 * loads this very file as a classic script (<script src="../../lib/plain-error.js">, CSP script-src
 * file:) and gets window.MantlePlain = the same exports: one table, one set of words, never a fork.
 * Hence the wrapper below: nothing leaks into a page's globals, and node still gets module.exports.
 *   forLog(err)             -> "Name: message" of a page's own error with no file address, for the log
 */
(function (root) {

/* ---- the words ---------------------------------------------------------------------------------- */
/* Lower-case phrases: they read after "...: " and inside "( )". */
const W = {
  denied: 'access was denied',
  admin: 'it needs administrator rights',
  inUse: 'the file is in use by another app',
  notFound: 'it was not found',
  fileNotFound: 'the file was not found',
  folderNotFound: 'the folder was not found',
  driveNotFound: 'the drive was not found',
  diskFull: 'the disk is full',
  noNet: 'there is no internet connection',
  noReach: 'the server could not be reached; check the internet connection',
  resInUse: 'it is in use by something else',
  audioInUse: 'another app is using the sound device on its own',
  notReadyNow: 'Windows was not ready for it; try again in a moment',
  missingPart: 'a part it needs is missing or could not be loaded',
  policy: 'a policy on this PC blocks it',
  turnedOff: 'it is turned off',
  rpcStopped: 'the Windows service it was using stopped',
  netPath: 'the network location could not be reached',
  timeout: 'it took too long and was stopped',
  serviceOff: 'the Windows service it needs is not running',
  serviceDisabled: 'the Windows service it needs is turned off',
  serviceMissing: 'the Windows service it needs is not installed',
  notInstalled: 'the part of Windows it needs is not installed',
  unsupported: 'this PC does not support it',
  busy: 'Windows is busy; try again in a moment',
  cancelled: 'it was cancelled',
  badRequest: 'Windows did not accept the request',
  memory: 'Windows ran out of memory',
  notReady: 'the device is not ready',
  notConnected: 'the device is not connected',
  exists: 'something with that name already exists',
  notEmpty: 'the folder is not empty',
  tooLong: 'the name or folder path is too long',
  tooMany: 'too many files are open',
  refused: 'the connection was refused',
  dropped: 'the connection dropped',
  secure: 'the secure connection failed (check the PC\'s date and time)',
  password: 'the user name or password is wrong',
  noApp: 'no app is set to open this kind of file',
  gone: 'the device was unplugged or changed',
  badName: 'Windows does not allow that name',
  writeProtected: 'the disk is write-protected',
  damaged: 'the file or folder is damaged',
  cloudOff: 'the file is online-only and OneDrive, or the app that syncs it, is not running',
  cloud: 'the online-only file could not be fetched from OneDrive or the app that syncs it',
  // Windows Update (learn.microsoft.com/windows/deployment/update/windows-update-error-reference)
  wuBusy: 'Windows Update is busy with another check or an install; try again in a few minutes',
  wuInstalling: 'Windows Update is installing, or waiting for a restart to finish installing',
  wuSelf: 'Windows Update is updating itself; try again in a few minutes',
  wuStopping: 'Windows Update was stopping (Windows may be restarting); try again in a minute',
  wuNoService: 'Windows Update is not available right now',
  wuServer: 'the Windows Update server is not answering; Windows tries again by itself',
  wuServerMissing: 'the Windows Update server did not have it; Windows tries again by itself',
  wuFilesDownload: 'Windows could not download files it needed to install it',
  wuDownload: 'the download did not finish; Windows tries again by itself',
  wuRestart: 'it did not finish after the restart; Windows tries again by itself',
  wuNotApplicable: 'it does not apply to this PC',
  wuNothing: 'there was nothing to do',
  wuPolicy: 'a policy on this PC blocks Windows Update',
  wuAllFailed: 'none of the updates installed',
  wuInstaller: 'the installer stopped with an error; Windows usually tries again by itself',
  wuReserved: 'Windows could not finish it: the system reserved partition may be too small, or the network dropped',
  wuFiles: 'Windows could not find files it needed to install it',
  wuDamaged: 'some Windows system files are damaged',
  wuGeneric: 'Windows Update reported an error it did not explain',
};
/** An error with no known meaning: still said, in words. */
const GENERIC = 'Windows reported an unexpected error';
/** A JavaScript error inside Mantle itself (a TypeError and the like): Mantle's fault, said as such. */
const INTERNAL = 'Mantle hit an internal error';

/* Win32 error codes (learn.microsoft.com/windows/win32/debug/system-error-codes). An HRESULT
   0x8007xxxx is HRESULT_FROM_WIN32(xxxx) and reads from this table too. */
const WIN32 = {
  2: W.fileNotFound, 3: W.folderNotFound, 4: W.tooMany, 5: W.denied, 8: W.memory, 14: W.memory, 15: W.driveNotFound,
  19: W.writeProtected, 21: W.notReady, 32: W.inUse, 33: W.inUse, 39: W.diskFull, 50: W.unsupported,
  53: W.netPath, 64: W.dropped, 67: W.netPath, 80: W.exists, 87: W.badRequest, 112: W.diskFull, 120: W.unsupported,
  145: W.notEmpty, 170: W.resInUse, 183: W.exists, 206: W.tooLong, 225: 'Windows Security blocked it because it may be unsafe',
  258: W.timeout, 1060: W.serviceMissing, 1058: W.serviceDisabled, 1062: W.serviceOff, 1068: W.serviceOff,
  1155: W.noApp, 1167: W.notConnected, 1168: W.notFound, 1222: W.noNet, 1223: W.cancelled, 1235: W.cancelled,
  1314: W.admin, 1326: W.password, 1450: 'Windows ran out of resources', 1460: W.timeout, 1722: W.serviceOff,
  1726: W.rpcStopped, 740: W.admin, 1056: 'it is already running', 1392: W.damaged, 111: W.tooLong, 123: W.badName, 161: W.badName, 362: W.cloudOff,
  4319: W.notReady, 1231: W.netPath, 1232: W.netPath,
};
/* Windows' cloud-file errors (ERROR_CLOUD_FILE_*, 380 to 399; 362 is the provider not running): OneDrive and the like. */
for (let n = 380; n <= 399; n++) if (!WIN32[n]) WIN32[n] = W.cloud;

/* HRESULTs that are not HRESULT_FROM_WIN32, or that read better specifically. */
const HR = {
  '0x80004001': W.unsupported,   // E_NOTIMPL
  '0x80004002': W.unsupported,   // E_NOINTERFACE
  '0x80004004': W.cancelled,     // E_ABORT
  '0x8000000E': W.notReadyNow,   // E_ILLEGAL_METHOD_CALL: called at an unexpected time
  '0x80040154': W.notInstalled,  // REGDB_E_CLASSNOTREG
  '0x80080005': 'the Windows service it needs did not start',   // CO_E_SERVER_EXEC_FAILURE
  '0x800401F3': W.notInstalled,  // CO_E_CLASSSTRING
  '0x80010108': W.rpcStopped,      // RPC_E_DISCONNECTED
  '0x800706BA': W.serviceOff,    // RPC_S_SERVER_UNAVAILABLE
  '0x800706BE': W.rpcStopped,      // RPC_S_CALL_FAILED
  '0x8001010A': W.busy,          // RPC_E_SERVERCALL_RETRYLATER
  '0x80010001': W.busy,          // RPC_E_CALL_REJECTED
  '0x8001010E': INTERNAL,        // RPC_E_WRONG_THREAD: Mantle called from the wrong thread
  '0x80070015': W.notReady,
  '0x8007000E': W.memory,        // E_OUTOFMEMORY
  '0x80070057': W.badRequest,    // E_INVALIDARG
  '0x88890004': W.gone,          // AUDCLNT_E_DEVICE_INVALIDATED
  '0x88890008': W.unsupported,   // AUDCLNT_E_UNSUPPORTED_FORMAT
  '0x8889000A': W.audioInUse,    // AUDCLNT_E_DEVICE_IN_USE (another app holds it in exclusive mode)
  '0x88890010': W.serviceOff,    // AUDCLNT_E_SERVICE_NOT_RUNNING
  '0x88890026': W.gone,          // AUDCLNT_E_RESOURCES_INVALIDATED
  '0x80072EE2': W.timeout,       // WININET_E_TIMEOUT
  '0x80072EE7': W.noReach,         // WININET_E_NAME_NOT_RESOLVED
  '0x80072EFD': W.noReach,         // WININET_E_CANNOT_CONNECT
  '0x80072EFE': W.dropped,       // WININET_E_CONNECTION_ABORTED
  '0x80072F8F': W.secure,        // WININET_E_DECODING_FAILED (certificate / clock)
  '0x800F0922': W.wuReserved,    // CBS_E_INSTALLERS_FAILED
  '0x800F081F': W.wuFiles,       // CBS_E_SOURCE_MISSING
  '0x800F0906': W.wuFilesDownload,       // CBS_E_DOWNLOAD_FAILURE
  '0x80073712': W.wuDamaged,     // ERROR_SXS_COMPONENT_STORE_CORRUPT
  '0x80070643': W.wuInstaller,   // ERROR_INSTALL_FAILURE
  '0xC0000005': 'Windows stopped it because it crashed',
  '0xC0000022': W.denied,        // STATUS_ACCESS_DENIED
  '0xC0000034': W.notFound,      // STATUS_OBJECT_NAME_NOT_FOUND
  // Windows Update Agent, WU_E_*
  '0x80240001': W.wuNoService,   // WU_E_NO_SERVICE
  '0x80240009': W.wuBusy,        // WU_E_OPERATIONINPROGRESS
  '0x8024000B': W.cancelled,     // WU_E_CALL_CANCELLED
  '0x8024000C': W.wuNothing,     // WU_E_NOOP
  '0x80240016': W.wuInstalling,  // WU_E_INSTALL_NOT_ALLOWED
  '0x80240017': W.wuNotApplicable, // WU_E_NOT_APPLICABLE
  '0x8024001B': W.wuSelf,        // WU_E_SELFUPDATE_IN_PROGRESS
  '0x8024001E': W.wuStopping,    // WU_E_SERVICE_STOP
  '0x80240022': W.wuAllFailed,   // WU_E_ALL_UPDATES_FAILED
  '0x8024002E': W.wuPolicy,      // WU_E_WU_DISABLED
  '0x80240438': W.noReach,         // WU_E_PT_ENDPOINT_UNREACHABLE
  '0x8024402C': W.noReach,       // WU_E_PT_WINHTTP_NAME_NOT_RESOLVED (server or proxy name not resolved)
  '0x8024401C': W.wuServer,      // WU_E_PT_HTTP_STATUS_REQUEST_TIMEOUT
  '0x80244022': W.wuServer,      // WU_E_PT_HTTP_STATUS_SERVICE_UNAVAIL
  '0x80244010': W.wuServer,      // WU_E_PT_EXCEEDED_MAX_SERVER_TRIPS
  '0x80244019': W.wuServerMissing,      // WU_E_PT_HTTP_STATUS_NOT_FOUND
  '0x8024200D': W.wuDownload,    // WU_E_UH_NEEDANOTHERDOWNLOAD
  '0x80246008': W.wuDownload,    // WU_E_DM_BITSTRANSFERERROR
  '0x8024402F': W.wuDownload,    // WU_E_PT_ECP_SUCCEEDED_WITH_ERRORS
  '0x80242016': W.wuRestart,     // WU_E_UH_POSTREBOOTUNEXPECTEDSTATE
  '0x80248000': W.wuStopping,    // WU_E_DS_SHUTDOWN
  '0x80248001': W.wuBusy,        // WU_E_DS_INUSE
  '0x8024800C': W.wuBusy,        // WU_E_DS_LOCKTIMEOUTEXPIRED
  '0x8024800F': W.wuBusy,        // WU_E_DS_STOREFILELOCKED
  '0x8024A000': W.wuNoService,   // WU_E_AU_NOSERVICE
};

/* Node's errno names (nodejs.org/api/errors.html#common-system-errors). */
const ERRNO = {
  ENOENT: W.notFound, EACCES: W.denied, EPERM: W.denied, EBUSY: W.inUse, ENOSPC: W.diskFull,
  ETIMEDOUT: W.timeout, ECONNREFUSED: W.refused, ECONNRESET: W.dropped, ECONNABORTED: W.dropped,
  ENOTFOUND: W.noReach, EAI_AGAIN: W.noReach, ENETUNREACH: W.noNet, EHOSTUNREACH: W.noNet, ENETDOWN: W.noNet,
  EEXIST: W.exists, ENOTEMPTY: W.notEmpty, EMFILE: W.tooMany, ENFILE: W.tooMany, EPIPE: W.dropped,
  EINVAL: W.badRequest, EISDIR: 'that is a folder, not a file', ENOTDIR: 'that is a file, not a folder',
  EXDEV: 'it cannot be moved to another drive that way', ENAMETOOLONG: W.tooLong, EROFS: 'the disk is read-only',
};

/* .NET exception type names (learn.microsoft.com/dotnet/api). */
const TYPES = {
  UnauthorizedAccessException: W.denied, SecurityException: W.denied,
  FileNotFoundException: W.fileNotFound, DirectoryNotFoundException: W.folderNotFound,
  DriveNotFoundException: W.driveNotFound, PathTooLongException: W.tooLong,
  TimeoutException: W.timeout, OperationCanceledException: W.cancelled, TaskCanceledException: W.cancelled,
  OutOfMemoryException: W.memory, InsufficientMemoryException: W.memory,
  NotSupportedException: W.unsupported, PlatformNotSupportedException: W.unsupported, NotImplementedException: W.unsupported,
  ArgumentException: W.badRequest, ArgumentNullException: W.badRequest, ArgumentOutOfRangeException: W.badRequest,
  FileLoadException: W.missingPart, DllNotFoundException: W.missingPart, TypeLoadException: W.missingPart,
  EntryPointNotFoundException: W.missingPart, BadImageFormatException: W.missingPart,
};

/* Windows' own English messages, for "TypeName: message" with no code (the message is dropped, its meaning kept). */
const SNIFF = [
  [/being used by another process|sharing violation|\block(?:ed)? a portion|resource busy or locked|file is locked/i, W.inUse],
  [/not enough (?:space|disk)|disk is full/i, W.diskFull],
  [/cloud file provider is not running/i, W.cloudOff],
  [/cloud (?:file|operation)/i, W.cloud],
  [/write[- ]protected/i, W.writeProtected],
  [/(?:file name|directory name|volume label) syntax is incorrect/i, W.badName],
  [/access (?:to the path .* )?is denied|access denied|permission denied|not permitted/i, W.denied],
  [/blocked by (?:your |the |an? )?(?:system )?administrator|group policy|by (?:a )?policy/i, W.policy],
  [/requires elevation|administrator (?:rights|privileges|permission)|run (?:it )?as (?:an )?administrator/i, W.admin],
  [/could not find a part of the path|cannot find the path|path (?:was )?not found/i, W.folderNotFound],
  [/could not find file|cannot find the file|file not found|no such file/i, W.fileNotFound],
  [/network path was not found|network name|no such host|could not be resolved|network is unreachable|no internet/i, W.netPath],
  [/timed? ?out|timeout/i, W.timeout],
  [/service (?:has not been started|is not running|cannot be started)/i, W.serviceOff],
  [/\bservice\b[^.]{0,60}\bdisabled\b|\bdisabled\b[^.]{0,20}\bservice\b/i, W.serviceDisabled],
  [/\bdisabled\b|turned off/i, W.turnedOff],
  [/element not found|not found/i, W.notFound],
  [/cancel+ed|aborted/i, W.cancelled],
  [/not supported|not implemented/i, W.unsupported],
  [/device is not ready/i, W.notReady],
  [/already exists/i, W.exists],
  [/out of memory|insufficient memory/i, W.memory],
  [/server is busy|is busy|in use/i, W.busy],
];

/* ---- finding the technical part ----------------------------------------------------------------- */
const M = '\u0000';   // where a technical part was: the words go at the first one
/* Node words a system error as "[syscall ]CODE[: text]" or "syscall CODE address": "getaddrinfo ENOTFOUND
   example.com", "connect ECONNREFUSED 127.0.0.1:80". The syscall and the address go with the code. */
const SYSCALL = 'spawn \\S+|getaddrinfo|connect|read|write|open|lstat|stat|unlink|rename|mkdir|rmdir|scandir|opendir|copyfile|readlink|symlink|chmod|utime|watch|listen|bind';
const ERRNO_RE = new RegExp(`(?:\\b(?:${SYSCALL}) )?\\b(${Object.keys(ERRNO).join('|')}|ERR_[A-Z_]{3,})\\b(?::[^()\\r\\n;]*| [\\w.-]*[.:\\d][^\\s();,]*)?`, 'g');
const HEX_RE = /\b(?:(?:HRESULT|hr|error|code)[:= ]+)?(0x[89abcABC][0-9a-fA-F]{7})\b/g;
const NEG_HR_RE = /\b(?:HRESULT|HResult|hr)[:= ]+(-2\d{9}|-1\d{9})\b/g;
const TYPE_RE = /(?:\b[A-Za-z_]\w*\.)*\b([A-Z]\w*Exception)\b(?:\s*\(?(0x[0-9a-fA-F]{8})\)?)?(?::[ \t]*((?:[^()\r\n;]|\([^()\r\n]*\))*))?/g;
const WIN32_RE = /\b(?:access (?:is )?denied|denied)\s*\((\d{1,5})\)|(?<!HTTP |status )\b(?:win32 |windows |system |native |last )?error(?: code)?[ =#]?(\d{1,5})\b/gi;
const SOFT = '\u0002';
const SYM_RE = /\b((?:[A-Z][A-Z0-9]*_)*(?:ERROR|ERR|E)_[A-Z0-9]+(?:_[A-Z0-9]+)*)\b(?::[ \t]*[^()\r\n;]*)?/g;
const SYM = {
  ERROR_ACCESS_DENIED: W.denied, E_ACCESSDENIED: W.denied, ERROR_FILE_NOT_FOUND: W.fileNotFound, ERROR_PATH_NOT_FOUND: W.folderNotFound,
  ERROR_SHARING_VIOLATION: W.inUse, ERROR_DISK_FULL: W.diskFull, ERROR_NOT_SUPPORTED: W.unsupported, ERROR_TIMEOUT: W.timeout,
  ERROR_SERVICE_NOT_ACTIVE: W.serviceOff, ERROR_SERVICE_DISABLED: W.serviceDisabled, ERROR_CANCELLED: W.cancelled,
  E_INVALIDARG: W.badRequest, E_OUTOFMEMORY: W.memory, E_NOTIMPL: W.unsupported,
  WU_E_OPERATIONINPROGRESS: W.wuBusy, WU_E_NO_SERVICE: W.wuNoService, WU_E_SERVICE_STOP: W.wuStopping, WU_E_WU_DISABLED: W.wuPolicy,
  WU_E_PT_WINHTTP_NAME_NOT_RESOLVED: W.noReach, WU_E_PT_ENDPOINT_UNREACHABLE: W.noReach,
  MEDIA_ERR_DECODE: 'the video is damaged or in a format Mantle cannot play', MEDIA_ERR_SRC_NOT_SUPPORTED: 'the video is in a format Mantle cannot play',
};
const JS_RE =/\b(TypeError|ReferenceError|RangeError|SyntaxError)\b(?::[ \t]*(?:[^()\r\n;]|\([^()\r\n]*\))*)?/g;

const hexOf = (h) => '0x' + h.slice(2).toUpperCase();
const negHex = (n) => '0x' + ((Number(n) >>> 0).toString(16).toUpperCase().padStart(8, '0'));

/** The words for one code, or null. */
function meaning(code) {
  if (typeof code !== 'string' || !code) return null;
  if (/^0x[0-9a-f]{8}$/i.test(code)) {
    const h = hexOf(code);
    if (HR[h]) return HR[h];
    if (/^0x8007/.test(h)) return WIN32[parseInt(h.slice(6), 16)] || null;
    return null;
  }
  const w = /^win32:(\d+)$/.exec(code);
  if (w) return WIN32[Number(w[1])] || null;
  if (ERRNO[code]) return ERRNO[code];
  if (TYPES[code]) return TYPES[code];
  return null;
}

function sniff(msg) {
  if (!msg) return null;
  for (const [re, words] of SNIFF) if (re.test(msg)) return words;
  return null;
}

/** -> { text, codes, changed } (see the header). */
function plainText(s) {
  if (typeof s !== 'string' || !s) return { text: s, codes: [], changed: false };
  const codes = [];
  const strong = [];   // meanings from a code: they win
  const weak = [];     // meanings from a type name or a sniffed message
  const add = (code, slot) => { if (!codes.includes(code)) codes.push(code); const m = meaning(code); if (m) slot.push(m); };
  let t = s;
  let hit = false;
  // stack text: "   at Namespace.Type.Method(...)" to the end
  t = t.replace(/(?:\r?\n|\s)+at [\w.`<>[\]$]+\([^]*$/, () => { hit = true; codes.push('stack'); return ''; });
  t = t.replace(/\r?\n[^]*$/, (m) => (hit ? '' : m));
  // .NET's own "(Exception from HRESULT: 0x...)"
  // (.NET Framework adds the symbol: "(Exception from HRESULT: 0x80070005 (E_ACCESSDENIED))")
  t = t.replace(/\s*\(Exception from HRESULT: (0x[0-9a-fA-F]{8})(?:\s*\(([A-Z][A-Z0-9_]*)\))?\)/g, (m, h, sym) => {
    hit = true;
    add(hexOf(h), strong);
    if (sym && !codes.includes(sym)) codes.push(sym);
    return '';
  });
  t = t.replace(NEG_HR_RE, (m, n) => { hit = true; add(negHex(n), strong); return M; });
  t = t.replace(TYPE_RE, (m, type, h, msg) => {
    hit = true;
    if (!codes.includes(type)) codes.push(type);
    if (h) add(hexOf(h), strong);
    const inner = msg ? /0x[89abcABC][0-9a-fA-F]{7}/.exec(msg) : null;
    if (inner) add(hexOf(inner[0]), strong);
    const sn = sniff(msg);
    if (sn) weak.push(sn);
    if (TYPES[type]) weak.push(TYPES[type]);
    return M;
  });
  t = t.replace(HEX_RE, (m, h) => { hit = true; add(hexOf(h), strong); return M; });
  t = t.replace(WIN32_RE, (m, a, b) => { hit = true; add(`win32:${Number(a || b)}`, strong); return M; });
  t = t.replace(ERRNO_RE, (m, name) => { hit = true; add(name, strong); const sn = sniff(m.slice(name.length)); if (sn) weak.push(sn); return M; });
  t = t.replace(JS_RE, (m, name) => { hit = true; if (!codes.includes(name)) codes.push(name); weak.push(INTERNAL); return M; });
  // a symbolic code (WU_E_PT_..., ERROR_ACCESS_DENIED, Chromium's PIPELINE_ERROR_DECODE): its words if
  // known; otherwise it is only dropped when the sentence already says what failed
  let soft = false;
  t = t.replace(SYM_RE, (m, name) => {
    hit = true;
    if (!codes.includes(name)) codes.push(name);
    if (SYM[name]) { strong.push(SYM[name]); return M; }
    soft = true;
    return SOFT;
  });
  if (!hit) return { text: s, codes: [], changed: false };
  if (soft) {
    const hard = t.includes(M);
    const rest = t.split(SOFT).join(' ').replace(/[()\s:;,]+/g, ' ').trim();
    t = hard || rest.split(' ').length >= 3
      ? t.replace(/\s*\(\s*\u0002\s*\)|\s*[:,;]?\s*\u0002/g, '')
      : t.split(SOFT).join(M);
    if (!t.includes(M)) {
      t = t.replace(/\s+([,.;:)])/g, '$1').replace(/[ \t]{2,}/g, ' ').trim().replace(/[:,;]\s*$/, '');
      return { text: t || GENERIC, codes, changed: t !== s };
    }
  }
  const wu = codes.some((c) => /^0x8024/.test(c));
  const words = strong[0] || weak[0] || (wu ? W.wuGeneric : GENERIC);
  // "X threw <code>" / "failed with <code>" read as "X failed: <words>" / "failed: <words>"
  t = t.replace(/\s+(?:threw|thrown|raised)(?: an?)?(?: error| exception)?\s*(?=\u0000)/g, ' failed: ')
    .replace(/\s+(?:with|gave|returned)(?: an?)?(?: error| exception| code)?\s*(?=\u0000)/g, ': ');
  let first = true;
  t = t.replace(/\u0000(?:[\s:,]*\u0000)*/g, () => { if (!first) return ''; first = false; return '\u0001'; });
  // tidy what is left around the words
  t = t.replace(/\u0001\s*\(\s*\)/g, '\u0001')
    .replace(/\(\s*\)/g, '')
    .replace(/\(\s*\u0001\s*\)\s*\(\s*\u0001?\s*\)/g, '(\u0001)')
    .replace(/(\S)\s*:\s*\(\s*\u0001\s*\)/g, '$1: \u0001')
    .replace(/\s+([,.;:)])/g, '$1')
    .replace(/\(\s+/g, '(')
    .replace(/:\s*:/g, ':')
    .replace(/[ \t]{2,}/g, ' ')
    .trim()
    .replace(/[:,;]\s*$/, '');
  // the words where the code was; a sentence that IS the words starts with a capital
  t = t.replace('\u0001', words);
  if (t.startsWith(words)) t = t.charAt(0).toUpperCase() + t.slice(1);
  if (!t) t = GENERIC;
  return { text: t, codes, changed: t !== s };
}

function plain(s) { return plainText(s).text; }

/* ---- replies and pushes ------------------------------------------------------------------------- */
/* A field whose text says what went wrong. `title`, `name`, `text`, `body`, `message` and the like are
   never touched: those carry a person's own content (a file name, a notification, a clip). */
const KEY_RE = /^(?:reason|why|error|err|warn|warning|warnings|note|notes|hint|refusal|failed|failure|problem|problems|detail)$|(?:Reason|Why|Error|Warn|Warning|Note|Hint|Refusal|Problem)s?$/;
const MAX_DEPTH = 6;
const MAX_ITEMS = 5000;

function plainReply(v, onCodes) {
  const found = [];
  const out = walk(v, 0, false, found);
  if (found.length && typeof onCodes === 'function') {
    try { onCodes(Array.from(new Set(found))); } catch (_) { /* a log that throws never costs the page its reply */ }
  }
  return out;
}

function walk(v, depth, keyed, found) {
  if (typeof v === 'string') {
    if (!keyed) return v;
    const r = plainText(v);
    if (r.codes.length) found.push(...r.codes);
    return r.text;
  }
  if (!v || typeof v !== 'object' || depth >= MAX_DEPTH) return v;
  if (Array.isArray(v)) {
    if (v.length > MAX_ITEMS) return v;
    let copy = null;
    for (let i = 0; i < v.length; i++) {
      const n = walk(v[i], depth + 1, keyed, found);
      if (n !== v[i]) { if (!copy) copy = v.slice(); copy[i] = n; }
    }
    return copy || v;
  }
  const proto = Object.getPrototypeOf(v);
  if (proto !== Object.prototype && proto !== null) return v;   // a Buffer, a Date, a class: not ours
  let copy = null;
  for (const k of Object.keys(v)) {
    const cur = v[k];
    if (cur === null || (typeof cur !== 'object' && typeof cur !== 'string')) continue;
    const n = walk(cur, depth + 1, KEY_RE.test(k), found);
    if (n !== cur) { if (!copy) copy = Object.assign({}, v); copy[k] = n; }
  }
  return copy || v;
}

/** (where, codes) => void: each distinct where+codes written once (the last 300 remembered). */
function onceLogger(write) {
  const said = new Set();
  return (where, codes) => {
    if (!codes || !codes.length) return;
    const key = `${where}|${codes.join(',')}`;
    if (said.has(key)) return;
    said.add(key);
    if (said.size > 300) said.delete(said.values().next().value);
    try { write(`${where}: shown in plain words, the codes were ${codes.join(', ')}`); } catch (_) { /* the log is best effort */ }
  };
}

/** plainReply for a page, the codes said once on Mantle's own log (stdout = mantle.log). */
const stdoutSaid = onceLogger((line) => process.stdout.write(`mantle: ${line}\n`));
function toPage(where, v) { return plainReply(v, (codes) => stdoutSaid(where, codes)); }

/** A page's own error for its log line: "TypeError: x is not a function", one line, no file:/// address
    (that has the home folder in it), at most 300 characters. Never shown on screen. */
function forLog(err) {
  const name = err && typeof err === 'object' && err.name ? String(err.name) : '';
  let msg = err && typeof err === 'object' && 'message' in err ? String(err.message) : String(err);
  msg = msg.replace(/\r?\n[^]*$/, '').replace(/\b(?:file|https?):\/\/\/?[^\s)'"]*/gi, '<address>');
  const s = name && !msg.startsWith(name) ? `${name}: ${msg}` : msg;
  return s.length > 300 ? `${s.slice(0, 297)}...` : (s || 'no reason given');
}

const API = { plain, plainText, plainReply, toPage, meaning, onceLogger, forLog, GENERIC, INTERNAL, KEY_RE, WORDS: W };
if (typeof module === 'object' && module && module.exports) module.exports = API;
else root.MantlePlain = API;
}(typeof globalThis !== 'undefined' ? globalThis : this));
