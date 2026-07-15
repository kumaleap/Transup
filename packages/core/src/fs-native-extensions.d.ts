declare module "fs-native-extensions" {
  interface LockOptions {
    shared?: boolean;
  }

  interface FsNativeExtensions {
    tryLock(fd: number, offset?: number, length?: number, options?: LockOptions): boolean;
    waitForLock(fd: number, offset?: number, length?: number, options?: LockOptions): Promise<void>;
    unlock(fd: number, offset?: number, length?: number): void;
  }

  const fsNativeExtensions: FsNativeExtensions;
  export default fsNativeExtensions;
}
