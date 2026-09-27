// Windows-only, std-only supervisor. Build with scripts/build-cc-job.mjs; no binary is checked in.
// First-party source for this project; repository license is not declared here.
// Rust std/toolchain distribution terms are independent. Protocol: [kind:u8][length:u32 little endian][bytes].
// Parent->helper: I input bytes, E input EOF, K terminate job. Helper->parent:
// P child PID (u32 LE), O stdout bytes, R stderr bytes, D exit code (i32 LE) after job empty.
// A missing D is ALWAYS unconfirmed, including helper crash or protocol corruption.
#![cfg(windows)]
use std::{env, io::{self, Read, Write}, mem::{size_of, zeroed}, os::windows::ffi::OsStrExt,
    ptr::{null, null_mut}, sync::{Arc, atomic::{AtomicBool, Ordering}},
    thread, time::{Duration, Instant}};
use std::ffi::c_void;

type Handle = *mut c_void;
type Bool = i32;
type Dword = u32;
const INVALID: Handle = -1isize as Handle;
const CREATE_SUSPENDED: Dword = 4;
const CREATE_NO_WINDOW: Dword = 0x0800_0000;
const STARTF_USESTDHANDLES: Dword = 0x100;
const HANDLE_FLAG_INHERIT: Dword = 1;
const JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE: Dword = 0x2000;
const JOB_OBJECT_EXTENDED_LIMIT_INFORMATION: Dword = 9;
const JOB_OBJECT_BASIC_ACCOUNTING_INFORMATION: Dword = 1;
const WAIT_OBJECT_0: Dword = 0;

#[repr(C)] struct SecurityAttributes { length: Dword, descriptor: *mut c_void, inherit: Bool }
#[repr(C)] struct StartupInfo {
    cb: Dword, reserved: *mut u16, desktop: *mut u16, title: *mut u16,
    x: Dword, y: Dword, width: Dword, height: Dword, xchars: Dword, ychars: Dword,
    fill: Dword, flags: Dword, show: u16, reserved2: u16, reserved_ptr: *mut u8,
    stdin: Handle, stdout: Handle, stderr: Handle,
}
#[repr(C)] struct ProcessInformation { process: Handle, thread: Handle, pid: Dword, tid: Dword }
#[repr(C)] struct BasicLimit {
    process_time: i64, job_time: i64, flags: Dword, min_memory: usize, max_memory: usize,
    active_limit: Dword, affinity: usize, priority: Dword, scheduling: Dword,
}
#[repr(C)] struct IoCounters { read_ops: u64, write_ops: u64, other_ops: u64,
    read_bytes: u64, write_bytes: u64, other_bytes: u64 }
#[repr(C)] struct ExtendedLimit { basic: BasicLimit, io: IoCounters,
    process_memory: usize, job_memory: usize, peak_process: usize, peak_job: usize }
#[repr(C)] struct BasicAccounting { user: i64, kernel: i64, period_user: i64, period_kernel: i64,
    page_faults: Dword, total: Dword, active: Dword, terminated: Dword }
