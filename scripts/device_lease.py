import ctypes
import re
import hashlib
def canonical_serial(serial):
    match = re.fullmatch(r'emulator-(\d+)', serial)
    if match:
        return 'local-adb:' + str(int(match.group(1)) + 1)
    match = re.fullmatch(r'(?:127\.0\.0\.1|localhost|\[::1\]):(\d+)', serial)
    return 'local-adb:' + match.group(1) if match else serial
class DeviceLease:
    def __init__(self, serial):
        self.handle = None
        self.kernel = ctypes.WinDLL('kernel32', use_last_error=True)
        self.kernel.CreateMutexW.argtypes = [ctypes.c_void_p, ctypes.c_int, ctypes.c_wchar_p]
        self.kernel.CreateMutexW.restype = ctypes.c_void_p
        self.kernel.ReleaseMutex.argtypes = [ctypes.c_void_p]
        self.kernel.CloseHandle.argtypes = [ctypes.c_void_p]
        name = 'Local\\xlamBOT-device-' + hashlib.sha256(canonical_serial(serial).encode()).hexdigest()
        handle = self.kernel.CreateMutexW(None, 1, name)
        error = ctypes.get_last_error()
        if not handle:
            raise OSError(error, 'Device mutex failed')
        if error == 183:
            self.kernel.CloseHandle(handle)
            raise ConnectionError('Device already has a capture/input owner: ' + serial)
        self.handle = handle
    def close(self):
        if self.handle:
            self.kernel.ReleaseMutex(self.handle)
            self.kernel.CloseHandle(self.handle)
            self.handle = None
