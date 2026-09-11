package com.dsh.console.knowledge;

/**
 * Supabase Storage 操作失败(上传/下载/删除)。
 *
 * <p>由 common 包 {@code GlobalExceptionHandler} 映射为 502 STORAGE_ERROR:
 * Storage 在 Supabase 侧,失败多为网络/RLS 拒绝,调用方可重试但非本服务缺陷。
 */
public class KbStorageException extends RuntimeException {

    public KbStorageException(String message, Throwable cause) {
        super(message, cause);
    }
}