#[link(name = "kernel32")]
unsafe extern "system" {
    fn CreatePipe(read: *mut Handle, write: *mut Handle, attrs: *mut SecurityAttributes, size: Dword) -> Bool;
    fn SetHandleInformation(handle: Handle, mask: Dword, flags: Dword) -> Bool;
    fn CreateJobObjectW(attrs: *mut c_void, name: *const u16) -> Handle;
    fn SetInformationJobObject(job: Handle, class: Dword, info: *const c_void, length: Dword) -> Bool;
    fn QueryInformationJobObject(job: Handle, class: Dword, info: *mut c_void, length: Dword, returned: *mut Dword) -> Bool;
    fn AssignProcessToJobObject(job: Handle, process: Handle) -> Bool;
    fn TerminateJobObject(job: Handle, code: Dword) -> Bool;
    fn CreateProcessW(app: *const u16, command: *mut u16, process_attrs: *mut c_void,
        thread_attrs: *mut c_void, inherit: Bool, flags: Dword, environment: *mut c_void,
        cwd: *const u16, startup: *const StartupInfo, info: *mut ProcessInformation) -> Bool;
    fn ResumeThread(thread: Handle) -> Dword;
    fn TerminateProcess(process: Handle, code: Dword) -> Bool;
    fn WaitForSingleObject(handle: Handle, milliseconds: Dword) -> Dword;
    fn GetExitCodeProcess(process: Handle, code: *mut Dword) -> Bool;
    fn ReadFile(handle: Handle, buffer: *mut c_void, len: Dword, read: *mut Dword, overlapped: *mut c_void) -> Bool;
    fn WriteFile(handle: Handle, buffer: *const c_void, len: Dword, written: *mut Dword, overlapped: *mut c_void) -> Bool;
    fn CloseHandle(handle: Handle) -> Bool;
}
struct Owned(Handle);
impl Owned {
    fn read(&self, buffer: &mut [u8], n: &mut Dword) -> Bool {
        unsafe { ReadFile(self.0, buffer.as_mut_ptr().cast(), buffer.len() as u32, n, null_mut()) }
    }
    fn write_all(&self, bytes: &[u8]) -> io::Result<()> { write_all(self.0, bytes) }
}
impl Drop for Owned { fn drop(&mut self) { if !self.0.is_null() && self.0 != INVALID { unsafe { CloseHandle(self.0); } } } }
unsafe impl Send for Owned {}
fn check(ok: Bool) -> io::Result<()> { if ok == 0 { Err(io::Error::last_os_error()) } else { Ok(()) } }
fn pipe() -> io::Result<(Owned, Owned)> {
    let mut read = null_mut(); let mut write = null_mut();
    let mut attrs = SecurityAttributes { length: size_of::<SecurityAttributes>() as u32, descriptor: null_mut(), inherit: 1 };
    check(unsafe { CreatePipe(&mut read, &mut write, &mut attrs, 0) })?;
    Ok((Owned(read), Owned(write)))
}
fn write_all(handle: Handle, mut bytes: &[u8]) -> io::Result<()> {
    while !bytes.is_empty() {
        let mut n = 0;
        check(unsafe { WriteFile(handle, bytes.as_ptr().cast(), bytes.len().min(u32::MAX as usize) as u32, &mut n, null_mut()) })?;
        if n == 0 { return Err(io::Error::from(io::ErrorKind::WriteZero)); }
        bytes = &bytes[n as usize..];
    }
    Ok(())
}
fn frame(kind: u8, bytes: &[u8]) -> io::Result<()> {
    // Stdout's process-wide lock serializes frames from both pipe readers and the main thread.
    let stdout = io::stdout(); let mut out = stdout.lock();
    out.write_all(&[kind])?;
    out.write_all(&(bytes.len() as u32).to_le_bytes())?;
    out.write_all(bytes)?;
    out.flush()
}
fn reader(handle: Owned, kind: u8) -> thread::JoinHandle<io::Result<()>> {
    thread::spawn(move || {
        let mut bytes = [0u8; 8192];
        loop {
            let mut n = 0;
            let ok = handle.read(&mut bytes, &mut n);
            if ok == 0 {
                let error = io::Error::last_os_error();
                if matches!(error.raw_os_error(), Some(109 | 232)) { break; } // ERROR_BROKEN_PIPE / ERROR_NO_DATA
                return Err(error);
            }
            if n == 0 { break; }
            frame(kind, &bytes[..n as usize])?;
        }
        Ok(())
    })
}
fn quote(arg: &str) -> String {
    let mut result = String::from("\""); let mut slashes = 0;
    for c in arg.chars() {
        if c == '\\' { slashes += 1; continue; }
        if c == '"' { result.push_str(&"\\".repeat(slashes * 2 + 1)); }
        else { result.push_str(&"\\".repeat(slashes)); }
        slashes = 0; result.push(c);
    }
    result.push_str(&"\\".repeat(slashes * 2)); result.push('"'); result
}
fn active(job: Handle) -> io::Result<Dword> {
    let mut info: BasicAccounting = unsafe { zeroed() };
    check(unsafe { QueryInformationJobObject(job, JOB_OBJECT_BASIC_ACCOUNTING_INFORMATION,
        (&mut info as *mut BasicAccounting).cast(), size_of::<BasicAccounting>() as u32, null_mut()) })?;
    Ok(info.active)
}
fn input(child_stdin: Owned, job: Handle, writer_failed: Arc<AtomicBool>,
    cancelled: Arc<AtomicBool>, writer_done: Arc<AtomicBool>) -> bool {
    let mut source = io::stdin().lock();
    let mut input: Option<Vec<u8>> = None;
    let mut child_stdin = Some(child_stdin);
    loop {
        let mut header = [0u8; 5];
        if source.read_exact(&mut header).is_err() { return false; }
        let len = u32::from_le_bytes(header[1..5].try_into().unwrap()) as usize;
        if len > 8 * 1024 * 1024 { return false; }
        if header[0] == b'K' && len == 0 {
            cancelled.store(true, Ordering::Release);
            unsafe { TerminateJobObject(job, 1); }
            return true;
        }
        if header[0] == b'I' && input.is_none() && child_stdin.is_some() {
            let mut bytes = vec![0u8; len];
            if source.read_exact(&mut bytes).is_err() { return false; }
            input = Some(bytes);
            continue;
        }
        if header[0] == b'E' && len == 0 && child_stdin.is_some() && input.is_some() {
            let bytes = input.take().unwrap();
            let writer = child_stdin.take().unwrap();
            let writer_failure = Arc::clone(&writer_failed);
            let writer_cancelled = Arc::clone(&cancelled);
            let writer_finished = Arc::clone(&writer_done);
            let job_value = job as usize;
            // A child may never read stdin. Its blocking WriteFile must NEVER block K/EOF.
            thread::spawn(move || {
                if writer.write_all(&bytes).is_err() && !writer_cancelled.load(Ordering::Acquire) {
                    writer_failure.store(true, Ordering::Release);
                    unsafe { TerminateJobObject(job_value as Handle, 1); }
                }
                writer_finished.store(true, Ordering::Release);
            });
            continue;
        }
        return false; // exactly one I, one E, then only K are accepted
    }
}
fn run() -> io::Result<()> {
    let args: Vec<String> = env::args().skip(1).collect();
    if args.is_empty() { return Err(io::Error::new(io::ErrorKind::InvalidInput, "missing child command")); }
    let (stdin_read, stdin_write) = pipe()?;
    let (stdout_read, stdout_write) = pipe()?;
    let (stderr_read, stderr_write) = pipe()?;
    for handle in [stdin_write.0, stdout_read.0, stderr_read.0] {
        check(unsafe { SetHandleInformation(handle, HANDLE_FLAG_INHERIT, 0) })?;
    }
    let job = Owned(unsafe { CreateJobObjectW(null_mut(), null()) });
    if job.0.is_null() { return Err(io::Error::last_os_error()); }
    let mut limits: ExtendedLimit = unsafe { zeroed() };
    limits.basic.flags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    check(unsafe { SetInformationJobObject(job.0, JOB_OBJECT_EXTENDED_LIMIT_INFORMATION,
        (&limits as *const ExtendedLimit).cast(), size_of::<ExtendedLimit>() as u32) })?;
    let cmd = args.iter().map(|s| quote(s)).collect::<Vec<_>>().join(" ");
    let mut cmd: Vec<u16> = std::ffi::OsStr::new(&cmd).encode_wide().chain(Some(0)).collect();
    let startup = StartupInfo { cb: size_of::<StartupInfo>() as u32, reserved: null_mut(),
        desktop: null_mut(), title: null_mut(), x: 0, y: 0, width: 0, height: 0,
        xchars: 0, ychars: 0, fill: 0, flags: STARTF_USESTDHANDLES,
        show: 0, reserved2: 0, reserved_ptr: null_mut(),
        stdin: stdin_read.0, stdout: stdout_write.0, stderr: stderr_write.0 };
    let mut info: ProcessInformation = unsafe { zeroed() };
    check(unsafe { CreateProcessW(null(), cmd.as_mut_ptr(), null_mut(), null_mut(), 1,
        CREATE_SUSPENDED | CREATE_NO_WINDOW, null_mut(), null(), &startup, &mut info) })?;
    let process = Owned(info.process); let thread_handle = Owned(info.thread);
    if let Err(error) = check(unsafe { AssignProcessToJobObject(job.0, process.0) }) {
        unsafe { TerminateProcess(process.0, 1); }
        return Err(error);
    }
    // All inheritable child handles are closed in the helper before any reads start.
    drop(stdin_read); drop(stdout_write); drop(stderr_write);
    let out = reader(stdout_read, b'O'); let err = reader(stderr_read, b'R');
    frame(b'P', &info.pid.to_le_bytes())?;
    if unsafe { ResumeThread(thread_handle.0) } == u32::MAX {
        unsafe { TerminateJobObject(job.0, 1); }
        return Err(io::Error::last_os_error());
    }
    drop(thread_handle);
    let job_value = job.0 as usize;
    let bad_control = Arc::new(AtomicBool::new(false));
    let writer_failed = Arc::new(AtomicBool::new(false));
    let cancelled = Arc::new(AtomicBool::new(false));
    let writer_done = Arc::new(AtomicBool::new(false));
    let bad_control_thread = Arc::clone(&bad_control);
    let writer_failed_thread = Arc::clone(&writer_failed);
    let cancelled_thread = Arc::clone(&cancelled);
    let writer_done_thread = Arc::clone(&writer_done);
    thread::spawn(move || {
        if !input(stdin_write, job_value as Handle, writer_failed_thread,
            cancelled_thread, writer_done_thread) {
            bad_control_thread.store(true, Ordering::Release);
            // EOF/corruption is NOT successful completion: parent may have crashed.
            unsafe { TerminateJobObject(job_value as Handle, 1); }
        }
    });
    // A root exiting does not prove descendants are gone. Wait for actual job accounting.
    let mut empty_since = None;
    loop {
        if active(job.0)? == 0 { empty_since.get_or_insert_with(Instant::now); }
        else { empty_since = None; }
        if empty_since.is_some_and(|instant: Instant| instant.elapsed() >= Duration::from_millis(50)) { break; }
        thread::sleep(Duration::from_millis(20));
    }
    // Job accounting can hit zero just before the root process handle becomes signalled.
    if unsafe { WaitForSingleObject(process.0, 2_000) } != WAIT_OBJECT_0 || active(job.0)? != 0 {
        return Err(io::Error::other("job empty but root process not signalled / descendants reappeared"));
    }
    let mut exit = 0;
    check(unsafe { GetExitCodeProcess(process.0, &mut exit) })?;
    out.join().map_err(|_| io::Error::other("stdout reader panic"))??;
    err.join().map_err(|_| io::Error::other("stderr reader panic"))??;
    // Job still held here, and verified empty after pipes close. Only D grants confirmation.
    // A finished process with an outstanding writer may never have received its prompt.
    let writer_deadline = Instant::now() + Duration::from_secs(2);
    while !cancelled.load(Ordering::Acquire) && !writer_done.load(Ordering::Acquire) &&
        Instant::now() < writer_deadline { thread::sleep(Duration::from_millis(10)); }
    if bad_control.load(Ordering::Acquire) ||
        (!cancelled.load(Ordering::Acquire) && !writer_done.load(Ordering::Acquire)) {
        return Err(io::Error::other("parent control or child input unconfirmed"));
    }
    // A closed child stdin is an input failure, not a failure of the Job Object stop proof.
    // Preserve the verified empty-job D frame but never report a successful turn for partial input.
    if writer_failed.load(Ordering::Acquire) && exit == 0 { exit = 1; }
    frame(b'D', &(exit as i32).to_le_bytes())?;
    Ok(())
}
fn main() {
    if let Err(error) = run() {
        eprintln!("cc-job-supervisor: {error}");
        std::process::exit(1);
    }
}
